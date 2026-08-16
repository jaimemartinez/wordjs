/**
 * WordJS — Optional S3 backup offload (dependency-free AWS SigV4 PUT).
 *
 * After a local backup is written, if — and ONLY if — S3 is configured, upload the archive to the bucket
 * so a host-disk loss doesn't take the backups with it. The AWS SDK is NOT a dependency, so this signs a
 * single PUT with Signature Version 4 using Node's built-in `https` + `crypto`. Works against real S3
 * (virtual-hosted style) and S3-compatible endpoints like MinIO (path style, via `endpoint`).
 *
 * Config-gated: with no bucket/keys configured, offloadBackup() is a no-op and the on-host behaviour is
 * unchanged. On upload failure the LOCAL copy is kept and the failure is reported (never throws out of
 * the backup) — an unreachable bucket must not turn a good local backup into a failed one.
 *
 * Configure via a `s3` block in wordjs-config.json or env:
 *   s3.bucket           | WORDJS_S3_BUCKET
 *   s3.region           | WORDJS_S3_REGION   | AWS_REGION           (default us-east-1)
 *   s3.accessKeyId      | WORDJS_S3_ACCESS_KEY_ID     | AWS_ACCESS_KEY_ID
 *   s3.secretAccessKey  | WORDJS_S3_SECRET_ACCESS_KEY | AWS_SECRET_ACCESS_KEY
 *   s3.sessionToken     | AWS_SESSION_TOKEN  (optional, for temp creds)
 *   s3.endpoint         | WORDJS_S3_ENDPOINT (optional, e.g. https://minio.example.com — enables path style)
 *   s3.prefix           | WORDJS_S3_PREFIX   (optional key prefix, default "wordjs-backups")
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const { URL } = require('url');
const config = require('../config/app');

export type S3Config = {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string | null;
    endpoint?: string | null;
    prefix: string;
};

/** Resolve S3 config from the app config (`s3` block) then env. Returns null if not fully configured. */
function getS3Config(env: NodeJS.ProcessEnv = process.env, cfg: any = config): S3Config | null {
    const s = (cfg && cfg.s3) || {};
    const bucket = s.bucket || env.WORDJS_S3_BUCKET;
    const accessKeyId = s.accessKeyId || env.WORDJS_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = s.secretAccessKey || env.WORDJS_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY;
    // A partial config (bucket but no keys, etc.) is treated as NOT configured — never a half-attempt.
    if (!bucket || !accessKeyId || !secretAccessKey) return null;
    return {
        bucket: String(bucket),
        region: String(s.region || env.WORDJS_S3_REGION || env.AWS_REGION || 'us-east-1'),
        accessKeyId: String(accessKeyId),
        secretAccessKey: String(secretAccessKey),
        sessionToken: s.sessionToken || env.AWS_SESSION_TOKEN || null,
        endpoint: s.endpoint || env.WORDJS_S3_ENDPOINT || null,
        prefix: s.prefix !== undefined ? String(s.prefix) : (env.WORDJS_S3_PREFIX || 'wordjs-backups'),
    };
}

function sha256Hex(data: any): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key: any, data: string): Buffer {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * The AWS SigV4 signing-key derivation — the cryptographic core, and the part a subtle bug hides in.
 * Extracted and exported so a test can pin it against AWS's OWN published known-answer vector rather
 * than merely asserting the signature's shape.
 */
function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
    const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
}
// Encode a single path segment per RFC 3986 (S3 canonical URI rules); '/' handled by the caller.
function uriEncodeSegment(seg: string): string {
    return encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// ---- destination validation --------------------------------------------------------------------
//
// bucket, region and endpoint do not "ride along" in this request — they CHOOSE ITS DESTINATION.
// `bucket` and `region` are interpolated straight into the HOST of a virtual-hosted request and the
// bucket also into the PATH of a path-style one; `endpoint` replaces the host outright. They come
// from wordjs-config.json / the environment, and until now not one character of them was looked at:
// a typo'd (or tampered) `WORDJS_S3_REGION` of `foo.evil.com/x#` produced the host
// `bucket.s3.foo.evil.com/x#.amazonaws.com`, and `WORDJS_S3_ENDPOINT` accepted any scheme and any
// host, including 169.254.169.254. That is a backup archive — plus a live SigV4 Authorization
// header — aimed somewhere it was never meant to go.
//
// So each is checked against a POSITIVE shape allowlist (never "does it contain something bad?").
// A value outside its shape is refused with a clear error; it is not repaired and never silently
// tolerated. offloadBackup already catches everything an upload throws, so a misconfigured bucket
// reports `upload-failed` and leaves the good LOCAL backup exactly where it is.
const S3_PROTOCOLS = ['http:', 'https:'];
/** AWS bucket-naming rules, which are also what makes a bucket safe to splice into a host label. */
const S3_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** AWS region codes: lowercase letters, digits and hyphens (`us-east-1`, `eu-central-1`, …). */
const S3_REGION_RE = /^[a-z0-9-]{1,32}$/;
/** An endpoint host: DNS labels (underscore allowed for container service names) or an IPv4 literal. */
const S3_HOST_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?$/;
/** One object-key segment. No empty segments, no `.`/`..`, nothing that could re-point the path. */
const S3_KEY_SEGMENT_RE = /^[A-Za-z0-9!_.*'()-]+$/;

function assertShape(value: string, re: RegExp, what: string): string {
    if (typeof value !== 'string' || !re.test(value)) {
        throw new Error(`S3 offload refused: ${what} has an unsupported shape (${JSON.stringify(String(value)).slice(0, 80)})`);
    }
    return value;
}

/** Validate an object key: every segment must be a plain name, and `.`/`..` are never one. */
function assertKey(key: string): string[] {
    const segments = String(key).split('/');
    if (!segments.length) throw new Error('S3 offload refused: empty object key');
    for (const seg of segments) {
        assertShape(seg, S3_KEY_SEGMENT_RE, 'object-key segment');
        if (seg === '.' || seg === '..') throw new Error('S3 offload refused: relative object-key segment');
    }
    return segments;
}

/**
 * Build the {host, path} pair for a bucket+key, virtual-hosted for real S3, path-style for endpoints.
 * Every input that lands in the host or the path is shape-checked FIRST (see above), and the
 * endpoint is rebuilt from its parsed, validated pieces rather than reused as written.
 */
function resolveTarget(s3: S3Config, key: string): { host: string; canonicalUri: string; protocol: string; port: number | null } {
    const bucket = assertShape(s3.bucket, S3_BUCKET_RE, 'bucket name');
    const encodedKey = assertKey(key).map(uriEncodeSegment).join('/');
    if (s3.endpoint) {
        let u: URL;
        try {
            u = new URL(String(s3.endpoint));
        } catch {
            throw new Error('S3 offload refused: endpoint is not a URL');
        }
        // The scheme that gets used is the LITERAL from the allowlist, not the configured text.
        const protocol = S3_PROTOCOLS.find((p) => p === u.protocol);
        if (!protocol) throw new Error(`S3 offload refused: endpoint scheme ${u.protocol} is not http/https`);
        if (u.username || u.password || u.search || u.hash) {
            throw new Error('S3 offload refused: endpoint carries credentials, a query or a fragment');
        }
        // A path-style endpoint is an ORIGIN — the bucket and key are the path. A path here would
        // silently prefix (or, with a `..`, escape) the object path we sign.
        if (u.pathname.replace(/\/+$/, '') !== '') throw new Error('S3 offload refused: endpoint must not carry a path');
        const host = u.hostname.toLowerCase();
        if (!S3_HOST_RE.test(host)) throw new Error(`S3 offload refused: endpoint host ${host} is not a plain host name`);
        const port = u.port ? Number(u.port) : null;
        if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
            throw new Error('S3 offload refused: endpoint port is out of range');
        }
        return {
            host,
            protocol,
            port,
            canonicalUri: `/${bucket}/${encodedKey}`, // path style
        };
    }
    const region = assertShape(s3.region, S3_REGION_RE, 'region');
    return {
        host: `${bucket}.s3.${region}.amazonaws.com`,
        protocol: 'https:',
        port: null,
        canonicalUri: `/${encodedKey}`, // virtual-hosted style
    };
}

/**
 * Everything the request needs to know ABOUT the payload — and nothing of the payload itself.
 * SigV4 signs the content digest and S3 needs the byte count, so exactly two numbers-as-facts about
 * the archive cross into the request configuration; the archive's BYTES only ever reach `req.end()`.
 * Splitting it out is what makes that division checkable instead of a claim in a comment.
 */
type PayloadMeta = { sha256: string; length: number };

/**
 * Build the signed PUT request options for a destination + payload description.
 *
 * Deliberately takes NO file contents: the destination comes from config (validated in
 * resolveTarget), the credentials from config, and the only payload-derived inputs are the two
 * primitives in `meta`. Nothing here can move the request.
 */
function buildSignedPutOptions(target: ReturnType<typeof resolveTarget>, s3: S3Config, meta: PayloadMeta, now: Date): any {
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = meta.sha256;
    const hostHeader = target.port ? `${target.host}:${target.port}` : target.host;

    // Canonical (signed) headers — sorted, lower-cased. Include the session token when present.
    const headerMap: Record<string, string> = {
        host: hostHeader,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
    };
    if (s3.sessionToken) headerMap['x-amz-security-token'] = s3.sessionToken;
    const signedHeaderNames = Object.keys(headerMap).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headerMap[h]}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
        'PUT',
        target.canonicalUri,
        '', // no query string
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${s3.region}/s3/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        sha256Hex(canonicalRequest),
    ].join('\n');

    const kSigning = deriveSigningKey(s3.secretAccessKey, dateStamp, s3.region, 's3');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const authorization =
        `AWS4-HMAC-SHA256 Credential=${s3.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers: Record<string, string> = {
        Host: hostHeader,
        'X-Amz-Date': amzDate,
        'X-Amz-Content-Sha256': payloadHash,
        Authorization: authorization,
        'Content-Length': String(meta.length),
        'Content-Type': 'application/zip',
    };
    if (s3.sessionToken) headers['X-Amz-Security-Token'] = s3.sessionToken;

    const options: any = {
        method: 'PUT',
        host: target.host,
        path: target.canonicalUri,
        headers,
        protocol: target.protocol,
    };
    if (target.port) options.port = target.port;
    return options;
}

/**
 * PUT a local file to S3 with a SigV4-signed request. Resolves on 2xx; rejects otherwise.
 *
 * The two halves are kept apart on purpose. WHERE this goes and HOW it is signed is decided by
 * buildSignedPutOptions from config alone; the archive's bytes are read here and handed to exactly
 * one place — `req.end(body)`, the request BODY. This is the whole answer to "can file data redirect
 * this request?": it cannot reach the URL, the host, the port or the path, because none of them are
 * computed from it.
 *
 * @param deps injectable { request, readFile, now } for tests (never hit a real bucket in tests).
 */
function uploadToS3(localPath: string, key: string, s3: S3Config, deps: any = {}): Promise<{ status: number }> {
    const requestFn = deps.request || https.request;
    const readFile = deps.readFile || fs.readFileSync;
    const now: Date = deps.now || new Date();

    const target = resolveTarget(s3, key); // destination: config only, shape-validated
    const body: Buffer = readFile(localPath); // payload: never consulted for the destination
    const options = buildSignedPutOptions(target, s3, { sha256: sha256Hex(body), length: body.length }, now);

    return new Promise((resolve, reject) => {
        const req = requestFn(options, (res: any) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const status = res.statusCode || 0;
                if (status >= 200 && status < 300) return resolve({ status });
                const bodyText = Buffer.concat(chunks).toString('utf8').slice(0, 512);
                reject(new Error(`S3 PUT failed: HTTP ${status}${bodyText ? ` — ${bodyText}` : ''}`));
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * Offload a just-written local backup to S3 when configured. NEVER throws: returns a status object so a
 * failed upload leaves the good local copy in place and merely reports.
 * @param deps injectable { getS3Config, uploadToS3, env, config } for tests.
 */
async function offloadBackup(localPath: string, filename: string, deps: any = {}): Promise<any> {
    const resolve = deps.getS3Config || getS3Config;
    const s3 = resolve(deps.env, deps.config);
    if (!s3) return { offloaded: false, reason: 'not-configured' };

    const key = (s3.prefix ? s3.prefix.replace(/\/+$/, '') + '/' : '') + filename;
    const upload = deps.uploadToS3 || uploadToS3;
    try {
        await upload(localPath, key, s3, deps);
        return { offloaded: true, bucket: s3.bucket, key };
    } catch (e: any) {
        return { offloaded: false, reason: 'upload-failed', error: e && e.message, key };
    }
}

module.exports = {
    getS3Config,
    uploadToS3,
    offloadBackup,
    // exported for unit tests
    resolveTarget,
    uriEncodeSegment,
    deriveSigningKey,
};

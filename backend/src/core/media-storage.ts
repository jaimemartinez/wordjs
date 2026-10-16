/**
 * WordJS — Media storage adapters (local disk by default, optional S3-compatible offload).
 *
 * WHAT THIS IS. Uploads have always been written under `config.uploads.dir` and served by the backend's
 * `/uploads` static handler. That is still the default (the `local` adapter) and, with nothing
 * configured, every code path behaves exactly as before. With a `mediaStorage` block whose `driver` is
 * `s3`, PUBLIC media — the original and every stored derivative (the size ladder and its WebP/AVIF
 * siblings) — is also written to an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Backblaze B2…)
 * and served from a public base URL (the bucket itself or a CDN in front of it).
 *
 * WHAT DOES NOT CHANGE. The database keeps the same RELATIVE references it always had: an attachment's
 * guid is `/uploads/<yyyy>/<mm>/<file>` and `_wp_attached_file` is `<yyyy>/<mm>/<file>`. No absolute
 * bucket or CDN URL is ever written to a row, so a site can move bucket, CDN host or domain — or roll the
 * offload back entirely — without rewriting content. The delivery URL is computed at read time:
 *
 *   - `/uploads/<rel>` on the backend redirects (302) to `<publicBase>/<rel>` when the file is not on
 *     this node's disk (index.ts), so every reference ever written — post HTML, persisted srcsets,
 *     theme settings — keeps working on any node without a shared uploads directory;
 *   - the public SSR rewrites `/uploads/` to the CDN base in the page data once the library is fully
 *     offloaded (the `media_public_base` public setting), so pages skip that hop.
 *
 * PRIVATE media (core/private-media) never leaves the private root: it is not offloaded, and an
 * offloaded item made private is pulled back to disk first.
 *
 * CONFIG — the `mediaStorage` block of wordjs-config.json (written by the admin screen through
 * configManager, like every other credential the backend holds) with per-field env overrides:
 *
 *   mediaStorage.driver           | WORDJS_MEDIA_STORAGE              'local' (default) | 's3'
 *   mediaStorage.bucket           | WORDJS_MEDIA_S3_BUCKET
 *   mediaStorage.region           | WORDJS_MEDIA_S3_REGION            (default us-east-1; R2 uses 'auto')
 *   mediaStorage.endpoint         | WORDJS_MEDIA_S3_ENDPOINT          (S3-compatible origin, path style)
 *   mediaStorage.accessKeyId      | WORDJS_MEDIA_S3_ACCESS_KEY_ID
 *   mediaStorage.secretAccessKey  | WORDJS_MEDIA_S3_SECRET_ACCESS_KEY
 *   mediaStorage.sessionToken     | WORDJS_MEDIA_S3_SESSION_TOKEN     (optional)
 *   mediaStorage.prefix           | WORDJS_MEDIA_S3_PREFIX            (key prefix, default 'uploads')
 *   mediaStorage.publicUrl        | WORDJS_MEDIA_PUBLIC_URL           (CDN / public bucket base URL)
 *   mediaStorage.keepLocalCopy    | WORDJS_MEDIA_KEEP_LOCAL_COPY      (keep new uploads on disk too)
 *
 * A partial s3 config (a bucket without keys…) is treated as NOT configured: the effective driver is
 * `local` and `incomplete` says why, never a half-attempt.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const s3offload = require('./s3-offload');
const { logSafe, logSafeError } = require('./log-safe');
const log = require('./module-logger').moduleLogger('core/media-storage');

export type MediaStorageSource = 'file' | 'env' | 'default';

export type ResolvedMediaStorage = {
    /** The adapter in effect: 'local' unless a COMPLETE s3 config is present. */
    driver: 'local' | 's3';
    /** 's3' was asked for but something required is missing (the names of the missing fields). */
    incomplete: string[] | null;
    s3: {
        bucket: string;
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken: string | null;
        endpoint: string | null;
        prefix: string;
    } | null;
    /** Base URL the `/uploads` tree maps to in the bucket: `<publicUrl>/<prefix>` (no trailing slash). */
    publicBase: string | null;
    /** The scheme://host[:port] of publicBase — the ONE origin the CSP gains. */
    publicOrigin: string | null;
    keepLocalCopy: boolean;
    /** Where each field came from, for the admin screen (never the values of secrets). */
    sources: Record<string, MediaStorageSource>;
};

const FIELDS: Array<[string, string]> = [
    ['driver', 'WORDJS_MEDIA_STORAGE'],
    ['bucket', 'WORDJS_MEDIA_S3_BUCKET'],
    ['region', 'WORDJS_MEDIA_S3_REGION'],
    ['endpoint', 'WORDJS_MEDIA_S3_ENDPOINT'],
    ['accessKeyId', 'WORDJS_MEDIA_S3_ACCESS_KEY_ID'],
    ['secretAccessKey', 'WORDJS_MEDIA_S3_SECRET_ACCESS_KEY'],
    ['sessionToken', 'WORDJS_MEDIA_S3_SESSION_TOKEN'],
    ['prefix', 'WORDJS_MEDIA_S3_PREFIX'],
    ['publicUrl', 'WORDJS_MEDIA_PUBLIC_URL'],
    ['keepLocalCopy', 'WORDJS_MEDIA_KEEP_LOCAL_COPY'],
];
const ENV_BY_FIELD: Record<string, string> = Object.fromEntries(FIELDS);

/** Default object-key prefix: the bucket mirrors the `/uploads` URL space. */
const DEFAULT_PREFIX = 'uploads';

/** The prefix: zero or more plain key segments joined by '/'. */
const PREFIX_RE = /^(?:[A-Za-z0-9!_.*'()-]+(?:\/[A-Za-z0-9!_.*'()-]+)*)?$/;

function truthy(v: unknown): boolean {
    return v === true || v === 1 || (typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim()));
}

/** The raw `mediaStorage` block of wordjs-config.json (fresh within configManager's 2 s cache). */
function fileBlock(cfg?: any): Record<string, any> {
    if (cfg !== undefined) return (cfg && typeof cfg === 'object' && cfg.mediaStorage && typeof cfg.mediaStorage === 'object') ? cfg.mediaStorage : {};
    try {
        const current = require('./configManager').getConfig();
        return current && current.mediaStorage && typeof current.mediaStorage === 'object' ? current.mediaStorage : {};
    } catch {
        return {};
    }
}

/**
 * Normalise an operator-typed public base URL: http(s) only, no credentials, query or fragment, no
 * trailing slash. Returns null for anything else — a value that would put a quote, a space or a
 * `;` into a URL attribute or a CSP header never gets that far.
 */
function normalizePublicUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let u: URL;
    try { u = new URL(raw.trim()); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.search || u.hash) return null;
    if (!u.hostname) return null;
    // Rebuilt from the parsed pieces: whatever survives here is WHATWG-serialised (percent-encoded path).
    const pathname = u.pathname.replace(/\/+$/, '');
    if (/[^A-Za-z0-9\-._~!$&'()*+,;=:@%/]/.test(pathname)) return null;
    return `${u.origin}${pathname}`;
}

/** The bucket's own public base when no publicUrl is configured (virtual-hosted S3, or endpoint/bucket). */
function derivedBucketBase(s3: NonNullable<ResolvedMediaStorage['s3']>): string | null {
    try {
        // resolveTarget shape-checks the bucket, region and endpoint; a probe key is enough.
        const t = s3offload.resolveTarget({ ...s3, prefix: '' }, 'probe');
        const port = t.port ? `:${t.port}` : '';
        const origin = `${t.protocol}//${t.host}${port}`;
        return s3.endpoint ? `${origin}/${s3.bucket}` : origin;
    } catch {
        return null;
    }
}

/**
 * Resolve the effective media storage config: the file block, each field overridable from the env.
 * Pure given (env, cfg) — the admin route, the CLI and the tests all call it with what they hold.
 */
function resolveMediaStorage(env: NodeJS.ProcessEnv = process.env, cfg?: any): ResolvedMediaStorage {
    const block = fileBlock(cfg);
    const values: Record<string, any> = {};
    const sources: Record<string, MediaStorageSource> = {};
    for (const [field, envName] of FIELDS) {
        const fromEnv = env[envName];
        if (fromEnv !== undefined && fromEnv !== '') {
            values[field] = fromEnv;
            sources[field] = 'env';
        } else if (block[field] !== undefined && block[field] !== null && block[field] !== '') {
            values[field] = block[field];
            sources[field] = 'file';
        } else {
            sources[field] = 'default';
        }
    }

    const asked = String(values.driver || 'local').toLowerCase() === 's3' ? 's3' : 'local';
    const keepLocalCopy = truthy(values.keepLocalCopy);
    const none: ResolvedMediaStorage = { driver: 'local', incomplete: null, s3: null, publicBase: null, publicOrigin: null, keepLocalCopy, sources };
    if (asked !== 's3') return none;

    const missing = ['bucket', 'accessKeyId', 'secretAccessKey'].filter((f) => !values[f]);
    const prefixRaw = values.prefix !== undefined ? String(values.prefix).replace(/^\/+|\/+$/g, '') : DEFAULT_PREFIX;
    if (!PREFIX_RE.test(prefixRaw) || prefixRaw.split('/').some((s) => s === '.' || s === '..')) missing.push('prefix');
    const s3 = {
        bucket: String(values.bucket || ''),
        region: String(values.region || 'us-east-1'),
        accessKeyId: String(values.accessKeyId || ''),
        secretAccessKey: String(values.secretAccessKey || ''),
        sessionToken: values.sessionToken ? String(values.sessionToken) : null,
        endpoint: values.endpoint ? String(values.endpoint) : null,
        prefix: prefixRaw,
    };
    const bucketBase = missing.length ? null : derivedBucketBase(s3);
    if (!missing.length && !bucketBase) missing.push('endpoint');
    let base: string | null;
    if (values.publicUrl !== undefined) {
        base = normalizePublicUrl(values.publicUrl);
        if (!base) missing.push('publicUrl');
    } else {
        base = bucketBase;
    }
    if (missing.length) return { ...none, incomplete: missing };

    const publicBase = s3.prefix ? `${base}/${s3.prefix}` : String(base);
    return {
        driver: 's3',
        incomplete: null,
        s3,
        publicBase,
        publicOrigin: new URL(publicBase).origin,
        keepLocalCopy,
        sources,
    };
}

/** Is this relative upload path one the bucket may hold? (Fonts and the negotiation cache stay local.) */
function isOffloadablePath(rel: string): boolean {
    if (typeof rel !== 'string' || !rel) return false;
    const segments = rel.split('/');
    if (segments[0] === 'fonts' || segments[0] === '.derivatives') return false;
    return segments.every((s) => /^[A-Za-z0-9!_.*'()-]+$/.test(s) && s !== '.' && s !== '..');
}

/** Object key for a relative upload path (`2026/10/a.jpg` → `uploads/2026/10/a.jpg`). Throws on a bad path. */
function objectKeyFor(store: ResolvedMediaStorage, rel: string): string {
    if (!store.s3) throw new Error('media storage: not an s3 store');
    if (!isOffloadablePath(rel)) throw new Error(`media storage: ${JSON.stringify(String(rel)).slice(0, 80)} is not an offloadable path`);
    return store.s3.prefix ? `${store.s3.prefix}/${rel}` : rel;
}

/** Public delivery URL of a relative upload path, or null when the store has none / the path is not offloadable. */
function publicUrlFor(store: ResolvedMediaStorage, rel: string): string | null {
    if (store.driver !== 's3' || !store.publicBase || !isOffloadablePath(rel)) return null;
    return `${store.publicBase}/${rel}`;
}

// ---- object content types --------------------------------------------------------------------------
//
// The bucket serves objects with the Content-Type they were stored with, and nothing like the backend's
// /uploads denylist runs in front of it. So the same rule is applied at write time: document types that
// could execute (.html, .js, .xml…) are stored as an opaque download, everything else with its real type.
const CONTENT_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.json': 'application/json',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const EXECUTABLE_DOC_EXTS = new Set(['.html', '.htm', '.xhtml', '.xht', '.shtml', '.shtm', '.js', '.mjs', '.cjs', '.xml', '.svgz']);

/** The headers an object is stored with: its type, an immutable cache policy, and a forced download for document types. */
function objectHeadersFor(rel: string): Record<string, string> {
    const ext = path.extname(rel).toLowerCase();
    const headers: Record<string, string> = {
        // Media filenames are UUID-unique and never overwritten at the same URL — the same policy /uploads uses.
        'Cache-Control': 'public, max-age=31536000, immutable',
    };
    if (EXECUTABLE_DOC_EXTS.has(ext)) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['Content-Disposition'] = 'attachment';
    } else {
        headers['Content-Type'] = CONTENT_TYPES[ext] || 'application/octet-stream';
    }
    return headers;
}

// ---- adapters --------------------------------------------------------------------------------------

export interface MediaStorageAdapter {
    readonly kind: 'local' | 's3';
    /** Store the local file at `localPath` under the relative upload path `rel`. */
    put(rel: string, localPath: string): Promise<void>;
    /** The stored object's size, or null when it does not exist. */
    head(rel: string): Promise<{ size: number } | null>;
    /** The stored bytes, or null when the object does not exist. */
    get(rel: string): Promise<Buffer | null>;
    /** Remove the stored object (a missing object is not an error). */
    remove(rel: string): Promise<void>;
}

/**
 * The default adapter: the files ARE the store, under `config.uploads.dir`, exactly where the upload
 * route wrote them. Every operation is the identity on disk, so "local" adds no I/O to any code path.
 */
function localAdapter(root: string): MediaStorageAdapter {
    const resolve = (rel: string) => {
        const { resolveWithin } = require('./safe-path');
        const p = resolveWithin(root, ...String(rel).split('/'));
        if (!p) throw new Error('media storage: path escapes the uploads root');
        return p;
    };
    return {
        kind: 'local',
        async put(rel: string, localPath: string) {
            const target = resolve(rel);
            if (path.resolve(localPath) !== target) {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(localPath, target);
            }
        },
        async head(rel: string) {
            try { const st = fs.statSync(resolve(rel)); return st.isFile() ? { size: st.size } : null; } catch { return null; }
        },
        async get(rel: string) {
            try { return fs.readFileSync(resolve(rel)); } catch { return null; }
        },
        async remove(rel: string) {
            try { fs.unlinkSync(resolve(rel)); } catch { /* already gone */ }
        },
    };
}

/** The S3-compatible adapter: one SigV4-signed request per operation (core/s3-offload s3Request). */
function s3Adapter(store: ResolvedMediaStorage, deps: any = {}): MediaStorageAdapter {
    if (store.driver !== 's3' || !store.s3) throw new Error('media storage: s3 is not configured');
    const s3 = store.s3;
    const request = deps.s3Request || s3offload.s3Request;
    const fail = (op: string, status: number, body?: Buffer) => {
        const text = body && body.length ? ` — ${body.toString('utf8').replace(/\s+/g, ' ').slice(0, 200)}` : '';
        return new Error(`S3 ${op} failed: HTTP ${status}${text}`);
    };
    return {
        kind: 's3',
        async put(rel: string, localPath: string) {
            const body: Buffer = fs.readFileSync(localPath);
            const res = await request('PUT', objectKeyFor(store, rel), s3, { body, headers: objectHeadersFor(rel) }, deps);
            if (res.status < 200 || res.status >= 300) throw fail('PUT', res.status, res.body);
        },
        async head(rel: string) {
            const res = await request('HEAD', objectKeyFor(store, rel), s3, {}, deps);
            if (res.status === 404) return null;
            if (res.status < 200 || res.status >= 300) throw fail('HEAD', res.status);
            const len = Number(res.headers['content-length']);
            return { size: Number.isFinite(len) ? len : -1 };
        },
        async get(rel: string) {
            const res = await request('GET', objectKeyFor(store, rel), s3, {}, deps);
            if (res.status === 404) return null;
            if (res.status < 200 || res.status >= 300) throw fail('GET', res.status, res.body);
            return res.body;
        },
        async remove(rel: string) {
            const res = await request('DELETE', objectKeyFor(store, rel), s3, {}, deps);
            if (res.status === 404) return;
            if (res.status < 200 || res.status >= 300) throw fail('DELETE', res.status, res.body);
        },
    };
}

/** The adapter for the effective config. `deps` lets tests inject a mocked s3Request. */
function getMediaStorage(store: ResolvedMediaStorage = resolveMediaStorage(), deps: any = {}): MediaStorageAdapter {
    if (store.driver === 's3') return s3Adapter(store, deps);
    const config = require('../config/app');
    return localAdapter(path.resolve(config.uploads.dir));
}

/** The per-attachment marker: post_meta `_wjs_media_storage` = 's3' on an attachment whose files are in the bucket. */
const STORAGE_META_KEY = '_wjs_media_storage';

/** Relative upload path of an absolute file under `root`, with '/' separators, or null outside it. */
function relativeTo(root: string, absolute: string): string | null {
    const rel = path.relative(path.resolve(root), path.resolve(absolute));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
}

/**
 * Write a set of local files (absolute, under `root`) to the store and VERIFY each one by size. All or
 * nothing from the caller's point of view: on any failure the objects already written are removed
 * (best effort) and the error is thrown, so a row is never told its files are in a bucket that does
 * not hold them. Returns the relative paths written.
 */
async function pushFiles(adapter: MediaStorageAdapter, root: string, files: string[]): Promise<string[]> {
    const done: string[] = [];
    try {
        for (const file of files) {
            const rel = relativeTo(root, file);
            if (!rel || !isOffloadablePath(rel)) throw new Error(`media storage: ${JSON.stringify(path.basename(file))} cannot be stored in the bucket (unsupported file name)`);
            const size = fs.statSync(file).size;
            const existing = await adapter.head(rel);
            if (!existing || existing.size !== size) await adapter.put(rel, file);
            const after = existing && existing.size === size ? existing : await adapter.head(rel);
            if (!after || (after.size >= 0 && after.size !== size)) throw new Error(`media storage: ${rel} did not verify after upload`);
            done.push(rel);
        }
        return done;
    } catch (e) {
        for (const rel of done) { try { await adapter.remove(rel); } catch { /* best effort */ } }
        throw e;
    }
}

/**
 * Bring a set of objects back to disk (absolute targets under `root`), each written to a temporary
 * file and renamed into place, so a reader never sees a half-written file. A target that already holds
 * the object's bytes (same size) is left alone. Returns the number of files written.
 */
async function pullFiles(adapter: MediaStorageAdapter, root: string, files: string[]): Promise<number> {
    let written = 0;
    for (const file of files) {
        const rel = relativeTo(root, file);
        if (!rel) throw new Error('media storage: target escapes the uploads root');
        const remote = await adapter.head(rel);
        let localSize = -1;
        try { localSize = fs.statSync(file).size; } catch { /* missing */ }
        if (remote === null) {
            if (localSize >= 0) continue; // already local, never offloaded (or removed remotely)
            throw new Error(`media storage: ${rel} is in neither the bucket nor on disk`);
        }
        if (localSize >= 0 && (remote.size < 0 || remote.size === localSize)) continue;
        const bytes = await adapter.get(rel);
        if (!bytes) throw new Error(`media storage: ${rel} vanished from the bucket while restoring`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.part`;
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, file);
        written++;
    }
    return written;
}

/** Remove every relative path from the store, never throwing (each failure is logged). */
async function removeFiles(adapter: MediaStorageAdapter, rels: string[]): Promise<void> {
    for (const rel of rels) {
        try { await adapter.remove(rel); } catch (e: any) { log.warn(`media storage: could not remove ${logSafe(rel)}: ${logSafeError(e)}`); }
    }
}

/**
 * The admin screen's view of a config: everything, except that secrets are reduced to whether they are
 * set and their last four characters, and the access key id to a hint. Never the full credential.
 */
function maskSecret(v: unknown): string | null {
    if (typeof v !== 'string' || !v) return null;
    return v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
}

function describeForAdmin(env: NodeJS.ProcessEnv = process.env, cfg?: any) {
    const block = fileBlock(cfg);
    const store = resolveMediaStorage(env, cfg);
    const pick = (field: string) => {
        const envName = ENV_BY_FIELD[field];
        return env[envName] !== undefined && env[envName] !== '' ? env[envName] : block[field];
    };
    return {
        driver: String(pick('driver') || 'local').toLowerCase() === 's3' ? 's3' : 'local',
        bucket: pick('bucket') || '',
        region: pick('region') || '',
        endpoint: pick('endpoint') || '',
        prefix: pick('prefix') !== undefined ? String(pick('prefix')) : '',
        publicUrl: pick('publicUrl') || '',
        keepLocalCopy: truthy(pick('keepLocalCopy')),
        accessKeyIdHint: maskSecret(pick('accessKeyId')),
        secretAccessKeySet: !!pick('secretAccessKey'),
        secretAccessKeyHint: maskSecret(pick('secretAccessKey')),
        sessionTokenSet: !!pick('sessionToken'),
        sources: store.sources,
        effective: {
            driver: store.driver,
            incomplete: store.incomplete,
            publicBase: store.publicBase,
            publicOrigin: store.publicOrigin,
        },
    };
}

/**
 * The `/uploads` fallback (mounted in index.ts AFTER express.static): a file this node does not hold,
 * with an s3 store configured, answers 302 to its public URL. Anything not offloadable (fonts, the
 * negotiation cache, a path outside the strict key charset) falls through to the usual 404.
 */
function uploadsRedirect() {
    return function mediaStorageRedirect(req: any, res: any, next: any) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let rel: string;
        try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch { return next(); }
        const store = resolveMediaStorage();
        const target = store.driver === 's3' ? publicUrlFor(store, rel) : null;
        if (!target) return next();
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.redirect(302, target);
    };
}

module.exports = {
    uploadsRedirect,
    resolveMediaStorage,
    normalizePublicUrl,
    isOffloadablePath,
    objectKeyFor,
    publicUrlFor,
    objectHeadersFor,
    getMediaStorage,
    localAdapter,
    s3Adapter,
    pushFiles,
    pullFiles,
    removeFiles,
    relativeTo,
    describeForAdmin,
    maskSecret,
    STORAGE_META_KEY,
    DEFAULT_PREFIX,
    ENV_BY_FIELD,
};

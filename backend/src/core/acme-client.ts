/**
 * WordJS ACME client (RFC 8555) — the protocol client core/cert-manager drives to obtain certificates
 * from Let's Encrypt (or any RFC 8555 CA) over HTTP-01 and DNS-01.
 *
 * WHY IT IS WRITTEN HERE. The npm `acme-client` package this replaces has had no release since 2024 and
 * hard-depends on node-forge, which carries unfixed high-severity advisories; its index loads the forge
 * helpers eagerly, so the dependency could not be dropped while keeping the package. What WordJS needs
 * from ACME is a small, fixed subset — account, order, authorizations, challenges, finalize, download —
 * and every cryptographic step is Node's own: JWS signatures with crypto.sign (RS256 / ES256), the JWK
 * thumbprint with crypto.createHash, the key pair and the CSR with ./x509 (crypto.sign again).
 *
 * The interface mirrors the subset of acme-client 5 that cert-manager uses, with the same semantics
 * (getChallengeKeyAuthorization returns the FINAL dns-01 TXT value; waitForValidStatus polls with
 * bounded exponential backoff; errors carry the CA's problem `detail`), so the flows built and fixed
 * on top of it keep their behaviour.
 */
const nodeCrypto = require('crypto');
const dnsPromises = require('dns').promises;
const x509 = require('./x509');

const directory = {
    letsencrypt: {
        production: 'https://acme-v02.api.letsencrypt.org/directory',
        staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
    },
};

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/** An ACME problem document (RFC 8555 §6.7) as an Error: message = the CA's detail, `.type` = its URN. */
class AcmeError extends Error {
    type: string | null;
    status: number;
    problem: any;
    constructor(message: string, { type = null, status = 0, problem = null }: { type?: string | null; status?: number; problem?: any } = {}) {
        super(message);
        this.name = 'AcmeError';
        this.type = type;
        this.status = status;
        this.problem = problem;
    }
}

// The human-readable part of a problem document (or of an object carrying one in `.error`).
function problemMessage(body: any, fallback: string): string {
    if (body && typeof body === 'object') {
        const p = body.error && typeof body.error === 'object' ? body.error : body;
        const text = p.detail || p.type;
        if (text) return String(text).replace(/\n/g, '');
    }
    return fallback;
}

/** RFC 7638 thumbprint input: the REQUIRED public members only, lexicographic order, no whitespace. */
function canonicalJwk(jwk: any): string {
    if (jwk.kty === 'RSA') return JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
    if (jwk.kty === 'EC') return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    throw new Error(`Unsupported account key type ${jwk.kty}`);
}

function parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const sec = Number.parseInt(value, 10);
    if (Number.isSafeInteger(sec) && String(sec) === value.trim()) return sec * 1000;
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

const PENDING = new Set(['pending', 'processing']);

interface ClientOptions {
    directoryUrl: string;
    accountKey: string | Buffer;
    backoffAttempts?: number;
    backoffMin?: number;
    backoffMax?: number;
    timeout?: number;
}

class Client {
    directoryUrl: string;
    backoffAttempts: number;
    backoffMin: number;
    backoffMax: number;
    timeout: number;
    private key: any;
    private jwk: any;
    private alg: 'RS256' | 'ES256';
    private kid: string | null = null;
    private nonce: string | null = null;
    private directoryCache: any = null;

    constructor({ directoryUrl, accountKey, backoffAttempts = 10, backoffMin = 5000, backoffMax = 30000, timeout = 10000 }: ClientOptions) {
        if (!directoryUrl) throw new Error('ACME directoryUrl is required');
        this.directoryUrl = directoryUrl;
        this.key = nodeCrypto.createPrivateKey(accountKey);
        const pub = nodeCrypto.createPublicKey(this.key).export({ format: 'jwk' });
        if (pub.kty === 'RSA') {
            this.alg = 'RS256';
            this.jwk = { e: pub.e, kty: 'RSA', n: pub.n };
        } else if (pub.kty === 'EC' && pub.crv === 'P-256') {
            this.alg = 'ES256';
            this.jwk = { crv: 'P-256', kty: 'EC', x: pub.x, y: pub.y };
        } else {
            throw new Error('The ACME account key must be RSA or ECDSA P-256');
        }
        this.backoffAttempts = backoffAttempts;
        this.backoffMin = backoffMin;
        this.backoffMax = backoffMax;
        this.timeout = timeout;
    }

    // ─── transport ───────────────────────────────────────────────────────────────────────────────

    private async http(url: string, init: any): Promise<Response> {
        const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.timeout) });
        const nonce = res.headers.get('replay-nonce');
        if (nonce) this.nonce = nonce;
        return res;
    }

    async getDirectory(): Promise<any> {
        if (!this.directoryCache) {
            const res = await this.http(this.directoryUrl, { method: 'GET' });
            if (res.status !== 200) throw new AcmeError(`ACME directory answered HTTP ${res.status}`, { status: res.status });
            const dir: any = await res.json();
            for (const field of ['newNonce', 'newAccount', 'newOrder']) {
                if (!dir || typeof dir[field] !== 'string') throw new AcmeError(`ACME directory has no ${field} URL`);
            }
            this.directoryCache = dir;
        }
        return this.directoryCache;
    }

    private async freshNonce(): Promise<string> {
        if (this.nonce) {
            const n = this.nonce;
            this.nonce = null;
            return n;
        }
        const dir = await this.getDirectory();
        const res = await this.http(dir.newNonce, { method: 'HEAD' });
        const n = this.nonce;
        this.nonce = null;
        if (!n) throw new AcmeError(`ACME newNonce answered HTTP ${res.status} without a Replay-Nonce`, { status: res.status });
        return n;
    }

    private sign(url: string, payload: any, nonce: string, useJwk: boolean) {
        const header: any = { alg: this.alg, nonce, url };
        if (useJwk) header.jwk = this.jwk;
        else header.kid = this.kid;
        const protectedB64 = b64url(JSON.stringify(header));
        // POST-as-GET (RFC 8555 §6.3) is the EMPTY payload, not "{}" and not "null".
        const payloadB64 = payload === null ? '' : b64url(JSON.stringify(payload));
        const signingInput = Buffer.from(`${protectedB64}.${payloadB64}`, 'ascii');
        const signature = this.alg === 'RS256'
            ? nodeCrypto.sign('sha256', signingInput, { key: this.key, padding: nodeCrypto.constants.RSA_PKCS1_PADDING })
            : nodeCrypto.sign('sha256', signingInput, { key: this.key, dsaEncoding: 'ieee-p1363' });
        return JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: b64url(signature) });
    }

    /**
     * One signed request. A badNonce answer (RFC 8555 §6.5) is retried with the nonce it carries, up to
     * five times; any other non-2xx answer throws its problem document as an AcmeError.
     */
    private async post(url: string, payload: any, { useJwk = false, accept = 'application/json' } = {}): Promise<{ status: number; headers: Headers; body: any; text: string }> {
        if (!useJwk && !this.kid) throw new Error('ACME account is not registered — call createAccount first');
        for (let attempt = 0; ; attempt++) {
            const nonce = await this.freshNonce();
            const res = await this.http(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/jose+json', Accept: accept },
                body: this.sign(url, payload, nonce, useJwk),
            });
            const text = await res.text();
            let body: any = null;
            if (/json/i.test(res.headers.get('content-type') || '')) {
                try { body = JSON.parse(text); } catch { body = null; }
            }
            if (res.status >= 200 && res.status < 300) return { status: res.status, headers: res.headers, body, text };
            const type = body && typeof body.type === 'string' ? body.type : null;
            if (res.status === 400 && type === 'urn:ietf:params:acme:error:badNonce' && attempt < 5) continue;
            throw new AcmeError(problemMessage(body, `ACME request to ${url} failed with HTTP ${res.status}`), { type, status: res.status, problem: body });
        }
    }

    private async postAsGet(url: string) {
        const { body } = await this.post(url, null);
        return { ...body, url };
    }

    // ─── account / orders ────────────────────────────────────────────────────────────────────────

    /** newAccount (RFC 8555 §7.3). Idempotent: an existing account for this key answers 200 with its URL. */
    async createAccount(data: { termsOfServiceAgreed?: boolean; contact?: string[] } = {}) {
        const dir = await this.getDirectory();
        const { headers, body } = await this.post(dir.newAccount, data, { useJwk: true });
        const location = headers.get('location');
        if (!location) throw new AcmeError('ACME newAccount answered without the account URL (Location)');
        this.kid = location;
        return body;
    }

    /** newOrder (RFC 8555 §7.4); the order comes back with its own URL as `url`. */
    async createOrder(data: { identifiers: { type: string; value: string }[] }) {
        const dir = await this.getDirectory();
        const { headers, body } = await this.post(dir.newOrder, data);
        const location = headers.get('location');
        if (!location) throw new AcmeError('ACME newOrder answered without the order URL (Location)');
        return { ...body, url: location };
    }

    async getOrder(order: { url: string }) {
        if (!order || !order.url) throw new Error('Unable to get order, URL not found');
        return this.postAsGet(order.url);
    }

    /** Every authorization of an order, each with its own URL as `url`. */
    async getAuthorizations(order: { authorizations?: string[] }) {
        const urls = (order && Array.isArray(order.authorizations)) ? order.authorizations : [];
        const out = [];
        for (const url of urls) out.push(await this.postAsGet(url));
        return out;
    }

    // ─── challenges ──────────────────────────────────────────────────────────────────────────────

    /**
     * What proving a challenge publishes (RFC 8555 §8.1): `token.thumbprint` for http-01 (the file
     * content) and tls-alpn-01; for dns-01 the FINAL TXT value, base64url(sha256(`token.thumbprint`))
     * (§8.4). Never hash the dns-01 value again.
     */
    async getChallengeKeyAuthorization(challenge: { type: string; token: string }) {
        const thumbprint = b64url(nodeCrypto.createHash('sha256').update(canonicalJwk(this.jwk)).digest());
        const keyAuthorization = `${challenge.token}.${thumbprint}`;
        if (challenge.type === 'http-01' || challenge.type === 'tls-alpn-01') return keyAuthorization;
        if (challenge.type === 'dns-01') return b64url(nodeCrypto.createHash('sha256').update(keyAuthorization).digest());
        throw new Error(`Unsupported challenge type ${challenge.type}`);
    }

    /**
     * Local pre-flight: is the challenge answer visible from HERE? (The CA's verdict is what counts —
     * cert-manager treats a miss as advisory.) http-01 fetches the token over port 80; dns-01 resolves
     * the TXT record, following a CNAME the way CA validators do.
     */
    async verifyChallenge(authz: { identifier: { value: string } }, challenge: { type: string; token: string }) {
        const expected = await this.getChallengeKeyAuthorization(challenge);
        const name = authz.identifier.value;
        if (challenge.type === 'http-01') {
            const res = await fetch(`http://${name}/.well-known/acme-challenge/${challenge.token}`, { signal: AbortSignal.timeout(this.timeout) });
            const body = (await res.text()).replace(/\s+$/, '');
            if (body !== expected) throw new Error(`Authorization not found in HTTP response from ${name}`);
            return true;
        }
        if (challenge.type === 'dns-01') {
            let record = `_acme-challenge.${name.replace(/^\*\./, '')}`;
            for (let depth = 0; depth < 5; depth++) {
                let cnames: string[] = [];
                try { cnames = await dnsPromises.resolveCname(record); } catch { /* no CNAME here */ }
                if (!cnames.length) break;
                record = cnames[0];
            }
            let values: string[] = [];
            try { values = (await dnsPromises.resolveTxt(record)).map((chunks: string[]) => chunks.join('')); } catch { /* none */ }
            if (!values.includes(expected)) throw new Error(`Authorization not found in DNS TXT record: ${record}`);
            return true;
        }
        throw new Error(`Unable to verify challenge type ${challenge.type}`);
    }

    /** Tell the CA the challenge is ready to be validated (RFC 8555 §7.5.1: POST `{}`). */
    async completeChallenge(challenge: { url: string }) {
        const { body } = await this.post(challenge.url, {});
        return body;
    }

    /**
     * Poll a challenge, authorization or order until it is `valid`. `invalid` throws the CA's reason at
     * once; `pending`/`processing` waits — exponential backoff from backoffMin to backoffMax, or the CA's
     * Retry-After when it sends one (capped at backoffMax) — for at most backoffAttempts polls.
     */
    async waitForValidStatus(item: { url: string }) {
        if (!item || !item.url) throw new Error('Unable to verify status of item, URL not found');
        for (let attempt = 1; ; attempt++) {
            const { headers, body } = await this.post(item.url, null);
            const status = body && body.status;
            if (status === 'valid') return { ...body, url: item.url };
            if (status === 'invalid') throw new AcmeError(problemMessage(body, `ACME ${item.url} is invalid`), { problem: body });
            if (!PENDING.has(status)) throw new Error(`Unexpected item status: ${status}`);
            if (attempt >= this.backoffAttempts) throw new Error('Operation is pending or processing');
            const backoff = Math.min(this.backoffMax, this.backoffMin * 2 ** (attempt - 1));
            const hinted = parseRetryAfter(headers.get('retry-after'));
            await new Promise((r) => setTimeout(r, hinted === null ? backoff : Math.min(hinted, this.backoffMax)));
        }
    }

    // ─── finalize / download ─────────────────────────────────────────────────────────────────────

    /** Send the CSR to the order's `finalize` URL (RFC 8555 §7.4); returns the updated order. */
    async finalizeOrder(order: { url: string; finalize?: string }, csr: string | Buffer) {
        if (!order || !order.finalize) throw new Error('Unable to finalize order, URL not found');
        const der = x509.pemBody(csr, ['CERTIFICATE REQUEST', 'NEW CERTIFICATE REQUEST']);
        const { body } = await this.post(order.finalize, { csr: b64url(der) });
        return { ...body, url: order.url };
    }

    /** The issued chain (PEM). Waits for the order to become `valid` first when it is still processing. */
    async getCertificate(order: { url: string; status?: string; certificate?: string }) {
        let current: any = order;
        if (!current.status || current.status !== 'valid' || !current.certificate) current = await this.waitForValidStatus(order);
        if (!current.certificate) throw new Error('Unable to download certificate, URL not found');
        const { text } = await this.post(current.certificate, null, { accept: 'application/pem-certificate-chain' });
        if (!/-----BEGIN CERTIFICATE-----/.test(text)) throw new AcmeError('ACME certificate download did not return a PEM chain');
        return text;
    }
}

/** Key and CSR helpers, in the shape acme-client's crypto helpers returned (PEM Buffers). */
const acmeCrypto = {
    /** A new RSA private key, PKCS#1 PEM — the format of every account and certificate key WordJS wrote. */
    async createPrivateKey(bits = 2048): Promise<Buffer> {
        return Buffer.from(x509.generateRsaKeyPair(bits).privateKeyPem);
    },
    /**
     * A fresh key and a CSR for `commonName` plus `altNames`. The common name is always also a
     * subjectAltName — the CA reads the identifiers from the SAN extension.
     */
    async createCsr({ commonName, altNames = [] }: { commonName: string; altNames?: string[] }, keyPem: string | Buffer | null = null): Promise<[Buffer, Buffer]> {
        const key = keyPem ? Buffer.from(keyPem) : await acmeCrypto.createPrivateKey();
        const names = [...new Set([commonName, ...altNames].filter(Boolean))];
        const csr = x509.createCsr({ privateKey: key, subject: [['CN', commonName]], altNames: names });
        return [key, Buffer.from(csr)];
    },
};

module.exports = { Client, directory, crypto: acmeCrypto, AcmeError };

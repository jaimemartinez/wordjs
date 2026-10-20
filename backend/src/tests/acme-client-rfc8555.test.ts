/**
 * core/acme-client — the RFC 8555 client that replaced the npm `acme-client` package (unmaintained since
 * 2024, hard-wired to node-forge) — driven end to end through the REAL certificate flows of
 * core/cert-manager: provisionAutoHTTP (HTTP-01, one certificate for several names, what auto-renewal
 * runs) and the two-step DNS-01 flow (startDNSChallenge → publish → finishDNSChallenge).
 *
 * THE CA. A strict in-process ACME server stands in for Let's Encrypt. It checks what a real CA checks
 * and what a lenient fake would let through: the JWS signature against the account key (RS256 or ES256,
 * RFC 7515/7518), a nonce it issued and never saw before, the `url` header equal to the URL actually
 * requested, `jwk` only on newAccount and the account's `kid` everywhere else, the JOSE content type,
 * POST-as-GET as an EMPTY payload, and a CSR whose self-signature verifies and that names every
 * identifier. It derives the expected key authorization ITSELF from the account JWK (RFC 7638), so a
 * wrong thumbprint or a double-hashed dns-01 value fails validation here exactly as at a real CA. It
 * answers one badNonce, and makes the client wait through `processing` with Retry-After.
 *
 * Only the gateway push is stubbed (pushCertToGateway / updateSSLConfig) — it has its own suite.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const x509 = require('../core/x509');
const acme = require('../core/acme-client');
const certManager = require('../core/cert-manager');
const LEGACY = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-forge-pki.json'), 'utf8'));

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const WWW_CHALLENGES = path.resolve(__dirname, '../../public/.well-known/acme-challenge');
const LIVE = path.resolve(__dirname, '../../ssl/live');

// ─── the CA ────────────────────────────────────────────────────────────────────────────────────────

function strictCa() {
    const caKeys = x509.generateRsaKeyPair(2048);
    const caPem: string = x509.createCertificate({
        subject: [['CN', 'Strict Test ACME CA']], publicKey: caKeys.publicKey, signingKey: caKeys.privateKey,
        notAfter: new Date(Date.now() + 864e5), ca: true, keyUsage: ['keyCertSign', 'cRLSign'],
    });
    const state: any = {
        nonces: new Set<string>(),
        accounts: new Map<string, any>(), // url → { jwk, thumbprint }
        orders: new Map<string, any>(),
        authzs: new Map<string, any>(),
        challenges: new Map<string, any>(),
        published: new Map<string, string>(), // dns-01: what the operator "published" per name
        badNonceOnce: false,
        violations: [] as string[],
        requests: [] as string[],
        signedAlgs: new Set<string>(),
    };
    let base = '';
    let seq = 0;
    const id = () => String(++seq);
    const nonce = () => { const n = b64url(crypto.randomBytes(16)); state.nonces.add(n); return n; };
    const thumbprintOf = (jwk: any) => b64url(crypto.createHash('sha256').update(
        jwk.kty === 'RSA' ? JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n }) : JSON.stringify({ crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y })).digest());

    function send(res: any, status: number, body: any, headers: Record<string, string> = {}) {
        const isText = typeof body === 'string';
        res.writeHead(status, { 'Replay-Nonce': nonce(), 'Content-Type': isText ? 'application/pem-certificate-chain' : (status >= 400 ? 'application/problem+json' : 'application/json'), ...headers });
        res.end(isText ? body : JSON.stringify(body));
    }
    const problem = (res: any, status: number, type: string, detail: string) => send(res, status, { type: `urn:ietf:params:acme:error:${type}`, detail, status });

    // Verify the JWS of one POST; returns { payload, account } or answers the problem itself.
    function verifyJws(req: any, raw: string, res: any, { newAccount = false } = {}) {
        const fail = (why: string) => { state.violations.push(`${req.url}: ${why}`); problem(res, 400, 'malformed', why); return null; };
        if (req.headers['content-type'] !== 'application/jose+json') return fail('Content-Type must be application/jose+json');
        let jws: any;
        try { jws = JSON.parse(raw); } catch { return fail('body is not JSON'); }
        if (Object.keys(jws).sort().join(',') !== 'payload,protected,signature') return fail('not a flattened JWS');
        const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8'));
        if (!['RS256', 'ES256'].includes(header.alg)) return fail(`alg ${header.alg}`);
        if (header.url !== base + req.url) return fail(`url header ${header.url} is not the request URL`);
        if (!state.nonces.has(header.nonce)) return fail('unknown or replayed nonce');
        state.nonces.delete(header.nonce);
        if (state.badNonceOnce) { state.badNonceOnce = false; problem(res, 400, 'badNonce', 'JWS has an invalid anti-replay nonce'); return null; }
        if (('jwk' in header) === ('kid' in header)) return fail('exactly one of jwk / kid');
        let jwk: any;
        let account: any = null;
        if (newAccount) {
            if (!header.jwk) return fail('newAccount must carry jwk');
            jwk = header.jwk;
        } else {
            if (!header.kid) return fail('requests after newAccount must carry kid');
            account = state.accounts.get(header.kid);
            if (!account) return fail('unknown kid');
            jwk = account.jwk;
        }
        const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        const input = Buffer.from(`${jws.protected}.${jws.payload}`, 'ascii');
        const sig = Buffer.from(jws.signature, 'base64url');
        const ok = header.alg === 'RS256'
            ? key.asymmetricKeyType === 'rsa' && crypto.verify('sha256', input, key, sig)
            : key.asymmetricKeyType === 'ec' && crypto.verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, sig);
        if (!ok) return fail('JWS signature does not verify');
        state.signedAlgs.add(header.alg);
        const payload = jws.payload === '' ? null : JSON.parse(Buffer.from(jws.payload, 'base64url').toString('utf8'));
        return { payload, jwk, account, header };
    }

    const server = http.createServer((req: any, res: any) => {
        let raw = '';
        req.on('data', (c: any) => { raw += c; });
        req.on('end', () => {
            state.requests.push(`${req.method} ${req.url}`);
            const u = req.url;
            if (req.method === 'GET' && u === '/dir') {
                return send(res, 200, { newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order`, meta: { termsOfService: `${base}/tos` } });
            }
            if (req.method === 'HEAD' && u === '/nonce') { res.writeHead(200, { 'Replay-Nonce': nonce(), 'Cache-Control': 'no-store' }); return res.end(); }
            if (req.method !== 'POST') return problem(res, 405, 'malformed', 'POST only');

            if (u === '/acct') {
                const v = verifyJws(req, raw, res, { newAccount: true });
                if (!v) return;
                if (!v.payload || v.payload.termsOfServiceAgreed !== true) return problem(res, 400, 'malformed', 'terms not agreed');
                const tp = thumbprintOf(v.jwk);
                for (const [url, a] of state.accounts) if (a.thumbprint === tp) return send(res, 200, { status: 'valid', contact: a.contact }, { Location: url });
                const url = `${base}/acct/${id()}`;
                state.accounts.set(url, { jwk: v.jwk, thumbprint: tp, contact: v.payload.contact });
                return send(res, 201, { status: 'valid', contact: v.payload.contact }, { Location: url });
            }

            const v = verifyJws(req, raw, res);
            if (!v) return;
            const postAsGet = v.payload === null;

            // The account itself (RFC 8555 §7.3.2): POST-as-GET reads it, a payload updates it.
            const acct = state.accounts.get(base + u);
            if (acct) {
                if (base + u !== v.header.kid) return problem(res, 403, 'unauthorized', 'not your account');
                if (!postAsGet && v.payload.contact) acct.contact = v.payload.contact;
                return send(res, 200, { status: 'valid', contact: acct.contact });
            }

            if (u === '/order') {
                const idents = (v.payload && v.payload.identifiers) || [];
                if (!idents.length) return problem(res, 400, 'malformed', 'no identifiers');
                const oid = id();
                const order: any = { id: oid, status: 'pending', identifiers: idents, authorizations: [], finalize: `${base}/order/${oid}/finalize`, account: v.header.kid, polls: 0 };
                for (const ident of idents) {
                    const aid = id();
                    const authz: any = { url: `${base}/authz/${aid}`, identifier: ident, status: 'pending', challenges: [] };
                    for (const type of ['http-01', 'dns-01']) {
                        const ch: any = { type, url: `${base}/chal/${id()}`, token: b64url(crypto.randomBytes(24)), status: 'pending', authz };
                        authz.challenges.push(ch);
                        state.challenges.set(ch.url, ch);
                    }
                    state.authzs.set(authz.url, authz);
                    order.authorizations.push(authz.url);
                }
                state.orders.set(`${base}/order/${oid}`, order);
                return send(res, 201, orderView(order), { Location: `${base}/order/${oid}` });
            }
            const orderUrl = base + u.replace(/\/finalize$/, '');
            const order = state.orders.get(orderUrl);
            if (order && order.account !== v.header.kid) return problem(res, 403, 'unauthorized', 'not your order');
            if (order && u.endsWith('/finalize')) {
                if (order.status !== 'ready') return problem(res, 403, 'orderNotReady', `order is ${order.status}`);
                let csr: any;
                try { csr = x509.parseCsr(x509.toPem('CERTIFICATE REQUEST', Buffer.from(v.payload.csr, 'base64url'))); } catch (e: any) { return problem(res, 400, 'badCSR', e.message); }
                if (!crypto.verify('sha256', csr.info, csr.publicKey, csr.signature)) return problem(res, 400, 'badCSR', 'CSR signature');
                for (const ident of order.identifiers) {
                    if (!csr.info.includes(Buffer.from(ident.value))) return problem(res, 400, 'badCSR', `CSR does not name ${ident.value}`);
                }
                order.certificatePem = x509.createCertificate({
                    subject: [['CN', order.identifiers[0].value]], issuerCertPem: caPem, publicKey: csr.publicKey, signingKey: caKeys.privateKey,
                    notAfter: new Date(Date.now() + 90 * 864e5), ca: false, keyUsage: ['digitalSignature', 'keyEncipherment'], extKeyUsage: ['serverAuth'],
                    altNames: order.identifiers.map((i: any) => i.value),
                });
                order.status = 'processing';
                return send(res, 200, orderView(order), { 'Retry-After': '0' });
            }
            if (order) {
                if (!postAsGet) return problem(res, 400, 'malformed', 'POST-as-GET must have an empty payload');
                if (order.status === 'processing' && ++order.polls >= 2) {
                    order.status = 'valid';
                    order.certificate = `${base}/cert/${order.id}`;
                }
                return send(res, 200, orderView(order), order.status === 'processing' ? { 'Retry-After': '0' } : {});
            }
            const authz = state.authzs.get(base + u);
            if (authz) {
                if (!postAsGet) return problem(res, 400, 'malformed', 'POST-as-GET must have an empty payload');
                return send(res, 200, authzView(authz));
            }
            const ch = state.challenges.get(base + u);
            if (ch) {
                if (postAsGet) {
                    // Poll: a challenge being validated reports `processing` once, then its verdict.
                    if (ch.status === 'processing') { ch.status = ch.verdict; if (ch.verdict === 'valid') ch.authz.status = 'valid'; refreshOrders(); return send(res, 200, challengeView({ ...ch, status: 'processing' }), { 'Retry-After': '0' }); }
                    return send(res, 200, challengeView(ch));
                }
                if (JSON.stringify(v.payload) !== '{}') return problem(res, 400, 'malformed', 'challenge response must be {}');
                const account = v.account;
                const keyAuth = `${ch.token}.${account.thumbprint}`;
                if (ch.type === 'http-01') {
                    let served = '';
                    try { served = fs.readFileSync(path.join(WWW_CHALLENGES, ch.token), 'utf8'); } catch { /* not there */ }
                    ch.verdict = served === keyAuth ? 'valid' : 'invalid';
                } else {
                    const expected = b64url(crypto.createHash('sha256').update(keyAuth).digest());
                    ch.verdict = state.published.get(ch.authz.identifier.value) === expected ? 'valid' : 'invalid';
                }
                if (ch.verdict === 'invalid') ch.error = { type: 'urn:ietf:params:acme:error:unauthorized', detail: `Incorrect validation for ${ch.authz.identifier.value} (${ch.type})` };
                ch.status = 'processing';
                return send(res, 200, challengeView({ ...ch, status: 'pending' }));
            }
            const cert = /^\/cert\/(\d+)$/.exec(u);
            if (cert) {
                const o = state.orders.get(`${base}/order/${cert[1]}`);
                if (!postAsGet) return problem(res, 400, 'malformed', 'POST-as-GET must have an empty payload');
                return send(res, 200, `${o.certificatePem}${caPem}`);
            }
            return problem(res, 404, 'malformed', 'No such challenge');
        });
    });

    function refreshOrders() {
        for (const o of state.orders.values()) {
            if (o.status !== 'pending') continue;
            const all = o.authorizations.map((url: string) => state.authzs.get(url));
            if (all.every((a: any) => a.status === 'valid')) o.status = 'ready';
            if (all.some((a: any) => a.challenges.some((c: any) => c.status === 'invalid'))) o.status = 'invalid';
        }
    }
    const orderView = (o: any) => ({ status: o.status, identifiers: o.identifiers, authorizations: o.authorizations, finalize: o.finalize, ...(o.certificate ? { certificate: o.certificate } : {}) });
    const challengeView = (c: any) => ({ type: c.type, url: c.url, token: c.token, status: c.status, ...(c.status === 'invalid' && c.error ? { error: c.error } : {}) });
    const authzView = (a: any) => ({ identifier: a.identifier, status: a.status, ...(a.status === 'valid' ? { challenges: a.challenges.filter((c: any) => c.status === 'valid').map(challengeView) } : { challenges: a.challenges.map(challengeView) }) });

    return {
        state,
        caPem,
        get directoryUrl() { return `${base}/dir`; },
        start: () => new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })),
        stop: () => new Promise<void>((r) => server.close(() => r())),
    };
}

// ─── the flows ─────────────────────────────────────────────────────────────────────────────────────

describe('core/acme-client against a strict RFC 8555 CA, through cert-manager', () => {
    const ca = strictCa();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-acme-rfc8555-'));
    const saved: any = {};
    let pushed: any[] = [];
    const names = ['acme-e2e.example.test', 'www.acme-e2e.example.test'];

    before(async () => {
        await ca.start();
        saved.production = acme.directory.letsencrypt.production;
        saved.accountKeyPath = certManager.accountKeyPath;
        saved.push = certManager.pushCertToGateway;
        saved.update = certManager.updateSSLConfig;
        saved.pending = certManager.pendingDnsPath;
        certManager.pendingDnsPath = path.join(tmp, 'pending-dns-01.json');
        // initClient addresses acme.directory.letsencrypt.production for a production order: point it at
        // the strict CA. Nothing else about the flow is changed.
        acme.directory.letsencrypt.production = ca.directoryUrl;
        certManager.pushCertToGateway = async (key: string, cert: string) => { pushed.push({ key, cert }); return { success: true }; };
        certManager.updateSSLConfig = async (keyPath: string, certPath: string) => { pushed.push({ key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(certPath, 'utf8') }); };
    });
    after(async () => {
        acme.directory.letsencrypt.production = saved.production;
        certManager.accountKeyPath = saved.accountKeyPath;
        certManager.pushCertToGateway = saved.push;
        certManager.updateSSLConfig = saved.update;
        certManager.pendingDnsPath = saved.pending;
        await ca.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
        for (const n of [...names, 'dns-e2e.example.test']) fs.rmSync(path.join(LIVE, n), { recursive: true, force: true });
    });
    beforeEach(() => { pushed = []; ca.state.violations = []; });
    afterEach(() => {
        assert.deepStrictEqual(ca.state.violations, [], 'the client broke the protocol');
        for (const f of fs.existsSync(WWW_CHALLENGES) ? fs.readdirSync(WWW_CHALLENGES) : []) fs.rmSync(path.join(WWW_CHALLENGES, f), { force: true });
    });

    function assertIssued(dir: string, expectedNames: string[]) {
        const key = fs.readFileSync(path.join(LIVE, dir, 'privkey.pem'), 'utf8');
        const chain = fs.readFileSync(path.join(LIVE, dir, 'fullchain.pem'), 'utf8');
        const leaf = new crypto.X509Certificate(chain);
        assert.ok(leaf.verify(new crypto.X509Certificate(ca.caPem).publicKey), 'the stored certificate is not the one the CA issued');
        assert.ok(leaf.checkPrivateKey(crypto.createPrivateKey(key)), 'privkey.pem does not belong to the issued certificate');
        assert.deepStrictEqual(certManager.readLocalCert(dir).names, expectedNames);
        assert.strictEqual(pushed.length, 1);
        assert.strictEqual(pushed[0].key, key);
        assert.strictEqual(pushed[0].cert, chain);
    }

    it('HTTP-01, a fresh account key, two names in one order — and a badNonce answer is retried', async () => {
        certManager.accountKeyPath = path.join(tmp, 'fresh-account.key');
        ca.state.badNonceOnce = true;
        const out = await certManager.provisionAutoHTTP(names, 'ops@example.test', false);
        assert.strictEqual(out.success, true);
        assertIssued(names[0], names);
        assert.match(fs.readFileSync(certManager.accountKeyPath, 'utf8'), /^-----BEGIN RSA PRIVATE KEY-----/, 'new account keys keep the PKCS#1 format');
        assert.ok(ca.state.signedAlgs.has('RS256'));
        assert.strictEqual(ca.state.badNonceOnce, false, 'the badNonce answer was never exercised');
    });

    it('an account key written by an older release (node-forge, PKCS#1) is the SAME account', async () => {
        const keyPath = path.join(tmp, 'legacy-account.key');
        fs.writeFileSync(keyPath, LEGACY['setup-frontend.key']);
        certManager.accountKeyPath = keyPath;
        const before = ca.state.accounts.size;
        await certManager.provisionAutoHTTP(names, 'ops@example.test', false);
        assertIssued(names[0], names);
        assert.strictEqual(ca.state.accounts.size, before + 1);
        // Registering again with the same key finds the existing account (200 + its URL), not a new one.
        await certManager.initClient('ops@example.test', false);
        assert.strictEqual(ca.state.accounts.size, before + 1);
        const jwk = crypto.createPublicKey(LEGACY['setup-frontend.key']).export({ format: 'jwk' });
        const tp = b64url(crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n })).digest());
        assert.ok([...ca.state.accounts.values()].some((a: any) => a.thumbprint === tp));
    });

    it('an ECDSA P-256 account key signs ES256', async () => {
        const keyPath = path.join(tmp, 'ec-account.key');
        fs.writeFileSync(keyPath, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
        certManager.accountKeyPath = keyPath;
        ca.state.signedAlgs.clear();
        await certManager.provisionAutoHTTP([names[0]], 'ops@example.test', false);
        assertIssued(names[0], [names[0]]);
        assert.deepStrictEqual([...ca.state.signedAlgs], ['ES256']);
    });

    it('DNS-01 in two steps: the value shown is the one the CA expects, and finishing issues the certificate', async () => {
        certManager.accountKeyPath = path.join(tmp, 'fresh-account.key');
        const step1 = await certManager.startDNSChallenge('dns-e2e.example.test', 'ops@example.test', false);
        assert.strictEqual(step1.txtRecord, '_acme-challenge.dns-e2e.example.test');
        assert.strictEqual(step1.directoryUrl, ca.directoryUrl);
        // The operator publishes exactly what the UI showed.
        ca.state.published.set('dns-e2e.example.test', step1.txtValue);
        const done = await certManager.finishDNSChallenge(JSON.parse(JSON.stringify(step1)), 'ops@example.test', false);
        assert.strictEqual(done.success, true);
        assertIssued('dns-e2e.example.test', ['dns-e2e.example.test']);
    });

    it('a challenge the CA rejects fails the order with the CA\'s own reason', async () => {
        certManager.accountKeyPath = path.join(tmp, 'fresh-account.key');
        const step1 = await certManager.startDNSChallenge('dns-e2e.example.test', 'ops@example.test', false);
        ca.state.published.set('dns-e2e.example.test', 'not-the-value');
        await assert.rejects(certManager.finishDNSChallenge(step1, 'ops@example.test', false),
            /DNS verification failed: Incorrect validation for dns-e2e\.example\.test \(dns-01\)/);
        assert.strictEqual(pushed.length, 0);
    });

    it('a certificate for a key other than ours is never written', async () => {
        certManager.accountKeyPath = path.join(tmp, 'fresh-account.key');
        const step1 = await certManager.startDNSChallenge('dns-e2e.example.test', 'ops@example.test', false);
        ca.state.published.set('dns-e2e.example.test', step1.txtValue);
        fs.rmSync(path.join(LIVE, 'dns-e2e.example.test'), { recursive: true, force: true });
        const realCreateCsr = acme.crypto.createCsr;
        // Sign the CSR with one key and hand cert-manager ANOTHER as "its" key: the CA's certificate then
        // belongs to a key cert-manager does not hold.
        acme.crypto.createCsr = async (opts: any) => { const [, csr] = await realCreateCsr(opts); const [other] = await realCreateCsr(opts); return [other, csr]; };
        try {
            await assert.rejects(certManager.finishDNSChallenge(step1, 'ops@example.test', false), /certificate for a different key/);
        } finally {
            acme.crypto.createCsr = realCreateCsr;
        }
        assert.ok(!fs.existsSync(path.join(LIVE, 'dns-e2e.example.test', 'fullchain.pem')), 'nothing was written');
        assert.strictEqual(pushed.length, 0);
    });

    it('step 2 acts on what THIS server minted: the URLs in the request body are ignored', async () => {
        // A browser (or anyone holding an admin session) posts back step-1 data whose every URL points
        // at another server. Nothing is requested there, and the real order still completes.
        const seen: string[] = [];
        const elsewhere = http.createServer((req: any, res: any) => { seen.push(req.url); res.writeHead(500); res.end(); });
        await new Promise<void>((r) => elsewhere.listen(0, '127.0.0.1', () => r()));
        try {
            certManager.accountKeyPath = path.join(tmp, 'fresh-account.key');
            const step1 = await certManager.startDNSChallenge('dns-e2e.example.test', 'ops@example.test', false);
            ca.state.published.set('dns-e2e.example.test', step1.txtValue);
            const other = `http://127.0.0.1:${elsewhere.address().port}`;
            const forged = {
                ...step1,
                directoryUrl: `${other}/dir`, orderUrl: `${other}/order`, authzUrl: `${other}/authz`,
                challenge: { ...step1.challenge, url: `${other}/chal` },
            };
            const done = await certManager.finishDNSChallenge(forged, 'ops@example.test', false);
            assert.strictEqual(done.success, true);
            assert.deepStrictEqual(seen, [], 'the server requested a URL taken from the request body');
            assert.strictEqual(certManager.pendingDnsFor('dns-e2e.example.test'), undefined, 'a finished request is forgotten');
        } finally {
            await new Promise<void>((r) => elsewhere.close(() => r()));
        }
    });

    it('step 2 without a request this server started is refused before any CA work', async () => {
        fs.writeFileSync(certManager.pendingDnsPath, JSON.stringify(certManager.readPendingDns().filter((r: any) => r.domain !== 'dns-e2e.example.test')));
        const requestsBefore = ca.state.requests.length;
        await assert.rejects(certManager.finishDNSChallenge({ domain: 'dns-e2e.example.test', challenge: { url: 'x' } }, 'ops@example.test', false),
            /No certificate request is pending for this domain/);
        assert.strictEqual(ca.state.requests.length, requestsBefore);
    });

    it('a stored request naming a directory this site never uses is refused', async () => {
        const step1 = await certManager.startDNSChallenge('dns-e2e.example.test', 'ops@example.test', false);
        certManager.rememberDnsChallenge({ ...step1, directoryUrl: 'https://169.254.169.254/latest/meta-data/' });
        const requestsBefore = ca.state.requests.length;
        await assert.rejects(certManager.finishDNSChallenge(step1, 'ops@example.test', false),
            /names a certificate authority this site does not use/);
        assert.strictEqual(ca.state.requests.length, requestsBefore);
    });

    it('a challenge the CA no longer knows maps to the "start again" explanation', async () => {
        certManager.accountKeyPath = path.join(tmp, 'fresh-account.key');
        const step1 = await certManager.startDNSChallenge('dns-e2e.example.test', 'ops@example.test', false);
        // The order expired at the CA: its challenge URL is gone there.
        certManager.rememberDnsChallenge({ ...step1, challenge: { ...step1.challenge, url: step1.challenge.url.replace(/\/chal\/\d+$/, '/chal/999999') } });
        await assert.rejects(certManager.finishDNSChallenge(step1, 'ops@example.test', false), /this challenge is no longer valid at the certificate authority/);
    });
});

describe('core/acme-client unit behaviour', () => {
    it('getChallengeKeyAuthorization: token.thumbprint for http-01, base64url(sha256(that)) for dns-01', async () => {
        const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
        const client = new acme.Client({ directoryUrl: 'http://127.0.0.1:1/dir', accountKey: pem });
        const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
        const tp = b64url(crypto.createHash('sha256').update(`{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`).digest());
        assert.strictEqual(await client.getChallengeKeyAuthorization({ type: 'http-01', token: 'tok' }), `tok.${tp}`);
        assert.strictEqual(await client.getChallengeKeyAuthorization({ type: 'dns-01', token: 'tok' }), b64url(crypto.createHash('sha256').update(`tok.${tp}`).digest()));
    });

    it('the directory must be https, or http on loopback only', () => {
        const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
        for (const bad of ['http://10.0.0.5/dir', 'http://ca.example/dir', 'ftp://ca.example/dir', 'https://user:pw@ca.example/dir', 'not a url']) {
            assert.throws(() => new acme.Client({ directoryUrl: bad, accountKey: key }), /ACME directory/, bad);
        }
        for (const good of ['https://acme-v02.api.letsencrypt.org/directory', 'http://127.0.0.1:14000/dir', 'http://localhost:14000/dir']) {
            assert.doesNotThrow(() => new acme.Client({ directoryUrl: good, accountKey: key }), good);
        }
    });

    it('a URL the CA answers with must stay on the directory\'s origin — nothing else is ever requested', async () => {
        const seen: string[] = [];
        const evil = http.createServer((req: any, res: any) => { seen.push(req.url); res.writeHead(200, { 'Replay-Nonce': 'n' }); res.end('{}'); });
        await new Promise<void>((r) => evil.listen(0, '127.0.0.1', () => r()));
        const internal = `http://localhost:${evil.address().port}`;
        const dir = http.createServer((_req: any, res: any) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ newNonce: `${internal}/nonce`, newAccount: `${internal}/acct`, newOrder: `${internal}/order` }));
        });
        await new Promise<void>((r) => dir.listen(0, '127.0.0.1', () => r()));
        try {
            const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
            const client = new acme.Client({ directoryUrl: `http://127.0.0.1:${dir.address().port}/dir`, accountKey: key });
            await assert.rejects(client.createAccount({ termsOfServiceAgreed: true }), /outside its own origin/);
            assert.deepStrictEqual(seen, [], 'the client requested a URL on another origin');
        } finally {
            await new Promise<void>((r) => evil.close(() => r()));
            await new Promise<void>((r) => dir.close(() => r()));
        }
    });

    it('refuses account keys it cannot sign with', () => {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        assert.throws(() => new acme.Client({ directoryUrl: 'http://127.0.0.1:1/dir', accountKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), /RSA or ECDSA P-256/);
    });

    it('createCsr puts the common name in the subjectAltName and returns a matching key', async () => {
        const [key, csr] = await acme.crypto.createCsr({ commonName: 'a.example', altNames: ['b.example'] });
        const parsed = x509.parseCsr(csr);
        assert.ok(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(parsed.publicKey.export({ type: 'spki', format: 'der' })));
        for (const n of ['a.example', 'b.example']) assert.ok(parsed.info.includes(Buffer.from(n)));
    });
});

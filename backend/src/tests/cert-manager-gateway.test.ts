/**
 * WordJS — core/cert-manager, phase 2 of the site-address work: the gateway's control plane is dialled at
 * the configured gatewayHost, and one certificate can cover several names.
 *
 * THE DIALLER. Certificate upload, the TLS/port switch, the info probe and the new "here is the main
 * address" push used to be pinned to https://127.0.0.1:3100, so a separate-mode backend could never reach
 * its gateway and a gateway on another internal port silently stopped hearing about TLS changes. These
 * tests stand up a REAL mTLS listener with a throwaway cluster CA and prove: the default (no gatewayHost)
 * still dials loopback and verifies the certificate as `localhost`; a configured host and port are dialled
 * and verified by their own name; this node presents its CN=backend identity; and a listener whose
 * certificate another CA issued is refused — the request carries private keys, verification is never
 * relaxed.
 *
 * MULTI-IDENTIFIER ACME. One order for every configured name (the main address and its www twin), every
 * pending authorization proved, every name in the CSR; renewal covers ALL of acme.domains (it used to renew
 * domains[0] only) and treats a certificate that does not cover a configured name as due now.
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const forge = require('node-forge');

const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-cm-gateway-${process.pid}-`));
const CONFIG_FILE = path.join(TMP, 'wordjs-config.json');
fs.writeFileSync(CONFIG_FILE, '{}');
process.chdir(TMP);
const SAVED_MODE = process.env.WORDJS_MODE;
const SAVED_EMBEDDED = process.env.WORDJS_EMBEDDED;
delete process.env.WORDJS_MODE;
delete process.env.WORDJS_EMBEDDED;

const configManager = require('../core/configManager');
const certManager = require('../core/cert-manager');
const acme = require('acme-client');

// ─── a throwaway cluster PKI ───────────────────────────────────────────────────────────────────────

function keyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
        pub: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' })),
        priv: forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' })),
        pem: privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
    };
}

function certificate(cn: string, keys: any, issuer: { cert: any; key: any } | null, altNames: any[] = [], days = 30) {
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.pub;
    cert.serialNumber = crypto.randomBytes(8).toString('hex');
    cert.validity.notBefore = new Date(Date.now() - 60000);
    cert.validity.notAfter = new Date(Date.now() + days * 864e5);
    cert.setSubject([{ name: 'commonName', value: cn }]);
    cert.setIssuer(issuer ? issuer.cert.subject.attributes : [{ name: 'commonName', value: cn }]);
    cert.setExtensions(issuer
        ? [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true, clientAuth: true }, ...(altNames.length ? [{ name: 'subjectAltName', altNames }] : [])]
        : [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
    cert.sign(issuer ? issuer.key : keys.priv, forge.md.sha256.create());
    return { cert, pem: forge.pki.certificateToPem(cert) as string };
}

const caKeys = keyPair();
const ca = certificate('Test Cluster CA', caKeys, null);
const issuer = { cert: ca.cert, key: caKeys.priv };
const gwKeys = keyPair();
const gatewayCert = certificate('gateway-internal', gwKeys, issuer, [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }]);
// The same identity, naming ONLY its IP: tells "verified by its own name" apart from "verified as localhost".
const ipOnlyCert = certificate('gateway-internal', gwKeys, issuer, [{ type: 7, ip: '127.0.0.1' }]);
const beKeys = keyPair();
const backendCert = certificate('backend', beKeys, issuer, [{ type: 2, value: 'localhost' }]);
const rogueCaKeys = keyPair();
const rogueCa = certificate('Rogue CA', rogueCaKeys, null);
const rogueKeys = keyPair();
const rogueCert = certificate('gateway-internal', rogueKeys, { cert: rogueCa.cert, key: rogueCaKeys.priv }, [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }]);

const CERTS = path.join(TMP, 'certs');
fs.mkdirSync(CERTS);
fs.writeFileSync(path.join(CERTS, 'cluster-ca.crt'), ca.pem);
fs.writeFileSync(path.join(CERTS, 'backend.crt'), backendCert.pem);
fs.writeFileSync(path.join(CERTS, 'backend.key'), beKeys.pem);
const MTLS = { ca: path.join(CERTS, 'cluster-ca.crt'), key: path.join(CERTS, 'backend.key'), cert: path.join(CERTS, 'backend.crt') };

// ─── a gateway control plane ───────────────────────────────────────────────────────────────────────

const seen: Array<{ method: string; url: string; body: string; peer: string }> = [];
function controlPlane(certPem: string, keyPem: string) {
    return https.createServer({ cert: certPem, key: keyPem, ca: ca.pem, requestCert: true, rejectUnauthorized: true }, (req: any, res: any) => {
        let body = '';
        req.on('data', (c: any) => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, body, peer: req.socket.getPeerCertificate().subject.CN });
            res.setHeader('Content-Type', 'application/json');
            res.end(req.url === '/info' ? JSON.stringify({ gatewayPort: 443, sslEnabled: true, siteUrl: 'https://example.com' }) : JSON.stringify({ success: true, siteUrl: JSON.parse(body || '{}').siteUrl || null }));
        });
    });
}
const genuine = controlPlane(gatewayCert.pem, gwKeys.pem);
const impostor = controlPlane(rogueCert.pem, rogueKeys.pem);
const ipOnly = controlPlane(ipOnlyCert.pem, gwKeys.pem);
let genuinePort = 0;
let impostorPort = 0;
let ipOnlyPort = 0;

before(async () => {
    await new Promise<void>((r) => genuine.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => ipOnly.listen(0, '127.0.0.1', r));
    genuinePort = genuine.address().port;
    impostorPort = impostor.address().port;
    ipOnlyPort = ipOnly.address().port;
});

after(async () => {
    await new Promise<void>((r) => genuine.close(() => r()));
    await new Promise<void>((r) => impostor.close(() => r()));
    await new Promise<void>((r) => ipOnly.close(() => r()));
    if (SAVED_MODE === undefined) delete process.env.WORDJS_MODE; else process.env.WORDJS_MODE = SAVED_MODE;
    if (SAVED_EMBEDDED === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = SAVED_EMBEDDED;
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

function stage(cfg: Record<string, unknown>) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    configManager.invalidateConfigCache();
    seen.length = 0;
}

describe('the gateway control plane is dialled at gatewayHost:gatewayInternalPort, over verified mTLS', () => {
    test('no gatewayHost: loopback, verified as localhost — and this node presents CN=backend', async () => {
        stage({ mtls: MTLS, gatewayInternalPort: genuinePort });
        const answer = await certManager.pushSiteUrlToGateway('https://example.com');
        assert.deepStrictEqual(answer, { success: true, siteUrl: 'https://example.com' });
        assert.deepStrictEqual(seen.map((s) => [s.method, s.url, JSON.parse(s.body), s.peer]),
            [['POST', '/config-update', { siteUrl: 'https://example.com' }, 'backend']]);
    });

    test('an enrolled node dials its configured host and verifies it by its own name', async () => {
        stage({ mtls: MTLS, gatewayHost: '127.0.0.1', advertiseHost: '127.0.0.1', gatewayInternalPort: genuinePort });
        const info = await certManager.getConfig();
        assert.strictEqual(info.siteUrl, 'https://example.com');
        assert.strictEqual(info.error, undefined);
        assert.deepStrictEqual(seen.map((s) => [s.method, s.url]), [['GET', '/info']]);

        stage({ mtls: MTLS, gatewayHost: 'localhost', gatewayInternalPort: genuinePort });
        const result = await certManager.updateGatewayConfig(443, true);
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(JSON.parse(seen[0].body), { port: 443, sslEnabled: true });

        // By its OWN name: a gateway whose certificate names only its IP is accepted when that IP is the
        // configured host — no `localhost` servername is forced on an enrolled node.
        stage({ mtls: MTLS, gatewayHost: '127.0.0.1', advertiseHost: '127.0.0.1', gatewayInternalPort: ipOnlyPort });
        assert.strictEqual((await certManager.pushSiteUrlToGateway('https://example.com')).success, true);
        assert.deepStrictEqual(seen.map((s) => [s.method, s.url]), [['POST', '/config-update']]);
    });

    test('a single-host install carrying a legacy gatewayHost still dials loopback, verified as localhost', async () => {
        // Installs made before the enrolment model wrote `gateway.<domain>` (or the raw IP of an IP install)
        // into gatewayHost. That name usually does not resolve, and the gateway's internal listener binds
        // 127.0.0.1: dialling it broke the SSL switch and every certificate push. Only an ENROLLED node
        // (advertiseHost, scripts/node-join.js) has its gateway on another machine.
        stage({ mtls: MTLS, gatewayHost: 'gateway.example.invalid', gatewayInternalPort: genuinePort });
        assert.deepStrictEqual(await certManager.pushSiteUrlToGateway('https://example.com'), { success: true, siteUrl: 'https://example.com' });
        assert.strictEqual((await certManager.updateGatewayConfig(443, true)).success, true);
        assert.deepStrictEqual(seen.map((s) => [s.method, s.url, s.peer]), [['POST', '/config-update', 'backend'], ['POST', '/config-update', 'backend']]);

        stage({ mtls: MTLS, gatewayHost: '192.0.2.50', gatewayInternalPort: genuinePort });
        assert.strictEqual((await certManager.getConfig()).siteUrl, 'https://example.com', 'the raw IP of a legacy IP install is not dialled either');

        // Verified as `localhost`, as it always was: a certificate naming only the IP does not pass.
        stage({ mtls: MTLS, gatewayHost: '127.0.0.1', gatewayInternalPort: ipOnlyPort });
        await assert.rejects(() => certManager.pushSiteUrlToGateway('https://example.com'));
        assert.deepStrictEqual(seen, []);
    });

    test('the same legacy-looking gatewayHost IS dialled once the node is enrolled (advertiseHost)', async () => {
        stage({ mtls: MTLS, gatewayHost: 'gateway.example.invalid', advertiseHost: '10.0.0.7', gatewayInternalPort: genuinePort });
        await assert.rejects(() => certManager.pushSiteUrlToGateway('https://example.com'),
            (e: any) => ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(e && e.code) || /gateway\.example\.invalid/.test(String(e && e.message)));
        assert.deepStrictEqual(seen, [], 'the loopback listener is not the one dialled');
    });

    test('the host policy is pushed to POST /host-policy as sent, over the same verified channel', async () => {
        stage({ mtls: MTLS, gatewayInternalPort: genuinePort });
        const body = { enforce: true, config: { siteUrl: 'https://example.com', siteAliases: ['https://www.example.com'], hostPolicy: { ipLiterals: 'own' } }, env: {}, nodeEnv: 'production' };
        assert.strictEqual((await certManager.pushHostPolicyToGateway(body)).success, true);
        assert.deepStrictEqual(seen.map((s) => [s.method, s.url, JSON.parse(s.body), s.peer]), [['POST', '/host-policy', body, 'backend']]);

        stage({ mtls: MTLS, gatewayInternalPort: impostorPort });
        await assert.rejects(() => certManager.pushHostPolicyToGateway(body));
        assert.deepStrictEqual(seen, [], 'a listener the cluster CA did not issue never learns the policy');
    });

    test('a listener holding another CA\'s certificate never receives the request', async () => {
        stage({ mtls: MTLS, gatewayInternalPort: impostorPort });
        await assert.rejects(() => certManager.pushSiteUrlToGateway('https://example.com'));
        await assert.rejects(() => certManager.pushCertToGateway('-----BEGIN PRIVATE KEY-----', '-----BEGIN CERTIFICATE-----'));
        assert.deepStrictEqual(seen, [], 'the private key never left: the handshake failed first');
        assert.strictEqual((await certManager.getConfig()).error, 'Gateway Unreachable');
    });

    test('a node without cluster identity says so instead of dialling', async () => {
        stage({ gatewayInternalPort: genuinePort });
        await assert.rejects(() => certManager.pushSiteUrlToGateway('https://example.com'), (e: any) => e.code === 'WJS_NO_CLUSTER_IDENTITY');
        assert.strictEqual((await certManager.getConfig()).error, 'Backend mTLS Key not found');
        assert.deepStrictEqual(seen, []);
    });
});

// ─── the install never mints the public name into the cluster's trust ──────────────────────────────

describe('a single-host install issues internal identities for this machine only', () => {
    test('no subjectAltName derived from the address the install arrived on; the control plane is localhost', () => {
        const certManagerModule = require('../core/certManager');
        const saved = { ca: certManagerModule.generateClusterCA, svc: certManagerModule.generateServiceCert };
        const issued: any[][] = [];
        certManagerModule.generateClusterCA = () => ({ key: 'ca-key', cert: 'ca-cert' });
        certManagerModule.generateServiceCert = (...args: any[]) => { issued.push(args); };
        try {
            const installed: Record<string, any> = { siteUrl: 'https://blog.example.com', gatewayHost: 'blog.example.com' };
            require('../routes/setup').issueLocalClusterIdentity(installed);
            assert.deepStrictEqual(issued, [
                ['gateway-internal', 'ca-key', 'ca-cert'],
                ['backend', 'ca-key', 'ca-cert'],
                ['frontend', 'ca-key', 'ca-cert'],
            ], 'only the built-in localhost / 127.0.0.1 names — never gateway.<site host>');
            assert.strictEqual(installed.gatewayHost, 'localhost');
            assert.deepStrictEqual(installed.mtls, { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' });
        } finally {
            certManagerModule.generateClusterCA = saved.ca;
            certManagerModule.generateServiceCert = saved.svc;
        }
    });
});

// ─── multi-identifier ACME ─────────────────────────────────────────────────────────────────────────

describe('one certificate for several names', () => {
    const LIVE = path.resolve(__dirname, '..', '..', 'ssl', 'live');
    const A = `multi-a-${process.pid}.invalid`;
    const B = `www.multi-a-${process.pid}.invalid`;
    const saved: Record<string, any> = {};
    let calls: any[] = [];

    beforeEach(() => {
        calls = [];
        for (const k of ['initClient', 'client', 'writeChallengeFile', 'pushCertToGateway']) saved[k] = certManager[k];
        saved.createCsr = acme.forge.createCsr;
        certManager.initClient = async () => { /* no network */ };
        certManager.writeChallengeFile = async (token: string) => { calls.push(['writeChallengeFile', token]); };
        certManager.pushCertToGateway = async () => { calls.push(['push']); };
        acme.forge.createCsr = async (opts: any) => { calls.push(['createCsr', opts]); return [Buffer.from('key'), Buffer.from('csr')]; };
    });
    afterEach(() => {
        for (const k of Object.keys(saved)) {
            if (k === 'createCsr') acme.forge.createCsr = saved.createCsr; else certManager[k] = saved[k];
        }
        for (const d of [A, B]) fs.rmSync(path.join(LIVE, d), { recursive: true, force: true });
    });

    function stubClient(authzs: any[]) {
        return {
            createOrder: async (o: any) => { calls.push(['createOrder', o.identifiers.map((i: any) => i.value)]); return { url: 'https://ca.example/order/1' }; },
            getAuthorizations: async () => authzs,
            getChallengeKeyAuthorization: async (c: any) => `ka-${c.token}`,
            verifyChallenge: async () => { throw new Error('no hairpin (pre-verify is advisory)'); },
            completeChallenge: async (c: any) => { calls.push(['complete', c.token]); },
            waitForValidStatus: async (c: any) => { calls.push(['wait', c.token]); },
            getOrder: async ({ url }: any) => ({ url, finalize: `${url}/finalize` }),
            finalizeOrder: async (o: any) => o,
            getCertificate: async () => '-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n',
        };
    }

    test('every name is ordered, every pending one proved, every one in the CSR', async () => {
        certManager.client = stubClient([
            { url: 'authz/a', identifier: { value: A }, challenges: [{ type: 'http-01', token: 'tok-a' }] },
            { url: 'authz/b', identifier: { value: B }, challenges: [{ type: 'http-01', token: 'tok-b' }] },
        ]);
        const result = await certManager.provisionAutoHTTP([A, B.toUpperCase(), A], 'ops@example.com');
        assert.deepStrictEqual(result.domains, [A, B], 'deduplicated, lower-cased, order kept');
        const names = (kind: string) => calls.filter((c) => c[0] === kind).map((c) => c[1]);
        assert.deepStrictEqual(names('createOrder'), [[A, B]]);
        assert.deepStrictEqual(names('writeChallengeFile'), ['tok-a', 'tok-b']);
        assert.deepStrictEqual(names('complete'), ['tok-a', 'tok-b']);
        assert.deepStrictEqual(names('wait'), ['tok-a', 'tok-b']);
        assert.deepStrictEqual(names('createCsr'), [{ commonName: A, altNames: [A, B] }]);
        assert.ok(fs.existsSync(path.join(LIVE, A, 'fullchain.pem')), 'stored under the FIRST name');
        assert.ok(calls.some((c) => c[0] === 'push'));
    });

    test('a name the CA already validated needs no challenge', async () => {
        certManager.client = stubClient([
            { url: 'authz/a', identifier: { value: A }, status: 'valid', challenges: [] },
            { url: 'authz/b', identifier: { value: B }, challenges: [{ type: 'http-01', token: 'tok-b' }] },
        ]);
        await certManager.provisionAutoHTTP([A, B], 'ops@example.com');
        assert.deepStrictEqual(calls.filter((c) => c[0] === 'writeChallengeFile').map((c) => c[1]), ['tok-b']);
    });

    test('one unstorable name refuses the whole order before any CA work', async () => {
        certManager.client = stubClient([]);
        await assert.rejects(() => certManager.provisionAutoHTTP([A, '../../escape'], 'ops@example.com'), /Invalid domain/);
        assert.deepStrictEqual(calls, []);
    });

    test('renewal covers every configured name, and a certificate missing one is due now', async () => {
        const config = require('../config/app');
        const savedAcme = config.acme;
        const savedProvision = certManager.provisionAutoHTTP;
        const provisioned: any[] = [];
        certManager.provisionAutoHTTP = async (domains: any) => { provisioned.push(domains); return { success: true }; };
        try {
            // A live certificate for A only, 60 days left — not due by date.
            const leafKeys = keyPair();
            const leaf = certificate(A, leafKeys, issuer, [{ type: 2, value: A }], 60);
            fs.mkdirSync(path.join(LIVE, A), { recursive: true });
            fs.writeFileSync(path.join(LIVE, A, 'fullchain.pem'), leaf.pem);
            assert.deepStrictEqual(certManager.readLocalCert(A).names, [A]);

            config.acme = { enabled: true, email: 'ops@example.com', domains: [A], renewBeforeDays: 30, challengeType: 'http-01' };
            const notDue = await certManager.renewIfDue();
            assert.strictEqual(notDue.reason, 'not_due', JSON.stringify(notDue));

            config.acme = { ...config.acme, domains: [A, B] };
            const due = await certManager.renewIfDue();
            assert.strictEqual(due.ok, true, JSON.stringify(due));
            assert.deepStrictEqual(provisioned, [[A, B]], 'ONE order for every configured name, because B is not covered yet');
        } finally {
            config.acme = savedAcme;
            certManager.provisionAutoHTTP = savedProvision;
        }
    });
});

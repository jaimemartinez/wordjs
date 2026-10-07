/**
 * mail-server direct-MX STARTTLS fallback suite.
 *
 * WHY THIS FILE EXISTS: deliverDirect verifies the MX host's STARTTLS certificate and, on a certificate
 * VERIFICATION failure only, retries that one host with verification disabled and logs the downgrade.
 * The detector matched err.code against the OpenSSL/Node verify codes, but nodemailer (9 and 10) sends
 * every socket error through _onError(err, 'ESOCKET') → _formatError, which overwrites err.code with
 * 'ESOCKET' on the same object. The fallback therefore never fired — every delivery to an MX with a
 * self-signed, expired or mismatched certificate failed — and no test noticed, because nothing had ever
 * driven it with the error nodemailer really produces.
 *
 * HOW IT AVOIDS A FIXTURE THAT DOES NOT MATCH THE PRODUCER: no error object is built by hand. The suite
 * LOADS THE REAL PLUGIN MODULE (marketplace/plugins/mail-server/index.js, as the mailbox-gate suite
 * does) and runs its REAL deliverDirect with the REAL nodemailer against real local endpoints — an
 * smtp-server presenting generated certificates, and raw sockets for the handshake failures — so every
 * error the classifier sees is the one Node and nodemailer actually emit on this runtime. A Node/OpenSSL
 * upgrade that rewords a verify reason fails here instead of silently disabling the fallback.
 *
 * Only the seams that would otherwise make the test impossible are replaced:
 *   - the host DNS bridge (`wordjs.dns.resolveMx`) answers one MX, `mx.example.test`;
 *   - assertPublicHost pins that MX to 127.0.0.1 — the real SSRF guard refuses loopback by design, and
 *     loopback is where a test server lives;
 *   - nodemailer.createTransport dials the test server's port instead of 25 and trusts the test CA
 *     (`ca`, standing in for the public CA bundle so a host CAN present a valid certificate). The options
 *     deliverDirect passes are recorded as given; its own `tls` options (rejectUnauthorized, servername)
 *     reach nodemailer unchanged.
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import tls from 'tls';
import vm from 'vm';

const forge = require('node-forge');
const realNodemailer = require('nodemailer');
const { SMTPServer } = require('smtp-server');

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');

const MX_HOST = 'mx.example.test';
const RECIPIENT = 'someone@dest.example';
const MAIL = { fromEmail: 'news@site.example', fromName: 'Site', subject: 'Hello', text: 'Body' };

// --- Certificates -------------------------------------------------------------------------------

type Cert = { key: string; pem: string; priv: any; cert: any };

function makeCert(o: { cn: string; san?: string; issuer?: Cert; ca?: boolean; notBefore?: Date; notAfter?: Date }): Cert {
    const pair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const priv = forge.pki.privateKeyFromPem(pair.privateKey);
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
    cert.serialNumber = '01' + crypto.randomBytes(8).toString('hex');
    cert.validity.notBefore = o.notBefore || new Date(Date.now() - 86400000);
    cert.validity.notAfter = o.notAfter || new Date(Date.now() + 86400000);
    const subject = [{ name: 'commonName', value: o.cn }];
    cert.setSubject(subject);
    cert.setIssuer(o.issuer ? o.issuer.cert.subject.attributes : subject);
    const extensions: any[] = [{ name: 'basicConstraints', cA: !!o.ca }];
    if (o.ca) extensions.push({ name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true });
    if (o.san) extensions.push({ name: 'subjectAltName', altNames: [{ type: 2, value: o.san }] });
    cert.setExtensions(extensions);
    cert.sign(o.issuer ? o.issuer.priv : priv, forge.md.sha256.create());
    return { key: pair.privateKey, pem: forge.pki.certificateToPem(cert), priv, cert };
}

const TRUSTED_CA = makeCert({ cn: 'Suite Trusted Root', ca: true });
const UNKNOWN_ROOT = makeCert({ cn: 'Unknown Root', ca: true });
const UNKNOWN_INTERMEDIATE = makeCert({ cn: 'Unknown Intermediate', ca: true, issuer: UNKNOWN_ROOT });
const VALID_LEAF = makeCert({ cn: MX_HOST, san: MX_HOST, issuer: TRUSTED_CA });

// --- The real plugin module, plus the seams named in the header ----------------------------------

const attempts: { host: string; port: number; tls: any }[] = [];
let targetPort = 0;

const nodemailerSeam = {
    ...realNodemailer,
    createTransport(opts: any) {
        attempts.push({ host: opts.host, port: opts.port, tls: { ...opts.tls } });
        return realNodemailer.createTransport({ ...opts, port: targetPort, tls: { ...opts.tls, ca: TRUSTED_CA.pem } });
    },
};

// Appended to the shipped source, so it closes over the module's own bindings: exposes the two
// functions under test and swaps the two network seams. Nothing in the plugin's code is altered.
const SUITE_HOOK = `
;module.exports.__mxTlsSuite = {
    deliverDirect,
    isTlsVerifyError,
    install(mxHost, pinnedIp) {
        wordjs = { dns: { resolveMx: async () => [{ exchange: mxHost, priority: 10 }] } };
        assertPublicHost = async () => [pinnedIp];
    },
};`;

const plugin: { deliverDirect: Function; isTlsVerifyError: (e: any) => boolean; install: Function } = (() => {
    const moduleObj: any = { exports: {} };
    const requireShim = (spec: string) => {
        if (spec === 'nodemailer') return nodemailerSeam;
        if (spec.startsWith('.')) return require(path.resolve(PLUGIN_DIR, spec));
        return require(spec);
    };
    const wrapper: any = vm.runInThisContext(
        `(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(PLUGIN_SRC, 'utf8')}\n${SUITE_HOOK}\n})`,
        { filename: PLUGIN_SRC }
    );
    wrapper(moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    const hooks = moduleObj.exports.__mxTlsSuite;
    hooks.install(MX_HOST, '127.0.0.1');
    return hooks;
})();

/** Run the real deliverDirect against `port`; collect its outcome, the transports it built and its warnings. */
async function deliver(port: number) {
    targetPort = port;
    attempts.length = 0;
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    try {
        const result = await plugin.deliverDirect(RECIPIENT, MAIL, undefined, 'mail.site.example');
        return { result, error: null as any, attempts: attempts.slice(), warnings };
    } catch (error) {
        return { result: null as any, error: error as any, attempts: attempts.slice(), warnings };
    } finally {
        console.warn = realWarn;
    }
}

/** The bare nodemailer error for a verified send to `port` — the object deliverDirect's catch receives. */
async function verifiedSendError(port: number) {
    const transport = realNodemailer.createTransport({
        host: '127.0.0.1', port, secure: false, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000,
        tls: { rejectUnauthorized: true, servername: MX_HOST, ca: TRUSTED_CA.pem },
    });
    try {
        await transport.sendMail({ envelope: { from: MAIL.fromEmail, to: RECIPIENT }, from: MAIL.fromEmail, to: RECIPIENT, subject: 'x', text: 'x' });
        return null;
    } catch (e) {
        return e as any;
    } finally {
        transport.close();
    }
}

// --- Local endpoints ----------------------------------------------------------------------------

const closers: (() => Promise<void>)[] = [];
after(async () => { await Promise.all(closers.map((c) => c())); });

/**
 * An SMTP server offering STARTTLS with the given certificate chain. Each received message records
 * whether its session had upgraded to TLS: the downgrade only drops VERIFICATION, never encryption.
 */
async function smtpWith(key: string, certChain: string, extra: Record<string, unknown> = {}) {
    const received: { body: string; secure: boolean }[] = [];
    const server = new SMTPServer({
        key, cert: certChain, authOptional: true, disabledCommands: ['AUTH'], logger: false, closeTimeout: 500,
        onData(stream: any, session: any, cb: (err?: Error) => void) {
            let body = '';
            stream.on('data', (d: Buffer) => { body += d.toString(); });
            stream.on('end', () => { received.push({ body, secure: session.secure === true }); cb(); });
        },
        ...extra,
    });
    server.on('error', () => { /* the server side of a refused handshake; the client's view is what is tested */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { port: server.server.address().port as number, received };
}

/** A raw endpoint that speaks SMTP up to STARTTLS's 220 and then hands the client's ClientHello to `onHello`. */
async function starttlsThen(onHello: (socket: net.Socket) => void) {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => { /* reset by design */ });
        socket.write(`220 ${MX_HOST} ESMTP\r\n`);
        const onCommand = (chunk: Buffer) => {
            const line = chunk.toString();
            if (/^EHLO/i.test(line)) socket.write(`250-${MX_HOST}\r\n250 STARTTLS\r\n`);
            else if (/^STARTTLS/i.test(line)) {
                socket.off('data', onCommand);
                socket.write('220 2.0.0 Ready to start TLS\r\n');
                socket.once('data', () => onHello(socket));
            }
        };
        socket.on('data', onCommand);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
    return (server.address() as net.AddressInfo).port;
}

/** The error Node itself raises for a verified TLS connection to a server presenting `chain` — no nodemailer in between. */
async function rawTlsVerifyError(key: string, chain: string) {
    const sockets = new Set<net.Socket>();
    const server = tls.createServer({ key, cert: chain }, (socket) => socket.end());
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('tlsClientError', () => { /* the client refused the certificate — that is the point */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
    const port = (server.address() as net.AddressInfo).port;
    return new Promise<any>((resolve) => {
        const socket = tls.connect({ host: '127.0.0.1', port, servername: MX_HOST, ca: TRUSTED_CA.pem, rejectUnauthorized: true },
            () => { socket.end(); resolve(null); });
        socket.on('error', resolve);
    });
}

function assertNoDowngrade(run: Awaited<ReturnType<typeof deliver>>, label: string) {
    assert.ok(run.error, `${label}: delivery must fail, got ${JSON.stringify(run.result)}`);
    assert.deepStrictEqual(run.attempts.map((a) => a.tls.rejectUnauthorized), [true],
        `${label}: only the verified attempt may be made — a second, unverified one is the downgrade`);
    assert.ok(!run.warnings.some((w) => w.includes('[MailServer][TLS]')), `${label}: no downgrade may be logged`);
}

// --- A verified host is never retried -----------------------------------------------------------

test('a host with a valid certificate is delivered on the verified attempt alone', async () => {
    const srv = await smtpWith(VALID_LEAF.key, VALID_LEAF.pem);
    const run = await deliver(srv.port);
    assert.strictEqual(run.error, null, run.error && run.error.message);
    assert.strictEqual(run.result.ok, true);
    assert.strictEqual(run.result.tlsDowngraded, undefined);
    assert.deepStrictEqual(run.attempts.map((a) => [a.host, a.port, a.tls.rejectUnauthorized, a.tls.servername]),
        [['127.0.0.1', 25, true, MX_HOST]],
        'deliverDirect dials the pinned IP on 25 and verifies against the real MX hostname');
    assert.deepStrictEqual(srv.received.map((m) => m.secure), [true], 'delivered once, over STARTTLS');
});

// --- Every certificate-verification failure of the policy takes the logged downgrade ------------

const CERT_FAILURES: { name: string; key: string; chain: string; reason: RegExp }[] = (() => {
    const selfSigned = makeCert({ cn: MX_HOST, san: MX_HOST });
    const unknownIssuer = makeCert({ cn: MX_HOST, san: MX_HOST, issuer: UNKNOWN_ROOT });
    const wrongHost = makeCert({ cn: 'other.example.test', san: 'other.example.test', issuer: TRUSTED_CA });
    const expired = makeCert({
        cn: MX_HOST, san: MX_HOST, issuer: TRUSTED_CA,
        notBefore: new Date(Date.now() - 3 * 86400000), notAfter: new Date(Date.now() - 86400000),
    });
    return [
        { name: 'self-signed leaf (DEPTH_ZERO_SELF_SIGNED_CERT)', key: selfSigned.key, chain: selfSigned.pem, reason: /^self[- ]signed certificate(;|$)/ },
        { name: 'untrusted issuer, leaf only (UNABLE_TO_VERIFY_LEAF_SIGNATURE)', key: unknownIssuer.key, chain: unknownIssuer.pem, reason: /^unable to verify the first certificate/ },
        { name: 'self-signed root in the chain (SELF_SIGNED_CERT_IN_CHAIN)', key: unknownIssuer.key, chain: unknownIssuer.pem + UNKNOWN_ROOT.pem, reason: /^self[- ]signed certificate in certificate chain/ },
        { name: 'hostname mismatch (ERR_TLS_CERT_ALTNAME_INVALID)', key: wrongHost.key, chain: wrongHost.pem, reason: /^Hostname\/IP does not match certificate's altnames/ },
        { name: 'expired certificate (CERT_HAS_EXPIRED)', key: expired.key, chain: expired.pem, reason: /^certificate has expired/ },
    ];
})();

for (const c of CERT_FAILURES) {
    test(`certificate failure → logged downgrade: ${c.name}`, async () => {
        const srv = await smtpWith(c.key, c.chain);

        // The shape this suite exists for: nodemailer has replaced the verify code with ESOCKET.
        const raw = await verifiedSendError(srv.port);
        assert.ok(raw, 'the verified send must fail');
        assert.strictEqual(raw.code, 'ESOCKET', 'nodemailer reports the verify failure as a socket error');
        assert.match(raw.message, c.reason);
        assert.strictEqual(plugin.isTlsVerifyError(raw), true, `not recognised: ${raw.code} / ${raw.message}`);

        const run = await deliver(srv.port);
        assert.strictEqual(run.error, null, `the fallback did not fire: ${run.error && run.error.message}`);
        assert.strictEqual(run.result.ok, true);
        assert.strictEqual(run.result.tlsDowngraded, true);
        assert.strictEqual(run.result.mx, MX_HOST);
        assert.deepStrictEqual(run.attempts.map((a) => [a.host, a.tls.rejectUnauthorized, a.tls.servername]),
            [['127.0.0.1', true, MX_HOST], ['127.0.0.1', false, MX_HOST]],
            'verified first, then ONE unverified retry of the same pinned host');
        assert.deepStrictEqual(srv.received.map((m) => m.secure), [true],
            'only the downgraded attempt delivers, and it still upgrades to TLS — verification is off, encryption is not');
        assert.ok(run.warnings.some((w) => w.includes(`[MailServer][TLS] STARTTLS verification FAILED for ${MX_HOST}`)),
            `the downgrade must be logged; got ${JSON.stringify(run.warnings)}`);
    });
}

// --- The same failure without nodemailer's rewrite is recognised by its code --------------------

test('a verify error that still carries its Node code is classified by that code, against the same exact list', async () => {
    // deliverDirect's errors come through nodemailer, which rewrites the code to ESOCKET (the cases
    // above). The code branch keeps the fallback working if that rewrite ever stops — a nodemailer that
    // preserves err.code would hand over exactly what Node's TLS socket raised, which is what this
    // drives. Without the branch such an error would fail the ESOCKET gate and silently lose the fallback.
    const selfSigned = makeCert({ cn: MX_HOST, san: MX_HOST });
    const inPolicy = await rawTlsVerifyError(selfSigned.key, selfSigned.pem);
    assert.strictEqual(inPolicy && inPolicy.code, 'DEPTH_ZERO_SELF_SIGNED_CERT', inPolicy && inPolicy.message);
    assert.strictEqual(plugin.isTlsVerifyError(inPolicy), true);

    const leaf = makeCert({ cn: MX_HOST, san: MX_HOST, issuer: UNKNOWN_INTERMEDIATE });
    const outside = await rawTlsVerifyError(leaf.key, leaf.pem + UNKNOWN_INTERMEDIATE.pem);
    assert.strictEqual(outside && outside.code, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', outside && outside.message);
    assert.strictEqual(plugin.isTlsVerifyError(outside), false, 'a code outside the policy is not downgraded either');
});

// --- Nothing else does --------------------------------------------------------------------------

test('a verification failure outside the policy (unknown root behind an intermediate) is not downgraded', async () => {
    const leaf = makeCert({ cn: MX_HOST, san: MX_HOST, issuer: UNKNOWN_INTERMEDIATE });
    const srv = await smtpWith(leaf.key, leaf.pem + UNKNOWN_INTERMEDIATE.pem);
    const raw = await verifiedSendError(srv.port);
    assert.ok(raw && raw.code === 'ESOCKET', 'a certificate failure, reported the same way');
    assert.strictEqual(plugin.isTlsVerifyError(raw), false, `the policy list is exact: ${raw.message}`);
    assertNoDowngrade(await deliver(srv.port), 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    assert.strictEqual(srv.received.length, 0);
});

test('a connection reset during the TLS handshake is not downgraded', async () => {
    const port = await starttlsThen((socket) => socket.resetAndDestroy());
    const raw = await verifiedSendError(port);
    assert.ok(raw && raw.code === 'ESOCKET', `a socket error like the certificate ones: ${raw && raw.message}`);
    assert.strictEqual(plugin.isTlsVerifyError(raw), false);
    const run = await deliver(port);
    assertNoDowngrade(run, 'ECONNRESET');
    assert.strictEqual(run.error.permanent, false, 'a network failure stays retryable');
});

test('a TLS protocol error — whatever text the peer sends — is not downgraded', async () => {
    // The peer answers the ClientHello with plaintext that QUOTES a verify reason: the error is OpenSSL's
    // record-layer failure, and nothing the peer sends can become the message the classifier compares.
    const port = await starttlsThen((socket) => socket.end('self-signed certificate\r\ncertificate has expired\r\n'));
    const raw = await verifiedSendError(port);
    assert.ok(raw && raw.code === 'ESOCKET', `a socket error like the certificate ones: ${raw && raw.message}`);
    assert.strictEqual(plugin.isTlsVerifyError(raw), false, raw.message);
    assertNoDowngrade(await deliver(port), 'TLS record error');
});

test('a refused connection is not downgraded', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const raw = await verifiedSendError(port);
    assert.ok(raw && raw.code === 'ESOCKET', `a socket error like the certificate ones: ${raw && raw.message}`);
    assert.strictEqual(plugin.isTlsVerifyError(raw), false);
    assertNoDowngrade(await deliver(port), 'ECONNREFUSED');
});

test('an SMTP reply quoting a verify reason is not downgraded and keeps its 5xx classification', async () => {
    const srv = await smtpWith(VALID_LEAF.key, VALID_LEAF.pem, {
        onRcptTo(_address: any, _session: any, cb: (err?: Error) => void) {
            const err: any = new Error('self-signed certificate');
            err.responseCode = 554;
            cb(err);
        },
    });
    const raw = await verifiedSendError(srv.port);
    assert.ok(raw && raw.responseCode === 554, raw && raw.message);
    assert.strictEqual(plugin.isTlsVerifyError(raw), false, raw.message);
    const run = await deliver(srv.port);
    assertNoDowngrade(run, '554 reply');
    assert.strictEqual(run.error.permanent, true, 'a 5xx reject is permanent');
    assert.strictEqual(srv.received.length, 0);
});

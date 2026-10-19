/**
 * DATABASE TLS UPGRADE NOTE — the boot error a site hits after upgrading leads to the fix.
 *
 * Database TLS is verified by default now. A managed database whose CA is not in Node's trust store
 * (Amazon RDS, DigitalOcean, Azure, …) makes the backend stop at boot. The message the driver logs must
 * name what to set and point at the upgrade note, and that note must exist where it says (a heading in
 * documentation/database.md, linked from the CHANGELOG).
 *
 * The first test runs the REAL Postgres driver against a server that answers the SSLRequest and then
 * presents a self-signed certificate, and reads the line the driver actually emitted (logger sink).
 *
 * MUTATION PROOF: drop the documentation pointer from DB_TLS_VERIFY_HINT, or the `log.error(hint)` call in
 * the driver's connect(), or rename the heading — the matching test fails.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const forge = require('node-forge');

const { DB_TLS_UPGRADE_DOC, DB_TLS_VERIFY_HINT } = require('../drivers/db-tls');

const REPO = path.join(__dirname, '..', '..', '..');

/** GitHub's heading anchor for a Markdown heading line. */
function slug(heading: string): string {
    return heading.trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/ /g, '-');
}

function selfSigned() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    const attrs = [{ name: 'commonName', value: 'managed-db.example.test' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

describe('database TLS upgrade note', () => {
    test('the real Postgres driver logs the hint, which points at the note, when the CA is unknown', async () => {
        const { key, cert } = selfSigned();
        // A "managed database": answers Postgres's SSLRequest with 'S', then speaks TLS with a
        // certificate no trust store knows.
        const server = net.createServer((sock: any) => {
            sock.once('data', () => {
                sock.write('S');
                const t = new tls.TLSSocket(sock, { isServer: true, key, cert });
                t.on('error', () => { /* the client hangs up on the certificate */ });
            });
            sock.on('error', () => {});
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        after(() => new Promise<void>((r) => server.close(() => r())));

        const lines: string[] = [];
        const removeSink = require('../core/logger').addLogSink((line: string) => lines.push(line));
        const pg = require('../drivers/postgres');
        try {
            await pg.init({ dbConfig: { host: '127.0.0.1', port: server.address().port, user: 'u', password: 'p', name: 'n', ssl: true } });
            await assert.rejects(pg.connect());
        } finally {
            removeSink();
            try { if (pg.pool) await pg.pool.end(); } catch { /* never connected */ }
        }
        const hint = lines.map((l) => { try { return JSON.parse(l).msg; } catch { return ''; } })
            .find((m: string) => typeof m === 'string' && m.includes('could not be verified'));
        assert.ok(hint, `the driver logged the TLS hint: ${lines.join('\n').slice(0, 2000)}`);
        assert.ok(hint.includes(DB_TLS_UPGRADE_DOC), 'the boot error points at the upgrade note');
        assert.match(hint, /dbSslCa/);
        assert.match(hint, /RDS/);
        assert.match(hint, /WORDJS_DB_SSL_CA/);
    });

    test('the note exists where the hint says, with the exact config, and the CHANGELOG links it', () => {
        assert.ok(DB_TLS_VERIFY_HINT.includes(DB_TLS_UPGRADE_DOC));
        const [file, anchor] = DB_TLS_UPGRADE_DOC.split('#');
        const doc = fs.readFileSync(path.join(REPO, file), 'utf8');
        const headings = doc.split(/\r?\n/).filter((l: string) => /^#{1,6} /.test(l)).map((l: string) => slug(l.replace(/^#+ /, '')));
        assert.ok(headings.includes(anchor), `a heading with anchor #${anchor} in ${file}`);
        const section = doc.slice(doc.indexOf('Upgrade note: database TLS'), doc.indexOf('**Example — SQLite'));
        for (const must of ['Amazon RDS', 'DigitalOcean', 'Azure', 'global-bundle.pem', '"dbSslCa"', 'WORDJS_DB_SSL_CA', 'dbSslRejectUnauthorized']) {
            assert.ok(section.includes(must), `the note covers ${must}`);
        }
        const changelog = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
        const unreleased = changelog.slice(changelog.indexOf('## [Unreleased]'), changelog.indexOf('\n## [', changelog.indexOf('## [Unreleased]') + 5));
        assert.match(unreleased, /Upgrade note/);
        assert.ok(unreleased.includes(`database.md#${anchor}`), 'the CHANGELOG links the note');
    });
});

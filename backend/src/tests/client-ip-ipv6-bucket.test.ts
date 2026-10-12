/**
 * A CLIENT WITH AN IPv6 /64 IS ONE CLIENT TO EVERY PER-CLIENT LIMIT.
 *
 * Every per-client control keyed on the full address: the plugin `clientKey` (an HMAC of the IP), the
 * per-(IP + account) login throttle, the API/auth/upload/forms limiters, the comment limiter, the sudo
 * in-flight slot. An IPv6 subscriber, VPS or cloud instance routinely holds a whole /64, so per /128 each
 * of those limits was a fresh bucket per request for anyone who rotated the low 64 bits. Now the key is
 * the address's rate-limit identity (core/client-ip ipBucket): IPv6 by /64, IPv4 per address, and an
 * IPv4-MAPPED address (how a dual-stack listener reports an IPv4 peer) per address in its IPv4 spelling —
 * grouping it by /64 would put every IPv4 client in one bucket.
 *
 * And the plugin clientKey is now keyed with the site's JWT secret as its comment always said: it read
 * `config.jwtSecret`, which the loaded config does not have, so every process used a random key and a
 * plugin's per-client counters reset on every restart and disagreed between nodes.
 *
 * MUTATION PROOF: key the login throttle on clientIp() again (routes/auth.ts) and the /64-rotation test
 * lets the 6th attempt through; make ipBucket return its input and the unit tests fail; read
 * `config.jwtSecret` in pluginClientKey and the restart test fails.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-ipv6-bucket-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const clientIpModule = require('../core/client-ip');

/** A request as core/client-ip sees it with no proxy trusted: the TCP peer is the address. */
const peer = (remoteAddress: string) => ({ ip: '198.51.100.250', socket: { remoteAddress } });

describe('ipBucket: the rate-limit identity of an address', () => {
    const { ipBucket } = clientIpModule;

    it('every address of one IPv6 /64 is one identity; another /64 is another', () => {
        const a = ipBucket('2001:db8:1:2::a');
        assert.strictEqual(a, '2001:db8:1:2::/64');
        for (const same of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:0db8:0001:0002:0:0:0:1', '2001:DB8:1:2::BEEF', '[2001:db8:1:2::7]', '2001:db8:1:2::9%eth0']) {
            assert.strictEqual(ipBucket(same), a, same);
        }
        assert.notStrictEqual(ipBucket('2001:db8:1:3::a'), a);
        assert.notStrictEqual(ipBucket('2001:db8:2:2::a'), a);
    });

    it('IPv4 stays per address, and an IPv4-mapped peer is the same identity as its IPv4 spelling', () => {
        assert.strictEqual(ipBucket('192.0.2.1'), '192.0.2.1');
        assert.strictEqual(ipBucket('::ffff:192.0.2.1'), '192.0.2.1');
        assert.strictEqual(ipBucket('::FFFF:c000:201'), '192.0.2.1');
        // Two IPv4 clients behind a dual-stack listener are NOT merged into one /64.
        assert.notStrictEqual(ipBucket('::ffff:192.0.2.1'), ipBucket('::ffff:192.0.2.2'));
    });

    it('a value that is not an address is returned unchanged (no bucket is invented)', () => {
        assert.strictEqual(ipBucket(''), '');
        assert.strictEqual(ipBucket(undefined), '');
        assert.strictEqual(ipBucket('not-an-ip'), 'not-an-ip');
    });
});

describe('pluginClientKey: one caller per /64, stable across restarts', () => {
    let savedEmbedded: any;
    before(() => { savedEmbedded = process.env.WORDJS_EMBEDDED; process.env.WORDJS_EMBEDDED = '1'; });
    after(() => { if (savedEmbedded === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = savedEmbedded; });

    it('two addresses of one /64 are one key; another /64 and another IPv4 are different keys', () => {
        const { pluginClientKey } = clientIpModule;
        const k = pluginClientKey(peer('2001:db8:aa:bb::1'));
        assert.match(k, /^[0-9a-f]{24}$/);
        assert.strictEqual(pluginClientKey(peer('2001:db8:aa:bb:1234:5678:9abc:def0')), k);
        assert.notStrictEqual(pluginClientKey(peer('2001:db8:aa:bc::1')), k);
        assert.strictEqual(pluginClientKey(peer('::ffff:203.0.113.5')), pluginClientKey(peer('203.0.113.5')));
        assert.notStrictEqual(pluginClientKey(peer('203.0.113.5')), pluginClientKey(peer('203.0.113.6')));
        assert.ok(!k.includes('2001') && !pluginClientKey(peer('203.0.113.5')).includes('203'), 'never the raw address');
    });

    it('the key survives a restart (it is keyed with the site secret, not a per-process random one)', () => {
        const { pluginClientKey } = clientIpModule;
        const before = pluginClientKey(peer('203.0.113.77'));
        delete (globalThis as any).__wjClientKeySecret; // what a new process starts without
        assert.strictEqual(pluginClientKey(peer('203.0.113.77')), before);
    });
});

describe('the login throttle counts an IPv6 /64 as one source', () => {
    let request: any, app: any;
    let savedTrust: any;

    before(async () => {
        request = require('supertest');
        savedTrust = config.trustProxy;
        config.trustProxy = true; // a fronting proxy is trusted: X-Forwarded-For is the client address
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        for (const login of ['v6-victim', 'v6-control']) {
            await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
                [login, 'not-a-real-hash', `${login}@example.com`, login]);
        }
        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        app.set('trust proxy', true);
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/v1', require('../routes'));
    });

    after(async () => {
        if (savedTrust === undefined) delete config.trustProxy; else config.trustProxy = savedTrust;
        try { await database.closeDatabase(); } catch { /* */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
    });

    const attempt = (username: string, from: string) => request(app).post('/api/v1/auth/login')
        .set('X-Forwarded-For', from).send({ username, password: 'wrong-pass' });

    it('a fresh address of the same /64 on every attempt still trips the per-(IP + account) throttle', async () => {
        for (let i = 1; i <= 5; i++) {
            const r = await attempt('v6-victim', `2001:db8:77:1::${i.toString(16)}`);
            assert.strictEqual(r.status, 401, `attempt ${i}: ${r.status}`);
        }
        const sixth = await attempt('v6-victim', '2001:db8:77:1:dead:beef:0:6');
        assert.strictEqual(sixth.status, 429, `the 6th attempt from the same /64 must be throttled, got ${sixth.status}`);
        assert.strictEqual(sixth.body.code, 'rest_login_throttled');
    });

    it('control: different /64s are different sources (the throttle is per source, not account-wide here)', async () => {
        for (let i = 1; i <= 6; i++) {
            const r = await attempt('v6-control', `2001:db8:${(0x100 + i).toString(16)}:1::1`);
            assert.strictEqual(r.status, 401, `attempt ${i} from its own /64: ${r.status}`);
        }
    });
});

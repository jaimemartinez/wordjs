/**
 * A plugin reaches the network only through the host's egress tunnel (core/egress-tunnel), on every OS.
 *
 * The child has no direct network at the kernel layer, so the host decides the exact destination and opens
 * the connection, and the worker carries the bytes over its IPC channel (core/egress-tunnel-client). These
 * tests pin, from INSIDE a real network-granted child, that plugin code keeps working unchanged:
 *   · http (a 2 MB body, eight times the backpressure window), global fetch, https, TLS upgraded over an
 *     existing socket (STARTTLS), and a bare `new net.Socket().connect()`;
 *   · and that the tunnel refuses what the egress guard refuses: cloud metadata, a private address and a
 *     loopback port nobody approved; UDP has no tunnel at all.
 * The decision rules themselves are checked without a network first.
 */
process.env.NODE_ENV = 'production';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-egress-tunnel-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const perms = require('../core/plugin-permissions');
const hooks = require('../core/hooks');
const iso = require('../core/plugin-isolate');
const tunnel = require('../core/egress-tunnel');
const x509 = require('../core/x509');
const pluginsRouter = require('../routes/plugins');

const SLUG = `wjs-tunnel-${process.pid}`;
const FILTER = `wjs_tunnel_probe_${String(SLUG).replace(/[^a-z0-9]/gi, '_')}`;
const servers: any[] = [];
const BIG = crypto.randomBytes(2 * 1024 * 1024);
const BIG_SHA = crypto.createHash('sha256').update(BIG).digest('hex');
let HTTP = 0, TLS = 0, ECHO = 0, CLOSED = 0;
let entry = '';

const PROBE_SOURCE = [
    "'use strict';",
    'exports.init = function (wordjs) {',
    `  wordjs.hooks.addFilter(${JSON.stringify(FILTER)}, async function (value) {`,
    '    try {',
    '    const { ports, only } = JSON.parse(value);',
    "    const net = require('net'); const http = require('http'); const https = require('https'); const tls = require('tls'); const crypto = require('crypto');",
    "    const verdict = (e) => (/blocked/i.test(String(e && e.message)) ? 'blocked' : 'error:' + String(e && (e.code || e.message)));",
    '    const out = {};',
    '    const httpGet = (mod, opts) => new Promise((resolve) => {',
    "      const req = mod.get(opts, (res) => { const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve(Buffer.concat(parts))); });",
    "      req.on('error', (e) => resolve(verdict(e)));",
    '    });',
    "    if (only === 'httpBig') { const big = await httpGet(http, { host: '127.0.0.1', port: ports.http, path: '/big' }); out.httpBig = Buffer.isBuffer(big) ? crypto.createHash('sha256').update(big).digest('hex') : big; }",
    "    if (only === 'fetch') { try { out.fetch = await (await fetch('http://127.0.0.1:' + ports.http + '/small')).text(); } catch (e) { out.fetch = verdict(e.cause || e); } }",
    "    if (only === 'https') { const sec = await httpGet(https, { host: '127.0.0.1', port: ports.tls, path: '/', rejectUnauthorized: false }); out.https = Buffer.isBuffer(sec) ? sec.toString() : sec; }",
    // STARTTLS shape: a plain connection first, then TLS over that same socket.
    "    if (only === 'starttls') out.starttls = await new Promise((resolve) => {",
    "      const trace = []; setTimeout(() => resolve('trace:' + trace.join(',')), 1500);",
    "      const plain = net.connect({ host: '127.0.0.1', port: ports.tls });",
    "      plain.once('error', (e) => resolve(verdict(e)));",
    "      plain.on('data', () => trace.push('plain-data'));",
    "      plain.once('connect', () => {",
    "        trace.push('plain-connect');",
    "        const t = tls.connect({ socket: plain, rejectUnauthorized: false, servername: 'localhost' }, () => { trace.push('secure'); t.write('GET / HTTP/1.0\\r\\n\\r\\n'); });",
    "        trace.push('tls-created');",
    "        let got = ''; t.on('data', (d) => { got += d; trace.push('tls-data'); }); t.on('end', () => resolve(/tunnel-tls/.test(got) ? 'ok' : 'got:' + got.slice(0, 80))); t.on('error', (e) => resolve(verdict(e)));",
    '      });',
    '    });',
    // A bare net.Socket, connected by hand.
    "    if (only === 'bare') out.bare = await new Promise((resolve) => {",
    '      const s = new net.Socket();',
    "      s.on('error', (e) => resolve(verdict(e)));",
    "      s.connect(ports.echo, '127.0.0.1', () => { out.bareRemote = s.remoteAddress; s.write('ping'); });",
    "      s.on('data', (d) => { resolve(String(d)); s.destroy(); });",
    '    });',
    '    const tryConnect = (host, port) => new Promise((resolve) => {',
    "      let s; const fin = (v) => { try { s && s.destroy(); } catch (e) { } resolve(v); };",
    '      try { s = net.connect({ host, port }); } catch (e) { return fin(verdict(e)); }',
    "      s.once('connect', () => fin('allowed')); s.once('error', (e) => fin(verdict(e))); setTimeout(() => fin('timeout'), 8000);",
    '    });',
    "    if (only === 'refusals') { out.metadata = await tryConnect('169.254.169.254', 80); out.privateLan = await tryConnect('10.1.2.3', 80); out.loopbackNotApproved = await tryConnect('127.0.0.1', ports.closed); }",
    "    if (only === 'udp') out.udp = await new Promise((resolve) => {",
    "      try { const u = require('dgram').createSocket('udp4'); u.on('error', (e) => resolve('refused:' + (e.code || e.message))); u.send(Buffer.from('x'), 53, '1.1.1.1', (e) => { try { u.close(); } catch (x) { } resolve(e ? 'refused:' + (e.code || e.message) : 'sent'); }); }",
    "      catch (e) { resolve('refused:' + String(e && (e.code || e.message))); }",
    '    });',
    '    return JSON.stringify(out);',
    "    } catch (e) { return JSON.stringify({ probeError: String(e && e.stack || e) }); }",
    '  });',
    '};',
    '',
].join('\n');

function listenOn(server: any): Promise<number> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server.address().port); }));
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    await require('../core/post-types').initPostTypes();
    HTTP = await listenOn(http.createServer((req: any, res: any) => {
        if (req.url === '/big') { res.writeHead(200, { 'Content-Length': BIG.length }); res.end(BIG); return; }
        res.end('tunnel-http');
    }));
    const keys = x509.generateRsaKeyPair(2048);
    const cert = x509.createCertificate({ subject: [['CN', 'localhost']], publicKey: keys.publicKey, signingKey: keys.privateKey, notAfter: new Date(Date.now() + 864e5), dnsNames: ['localhost'] });
    const key = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    TLS = await listenOn(https.createServer({ key, cert }, (req: any, res: any) => res.end('tunnel-tls')));
    ECHO = await listenOn(net.createServer((s: any) => s.on('data', (d: any) => s.write('echo:' + d))));
    // A port with nothing approved on it.
    CLOSED = await listenOn(net.createServer((s: any) => s.end()));
    const dir = pluginsRouter.resolveSafePluginDir(SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, version: '1.0.0', isolated: true, permissions: [{ scope: 'network' }] }));
    entry = path.join(dir, 'index.js');
    fs.writeFileSync(entry, PROBE_SOURCE);
    await perms.loadGrants();
    await perms.loadEgressHosts();
    await perms.setGrants(SLUG, ['network']);
    await perms.applyPrivateDestinations(SLUG, [`127.0.0.1:${HTTP}`, `127.0.0.1:${TLS}`, `127.0.0.1:${ECHO}`]);
}, { timeout: 60000 });

after(async () => {
    for (const s of iso.listIsolates()) { try { iso.unloadIsolatedPlugin(s); } catch { /* */ } }
    for (const srv of servers) { try { srv.close(); } catch { /* */ } }
    try { fs.rmSync(pluginsRouter.resolveSafePluginDir(SLUG), { recursive: true, force: true }); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

const POLICY = { network: true, loaded: true, allowedHosts: [], privateDestinations: [], ports: [53, 80, 443] };

test('the host decides: grant, policy, port, allowlist, and public-only unless an exact host:port is approved', () => {
    const j = (p: any, host: any, port: any) => tunnel.judgeDestination({ ...POLICY, ...p }, host, port);
    assert.match(j({ network: false }, '93.184.216.34', 80).refuse.message, /network grant/);
    assert.match(j({ loaded: false }, '93.184.216.34', 80).refuse.message, /not available/);
    assert.strictEqual(j({}, '93.184.216.34', 80).refuse, undefined, 'a public address on an allowed port');
    assert.match(j({}, '93.184.216.34', 25).refuse.message, /port 25/, 'a port the plugin did not declare');
    assert.match(j({ allowedHosts: ['example.org'] }, 'example.com', 443).refuse.message, /allowed hosts/);
    assert.strictEqual(j({ allowedHosts: ['example.org'] }, 'api.example.org', 443).refuse, undefined);
    for (const host of ['169.254.169.254', '10.1.2.3', '127.0.0.1', '[::1]', '192.168.0.1', '100.64.0.1', 'fd00::1']) {
        assert.match(j({}, host, 80).refuse.message, /blocked/, host);
    }
    // An approved host:port opens on that port only, even one the plugin did not declare.
    assert.strictEqual(j({ privateDestinations: ['127.0.0.1:2525'] }, '127.0.0.1', 2525).refuse, undefined);
    assert.match(j({ privateDestinations: ['127.0.0.1:2525'] }, '127.0.0.1', 2526).refuse.message, /port 2526/);
    assert.strictEqual(j({ privateDestinations: ['relay.lan:587'] }, 'relay.lan', 587).approved, true);
    // Never a path, a NUL trick or a non-ASCII spelling: the name judged is the name resolved.
    for (const bad of ['', 'a\u0000.example.com', 'exámple.com', '/var/run/docker.sock']) {
        assert.ok(j({}, bad, 443).refuse, JSON.stringify(bad));
    }
    assert.ok(tunnel.TUNNEL_LIMITS.maxStreams > 0 && tunnel.TUNNEL_LIMITS.window > 0 && tunnel.TUNNEL_LIMITS.idleTimeoutMs > 0);
});

test('inside a real network-granted child, plugin code reaches the network only through the tunnel', { timeout: 120000 }, async () => {
    await iso.loadIsolatedPlugin(SLUG, entry);
    const ports = { http: HTTP, tls: TLS, echo: ECHO, closed: CLOSED };
    // One case per call: the host gives a plugin filter about two seconds.
    const r: any = {};
    for (const only of ['httpBig', 'fetch', 'https', 'starttls', 'bare', 'refusals', 'udp']) {
        const one = JSON.parse(await hooks.applyFilters(FILTER, JSON.stringify({ ports, only })));
        assert.strictEqual(one.probeError, undefined, one.probeError);
        assert.ok(!('only' in one), `the ${only} case answered within the filter's time`);
        Object.assign(r, one);
    }
    assert.strictEqual(r.httpBig, BIG_SHA, '5 MB over http arrives intact through the backpressure window');
    assert.strictEqual(r.fetch, 'tunnel-http', 'global fetch');
    assert.strictEqual(r.https, 'tunnel-tls', 'https');
    assert.strictEqual(r.starttls, 'ok', 'TLS upgraded over an existing socket');
    assert.strictEqual(r.bare, 'echo:ping', 'a bare net.Socket connected by hand');
    assert.strictEqual(r.bareRemote, '127.0.0.1', 'and it reports the address the host connected to');
    assert.strictEqual(r.metadata, 'blocked', 'cloud metadata');
    assert.strictEqual(r.privateLan, 'blocked', 'a private address');
    assert.strictEqual(r.loopbackNotApproved, 'blocked', 'a loopback port nobody approved');
    assert.match(r.udp, /^refused:/, 'UDP has no tunnel');
});

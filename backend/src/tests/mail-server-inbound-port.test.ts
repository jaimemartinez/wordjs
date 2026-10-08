/**
 * mail-server: what the admin is told when inbound SMTP cannot bind port 25.
 *
 * WHY THIS FILE EXISTS: when the port-25 probe failed with EACCES, the plugin told the operator to run
 *     sudo setcap cap_net_bind_service=+ep $(readlink -f $(which node))
 * and that advice is withdrawn. A capability on node (setcap) or on the service (systemd's
 * AmbientCapabilities=) is exactly what the Linux plugin sandbox has to strip before it confines a plugin;
 * the ambient variant made the sandbox shim fail closed (SHIM-FAIL: setgroups(clear): EPERM) and refuse
 * every plugin on a production host. A file capability on node also widens every node script on the
 * machine. So the EACCES answer must name the real alternatives — the sysctl (with its cost) or a
 * firewall redirect to the 2525 fallback — and never a capability.
 *
 * And EPERM gets its own answer: under the Linux Landlock/seccomp floor an isolated plugin may not
 * bind/listen on ANY port (measured on Linux 7.0 under the shim with the network grant: EPERM on 25 and
 * on 2525 alike). "Could not bind port 25 (EPERM)" left the operator hunting for a port grant that cannot
 * exist; the reason has to say that no port setting changes it.
 *
 * HOW: the REAL plugin module is loaded and its REAL `init(bridge)` runs, exactly as in
 * mail-server-mailbox-gate.test.ts. Two I/O boundaries are doubled: `smtp-server` (it would bind a real
 * port) and `net`, whose server reports the errno under test from the plugin's own port-25 probe. The
 * reason is read back through the plugin's own admin route (GET /settings → inbound_reason), which is
 * what the admin UI renders.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { EventEmitter } from 'events';
import { makeDb } from './fixtures/mail-server-db';

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');
const SOURCE = fs.readFileSync(PLUGIN_SRC, 'utf8');
const ADMIN = { id: 1, role: 'administrator', userEmail: 'boss@acme.example', userLogin: 'boss', hasProfessionalMailbox: false };

/** `smtp-server` double: records the port it was asked for and "binds" it, so a fallback shows as bound. */
class FakeSMTPServer {
    static ports: number[] = [];
    constructor(public options: any) { }
    on() { return this; }
    listen(port: number, cb?: () => void) { FakeSMTPServer.ports.push(port); if (cb) setImmediate(cb); }
    close() { /* no-op */ }
}

/** `net` double whose servers fail every listen with `code` (or succeed when code is null). */
function fakeNet(code: string | null) {
    return {
        createServer() {
            const server: any = new EventEmitter();
            server.listen = () => {
                setImmediate(() => {
                    if (code) { const e: any = new Error(`listen ${code}`); e.code = code; server.emit('error', e); }
                    else server.emit('listening');
                });
                return server;
            };
            server.close = (cb?: () => void) => { if (cb) setImmediate(cb); return server; };
            return server;
        },
    };
}

async function bootWithProbe(code: string | null) {
    const moduleObj: any = { exports: {} };
    const requireShim = (spec: string) => {
        if (spec === 'smtp-server') return { SMTPServer: FakeSMTPServer };
        if (spec === 'net') return fakeNet(code);
        if (spec.startsWith('.')) return require(path.resolve(PLUGIN_DIR, spec));
        return require(spec);
    };
    vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${SOURCE}\n})`, { filename: PLUGIN_SRC })(
        moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    const plugin = moduleObj.exports;

    const options: Record<string, string> = { smtp_listen_port: '25' };
    const routes = new Map<string, (req: any, res: any) => any>();
    const bridge: any = {
        db: makeDb(),
        options: {
            async get(key: string, def: any) { return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : def; },
            async set(key: string, value: any) { options[key] = String(value); return true; },
        },
        site: { async url() { return 'https://acme.example'; }, async domain() { return 'acme.example'; }, async adminEmail() { return ADMIN.userEmail; } },
        users: { async findByEmail() { return null; }, async findByLogin() { return null; }, async findById() { return null; }, async search() { return []; } },
        http: { route(method: string, sub: string, _opts: any, handler: any) { routes.set(`${method} ${sub}`, handler); } },
        adminMenu: { add() { /* not under test */ } },
        provideMail() { /* not under test */ },
        notify: Object.assign(async () => { /* not under test */ }, { registerTransport() { } }),
        dns: {
            resolveMx: async () => { throw new Error('queryMx ENOTFOUND'); },
            resolveTxt: async () => { throw new Error('queryTxt ENOTFOUND'); },
            resolve4: async () => { throw new Error('queryA ENOTFOUND'); },
            resolve6: async () => { throw new Error('queryAaaa ENOTFOUND'); },
            resolve: async () => { throw new Error('query ENOTFOUND'); },
        },
    };
    FakeSMTPServer.ports = [];
    await plugin.init(bridge);
    await new Promise((r) => setImmediate(r)); // let the fake listen callback record the bound port

    const out: any = { status: 200, body: undefined };
    const res: any = {
        status(s: number) { out.status = s; return res; },
        set() { return res; }, cookie() { return res; }, clearCookie() { return res; },
        json(b: any) { out.body = b; return res; }, send(b: any) { out.body = b; return res; }, end() { return res; },
    };
    const handler = routes.get('get /settings');
    assert.ok(handler, 'the plugin no longer registers GET /settings; update this suite to the new route');
    await handler!({ query: {}, params: {}, body: {}, cookies: {}, user: ADMIN }, res);
    plugin.deactivate();
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    return { settings: out.body, listenedOn: FakeSMTPServer.ports };
}

const CAPABILITY_ADVICE = /setcap|cap_net_bind_service=|AmbientCapabilities=CAP|needs CAP_NET_BIND_SERVICE/i;

test('EACCES on port 25: the sysctl (with its cost) or a redirect to 2525 — never a capability', async () => {
    const { settings, listenedOn } = await bootWithProbe('EACCES');
    const reason = String(settings.inbound_reason);
    assert.strictEqual(settings.inbound_degraded, true);
    assert.deepStrictEqual(listenedOn, [2525], 'the unprivileged fallback is what comes up');
    assert.strictEqual(settings.inbound_bound_port, 2525);
    assert.ok(!/sudo setcap|cap_net_bind_service=\+ep|needs CAP_NET_BIND_SERVICE/i.test(reason), `capability advice is back: ${reason}`);
    assert.match(reason, /net\.ipv4\.ip_unprivileged_port_start=25/);
    assert.match(reason, /EVERY unprivileged process/, 'the sysctl is offered with its trade-off, not as a free fix');
    assert.match(reason, /REDIRECT 25 → 2525/);
    assert.match(reason, /Do not setcap the node binary/);
});

test('EPERM on port 25: the reason says the sandbox forbids listening, and that no port setting helps', async () => {
    const { settings } = await bootWithProbe('EPERM');
    const reason = String(settings.inbound_reason);
    assert.strictEqual(settings.inbound_degraded, true);
    assert.match(reason, /plugin sandbox/);
    assert.match(reason, /any port/);
    assert.match(reason, /no port, sysctl or capability setting changes it/);
    assert.ok(!CAPABILITY_ADVICE.test(reason), reason);
});

test('EADDRINUSE keeps its answer, and a bindable port 25 reports no reason at all', async () => {
    const busy = await bootWithProbe('EADDRINUSE');
    assert.strictEqual(busy.settings.inbound_reason, 'port 25 is already in use by another mail server — stop it, or map 25 → 2525');

    const free = await bootWithProbe(null);
    assert.deepStrictEqual(free.listenedOn, [25]);
    assert.strictEqual(free.settings.inbound_degraded, false);
    assert.strictEqual(free.settings.inbound_reason, null);
    assert.strictEqual(free.settings.inbound_ok, true);
});

test('the shipped plugin source no longer carries the setcap grant anywhere', () => {
    const hit = SOURCE.split('\n').find((l) => /setcap\s+cap_net_bind_service|cap_net_bind_service=\+ep/i.test(l));
    assert.ok(!hit, `still in marketplace/plugins/mail-server/index.js: ${hit && hit.trim()}`);
});

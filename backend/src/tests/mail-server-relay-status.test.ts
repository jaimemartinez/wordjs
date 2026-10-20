/**
 * mail-server: what happens when the configured relay is down, when the host refuses the listen port, and
 * when the mail domain is not a public one.
 *
 * RELAY. A configured relay (smarthost) is the only outbound path. When `transporter.verify()` failed, the
 * plugin used to drop the relay and deliver direct-to-MX without a word — on exactly the hosts that
 * configure a relay because outbound port 25 is blocked. Now the failure is kept and shown
 * ("Relay unavailable: <reason>") in GET /settings, the overview and the Test tab, the mail waits in the
 * retry queue, and direct-to-MX is never attempted. A relay given by NAME is resolved by the plugin
 * (dns.lookup) and nodemailer gets the address, with the name kept for TLS: nodemailer's own resolver is
 * denied inside the sandbox. Credentials are optional.
 *
 * LISTEN PORT. With smtp:inbound the host refuses a port it will not open; the plugin then listens on 25
 * and says which port was refused, instead of ending with no listener at all.
 *
 * MAIL DOMAIN. A site reached by `localhost` gives mailboxes @localhost; GET /settings says the domain is
 * not public so the console can warn.
 *
 * HOW: the REAL plugin module and its REAL init(bridge) run (as in mail-server-inbound-port.test.ts), with
 * nodemailer, smtp-server and dns doubled at the require boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import { makeDb } from './fixtures/mail-server-db';

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');
const SOURCE = fs.readFileSync(PLUGIN_SRC, 'utf8');
const ADMIN = { id: 1, role: 'administrator', userEmail: 'boss@acme.example', userLogin: 'boss', displayName: 'Boss', accountCapabilities: [] };
const SANDBOX_REFUSAL = '[sandbox] network egress to 192.168.182.56 is blocked — only public destinations are allowed for plugins';

class FakeSMTPServer {
    constructor(public options: any) { }
    on() { return this; }
    listen(_port: number, cb?: () => void) { if (cb) setImmediate(cb); return this; }
    close(cb?: () => void) { if (cb) setImmediate(cb); }
}

interface Boot {
    options?: Record<string, any>;
    verify?: (transportOptions: any) => Promise<any>;
    siteDomain?: string;
    smtpListen?: (handlers: any, opts: any) => Promise<any>;
}

async function boot(cfg: Boot) {
    const transports: any[] = [];
    const relaySends: any[] = [];
    const mxLookups: string[] = [];
    const nodemailer = {
        createTransport(opts: any) {
            transports.push(opts);
            return {
                verify: cfg.verify ? () => cfg.verify!(opts) : (async () => true),
                async sendMail(m: any) { relaySends.push(m); return { response: '250 2.0.0 Ok: queued' }; },
            };
        },
    };
    const dnsDouble = { promises: { async lookup(name: string) { return name === 'relay.lan' ? { address: '192.168.182.56', family: 4 } : { address: '203.0.113.9', family: 4 }; } } };
    const moduleObj: any = { exports: {} };
    const requireShim = (spec: string) => {
        if (spec === 'smtp-server') return { SMTPServer: FakeSMTPServer };
        if (spec === 'nodemailer') return nodemailer;
        if (spec === 'dns') return dnsDouble;
        if (spec.startsWith('.')) return require(path.resolve(PLUGIN_DIR, spec));
        return require(spec);
    };
    vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${SOURCE}\n})`, { filename: PLUGIN_SRC })(
        moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    const plugin = moduleObj.exports;

    const options: Record<string, any> = { smtp_listen_port: '25', mail_undo_send_seconds: '0', ...(cfg.options || {}) };
    const routes = new Map<string, (req: any, res: any) => any>();
    const domain = cfg.siteDomain || 'acme.example';
    const dnsBridge = (label: string) => async (name: string) => { mxLookups.push(`${label} ${name}`); throw new Error(`query ${label} ENOTFOUND`); };
    const bridge: any = {
        db: makeDb(),
        options: {
            async get(key: string, def: any) { return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : def; },
            async set(key: string, value: any) { options[key] = String(value); return true; },
        },
        site: { async url() { return `https://${domain}`; }, async domain() { return domain; }, async adminEmail() { return ADMIN.userEmail; } },
        users: {
            async findByEmail(e: string) { return e === ADMIN.userEmail ? ADMIN : null; },
            async findByLogin() { return null; },
            async findById(id: number) { return id === ADMIN.id ? ADMIN : null; },
            async search() { return []; },
        },
        http: { route(method: string, sub: string, _opts: any, handler: any) { routes.set(`${method} ${sub}`, handler); } },
        adminMenu: { add() { /* not under test */ } },
        provideMail() { /* not under test */ },
        notify: Object.assign(async () => { /* not under test */ }, { registerTransport() { } }),
        dns: { resolveMx: dnsBridge('MX'), resolveTxt: dnsBridge('TXT'), resolve4: dnsBridge('A'), resolve6: dnsBridge('AAAA'), resolve: dnsBridge('ANY') },
        ...(cfg.smtpListen ? { smtp: { listen: cfg.smtpListen } } : {}),
    };
    await plugin.init(bridge);
    await new Promise((r) => setImmediate(r));

    const call = async (method: string, sub: string, body: any = {}) => {
        const out: any = { status: 200, body: undefined };
        const res: any = {
            status(s: number) { out.status = s; return res; },
            set() { return res; }, cookie() { return res; }, clearCookie() { return res; },
            json(b: any) { out.body = b; return res; }, send(b: any) { out.body = b; return res; }, end() { return res; },
        };
        const handler = routes.get(`${method} ${sub}`);
        assert.ok(handler, `the plugin no longer registers ${method.toUpperCase()} ${sub}; update this suite`);
        await handler!({ query: {}, params: {}, body, cookies: {}, user: ADMIN, headers: {} }, res);
        return out;
    };
    return { plugin, call, transports, relaySends, mxLookups, options };
}

test('a relay the sandbox refuses is reported as unavailable, and mail is queued — never sent direct-to-MX', async () => {
    const b = await boot({
        options: { mail_server: '192.168.182.56', mail_port: '1025', mail_relay_require_tls: '0' },
        verify: async () => { throw new Error(SANDBOX_REFUSAL); },
    });
    try {
        const settings = (await b.call('get', '/settings')).body;
        assert.strictEqual(settings.relay_status.configured, true);
        assert.strictEqual(settings.relay_status.ok, false);
        assert.strictEqual(settings.relay_status.sandboxBlocked, true);
        assert.match(settings.relay_status.error, /sandbox blocks private addresses .* approve 192\.168\.182\.56:1025/);
        assert.strictEqual(b.options.mail_delivery_ready, '0', 'password recovery stays off while the relay cannot deliver');

        const lookupsBefore = b.mxLookups.length;
        const r = await b.call('post', '/test', { to: 'someone@example.org' });
        assert.strictEqual(r.body.success, false, JSON.stringify(r.body));
        assert.strictEqual(r.body.failed.length, 1);
        assert.match(r.body.failed[0].error, /^Relay unavailable: /);
        assert.strictEqual(r.body.failed[0].permanent, false, 'the message waits in the retry queue');
        assert.match(r.body.message, /^Relay unavailable: .*not sent direct-to-MX/);
        assert.deepStrictEqual(b.mxLookups.slice(lookupsBefore).filter((l) => l.startsWith('MX')), [], 'no direct-to-MX attempt');
        assert.strictEqual(b.relaySends.length, 0);

        const overview = (await b.call('get', '/admin/overview')).body;
        assert.strictEqual(overview.relay, true);
        assert.strictEqual(overview.relayStatus.ok, false);
    } finally { b.plugin.deactivate(); }
});

test('a relay given by name is resolved by the plugin; nodemailer gets the address, the name for TLS, and no auth without credentials', async () => {
    const b = await boot({ options: { mail_server: 'relay.lan', mail_port: '587' } });
    try {
        const t = b.transports[b.transports.length - 1];
        assert.strictEqual(t.host, '192.168.182.56');
        assert.strictEqual(t.servername, 'relay.lan');
        assert.strictEqual(t.tls.servername, 'relay.lan');
        assert.strictEqual(t.auth, undefined, 'credentials are optional');
        assert.strictEqual(t.requireTLS, true, 'STARTTLS stays required by default');
        const settings = (await b.call('get', '/settings')).body;
        assert.strictEqual(settings.relay_status.ok, true);
        // A relay that answers makes mail deliverable — the flag password recovery is gated on — without
        // the MX/SPF/DKIM/DMARC check, which a relay-only site never passes.
        assert.strictEqual(b.options.mail_delivery_ready, '1');
        await b.call('get', '/security/dns-check');
        assert.strictEqual(b.options.mail_delivery_ready, '1', 'the DNS check does not override a working relay');
        await b.call('post', '/settings', { mail_server: '' });
        assert.strictEqual(b.options.mail_delivery_ready, '0', 'removing the relay hands readiness back to the DNS check');
        await b.call('post', '/settings', { mail_server: 'relay.lan' });
        const r = await b.call('post', '/test', { to: 'someone@example.org' });
        assert.strictEqual(r.body.success, true, JSON.stringify(r.body));
        assert.strictEqual(r.body.delivered[0].via, 'relay');
        assert.strictEqual(b.relaySends.length, 1);
    } finally { b.plugin.deactivate(); }
});

test('an smtp_listen_port the host refuses falls back to 25 and says which port was refused', async () => {
    const asked: number[] = [];
    const b = await boot({
        options: { smtp_listen_port: '587' },
        smtpListen: async (_h: any, opts: any) => {
            asked.push(opts.port);
            if (opts.port !== 25) return { granted: true, ok: false, error: `port ${opts.port} is not declared in the plugin's manifest claimPorts (undeclared ports must be 1024 or higher)`, boundPort: null };
            return { granted: true, ok: true, requestedPort: 25, boundPort: 25, degraded: false, reason: null, proxyIps: [] };
        },
    });
    try {
        assert.deepStrictEqual(asked, [587, 25]);
        const settings = (await b.call('get', '/settings')).body;
        assert.strictEqual(settings.inbound_mode, 'host');
        assert.strictEqual(settings.inbound_bound_port, 25);
        assert.match(settings.inbound_reason, /smtp_listen_port 587 could not be used \(port 587 is not declared.*\); listening on 25 instead/);
    } finally { b.plugin.deactivate(); }
});

test('a localhost site gives a non-public mail domain, and GET /settings says so', async () => {
    const local = await boot({ siteDomain: 'localhost' });
    try {
        const s = (await local.call('get', '/settings')).body;
        assert.strictEqual(s.mail_domain, 'localhost');
        assert.strictEqual(s.mail_domain_public, false);
        assert.strictEqual(s.relay_status.configured, false);
    } finally { local.plugin.deactivate(); }
    const real = await boot({ siteDomain: 'acme.org' });
    try {
        const s = (await real.call('get', '/settings')).body;
        assert.strictEqual(s.mail_domain, 'acme.org');
        assert.strictEqual(s.mail_domain_public, true);
    } finally { real.plugin.deactivate(); }
});

test('a setting saved as 0 is read as off: Require STARTTLS = No is honoured even when the host returns the number 0', async () => {
    const b = await boot({ options: { mail_server: '192.168.182.56', mail_port: 1025, mail_relay_require_tls: 0 } });
    try {
        const t = b.transports[b.transports.length - 1];
        assert.strictEqual(t.requireTLS, false);
        assert.strictEqual(t.port, 1025);
        const settings = (await b.call('get', '/settings')).body;
        assert.strictEqual(settings.mail_relay_require_tls, '0', 'the console shows No, not the default Yes');
    } finally { b.plugin.deactivate(); }
});

test('with Require STARTTLS off, a relay that refuses STARTTLS with an SMTP reply is used without TLS; with it on, it is reported', async () => {
    const REFUSED = 'Error upgrading connection with STARTTLS: 502 5.5.1 Command not implemented';
    const verify = async (opts: any) => { if (!opts.ignoreTLS) throw new Error(REFUSED); return true; };
    const off = await boot({ options: { mail_server: '192.168.182.56', mail_port: '1025', mail_relay_require_tls: '0' }, verify });
    try {
        const last = off.transports[off.transports.length - 1];
        assert.strictEqual(last.ignoreTLS, true);
        assert.strictEqual((await off.call('get', '/settings')).body.relay_status.ok, true);
    } finally { off.plugin.deactivate(); }
    const on = await boot({ options: { mail_server: '192.168.182.56', mail_port: '587' }, verify });
    try {
        assert.ok(on.transports.every((t: any) => !t.ignoreTLS), 'never downgraded while STARTTLS is required');
        const st = (await on.call('get', '/settings')).body.relay_status;
        assert.strictEqual(st.ok, false);
        assert.match(st.error, /502 5\.5\.1/);
    } finally { on.plugin.deactivate(); }
});

/**
 * mail-server ACTIVE CORPORATE MAILBOX gate suite.
 *
 * WHY THIS FILE EXISTS: every user-facing mail route used to be declared with `{ auth: true }` and
 * nothing else, so ANY authenticated account — including a subscriber with no inbox on this server at
 * all — could POST /send and push mail through the site MTA, signed with the SITE's DKIM key, spending
 * the site domain's sending reputation.
 *
 * The first fix gated the surface on "the account's own email is on the site domain". That predicate
 * was SELF-GRANTABLE (PUT /users/me and POST /auth/register both write that field), so the gate now
 * reads the ADMIN-OWNED grant the host projects as `user.hasProfessionalMailbox`
 * (backend/src/core/mailbox.ts; the host half is pinned by mailbox-grant.test.ts). This suite pins the
 * plugin half: the gate reads the GRANT and never the address, delivery needs BOTH, the mail domain
 * has one definition, and no route can reach the bridge unclassified.
 *
 * HOW IT AVOIDS THE "green suite over broken code" trap: it does NOT reimplement the rule and it
 * does not call a stub. It LOADS THE REAL PLUGIN MODULE (marketplace/plugins/mail-server/index.js)
 * in a module wrapper, runs the REAL `exports.init(bridge)` — which performs the REAL route
 * registration through the plugin's own `route()` helper, where the gate lives — captures the
 * handlers the plugin registered, and invokes those. The store is the REAL email-store over an
 * in-memory SQLite database (shared fixture, so the host's SQL text-guard tripwire applies here
 * too). A behaviour change in the plugin is visible here immediately.
 *
 * Exactly ONE thing is doubled, and only because it is the plugin's I/O boundary: `smtp-server`,
 * whose SMTPServer binds a real TCP port. The double also KEEPS the handler options the plugin
 * passes it, which is what lets the inbound test below drive the real onData delivery path. The
 * listener port is set to 2525 in the options fixture so the plugin's port-25 bindability probe
 * (real `net`) never runs. Everything else — nodemailer, mailparser, bayes, the email store — is
 * the real module; no outbound socket is opened because no test exercises external delivery (the
 * undo-send window keeps a send in the outbox, exactly as in production).
 *
 * `res` mirrors the shim the isolate worker gives a plugin route handler
 * (backend/src/core/plugin-worker.js), and `req.user` mirrors the projection the host forwards
 * ({ id, role, userEmail, userLogin, hasProfessionalMailbox } — no capability map, which is why the
 * admin allowance below keys off `role`, exactly like the plugin's existing canAccessEmail override).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { Readable } from 'stream';
import { makeDb, PREFIX } from './fixtures/mail-server-db';

const PLUGIN_DIR = path.resolve(__dirname, '../../../marketplace/plugins/mail-server');
const PLUGIN_SRC = path.join(PLUGIN_DIR, 'index.js');
const SOURCE = fs.readFileSync(PLUGIN_SRC, 'utf8');

const SITE_DOMAIN = 'acme.example';

// --- The one doubled I/O boundary: smtp-server (binds a real port) -------------------------------
const smtpInstances: any[] = [];
class FakeSMTPServer {
    options: any;
    constructor(options: any) { this.options = options; smtpInstances.push(this); }
    on() { return this; }
    listen(_port: number, _cb?: () => void) { /* never binds; the callback only logs */ }
    close() { /* no-op */ }
}

/**
 * Load a FRESH instance of the real plugin module. Fresh per boot because the plugin keeps
 * module-scoped state (the bridge, the store, the queue timer), so two boots sharing one instance
 * would clobber each other.
 */
function loadPluginModule(): any {
    const moduleObj: any = { exports: {} };
    const requireShim = (spec: string) => {
        if (spec === 'smtp-server') return { SMTPServer: FakeSMTPServer };
        if (spec.startsWith('.')) return require(path.resolve(PLUGIN_DIR, spec));
        return require(spec); // nodemailer / mailparser / bayes / node builtins — the real modules
    };
    const wrapper: any = vm.runInThisContext(
        `(function (exports, require, module, __filename, __dirname) {${SOURCE}\n})`,
        { filename: PLUGIN_SRC }
    );
    wrapper(moduleObj.exports, requireShim, moduleObj, PLUGIN_SRC, PLUGIN_DIR);
    return moduleObj.exports;
}

// --- Users, in the exact projection shape the host forwards to an isolated plugin route ----------
// `hasProfessionalMailbox` IS the grant (user_meta.professional_mailbox, writable only by an
// `edit_users` caller — see backend/src/core/mailbox.ts). Note MALLORY: an on-domain address WITHOUT
// the grant, i.e. exactly what a subscriber could give themselves through PUT /users/me before the
// host closed that door. She must be refused everywhere.
const ALICE = { id: 2, role: 'editor', userEmail: `alice@${SITE_DOMAIN}`, userLogin: 'alice', hasProfessionalMailbox: true };
const PABLO = { id: 3, role: 'subscriber', userEmail: 'pablo@gmail.com', userLogin: 'pablo', hasProfessionalMailbox: false };
const MALLORY = { id: 4, role: 'subscriber', userEmail: `ceo@${SITE_DOMAIN}`, userLogin: 'mallory', hasProfessionalMailbox: false };
const BOSS = { id: 1, role: 'administrator', userEmail: 'boss@gmail.com', userLogin: 'boss', hasProfessionalMailbox: false };
const DIRECTORY = [BOSS, ALICE, PABLO, MALLORY];

type RouteHandler = (req: any, res: any) => any;

type Boot = {
    plugin: any;
    routes: Map<string, RouteHandler>;
    registered: { method: string; sub: string; opts: any }[];
    db: any;
    Email: any;
    smtp: any;
};

type BootOpts = {
    options?: Record<string, string>;
    /**
     * Option keys the HOST refuses to serve an untrusted plugin (anything matching its
     * PROTECTED_OPTION_RE — 'dkim', 'key', 'password', …). The plugin keeps those in its OWN
     * wjp_mail_server_secrets table and routes getOption/updateOption there transparently, so a fixture
     * that put `mail_security_dkim_domain` in `options` would be silently ignored. Seeded as plaintext,
     * which getSecret reads transparently (legacy rows predate encryption-at-rest).
     */
    secrets?: Record<string, string>;
    users?: any[];
    /** The SITE hostname, which is NOT necessarily the mail domain — see the `www.` test. */
    siteDomain?: string;
};

async function boot({ options: extraOptions = {}, secrets = {}, users = DIRECTORY, siteDomain = SITE_DOMAIN }: BootOpts = {}): Promise<Boot> {
    const db = makeDb();
    // Before init, so the plugin's boot-time reads (the SMTP listener's mail domain) see them.
    for (const [name, value] of Object.entries(secrets)) {
        await db.createTable(`${PREFIX}secrets`, ['name TEXT', 'value TEXT', 'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP']);
        await db.run(`INSERT INTO ${PREFIX}secrets (name, value) VALUES (?, ?)`, [name, value]);
    }
    const routes = new Map<string, RouteHandler>();
    const registered: { method: string; sub: string; opts: any }[] = [];
    // 2525 keeps the plugin's real port-25 bindability probe (which uses `net`) from ever running.
    const options: Record<string, string> = { smtp_listen_port: '2525', ...extraOptions };
    const find = (pred: (u: any) => boolean) => users.find(pred) || null;

    const bridge: any = {
        db,
        options: {
            async get(key: string, def: any) {
                return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : def;
            },
            async set(key: string, value: any) { options[key] = String(value); return true; }
        },
        site: {
            async url() { return `https://${siteDomain}`; },
            async domain() { return siteDomain; },
            async adminEmail() { return BOSS.userEmail; }
        },
        users: {
            async findByEmail(email: string) {
                return find(u => u.userEmail.toLowerCase() === String(email || '').toLowerCase());
            },
            async findByLogin(login: string) {
                return find(u => u.userLogin.toLowerCase() === String(login || '').toLowerCase());
            },
            async findById(id: number) { return find(u => u.id === Number(id)); },
            async search(q: string, limit: number) {
                const needle = String(q || '').toLowerCase();
                return users.filter(u => u.userLogin.includes(needle) || u.userEmail.includes(needle)).slice(0, limit || 50);
            }
        },
        http: {
            route(method: string, sub: string, opts: any, handler: RouteHandler) {
                registered.push({ method, sub, opts });
                routes.set(`${method} ${sub}`, handler);
            }
        },
        adminMenu: { add() { /* captured elsewhere */ } },
        provideMail() { /* host-wide mail provider registration */ },
        notify: Object.assign(async () => { /* db/sse notification */ }, { registerTransport() { } }),
        dns: {
            resolveMx: async () => { throw new Error('queryMx ENOTFOUND'); },
            resolveTxt: async () => { throw new Error('queryTxt ENOTFOUND'); },
            resolve4: async () => { throw new Error('queryA ENOTFOUND'); },
            resolve6: async () => { throw new Error('queryAaaa ENOTFOUND'); },
            resolve: async () => { throw new Error('query ENOTFOUND'); }
        }
    };

    const plugin = loadPluginModule();
    smtpInstances.length = 0;
    await plugin.init(bridge);

    const createEmailStore = require(path.join(PLUGIN_DIR, 'lib/email-store.js'));
    return { plugin, routes, registered, db, Email: createEmailStore(db), smtp: smtpInstances[0] };
}

// --- The route-handler calling convention of backend/src/core/plugin-worker.js -------------------
function makeRes() {
    const out: { status: number; body: any; settled: boolean } = { status: 200, body: undefined, settled: false };
    const res: any = {
        status(s: number) { out.status = s; return res; },
        set() { return res; },
        cookie() { return res; },
        clearCookie() { return res; },
        json(b: any) { out.body = b; out.settled = true; return res; },
        send(b: any) { out.body = b; out.settled = true; return res; },
        end() { out.settled = true; return res; }
    };
    return { res, out };
}

async function call(b: Boot, key: string, user: any, req: any = {}) {
    const handler = b.routes.get(key);
    assert.ok(
        handler,
        `route '${key}' is not registered by the plugin. This suite drives the REAL registrations — ` +
        'if a route was renamed, update the list here so its gate stays covered.'
    );
    const { res, out } = makeRes();
    await handler!({ query: {}, params: {}, body: {}, cookies: {}, ...req, user }, res);
    return out;
}

/**
 * The whole user-facing mail surface. Every one of these must refuse an account without an active
 * corporate mailbox — that is the security boundary, and listing them explicitly is what makes a
 * newly added ungated route visible in CI.
 */
const GATED_ROUTES: [string, any][] = [
    ['post /send', { body: { to: 'someone@example.org', subject: 'hi', body: 'text' } }],
    ['post /drafts', { body: { to: 'someone@example.org', subject: 'hi', body: 'text' } }],
    ['get /emails', { query: { folder: 'inbox' } }],
    ['get /emails/search', { query: { q: 'invoice' } }],
    ['get /emails/:id', { params: { id: '1' } }],
    ['delete /emails/:id', { params: { id: '1' } }],
    ['put /emails/:id/read', { params: { id: '1' } }],
    ['put /emails/:id/star', { params: { id: '1' } }],
    ['put /emails/:id/archive', { params: { id: '1' } }],
    ['put /emails/:id/spam', { params: { id: '1' } }],
    ['put /emails/:id/restore', { params: { id: '1' } }],
    ['put /emails/:id/labels', { params: { id: '1' }, body: { add: [], remove: [] } }],
    ['post /emails/:id/unsend', { params: { id: '1' } }],
    ['post /emails/:id/retry', { params: { id: '1' } }],
    ['post /emails/bulk', { body: { ids: [1], action: 'read' } }],
    ['delete /trash/empty', {}],
    ['get /stats', {}],
    ['post /classification/train', { body: { text: 'x', category: 'spam' } }],
    ['get /users/search', { query: { q: 'ali' } }],
    ['get /contacts/suggest', { query: { q: 'ali' } }],
    ['get /labels', {}],
    ['post /labels', { body: { name: 'Work' } }],
    ['put /labels/:id', { params: { id: '1' }, body: { name: 'Work' } }],
    ['delete /labels/:id', { params: { id: '1' } }],
    ['get /prefs', {}],
    ['put /prefs', { body: { signature: 'x' } }],
    ['post /upload/attachment', { file: { path: '/tmp/x', originalname: 'x.txt', mimetype: 'text/plain', size: 1 } }],
    ['get /attachments/:fileId', { params: { fileId: 'abc' } }],
];

// Admin CONFIGURATION routes. These are NOT mailbox use and must never be mailbox-gated: at first
// install NOBODY has a mailbox yet, so gating them would make the mail server unconfigurable
// (chicken-and-egg). The host enforces `admin: true` on them.
const ADMIN_CONFIG_ROUTES = [
    'get /settings', 'post /settings', 'post /test',
    'get /security/dns-records', 'get /security/dns-check', 'post /security/dkim/generate'
];

// Routes that are neither mailbox use nor configuration. Each entry must carry the REASON.
const UNGATED_BY_DESIGN = new Map([
    // The probe that TELLS a user they have no mailbox; gating it would 403 the answer.
    ['get /mailbox', 'the mailbox probe the client shell asks before rendering'],
]);

/**
 * Locate a route's SHIPPED declaration.
 *
 * The `mailbox` flag is a PLUGIN-LOCAL route option — the plugin's route() helper consumes it and
 * never forwards it to the host — so the shipped source is the only place it is observable. Both quote
 * styles are matched, and the OPTION-LESS 3-argument form `route(m, p, handler)` is matched too (it
 * yields `opts === null`, which the helper turns into the fail-closed `{auth, mailbox}` default).
 *
 * The previous version of this regex accepted single quotes AND required a literal options object, so
 * BOTH of those spellings were invisible to it — a route added either way could ship completely
 * ungated with this suite green. The set-equality tripwire below is now the primary defence (it works
 * off what actually crossed the bridge, so it is immune to spelling entirely); this scan only reads
 * the plugin-local flag.
 */
const ROUTE_DECL_RE = /route\(\s*(['"])(get|post|put|delete|patch)\1\s*,\s*(['"])([^'"]+)\3\s*,\s*(\{[^}]*\})?/g;
function declaredRoutes(): Map<string, string | null> {
    const out = new Map<string, string | null>();
    ROUTE_DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROUTE_DECL_RE.exec(SOURCE)) !== null) out.set(`${m[2]} ${m[4]}`, m[5] === undefined ? null : m[5]);
    return out;
}
function declarationOf(key: string): string | null {
    const all = declaredRoutes();
    if (!all.has(key)) assert.fail(`route '${key}' is not declared in ${PLUGIN_SRC}`);
    return all.get(key)!;
}
const declaresMailbox = (opts: string | null) => opts === null || /mailbox\s*:\s*true/.test(opts);

// ================================================================================================

test('a user WITHOUT a corporate mailbox is refused by POST /send', async () => {
    const b = await boot();
    try {
        const out = await call(b, 'post /send', PABLO, {
            body: { to: 'victim@example.org', subject: 'Cheap pills', body: 'spam' }
        });
        assert.equal(out.status, 403, 'a personal-email account must not be able to send through the site MTA');
        assert.equal(out.body.code, 'mail_no_corporate_mailbox');
        assert.match(String(out.body.error), /administrator/i, 'the message must tell the user what to ask for');
        // Nothing may reach the outbox/queue either — a queued row IS a send.
        const rows = await b.db.all(`SELECT id FROM ${PREFIX}received_emails`, []);
        assert.equal(rows.length, 0, 'the refused send must not leave a queued outbox row');
    } finally { b.plugin.deactivate(); }
});

test('a user WITHOUT a corporate mailbox is refused by EVERY user-facing mail route', async () => {
    const b = await boot();
    try {
        for (const [key, req] of GATED_ROUTES) {
            const out = await call(b, key, PABLO, req);
            assert.equal(out.status, 403, `${key} must refuse an account with no corporate mailbox (got ${out.status})`);
            assert.equal(out.body && out.body.code, 'mail_no_corporate_mailbox', `${key} must refuse with the mailbox gate, not an incidental 403`);
        }
    } finally { b.plugin.deactivate(); }
});

test('THE SELF-GRANT: an on-domain address WITHOUT the admin grant is refused everywhere', async () => {
    // This is the hole the gate was proven not to close. Under the old rule ("your own account email is
    // on the site domain") MALLORY — a subscriber who set her address to ceo@<domain> through PUT
    // /users/me, a route guarded by `authenticate` alone — passed the gate and could send DKIM-signed
    // mail as the site. The gate now reads the ADMIN-OWNED grant, so the address buys her nothing.
    const b = await boot();
    try {
        for (const [key, req] of GATED_ROUTES) {
            const out = await call(b, key, MALLORY, req);
            assert.equal(out.status, 403, `${key} must refuse a self-assigned on-domain address (got ${out.status})`);
            assert.equal(out.body && out.body.code, 'mail_no_corporate_mailbox');
        }
        const probe = await call(b, 'get /mailbox', MALLORY);
        assert.deepEqual(
            { hasMailbox: probe.body.hasMailbox, canUseMail: probe.body.canUseMail, address: probe.body.address },
            { hasMailbox: false, canUseMail: false, address: null },
            'the probe must agree with the gate: the address alone is not a mailbox'
        );
    } finally { b.plugin.deactivate(); }
});

test('a user WITH a corporate mailbox reaches the handlers (read + send)', async () => {
    const b = await boot();
    try {
        await b.Email.create({
            messageId: '<inbound-1@example.org>', fromAddress: 'ext@example.org', fromName: 'Ext',
            toAddress: ALICE.userEmail, subject: 'Invoice 42', bodyText: 'body', bodyHtml: '<p>body</p>',
            rawContent: 'body', userId: ALICE.id
        });

        const list = await call(b, 'get /emails', ALICE, { query: { folder: 'inbox' } });
        assert.equal(list.status, 200);
        assert.equal(list.body.emails.length, 1, 'her own inbox message is listed');
        assert.equal(list.body.emails[0].subject, 'Invoice 42');

        const sent = await call(b, 'post /send', ALICE, {
            body: { to: 'client@example.org', subject: 'Re: Invoice 42', body: 'Attached.' }
        });
        assert.equal(sent.status, 200);
        assert.equal(sent.body.success, true);
        assert.ok(sent.body.id, 'the message was accepted into the outbox (undo-send window)');

        const probe = await call(b, 'get /mailbox', ALICE);
        assert.deepEqual(
            { hasMailbox: probe.body.hasMailbox, canUseMail: probe.body.canUseMail, address: probe.body.address },
            { hasMailbox: true, canUseMail: true, address: ALICE.userEmail }
        );
    } finally { b.plugin.deactivate(); }
});

test('an ADMINISTRATOR without a mailbox of their own keeps the surface (they own the catch-all inbox)', async () => {
    // Decision for the catch-all edge case: inbound mail with no matching mailbox is stored OWNED BY
    // THE SITE ADMIN, and the admin's own address may well be personal — a naive gate would lock them
    // out of mail they own. Administrators therefore pass, exactly like the host's admin-menu filter
    // (backend/src/routes/plugins.ts keeps requiresProfessionalMailbox items visible to admins) and
    // exactly like the plugin's existing canAccessEmail role override.
    const b = await boot();
    try {
        await b.Email.create({
            messageId: '<catchall-1@example.org>', fromAddress: 'ext@example.org', fromName: 'Ext',
            toAddress: `sales@${SITE_DOMAIN}`, subject: 'Catch-all enquiry', bodyText: 'body',
            bodyHtml: '<p>body</p>', rawContent: 'body', userId: BOSS.id
        });

        const list = await call(b, 'get /emails', BOSS, { query: { folder: 'inbox' } });
        assert.equal(list.status, 200, 'the admin must still reach the mail they own');
        assert.equal(list.body.emails[0].subject, 'Catch-all enquiry');

        const sent = await call(b, 'post /send', BOSS, {
            body: { to: 'client@example.org', subject: 'Re: enquiry', body: 'Hello.' }
        });
        assert.equal(sent.status, 200, 'the admin may reply to catch-all mail');

        const probe = await call(b, 'get /mailbox', BOSS);
        assert.deepEqual(
            { hasMailbox: probe.body.hasMailbox, canUseMail: probe.body.canUseMail, isAdmin: probe.body.isAdmin },
            { hasMailbox: false, canUseMail: true, isAdmin: true },
            'the probe must report NO mailbox but full access — the UI shows the app, not the empty-state'
        );
    } finally { b.plugin.deactivate(); }
});

test('admin CONFIG routes still work with no mailbox anywhere on the site (first-install chicken-and-egg)', async () => {
    // A fresh install has zero corporate mailboxes — not even the admin's. Configuring the mail server
    // is what CREATES the first one, so the configuration surface must not require one.
    const b = await boot({ users: [BOSS] });
    try {
        const settings = await call(b, 'get /settings', BOSS);
        assert.equal(settings.status, 200, 'an admin with a personal address must be able to read mail settings');
        assert.equal(settings.body.smtp_listen_port, '2525');

        const dns = await call(b, 'get /security/dns-records', BOSS);
        assert.equal(dns.status, 200, 'the DKIM/SPF/DMARC record page must be reachable before any mailbox exists');
        assert.equal(dns.body.domain, SITE_DOMAIN);

        // The remaining config routes are asserted on their DECLARATIONS (POST /test would attempt a
        // real delivery, GET /security/dns-check a real DNS lookup). The `mailbox` flag is plugin-local
        // and stripped before the registration crosses the bridge, so the shipped source is where that
        // half is observable; `admin` is checked on what actually crossed.
        for (const key of ADMIN_CONFIG_ROUTES) {
            const reg = b.registered.find(r => `${r.method} ${r.sub}` === key);
            assert.ok(reg, `admin config route '${key}' is not registered`);
            assert.equal(reg!.opts.admin, true, `${key} must stay admin-only`);
            assert.ok(
                !declaresMailbox(declarationOf(key)),
                `${key} is CONFIGURATION, not mailbox use — gating it would make a fresh install, where ` +
                'nobody has a mailbox yet, impossible to configure'
            );
        }
    } finally { b.plugin.deactivate(); }
});

test('losing the corporate mailbox denies the very NEXT request (no cached access)', async () => {
    // The host rebuilds req.user from the database on every request (middleware/auth.ts), so the gate
    // must re-evaluate every time. If the plugin ever memoized the answer per user id, an admin
    // flipping the "Professional Mail Account" toggle off would leave the old grant live.
    const b = await boot();
    try {
        const stillHasIt = { ...ALICE };
        assert.equal((await call(b, 'get /stats', stillHasIt)).status, 200);

        // The admin flips the toggle off. The ADDRESS is untouched — only the grant is revoked, which is
        // exactly what the toggle now does, and the gate must follow the grant.
        const demoted = { ...ALICE, hasProfessionalMailbox: false };
        const after = await call(b, 'get /stats', demoted);
        assert.equal(after.status, 403, 'access must end with the grant, on the next request');
        assert.equal(after.body.code, 'mail_no_corporate_mailbox');
    } finally { b.plugin.deactivate(); }
});

test('the plugin and the HOST agree, address for address, on what a mail domain is', async () => {
    // The plugin runs in a sandboxed child process and cannot require host modules, so the address rule
    // necessarily exists twice (marketplace/…/index.js `mailboxDomainOf` and backend/src/core/mailbox.ts
    // `domainOfAddress`). They previously DISAGREED — the plugin took the text after the LAST '@' and
    // the host after the FIRST — which is a real split-identity bug: 'a@gmail.com@acme.example' passed
    // the plugin's mailbox test while the host filtered the same user out of the menu.
    //
    // Driven through the REAL /mailbox route, whose `address` is non-null exactly when the plugin's rule
    // says the account's address is on the mail domain, and compared against the host helper's answer
    // for the same string.
    const { domainOfAddress } = require('../core/mailbox');
    const ADVERSARIAL = [
        `alice@${SITE_DOMAIN}`,
        `ALICE@${SITE_DOMAIN.toUpperCase()}`,
        `  alice@${SITE_DOMAIN}  `,
        '', 'alice', 'alice@', `@${SITE_DOMAIN}`,
        `alice@mail.${SITE_DOMAIN}`,
        `alice@${SITE_DOMAIN}.evil.test`,
        `weird@quoted@${SITE_DOMAIN}`,     // two '@' — an address neither side may claim to understand
        `a@gmail.com@${SITE_DOMAIN}`,      // the exact drift case
        `alice@${SITE_DOMAIN}.`,           // trailing dot
        'alice@localhost',                 // no dot in the domain
    ];
    const b = await boot();
    try {
        for (const userEmail of ADVERSARIAL) {
            const probe = await call(b, 'get /mailbox',
                { id: 9, role: 'subscriber', userLogin: 'x', userEmail, hasProfessionalMailbox: true });
            const pluginSaysOnDomain = probe.body.address !== null;
            const hostSaysOnDomain = domainOfAddress(userEmail) === SITE_DOMAIN;
            assert.equal(
                pluginSaysOnDomain, hostSaysOnDomain,
                `plugin and host disagree about ${JSON.stringify(userEmail)}: plugin=${pluginSaysOnDomain} host=${hostSaysOnDomain}`
            );
        }
        // …and pin the actual rule, so "they agree" cannot be satisfied by both being wrong.
        assert.equal(domainOfAddress(`alice@${SITE_DOMAIN}`), SITE_DOMAIN);
        assert.equal(domainOfAddress(`a@gmail.com@${SITE_DOMAIN}`), '', 'a two-@ string is not an address at all');
        assert.equal(domainOfAddress(`alice@mail.${SITE_DOMAIN}`), `mail.${SITE_DOMAIN}`, 'a subdomain is a different domain');
    } finally { b.plugin.deactivate(); }
});

test('the mailbox PROBE reports the grant, not the address', async () => {
    const b = await boot();
    try {
        const probe = async (user: any) => (await call(b, 'get /mailbox', user)).body;
        // Grant + on-domain address = a real mailbox, reported with its address.
        assert.deepEqual(
            (({ hasMailbox, address }) => ({ hasMailbox, address }))(await probe(ALICE)),
            { hasMailbox: true, address: ALICE.userEmail }
        );
        // Grant but an off-domain address: they may use the surface, but they receive nowhere, and the
        // probe must not invent an address for them.
        const odd = { ...PABLO, hasProfessionalMailbox: true };
        assert.deepEqual(
            (({ hasMailbox, canUseMail, address }) => ({ hasMailbox, canUseMail, address }))(await probe(odd)),
            { hasMailbox: true, canUseMail: true, address: null }
        );
    } finally { b.plugin.deactivate(); }
});

test('INBOUND delivery needs the GRANT as well as the address (no self-provisioned inbox)', async () => {
    // The gate did not invent a rule for delivery: a user receives here only when the admin enabled
    // their mailbox AND their account address really is on the mail domain. MALLORY has the address but
    // not the grant — before this, that was enough to have ceo@<domain>'s incoming mail delivered into
    // her inbox. This drives the REAL onData handler the plugin installed on the SMTP server.
    const b = await boot({ options: { smtp_catch_all: '1' } });
    try {
        const deliver = (to: string, subject: string) => new Promise<void>((resolve, reject) => {
            const raw = [
                'From: Outside <ext@example.org>',
                `To: <${to}>`,
                `Subject: ${subject}`,
                '', 'Hello there.', ''
            ].join('\r\n');
            b.smtp.options.onData(Readable.from([raw]), {}, (err: any) => err ? reject(err) : resolve());
        });

        await deliver(`alice@${SITE_DOMAIN}`, 'For a real mailbox');
        await deliver(`pablo@${SITE_DOMAIN}`, 'For a personal-email user');
        await deliver(`ceo@${SITE_DOMAIN}`, 'For a self-assigned address');

        const owner = async (subject: string) =>
            (await b.db.get(`SELECT user_id FROM ${PREFIX}received_emails WHERE subject = ?`, [subject]) as any);

        assert.equal((await owner('For a real mailbox')).user_id, ALICE.id, 'a corporate mailbox receives its own mail');
        assert.equal(
            (await owner('For a personal-email user')).user_id, BOSS.id,
            'pablo@ has no mailbox so the message falls to the catch-all admin, not to him'
        );
        assert.equal(
            (await owner('For a self-assigned address')).user_id, BOSS.id,
            'MALLORY self-assigned ceo@ but has no GRANT — its mail must go to the catch-all admin, never to her'
        );
    } finally { b.plugin.deactivate(); }
});

test('a `www.` install (site host ≠ mail domain) keeps working — gate, probe, delivery and DNS page', async () => {
    // REGRESSION GUARD. The site is at https://www.acme.example while SPF/DKIM/DMARC/MX are published on
    // acme.example (mail_security_dkim_domain), which is the documented reason that override exists. The
    // plugin already signed, HELO'd and sent as acme.example, but the mailbox/inbound tests compared
    // against the raw site hostname — so on this exact install every non-admin was 403'd out of the whole
    // webmail and no inbound mail for @acme.example was ever stored, while the server happily kept
    // sending as it. One expression (resolveMailDomain) now feeds all of them.
    const b = await boot({
        options: { smtp_catch_all: '1' },
        secrets: { mail_security_dkim_domain: SITE_DOMAIN },
        siteDomain: `www.${SITE_DOMAIN}`
    });
    try {
        assert.equal((await call(b, 'get /stats', ALICE)).status, 200,
            'a granted user on the MAIL domain must not be 403d because the SITE host differs');

        const probe = await call(b, 'get /mailbox', ALICE);
        assert.equal(probe.body.siteDomain, SITE_DOMAIN, 'the probe must report the MAIL domain, not the site host');
        assert.equal(probe.body.address, ALICE.userEmail);

        const dns = await call(b, 'get /security/dns-records', BOSS);
        assert.equal(dns.body.domain, SITE_DOMAIN, 'the records to publish are for the mail domain');
        assert.equal(dns.body.heloHost, SITE_DOMAIN, 'and the HELO name is the same one');

        await new Promise<void>((resolve, reject) => {
            const raw = ['From: Outside <ext@example.org>', `To: <alice@${SITE_DOMAIN}>`,
                'Subject: Inbound on the apex', '', 'Hi.', ''].join('\r\n');
            b.smtp.options.onData(Readable.from([raw]), {}, (err: any) => err ? reject(err) : resolve());
        });
        const row: any = await b.db.get(`SELECT user_id FROM ${PREFIX}received_emails WHERE subject = ?`, ['Inbound on the apex']);
        assert.ok(row, 'inbound mail for the MAIL domain must be accepted');
        assert.equal(row.user_id, ALICE.id, 'and delivered to the mailbox it is addressed to');
    } finally { b.plugin.deactivate(); }
});

test('EVERY route that crosses the bridge is classified, and every gated route is exercised', async () => {
    // THE "CANNOT BE FORGOTTEN" ASSERTION, and the reason it is written this way.
    //
    // It used to be a REGEX SCAN of the shipped source that only recognised single-quoted paths followed
    // by a literal options object. Two mutations therefore left it 10/10 green: the 3-argument
    // `route(m, p, handler)` form (which registered a route with NO auth at all) and a double-quoted
    // path with `{ auth: true }` — the exact defect class this file exists to catch.
    //
    // So it now asserts SET EQUALITY between what ACTUALLY crossed the bridge during a real boot() and
    // the three declared sets. Any route registered in ANY syntactic form, from any code path, must
    // appear in exactly one of them or this fails — spelling cannot hide it, because nothing here reads
    // the spelling.
    const b = await boot();
    try {
        const registered = b.registered.map(r => `${r.method} ${r.sub}`);
        assert.equal(new Set(registered).size, registered.length,
            `the plugin registered the same route key twice: ${registered.filter((k, i) => registered.indexOf(k) !== i).join(', ')}`);

        const classified = new Set<string>([
            ...GATED_ROUTES.map(([k]) => k), ...ADMIN_CONFIG_ROUTES, ...UNGATED_BY_DESIGN.keys()
        ]);
        assert.deepEqual(
            registered.filter(k => !classified.has(k)).sort(), [],
            'these routes reached the host WITHOUT being classified. Every mail route must be declared ' +
            '{ auth: true, mailbox: true } and listed in GATED_ROUTES; a configuration route belongs in ' +
            'ADMIN_CONFIG_ROUTES; anything else needs an explicit entry (with its reason) in UNGATED_BY_DESIGN.'
        );
        assert.deepEqual(
            [...classified].filter(k => !registered.includes(k)).sort(), [],
            'these routes are declared here but the plugin no longer registers them — the coverage is stale'
        );

        // The gate is a PLUGIN-LOCAL option stripped before the bridge, so its presence is read from the
        // shipped declaration; its EFFECT is what the behavioural refusal loops above assert.
        for (const [key] of GATED_ROUTES) {
            assert.ok(declaresMailbox(declarationOf(key)),
                `${key} is user-facing mail: declare { auth: true, mailbox: true } on it`);
        }
        // The one ungated route must at least be authenticated.
        for (const key of UNGATED_BY_DESIGN.keys()) {
            const reg = b.registered.find(r => `${r.method} ${r.sub}` === key);
            assert.equal(reg!.opts.auth, true, `${key} is ungated but must still require authentication`);
        }
    } finally { b.plugin.deactivate(); }
});

test('the option-less route() form fails CLOSED', async () => {
    // `route(method, sub, handler)` used to register an UNAUTHENTICATED route — the worst default in a
    // mail plugin and the easiest thing for a reviewer to miss. It now means { auth: true, mailbox: true }.
    // (The set-equality test above is what stops such a route from shipping at all; this pins the
    // behaviour a future 3-arg call would get.)
    assert.match(
        SOURCE,
        /if \(typeof opts === 'function'\) \{ handler = opts; opts = \{ auth: true, mailbox: true \}; \}/,
        'the option-less route() form must default to the strictest declaration, not to none'
    );
});

test('the corporate-mailbox rule has exactly ONE definition in the plugin', () => {
    // Structural, on the shipped source: the point of the change is that ONE predicate decides this.
    assert.equal(
        (SOURCE.match(/function hasCorporateMailbox\(/g) || []).length, 1,
        'hasCorporateMailbox() must be defined exactly once'
    );
    // The historical inline copies compared the user's own email domain to siteDomain by hand.
    const inline = SOURCE.match(/userEmail[^\n]*split\('@'\)\[1\][^\n]*siteDomain/g) || [];
    assert.deepEqual(inline, [], 'the mailbox rule must not be re-inlined — call hasCorporateMailbox()');
    // Inbound delivery and sendMail's internal-delivery branch both resolve a recipient to a candidate
    // account, and both must ask for the ADDRESS (grant + on-domain), not merely the grant.
    //
    // THE ASSERTION IS INVERTED, and this is the third spelling of it. Version 1 counted occurrences of
    // one literal, which made the suite depend on what the delivery locals were NAMED. Version 2
    // DISCOVERED delivery paths by the `findByEmail || findByLogin` pair — an improvement on the guard
    // half (it demanded the assignment be inside the if) and a hole on the discovery half: it recognized
    // ONE SYNTACTIC SHAPE and nothing else, so a future `const u = await User.findByEmail(addr); if (u)
    // localUser = u;` was simply not seen, passed in silence, and `>= 2` meant a third path could be
    // added without anyone noticing. A test that enumerates the forms the code already handles is
    // documentation, not a gate.
    //
    // So: enumerate EVERY account lookup in the plugin and make each one justify itself. A lookup is
    // either (a) a DELIVERY path, which must assign its candidate as the local inbox owner only inside
    // an `if (mailboxAddressOf(<local>, <domain>))` guard, or (b) explicitly marked
    // `// NOT-A-DELIVERY-PATH: <reason>` in the source immediately above it. A new lookup with neither
    // fails HERE, by default — which is the property the previous versions did not have.
    const SRC_LINES = SOURCE.split('\n');
    const lookupLines = SRC_LINES
        .map((text, i) => ({ text, i }))
        .filter(l => /User\.(?:findByEmail|findByLogin)\s*\(/.test(l.text) && !/^\s*(?:\/\/|\*)/.test(l.text));
    assert.ok(lookupLines.length >= 6,
        `expected the plugin to still resolve accounts somewhere; found ${lookupLines.length}`);
    const deliverySites: string[] = [];
    const exempted: string[] = [];
    for (const { text: line, i } of lookupLines) {
        // The exemption must sit in the comment block DIRECTLY above the statement — walk up while the
        // lines are comments, stop at the first blank line or statement — so it cannot be inherited
        // from an unrelated paragraph further up the file.
        let exempt = false;
        for (let j = i - 1; j >= 0; j--) {
            const t = SRC_LINES[j].trim();
            if (t === '' || !t.startsWith('//')) break;
            if (t.includes('NOT-A-DELIVERY-PATH:')) { exempt = true; break; }
        }
        if (exempt) { exempted.push(line.trim()); continue; }
        // A delivery path: it must name a local and gate the assignment on mailboxAddressOf().
        const local = (line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/) || [])[1];
        assert.ok(
            local,
            `this account lookup is neither marked NOT-A-DELIVERY-PATH nor assigned to a local the guard ` +
            `can be checked against:\n    ${line.trim()}`
        );
        const after = SRC_LINES.slice(i, i + 20).join('\n');
        assert.match(
            after,
            new RegExp(`if\\s*\\(\\s*mailboxAddressOf\\(\\s*${local}\\s*,\\s*\\w+\\s*\\)\\s*\\)\\s*\\{\\s*[A-Za-z_$][\\w$]*\\s*=\\s*${local}\\s*;`),
            `a delivery path resolves '${local}' from an inbound recipient and must assign it as the local ` +
            `inbox owner ONLY inside an if (mailboxAddressOf(${local}, <mailDomain>)) guard — the grant ` +
            `alone, or the address alone, is the inbox-hijack this predicate exists to close. If this ` +
            `lookup does NOT map a recipient onto an inbox, mark it '// NOT-A-DELIVERY-PATH: <why>'.`
        );
        deliverySites.push(local);
    }
    assert.ok(
        deliverySites.length >= 2,
        `both delivery paths (inbound onData + sendMail internal delivery) must resolve a recipient ` +
        `account; found ${deliverySites.length} such site(s). Exempted: ${exempted.length}`
    );
    // And the mail domain itself has ONE expression — every other site calls it.
    assert.equal(
        (SOURCE.match(/function resolveMailDomain\(/g) || []).length, 1,
        'resolveMailDomain() must be defined exactly once'
    );
    assert.deepEqual(
        SOURCE.match(/dkimDomain \|\| siteDomain/g) || [], [],
        'the "dkim domain else site domain" expression must not be re-inlined — call resolveMailDomain()/getMailDomain()'
    );
});

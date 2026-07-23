/**
 * mail-server ACTIVE CORPORATE MAILBOX gate suite.
 *
 * WHY THIS FILE EXISTS: every user-facing mail route used to be declared with `{ auth: true }` and
 * nothing else, so ANY authenticated account — including a subscriber whose account email is a
 * personal gmail address, who therefore has no inbox on this server at all — could POST /send and
 * push mail through the site MTA, signed with the SITE's DKIM key, spending the site domain's
 * sending reputation. Per-message ownership was checked, so this was never a read-others hole; it
 * was an unauthorized-SEND and unauthorized-surface hole. The fix gates the whole mail surface on
 * the mailbox predicate that inbound delivery already enforced.
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
 * ({ id, role, userEmail, userLogin } — no capability map, which is why the admin allowance below
 * keys off `role`, exactly like the plugin's existing canAccessEmail override).
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
const ALICE = { id: 2, role: 'editor', userEmail: `alice@${SITE_DOMAIN}`, userLogin: 'alice' };      // HAS a mailbox
const PABLO = { id: 3, role: 'subscriber', userEmail: 'pablo@gmail.com', userLogin: 'pablo' };        // personal address
const BOSS = { id: 1, role: 'administrator', userEmail: 'boss@gmail.com', userLogin: 'boss' };        // admin, personal address
const DIRECTORY = [BOSS, ALICE, PABLO];

type RouteHandler = (req: any, res: any) => any;

type Boot = {
    plugin: any;
    routes: Map<string, RouteHandler>;
    registered: { method: string; sub: string; opts: any }[];
    db: any;
    Email: any;
    smtp: any;
};

async function boot(extraOptions: Record<string, string> = {}, users = DIRECTORY): Promise<Boot> {
    const db = makeDb();
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
            async url() { return `https://${SITE_DOMAIN}`; },
            async domain() { return SITE_DOMAIN; },
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

// The `mailbox` flag is a PLUGIN-LOCAL route option — the plugin's route() helper consumes it and
// never forwards it to the host — so the shipped declaration is where it is observable.
const ROUTE_DECL_RE = /route\('(get|post|put|delete|patch)', '([^']+)', \{([^}]*)\}/g;
function declarationOf(key: string): string {
    ROUTE_DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROUTE_DECL_RE.exec(SOURCE)) !== null) {
        if (`${m[1]} ${m[2]}` === key) return m[3];
    }
    assert.fail(`route '${key}' is not declared in ${PLUGIN_SRC}`);
}

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
    const b = await boot({}, [BOSS]);
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
                !/mailbox\s*:\s*true/.test(declarationOf(key)),
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

        // The admin flips the toggle off: the account email is rewritten to a personal address.
        const demoted = { ...ALICE, userEmail: 'alice@gmail.com' };
        const after = await call(b, 'get /stats', demoted);
        assert.equal(after.status, 403, 'access must end with the mailbox, on the next request');
        assert.equal(after.body.code, 'mail_no_corporate_mailbox');
    } finally { b.plugin.deactivate(); }
});

test('the mailbox predicate handles blank / malformed / differently-cased addresses', async () => {
    // Driven through the REAL /mailbox route, which answers from the same helper the gate uses.
    const b = await boot();
    try {
        const probe = async (userEmail: any) =>
            (await call(b, 'get /mailbox', { id: 9, role: 'subscriber', userLogin: 'x', userEmail })).body.hasMailbox;

        assert.equal(await probe(`ALICE@${SITE_DOMAIN.toUpperCase()}`), true, 'case must not matter');
        assert.equal(await probe(`  alice@${SITE_DOMAIN}  `), true, 'surrounding whitespace must not matter');
        assert.equal(await probe(''), false, 'a blank email is not a mailbox');
        assert.equal(await probe(null), false, 'a missing email is not a mailbox');
        assert.equal(await probe(undefined), false, 'an undefined email is not a mailbox');
        assert.equal(await probe('alice'), false, 'an address with no @ is not a mailbox');
        assert.equal(await probe(`alice@`), false, 'an empty domain is not a mailbox');
        assert.equal(await probe(`@${SITE_DOMAIN}`), false, 'an empty local part is not a mailbox');
        assert.equal(await probe(`alice@mail.${SITE_DOMAIN}`), false, 'a SUBdomain is a different mail domain');
        assert.equal(await probe(`alice@${SITE_DOMAIN}.evil.test`), false, 'a suffix-extended domain must not match');
        assert.equal(await probe(`weird@quoted@${SITE_DOMAIN}`), true, 'the domain is what follows the LAST @');
    } finally { b.plugin.deactivate(); }
});

test('INBOUND delivery decides local ownership with the SAME predicate (personal-email user gets no inbox)', async () => {
    // The gate did not invent a rule: it reuses the one the inbound path already enforced. This drives
    // the REAL onData handler the plugin installed on the SMTP server.
    const b = await boot({ smtp_catch_all: '1' });
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

        const owner = async (subject: string) =>
            (await b.db.get(`SELECT user_id FROM ${PREFIX}received_emails WHERE subject = ?`, [subject]) as any);

        assert.equal((await owner('For a real mailbox')).user_id, ALICE.id, 'a corporate mailbox receives its own mail');
        assert.equal(
            (await owner('For a personal-email user')).user_id, BOSS.id,
            'pablo@ has no inbox (his account email is personal) so the message falls to the catch-all admin, not to him'
        );
    } finally { b.plugin.deactivate(); }
});

test('EVERY non-admin route declares the gate, and every gated route is exercised above', () => {
    // This is the "cannot be forgotten" assertion. A new user-facing mail route added with a bare
    // `{ auth: true }` — the exact defect this change fixes — fails HERE, in CI, instead of shipping
    // as another way for an account with no mailbox to use the site MTA.
    const UNGATED_BY_DESIGN = new Map([
        // The probe that TELLS a user they have no mailbox; gating it would 403 the answer.
        ['get /mailbox', 'the mailbox probe the client shell asks before rendering'],
    ]);
    const declared: string[] = [];
    const ungated: string[] = [];
    ROUTE_DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROUTE_DECL_RE.exec(SOURCE)) !== null) {
        const key = `${m[1]} ${m[2]}`;
        const opts = m[3];
        if (/mailbox\s*:\s*true/.test(opts)) { declared.push(key); continue; }
        if (/admin\s*:\s*true/.test(opts)) continue;            // configuration — see the test above
        if (UNGATED_BY_DESIGN.has(key)) continue;
        ungated.push(key);
    }
    assert.deepEqual(
        ungated, [],
        'these mail routes are reachable by ANY authenticated account, including one with no inbox on ' +
        'this server. Declare { auth: true, mailbox: true } on them (or, if the route is genuinely ' +
        'not mail use, document it in UNGATED_BY_DESIGN / ADMIN_CONFIG_ROUTES).'
    );
    assert.ok(declared.length >= 28, `expected the whole mail surface to be gated, found ${declared.length} routes`);
    const exercised = new Set(GATED_ROUTES.map(([k]) => k));
    assert.deepEqual(
        declared.filter(k => !exercised.has(k)), [],
        'a gated route is not covered by the behavioural refusal loop — add it to GATED_ROUTES'
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
    // Inbound delivery and sendMail's internal-delivery branch both resolve a `candidate` user.
    assert.equal(
        (SOURCE.match(/hasCorporateMailbox\(candidate, siteDomain\)/g) || []).length, 2,
        'both delivery paths (inbound onData + sendMail internal delivery) must go through the helper'
    );
});

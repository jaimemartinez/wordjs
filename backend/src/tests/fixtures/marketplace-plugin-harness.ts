/**
 * Shared test fixture: boot a REAL marketplace plugin entry point (marketplace/plugins/<slug>/index.js)
 * in-process against a minimal `wordjs` bridge, backed by an in-memory better-sqlite3 database, and call
 * its HTTP handlers directly.
 *
 * What is real: the plugin's own code (loaded fresh per boot, so module-level state never leaks between
 * tests), its SQL (executed by SQLite) and the HOST SQL GUARD — every statement goes through
 * plugin-api.assertSqlAllowed with the plugin's own prefix and the verb list the host applies to that
 * bridge method, so a fix that issues SQL the sandbox would deny fails here instead of at runtime.
 *
 * What is stubbed: mail (recorded, or made to throw), options (a Map), crypto.randomToken (node's
 * CSPRNG), site.url, adminMenu, shortcodes and assets (registrations ignored), timers the plugin arms
 * at boot (captured and cleared by close()), and the request object — which carries `clientKey`
 * exactly like plugin-isolate.ts forwards it.
 *
 * Engine model: SQLite runs every statement atomically, which hides a race that Postgres has. On the
 * host each plugin statement autocommits on its own pooled connection under READ COMMITTED, so an
 * `INSERT ... SELECT ... WHERE <guard>` evaluates its guard against a snapshot taken when the statement
 * starts: two concurrent statements both see "no conflicting row" and both insert. `snapshotInsertSelect`
 * reproduces that: such a statement evaluates its SELECT, yields to the event loop once (so every
 * concurrent statement takes its snapshot too), then inserts the rows. Unique indexes are still enforced
 * at insert time, as they are on every engine — the one mechanism that stays atomic there, together
 * with a conditional UPDATE that re-checks its own row. `caseInsensitiveText` models MySQL's
 * case- and accent-insensitive collation: two strings JavaScript tells apart can be one key there.
 *
 * Interleaving: `setStatementHook` runs a callback after each statement has executed and before the
 * plugin sees its result. A test uses it to land another request's writes in the gap between two
 * statements of one request — e.g. a read and the UPDATE it decides — exactly where a concurrent
 * request's statements commit on the host (each one autocommits on its own connection).
 * `setPreStatementHook` runs a callback before a statement executes: the statement is in flight over
 * the bridge and other requests' statements land first. That is the gap after a request releases an
 * in-process lock and before its next statement runs, which no post-statement hook can reach: in
 * the harness that next statement otherwise runs in the same tick as the release.
 */
import path from 'path';
import crypto from 'crypto';

const Database = require('better-sqlite3');
const { assertSqlAllowed } = require('../../core/plugin-api');

const PLUGINS_DIR = path.resolve(__dirname, '../../../../marketplace/plugins');
const READ_VERBS = ['select', 'with'];
const WRITE_VERBS = ['insert', 'update', 'delete', 'create', 'alter', 'drop', 'replace'];

export interface MailMessage { to: string; subject: string; text?: string; html?: string }

export interface CallOptions {
    body?: any;
    query?: any;
    params?: any;
    user?: any;
    clientKey?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
}

export type StatementHook = (sql: string, params: any[]) => void | Promise<void>;

export interface BootedPlugin {
    sdb: any;
    prefix: string;
    mails: MailMessage[];
    options: Map<string, any>;
    /** When set, every wordjs.mail() call throws this error (models "no provider configured"). */
    setMailFailure(err: Error | null): void;
    /**
     * Run `hook` after every db.get / db.all / db.run statement has executed and before the plugin
     * receives its result (null removes it). Statements issued from inside the hook reach it too.
     */
    setStatementHook(hook: StatementHook | null): void;
    /**
     * Run `hook` before every db.get / db.all / db.run statement executes (null removes it); the
     * statement waits for it. Statements issued from inside the hook reach it too.
     */
    setPreStatementHook(hook: StatementHook | null): void;
    call(method: string, routePath: string, opts?: CallOptions): Promise<{ status: number; body: any }>;
    close(): void;
}

export interface BootOptions {
    /** Runs against the empty database BEFORE init() — e.g. to lay down a previous version's schema. */
    beforeInit?: (sdb: any, prefix: string) => void;
    /** Model Postgres READ COMMITTED for `INSERT ... SELECT` (see "Engine model" above). */
    snapshotInsertSelect?: boolean;
    /**
     * Model MySQL's case-insensitive collations (utf8mb4_unicode_ci, the collation the MySQL driver
     * connects with, also folds accents: 'josé' = 'jose'): the plugin's TEXT and VARCHAR columns are
     * created COLLATE NOCASE, so `=`, `IN` and unique indexes on them treat two spellings as one value
     * while JavaScript sees two strings. SQLite folds ASCII case only, so a test plays the accented
     * twin with an upper-case one.
     */
    caseInsensitiveText?: boolean;
}

// `INSERT INTO <table> (<cols>) SELECT ...` — the only statement shape the snapshot model rewrites.
const INSERT_SELECT_RE = /^\s*INSERT\s+INTO\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*(SELECT\b[\s\S]*)$/i;
// `<name> TEXT|VARCHAR(n) ...` — a column definition the case-insensitive model gives COLLATE NOCASE.
const TEXT_COLUMN_RE = /^(\s*[A-Za-z_][A-Za-z0-9_]*\s+(?:TEXT|VARCHAR\(\d+\)))(?![^,]*\bCOLLATE\b)/i;
const ALTER_ADD_TEXT_RE = /^(\s*ALTER\s+TABLE\s+[A-Za-z0-9_]+\s+ADD\s+COLUMN\s+[A-Za-z_][A-Za-z0-9_]*\s+(?:TEXT|VARCHAR\(\d+\)))/i;

export async function bootPlugin(slug: string, bootOpts: BootOptions = {}): Promise<BootedPlugin> {
    const sdb = new Database(':memory:');
    const prefix = 'wjp_' + slug.replace(/-/g, '_') + '_';
    if (bootOpts.beforeInit) bootOpts.beforeInit(sdb, prefix);
    const fixTypes = (s: string) => s.replace(/\bINT_PK\b/g, 'INTEGER PRIMARY KEY AUTOINCREMENT').replace(/\bINT\b/g, 'INTEGER');
    const fix = bootOpts.caseInsensitiveText
        ? (s: string) => fixTypes(s.replace(ALTER_ADD_TEXT_RE, '$1 COLLATE NOCASE'))
        : fixTypes;
    const fixColumn = (c: string) => (bootOpts.caseInsensitiveText ? c.replace(TEXT_COLUMN_RE, '$1 COLLATE NOCASE') : c);
    const guard = (sql: string, verbs: string[]) => assertSqlAllowed(sql, verbs, prefix, slug);
    let statementHook: StatementHook | null = null;
    /**
     * The statement has run: give the hook its turn, then hand the result to the plugin. Without a
     * hook the result is returned as is, so the timing every other test relies on is unchanged.
     */
    const settle = <R>(sql: string, p: any[], result: R): R | Promise<R> => {
        const hook = statementHook;
        return hook ? Promise.resolve(hook(sql, p)).then(() => result) : result;
    };
    let preStatementHook: StatementHook | null = null;

    const db = {
        tablePrefix: prefix,
        async run(sql: string, p: any[] = []) {
            guard(sql, WRITE_VERBS);
            if (preStatementHook) await preStatementHook(sql, p);
            const m = bootOpts.snapshotInsertSelect ? INSERT_SELECT_RE.exec(sql) : null;
            if (m) {
                // Read the guard's verdict from the current state, let concurrent statements read the
                // same state, then write — exactly the window READ COMMITTED leaves open.
                const rows: any[][] = sdb.prepare(fix(m[3])).raw().all(...p);
                await new Promise((resolve) => setImmediate(resolve));
                const cols = m[2].split(',').map((c) => c.trim());
                const ins = sdb.prepare(`INSERT INTO ${m[1]} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
                let changes = 0;
                let lastID = 0;
                for (const row of rows) {
                    const r = ins.run(...row);
                    changes += r.changes;
                    lastID = Number(r.lastInsertRowid);
                }
                return settle(sql, p, { changes, lastID });
            }
            const r = sdb.prepare(fix(sql)).run(...p);
            return settle(sql, p, { changes: r.changes, lastID: Number(r.lastInsertRowid) });
        },
        async get(sql: string, p: any[] = []) {
            guard(sql, READ_VERBS);
            if (preStatementHook) await preStatementHook(sql, p);
            return settle(sql, p, sdb.prepare(sql).get(...p));
        },
        async all(sql: string, p: any[] = []) {
            guard(sql, READ_VERBS);
            if (preStatementHook) await preStatementHook(sql, p);
            return settle(sql, p, sdb.prepare(sql).all(...p));
        },
        async createTable(name: string, cols: string[]) {
            if (!name.startsWith(prefix)) throw new Error(`createTable outside the plugin prefix: ${name}`);
            sdb.exec(fix(`CREATE TABLE IF NOT EXISTS ${name} (${cols.map(fixColumn).join(', ')})`));
        },
        async batch(stmts: Array<[string, any[]]>) {
            for (const [s, p] of stmts) { guard(s, WRITE_VERBS); sdb.prepare(s).run(...(p || [])); }
        },
        async getType() { return 'sqlite'; },
    };

    type Handler = (req: any, res: any) => unknown;
    const routes = new Map<string, { opts: any; fn: Handler }>();
    const http = {
        route(method: string, p: string, opts: any, fn?: Handler) {
            if (typeof opts === 'function') { fn = opts; opts = {}; }
            routes.set(method.toUpperCase() + ' ' + p, { opts, fn: fn as Handler });
        },
    };

    const mails: MailMessage[] = [];
    let mailFailure: Error | null = null;
    const options = new Map<string, any>();
    const wordjs: any = {
        db,
        http,
        adminMenu: { add() { /* sidebar is irrelevant here */ } },
        shortcodes: { add() { /* shortcode rendering is not under test here */ } },
        assets: { enqueueScript() { /* front-end assets are irrelevant here */ }, enqueueStyle() { /* idem */ } },
        notify: async () => ({}),
        mail: async (msg: MailMessage) => {
            if (mailFailure) throw mailFailure;
            mails.push(msg);
            return {};
        },
        options: {
            get: async (k: string, d: any) => (options.has(k) ? options.get(k) : d),
            set: async (k: string, v: any) => { options.set(k, v); },
        },
        crypto: {
            randomToken: async (n: number) => crypto.randomBytes(n).toString('hex'),
            randomInt: async (min: number, max: number) => crypto.randomInt(min, max),
        },
        site: { url: async () => 'http://site.test', domain: async () => 'site.test', adminEmail: async () => 'admin@site.test' },
    };

    // Load a FRESH copy of the entry so module-level state (timers, maps) is per boot.
    const entry = path.join(PLUGINS_DIR, slug, 'index.js');
    delete require.cache[require.resolve(entry)];
    const mod = require(entry);

    const timers: any[] = [];
    const realSetTimeout = global.setTimeout;
    const realSetInterval = global.setInterval;
    (global as any).setTimeout = (...a: any[]) => { const h = (realSetTimeout as any)(...a); timers.push(h); return h; };
    (global as any).setInterval = (...a: any[]) => { const h = (realSetInterval as any)(...a); timers.push(h); return h; };
    const realLog = console.log;
    console.log = () => { /* plugin boot chatter */ };
    try {
        await mod.init(wordjs);
    } finally {
        (global as any).setTimeout = realSetTimeout;
        (global as any).setInterval = realSetInterval;
        console.log = realLog;
    }

    async function call(method: string, routePath: string, o: CallOptions = {}) {
        const r = routes.get(method.toUpperCase() + ' ' + routePath);
        if (!r) throw new Error(`no route ${method} ${routePath} in ${slug}`);
        return new Promise<{ status: number; body: any }>((resolve, reject) => {
            const res: any = {
                statusCode: 200,
                status(c: number) { this.statusCode = c; return this; },
                json(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
                send(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
                setHeader() { /* noop */ }, cookie() { /* noop */ }, clearCookie() { /* noop */ },
            };
            const req = {
                body: o.body || {}, query: o.query || {}, params: o.params || {},
                headers: o.headers || {}, cookies: o.cookies || {},
                user: o.user || null, clientKey: o.clientKey === undefined ? 'client-default' : o.clientKey,
            };
            Promise.resolve(r.fn(req, res)).catch(reject);
        });
    }

    return {
        sdb, prefix, mails, options,
        setMailFailure(err) { mailFailure = err; },
        setStatementHook(hook) { statementHook = hook; },
        setPreStatementHook(hook) { preStatementHook = hook; },
        call,
        close() {
            for (const h of timers) { try { clearTimeout(h); clearInterval(h); } catch { /* cleared */ } }
            try { if (typeof mod.deactivate === 'function') mod.deactivate(); } catch { /* best effort */ }
            sdb.close();
        },
    };
}

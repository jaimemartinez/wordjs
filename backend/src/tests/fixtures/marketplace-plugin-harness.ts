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
 * CSPRNG), site.url, adminMenu, timers the plugin arms at boot (captured and cleared by close()), and the
 * request object — which carries `clientKey` exactly like plugin-isolate.ts forwards it.
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

export interface BootedPlugin {
    sdb: any;
    prefix: string;
    mails: MailMessage[];
    options: Map<string, any>;
    /** When set, every wordjs.mail() call throws this error (models "no provider configured"). */
    setMailFailure(err: Error | null): void;
    call(method: string, routePath: string, opts?: CallOptions): Promise<{ status: number; body: any }>;
    close(): void;
}

export interface BootOptions {
    /** Runs against the empty database BEFORE init() — e.g. to lay down a previous version's schema. */
    beforeInit?: (sdb: any, prefix: string) => void;
}

export async function bootPlugin(slug: string, bootOpts: BootOptions = {}): Promise<BootedPlugin> {
    const sdb = new Database(':memory:');
    const prefix = 'wjp_' + slug.replace(/-/g, '_') + '_';
    if (bootOpts.beforeInit) bootOpts.beforeInit(sdb, prefix);
    const fix = (s: string) => s.replace(/\bINT_PK\b/g, 'INTEGER PRIMARY KEY AUTOINCREMENT').replace(/\bINT\b/g, 'INTEGER');
    const guard = (sql: string, verbs: string[]) => assertSqlAllowed(sql, verbs, prefix, slug);

    const db = {
        tablePrefix: prefix,
        async run(sql: string, p: any[] = []) {
            guard(sql, WRITE_VERBS);
            const r = sdb.prepare(fix(sql)).run(...p);
            return { changes: r.changes, lastID: Number(r.lastInsertRowid) };
        },
        async get(sql: string, p: any[] = []) { guard(sql, READ_VERBS); return sdb.prepare(sql).get(...p); },
        async all(sql: string, p: any[] = []) { guard(sql, READ_VERBS); return sdb.prepare(sql).all(...p); },
        async createTable(name: string, cols: string[]) {
            if (!name.startsWith(prefix)) throw new Error(`createTable outside the plugin prefix: ${name}`);
            sdb.exec(fix(`CREATE TABLE IF NOT EXISTS ${name} (${cols.join(', ')})`));
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
        call,
        close() {
            for (const h of timers) { try { clearTimeout(h); clearInterval(h); } catch { /* cleared */ } }
            try { if (typeof mod.deactivate === 'function') mod.deactivate(); } catch { /* best effort */ }
            sdb.close();
        },
    };
}

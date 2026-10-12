/**
 * Shared test fixture: boots the REAL conference-manager plugin (marketplace/plugins/conference-manager/
 * index.js) — its real `exports.init(wordjs)`, real schema, real migrations and real route handlers — over an
 * in-memory better-sqlite3 database, through a double of the isolated plugin's `wordjs` capability bridge.
 *
 * What is doubled, and how faithfully:
 *   - `wordjs.db`: every statement first goes through the HOST's real SQL guard (core/plugin-api.ts
 *     assertSqlAllowed, with the verb list plugin-api hands it for that method), so SQL the sandbox would
 *     deny fails here too. `INT_PK` is translated like the SQLite driver does.
 *   - `wordjs.users`: the users:read bridge over a directory, projected with the host's own projectUser;
 *     `setUsersGrant(false)` makes it throw the host's «without permission» Security Block. A directory
 *     user's `extra.pluginCapabilities` is added to its projection, as the host adds the account's
 *     own-namespace capabilities (core/plugin-api.ts projectUserFor); without it the projection carries
 *     none, like a host older than 2.16.0.
 *   - routes: `call()` enforces the route options the way core/plugin-isolate.ts does ({ auth } → 401 without
 *     a user; { admin } → 403 for a non-administrator) BEFORE the handler, and passes `req.user` in the shape
 *     the host forwards ({ id, role, userEmail, userLogin, hasProfessionalMailbox }, plus the user's
 *     `extra` — e.g. `pluginCapabilities`, which a 2.16.0 host forwards on every request).
 *   - `adminMenu.add` records the menu items; `crypto` is node's CSPRNG.
 * `reboot()` runs init() again on the SAME database (a restart), so boot-time migrations can be pinned.
 */
import path from 'path';

const Database = require('better-sqlite3');
const { assertSqlAllowed, projectUser } = require('../../core/plugin-api');

export const PLUGIN_DIR = path.resolve(__dirname, '../../../../marketplace/plugins/conference-manager');
export const PLUGIN_PATH = path.join(PLUGIN_DIR, 'index.js');
export const PREFIX = 'wjp_conference_manager_';
const SLUG = 'conference-manager';
const READ = ['select', 'with'];
const WRITE = ['insert', 'update', 'delete', 'create', 'alter', 'drop', 'replace'];

export type HarnessUser = { id: number; role: string; userLogin?: string; userEmail?: string; displayName?: string; extra?: Record<string, any> };
export type CallResult = { status: number | 'UNHANDLED'; body: any; route: string | null; host?: boolean };

const bindable = (params: any[] | undefined) => (params || []).map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const typeMap = (col: string) => col.replace(/\bINT_PK\b/g, 'INTEGER PRIMARY KEY AUTOINCREMENT');

export const ADMIN: HarnessUser = { id: 1, role: 'administrator', userLogin: 'boss', userEmail: 'boss@example.test', displayName: 'Boss' };

export async function bootPlugin(opts: { users?: HarnessUser[]; usersGrant?: boolean; quiet?: boolean } = {}) {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const usersState = {
        grant: opts.usersGrant !== false,
        directory: new Map<number, HarnessUser>([[ADMIN.id, ADMIN], ...(opts.users || []).map(u => [u.id, u] as [number, HarnessUser])]),
    };
    const routes: { method: string; path: string; opts: any; handler: (req: any, res: any) => any }[] = [];
    const menu: any[] = [];
    const logs: [string, string][] = [];
    const sqlLog: string[] = [];
    const guard = (sql: string, verbs: string[]) => { sqlLog.push(sql); assertSqlAllowed(sql, verbs, PREFIX, SLUG); };

    const db = {
        tablePrefix: PREFIX,
        async all(sql: string, params: any[] = []) { guard(sql, READ); return raw.prepare(sql).all(...bindable(params)); },
        async get(sql: string, params: any[] = []) { guard(sql, READ); return raw.prepare(sql).get(...bindable(params)); },
        async run(sql: string, params: any[] = []) {
            guard(sql, WRITE);
            if (/^\s*(?:create|alter|drop)\b/i.test(sql) && !(params || []).length) { raw.exec(sql); return { lastID: 0, changes: 0 }; }
            const info = raw.prepare(sql).run(...bindable(params));
            return { lastID: Number(info.lastInsertRowid), changes: info.changes };
        },
        async batch(statements: any[]) {
            if (!Array.isArray(statements) || !statements.length) throw new Error('db.batch expects a non-empty array');
            if (statements.length > 200) throw new Error('db.batch accepts at most 200 statements per call.');
            const plan = statements.map(e => (Array.isArray(e) ? e : [e, []]));
            for (const [sql] of plan) {
                if (/^\s*(?:create|alter|drop)\b/i.test(sql)) throw new Error('db.batch does not accept DDL');
                guard(sql, /^\s*(?:select|with)\b/i.test(sql) ? READ : ['insert', 'update', 'delete', 'replace']);
            }
            const out: any[] = [];
            for (const [sql, params = []] of plan) {
                if (/^\s*(?:select|with)\b/i.test(sql)) out.push(raw.prepare(sql).all(...bindable(params)));
                else { const i = raw.prepare(sql).run(...bindable(params)); out.push({ lastID: Number(i.lastInsertRowid), changes: i.changes }); }
            }
            return out;
        },
        async createTable(name: string, columns: string[]) {
            if (!String(name).startsWith(PREFIX)) throw new Error(`createTable outside the plugin prefix: ${name}`);
            raw.exec(`CREATE TABLE IF NOT EXISTS ${name} (${columns.map(typeMap).join(', ')})`);
        },
        getType() { return 'sqlite'; },
    };
    // The host's users-bridge projection: projectUser + the account's own-namespace capabilities.
    const project = (u: HarnessUser | null) => {
        const p = projectUser(u);
        if (p && u && u.extra && Array.isArray(u.extra.pluginCapabilities)) p.pluginCapabilities = u.extra.pluginCapabilities.slice();
        return p;
    };
    const usersGate = () => {
        if (!usersState.grant) throw new Error(`Security Block: Plugin '${SLUG}' tried to access 'users' (read) without permission. Declare it in manifest.json first.`);
    };
    const wordjs = {
        db,
        http: {
            route(method: string, p: string, o: any, handler?: any) {
                if (typeof o === 'function') { handler = o; o = {}; }
                routes.push({ method: method.toLowerCase(), path: p, opts: o || {}, handler });
            },
        },
        adminMenu: { add: (m: any) => menu.push(m) },
        users: {
            async findById(id: any) { usersGate(); return project(usersState.directory.get(Number(id)) || null); },
            async findByLogin(l: string) { usersGate(); return project([...usersState.directory.values()].find(u => u.userLogin === l) || null); },
            async findByEmail(e: string) { usersGate(); return project([...usersState.directory.values()].find(u => u.userEmail === e) || null); },
            async search(term: string, limit = 50) {
                usersGate();
                const t = String(term || '').toLowerCase();
                return [...usersState.directory.values()]
                    .filter(u => !t || [u.userLogin, u.displayName, u.userEmail].some(v => String(v || '').toLowerCase().includes(t)))
                    .slice(0, Math.min(Number(limit) || 50, 200)).map(project);
            },
        },
        crypto: {
            randomInt: async (lo: number, hi: number) => require('crypto').randomInt(lo, hi),
            randomToken: async (bytes = 16) => require('crypto').randomBytes(Math.min(Math.max(Math.floor(Number(bytes) || 16), 8), 64)).toString('hex'),
        },
    };

    async function init() {
        routes.length = 0;
        menu.length = 0;
        const resolved = require.resolve(PLUGIN_PATH);
        delete require.cache[resolved];
        const plugin = require(resolved);
        const orig = { log: console.log, warn: console.warn, error: console.error };
        console.log = (...a: any[]) => { logs.push(['log', a.join(' ')]); };
        console.warn = (...a: any[]) => { logs.push(['warn', a.join(' ')]); };
        console.error = (...a: any[]) => { logs.push(['error', a.join(' ')]); };
        try { await plugin.init(wordjs); } finally { Object.assign(console, orig); }
    }
    await init();

    function match(method: string, urlPath: string) {
        for (const r of routes) {
            if (r.method !== method) continue;
            const a = r.path.split('/'), b = urlPath.split('/');
            if (a.length !== b.length) continue;
            const params: Record<string, string> = {};
            let ok = true;
            for (let i = 0; i < a.length; i++) {
                if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
                else if (a[i] !== b[i]) { ok = false; break; }
            }
            if (ok) return { route: r, params };
        }
        return null;
    }

    /** One request. `user` defaults to the administrator; `anonymous` sends none. */
    async function call(method: string, url: string, { body, user, anonymous }: { body?: any; user?: HarnessUser & Record<string, any>; anonymous?: boolean } = {}): Promise<CallResult> {
        const [urlPath, qs] = url.split('?');
        const m = match(method.toLowerCase(), urlPath);
        if (!m) return { status: 404, body: { error: 'no route' }, route: null };
        const who = anonymous ? null : (user || ADMIN);
        if (m.route.opts.auth && !who) return { status: 401, body: { code: 'rest_not_logged_in' }, route: m.route.path, host: true };
        if (m.route.opts.admin && (!who || who.role !== 'administrator')) {
            return { status: who ? 403 : 401, body: { code: who ? 'rest_forbidden' : 'rest_not_logged_in' }, route: m.route.path, host: true };
        }
        // The projection plugin-isolate.ts forwards (rebuilt per request).
        const fwdUser = who ? { id: who.id, role: who.role, userEmail: who.userEmail, userLogin: who.userLogin, hasProfessionalMailbox: false, ...(who as any).extra } : null;
        const req = {
            params: m.params, query: Object.fromEntries(new URLSearchParams(qs || '')),
            body: body === undefined ? {} : JSON.parse(JSON.stringify(body)),
            headers: {}, cookies: {}, user: fwdUser, method: method.toUpperCase(),
        };
        const res: any = {
            statusCode: 200, _body: undefined,
            status(c: number) { this.statusCode = c; return this; },
            json(b: any) { this._body = JSON.parse(JSON.stringify(b === undefined ? null : b)); return this; },
            send(b: any) { this._body = b; return this; },
            cookie() { return this; },
            clearCookie() { return this; },
            setHeader() { return this; },
        };
        try { await m.route.handler(req, res); }
        catch (e: any) { return { status: 'UNHANDLED', body: { error: String(e && e.message) }, route: m.route.path }; }
        return { status: res.statusCode, body: res._body, route: m.route.path };
    }

    return {
        raw, routes, menu, logs, sqlLog, call,
        reboot: init,
        addUser: (u: HarnessUser) => { usersState.directory.set(u.id, u); },
        setUsersGrant: (v: boolean) => { usersState.grant = !!v; },
        /** Direct SQL on the plugin's tables (test setup / assertions only). */
        q: (sql: string, ...params: any[]) => raw.prepare(sql).all(...params),
        one: (sql: string, ...params: any[]) => raw.prepare(sql).get(...params),
        exec: (sql: string, ...params: any[]) => raw.prepare(sql).run(...params),
    };
}

export type Plugin = Awaited<ReturnType<typeof bootPlugin>>;

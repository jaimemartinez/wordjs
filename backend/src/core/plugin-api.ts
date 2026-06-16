/**
 * WordJS - Plugin Capability Bridge (Phase 1 of the isolation proposal)
 *
 * A single, permission-checked facade that plugins use INSTEAD of require()ing core modules
 * directly. Today it runs in-process (a thin facade over the core modules); under the isolation
 * proposal the SAME surface is served over message-passing to an isolate, so plugin code never
 * touches raw fs/child_process/dbAsync/secrets. Adopting it now is non-breaking: it is passed as
 * the argument to a plugin's init(api) — existing plugins that ignore the arg keep working.
 *
 * Every method enforces the plugin's manifest permissions (via verifyPermission, which resolves
 * the effective plugin) and constrains arguments host-side (key allowlists, table scoping, path
 * confinement) — the plugin is untrusted input.
 *
 * See documentation/plugin-isolation-proposal.md.
 */

const path = require('path');
const fs = require('fs');
const { verifyPermission } = require('./plugin-context');

// Privileged capabilities (touch core DB tables, read/write secret-named options, provide mail) are
// gated on the OPERATOR-MAINTAINED trusted allowlist (config.trustedSystemPlugins) — NOT on a
// manifest permission, which a plugin self-declares and is therefore untrustworthy for this. An
// uploaded plugin can ask for `database:admin` all it wants; it still can't reach `users`/`options`.
function isTrustedPlugin(slug: string): boolean {
    try { return require('./plugin-trust').isTrusted(slug); } catch { return false; }
}

const ROOT_DIR = path.resolve(__dirname, '../../');
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');

// Option keys a plugin may never read/write through the bridge (secrets / security-critical).
// Deliberately broad (matches getProtectedEnv): the previous narrow list let an untrusted plugin
// read options like `stripe_key`, `api_key`, `*_credential`, `encryption_key`, certs, etc.
const PROTECTED_OPTION_RE = /secret|passw(or)?d|pwd|priv(ate)?[_-]?key|privatekey|dkim|\bkey\b|[_-]key\b|key$|api[_-]?key|token|\bsalt\b|jwt|credential|encryption|signing|certificate|\.pem|access[_-]?key/i;
// Core DB tables a plugin may never touch (mirrors the dbAsync scoping in secure-require).
const PROTECTED_TABLES = new Set(['users', 'user_meta', 'usermeta', 'options', 'user_roles', 'roles', 'sessions']);

// Reject any SQL that references a core table. Regex *structural* parsing of SQL is bypassable
// (comma joins `FROM a, users`, subqueries, and comment-as-whitespace `FROM/**/users` all slip a
// table past a `FROM <table>` matcher). So strip comments, then deny if a protected table name
// appears as a STANDALONE WORD anywhere in the statement — a conservative text denylist, not a
// parse. Over-blocks queries that merely mention a core-table name (acceptable: an untrusted plugin
// has no business naming core tables). Trusted plugins skip this entirely (see callers).
function assertSqlAllowed(sql: string) {
    const stripped = String(sql || '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* block comments */ (used as whitespace to evade)
        .replace(/--[^\n]*/g, ' ')           // -- line comments
        .toLowerCase();
    for (const t of PROTECTED_TABLES) {
        if (new RegExp(`\\b${t}\\b`).test(stripped)) {
            throw new Error(`🛡️ Plugin DB access denied: query references core table '${t}', which is off-limits to plugins.`);
        }
    }
}

// Confine a plugin-supplied relative path to its own dir or the uploads dir; realpath-checked.
function resolvePluginPath(slug: string, relPath: string, mustExist: boolean): string {
    const base = slug.startsWith('theme:') ? path.join(ROOT_DIR, 'themes', slug.slice(6)) : path.join(PLUGINS_DIR, slug);
    const candidate = path.resolve(base, String(relPath || ''));
    const real = (() => {
        try { return fs.realpathSync(candidate); } catch { return candidate; }
    })();
    const ok = (dir: string) => real === dir || real.startsWith(dir + path.sep);
    if (!ok(base) && !ok(UPLOADS_DIR)) {
        throw new Error(`🛡️ Plugin path denied: '${relPath}' is outside the plugin dir and uploads.`);
    }
    if (mustExist && !fs.existsSync(real)) throw new Error(`File not found: ${relPath}`);
    return real;
}

/**
 * Build the `wordjs` capability object for a plugin. `slug` is the plugin (or `theme:<slug>`).
 */
function createPluginApi(slug: string) {
    return {
        slug,

        options: {
            async get(key: string, def: any = null) {
                verifyPermission('settings', 'read');
                // Secret-named options are off-limits UNLESS the plugin is operator-trusted
                // (config.trustedSystemPlugins, e.g. mail-server reading its own DKIM private key).
                if (PROTECTED_OPTION_RE.test(String(key)) && !isTrustedPlugin(slug)) {
                    throw new Error(`🛡️ Option '${key}' is not readable by plugins.`);
                }
                const { getOption } = require('./options');
                return getOption(key, def);
            },
            async set(key: string, value: any) {
                verifyPermission('settings', 'write');
                if (PROTECTED_OPTION_RE.test(String(key)) && !isTrustedPlugin(slug)) {
                    throw new Error(`🛡️ Option '${key}' is not writable by plugins.`);
                }
                const { updateOption } = require('./options');
                return updateOption(key, value);
            }
        },

        db: {
            // Read-only query (SELECT). Table-scoped away from core tables — UNLESS the plugin is
            // operator-trusted (config.trustedSystemPlugins, e.g. db-migration), which lifts the
            // scoping so it can touch core tables. The isolate is still the boundary; host-enforced.
            async all(sql: string, params: any[] = []) {
                verifyPermission('database', 'read');
                if (!isTrustedPlugin(slug)) assertSqlAllowed(sql);
                const { dbAsync } = require('../config/database');
                return dbAsync.all(sql, params);
            },
            async get(sql: string, params: any[] = []) {
                verifyPermission('database', 'read');
                if (!isTrustedPlugin(slug)) assertSqlAllowed(sql);
                const { dbAsync } = require('../config/database');
                return dbAsync.get(sql, params);
            },
            // Mutating query (INSERT/UPDATE/DELETE/CREATE/ALTER). Scoped unless `database:admin`.
            async run(sql: string, params: any[] = []) {
                verifyPermission('database', 'write');
                if (!isTrustedPlugin(slug)) assertSqlAllowed(sql);
                const { dbAsync } = require('../config/database');
                return dbAsync.run(sql, params);
            },
            // Create a table (driver-agnostic). Core-table names are blocked unless `database:admin`.
            async createTable(name: string, columns: string[]) {
                verifyPermission('database', 'write');
                if (!isTrustedPlugin(slug) && PROTECTED_TABLES.has(String(name).toLowerCase())) {
                    throw new Error(`🛡️ Plugin DB access denied: '${name}' is a core table.`);
                }
                const { createPluginTable } = require('../config/database');
                return createPluginTable(name, columns);
            },
            // Which SQL dialect is active (so a plugin can branch on Postgres vs SQLite DDL).
            getType() {
                verifyPermission('database', 'read');
                const { getDbType } = require('../config/database');
                return getDbType();
            }
        },

        hooks: {
            addAction(hook: string, cb: (...a: any[]) => any, priority?: number) {
                const { addAction } = require('./hooks');
                return addAction(hook, cb, priority);
            },
            addFilter(hook: string, cb: (...a: any[]) => any, priority?: number) {
                const { addFilter } = require('./hooks');
                return addFilter(hook, cb, priority);
            },
            doAction(hook: string, ...args: any[]) {
                const { doAction } = require('./hooks');
                return doAction(hook, ...args);
            }
        },

        http: {
            // Register an Express route. Handlers run anchored in the plugin context (appRegistry
            // wraps the Router/app methods). Path is namespaced under the plugin to avoid collisions.
            route(method: string, routePath: string, ...handlers: any[]) {
                const { getApp } = require('./appRegistry');
                const app = getApp();
                if (!app) throw new Error('App not available');
                const m = String(method).toLowerCase();
                if (!['get', 'post', 'put', 'patch', 'delete', 'use'].includes(m)) throw new Error(`Bad method ${method}`);
                const full = `/api/v1/plugin/${slug.replace('theme:', 'theme-')}${routePath}`;
                return app[m](full, ...handlers);
            }
        },

        fs: {
            async read(relPath: string, encoding: BufferEncoding = 'utf8') {
                verifyPermission('filesystem', 'read');
                return fs.promises.readFile(resolvePluginPath(slug, relPath, true), encoding);
            },
            async write(relPath: string, data: any) {
                verifyPermission('filesystem', 'write');
                const target = resolvePluginPath(slug, relPath, false);
                if (path.basename(target).toLowerCase() === 'manifest.json') throw new Error('🛡️ manifest.json is immutable.');
                await fs.promises.mkdir(path.dirname(target), { recursive: true });
                return fs.promises.writeFile(target, data);
            }
        },

        async mail(msg: any) {
            verifyPermission('email', 'admin');
            const send = (global as any).wordjs_send_mail;
            if (typeof send !== 'function') throw new Error('Mail server not available');
            return send(msg);
        },

        // A mail-PROVIDER plugin (e.g. mail-server) registers the host-wide send function that
        // backs wordjs.mail / global.wordjs_send_mail. In-process this sets the global directly;
        // for isolated providers the worker bridge wires a shim that RPCs the provider's worker.
        provideMail(handler: (msg: any) => any) {
            verifyPermission('email', 'admin');
            (global as any).wordjs_send_mail = handler;
        },

        async notify(n: any) {
            verifyPermission('notifications', 'send');
            const notificationService = require('./notifications');
            return notificationService.send(n);
        },

        shortcodes: {
            // Register a shortcode. Handler may be async (rendered via doShortcodeAsync). In-process
            // here; for isolated plugins the worker bridge forwards it over RPC (see plugin-isolate).
            add(tag: string, handler: (attrs: any, content: string, tag: string) => any) {
                const { addShortcode } = require('./shortcodes');
                return addShortcode(tag, handler);
            }
        },

        adminMenu: {
            add(item: any) {
                const { registerAdminMenu } = require('./adminMenu');
                return registerAdminMenu(slug, item);
            }
        },

        cron: {
            schedule(timestamp: number, recurrence: string | false, hook: string, args: any[] = []) {
                const cron = require('./cron');
                return recurrence
                    ? cron.scheduleEvent(timestamp, recurrence, hook, args)
                    : cron.scheduleSingleEvent(timestamp, hook, args);
            }
        }
    };
}

module.exports = { createPluginApi };

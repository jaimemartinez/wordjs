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

const ROOT_DIR = path.resolve(__dirname, '../../');
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');

// Option keys a plugin may never read/write through the bridge (secrets / security-critical).
const PROTECTED_OPTION_RE = /secret|password|private_key|dkim_private|token|salt|jwt/i;
// Core DB tables a plugin may never touch (mirrors the dbAsync scoping in secure-require).
const PROTECTED_TABLES = new Set(['users', 'user_meta', 'usermeta', 'options', 'user_roles', 'roles', 'sessions']);

function extractSqlTables(sql: string): string[] {
    const out: string[] = [];
    const re = /\b(?:from|join|into|update|table(?:\s+if\s+not\s+exists)?)\s+["'`\[]?([a-z_][a-z0-9_]*)/gi;
    let m;
    while ((m = re.exec(String(sql || '')))) out.push(m[1].toLowerCase());
    return out;
}

function assertSqlAllowed(sql: string) {
    for (const t of extractSqlTables(sql)) {
        if (PROTECTED_TABLES.has(t)) {
            throw new Error(`🛡️ Plugin DB access denied: core table '${t}' is off-limits to plugins.`);
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
                if (PROTECTED_OPTION_RE.test(String(key))) throw new Error(`🛡️ Option '${key}' is not readable by plugins.`);
                const { getOption } = require('./options');
                return getOption(key, def);
            },
            async set(key: string, value: any) {
                verifyPermission('settings', 'write');
                if (PROTECTED_OPTION_RE.test(String(key))) throw new Error(`🛡️ Option '${key}' is not writable by plugins.`);
                const { updateOption } = require('./options');
                return updateOption(key, value);
            }
        },

        db: {
            // Read-only query (SELECT). Table-scoped away from core tables.
            async all(sql: string, params: any[] = []) {
                verifyPermission('database', 'read');
                assertSqlAllowed(sql);
                const { dbAsync } = require('../config/database');
                return dbAsync.all(sql, params);
            },
            async get(sql: string, params: any[] = []) {
                verifyPermission('database', 'read');
                assertSqlAllowed(sql);
                const { dbAsync } = require('../config/database');
                return dbAsync.get(sql, params);
            },
            // Mutating query (INSERT/UPDATE/DELETE/CREATE on the plugin's own tables).
            async run(sql: string, params: any[] = []) {
                verifyPermission('database', 'write');
                assertSqlAllowed(sql);
                const { dbAsync } = require('../config/database');
                return dbAsync.run(sql, params);
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

        async notify(n: any) {
            verifyPermission('notifications', 'send');
            const notificationService = require('./notifications');
            return notificationService.send(n);
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

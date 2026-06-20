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
// Security-critical option NAMES that PROTECTED_OPTION_RE misses (no secret-ish word) but control
// authorization / site integrity. Writing 'wordjs_user_roles' rewrites the role->capability map =
// full privilege escalation; 'active_plugins' enables/disables plugins; 'siteurl' can break the
// migration/host guard. Off-limits (read AND write) to untrusted plugins.
const PROTECTED_OPTION_NAMES = new Set([
    'wordjs_user_roles', 'user_roles', 'roles', 'active_plugins', 'default_role',
    'users_can_register', 'admin_email', 'siteurl', 'site_url', 'home',
    // 'trusted_plugins' drives the trust system — writing it self-promotes a plugin to the privileged
    // tier on next boot (full sandbox escape). Off-limits to untrusted plugins.
    'trusted_plugins', 'trusted_plugin', 'trustedsystemplugins'
]);
const isProtectedOption = (key: string, slug: string): boolean =>
    !isTrustedPlugin(slug) &&
    (PROTECTED_OPTION_RE.test(String(key)) || PROTECTED_OPTION_NAMES.has(String(key).toLowerCase()));

// Core DB tables a plugin may never touch (mirrors the dbAsync scoping in secure-require).
const PROTECTED_TABLES = new Set(['users', 'user_meta', 'usermeta', 'options', 'user_roles', 'roles', 'sessions']);

// Constrain untrusted-plugin SQL. Beyond the core-table denylist, REJECT dangerous constructs that a
// table-name denylist misses: ATTACH/DETACH (mounts arbitrary host files as a DB -> file read/write),
// PRAGMA (info disclosure / settings), schema catalogs (enumerate/read core schema), and stacked
// statements ('SELECT 1; DROP TABLE x'). Then require the statement to START with one of the caller's
// allowed verbs (positive allowlist). Comments are stripped first so they can't act as whitespace to
// evade. Trusted plugins skip this entirely (see callers).
function assertSqlAllowed(sql: string, allowedVerbs: string[], tablePrefix?: string) {
    const lower = String(sql || '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* block comments */ (used as whitespace to evade)
        .replace(/--[^\n]*/g, ' ')           // -- line comments
        .trim()
        .toLowerCase();

    if (/\battach\b/.test(lower) || /\bdetach\b/.test(lower) || /\bpragma\b/.test(lower)) {
        throw new Error(`🛡️ Plugin DB access denied: ATTACH/DETACH/PRAGMA are not permitted.`);
    }
    if (/\bsqlite_(master|schema|temp_master|temp_schema)\b/.test(lower) ||
        /\binformation_schema\b/.test(lower) || /\bpg_catalog\b/.test(lower)) {
        throw new Error(`🛡️ Plugin DB access denied: querying the schema catalog is not permitted.`);
    }
    // Single statement only — strip a single trailing ';' then reject any remaining one.
    if (lower.replace(/;\s*$/, '').includes(';')) {
        throw new Error(`🛡️ Plugin DB access denied: multiple statements are not permitted.`);
    }
    // Positive leading-verb allowlist (e.g. read = SELECT/WITH; write = INSERT/UPDATE/DELETE/...).
    const verb = (lower.match(/^([a-z]+)/) || [])[1] || '';
    if (allowedVerbs.length && !allowedVerbs.includes(verb)) {
        throw new Error(`🛡️ Plugin DB access denied: '${verb || '(empty)'}' statements are not permitted here.`);
    }
    // Core-table denylist (defense in depth alongside the prefix allowlist below).
    for (const t of PROTECTED_TABLES) {
        if (new RegExp(`\\b${t}\\b`).test(lower)) {
            throw new Error(`🛡️ Plugin DB access denied: query references core table '${t}', which is off-limits to plugins.`);
        }
    }
    // Allow-by-PREFIX (default-deny): every table the query touches must be one the plugin OWNS
    // (created via createTable under its wjp_<slug>_ prefix). This replaces the leaky denylist with
    // default-deny — a plugin can't read another plugin's tables (e.g. mail-server's received_emails)
    // or any core table, even one not in PROTECTED_TABLES.
    if (tablePrefix) {
        // Normalize SQL identifier delimiters — SQLite [brackets], plus "double" and `back` quotes — to
        // spaces so a delimiter-quoted name like [posts] / "posts" can't slip past attribution. (Leave
        // ' string literals alone.) Then every table-introducing keyword must be followed by a table
        // identifier OWNED by this plugin (prefixed); FAIL-CLOSED — an unattributable/non-prefixed token
        // is denied, not ignored.
        const norm = lower.replace(/[[\]"`]/g, ' ');
        if (/\bfrom\s+[a-z_][\w$.]*\s*,/.test(norm)) {
            throw new Error(`🛡️ Plugin DB access denied: comma joins are not permitted; use explicit JOIN.`);
        }
        const tableRe = /\b(?:from|join|into|update|table(?:\s+if\s+not\s+exists)?)\s+([^\s(;]+)/g;
        let m;
        while ((m = tableRe.exec(norm))) {
            const tok = m[1];
            // A subquery `FROM (SELECT ...)` puts '(' right after the keyword → no token captured here;
            // its inner FROM is matched separately. Any captured token must be a prefixed identifier.
            if (!/^[a-z_][a-z0-9_$.]*$/.test(tok) || !tok.startsWith(tablePrefix)) {
                throw new Error(`🛡️ Plugin DB access denied: table '${tok}' is not owned by this plugin — use the '${tablePrefix}' prefix (wordjs.db.tablePrefix).`);
            }
        }
        // INDEX DDL: CREATE [UNIQUE] INDEX <name> ON <table> (...) / DROP INDEX <name>. The generic
        // table matcher above misses the `ON <table>` target and the index name, so scope them too.
        if (/\bindex\b/.test(norm)) {
            const onTbl = norm.match(/\bon\s+([^\s(;]+)/);
            if (onTbl && (!/^[a-z_][a-z0-9_$.]*$/.test(onTbl[1]) || !onTbl[1].startsWith(tablePrefix))) {
                throw new Error(`🛡️ Plugin DB access denied: index target '${onTbl[1]}' is not owned by this plugin.`);
            }
            const idxName = norm.match(/\b(?:create(?:\s+unique)?\s+index|drop\s+index)(?:\s+if\s+(?:not\s+)?exists)?\s+([^\s(;]+)/);
            if (idxName && (!/^[a-z_][a-z0-9_$.]*$/.test(idxName[1]) || !idxName[1].startsWith(tablePrefix))) {
                throw new Error(`🛡️ Plugin DB access denied: index name '${idxName[1]}' must use the '${tablePrefix}' prefix.`);
            }
        }
    }
}

// Confine a plugin-supplied relative path to its own dir or the uploads dir; realpath-checked.
function resolvePluginPath(slug: string, relPath: string, mustExist: boolean, allowUploads = true): string {
    const base = slug.startsWith('theme:') ? path.join(ROOT_DIR, 'themes', slug.slice(6)) : path.join(PLUGINS_DIR, slug);
    const candidate = path.resolve(base, String(relPath || ''));
    const real = (() => {
        try { return fs.realpathSync(candidate); } catch { return candidate; }
    })();
    const ok = (dir: string) => real === dir || real.startsWith(dir + path.sep);
    if (!ok(base) && !(allowUploads && ok(UPLOADS_DIR))) {
        throw new Error(`🛡️ Plugin path denied: '${relPath}' is outside the plugin dir${allowUploads ? ' and uploads' : ''}.`);
    }
    if (mustExist && !fs.existsSync(real)) throw new Error(`File not found: ${relPath}`);
    return real;
}

/**
 * Build the `wordjs` capability object for a plugin. `slug` is the plugin (or `theme:<slug>`).
 */
function createPluginApi(slug: string) {
    // Per-plugin table namespace (like WordPress $wpdb->prefix). Untrusted plugins may only create
    // and query tables under this prefix (enforced in createTable + assertSqlAllowed).
    const tablePrefix = ('wjp_' + slug.replace(/[^A-Za-z0-9]+/g, '_') + '_').toLowerCase();
    return {
        slug,

        options: {
            async get(key: string, def: any = null) {
                verifyPermission('settings', 'read');
                // Secret-named options are off-limits UNLESS the plugin is operator-trusted
                // (config.trustedSystemPlugins, e.g. mail-server reading its own DKIM private key).
                if (isProtectedOption(key, slug)) {
                    throw new Error(`🛡️ Option '${key}' is not readable by plugins.`);
                }
                const { getOption } = require('./options');
                return getOption(key, def);
            },
            async set(key: string, value: any) {
                verifyPermission('settings', 'write');
                if (isProtectedOption(key, slug)) {
                    throw new Error(`🛡️ Option '${key}' is not writable by plugins.`);
                }
                const { updateOption } = require('./options');
                return updateOption(key, value);
            }
        },

        db: {
            // Per-plugin table prefix the plugin must use for its own tables (like $wpdb->prefix).
            tablePrefix,
            // Read-only query (SELECT). Table-scoped away from core tables — UNLESS the plugin is
            // operator-trusted (config.trustedSystemPlugins, e.g. db-migration), which lifts the
            // scoping so it can touch core tables. The isolate is still the boundary; host-enforced.
            async all(sql: string, params: any[] = []) {
                verifyPermission('database', 'read');
                if (!isTrustedPlugin(slug)) assertSqlAllowed(sql, ['select', 'with'], tablePrefix);
                const { dbAsync } = require('../config/database');
                return dbAsync.all(sql, params);
            },
            async get(sql: string, params: any[] = []) {
                verifyPermission('database', 'read');
                if (!isTrustedPlugin(slug)) assertSqlAllowed(sql, ['select', 'with'], tablePrefix);
                const { dbAsync } = require('../config/database');
                return dbAsync.get(sql, params);
            },
            // Mutating query (INSERT/UPDATE/DELETE/CREATE/ALTER). Scoped unless `database:admin`.
            async run(sql: string, params: any[] = []) {
                verifyPermission('database', 'write');
                if (!isTrustedPlugin(slug)) assertSqlAllowed(sql, ['insert', 'update', 'delete', 'create', 'alter', 'drop', 'replace'], tablePrefix);
                const { dbAsync } = require('../config/database');
                return dbAsync.run(sql, params);
            },
            // Create a table (driver-agnostic). Core-table names are blocked unless `database:admin`.
            async createTable(name: string, columns: string[]) {
                verifyPermission('database', 'write');
                if (!isTrustedPlugin(slug)) {
                    // Untrusted plugins may only create tables under their own prefix, so they can't
                    // create/shadow core or other plugins' tables and assertSqlAllowed can attribute
                    // their queries by prefix.
                    if (!String(name).toLowerCase().startsWith(tablePrefix)) {
                        throw new Error(`🛡️ Plugin tables must be named with the '${tablePrefix}' prefix (use wordjs.db.tablePrefix).`);
                    }
                } else if (PROTECTED_TABLES.has(String(name).toLowerCase())) {
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
                const hooksMod = require('./hooks');
                // Untrusted plugins may only fire their OWN registered callbacks (the same scoping cron
                // uses), never arbitrary CORE / other-plugin action handlers — so a plugin can't trigger
                // privileged core side effects with attacker-controlled args.
                if (!isTrustedPlugin(slug)) return hooksMod.doActionForPlugin(hook, slug, ...args);
                return hooksMod.doAction(hook, ...args);
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
                // Untrusted plugins write only inside their OWN dir — not the shared public uploads dir
                // (where an .html/.svg could be served to other users). Trusted plugins keep uploads.
                const target = resolvePluginPath(slug, relPath, false, isTrustedPlugin(slug));
                if (path.basename(target).toLowerCase() === 'manifest.json') throw new Error('🛡️ manifest.json is immutable.');
                // (#6) Bound disk use so a write-permitted plugin can't fill the host disk: reject an
                // oversized single write, and keep the plugin's OWN-dir footprint under a quota so repeated
                // small writes can't either. (Trusted writes to shared uploads keep only the per-write cap.)
                const SINGLE_WRITE_MAX = 16 * 1024 * 1024, PLUGIN_DISK_QUOTA = 100 * 1024 * 1024;
                let writeBytes: number;
                try { writeBytes = Buffer.byteLength(data); } catch { writeBytes = Buffer.byteLength(String(data ?? '')); }
                if (writeBytes > SINGLE_WRITE_MAX) throw new Error(`🛡️ write too large (${writeBytes} > ${SINGLE_WRITE_MAX} bytes).`);
                const baseDir = resolvePluginPath(slug, '.', false, false);
                if (target === baseDir || target.startsWith(baseDir + path.sep)) {
                    const du = async (dir: string, cap: number): Promise<number> => {
                        let total = 0; let entries: any[];
                        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
                        for (const e of entries) {
                            const p = path.join(dir, e.name);
                            try { total += e.isDirectory() ? await du(p, cap - total) : (await fs.promises.stat(p)).size; } catch { /* skip */ }
                            if (total >= cap) break; // early-exit once over budget
                        }
                        return total;
                    };
                    let existing = 0; try { existing = (await fs.promises.stat(target)).size; } catch { /* new file */ }
                    const used = await du(baseDir, PLUGIN_DISK_QUOTA + writeBytes);
                    if (used - existing + writeBytes > PLUGIN_DISK_QUOTA) throw new Error(`🛡️ plugin disk quota exceeded (${PLUGIN_DISK_QUOTA} bytes).`);
                }
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
            // Becoming the host-wide mail sender can intercept ALL outbound mail, so it is restricted
            // to operator-trusted plugins — mirror the register-mail-provider IPC handler. An untrusted
            // child can reach this method directly via a kind:'call' bridge message, bypassing that
            // handler's gate, so the trust check MUST be re-enforced here (not just at registration).
            if (!isTrustedPlugin(slug)) throw new Error('provideMail is restricted to operator-trusted plugins');
            verifyPermission('email', 'admin');
            if (typeof handler !== 'function') throw new Error('provideMail requires a function');
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

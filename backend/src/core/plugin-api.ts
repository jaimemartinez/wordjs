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

// NO plugin bypasses the sandbox anymore — there is no "trusted" tier. Every capability is gated by an
// admin GRANT (Android-style, default-deny). Privileged things that used to need trust are now either a
// SAFE host-mediated bridge (users projection, site info, mail provider) gated by a grant, or removed.
// Safe projection for the `users` bridge — NEVER includes user_pass / tokens / meta. Accepts either a
// core User instance (camelCase) or a raw row (snake_case).
function projectUser(u: any): any {
    if (!u) return null;
    return {
        id: u.id,
        userLogin: u.userLogin || u.user_login,
        username: u.userLogin || u.user_login,
        userEmail: u.userEmail || u.user_email,
        displayName: u.displayName || u.display_name,
        role: u.role,
    };
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
// Protected for EVERY plugin now (no trusted bypass). Secret/security-critical options are never
// readable/writable through the generic options bridge; safe non-secret reads go via the `site` bridge.
const isProtectedOption = (key: string, _slug?: string): boolean =>
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
    // File / extension / program SQL functions never belong in plugin SQL, and (taking no FROM) they
    // bypass the table-prefix attribution below. Inert on the default better-sqlite3 driver (no such
    // functions / load_extension SQL not authorized), but deny TEXTUALLY so a driver swap or an enabled
    // extension can never open a file-read / file-write / RCE channel from a scoped query.
    if (/\b(?:readfile|writefile|load_extension|fsdir|zipfile|sqlite3_\w+|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|dblink|dblink_exec)\s*\(/.test(lower)) {
        throw new Error(`🛡️ Plugin DB access denied: file/extension/program SQL functions are not permitted.`);
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
        // RETURNING is the scalar-exfil channel for a DELETE/UPDATE...USING that joins another table (and
        // an untrusted plugin gets inserted ids via lastID anyway) — deny it outright for untrusted SQL.
        if (/\breturning\b/.test(norm)) {
            throw new Error(`🛡️ Plugin DB access denied: RETURNING is not permitted; use a separate SELECT.`);
        }
        // Comma lists after FROM or USING are implicit cross-joins that smuggle a second table past the
        // single-token attribution below — require explicit JOIN instead.
        if (/\b(?:from|using)\s+[a-z_][\w$.]*\s*,/.test(norm)) {
            throw new Error(`🛡️ Plugin DB access denied: comma joins are not permitted; use explicit JOIN.`);
        }
        // Include USING (Postgres DELETE ... USING <table>) in the table-introducing keywords, else a
        // table referenced only there escapes the per-plugin prefix attribution.
        const tableRe = /\b(?:from|join|into|update|using|table(?:\s+if\s+not\s+exists)?)\s+([^\s(;]+)/g;
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
                // Secret-named options are off-limits to EVERY plugin (no trusted bypass). A plugin
                // keeps its own secrets in its own wjp_<slug>_ table; non-secret site info via `site`.
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
            // Read-only query (SELECT) — ALWAYS scoped to the plugin's own wjp_<slug>_ tables (no
            // trusted bypass exists anymore); core tables (users/options/…) are unreachable. For user
            // lookups use the safe `users` bridge (projection only, never user_pass).
            async all(sql: string, params: any[] = []) {
                verifyPermission('database', 'read');
                assertSqlAllowed(sql, ['select', 'with'], tablePrefix);
                const { dbAsync } = require('../config/database');
                return dbAsync.all(sql, params);
            },
            async get(sql: string, params: any[] = []) {
                verifyPermission('database', 'read');
                assertSqlAllowed(sql, ['select', 'with'], tablePrefix);
                const { dbAsync } = require('../config/database');
                return dbAsync.get(sql, params);
            },
            // Mutating query (INSERT/UPDATE/DELETE/CREATE/ALTER) — always scoped to own tables.
            async run(sql: string, params: any[] = []) {
                verifyPermission('database', 'write');
                assertSqlAllowed(sql, ['insert', 'update', 'delete', 'create', 'alter', 'drop', 'replace'], tablePrefix);
                const { dbAsync } = require('../config/database');
                return dbAsync.run(sql, params);
            },
            // Create a table — ALWAYS under the plugin's own prefix (no trusted bypass), so it can't
            // create or shadow core / other plugins' tables.
            async createTable(name: string, columns: string[]) {
                verifyPermission('database', 'write');
                if (!String(name).toLowerCase().startsWith(tablePrefix)) {
                    throw new Error(`🛡️ Plugin tables must be named with the '${tablePrefix}' prefix (use wordjs.db.tablePrefix).`);
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
                // A plugin may fire ONLY its OWN registered callbacks (no trusted bypass) — never
                // arbitrary core / other-plugin action handlers with attacker-controlled args.
                return hooksMod.doActionForPlugin(hook, slug, ...args);
            }
        },

        // Safe, read-only USER lookups (grant: users:read) — returns a PROJECTION only
        // (id/login/email/displayName/role), NEVER user_pass / tokens / meta. Replaces a plugin doing
        // raw `SELECT * FROM users` (which leaked password hashes). The host writes the query (core User
        // model); the plugin passes only a key/term.
        users: {
            async findByEmail(email: string) { verifyPermission('users', 'read'); return projectUser(await require('../models/User').findByEmail(email)); },
            async findByLogin(login: string) { verifyPermission('users', 'read'); return projectUser(await require('../models/User').findByLogin(login)); },
            async findById(id: any) { verifyPermission('users', 'read'); return projectUser(await require('../models/User').findById(id)); },
            async search(term: string, limit = 50) {
                verifyPermission('users', 'read');
                const list = await require('../models/User').findAll({ search: String(term || ''), limit: Math.min(Number(limit) || 50, 200) });
                return (Array.isArray(list) ? list : []).map(projectUser);
            },
        },

        // Non-secret site info (grant: settings:read). Avoids needing the (blocked) protected-option
        // reads of siteurl/home/admin_email; never exposes secrets.
        site: {
            async url() { verifyPermission('settings', 'read'); const { getOption } = require('./options'); return getOption('siteurl', await getOption('home', 'http://localhost')); },
            async domain() { verifyPermission('settings', 'read'); const { getOption } = require('./options'); try { return new URL(await getOption('siteurl', await getOption('home', 'http://localhost'))).hostname; } catch { return 'localhost'; } },
            async adminEmail() { verifyPermission('settings', 'read'); const { getOption } = require('./options'); return getOption('admin_email', ''); },
        },

        http: {
            // Register an Express route. Handlers run anchored in the plugin context (appRegistry
            // wraps the Router/app methods). Path is ALWAYS namespaced under the plugin (no absolute bypass).
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
                // Every plugin reads only inside its OWN dir — never the shared uploads dir (no trusted
                // bypass). Raw fs to a SAFE zone is governed separately by io-guard.
                return fs.promises.readFile(resolvePluginPath(slug, relPath, true, false), encoding);
            },
            async write(relPath: string, data: any) {
                verifyPermission('filesystem', 'write');
                // Every plugin writes only inside its OWN dir — never the shared public uploads dir
                // (where an .html/.svg could be served to other users). No trusted bypass.
                const target = resolvePluginPath(slug, relPath, false, false);
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
            // Becoming the host-wide mail sender intercepts ALL outbound mail, so it requires the
            // explicit `email:provider` grant (admin-approved, with a loud UI warning). No trusted
            // bypass — re-checked here AND at the register-mail-provider IPC handler.
            verifyPermission('email', 'provider');
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

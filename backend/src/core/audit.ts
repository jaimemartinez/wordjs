/**
 * WordJS — Append-only audit trail (FRENTE C-3).
 *
 * A thin, best-effort recorder for security-relevant mutations: who (actor), what (action), on what
 * (target type + id), when (created_at), and a small JSON `detail`. The table (audit_log, migration
 * 0009) is APPEND-ONLY for the application — no route updates or deletes a row, and the only reader is
 * the admin GET /api/v1/audit endpoint. The ONE writer that removes rows is the retention prune at the
 * bottom of this file: age-based, scheduled by core/cron, and never selective about WHAT it removes.
 *
 * TWO HARD RULES the callers rely on:
 *   1. NEVER block or fail the mutation. recordAudit swallows every error (log-and-continue): a broken
 *      audit insert must never turn a successful role change into a 500. It is a single INSERT.
 *   2. NEVER persist secret material. `detail` is sanitized here — any key that looks like a
 *      secret/password/token is dropped, and only scalars (or arrays of scalars) survive, so a caller
 *      can't accidentally smuggle a password/hash/token into the log through a nested object.
 */

const { dbAsync } = require('../config/database');
const log = require('./module-logger').moduleLogger('core/audit');

/**
 * THE ACTION CATALOGUE — one place where every action name in the product is written down.
 *
 * A log whose vocabulary is invented at each call site cannot be searched: `auth.login.failed` and
 * `auth.login.failure` are two different things to a `WHERE action = ?`, and nothing would have caught
 * the difference. Every name that has EVER been stored is here, spelled exactly as it was stored — this
 * catalogue does not rename anything, so an operator's saved query keeps working across the upgrade.
 *
 * Call sites still pass string literals (the routers reach this module through an untyped
 * `require(...)`, so a constant read through that path would be `any` and a typo would silently record
 * `undefined`). What holds the two halves together is a gate in src/tests/audit-trail.test.ts: it reads
 * the action literal out of every recordAudit() call in the backend source and fails when one is not in
 * this object. So the list below is a DERIVED-AND-CHECKED inventory, not a comment that hopes.
 */
const AUDIT_ACTIONS = Object.freeze({
    // ── Authentication / credentials ────────────────────────────────────────────────────────────────
    LOGIN_SUCCESS: 'auth.login.success',
    LOGIN_FAILURE: 'auth.login.failure',
    LOGOUT: 'auth.logout',
    // Multisite: a network administrator opened this site's admin through the audited handoff
    // (core/network-handoff): {networkAdmin, networkAdminId, from, ip, expiresAt}. The network's own log
    // records the same event (site.handoff.redeemed).
    NETWORK_HANDOFF: 'auth.network_handoff',
    // Multisite switched from the panel (routes/network.ts, core/network-setup): {admins, mfa} / {mfa}. The
    // network's own log records the same (network.enabled / network.disabled).
    NETWORK_ENABLE: 'network.enable',
    NETWORK_DISABLE: 'network.disable',
    // A network administrator added or removed from the panel: {login}. Also in the network's own log.
    NETWORK_ADMIN_ADD: 'network.admin.add',
    NETWORK_ADMIN_REMOVE: 'network.admin.remove',
    // Security → Server (routes/server-settings.ts): {fields, trustProxy?, logLevel?} — the reverse-proxy
    // trust and the log level, written to wordjs-config.json and applied by a restart.
    SERVER_SETTINGS_UPDATE: 'system.server.update',
    // Settings → Performance (routes/redis-settings.ts): {enabled, host, port, db, password: kept|changed|removed}
    // — the Redis server written to wordjs-config.json and applied by a restart. Never the password itself.
    REDIS_SETTINGS_UPDATE: 'system.redis.update',
    // Admin → Servers (routes/cluster.ts): a join token minted {role, host, expiresAt, mfa} (never the
    // token), every outstanding token revoked, a node taken out of the cluster {url, routes, mfa}, the
    // ports the gateway forwards to the backend node replaced.
    CLUSTER_TOKEN_CREATE: 'cluster.token.create',
    CLUSTER_TOKENS_REVOKE: 'cluster.tokens.revoke',
    CLUSTER_NODE_REMOVE: 'cluster.node.remove',
    CLUSTER_FORWARDS_SET: 'cluster.forwards.set',
    // Admin → Updates (core/updater): an update started from the panel {from, to}.
    SYSTEM_UPDATE_START: 'system.update.start',
    // A new password stored through a profile write (routes/users.ts PUT /users/me and PUT /users/:id).
    // Kept under `auth.` rather than as a `user.update` field, so "who changed whose password" is one query.
    PASSWORD_CHANGE: 'auth.password.change',
    PASSWORD_RESET: 'auth.password.reset',
    MFA_ENABLE: 'auth.mfa.enable',
    MFA_DISABLE: 'auth.mfa.disable',
    MFA_BACKUP_CODES: 'auth.mfa.backup_codes',
    // Which roles must have a second factor, the grace window, and whether API tokens are held to it.
    MFA_POLICY_UPDATE: 'auth.mfa.policy_update',
    TOKEN_CREATE: 'auth.token.create',
    // A mint refused because the step-up code a required-2FA role must present was wrong.
    TOKEN_CREATE_REFUSED: 'auth.token.create_refused',
    TOKEN_REVOKE: 'auth.token.revoke',

    // ── Users (already recorded before this batch — names preserved verbatim) ────────────────────────
    USER_CREATE: 'user.create',
    // A profile write: {fields} names what the request wrote (never values, never the password).
    USER_UPDATE: 'user.update',
    USER_DELETE: 'user.delete',
    // My Account (routes/users.ts): a new or removed profile picture, and a download of your own data.
    USER_AVATAR_UPDATE: 'user.avatar.update',
    USER_EXPORT: 'user.export',
    USER_ROLE_CHANGE: 'user.role_change',
    USER_SESSIONS_REVOKED: 'user.sessions_revoked',
    // An admin resetting SOMEONE ELSE's second factor. It lives under `user.` (not `auth.`) because
    // that is the name it has been storing since FRENTE C-3 — renaming it would break saved queries.
    USER_MFA_RESET: 'user.mfa_reset',

    // ── Content ─────────────────────────────────────────────────────────────────────────────────────
    POST_CREATE: 'post.create',
    POST_UPDATE: 'post.update',
    POST_PUBLISH: 'post.publish',
    POST_TRASH: 'post.trash',
    POST_RESTORE: 'post.restore',
    POST_DELETE: 'post.delete',
    // Comment moderation, one row per write naming the most specific transition ({from, to} statuses).
    COMMENT_UPDATE: 'comment.update',
    COMMENT_APPROVE: 'comment.approve',
    COMMENT_SPAM: 'comment.spam',
    COMMENT_TRASH: 'comment.trash',
    COMMENT_DELETE: 'comment.delete',
    // The media library (routes/media.ts).
    MEDIA_UPLOAD: 'media.upload',
    MEDIA_UPDATE: 'media.update',
    MEDIA_DELETE: 'media.delete',
    // An image rotated/flipped/cropped/scaled into a new file {rotate, flipH, flipV, crop, width}, and the
    // uploaded file made current again.
    MEDIA_EDIT: 'media.edit',
    MEDIA_RESTORE_ORIGINAL: 'media.restore_original',
    // Media-library folders (core/media-folders): created {parent}, renamed or moved {renamed, parent}, deleted
    // {moveTo, movedFiles, movedFolders}, and files moved into one {count} (the folder is the target id).
    MEDIA_FOLDER_CREATE: 'media.folder.create',
    MEDIA_FOLDER_UPDATE: 'media.folder.update',
    MEDIA_FOLDER_DELETE: 'media.folder.delete',
    MEDIA_MOVE: 'media.move',
    // Categories and tags ({taxonomy}).
    TERM_CREATE: 'term.create',
    TERM_UPDATE: 'term.update',
    TERM_DELETE: 'term.delete',
    // Navigation menus. Item and location changes are `menu.update` with a {change} naming which.
    MENU_CREATE: 'menu.create',
    MENU_UPDATE: 'menu.update',
    MENU_DELETE: 'menu.delete',

    // ── Backups (a restore is the most destructive operation the product offers) ─────────────────────
    BACKUP_CREATE: 'backup.create',
    BACKUP_RESTORE: 'backup.restore',
    BACKUP_DELETE: 'backup.delete',

    // ── Extensions ──────────────────────────────────────────────────────────────────────────────────
    MARKETPLACE_INSTALL: 'marketplace.install',
    MARKETPLACE_UPDATE: 'marketplace.update',
    // An installed plugin brought onto a catalog entry from another provenance (POST /marketplace/adopt):
    // {mode: adopt|reinstall, keepData, previousSource, newSource, previousGrants, grants}.
    MARKETPLACE_ADOPT: 'marketplace.adopt',
    // A plugin installed from an uploaded zip (the marketplace path records `marketplace.install`).
    PLUGIN_INSTALL: 'plugin.install',
    PLUGIN_UNINSTALL: 'plugin.uninstall',
    // An installed plugin's code replaced from an uploaded zip (POST /plugins/:slug/update).
    PLUGIN_UPDATE: 'plugin.update',
    PLUGIN_ACTIVATE: 'plugin.activate',
    PLUGIN_DEACTIVATE: 'plugin.deactivate',
    // An ORPHANED slug reclaimed: `active_plugins` named it while its files were not loadable, so the
    // stale entry was dropped and (only when the directory held no manifest and no entry file) its
    // residue removed. Recorded because it both changes the active list and deletes from disk.
    PLUGIN_ORPHAN_RECLAIM: 'plugin.orphan_reclaim',
    // An install whose administrator chose to DISCARD what a previous uninstall kept under the same slug
    // (existingData=discard): its data/ directory, wjp_<slug>_* tables, owned options and storage removed.
    PLUGIN_DISCARD_PREVIOUS_DATA: 'plugin.discard_previous_data',
    // An administrator approved (or withdrew) an exact private host:port a plugin may reach (a LAN SMTP
    // relay): {destinations} - the full approved list after the write.
    PLUGIN_PRIVATE_EGRESS: 'plugin.private_egress',
    THEME_ACTIVATE: 'theme.activate',
    // An installed theme replaced from an uploaded zip (POST /themes/:slug/update).
    THEME_UPDATE: 'theme.update',
    THEME_MODS_IMPORT: 'theme.mods.import',
    // An administrator granted or revoked a theme's functions.js permissions (activation dialog or
    // PUT /themes/:slug/permissions): {granted} - the full grant list after the write.
    THEME_PERMISSIONS: 'theme.permissions',

    // ── Configuration ───────────────────────────────────────────────────────────────────────────────
    SETTINGS_UPDATE: 'settings.update',
    // Where public media is stored (core/media-storage): {driver, bucket, endpoint, publicUrl,
    // keysRotated} - never a credential - and each offload/restore run that was started.
    MEDIA_STORAGE_UPDATE: 'media.storage.update',
    MEDIA_STORAGE_MIGRATE: 'media.storage.migrate',
    // The AI provider (core/ai-provider): {provider, model, baseUrlHost, previousProvider, keyChanged,
    // keyCleared}. Where the site's prompts — and its provider key — are sent is security-relevant on its
    // own; the key itself is never in the row.
    AI_SETTINGS_UPDATE: 'ai.settings.update',

    // ── The site's addresses (core/site-address) ─────────────────────────────────────────────────────
    // Each change of where the site lives is recorded with {from, to, added, removed, via, force, rev}
    // (and forcedPast when an override went past something): the main address is the base of every
    // emailed link, so a move is security-relevant on its own. One row per revision, the CLI's included.
    SITE_ADDRESS_CANONICAL: 'site.address.canonical',
    SITE_ADDRESS_ALIASES: 'site.address.aliases',
    SITE_ADDRESS_POLICY: 'site.address.policy',
    // An AUTOMATIC change: the same host moving http → https with the gateway, the repair of the old
    // `https,http://host` corruption. Separate from canonical so "which moves did a person make" is one query.
    SITE_ADDRESS_REPAIR: 'site.address.repair',
    SITE_ADDRESS_CONFLICT_RESOLVED: 'site.address.conflict_resolved',
    // Revisions `npm run site` wrote whose details the config's bounded change log no longer holds (more
    // changes than it keeps before the backend applied them — stopped, or a burst inside one watcher
    // tick): {from, to, revisions}, one row per run of consecutive revisions. Never silently skipped.
    SITE_ADDRESS_GAP: 'site.address.gap',

    // ── AI agent connections (models/AgentConnection, routes/agents, core/mcp-server) ──────────────
    // Every row of an agent's own trail is keyed target_type 'agent' / target_id <connection id>, so the
    // admin screen's "what did this agent do" is one indexed-by-PK walk with a WHERE on two columns.
    AGENT_CREATE: 'agent.create',
    AGENT_GRANT: 'agent.grant',
    AGENT_REVOKE: 'agent.revoke',
    // One row per agent tool call that WRITES (create/update draft, submit, publish, upload, term,
    // moderation), success or refusal, with {tool, objectType, objectId, status, ok}. The REST handler the
    // call ran through records its own row too (post.create, …) under the bound user.
    AGENT_WRITE: 'agent.write',
    // A tool call refused because the connection lacks the grant (or is still pending): {tool, needs}.
    AGENT_DENIED: 'agent.denied',
    // The site-wide "a person confirms what agents publish" switch changed: {publishConfirmation, previous}.
    AGENT_SETTINGS: 'agent.settings',
    // A person removed an agent's publish request from the queue (after publishing or returning it).
    AGENT_PUBLISH_REQUEST_DISMISS: 'agent.publish_request.dismiss',

    // ── Account email (routes/account-mail, core/account-mail) ─────────────────────────────────────
    // The built-in SMTP transport was configured or removed: {configured, host, passwordChanged} — never
    // the password. And a provider plugin was allowed / disallowed to carry reset links: {plugin, allowed}.
    ACCOUNT_MAIL_SMTP: 'account_mail.smtp',
    ACCOUNT_MAIL_PROVIDER: 'account_mail.provider',

    // ── Settings → Emails (routes/email-templates, core/email-templates) ─────────────────────────────
    // A message's words were edited or reset to the default: {template, lang} (never the text itself);
    // and the layout around every message was changed: {accentColor, backgroundColor, showLogo}.
    EMAIL_TEMPLATE_UPDATE: 'email_template.update',
    EMAIL_TEMPLATE_RESET: 'email_template.reset',
    EMAIL_LAYOUT_UPDATE: 'email_layout.update',

    // ── Admin → Site Health → Duplicate records (routes/database-integrity) ─────────────────────────
    // One duplicated value was resolved: {rule, keptId, changedIds, fields, reauth} — ids only, never the
    // logins, emails or slugs themselves.
    DATABASE_DUPLICATES_RESOLVE: 'database.duplicates.resolve',

    // ── The log about the log ───────────────────────────────────────────────────────────────────────
    AUDIT_PRUNE: 'audit.prune',
    // Admin → Audit settings changed (retention, external copy): {retentionDays, exportMode, reauth}.
    AUDIT_SETTINGS_UPDATE: 'audit.settings.update'
} as const);

type AuditAction = typeof AUDIT_ACTIONS[keyof typeof AUDIT_ACTIONS];

// Keys whose VALUES would be secrets — mirrors options.SECRET_OPTION_NAME_RE in spirit. Any detail key
// matching this is dropped WHOLE (we never store the value, and the key name itself signals intent).
const SECRET_KEY_RE = /secret|passw|priv[_-]?key|privatekey|\bkey\b|[_-]key\b|token|jwt|credential|encryption|dkim|\bsalt\b|api[_-]?key|signing|certificate|hash/i;

function isScalar(v: any): boolean {
    return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

// THE "SMALL" IN THE CONTRACT BELOW, AS NUMBERS.
//
// 'secret-free' and 'scalar-only' were enforced; 'small' was not. There was no bound on a string
// value, on an array's length or on the number of keys, so the size of an audit row rested on every
// call site remembering to bound its own strings — 33 call sites' discipline standing in for one
// function's guarantee, in the one table whose unbounded growth is why the retention prune below had
// to be written at all. These are that guarantee, and they hold for a call site that does not exist
// yet.
//
// OVERFLOW IS TRUNCATED AND SAYS SO. A value silently cut short reads as the whole value, which in a
// security log is worse than no value: the marker is what tells a reader they are looking at a
// fragment.
const MAX_DETAIL_STRING = 512;
const MAX_DETAIL_ARRAY = 32;
const MAX_DETAIL_KEYS = 32;
/** The one key sanitizeDetail adds itself, when it had to drop keys to stay inside MAX_DETAIL_KEYS. */
const TRUNCATED_KEYS_MARKER = '_truncated';

function boundString(v: string): string {
    return v.length <= MAX_DETAIL_STRING
        ? v
        : `${v.slice(0, MAX_DETAIL_STRING)}[+${v.length - MAX_DETAIL_STRING} chars]`;
}

function boundArray(v: any[]): any[] {
    const scalars = v.filter(isScalar).map((e: any) => (typeof e === 'string' ? boundString(e) : e));
    return scalars.length <= MAX_DETAIL_ARRAY
        ? scalars
        : scalars.slice(0, MAX_DETAIL_ARRAY).concat([`[+${scalars.length - MAX_DETAIL_ARRAY} more]`]);
}

/**
 * Reduce an arbitrary detail object to a SMALL, secret-free, scalar-only JSON-able map. Drops:
 *   - any key that looks like a secret (SECRET_KEY_RE),
 *   - any non-scalar value (nested objects — the classic place a secret hides),
 *   - array elements that are not scalars.
 * And BOUNDS what survives: every string to MAX_DETAIL_STRING characters, every array to
 * MAX_DETAIL_ARRAY elements, and the map itself to MAX_DETAIL_KEYS keys — plus, when anything had to
 * be dropped for the key cap, one `_truncated` marker saying how many.
 * A non-object input yields {}.
 */
function sanitizeDetail(detail: any): Record<string, any> {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {};
    const out: Record<string, any> = {};
    let droppedKeys = 0;
    for (const [k, v] of Object.entries(detail)) {
        if (SECRET_KEY_RE.test(k)) continue;                 // never store a secret-named field
        let value: any;
        if (isScalar(v)) {
            value = typeof v === 'string' ? boundString(v) : v;
        } else if (Array.isArray(v)) {                       // keep only scalar elements
            const arr = boundArray(v);
            if (!arr.length) continue;
            value = arr;
        } else {
            continue;  // Nested object / function / etc. — dropped (keeps the blob small and secret-safe).
        }
        // The cap counts only keys that SURVIVED the filters above, so a detail object padded with
        // secret-named or nested junk cannot push a real field out.
        if (!(k in out) && Object.keys(out).length >= MAX_DETAIL_KEYS) { droppedKeys++; continue; }
        out[k] = value;
    }
    if (droppedKeys) out[TRUNCATED_KEYS_MARKER] = `${droppedKeys} more key(s) dropped`;
    return out;
}

/**
 * IN-PROCESS OBSERVERS of recorded events — host-only, never the plugin hook bus. An audit row marks
 * the moment a mutation committed, with its actor and target, so it is the one seam that already covers
 * every lifecycle moment the product records; core/webhooks derives outgoing events from it instead of
 * scattering emit calls next to every recordAudit. An observer receives the SANITIZED detail (the same
 * secret-free, bounded object that is stored), runs after the mutation's transaction commits, and can
 * never affect the mutation: a throwing or rejecting observer is logged and ignored.
 */
type AuditEvent = { actorId: number | null; action: string; targetType: string; targetId: string; detail: Record<string, any> };
type AuditObserver = (event: AuditEvent) => any;
const _observers: AuditObserver[] = [];

/** Register an observer; returns a function that removes it. */
function onAuditRecorded(fn: AuditObserver): () => void {
    _observers.push(fn);
    return () => { const i = _observers.indexOf(fn); if (i !== -1) _observers.splice(i, 1); };
}

async function notifyObservers(event: AuditEvent): Promise<void> {
    for (const fn of _observers.slice()) {
        try { await fn(event); } catch (e: any) {
            log.warn(`[audit] observer failed for '${event.action}' (non-fatal): ${e && e.message}`);
        }
    }
}

/**
 * Record one audit event. Never throws.
 * @param actorId  acting user's id, or null/undefined for a system action.
 * @param action   one of AUDIT_ACTIONS, e.g. 'user.role_change', 'auth.login.failure'.
 * @param targetType  'user' | 'settings' | 'plugin' | 'theme' | 'post' | 'backup' | ...
 * @param targetId    the target's id or slug or option key (stringified).
 * @param detail   optional small object; sanitized before storage.
 */
async function recordAudit(actorId: any, action: AuditAction, targetType: string, targetId: any, detail?: any): Promise<void> {
    let event: AuditEvent | null = null;
    try {
        const actor = (actorId === null || actorId === undefined || actorId === '') ? null : Number(actorId);
        const clean = sanitizeDetail(detail);
        event = {
            actorId: Number.isFinite(actor) ? actor : null,
            action: String(action || ''),
            targetType: String(targetType || ''),
            targetId: targetId === null || targetId === undefined ? '' : String(targetId),
            detail: clean
        };
        await dbAsync.run(
            `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)`,
            [event.actorId, event.action, event.targetType, event.targetId, JSON.stringify(clean)]
        );
    } catch (e: any) {
        // Log-and-continue: the mutation already happened (or is about to answer) — auditing must not
        // change its outcome.
        log.warn({ action, err: e }, `[audit] failed to record '${action}'`);
    }
    // TAMPER EVIDENCE (core/audit-chain): the row gets its place in the hash chain once it is committed —
    // after COMMIT inside a transaction (a rolled-back row is never sealed), right away otherwise. Never
    // throws, and a failure only leaves the row pending for the next pass.
    if (event) {
        const seal = () => require('./audit-chain').sealPending();
        let deferred = false;
        try { deferred = require('../config/database').afterCommit(seal); } catch { /* bootstrapping */ }
        if (!deferred) await seal();
    }
    // The mutation happened whether or not its row could be written, so observers hear about it either
    // way. Inside a pinned transaction they run only after COMMIT (the same rule as hooks.doAction): an
    // outgoing webhook must never announce a write that is then rolled back.
    if (!event || !_observers.length) return;
    const ev = event;
    try {
        const database = require('../config/database');
        if (database.afterCommit(() => notifyObservers(ev))) return;
    } catch { /* database still bootstrapping — notify immediately */ }
    await notifyObservers(ev);
}

/**
 * Read a page of the audit log, newest-first. Admin-only at the route layer.
 * @returns { rows, total, limit, offset }
 */
async function listAudit(opts: { limit?: any; offset?: any } = {}): Promise<any> {
    const limit = Math.min(Math.max(parseInt(String(opts.limit), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(opts.offset), 10) || 0, 0);
    const rows = (await dbAsync.all(
        `SELECT id, actor_id, action, target_type, target_id, detail, created_at
         FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`,
        [limit, offset]
    )) || [];
    const totalRow = await dbAsync.get(`SELECT COUNT(*) AS c FROM audit_log`);
    const total = totalRow ? Number(totalRow.c) || 0 : 0;
    return {
        rows: rows.map((r: any) => ({
            id: r.id,
            actorId: r.actor_id,
            action: r.action,
            targetType: r.target_type,
            targetId: r.target_id,
            detail: safeParse(r.detail),
            createdAt: r.created_at
        })),
        total,
        limit,
        offset
    };
}

/**
 * The trail of ONE target (e.g. an agent connection), newest first. Admin-only at the route layer.
 */
async function listAuditForTarget(targetType: string, targetId: any, opts: { limit?: any; offset?: any } = {}): Promise<any> {
    const limit = Math.min(Math.max(parseInt(String(opts.limit), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(opts.offset), 10) || 0, 0);
    const tid = targetId === null || targetId === undefined ? '' : String(targetId);
    const rows = (await dbAsync.all(
        `SELECT id, actor_id, action, target_type, target_id, detail, created_at
         FROM audit_log WHERE target_type = ? AND target_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
        [String(targetType), tid, limit, offset]
    )) || [];
    const totalRow = await dbAsync.get(
        `SELECT COUNT(*) AS c FROM audit_log WHERE target_type = ? AND target_id = ?`, [String(targetType), tid]
    );
    return {
        rows: rows.map((r: any) => ({
            id: r.id,
            actorId: r.actor_id,
            action: r.action,
            targetType: r.target_type,
            targetId: r.target_id,
            detail: safeParse(r.detail),
            createdAt: r.created_at
        })),
        total: totalRow ? Number(totalRow.c) || 0 : 0,
        limit,
        offset
    };
}

function safeParse(s: any): any {
    if (!s) return {};
    try { return JSON.parse(String(s)); } catch { return {}; }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// RETENTION
//
// Nothing in the product had ever deleted an audit row, and this batch multiplies the write rate by an
// order of magnitude: every login attempt — including the failed ones an attacker generates for free —
// now lands here. "Append-only" describes the ABSENCE OF TAMPERING, not an obligation to keep a failed
// login from 2021 until the disk fills; a table that only grows, fed by an unauthenticated surface, is
// a full disk with a date on it (the same finding core/analytics-retention closed for wordjs_analytics).
//
// So the log gets an age: rows older than `audit_retention_days` (default 365; 0 = keep for ever) go,
// once a day, driven by core/cron — which already runs its tick under a distributed leader lease, so on
// N nodes the prune executes on exactly one of them per tick.
//
// TWO DETAILS THAT ARE NOT DECORATION:
//   · The cutoff is rendered and the reference instant is read THROUGH core/analytics-retention's
//     helpers rather than re-derived here. Both halves of that comparison — 'YYYY-MM-DD HH:MM:SS'
//     against a CURRENT_TIMESTAMP-stamped column, in the DATABASE's clock frame — were real bugs there
//     (an ISO 'T' sorts after a space; a non-UTC server shifts the window by hours). Deriving a second
//     copy of that reasoning is how the two would drift apart.
//   · The delete walks the PRIMARY KEY, not `created_at` (which carries no index, and adding one means
//     a migration). The table is append-only, so id order IS insertion order: the oldest rows are the
//     lowest ids, the bounded subselect stops as soon as it leaves the window, and the form is portable
//     (Postgres has no DELETE ... LIMIT).
// ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Cron hook the prune is registered under (see core/cron.initDefaultCronEvents). */
const AUDIT_PRUNE_HOOK = 'wordjs_audit_prune';
/** A year of history by default — long enough to investigate an incident nobody noticed for months. */
const DEFAULT_AUDIT_RETENTION_DAYS = 365;
/** The shortest window the prune ever uses, whatever is stored (the panel offers 90, 180, 365, 730 or 0). */
const MIN_AUDIT_RETENTION_DAYS = 90;
const AUDIT_RETENTION_CHOICES = [0, 90, 180, 365, 730];
/** Rows removed per statement: bounded so a long-neglected table drains over several passes instead of
 *  one transaction that holds SQLite's global write lock. */
const PRUNE_BATCH = 1000;
/** …and a ceiling per run, so a first prune over years of rows never monopolises the database. */
const PRUNE_MAX_ROWS_PER_RUN = 200_000;
const PRUNE_MAX_RUN_MS = 30_000;

/**
 * Last prune outcome. `behind` means the run hit a cap with rows still outside the window, i.e.
 * retention is losing the race against the write side — the one value here that is a call to action.
 * `retentionDays` is the window the LAST run actually used (null before the first run of this
 * process), not what the option says now: the two differ exactly when an operator has just changed it.
 * Read by routes/health.ts, which reports it next to the other degradations an operator would
 * otherwise only meet as a console line on a boot nobody watches.
 */
let pruneState: {
    lastRunAt: number | null;
    lastRemoved: number;
    behind: boolean;
    lastError: string | null;
    retentionDays: number | null;
} = {
    lastRunAt: null, lastRemoved: 0, behind: false, lastError: null, retentionDays: null
};

/** Configured retention in days, or 0 when the operator has switched pruning off. */
async function auditRetentionDays(): Promise<number> {
    const { getOption } = require('./options');
    const raw = await getOption('audit_retention_days', DEFAULT_AUDIT_RETENTION_DAYS);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_AUDIT_RETENTION_DAYS;
    // A value written around the screen (a raw option write, an old import) can never make the prune
    // erase recent evidence: anything between 0 and the floor counts as the floor.
    if (n > 0 && n < MIN_AUDIT_RETENTION_DAYS) return MIN_AUDIT_RETENTION_DAYS;
    return Math.floor(n);
}

/** Does going from `fromDays` to `toDays` keep LESS history than before? (0 = for ever.) */
function retentionShortens(fromDays: number, toDays: number): boolean {
    if (toDays === 0) return false;
    if (fromDays === 0) return true;
    return toDays < fromDays;
}

/**
 * Delete audit rows older than the configured retention. Returns how many were removed.
 * Exported so the test drives it against a real table instead of asserting on a fixture.
 *
 * @param now     TEST SEAM ONLY. Production passes nothing and takes the database's own clock.
 * @param limits  TEST SEAM ONLY. Production uses the module constants above.
 */
async function pruneAuditLog(
    now: number | null = null,
    limits: { batch?: number; maxRows?: number; maxMs?: number } = {}
): Promise<number> {
    const batch = limits.batch || PRUNE_BATCH;
    const maxRows = limits.maxRows || PRUNE_MAX_ROWS_PER_RUN;
    const maxMs = limits.maxMs || PRUNE_MAX_RUN_MS;
    const startedAt = Date.now();

    const days = await auditRetentionDays();
    if (days <= 0) {
        pruneState = { ...pruneState, lastRunAt: startedAt, lastRemoved: 0, behind: false, retentionDays: days };
        return 0;
    }

    // One implementation of "the cutoff, in the producer's format and the producer's clock frame".
    const { dbTimestamp, databaseNowMs } = require('./analytics-retention');
    const reference = typeof now === 'number' ? now : await databaseNowMs(Date.now());
    const cutoff = dbTimestamp(reference - days * 86400000);

    // The prune keeps the hash chain verifiable (core/audit-chain): BEFORE it deletes a batch it records
    // the hash of each removed row whose successor stays, so the gaps it leaves are accounted for and
    // any other gap is not. Rows not sealed yet are sealed first: an unsealed row is never removed.
    const chain = require('./audit-chain');
    await chain.sealPending();

    let removed = 0;
    let cappedOut = false;
    for (;;) {
        const room = maxRows - removed;
        if (room <= 0) { cappedOut = true; break; }
        if (Date.now() - startedAt > maxMs) { cappedOut = true; break; }
        const want = Math.min(batch, room);
        const doomed = await chain.prunableRows(cutoff, want);
        if (!doomed || doomed.length === 0) break;
        if (!(await chain.recordRemoval(doomed))) { cappedOut = true; break; }
        const placeholders = doomed.map(() => '?').join(',');
        await dbAsync.run(`DELETE FROM audit_log WHERE id IN (${placeholders})`, doomed.map((r: any) => r.id));
        removed += doomed.length;
        if (doomed.length < want) break;   // the window is drained
    }

    // Stopping at a cap is not finishing: ask the table whether anything outside the window survived.
    if (cappedOut) {
        const leftover = await chain.prunableRows(cutoff, 1);
        cappedOut = !!(leftover && leftover.length);
    }

    pruneState = { lastRunAt: Date.now(), lastRemoved: removed, behind: cappedOut, lastError: null, retentionDays: days };
    return removed;
}

/** What the last prune did — for the cron log and for anyone asking whether retention is keeping up. */
function auditRetentionState() {
    return { ...pruneState };
}

/**
 * The cron handler, as a plain function so core/cron can register it and a test can call it.
 * Never throws: a failing prune must not abort the cron tick that also runs the backup.
 */
async function runAuditRetention(): Promise<number> {
    try {
        const removed = await pruneAuditLog();
        if (removed > 0) {
            log.info({ removed }, `⏰ audit: pruned ${removed} row(s) past the retention window`);
            // The prune is the ONE thing that removes evidence, so it leaves evidence of itself: an
            // operator reading a thin log must be able to tell "nothing happened" from "it was pruned".
            const anchor = await require('./audit-chain').readAnchor();
            await recordAudit(null, AUDIT_ACTIONS.AUDIT_PRUNE, 'audit_log', '', {
                removed, retentionDays: await auditRetentionDays(), throughSeq: anchor.seq
            });
        }
        if (pruneState.behind) {
            log.warn(`⚠️  audit retention is BEHIND: ${removed} row(s) removed and the table still holds rows ` +
                'outside the window. Lower audit_retention_days or run the prune more often.');
        }
        return removed;
    } catch (e: any) {
        pruneState = { ...pruneState, lastRunAt: Date.now(), lastError: String(e && e.message) };
        log.error({ err: e }, 'Audit retention prune failed');
        return 0;
    }
}

module.exports = {
    recordAudit, listAudit, listAuditForTarget, sanitizeDetail, onAuditRecorded,
    AUDIT_ACTIONS,
    pruneAuditLog, runAuditRetention, auditRetentionState, auditRetentionDays,
    AUDIT_PRUNE_HOOK, DEFAULT_AUDIT_RETENTION_DAYS, MIN_AUDIT_RETENTION_DAYS, AUDIT_RETENTION_CHOICES, retentionShortens,
    MAX_DETAIL_STRING, MAX_DETAIL_ARRAY, MAX_DETAIL_KEYS
};

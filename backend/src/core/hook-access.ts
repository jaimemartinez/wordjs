/**
 * WordJS - Plugin hook access policy (which core hooks a sandboxed plugin may subscribe to, and what it sees)
 *
 * THE CLASS THIS CLOSES. A plugin subscribes to a hook with `wordjs.hooks.addAction/addFilter`; the
 * host installs a shim that serializes the hook's ARGUMENTS into the plugin's child process. Hook
 * registration used to be gated only by count caps and a raw-HTML denylist, so a plugin with ZERO
 * grants could subscribe to any core hook and receive whatever core passed: every commenter's email
 * and IP (`wp_insert_comment`), the full content of every notification (`notification_sent`), the
 * body of every draft / private / password-protected post (`wp_insert_post`, `post_updated`). A hook
 * subscription is a READ of the data the hook carries, so it is gated by the same DATA grant the
 * plugin would need to read that data any other way, and the payload is minimized at the boundary.
 *
 * The rules, all enforced HOST-SIDE (never trusting the child):
 *
 *   1. Every hook core fires is classified in CORE_HOOK_POLICY below — ONE table, reviewed together.
 *      `public`  carries no third-party data: any plugin may subscribe.
 *      `data`    carries other parties' data: subscribing requires every grant in `requires`, and the
 *                arguments go through `sanitize` before they are serialized to the plugin.
 *      `denied`  no plugin may subscribe (raw-HTML output, host-only maintenance / request internals).
 *   2. A hook name that is NOT in the table and does not look like a core name is the plugin's OWN hook
 *      (fired by its own `wordjs.hooks.doAction`, which reaches only its own callbacks, or its own cron
 *      events): allowed, because core never fires it. That "core never fires an unclassified name" is
 *      enforced by tests/plugin-hook-privacy.test.ts, which scans every doAction/applyFilters call site
 *      in backend/src and fails the build on a core hook missing from this table.
 *   3. An unclassified name in a core namespace (RESERVED_CORE_HOOK_RE: `wp_*`, `wordjs_*`, `core:*`,
 *      `comments:*`, …) is DENIED — default-deny for a core hook added before anyone classified it.
 *   4. Registration is checked when the plugin registers (plugin-isolate's `register` IPC handler and the
 *      in-process bridge) AND re-checked on every delivery (the shim), so a revoked grant stops the flow
 *      immediately and the sanitizer always runs, whichever path fired the hook.
 *
 * Secrets never travel through a hook payload to a plugin, whatever its grants: password-protected post
 * passwords, notification tokens / codes / reset links, secret or protected option values. Commenter
 * email, IP and user agent are personal data, delivered only with the explicit `comments:pii` grant
 * (never implied by any other grant) — the anti-spam extension point (`comments:pre_insert`) is the use
 * that needs them; everything else gets the comment without them.
 */

type Grant = readonly [scope: string, access: string];

interface HookPolicy {
    kind: 'public' | 'data' | 'denied';
    /** For `data`: grants that must ALL be held to subscribe. */
    requires?: readonly Grant[];
    /** Why the hook is classified this way (shown in the refusal and kept next to the rule). */
    why: string;
    /** For `data`: returns the arguments a plugin may see (a COPY — never mutates the caller's values). */
    sanitize?: (slug: string, args: any[]) => any[];
}

const REDACTED = '[redacted]';

function granted(slug: string, scope: string, access: string): boolean {
    try { return require('./plugin-permissions').isGranted(slug, scope, access) === true; } catch { return false; }
}

// Key names whose VALUES are secrets wherever they appear in a payload (tokens, codes, passwords, keys,
// signed links). Deliberately broader than the option-name rule: a notification's `data` is free-form.
const SECRET_KEY_RE = /secret|passw|token|jwt|credential|api[_-]?key|private[_-]?key|^key$|[_-]key$|salt|signature|signing|nonce|otp|^pin$|(?:^|[_-])code$|^code|hash$|reset|verif|magic|session|cookie|^authorization$/i;

/** Deep copy of a JSON-ish value with every secret-named key's value replaced by '[redacted]'. */
function redactSecretKeys(value: any, depth = 0): any {
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => redactSecretKeys(v, depth + 1));
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) {
        out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactSecretKeys(value[k], depth + 1);
    }
    return out;
}

// Notification types whose human text / link IS the secret (reset or verification codes, magic links).
const SENSITIVE_NOTIFICATION_TYPE_RE = /passw|reset|verif|otp|mfa|2fa|two[_-]?factor|magic|login[_-]?(?:code|link)|token|secret|confirm/i;

/** Strip secret-named query parameters (and any fragment) from a link. Keeps relative links relative. */
function redactLink(url: any): any {
    if (typeof url !== 'string' || !url) return url;
    const hashAt = url.indexOf('#');
    const noHash = hashAt === -1 ? url : url.slice(0, hashAt);
    const q = noHash.indexOf('?');
    if (q === -1) return noHash;
    const params = noHash.slice(q + 1).split('&').map((pair) => {
        const eq = pair.indexOf('=');
        const key = decodeURIComponentSafe(eq === -1 ? pair : pair.slice(0, eq));
        return SECRET_KEY_RE.test(key) ? `${eq === -1 ? pair : pair.slice(0, eq)}=${REDACTED}` : pair;
    });
    return `${noHash.slice(0, q)}?${params.join('&')}`;
}
function decodeURIComponentSafe(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

/**
 * The notification as a hook may carry it: secret-named `data` keys redacted, secret query parameters
 * stripped from the link, and for a sensitive TYPE (password reset, verification, OTP, magic link) the
 * message and link withheld entirely — their text is the secret. Used at the source (notifications.ts,
 * like options.ts redacts `updated_option`) and again at the plugin boundary (idempotent).
 */
function redactNotificationForHook(n: any): any {
    if (!n || typeof n !== 'object') return n;
    const sensitive = SENSITIVE_NOTIFICATION_TYPE_RE.test(String(n.type || ''));
    const out: any = { ...n };
    out.data = redactSecretKeys(n.data);
    out.action_url = sensitive && n.action_url ? REDACTED : redactLink(n.action_url);
    if (sensitive) out.message = REDACTED;
    return out;
}

/** A comment as a plugin may see it: personal data (email, IP, user agent) only with `comments:pii`. */
function projectComment(slug: string, c: any): any {
    if (!c || typeof c !== 'object') return c;
    const out: any = { ...c };
    if (!granted(slug, 'comments', 'pii')) {
        delete out.authorEmail;
        delete out.authorIp;
        delete out.agent;
    }
    return out;
}

/** Post data as a plugin may see it: never the post password (or any other secret-named field). */
function projectPostData(data: any): any {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const out: any = {};
    for (const k of Object.keys(data)) {
        if (/passw|secret|token/i.test(k)) continue;
        out[k] = data[k];
    }
    return out;
}

function optionValueForPlugin(slug: string, name: any, value: any): any {
    const n = String(name);
    let isProtected = true; // fail closed if the checker can't be loaded
    try { isProtected = require('./plugin-api').isProtectedOption(n, slug) === true; } catch { /* closed */ }
    // The source already redacts secret-named values (options.ts, audit F-02); protected options (grants,
    // roles, active plugins, site address, …) are equally unreadable through options.get, so the hook
    // must not hand them out either.
    return isProtected ? REDACTED : value;
}

const PUBLIC = (why: string): HookPolicy => ({ kind: 'public', why });
const DENIED = (why: string): HookPolicy => ({ kind: 'denied', why });

const RAW_HTML = DENIED('its filtered value is emitted as raw, unescaped HTML (stored-XSS primitive)');
const HOST_MAINTENANCE = DENIED('host-only maintenance hook; plugins schedule their own cron events');

const COMMENT_HOOK_ARGS = (slug: string, [id, data, ...rest]: any[]) => [id, projectComment(slug, data), ...rest];

/**
 * EVERY hook core fires (doAction / applyFilters / doActionSync / applyFiltersSync in backend/src),
 * classified by the data it exposes. Adding a core hook means adding it HERE — the completeness test
 * fails otherwise. Null prototype: a hook named `constructor` / `__proto__` can never match an entry.
 */
const POLICY_TABLE: Record<string, HookPolicy> = {
    // ── public: no third-party data ──────────────────────────────────────────────────────────────
    'init': PUBLIC('fired once at boot with no arguments'),
    'activated_plugin': PUBLIC('carries only a plugin slug'),
    'deactivated_plugin': PUBLIC('carries only a plugin slug'),
    'switch_theme': PUBLIC('carries only theme slugs'),
    'registered_content_type_schema': PUBLIC('carries a public content-type schema'),
    'registered_post_type': PUBLIC('carries a public post-type definition'),
    'registered_taxonomy': PUBLIC('carries a public taxonomy definition'),

    // ── data: other parties' data, gated on the matching read grant and minimized ──────────────────
    'updated_option': {
        kind: 'data', requires: [['settings', 'read']],
        why: 'carries site option values',
        sanitize: (slug, [name, value, ...rest]) => [name, optionValueForPlugin(slug, name, value), ...rest],
    },
    'wp_insert_post': {
        kind: 'data', requires: [['posts', 'read']],
        why: 'carries post content, including drafts and private posts',
        sanitize: (_slug, [id, data, ...rest]) => [id, projectPostData(data), ...rest],
    },
    'post_updated': {
        kind: 'data', requires: [['posts', 'read']],
        why: 'carries post content, including drafts and private posts',
        sanitize: (_slug, [id, data, ...rest]) => [id, projectPostData(data), ...rest],
    },
    'deleted_post': {
        kind: 'data', requires: [['posts', 'read']],
        why: 'reveals which posts (including unpublished ones) exist and are deleted',
        sanitize: (_slug, args) => args.slice(),
    },
    'wp_insert_comment': {
        kind: 'data', requires: [['comments', 'read']],
        why: 'carries every new comment, including unapproved ones and the commenter\'s personal data',
        sanitize: COMMENT_HOOK_ARGS,
    },
    'deleted_comment': {
        kind: 'data', requires: [['comments', 'read']],
        why: 'reveals comment moderation activity',
        sanitize: (_slug, args) => args.slice(),
    },
    'comments:pre_insert': {
        kind: 'data', requires: [['comments', 'read']],
        why: 'carries every comment about to be written, with the commenter\'s personal data',
        // filter: args[0] is the verdict (true) and is passed through untouched; args[1] is the comment.
        sanitize: COMMENT_HOOK_ARGS,
    },
    'notification_sent': {
        kind: 'data', requires: [['notifications', 'read']],
        why: 'carries every in-app notification sent to any user',
        sanitize: (_slug, [n, ...rest]) => [redactNotificationForHook(n), ...rest],
    },

    // ── denied: no plugin, whatever its grants ───────────────────────────────────────────────────
    'wordjs_head': RAW_HTML,
    'wordjs_footer': RAW_HTML,
    'wp_head': RAW_HTML,
    'wp_footer': RAW_HTML,
    // renderSidebar's result is served as text/html by GET /widgets/sidebars/:id/render.
    'dynamic_sidebar': RAW_HTML,
    'admin_menu_items': DENIED('host-only synchronous filter carrying the requesting user'),
    'publish_future_post': HOST_MAINTENANCE,
    'wordjs_scheduled_backup': HOST_MAINTENANCE,
    'wordjs_version_check': HOST_MAINTENANCE,
    'wordjs_db_maintenance': HOST_MAINTENANCE,
    'wordjs_cert_renewal': HOST_MAINTENANCE,
    'wordjs_collab_sweep': HOST_MAINTENANCE,
    'wordjs_audit_prune': HOST_MAINTENANCE,
    'wordjs_analytics_prune': HOST_MAINTENANCE,
};
const CORE_HOOK_POLICY: Readonly<Record<string, HookPolicy>> =
    Object.freeze(Object.assign(Object.create(null) as Record<string, HookPolicy>, POLICY_TABLE));

/** Hook names in a core namespace. Unclassified ones are denied (a core hook nobody classified yet). */
const RESERVED_CORE_HOOK_RE = /^(?:wp_|wordjs_|core[:_.]|(?:comments?|posts?|users?|options?|notifications?|media|auth|mfa|plugins?|themes?|site|settings|mail|email)[:.])/i;

/** The raw-HTML output hooks (kept as a named set for callers/tests that reason about XSS specifically). */
const RAW_HTML_HOOKS: ReadonlySet<string> = new Set(
    Object.keys(CORE_HOOK_POLICY).filter(h => CORE_HOOK_POLICY[h] === RAW_HTML));

function getHookPolicy(hook: string): HookPolicy | null {
    return Object.prototype.hasOwnProperty.call(CORE_HOOK_POLICY, hook) ? CORE_HOOK_POLICY[hook] : null;
}

type Decision = { ok: true } | { ok: false; reason: string };

/** May `slug` subscribe to `hook` right now? Pure decision; callers log / throw. */
function checkHookSubscription(slug: string, hook: unknown): Decision {
    if (typeof hook !== 'string' || !hook || hook.length > 200) {
        return { ok: false, reason: 'invalid hook name' };
    }
    const policy = getHookPolicy(hook);
    if (!policy) {
        if (RESERVED_CORE_HOOK_RE.test(hook)) {
            return { ok: false, reason: `'${hook}' is in a reserved core namespace and is not an approved plugin hook` };
        }
        return { ok: true }; // the plugin's own hook — core never fires an unclassified name
    }
    if (policy.kind === 'public') return { ok: true };
    if (policy.kind === 'denied') return { ok: false, reason: `'${hook}' is not available to plugins (${policy.why})` };
    const missing = (policy.requires || []).filter(([s, a]) => !granted(slug, s, a)).map(([s, a]) => `${s}:${a}`);
    if (missing.length) {
        return { ok: false, reason: `'${hook}' ${policy.why}; it requires the ${missing.join(' + ')} permission` };
    }
    return { ok: true };
}

/** Throwing form, for the in-process bridge (plugin-api hooks.addAction/addFilter). */
function assertHookSubscribable(slug: string, hook: unknown): void {
    const d = checkHookSubscription(slug, hook);
    if (!d.ok) throw new Error(`🛡️ Plugin '${slug}' may not subscribe to this hook: ${d.reason}.`);
}

/**
 * The arguments a delivery to `slug` may carry, or null when the delivery must not happen (the grant was
 * revoked since registration, or the hook is denied). Unclassified (plugin-own) hooks pass through.
 */
function argsForPlugin(slug: string, hook: string, args: any[]): any[] | null {
    if (!checkHookSubscription(slug, hook).ok) return null;
    const policy = getHookPolicy(hook);
    if (!policy || !policy.sanitize) return args;
    return policy.sanitize(slug, args);
}

module.exports = {
    CORE_HOOK_POLICY, RESERVED_CORE_HOOK_RE, RAW_HTML_HOOKS,
    getHookPolicy, checkHookSubscription, assertHookSubscribable, argsForPlugin,
    redactNotificationForHook,
};

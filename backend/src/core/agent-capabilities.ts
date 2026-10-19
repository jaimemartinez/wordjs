/**
 * WordJS — AI agent capabilities: the vocabulary an agent connection REQUESTS, an administrator GRANTS,
 * and the one function that turns a grant into authority.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: an agent can never do more than the user it is bound to. Every agent
 * call runs AS that user, through the very same REST handlers a browser reaches (core/rest-dispatch), but
 * with `req.user` replaced by narrowUser(): its `can(cap)` answers
 *
 *        user.can(cap)  AND  agentPermitsCapability(grants, cap)
 *
 * so a grant can only ever REMOVE capabilities from the user, never add one. The grant vocabulary below is
 * deliberately coarse and content-shaped (what an admin can reason about in one glance), and it maps onto
 * the product's real capabilities here — not at each call site — so a REST route that gains a new check is
 * covered automatically: a capability this file does not name is DENIED to every agent.
 *
 * What no grant can ever reach, whatever the bound user holds: deleting anything, users/roles, plugins,
 * themes, settings writes, tokens, MFA, backups. There is no vocabulary word for them, and the narrowed
 * user answers `false` for their capabilities and reports the synthetic role `agent` to role-based gates
 * (`isAdmin` and friends), so even an administrator's agent is refused there.
 */

/** The grant vocabulary. Order is the display order in the admin UI. */
const AGENT_CAPABILITIES = Object.freeze([
    'content:read',
    'content:draft',
    'content:publish',
    'content:others',
    'media:upload',
    'taxonomy:write',
    'comments:moderate',
    'settings:read',
] as const);

type AgentCapability = typeof AGENT_CAPABILITIES[number];

/**
 * `content:others` is the one word that reaches OTHER people's content: reading their private entries
 * (`read_private_*`) and editing their entries (`edit_others_*`, together with `content:draft`). Without
 * it an agent works on its bound user's own entries and on published content only — the text other
 * authors and commenters wrote never reaches its context through a write tool. It is never implied by
 * another word and never added to an existing grant: an administrator grants it on purpose.
 *
 * A grant that only makes sense together with another one, made explicit: editing a draft implies being
 * able to read it, and publishing implies being able to prepare the draft. Applied when a set is
 * NORMALIZED (so the stored grant already carries the implication and the admin UI shows it), never
 * silently at check time.
 */
const IMPLIES: Readonly<Record<string, readonly AgentCapability[]>> = Object.freeze({
    'content:draft': ['content:read'],
    'content:publish': ['content:draft', 'content:read'],
    'content:others': ['content:read'],
});

/** The synthetic role a narrowed administrator reports to role-based gates (never 'administrator'). */
const AGENT_ROLE = 'agent';

function isAgentCapability(s: unknown): s is AgentCapability {
    return typeof s === 'string' && (AGENT_CAPABILITIES as readonly string[]).includes(s);
}

function capabilityTokens(input: unknown): string[] {
    let parts: string[];
    if (Array.isArray(input)) parts = input.map((s) => String(s));
    else if (typeof input === 'string') parts = input.split(',');
    else parts = [];
    return parts.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Supplied tokens that are not in the vocabulary — routes reject these (400) instead of dropping them. */
function invalidAgentCapabilities(input: unknown): string[] {
    return capabilityTokens(input).filter((s) => !isAgentCapability(s));
}

/** Canonical, deduped, implication-expanded, vocabulary-ordered set. Unknown tokens are dropped. */
function normalizeAgentCapabilities(input: unknown): AgentCapability[] {
    const wanted = new Set<AgentCapability>();
    for (const s of capabilityTokens(input)) {
        if (!isAgentCapability(s)) continue;
        wanted.add(s);
        for (const implied of IMPLIES[s] || []) wanted.add(implied);
    }
    return AGENT_CAPABILITIES.filter((c) => wanted.has(c));
}

/**
 * A grant may only contain what was requested. Returns the normalized grant, or the list of tokens that
 * exceed the request (the route answers 400 with them). Implications are expanded on BOTH sides first, so
 * granting `content:publish` against a request for `content:publish` is not refused for its implied parts.
 */
function grantWithinRequest(requested: unknown, granted: unknown): { ok: true; grant: AgentCapability[] } | { ok: false; excess: string[] } {
    const req = new Set(normalizeAgentCapabilities(requested));
    const grant = normalizeAgentCapabilities(granted);
    const excess = grant.filter((c) => !req.has(c));
    return excess.length ? { ok: false, excess } : { ok: true, grant };
}

// ─── Grant → capability ──────────────────────────────────────────────────────────────────────────────

// 'readOthers' / 'editOthers' reach content the bound user did not write; they need `content:others`
// on top of the read / draft word. Ranked above their base kind so a name shared with one fails closed.
type ContentKind = 'read' | 'readOthers' | 'draft' | 'editOthers' | 'publish' | 'never';
const KIND_RANK: Record<ContentKind, number> = { read: 0, readOthers: 1, draft: 2, editOthers: 3, publish: 4, never: 5 };

/**
 * Every content capability of every registered post type, classified. Built from the SAME policy the
 * REST content routes authorize with (core/post-capabilities capsForType), so a custom type's
 * `edit_books` / `publish_books` is classified like `edit_posts` / `publish_posts` with no list to keep in
 * sync. When two types disagree on one capability name, the MOST restrictive kind wins (fail closed).
 * Rebuilt per call: types register at runtime (plugins), and this is a handful of map lookups.
 */
function contentCapabilityKinds(): Map<string, ContentKind> {
    const kinds = new Map<string, ContentKind>();
    const put = (cap: unknown, kind: ContentKind) => {
        if (typeof cap !== 'string' || !cap) return;
        const prev = kinds.get(cap);
        if (!prev || KIND_RANK[kind] > KIND_RANK[prev]) kinds.set(cap, kind);
    };
    let types: any[];
    try { types = require('./post-types').getPostTypes() || []; } catch { types = []; }
    const { capsForType } = require('./post-capabilities');
    const names = new Set<string>(['post', 'page']);
    for (const t of types) if (t && typeof t.name === 'string') names.add(t.name);
    for (const name of names) {
        let p: any;
        try { p = capsForType(name); } catch { p = null; }
        if (!p) continue;
        put(p.readPrivate, 'readOthers');
        put(p.create, 'draft');
        put(p.edit, 'draft');
        put(p.editOthers, 'editOthers');
        put(p.publish, 'publish');
        put(p.editPublished, 'publish');
        put(p.del, 'never');
        put(p.deletePublished, 'never');
        put(p.deleteOthers, 'never');
    }
    return kinds;
}

/**
 * Does the agent GRANT permit product capability `cap`? This is the agent half of the intersection only;
 * narrowUser ANDs it with the bound user's own answer. Anything not named here is false.
 */
function agentPermitsCapability(grants: Iterable<string>, cap: string, kinds?: Map<string, ContentKind>): boolean {
    const g = grants instanceof Set ? grants as Set<string> : new Set(grants);
    if (cap === 'read') return true; // the baseline every logged-in account holds
    if (cap === 'upload_files') return g.has('media:upload');
    if (cap === 'manage_categories') return g.has('taxonomy:write');
    if (cap === 'moderate_comments') return g.has('comments:moderate');
    const kind = (kinds || contentCapabilityKinds()).get(cap);
    if (kind === 'read') return g.has('content:read');
    if (kind === 'readOthers') return g.has('content:read') && g.has('content:others');
    if (kind === 'draft') return g.has('content:draft');
    if (kind === 'editOthers') return g.has('content:draft') && g.has('content:others');
    if (kind === 'publish') return g.has('content:publish');
    return false;
}

/**
 * The bound user, narrowed by the grant. A COPY with the same prototype (so every method and field the
 * routes read is there, `id` included) whose capability answers are the intersection. The original user
 * object is never mutated — it may be shared through the user cache.
 */
function narrowUser(user: any, grants: Iterable<string>): any {
    const g = new Set(grants);
    const narrowed = Object.assign(Object.create(Object.getPrototypeOf(user)), user);
    const realRole = () => (typeof user.getRole === 'function' ? user.getRole() : user.role);
    narrowed.can = (cap: string) => !!user.can(cap) && agentPermitsCapability(g, cap);
    narrowed.getRole = () => (realRole() === 'administrator' ? AGENT_ROLE : realRole());
    narrowed.getCapabilities = () => {
        const kinds = contentCapabilityKinds();
        const base: string[] = (typeof user.getCapabilities === 'function' && user.getCapabilities()) || [];
        const candidates = base.includes('*')
            ? ['read', 'upload_files', 'manage_categories', 'moderate_comments', ...kinds.keys()]
            : base;
        return Array.from(new Set(candidates.filter((c) => user.can(c) && agentPermitsCapability(g, c, kinds)))).sort();
    };
    narrowed.isAgent = true;
    return narrowed;
}

/**
 * Which grant words are EFFECTIVE for this user — granted AND backed by at least one capability the user
 * really holds. Shown in the admin UI so a grant the user cannot exercise (e.g. content:publish on a
 * contributor) is visibly inert instead of silently promising something it cannot deliver.
 */
function effectiveAgentCapabilities(user: any, grants: Iterable<string>): AgentCapability[] {
    const g = normalizeAgentCapabilities(Array.from(grants));
    const kinds = contentCapabilityKinds();
    const userCan = (c: string) => !!(user && user.can(c));
    const byKind = (k: ContentKind) => Array.from(kinds.entries()).some(([cap, kind]) => kind === k && userCan(cap));
    return g.filter((c) => {
        switch (c) {
            case 'content:read': return true; // published content is readable by anyone, so never inert
            case 'content:draft': return byKind('draft');
            case 'content:publish': return byKind('publish');
            case 'content:others': return byKind('readOthers') || byKind('editOthers');
            case 'media:upload': return userCan('upload_files');
            case 'taxonomy:write': return userCan('manage_categories');
            case 'comments:moderate': return userCan('moderate_comments');
            case 'settings:read': return true; // the public site identity only (see core/mcp-server)
            default: return false;
        }
    });
}

/**
 * The coarse REST scopes a grant implies — stamped on the dispatched request as `req.apiToken.scopes`, so
 * the same per-resource method gate API tokens get is a SECOND fence behind the capability intersection
 * (and so code that branches on `req.apiToken` treats an agent as headless, which it is).
 */
function scopesForGrants(grants: Iterable<string>): string[] {
    const g = new Set(grants);
    const s = new Set<string>();
    if (g.has('content:read')) ['posts:read', 'types:read', 'taxonomies:read', 'categories:read', 'tags:read', 'media:read'].forEach((x) => s.add(x));
    if (g.has('content:draft') || g.has('content:publish')) s.add('posts:write');
    if (g.has('media:upload')) s.add('media:write');
    if (g.has('taxonomy:write')) { s.add('categories:write'); s.add('tags:write'); }
    if (g.has('comments:moderate')) s.add('comments:write');
    return Array.from(s).sort();
}

module.exports = {
    AGENT_CAPABILITIES,
    AGENT_ROLE,
    isAgentCapability,
    invalidAgentCapabilities,
    normalizeAgentCapabilities,
    grantWithinRequest,
    agentPermitsCapability,
    narrowUser,
    effectiveAgentCapabilities,
    scopesForGrants,
    contentCapabilityKinds,
};

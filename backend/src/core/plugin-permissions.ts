/**
 * WordJS - Plugin Permission Grants (Android-style, admin-controlled, DEFAULT-DENY)
 *
 * The plugin's manifest declares the permissions it REQUESTS; this registry records what an operator
 * has actually GRANTED per plugin. A bridge capability is allowed only if the manifest declares it AND
 * the admin granted it (see plugin-context.hasPermission) — so a plugin gets NOTHING until an admin
 * approves it in the UI (`/admin/plugins`). Network is a separate, manifest-independent grant (an
 * untrusted plugin has no network unless an admin explicitly grants it, with a warning).
 *
 * Grants are stored SERVER-SIDE (the `plugin_grants` option) — never self-declarable — and mirrored in
 * memory so the host security gates read them synchronously. loadGrants() runs at boot after the DB is
 * up, and again whenever core/coherence.ts re-syncs (a peer's change, a bus reconnect, every 10 s) — see
 * "ONE ORDER" below for how those reads and the writes are kept from undoing each other. The child can't
 * read the DB, so the NETWORK grant is pushed into each isolate's cfg at
 * spawn (→ global.__WORDJS_PLUGIN_NETWORK__); bridge-scope grants are enforced host-side per call.
 *
 * There is NO trust tier: every plugin runs in the child_process sandbox and gets ONLY what an admin
 * has granted (default-deny). No plugin bypasses DB scoping, io-guard, or these grants.
 */

// slug -> set of granted tokens: "scope:access" (e.g. "database:write") and/or the literal "network".
const grants = new Map<string, Set<string>>();
let loaded = false;

// slug -> list of egress hosts a NETWORK-granted plugin may reach (bare hostname or IP literal). EMPTY /
// absent = allow-all-public (today's behavior, so a granted plugin with no list does NOT regress); a
// non-empty list flips that plugin to default-DENY at the egress-guard (only listed hosts + subdomains).
// Manifest-independent, admin-set, stored SERVER-SIDE in the `plugin_egress_hosts` option.
const egressHosts = new Map<string, string[]>();

// A valid egress-host entry: a bare hostname (optionally a leading '*.'/'.'), or an IP literal. NEVER a
// scheme, path, port, query, or whitespace — those are rejected so a poisoned option can't smuggle a URL.
const VALID_EGRESS_HOST = /^(?:\*\.)?(?:[a-z0-9_-]+\.)*[a-z0-9_-]+$/i;
function isValidEgressHost(h: string): boolean {
    if (!h || h.length > 253) return false;
    if (require('net').isIP(h)) return true;
    return VALID_EGRESS_HOST.test(h);
}

/** The literal token used for the network grant (no access level). */
const NETWORK_TOKEN = 'network';

// ── Slug-as-OBJECT-KEY: the structure-choosing input ────────────────────────────────────────────────
//
// `plugin_grants` and `plugin_egress_hosts` are JSON blobs keyed BY PLUGIN SLUG, and the slug arrives
// from the request (`POST /plugins/:slug/permissions`, `.../egress-hosts`). So a remote value is not
// merely stored — it CHOOSES A PROPERTY NAME. That is the same defect class as the path routes: the code
// sanitized the VALUES (the token/host lists, thoroughly) and never validated the thing selecting
// structure. Two concrete failures it left open on `stored[slug] = clean`:
//
//   · `__proto__` — on the `{}` default that getOption returns when the option is unset, this is a
//     SETTER, not a property: it silently re-parents the object instead of adding a key. updateOption
//     then serializes an object with no such key, so the API answers 200 with the admin's egress
//     allowlist… never persisted. A restrictive policy that reports success and does not exist is
//     fail-OPEN, which is exactly what the egress allowlist exists to prevent.
//   · `constructor` / `prototype` — both are legal slugs under the project's slug charset, and both
//     shadow inherited names, so any later `stored[x]`-shaped read of a MISSING key stops returning
//     undefined and starts returning a function.
//
// Fix, per the rule the editor fuzzer taught us: allowlist the FORM of the key, refuse the three magic
// names outright, and never index an inherited name — every read is Object.hasOwn-gated and every write
// goes through writeSlugKey(), which rebuilds the record with a NULL PROTOTYPE so there is no inherited
// name left to hit in the first place.

/** A plugin slug: one segment, starts alnum, ≤64. Character-for-character routes/plugins.ts' SLUG_RE. */
const PLUGIN_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Property names that must never be written or read through a computed key, whatever the charset says.
 * `__proto__` cannot match PLUGIN_SLUG; `constructor` and `prototype` CAN — which is the whole point of
 * listing them explicitly rather than inferring safety from the regex.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A key echoed into an operator log line, with line breaks stripped: an unsafe key is by definition a
 * value we did not validate, so it must not be able to forge or split a log entry on its way to the
 * warning that reports it. Two single-constant replacements (the shape the log-injection analysis
 * recognises), exactly like routes/plugins.ts' logSafe().
 */
function logSafeKey(v: unknown): string {
    return String(v).replace(/\n/g, '').replace(/\r/g, '');
}

/** Is `slug` usable as a record key here — right shape AND not a magic name? */
function isSafeSlugKey(slug: unknown): boolean {
    return typeof slug === 'string' && PLUGIN_SLUG.test(slug) && !FORBIDDEN_KEYS.has(slug);
}

/** A NEW null-prototype copy of a stored blob's own keys, without the forbidden names. */
function copyStore(store: any): Record<string, any> {
    const out: Record<string, any> = Object.create(null);
    if (store && typeof store === 'object') {
        for (const k of Object.keys(store)) {
            if (!Object.hasOwn(store, k) || FORBIDDEN_KEYS.has(k)) continue;
            out[k] = (store as any)[k];
        }
    }
    return out;
}

/**
 * Return a NEW null-prototype record = `store` plus `slug -> value`. Throws on a slug that may not be a
 * key (fail closed: an unstorable grant/egress change must be an error the admin sees, never a silent
 * no-op that leaves the old policy in force while the API reports success).
 *
 * The copy is own-properties-only and skips the forbidden names, so a `plugin_grants` blob that was
 * poisoned before this guard existed is also cleaned up the first time it is rewritten.
 */
function writeSlugKey(store: any, slug: unknown, value: any): Record<string, any> {
    if (!isSafeSlugKey(slug)) {
        throw new Error(`Refusing to store plugin policy under an unsafe key: ${JSON.stringify(slug)}`);
    }
    const out = copyStore(store);
    out[slug as string] = value;
    return out;
}

/** Same own-key discipline for the DELETE side (uninstall), without needing a value. */
function deleteSlugKey(store: any, slug: unknown): { changed: boolean; next: Record<string, any> } {
    const next: Record<string, any> = Object.create(null);
    let changed = false;
    if (store && typeof store === 'object') {
        for (const k of Object.keys(store)) {
            if (!Object.hasOwn(store, k)) continue;
            if (FORBIDDEN_KEYS.has(k)) { changed = true; continue; } // drop a poisoned key while we are here
            if (k === slug) { changed = true; continue; }
            next[k] = (store as any)[k];
        }
    }
    return { changed, next };
}

// A grant token is either the literal 'network' or a "<scope>:<access>" pair. The SHAPE is checked on
// both sides of the store: the writers never store a malformed token (normalizeGrantTokens), and
// loadGrants() drops one anyway, so a blob poisoned by some other path (or written before the write-side
// check existed) can't smuggle in a structurally-bogus token (SQL, path, whitespace, object). The two
// sides MUST agree: a token the writer kept but the loader drops made memory (what a child is spawned
// with) differ from what every later re-read produces — one needless respawn, and a warning on every node
// at every re-sync. We match the general scope:access shape rather than a hardcoded list of access verbs —
// the real verbs vary by scope (read/write/admin/provider/send/register_route/register, per
// KNOWN_PERMISSIONS) and a narrow list silently DROPS legitimate grants (e.g. notifications:send) on reload.
const VALID_GRANT_TOKEN = /^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_-]*$/;
function isValidGrantToken(t: string): boolean {
    return t === NETWORK_TOKEN || VALID_GRANT_TOKEN.test(t);
}

/** A requested token list, lowercased, trimmed, de-duplicated and without blanks (well-formed or not). */
function requestedGrantTokens(tokens: string[]): string[] {
    return Array.from(new Set((tokens || []).map(t => String(t).toLowerCase().trim()).filter(Boolean)));
}

/**
 * THE token list a writer stores for `tokens`: requestedGrantTokens(), well-formed tokens only — the
 * exact set loadGrants() would rebuild from it. What a write would ADD (grantsAddedTo) is judged on this
 * same list, so a spelling the store folds together cannot pass for a narrowing.
 */
function normalizeGrantTokens(tokens: string[]): string[] {
    return requestedGrantTokens(tokens).filter(isValidGrantToken);
}

/**
 * normalizeGrantTokens() for a writer: a malformed token is dropped (logged here, once per write), not
 * refused — grant-on-activate and the boot backfill pass manifest-derived lists, and one bad entry must
 * not cost a plugin every other grant it declared.
 */
function cleanGrantTokens(slug: string, tokens: string[]): string[] {
    const requested = requestedGrantTokens(tokens);
    const clean = requested.filter(isValidGrantToken);
    if (clean.length !== requested.length) {
        const dropped = requested.filter(t => !isValidGrantToken(t));
        console.warn("[PluginPermissions] Not storing malformed grant token(s) %s for plugin '%s' (a grant is 'network' or 'scope:access').", JSON.stringify(dropped), logSafeKey(slug));
    }
    return clean;
}

/** An egress list as the writers store it: lowercased, trimmed, de-duplicated, valid entries only. */
function normalizeEgressHosts(hosts: string[]): string[] {
    return Array.from(new Set((hosts || []).map(h => String(h).toLowerCase().trim()).filter(isValidEgressHost)));
}

// A load runs on every re-sync — every 10 s, on every node — so a malformed entry in a stored blob would
// repeat the same warning forever. Report each distinct one once per process. Capped: the blobs are
// admin-written and small, but a set that only ever grows is not something to leave in a server.
const reportedMalformed = new Set<string>();
function warnMalformedOnce(key: string, message: string, ...args: unknown[]): void {
    if (reportedMalformed.has(key)) return;
    if (reportedMalformed.size >= 1000) reportedMalformed.clear();
    reportedMalformed.add(key);
    console.warn(message, ...args);
}

/**
 * One plugin's grant RECORD from a stored list: its well-formed tokens, or null when there is no record
 * (a value that is not a list). A record may be EMPTY; whether that emptiness was an administrator's
 * decision is recorded separately (ADMIN_DECISIONS_MARKER).
 */
function grantRecordOf(slug: string, list: unknown): string[] | null {
    if (!Array.isArray(list)) return null;
    const clean: string[] = [];
    for (const raw of list) {
        const t = String(raw).toLowerCase().trim();
        if (isValidGrantToken(t)) clean.push(t);
        else warnMalformedOnce(`grants\u0000${slug}\u0000${String(raw)}`, "[PluginPermissions] Dropping malformed grant token %s for plugin '%s' from plugin_grants.", JSON.stringify(String(raw)), slug);
    }
    return clean;
}

/** A plugin's grant record inside a `plugin_grants` value, read the way loadGrants() reads it (null: none). */
function grantRecordIn(stored: any, slug: string): string[] | null {
    if (!isSafeSlugKey(slug) || !stored || typeof stored !== 'object' || !Object.hasOwn(stored, slug)) return null;
    return grantRecordOf(slug, stored[slug]);
}

/** One plugin's egress list from a stored list: its valid hosts (a value that is not a list: none). */
function egressRecordOf(slug: string, list: unknown): string[] | null {
    if (!Array.isArray(list)) return null;
    const clean: string[] = [];
    for (const raw of list) {
        const h = String(raw).toLowerCase().trim();
        if (isValidEgressHost(h)) clean.push(h);
        else warnMalformedOnce(`egress\u0000${slug}\u0000${String(raw)}`, "[PluginPermissions] Dropping malformed egress host %s for plugin '%s' from plugin_egress_hosts.", JSON.stringify(String(raw)), slug);
    }
    return clean;
}

/** A plugin's egress list inside a `plugin_egress_hosts` value, read the way loadEgressHosts() reads it (null: none). */
function egressRecordIn(stored: any, slug: string): string[] | null {
    if (!isSafeSlugKey(slug) || !stored || typeof stored !== 'object' || !Object.hasOwn(stored, slug)) return null;
    return egressRecordOf(slug, stored[slug]);
}

// ── THE HOST'S OWN ENTRY IN THE GRANT STORE ─────────────────────────────────────────────────────────
//
// Bookkeeping that decides GRANTS must live where the grants live. The one-time browser:script upgrade
// (core/plugins migrateBrowserCapabilityGrants) used to record "done" in an option of its own, and that
// option was the only thing standing between the next boot and a fresh grant of browser:script to every
// active plugin with browser code: clear it — a settings:write plugin could, through the options bridge
// — and an administrator's revocations were silently undone. Kept inside `plugin_grants`, the marker
// can only be reset by something that can already rewrite every grant directly, so resetting it confers
// nothing. It is written like every other policy change (writePolicyBlob: under the policy lease, on a
// fresh read, guarded), so a marker write and a grant write never undo each other.
//
// '@host' cannot be a plugin slug (PLUGIN_SLUG starts with an alphanumeric), so it never collides with a
// plugin's record; loadGrants() skips it, and writeSlugKey/deleteSlugKey carry it over untouched like any
// other own key.
const HOST_RECORD_KEY = '@host';

function hostRecordOf(stored: any): Record<string, any> {
    const rec = stored && typeof stored === 'object' && Object.hasOwn(stored, HOST_RECORD_KEY) ? stored[HOST_RECORD_KEY] : null;
    return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : {};
}

/** A prototype-free copy of the stored host record, to modify and write back. */
function hostRecordCopy(stored: any): Record<string, any> {
    const rec: Record<string, any> = Object.create(null);
    for (const [k, v] of Object.entries(hostRecordOf(stored))) if (!FORBIDDEN_KEYS.has(k)) rec[k] = v;
    return rec;
}

/**
 * WHICH GRANT RECORDS AN ADMINISTRATOR HAS DECIDED — host marker `adminDecisions`: slug → when.
 *
 * A grant record alone does not say who wrote it. One written by an administrator's decision (the
 * activation dialog's grant-on-activate, the permissions screen) states what that administrator wants,
 * browser:script included — and an EMPTY one states "nothing"; one written by a boot-time upgrade step
 * (backfillActive) or by a version that predates a capability does not, and an empty one may be what an
 * older in-place update left behind (see shouldSeedDeclaredGrants). So:
 *   · a one-time upgrade that ADDS a capability to "plugins that were already active" (core/plugins
 *     migrateBrowserCapabilityGrants) never touches a decided record: on a site installed through the
 *     setup wizard that upgrade first ran at the first restart after real use, found a plugin whose
 *     browser:script the administrator had revoked, read it as a pre-upgrade plugin and granted it again;
 *   · grant-on-activate never re-seeds a decided EMPTY record: an administrator's revoke of every grant
 *     survives the next activation.
 * Recorded in the same write as the grants, so the two cannot disagree; removed with the record
 * (removeGrants, clearGrants).
 */
const ADMIN_DECISIONS_MARKER = 'adminDecisions';

/** Has an administrator decided this plugin's grants, in this stored `plugin_grants` value? */
function hasAdminDecisionIn(stored: any, slug: string): boolean {
    const decisions = hostRecordOf(stored)[ADMIN_DECISIONS_MARKER];
    return !!(decisions && typeof decisions === 'object' && !Array.isArray(decisions) && Object.hasOwn(decisions, slug));
}

/** `next` (a fresh copy of `stored`) with `slug`'s administrator decision recorded (`decided`) or dropped. */
function withAdminDecision(next: Record<string, any>, stored: any, slug: string, decided: boolean): Record<string, any> {
    if (!decided && !hasAdminDecisionIn(stored, slug)) return next;
    const rec = hostRecordCopy(stored);
    const previous = rec[ADMIN_DECISIONS_MARKER];
    const decisions: Record<string, string> = Object.create(null);
    if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
        for (const [k, v] of Object.entries(previous)) if (isSafeSlugKey(k) && k !== slug) decisions[k] = String(v);
    }
    if (decided) decisions[slug] = new Date().toISOString();
    rec[ADMIN_DECISIONS_MARKER] = decisions;
    next[HOST_RECORD_KEY] = rec;
    return next;
}

/** The `plugin_grants` value with `slug` holding `clean` (and, for an administrator's decision, its marker). */
function grantStoreWith(stored: any, slug: string, clean: string[], opts: { adminDecision?: boolean } = {}): Record<string, any> {
    const next = writeSlugKey(stored, slug, clean);
    return opts && opts.adminDecision === true ? withAdminDecision(next, stored, slug, true) : next;
}

/** The `plugin_grants` value without `slug`'s record and without its administrator decision. */
function grantStoreWithout(stored: any, slug: string): { changed: boolean; next: Record<string, any> } {
    const { changed, next } = deleteSlugKey(stored, slug);
    if (!hasAdminDecisionIn(stored, slug)) return { changed, next };
    return { changed: true, next: withAdminDecision(next, stored, slug, false) };
}

// ── ONE ORDER FOR EVERY READ AND WRITE OF THE POLICY STORE ──────────────────────────────────────────
//
// The in-memory maps above are what the host gates read synchronously and what an isolate is spawned
// with, so the order in which loads and writes land in them IS the policy. The rules:
//
//   1. A write READS THE ROW FRESH, UNDER THE CLUSTER LEASE, and decides on that read. The
//      read-modify-write of the shared JSON blob runs under the `wordjs:plugin-policy` dist-lock
//      (single-host: no-op), reading the row from the database (options.readStoredOption) — a blob read
//      through a stale L1 and written back would silently undo a peer's change to ANOTHER plugin, and a
//      decision taken on this node's mirror ("would this write add a grant?", "does this plugin hold
//      grants yet?") would be taken on what a revoke made through another node has not reached yet.
//   2. The write is GUARDED: it lands only if the row still holds exactly what was read (persistOption's
//      `expectedRaw`; when there was no row, only while there is still none), and otherwise the row is
//      read and the decision taken again. The lease already orders this code's writers across nodes; the
//      guard is what keeps a decision from being applied over a value it was not taken on even when
//      something else wrote the row (an older node, a restore, a hand edit).
//   3. It PERSISTS FIRST and updates memory second. Memory first left a window in which a reload
//      (another node's option-changed broadcast, the periodic re-sync in core/coherence.ts) read the
//      database BEFORE the write landed and put the OLD value back into memory — and the caller's very
//      next step, the permission route's reloadIsolatedPlugin(), then spawned the child with it: a
//      network revoke that the API reported as done, with the child still holding the network.
//   4. Loads and writes run ONE AT A TIME in this process (policyChain). Persist-first alone does not
//      close the other interleaving: a load that READ before the write committed and APPLIED after the
//      write updated memory would still restore the old value. Serializing them means a load either
//      completes before a write starts or reads after the write committed. Adopting the stored record
//      for one plugin (adoptStoredPolicy) is a load too.
//
// "Memory second" means IMMEDIATELY second: the row is written with options.persistOption(), memory is
// updated, and only then — after the lease and the queue are released — do the `updated_option` hooks
// fan out (announceInOrder). That fan-out visits every subscriber in turn — an isolated plugin's over
// IPC, each held up to its hook shim's timeout (2 s) — so it can take as long as the subscribers do. Run
// inside updateOption() it sat between the commit and the memory update (a revoked grant stayed live on
// the writing node for the whole fan-out), and inside the queue and the lease it held up this node's
// re-syncs and every other node's policy writes.
//
// The same holds one step further out, for what a running CHILD was spawned with (the network grant,
// the egress allowlist, the child-side fs gate): a caller that respawns the child — or re-scans it and
// deactivates it — after a change must do so as soon as the change is in memory, not after the fan-out.
// applyGrants()/applyEgressAllowlist() resolve at exactly that point and hand the fan-out back as
// `announced`; setGrants()/setEgressAllowlist() are the same writes that also wait for it.
let policyChain: Promise<unknown> = Promise.resolve();
function serializePolicy<T>(fn: () => Promise<T>): Promise<T> {
    const run = policyChain.then(fn, fn); // a failed predecessor must not wedge the queue
    policyChain = run.catch(() => { /* only its completion orders the next one */ });
    return run;
}

// The `updated_option` fan-outs of policy writes, one at a time and in commit order (each is queued from
// inside the serialized write), but OUTSIDE policyChain: loads and later writes do not wait for them.
let announceChain: Promise<unknown> = Promise.resolve();
function announceInOrder(announce: () => Promise<void>): Promise<void> {
    const run = announceChain.then(announce, announce);
    announceChain = run.catch(() => { /* a failed fan-out must not wedge the next one */ });
    return run;
}

type PolicyOption = 'plugin_grants' | 'plugin_egress_hosts';

/**
 * Read one policy option fresh from the database: its exact stored text (`raw`, null when there is no
 * row — the guard of a write decided on this read) and its value as an object (`{}` for none). Throws on
 * a DB error — never answers a default.
 */
async function readPolicyOption(name: PolicyOption): Promise<{ raw: string | null; stored: any }> {
    const { raw, value } = await require('./options').readStoredOption(name);
    return { raw, stored: value && typeof value === 'object' && !Array.isArray(value) ? value : {} };
}

/** How many times a policy write re-reads and decides again when another write keeps landing first. */
const POLICY_WRITE_ATTEMPTS = 5;

/**
 * A policy write that is persisted and in force in this process's memory. `announced` is its
 * `updated_option` hook fan-out, still running: it settles once every subscriber has been told (and
 * rejects if one of them threw). It already has a handler attached (announceInOrder), so a caller that
 * awaits it only later — after respawning a child — does not leave an unhandled rejection behind.
 */
interface PolicyApplied { announced: Promise<void> }

/**
 * A write that may only NARROW (an API token's) and found it would ADD something: `refused` names what
 * (grant tokens, or egress hosts with EGRESS_EVERY_PUBLIC_HOST for "every public host"), and nothing was
 * written. Empty for a write that went through.
 */
interface PolicyWriteResult extends PolicyApplied { refused: string[] }

/**
 * THE policy write (see "ONE ORDER"): under the cross-node lease, read the blob fresh, let `decide` say
 * what to store (`changed: false` writes nothing), write it guarded on the text that was read — reading
 * and deciding again when the row changed in between — and run `apply` (the in-memory update) straight
 * away. `decide` may run more than once, and only its LAST answer is applied: it must set whatever state
 * `apply` reads on every call. Throws — nothing written, memory untouched — when the lease cannot be taken
 * or the row keeps changing: a policy change that may be lost is an error the admin sees, never a silent
 * success. Resolves to `announced`, the queued `updated_option` fan-out of the write, which the public
 * writer awaits after it has left the serialized section. Call it inside serializePolicy().
 */
async function writePolicyBlob(name: PolicyOption, decide: (stored: any) => { changed: boolean; next?: any }, apply: () => void): Promise<PolicyApplied> {
    const { acquireBlocking } = require('./dist-lock');
    const lock = await acquireBlocking('wordjs:plugin-policy', { ttlMs: 15000, timeoutMs: 15000 });
    if (!lock.held) throw new Error(`Could not acquire the plugin policy lock to update ${name} (another node holds it)`);
    let announce: (() => Promise<void>) | null = null;
    try {
        for (let attempt = 0; ; attempt++) {
            if (attempt >= POLICY_WRITE_ATTEMPTS) {
                throw new Error(`The stored ${name} changed ${POLICY_WRITE_ATTEMPTS} times while this write was decided; nothing was written.`);
            }
            const { raw, stored } = await readPolicyOption(name);
            const { changed, next } = decide(stored);
            if (!changed) break;
            const res = await require('./options').persistOption(name, next, 'yes', { expectedRaw: raw });
            if (res.written === false) continue; // the row changed since it was read: read and decide again
            announce = res.announce;
            break;
        }
        apply();
    } finally {
        await lock.release();
    }
    return { announced: announce ? announceInOrder(announce) : Promise.resolve() };
}

/** Run one serialized policy write, then wait for its hook fan-out outside the queue. */
async function writePolicy(fn: () => Promise<PolicyApplied>): Promise<void> {
    const { announced } = await serializePolicy(fn);
    await announced;
}

function assertHostContext(what: string): void {
    // NO plugin/theme may touch the permission store: it IS the permission store, so an in-process theme
    // calling require('core/plugin-permissions').setGrants('confederate', ['*']) would self-escalate past
    // the admin-approval default-deny model (#9). Only host/admin code (no plugin context) may call it —
    // grant-on-activate and boot backfill both run in host context (getEffectivePlugin() === null).
    if (require('./plugin-context').getEffectivePlugin()) {
        throw new Error(`🛡️ ${what} is not permitted from plugin/theme context.`);
    }
}

/** Load the persisted grants into memory. Runs at boot (after the DB is up) and on every re-sync. */
async function loadGrants(): Promise<void> {
    return serializePolicy(loadGrantsUnlocked);
}

async function loadGrantsUnlocked(): Promise<void> {
    try {
        // Fresh + strict: a DB error THROWS here (caught below) and leaves the last-known-good map in
        // place. getOption answered it with `{}`, which this function then applied — dropping EVERY
        // plugin's grants on a transient database error.
        const { stored } = await readPolicyOption('plugin_grants');
        grants.clear();
        for (const [slug, list] of Object.entries(stored)) {
            if (slug === HOST_RECORD_KEY) continue; // the host's bookkeeping, not a plugin's grants
            // The KEY is validated too, not just the values: a blob written before this guard (or by
            // any path other than setGrants) must not be able to install a grant record under a magic
            // name. Unsafe key ⇒ the plugin simply has no grants — default-deny, fail closed.
            if (!isSafeSlugKey(slug)) {
                warnMalformedOnce(`grants-key\u0000${String(slug)}`, "[PluginPermissions] Dropping grant record under an unsafe plugin key '%s' from plugin_grants.", logSafeKey(slug));
                continue;
            }
            const record = grantRecordOf(slug, list);
            if (record) grants.set(slug, new Set(record));
        }
        loaded = true;
    } catch (e: any) {
        console.warn('[PluginPermissions] Failed to load plugin_grants option (the grants already in memory stay in force):', e && e.message);
    }
}

/** Synchronous grant check used by the host security gates (default-deny). */
function isGranted(slug: string, scope: string, access = 'read'): boolean {
    if (!slug) return false;
    const s = grants.get(slug);
    if (!s) return false;
    if (s.has(`${scope}:${access}`)) return true;
    // `admin` implies ONLY the ordinary read+write verbs — NOT the high-power special verbs (provider =
    // become the system mail sender; register / register_route = own host routes). Those confer far more
    // than admin-on-this-scope and MUST be granted explicitly (audit HIGH: email:admin silently subsumed
    // email:provider, letting a send-mail plugin hijack ALL outbound mail).
    return (access === 'read' || access === 'write') && s.has(`${scope}:admin`);
}

/** Whether the operator granted this (untrusted) plugin outbound network access. */
function isNetworkGranted(slug: string): boolean {
    const s = grants.get(slug);
    return !!(s && s.has(NETWORK_TOKEN));
}

/** The raw granted-token list for a plugin (for the admin UI / API). */
function getGrants(slug: string): string[] {
    return Array.from(grants.get(slug) || []);
}

/**
 * Whether the plugin has a grant RECORD at all — possibly an empty one. getGrants(slug).length cannot
 * tell the two apart.
 */
function hasGrantRecord(slug: string): boolean {
    return grants.has(slug);
}

// ── WIDENING vs NARROWING — what a write would ADD ───────────────────────────────────────────────────
//
// An API token may take a plugin's capabilities away but never add one (middleware/auth.ts
// refusePluginGrantByToken). The two questions below answer "what would this write add?" on the values
// the writers actually store (normalizeGrantTokens / normalizeEgressHosts), so a spelling the store folds
// together cannot pass for a narrowing — and they are asked inside the write (`narrowOnly`), on the row
// read fresh under the lease, never against this node's mirror: on a multi-node install a revoke made on
// another node reaches the database before it reaches this node's maps (the next re-sync), and judged
// against the mirror, a token on a node that still held a revoked grant re-saved it as "nothing added"
// (stored [settings:read], stale mirror database:write → 200, both saved).

/** The tokens of `tokens` a plugin holding `held` does not hold — what writing `tokens` would ADD. */
function grantsAddedTo(held: Iterable<string>, tokens: string[]): string[] {
    const holds = new Set<string>(held);
    return normalizeGrantTokens(tokens).filter((t) => {
        if (holds.has(t)) return false;
        // `scope:admin` already holds that scope's read and write (isGranted), so asking for one of those
        // instead is a narrowing; it implies nothing else.
        const m = /^(.+):(read|write)$/.exec(t);
        return !(m && holds.has(`${m[1]}:admin`));
    });
}

/** What an EMPTY egress allowlist adds when it replaces a list: every public host. */
const EGRESS_EVERY_PUBLIC_HOST = '*';

/**
 * The hosts of `hosts` a plugin whose allowlist is `current` cannot reach — what writing `hosts` would
 * ADD. Matching is egress-guard's isHostAllowed: an entry covers itself and its subdomains at a LABEL
 * boundary (`example.com` covers `api.example.com`, never `evilexample.com`; a leading `*.` changes
 * nothing), an IP literal only itself and a hostname never an IP. An empty list means every public host, so
 * clearing a list adds EGRESS_EVERY_PUBLIC_HOST, and any list narrows a plugin that has none.
 */
function egressHostsAddedTo(current: string[], hosts: string[]): string[] {
    const net = require('net');
    const clean = normalizeEgressHosts(hosts);
    if (clean.length === 0) return current.length ? [EGRESS_EVERY_PUBLIC_HOST] : [];
    if (current.length === 0) return [];
    const bare = (h: string) => h.replace(/^\*?\./, '').replace(/\.$/, '');
    const covered = current.map(bare);
    return clean.filter((h) => {
        const n = bare(h);
        return !covered.some((c) => n === c || (!net.isIP(n) && !net.isIP(c) && n.endsWith('.' + c)));
    });
}

/**
 * Replace a plugin's grants (admin action). `tokens` is the full new set of granted "scope:access"
 * strings (+ optional "network"); a malformed token is not stored (cleanGrantTokens). Persists to the
 * `plugin_grants` option and mirrors in memory, and resolves once the `updated_option` subscribers have
 * been told. A caller that respawns or re-scans the plugin's child afterwards uses applyGrants() instead.
 *
 * `adminDecision: true` marks the write as an administrator's decision (ADMIN_DECISIONS_MARKER): the
 * activation dialog's grant-on-activate and the permissions screen pass it; a boot-time upgrade step and
 * the backfill do not.
 */
async function setGrants(slug: string, tokens: string[], opts: { adminDecision?: boolean } = {}): Promise<void> {
    assertHostContext('setGrants');
    const { announced } = await applyGrants(slug, tokens, { adminDecision: !!(opts && opts.adminDecision === true) });
    await announced;
}

/**
 * setGrants() without the wait for the hook fan-out: resolves as soon as the new grants are persisted and
 * in force in this process's memory — the point from which a child spawned for the plugin gets them —
 * with the fan-out handed back as `announced` (see "ONE ORDER"). The permission route respawns (or
 * re-scans and deactivates) the plugin's child here, and only then waits for `announced`: a child still
 * running with a revoked network grant must not outlive the change by however long the subscribers take.
 *
 * `narrowOnly` (an API token's write): decided on the grants STORED now (read fresh under the lease, see
 * "WIDENING vs NARROWING"), a set that would add anything is not written — `refused` names the additions.
 */
async function applyGrants(slug: string, tokens: string[], opts: { adminDecision?: boolean; narrowOnly?: boolean } = {}): Promise<PolicyWriteResult> {
    assertHostContext('applyGrants');
    // Validate the KEY before it selects anything — throws on __proto__/constructor/prototype or a
    // non-slug shape, so a bad key can never reach either the mirror or the option.
    if (!isSafeSlugKey(slug)) writeSlugKey({}, slug, []); // throws the descriptive error
    const clean = cleanGrantTokens(slug, tokens);
    let refused: string[] = [];
    const { announced } = await serializePolicy(() => writePolicyBlob('plugin_grants',
        (stored) => {
            refused = opts.narrowOnly ? grantsAddedTo(grantRecordIn(stored, slug) || [], clean) : [];
            if (refused.length) return { changed: false };
            return { changed: true, next: grantStoreWith(stored, slug, clean, opts) };
        },
        () => { if (!refused.length) grants.set(slug, new Set(clean)); }));
    return { announced, refused };
}

/**
 * THE grant-on-activate rule, in one place: given a plugin's stored grant record (null = none) and
 * whether an administrator has decided it (ADMIN_DECISIONS_MARKER), does activating it store the grants
 * its manifest declares? seedGrants() asks it on the row it read fresh under the policy lease, and a
 * token's activation (adoptStoredPolicy) on the row it adopted.
 *
 * Yes when there is no record. Yes when the record is EMPTY and no administrator decided it: since
 * 1.12.12 every in-place update of a plugin with no grant record stored an empty one for it, so on an
 * existing site such a record is as likely an update's leftover for a plugin that was never activated —
 * and reading it as a revoke would start that plugin, on its first activation, with none of the
 * permissions it declares. (An update still stores an empty record for a plugin that has none —
 * ensureGrantRecord, which the boot backfill needs — and never an administrator decision with it, so this
 * rule seeds that record too.) No for an empty record an administrator decided — they revoked
 * everything, and that survives a re-activation — and no for a record that holds grants (a partial
 * revoke survives too).
 */
function shouldSeedDeclaredGrants(_slug: string, stored: string[] | null, adminDecided = false): boolean {
    if (!stored) return true;
    return stored.length === 0 && !adminDecided;
}

/**
 * Grant-on-activate: store `tokens` as the plugin's grants when shouldSeedDeclaredGrants() says so.
 * Returns whether it stored them. Decided on the row read fresh under the policy lease (not on this
 * node's map, which may be one re-sync behind), in the same read-modify-write that stores the seed —
 * with, for `adminDecision`, the administrator's decision recorded alongside.
 */
async function seedGrants(slug: string, tokens: string[], opts: { adminDecision?: boolean } = {}): Promise<boolean> {
    assertHostContext('seedGrants');
    if (!isSafeSlugKey(slug)) writeSlugKey({}, slug, []); // throws the descriptive error
    const clean = cleanGrantTokens(slug, tokens);
    let seeded = false;
    let existing: string[] | null = null;
    await writePolicy(() => writePolicyBlob('plugin_grants',
        (stored) => {
            existing = grantRecordIn(stored, slug);
            seeded = shouldSeedDeclaredGrants(slug, existing, hasAdminDecisionIn(stored, slug));
            if (!seeded) return { changed: false };
            return { changed: true, next: grantStoreWith(stored, slug, clean, opts) };
        },
        // Memory mirrors the row this decision was made on: the seed, or the record as stored (none ⇒ none).
        () => {
            if (seeded) grants.set(slug, new Set(clean));
            else if (existing) grants.set(slug, new Set(existing));
            else grants.delete(slug);
        }));
    return seeded;
}

/**
 * Drop a plugin's grant RECORD — and the administrator decision recorded with it (only `plugin_grants`;
 * the egress allowlist is left alone). Used to undo grant-on-activate when the activation fails, so a
 * plugin that never ran holds no grant record: the record is persisted BEFORE activation (other nodes are
 * told about the activation, and must find the grants already in the database).
 */
async function clearGrants(slug: string): Promise<void> {
    assertHostContext('clearGrants');
    return writePolicy(() => writePolicyBlob('plugin_grants',
        (stored) => grantStoreWithout(stored, slug),
        () => { grants.delete(slug); }));
}

/**
 * Give a plugin that has NO grant record an empty one — insert-if-absent: decided on the row read fresh
 * under the policy lease and written guarded on it (writePolicyBlob), so a record any other writer stores
 * in between is kept, never replaced, and a record that exists (empty or not, decided or not) is never
 * touched. No administrator decision is recorded with it. A value that is not a list counts as no record,
 * as it does for loadGrants(). Returns whether it created the record; memory mirrors the row.
 *
 * For the in-place UPDATE (routes/plugins runPluginUpdate), which replaces a plugin's code — and so its
 * manifest — without anyone approving what the new version declares. "No record" is not a neutral state
 * for an ACTIVE plugin: backfillActive() runs at every boot and grants every active plugin with no record
 * whatever its manifest declares, and an active plugin has none whenever it was activated while declaring
 * nothing (grant-on-activate stores only a non-empty seed — and an API token may activate such a plugin).
 * Left without a record, an update to a version declaring `network` or `database:write` was granted them
 * at the next restart, by nobody. An empty record changes nothing else: one no administrator decided is
 * seeded at the plugin's first activation exactly like a missing one (shouldSeedDeclaredGrants), so a
 * plugin updated before it was ever activated still gets what it declares when an administrator
 * activates it, and an API token's activation of it is still refused.
 */
async function ensureGrantRecord(slug: string): Promise<boolean> {
    assertHostContext('ensureGrantRecord');
    if (!isSafeSlugKey(slug)) writeSlugKey({}, slug, []); // throws the descriptive error
    let created = false;
    let existing: string[] | null = null;
    await writePolicy(() => writePolicyBlob('plugin_grants',
        (stored) => {
            existing = grantRecordIn(stored, slug);
            created = existing === null;
            if (!created) return { changed: false };
            return { changed: true, next: writeSlugKey(stored, slug, []) };
        },
        () => { grants.set(slug, new Set(existing || [])); }));
    return created;
}

/**
 * Non-breaking boot backfill: grant the manifest-declared permissions to plugins that are ACTIVE and
 * have NO grant record — so flipping the model to default-deny doesn't silently break a running site.
 * New activations stay default-deny. `entries` is [{ slug, requested: string[] }] for currently-active
 * plugins. Returns the slugs backfilled.
 *
 * It runs at EVERY boot (index.ts) and reads the manifests on disk, so a path that replaces an active
 * plugin's code must not leave it without a record: the in-place update gives it an empty one first
 * (ensureGrantRecord), or the next restart grants whatever the new version declares.
 */
async function backfillActive(entries: Array<{ slug: string; requested: string[] }>): Promise<string[]> {
    assertHostContext('backfillActive');
    if (!loaded) await loadGrants();
    // "No record in memory" only means "no record" once the store has been read: with the policy still
    // unread (a database error at boot) every plugin would look unrecorded, and the declared sets would
    // be written over what administrators stored.
    if (!loaded) {
        console.warn('[PluginPermissions] Grant backfill skipped: plugin_grants could not be read.');
        return [];
    }
    const done: string[] = [];
    for (const { slug, requested } of entries || []) {
        if (grants.has(slug)) continue; // already has an explicit grant record — respect the admin
        // Nothing declared ⇒ nothing to grandfather, and NO record either: memory mirrors the store. An
        // empty record made up here in memory alone would differ from what every node re-reads (the next
        // re-sync drops it again) and from what hasGrantRecord reports.
        if (!requested || !requested.length) { done.push(slug); continue; }
        if (!isSafeSlugKey(slug)) continue;
        // Grandfather what the manifest declared (admin can revoke) — INSERT-IF-ABSENT, decided on the row
        // read under the lease like every other policy write: a record stored since this node's load (an
        // administrator's decision on another node, an update's empty record) is kept, never replaced.
        const clean = cleanGrantTokens(slug, requested);
        let existing: string[] | null = null;
        await writePolicy(() => writePolicyBlob('plugin_grants',
            (stored) => {
                existing = grantRecordIn(stored, slug);
                if (existing !== null) return { changed: false };
                return { changed: true, next: grantStoreWith(stored, slug, clean) };
            },
            () => { grants.set(slug, new Set(existing !== null ? existing : clean)); }));
        if (existing === null) done.push(slug);
    }
    if (done.length) console.log(`[PluginPermissions] Backfilled manifest grants for already-active plugins: ${done.join(', ')} (default-deny applies to new activations).`);
    return done;
}

/**
 * Has this process read the stored grants at least once (loadGrants)? Until it has, "no record in
 * memory" says nothing about the store — and the boot backfill, which runs first, has skipped.
 */
function isGrantsLoaded(): boolean {
    return loaded;
}

/**
 * A one-time upgrade step's grant (core/plugins migrateBrowserCapabilityGrants): ADD `token` to the
 * plugin's grant record AS STORED — decided on the row read fresh under the policy lease and written
 * guarded on it (writePolicyBlob), like the boot backfill, never on this node's map:
 *   · a record that already holds the token is left alone;
 *   · a record an administrator has decided (ADMIN_DECISIONS_MARKER) is left alone, whatever it holds;
 *   · otherwise the token is added to the stored record, every other grant in it kept — or, for a plugin
 *     with no record, stored as its only grant.
 * No administrator decision is recorded with it. Memory mirrors the row the decision was taken on.
 * Returns whether it added the token.
 */
async function addUpgradeGrant(slug: string, token: string): Promise<boolean> {
    assertHostContext('addUpgradeGrant');
    if (!isSafeSlugKey(slug)) writeSlugKey({}, slug, []); // throws the descriptive error
    const clean = cleanGrantTokens(slug, [token]);
    if (clean.length !== 1) throw new Error(`Refusing to grant a malformed token to '${logSafeKey(slug)}'.`);
    let added = false;
    let record: string[] | null = null;
    await writePolicy(() => writePolicyBlob('plugin_grants',
        (stored) => {
            const existing = grantRecordIn(stored, slug);
            added = !(existing && existing.includes(clean[0])) && !hasAdminDecisionIn(stored, slug);
            record = added ? Array.from(new Set([...(existing || []), clean[0]])) : existing;
            if (!added) return { changed: false };
            return { changed: true, next: grantStoreWith(stored, slug, record as string[]) };
        },
        () => {
            if (record) grants.set(slug, new Set(record));
            else grants.delete(slug);
        }));
    return added;
}

/**
 * Remove a plugin's grants entirely (on uninstall). Without this, DELETE left stored[slug] in the
 * plugin_grants option, so re-uploading the same slug silently INHERITED the old (possibly revoked)
 * grants — a real security surprise. Clears the in-memory mirror and the persisted record, the
 * administrator decision recorded with it, and the egress allowlist.
 */
async function removeGrants(slug: string): Promise<void> {
    // Persist first, then drop the mirror (see "ONE ORDER"). Also clears the egress allowlist so
    // re-uploading the same slug can't silently inherit an old policy.
    const fanOuts = await serializePolicy(async () => {
        const g = await writePolicyBlob('plugin_grants', (stored) => grantStoreWithout(stored, slug), () => { grants.delete(slug); });
        const e = await writePolicyBlob('plugin_egress_hosts', (stored) => deleteSlugKey(stored, slug), () => { egressHosts.delete(slug); });
        return [g.announced, e.announced];
    });
    await Promise.all(fanOuts);
}

/** Read one host marker from the grant store, as stored now (null when absent). Throws on a DB error. */
async function getHostMarker(name: string): Promise<any> {
    const { stored } = await readPolicyOption('plugin_grants');
    const rec = hostRecordOf(stored);
    return Object.hasOwn(rec, name) ? rec[name] : null;
}

/** Write one host marker into the grant store — a policy write like any other. Host context only. */
async function setHostMarker(name: string, value: any): Promise<void> {
    assertHostContext('setHostMarker');
    if (FORBIDDEN_KEYS.has(name)) throw new Error(`Refusing to store a host marker under ${JSON.stringify(name)}`);
    return writePolicy(() => writePolicyBlob('plugin_grants',
        (stored) => {
            const next = copyStore(stored);
            const rec = hostRecordCopy(stored);
            rec[name] = value;
            next[HOST_RECORD_KEY] = rec;
            return { changed: true, next };
        },
        () => { /* the host record is not a plugin's grants: nothing to mirror */ }));
}

/** Has an administrator decided this plugin's grants (see ADMIN_DECISIONS_MARKER)? As stored now. */
async function hasAdminGrantDecision(slug: string): Promise<boolean> {
    const { stored } = await readPolicyOption('plugin_grants');
    return hasAdminDecisionIn(stored, slug);
}

// Distinguishes "policy loaded successfully" from "load failed / not yet loaded" (audit F-06). A DB/options
// failure while reading plugin_egress_hosts must NOT silently widen a network-granted plugin from its
// configured host set to allow-all-public: when this is false, the spawn path (plugin-isolate) ships a
// deny-all egress signal so the plugin reaches ZERO public hosts (private/loopback are blocked regardless)
// — fail CLOSED — instead of the whole internet. A genuinely-empty policy ({}) is a SUCCESSFUL load and
// keeps today's allow-all-public behavior, so no regression for plugins that never configured a list.
let egressPolicyLoaded = false;

/**
 * Load the persisted per-plugin egress allowlists into memory. Runs at boot, after the DB is up, and again
 * whenever core/coherence.ts re-syncs (a peer's change, or the periodic catch-up).
 *
 * A READ FAILURE is handled differently before and after the first good load:
 *   · never loaded (boot) ⇒ egressPolicyLoaded stays FALSE and network-granted plugins spawn deny-all
 *     (F-06). Until this read was strict that branch was unreachable for the case it was written for: a
 *     database error came back from getOption() as `{}` — a "successful", empty policy — so a plugin
 *     with an allowlist got the whole public internet instead of nothing.
 *   · already loaded (a re-sync) ⇒ the last-known-good allowlists stay in force. Flipping to deny-all on
 *     every transient read error of a 10 s re-sync would respawn every network plugin twice per blip.
 */
async function loadEgressHosts(): Promise<void> {
    return serializePolicy(loadEgressHostsUnlocked);
}

async function loadEgressHostsUnlocked(): Promise<void> {
    try {
        const { stored } = await readPolicyOption('plugin_egress_hosts');
        egressHosts.clear();
        for (const [slug, list] of Object.entries(stored)) {
            if (!isSafeSlugKey(slug)) {
                warnMalformedOnce(`egress-key\u0000${String(slug)}`, "[PluginPermissions] Dropping egress record under an unsafe plugin key '%s' from plugin_egress_hosts.", logSafeKey(slug));
                continue;
            }
            const record = egressRecordOf(slug, list);
            if (record) egressHosts.set(slug, record);
        }
        egressPolicyLoaded = true; // populated cleanly (an empty {} is a valid, successfully-loaded policy)
    } catch (e: any) {
        // Not touched here: still FALSE if no load ever succeeded (fail CLOSED — the spawn path denies
        // egress for network plugins until a re-sync loads it), still the last-known-good policy otherwise.
        console.warn(egressPolicyLoaded
            ? '[PluginPermissions] Failed to re-read plugin_egress_hosts (the allowlists already in memory stay in force):'
            : '[PluginPermissions] Failed to load plugin_egress_hosts option (egress fails CLOSED for network-granted plugins until it loads):', e && e.message);
    }
}

/** True once loadEgressHosts() has populated the policy without error. False ⇒ spawn path fails egress CLOSED. */
function isEgressPolicyLoaded(): boolean { return egressPolicyLoaded; }

/** The egress allowlist for a plugin (for the admin API and the spawn-time childCfg). Empty = allow-all. */
function getEgressAllowlist(slug: string): string[] {
    return Array.from(egressHosts.get(slug) || []);
}

/**
 * Replace a plugin's egress allowlist (admin action). Persists to `plugin_egress_hosts` + mirrors in
 * memory, and resolves once the `updated_option` subscribers have been told. Same no-self-grant guard as
 * setGrants: a plugin/theme context may NEVER widen its own egress.
 */
async function setEgressAllowlist(slug: string, hosts: string[]): Promise<void> {
    assertHostContext('setEgressAllowlist');
    const { announced } = await applyEgressAllowlist(slug, hosts);
    await announced;
}

/**
 * setEgressAllowlist() without the wait for the hook fan-out — the egress twin of applyGrants(): resolves
 * once the allowlist is persisted and in memory (what a respawned child is given), with the fan-out as
 * `announced`. The egress-hosts route respawns the child before waiting for it.
 *
 * `narrowOnly` (an API token's write): a list that would let the plugin reach a host its STORED allowlist
 * does not cover — '*' for every public host — is not written, and `refused` names those hosts. While
 * this node failed to load the stored policy the plugin is held here at deny-all (loadEgressHosts), so
 * then every such write adds something.
 */
async function applyEgressAllowlist(slug: string, hosts: string[], opts: { narrowOnly?: boolean } = {}): Promise<PolicyWriteResult> {
    assertHostContext('applyEgressAllowlist');
    const clean = normalizeEgressHosts(hosts);
    if (!isSafeSlugKey(slug)) writeSlugKey({}, slug, clean); // key gate first: no silent __proto__ no-op
    if (opts.narrowOnly && !egressPolicyLoaded) {
        return { announced: Promise.resolve(), refused: clean.length ? clean : [EGRESS_EVERY_PUBLIC_HOST] };
    }
    let refused: string[] = [];
    const { announced } = await serializePolicy(() => writePolicyBlob('plugin_egress_hosts',
        (stored) => {
            refused = opts.narrowOnly ? egressHostsAddedTo(egressRecordIn(stored, slug) || [], clean) : [];
            if (refused.length) return { changed: false };
            return { changed: true, next: writeSlugKey(stored, slug, clean) };
        },
        () => { if (!refused.length) egressHosts.set(slug, clean); }));
    return { announced, refused };
}

/**
 * A plugin's policy AS STORED NOW — grants and egress allowlist, each read fresh from the database —
 * ADOPTED into this node's maps before it is returned (serialized like every other load: see "ONE
 * ORDER"). For the places that START a plugin from a request a node a re-sync behind may serve: a token's
 * activation (routes/plugins.ts), and an in-place update or its rollback, which never rewrite either
 * record (the update's one grant write is ensureGrantRecord's, for a plugin with none). The question "would activating it seed its declared grants?" must not be answered by a mirror
 * another node's revoke has not reached, and the plugin it then starts here must run with what is stored
 * — the spawn ships this node's copy to the child (plugin-isolate childCfg) — not with the grant that was
 * revoked or the list that was narrowed. No record stays no record in memory too. The node-wide "policy
 * failed to load" state is not touched: while it holds, the spawn still denies every public host whatever
 * the list says. A database error is thrown.
 */
async function adoptStoredPolicy(slug: string): Promise<{ grants: string[]; egress: string[]; seedsDeclaredGrants: boolean }> {
    assertHostContext('adoptStoredPolicy');
    return serializePolicy(async () => {
        const g = await readPolicyOption('plugin_grants');
        const e = await readPolicyOption('plugin_egress_hosts');
        const record = grantRecordIn(g.stored, slug);
        const egress = egressRecordIn(e.stored, slug);
        if (isSafeSlugKey(slug)) {
            if (record) grants.set(slug, new Set(record)); else grants.delete(slug);
            if (egress) egressHosts.set(slug, egress); else egressHosts.delete(slug);
        }
        return {
            grants: record ? Array.from(new Set(record)) : [],
            egress: egress || [],
            seedsDeclaredGrants: shouldSeedDeclaredGrants(slug, record, hasAdminDecisionIn(g.stored, slug)),
        };
    });
}

/**
 * The policy an isolate of `slug` is spawned with, as one comparable string: its full grant set (a
 * respawn re-registers routes and re-evaluates host-capability gates, exactly what the permission route's
 * local reload does), and — for a network-granted plugin — the egress allowlist and the deny-all state
 * that go into the child's cfg. core/plugin-isolate.ts records it at every spawn; core/coherence.ts
 * respawns a running child whose recorded value no longer equals the current one.
 */
function policyFingerprint(slug: string): string {
    const g = getGrants(slug).sort();
    const net = isNetworkGranted(slug);
    const denyAll = net && !egressPolicyLoaded;
    const hosts = (net && !denyAll) ? getEgressAllowlist(slug).sort() : [];
    return JSON.stringify([g, hosts, denyAll]);
}

// Test-only: set a plugin's grants in memory WITHOUT persisting, so unit tests can grant the
// permissions a default-deny bridge now requires, with no DB dependency.
function _setGrantsInMemory(slug: string, tokens: string[]): void {
    // Same escalation vector as setGrants: ungated in-memory grant. Never callable from plugin/theme
    // context (test/host only) — an in-process theme could otherwise silently grant itself any cap (#9).
    assertHostContext('_setGrantsInMemory');
    grants.set(slug, new Set(requestedGrantTokens(tokens)));
}

// Test-only: install a plugin's egress allowlist in memory (no DB) AND mark the policy as loaded, so
// unit tests can exercise allowlist-governed bridges. Same plugin-context guard as _setGrantsInMemory.
function _setEgressAllowlistInMemory(slug: string, hosts: string[]): void {
    assertHostContext('_setEgressAllowlistInMemory');
    egressHosts.set(slug, normalizeEgressHosts(hosts));
    egressPolicyLoaded = true;
}

module.exports = {
    loadGrants, isGranted, isNetworkGranted, getGrants, hasGrantRecord,
    setGrants, applyGrants, shouldSeedDeclaredGrants, seedGrants, clearGrants, ensureGrantRecord, removeGrants, backfillActive,
    isGrantsLoaded, addUpgradeGrant,
    adoptStoredPolicy, policyFingerprint, NETWORK_TOKEN, _setGrantsInMemory, _setEgressAllowlistInMemory,
    loadEgressHosts, isEgressPolicyLoaded, getEgressAllowlist, setEgressAllowlist, applyEgressAllowlist,
    PLUGIN_SLUG, FORBIDDEN_KEYS, isSafeSlugKey, writeSlugKey,
    getHostMarker, setHostMarker, HOST_RECORD_KEY, hasAdminGrantDecision, ADMIN_DECISIONS_MARKER,
    grantsAddedTo, egressHostsAddedTo, EGRESS_EVERY_PUBLIC_HOST,
};

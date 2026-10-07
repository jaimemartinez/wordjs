/**
 * WordJS — THE SITE'S ADDRESSES: the one writer of "where does this site live".
 *
 * THE MODEL. One canonical "main address" (`siteUrl` in wordjs-config.json) is the only base for every
 * link built outside the browser: password-reset and verification emails, feeds, the sitemap, plugins'
 * `site.url()`, the mail domain. Any number of ALIASES (`siteAliases`) are addresses the site also
 * answers on — never a link base. IP literals and loopback are accepted by rule (core/host-policy).
 *
 * WHERE EACH VALUE LIVES, AND WHO WRITES IT.
 *   · wordjs-config.json is the master: siteUrl, siteAliases, hostPolicy, and siteAddress.{rev,lastChange,
 *     changes,retired}. Aliases live ONLY there, a file neither `PUT /settings` nor the plugin bridge can
 *     reach.
 *   · The options `siteurl`, `home` and `site_address_rev` are MIRRORS for the readers that have always
 *     read them (the SSR layout, plugins). Only this module writes them (and the installer, once).
 *   · Writers: `commit()` (the admin API in routes/site-address.ts, and the automatic upgrade below) and
 *     the server-side CLI (scripts/site-address.js), which writes only the file; the running backend
 *     notices the new revision and applies the rest (`checkExternalChange`), auditing every revision the
 *     CLI wrote from the bounded log the file carries (`siteAddress.changes`).
 *
 * WHAT A CHANGE DOES (commit, in order):
 *   1. compare-and-swap on `siteAddress.rev`, refuse on an unreadable file (REDTEAM R10), refuse to retire
 *      an address something still depends on unless forced (the interlock), then write the file atomically;
 *   2. refresh the runtime config and the host policy, so the gate answers the new set at once;
 *   3. write the mirrors in ONE database transaction — and if that fails, put the previous file bytes back
 *      and answer 500, so the file and the database never disagree about where the site lives;
 *   4. tell the gateway (split / separate) which addresses its edge answers and, when it moved, the main
 *      address, 5. purge the frontend caches, 6. audit, 7. notify every
 *      administrator in-app and by email (no links in the email — it must not be a phishing template).
 *
 * WHAT IS AUTOMATIC, AND WHY ONLY THAT.
 *   · An http → https move of the SAME host (REDTEAM R1): turning SSL on in split mode makes the gateway
 *     serve https, and leaving the main address on http would email every reset token as an http:// link
 *     a passive observer can read. Downgrades and host changes always need an administrator.
 *   · The upgrade of a legacy install (no siteAddress key) to revision 1, and the repair of the old
 *     /migrate corruption `https,http://host` — which only ever picks https (REDTEAM R5): "if in doubt,
 *     raise a conflict" beats silently turning token links into plain http.
 *   · Nothing is ever derived from a request. No value here comes from Host or X-Forwarded-Host.
 */

import type { SiteUrl, SiteHost, LastSeen, HostPolicy, PolicyProvider } from './host-policy';

const hostPolicy: typeof import('./host-policy') = require('./host-policy');
const configManager = require('./configManager');
const { logSafe } = require('./log-safe');

// ─── Constants ──────────────────────────────────────────────────────────────────────────────────────

/** Tunnel names are handed to the next customer when the tunnel restarts: a week, unless told otherwise. */
const TUNNEL_ALIAS_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** How recently an AUTHENTICATED request must have used an address for the interlock to protect it (R7). */
const INTERLOCK_WINDOW_MS = 10 * 60 * 1000;
/** Bounds on what an administrator can store; the list is read on every request by the gate. */
const MAX_ALIASES = 50;
const MAX_LABEL_LENGTH = 100;
/** Tags and paths a change of address invalidates: everything that may print an absolute URL. */
const PURGE_TAGS = ['settings', 'posts', 'menus', 'terms', 'taxonomies', 'comments', 'plugin-assets', 'fonts'];
const NOTICE_IDS = {
    conflict: 'site.address.conflict',
    gatewayDrift: 'site.address.gateway-drift',
    missingCanonical: 'site.address.missing-canonical',
    proxyCollapse: 'site.address.proxy-collapse',
} as const;
/** A legacy /migrate value: an X-Forwarded-Proto LIST pasted in front of `://`. */
const SCHEME_LIST_PREFIX = /^\s*(https?(?:\s*,\s*https?)+)\s*:\/\//i;

/**
 * How many revisions the config remembers in `siteAddress.changes`, the log the running backend audits
 * from (changesSince): every revision the CLI wrote between two watcher ticks, or while the backend was
 * stopped, gets its own audit row. Older ones are dropped; a run of revisions the log no longer holds is
 * audited as one `site.address.gap` row instead of disappearing.
 */
const MAX_CHANGE_LOG = 20;
/** How often a backend with a gateway re-sends its addresses (startGatewaySync), plus up to 20% jitter. */
const GATEWAY_SYNC_MS = 30 * 1000;
/** Bound on the edge refusals kept from the gateway's answers, as on every refusal list. */
const MAX_REFUSED = 32;

export type OldAddressAction = 'keep' | 'redirect' | 'drop';
/** Who or what made a change: the admin screen, the server CLI, one of the automatic paths, the installer. */
export type ChangeVia = 'ui' | 'cli' | 'repair' | 'upgrade' | 'gateway' | 'install';
export type ChangeKind = 'canonical' | 'aliases' | 'policy' | 'repair';
const CHANGE_KINDS: readonly string[] = ['canonical', 'aliases', 'policy', 'repair'];
const CHANGE_VIAS: readonly string[] = ['ui', 'cli', 'repair', 'upgrade', 'gateway', 'install'];

/** What a change does, computed from a config snapshot by one of the plan* functions. Pure data. */
export interface Plan {
    kind: ChangeKind;
    /** Top-level config keys to set. */
    patch: Record<string, unknown>;
    /** Hostnames this change stops answering on — what the interlock checks. */
    removedHosts: string[];
    /** The audit detail and the lastChange record: scalars and lists of scalars only. */
    summary: Record<string, unknown>;
    canonicalChanged: boolean;
    unchanged: boolean;
}

export interface Dependent {
    kind: 'gatewayUrl' | 'frontendUrl' | 'recent-use';
    host: string;
    detail: string;
}

export interface CommitResult {
    rev: number;
    unchanged?: boolean;
    warnings: string[];
}

/** A refusal with the HTTP answer the API gives for it. */
class SiteAddressError extends Error {
    status: number;
    code: string;
    data: Record<string, unknown>;
    constructor(status: number, code: string, message: string, data: Record<string, unknown> = {}) {
        super(message);
        this.name = 'SiteAddressError';
        this.status = status;
        this.code = code;
        this.data = data;
    }
}

const invalid = (message: string, params?: string[]) =>
    new SiteAddressError(400, 'rest_invalid_param', message, params ? { params } : {});

// ─── Reading ────────────────────────────────────────────────────────────────────────────────────────

function siteAddressRev(cfg: unknown): number {
    return configManager.siteAddressRev(cfg);
}

/**
 * THE MAIN ADDRESS, from the config — synchronous, so code with no request and no database (cron, the
 * plugin bridge's fallback, boot) can use it. The file is the master; while it cannot be read (a write in
 * progress), the runtime copy config/app loaded last is used instead of answering "no address". Null only
 * when neither holds a valid site address.
 */
function canonicalOrigin(): string | null {
    const fromFile = hostPolicy.parseSiteUrl((configManager.getConfig() || {}).siteUrl);
    if (fromFile) return fromFile.origin;
    try {
        const runtime = hostPolicy.parseSiteUrl(require('../config/app').siteUrl);
        return runtime ? runtime.origin : null;
    } catch {
        return null;
    }
}

/**
 * THE BASE OF EVERY LINK BUILT OUTSIDE THE BROWSER: the `siteurl` mirror, then `home`, then the main
 * address from the config, then `http://localhost` (the value these callers always fell back to).
 *
 * In steady state this IS canonicalOrigin() — commit() writes both. The mirror is read first so that an
 * unresolved upgrade conflict keeps emailing exactly the links it emailed before the upgrade, until an
 * administrator chooses. Each value must parse as a site address: a corrupted option can never become
 * the host of a password-reset link. It NEVER reads the request — a forged Host must not be able to
 * choose where a reset token is sent (SPEC §5, the reason this function exists).
 */
async function linkBase(): Promise<string> {
    const { getOption } = require('./options');
    for (const name of ['siteurl', 'home']) {
        const site = hostPolicy.parseSiteUrl(await getOption(name, null));
        if (site) return site.origin;
    }
    return canonicalOrigin() || 'http://localhost';
}

/** The hostname of linkBase() (`[::1]` keeps its brackets, as `new URL().hostname` always did). */
async function linkHostname(): Promise<string> {
    return new URL(await linkBase()).hostname;
}

interface ConfigAlias {
    /** The entry exactly as stored (a string or an object), kept so unknown fields survive a rewrite. */
    raw: any;
    site: SiteUrl | null;
}

function configAliases(cfg: any): ConfigAlias[] {
    const list = cfg && Array.isArray(cfg.siteAliases) ? cfg.siteAliases : [];
    return list.map((raw: any) => ({ raw, site: hostPolicy.parseSiteUrl(raw && typeof raw === 'object' ? raw.url : raw) }));
}

function isoAt(ms: number): string {
    return new Date(ms).toISOString();
}

function sourceFor(via: ChangeVia): string {
    return via === 'ui' ? 'admin' : via === 'cli' ? 'cli' : 'system';
}

/** Hostnames for audit rows and notifications: bounded, so a 50-entry change is still a small row. */
function hostList(hosts: string[]): string[] {
    return hosts.slice(0, 32);
}

// ─── Planning (pure: config snapshot in, Plan out) ─────────────────────────────────────────────────

function unchangedPlan(kind: ChangeKind): Plan {
    return { kind, patch: {}, removedHosts: [], summary: {}, canonicalChanged: false, unchanged: true };
}

/**
 * Make `url` the main address. The value comes from the caller's body or the CLI argument — never from
 * a request's Host. `oldAddress` decides what happens to the previous main address when its HOST changes:
 * kept as an alias (default), kept as a redirecting alias (phase 2 answers it with a 308), or dropped.
 *
 * REDTEAM R3: `frontendUrl` and `gatewayUrl` are rewritten when they named exactly the old main origin.
 * They were set to the install-time public origin by the wizard, and left behind they kept the retired
 * domain in credentialed CORS and kept SSR sending the admin's cookie there.
 */
function planCanonical(cfg: any, input: { url: unknown; oldAddress?: unknown; actorId?: number | null; via: ChangeVia; now: number }): Plan {
    const next = hostPolicy.parseSiteUrl(input.url);
    if (!next) {
        throw new SiteAddressError(400, 'rest_invalid_site_address',
            'Enter the address as http(s)://host[:port] — no path, user name, query, wildcard or list.', { params: ['url'] });
    }
    const oldAddress = input.oldAddress === undefined ? 'keep' : input.oldAddress;
    if (oldAddress !== 'keep' && oldAddress !== 'redirect' && oldAddress !== 'drop') {
        throw invalid('oldAddress must be keep, redirect or drop.', ['oldAddress']);
    }
    const current = hostPolicy.parseSiteUrl(cfg.siteUrl);
    if (current && current.origin === next.origin) {
        // A config with no revision has never been reconciled — and while an upgrade CONFLICT is pending
        // it cannot have one (raiseConflict runs only on such a config, and any change applied since
        // ends the conflict: see afterChange). So naming the address the file already holds is a choice
        // here, the "Use A" of the conflict banner and `npm run site -- canonical <config's url>`: it is
        // recorded as revision 1, and the mirrors then name it too. It used to be "nothing to change",
        // which left the database's address in every link with no way to pick the file's (lab finding).
        if (siteAddressRev(cfg) > 0) return unchangedPlan('canonical');
        return {
            kind: 'canonical',
            patch: { siteUrl: next.origin },
            removedHosts: [],
            summary: { from: current.origin, to: next.origin, oldAddress, rewritten: [], confirmed: true },
            canonicalChanged: true,
            unchanged: false,
        };
    }

    // The new main host is answered as the canonical from now on; an alias entry for it would only be
    // ignored (with a warning) by the policy, so it leaves the list.
    let aliases = configAliases(cfg).filter((a) => !a.site || a.site.hostname !== next.hostname);
    const removedHosts: string[] = [];
    if (current && current.hostname !== next.hostname) {
        const existing = aliases.find((a) => a.site && a.site.hostname === current.hostname);
        if (oldAddress === 'drop') {
            aliases = aliases.filter((a) => a !== existing);
            removedHosts.push(current.hostname);
        } else {
            const mode = oldAddress === 'redirect' ? 'redirect' : 'serve';
            if (existing) {
                existing.raw = { ...(typeof existing.raw === 'object' ? existing.raw : { url: current.origin }), mode };
            } else {
                aliases.push({
                    site: current,
                    raw: {
                        url: current.origin,
                        mode,
                        label: 'Previous main address',
                        source: sourceFor(input.via),
                        ...(typeof input.actorId === 'number' ? { addedBy: input.actorId } : {}),
                        addedAt: isoAt(input.now),
                    },
                });
            }
        }
    }

    const patch: Record<string, unknown> = { siteUrl: next.origin, siteAliases: aliases.map((a) => a.raw) };
    const rewritten: string[] = [];
    if (current) {
        for (const key of ['frontendUrl', 'gatewayUrl']) {
            const value = hostPolicy.parseSiteUrl(cfg[key]);
            if (value && value.origin === current.origin) {
                patch[key] = next.origin;
                rewritten.push(key);
            }
        }
    }
    const from = current ? current.origin : (typeof cfg.siteUrl === 'string' ? cfg.siteUrl.slice(0, 200) : null);
    return {
        kind: 'canonical',
        patch,
        removedHosts,
        summary: { from, to: next.origin, oldAddress, rewritten },
        canonicalChanged: true,
        unchanged: false,
    };
}

/** The same move, recorded as an automatic repair (R1 upgrade, R5 salvage) rather than an admin choice. */
function planRepair(cfg: any, url: string, reason: string, now: number): Plan {
    const plan = planCanonical(cfg, { url, oldAddress: 'keep', actorId: null, via: 'repair', now });
    return { ...plan, kind: 'repair', summary: { ...plan.summary, reason } };
}

function aliasFields(raw: any) {
    const r = raw && typeof raw === 'object' ? raw : { url: raw };
    return {
        url: hostPolicy.parseSiteUrl(r.url)?.origin ?? null,
        mode: r.mode === 'redirect' ? 'redirect' : 'serve',
        label: typeof r.label === 'string' ? r.label : null,
        signIn: typeof r.signIn === 'boolean' ? r.signIn : null,
        expiresAt: typeof r.expiresAt === 'string' && !Number.isNaN(Date.parse(r.expiresAt)) ? Date.parse(r.expiresAt) : null,
    };
}

function sameAlias(a: any, b: any): boolean {
    return JSON.stringify(aliasFields(a)) === JSON.stringify(aliasFields(b));
}

/**
 * Replace the whole alias list (PUT /aliases, `npm run site -- add|remove`). Every entry is validated
 * with the same parser the gate uses; who added an existing entry and when is kept from the stored
 * record, never taken from the caller.
 *
 * Two defaults apply to NEWLY added names only — an existing entry keeps exactly what it has, so an
 * administrator who cleared a tunnel's expiry is not overruled on the next unrelated save:
 *   · a tunnel name expires after a week (the name is reassigned to strangers when the tunnel restarts);
 *   · a `.local` name needs `confirmLocal` — anyone on the LAN can answer mDNS for it.
 * Wildcards, CIDRs and suffixes are refused by the parser: a dangling subdomain would become an
 * attacker's DNS-rebinding name.
 */
function planAliases(cfg: any, input: { aliases: unknown; confirmLocal?: unknown; actorId?: number | null; via: ChangeVia; now: number }): Plan {
    if (!Array.isArray(input.aliases)) throw invalid('aliases must be a list of addresses.', ['aliases']);
    if (input.aliases.length > MAX_ALIASES) throw invalid(`At most ${MAX_ALIASES} other addresses can be stored.`, ['aliases']);
    const canonical = hostPolicy.parseSiteUrl(cfg.siteUrl);
    const stored = configAliases(cfg);
    const storedByHost = new Map<string, ConfigAlias>();
    for (const a of stored) if (a.site && !storedByHost.has(a.site.hostname)) storedByHost.set(a.site.hostname, a);

    const seen = new Set<string>();
    const added: string[] = [];
    const changed: string[] = [];
    const out: Record<string, unknown>[] = [];
    input.aliases.forEach((item: unknown, i: number) => {
        const where = `aliases[${i}]`;
        const raw: any = typeof item === 'string' ? { url: item } : item;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`${where} is not an address entry.`, [where]);
        const site = hostPolicy.parseSiteUrl(raw.url);
        if (!site) {
            throw new SiteAddressError(400, 'rest_invalid_site_address',
                `${where} is not a site address: use http(s)://host[:port] — no path, user name, query, wildcard or list.`, { params: [where] });
        }
        if (canonical && site.hostname === canonical.hostname) throw invalid(`${site.hostname} is the main address already.`, [where]);
        if (seen.has(site.hostname)) throw invalid(`${site.hostname} is listed twice; addresses are matched by name, not port.`, [where]);
        seen.add(site.hostname);

        if (raw.mode !== undefined && raw.mode !== 'serve' && raw.mode !== 'redirect') throw invalid(`${where}.mode must be serve or redirect.`, [where]);
        if (raw.label !== undefined && raw.label !== null && typeof raw.label !== 'string') throw invalid(`${where}.label must be text.`, [where]);
        if (raw.signIn !== undefined && raw.signIn !== null && typeof raw.signIn !== 'boolean') throw invalid(`${where}.signIn must be true or false.`, [where]);
        let expiresAt: string | null | undefined;
        if (raw.expiresAt === null) expiresAt = null;
        else if (raw.expiresAt !== undefined) {
            const ms = typeof raw.expiresAt === 'string' ? Date.parse(raw.expiresAt) : NaN;
            if (Number.isNaN(ms)) throw invalid(`${where}.expiresAt must be a date and time.`, [where]);
            expiresAt = isoAt(ms);
        }

        const previous = storedByHost.get(site.hostname);
        if (!previous) {
            if (hostPolicy.isLanName(site.hostname) && input.confirmLocal !== true) {
                throw new SiteAddressError(400, 'rest_site_address_confirm_local',
                    `${site.hostname} is a .local name: anyone on your network can answer for it. Confirm to add it anyway.`, { params: [where] });
            }
            if (expiresAt === undefined && hostPolicy.isTunnelHost(site.hostname)) expiresAt = isoAt(input.now + TUNNEL_ALIAS_LIFETIME_MS);
        }
        const prev = previous && typeof previous.raw === 'object' ? previous.raw : {};
        // Control characters out, whitespace collapsed: a label is shown in the admin screen and the log.
        const label = typeof raw.label === 'string' ? raw.label.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH) : '';
        const entry: Record<string, unknown> = {
            url: site.origin,
            mode: raw.mode === 'redirect' ? 'redirect' : 'serve',
            ...(label ? { label } : {}),
            ...(typeof raw.signIn === 'boolean' ? { signIn: raw.signIn } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            source: typeof prev.source === 'string' ? prev.source : sourceFor(input.via),
            ...(previous
                ? (typeof prev.addedBy === 'number' ? { addedBy: prev.addedBy } : {})
                : (typeof input.actorId === 'number' ? { addedBy: input.actorId } : {})),
            addedAt: typeof prev.addedAt === 'string' ? prev.addedAt : isoAt(input.now),
        };
        if (!previous) added.push(site.hostname);
        else if (!sameAlias(previous.raw, entry)) changed.push(site.hostname);
        out.push(entry);
    });

    const removed = [...storedByHost.keys()].filter((h) => !seen.has(h));
    // Entries that never parsed are inert; a rewrite that drops them is still a change worth writing.
    const droppedInvalid = stored.length !== storedByHost.size;
    if (!added.length && !removed.length && !changed.length && !droppedInvalid) return unchangedPlan('aliases');
    return {
        kind: 'aliases',
        patch: { siteAliases: out },
        removedHosts: removed,
        summary: { added: hostList(added), removed: hostList(removed), changed: hostList(changed) },
        canonicalChanged: false,
        unchanged: false,
    };
}

/** Which IP literals the site answers on, and whether sessions may be minted on them (hostPolicy). */
function planPolicy(cfg: any, input: { ipLiterals: unknown; ipSignIn?: unknown }): Plan {
    if (input.ipLiterals !== 'any' && input.ipLiterals !== 'own' && input.ipLiterals !== 'none') {
        throw invalid('ipLiterals must be any, own or none.', ['ipLiterals']);
    }
    if (input.ipSignIn !== undefined && typeof input.ipSignIn !== 'boolean') throw invalid('ipSignIn must be true or false.', ['ipSignIn']);
    const current = cfg.hostPolicy && typeof cfg.hostPolicy === 'object' && !Array.isArray(cfg.hostPolicy) ? cfg.hostPolicy : {};
    const next = { ...current, ipLiterals: input.ipLiterals, ...(input.ipSignIn !== undefined ? { ipSignIn: input.ipSignIn } : {}) };
    if (current.ipLiterals === next.ipLiterals && current.ipSignIn === next.ipSignIn) return unchangedPlan('policy');
    return {
        kind: 'policy',
        patch: { hostPolicy: next },
        removedHosts: [],
        summary: {
            from: typeof current.ipLiterals === 'string' ? current.ipLiterals : 'default',
            to: next.ipLiterals,
            ipSignIn: next.ipSignIn === true,
            // What sign-in on IP addresses was before, so the notice can say whether it was switched.
            ipSignInFrom: current.ipSignIn === true,
        },
        canonicalChanged: false,
        unchanged: false,
    };
}

/**
 * THE INTERLOCK — what would break if these hosts stopped being answered. Judged on the config the change
 * WOULD write, so a frontendUrl / gatewayUrl that R3 rewrites in the same change no longer counts:
 *   · the host of gatewayUrl (the SSR base in split mode) or of frontendUrl (the purge target);
 *   · an AUTHENTICATED request on it within the last ten minutes. Only authenticated use counts (R7): an
 *     anonymous client must not be able to keep a retired address alive by requesting it.
 */
function interlock(nextConfig: any, removedHosts: string[], opts: { now: number; lastSeen?: LastSeen }): Dependent[] {
    const seen = opts.lastSeen || hostPolicy.lastSeen;
    const dependents: Dependent[] = [];
    for (const host of new Set(removedHosts)) {
        for (const key of ['gatewayUrl', 'frontendUrl'] as const) {
            const value = hostPolicy.parseSiteUrl(nextConfig[key]);
            if (value && value.hostname === host) dependents.push({ kind: key, host, detail: value.origin });
        }
        const use = seen.get(host);
        if (use && use.authenticatedAt !== null && opts.now - use.authenticatedAt < INTERLOCK_WINDOW_MS) {
            dependents.push({ kind: 'recent-use', host, detail: isoAt(use.authenticatedAt) });
        }
    }
    return dependents;
}

/**
 * What applyPlan needs besides the two configs to know which addresses a change stops answering: the
 * same inputs core/host-policy buildPolicy reads. The REST commit passes this process's environment and
 * NODE_ENV, the CLI its own; both pass publicOwnAddresses as `ownAddresses` (the gateway's addresses
 * when one fronts the site); left out, it is this machine's interfaces.
 */
interface PolicyInputs {
    env?: Record<string, string | undefined>;
    nodeEnv?: string;
    ownAddresses?: () => Set<string>;
}

/** Who made a change and how: what applyPlan records with it, and what its audit row says. */
interface ChangeMeta extends PolicyInputs {
    via: ChangeVia;
    actorId: number | null;
    now: number;
    /** The caller asked to override the interlock (`--force`, "Change anyway"). */
    force?: boolean;
    /** What the override went past (describeDependents), when anything did. */
    forcedPast?: string[] | null;
}

/** The complete config a plan produces from `current`: the patch, the next revision and its record. */
function applyPlan(current: any, plan: Plan, meta: ChangeMeta): Record<string, any> {
    const previous = current.siteAddress && typeof current.siteAddress === 'object' ? current.siteAddress : {};
    const patched = { ...current, ...plan.patch };
    // The retirement record travels in the same atomic write as the change itself, so the gate of every
    // process (and the CLI's next run) sees the addresses and the sessions they ended together.
    const { retired: _previousRecord, changes: previousChanges, ...kept } = previous;
    const retired = retiredRecord(current, patched, meta);
    const rev = siteAddressRev(current) + 1;
    // The revision's record, as lastChange and appended to the bounded log the running backend audits
    // every revision from (changesSince) — the CLI cannot reach the database, so this IS its audit trail
    // until the backend applies it.
    const record = changeRecord(eventFor(plan, meta, rev));
    const log = (Array.isArray(previousChanges) ? previousChanges : []).filter((e: unknown) => e && typeof e === 'object' && !Array.isArray(e));
    return {
        ...patched,
        siteAddress: {
            ...kept,
            rev,
            lastChange: record,
            changes: [...log, record].slice(-MAX_CHANGE_LOG),
            ...(retired ? { retired } : {}),
        },
        updatedAt: isoAt(meta.now),
    };
}

// ─── The change log: every revision is audited, however quickly they came ─────────────────────────

/** One revision: who and how (never taken from the file for a change made outside this process), and the planner's summary. */
interface ChangeEvent {
    rev: number;
    kind: ChangeKind;
    via: ChangeVia;
    by: number | null;
    at: string;
    force: boolean;
    forcedPast: string[] | null;
    summary: Record<string, unknown>;
}

/** Revisions the log no longer holds (pruned, or written by something that kept no log). */
interface ChangeGap {
    from: number;
    to: number;
    revisions: number;
}

const RECORD_KEYS = new Set(['rev', 'kind', 'via', 'by', 'at', 'force', 'forcedPast']);

function eventFor(plan: Plan, meta: ChangeMeta, rev: number): ChangeEvent {
    return {
        rev,
        kind: plan.kind,
        via: meta.via,
        by: meta.actorId,
        at: isoAt(meta.now),
        force: meta.force === true,
        forcedPast: meta.forcedPast && meta.forcedPast.length ? hostList(meta.forcedPast) : null,
        summary: plan.summary,
    };
}

/** The stored form: flat, so lastChange keeps the shape `npm run site -- list` and the admin read. */
function changeRecord(e: ChangeEvent): Record<string, unknown> {
    return { kind: e.kind, via: e.via, by: e.by, at: e.at, rev: e.rev, force: e.force, ...(e.forcedPast ? { forcedPast: e.forcedPast } : {}), ...e.summary };
}

/** A stored record read back, with anything a hand edit could have broken left out; null if it is not one. */
function readChange(raw: any): ChangeEvent | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!Number.isInteger(raw.rev) || raw.rev < 1 || !CHANGE_KINDS.includes(raw.kind)) return null;
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (RECORD_KEYS.has(key)) continue;
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) summary[key] = value;
        else if (Array.isArray(value)) summary[key] = hostList(value.filter((v) => typeof v === 'string'));
    }
    const forcedPast = Array.isArray(raw.forcedPast) ? hostList(raw.forcedPast.filter((v: unknown) => typeof v === 'string')) : [];
    return {
        rev: raw.rev,
        kind: raw.kind,
        via: CHANGE_VIAS.includes(raw.via) ? raw.via : 'cli',
        by: typeof raw.by === 'number' ? raw.by : null,
        at: typeof raw.at === 'string' ? raw.at : '',
        force: raw.force === true,
        forcedPast: forcedPast.length ? forcedPast : null,
        summary,
    };
}

/** Records that number a revision without being an address change: the installer's, the legacy upgrade's. */
function isBookkeeping(raw: any): boolean {
    return raw.kind === 'install' || raw.via === 'install' || raw.via === 'upgrade';
}

/**
 * The revisions in (afterRev, the file's rev], oldest first, from `siteAddress.changes` — and the ones it
 * does not cover, as gaps (one per run of consecutive revisions). lastChange describes the file's own
 * revision when the log does not: a file written before the log existed, or by a writer that keeps none
 * (an older CLI, which writes lastChange without a revision and carries the log over untouched). A change
 * applied from the FILE is never attributed to a user (`by` null): whoever can write the file can write
 * any name in it.
 */
function changesSince(cfg: any, afterRev: number): { events: ChangeEvent[]; gaps: ChangeGap[] } {
    const rev = siteAddressRev(cfg);
    if (rev <= afterRev) return { events: [], gaps: [] };
    const sa = cfg && cfg.siteAddress && typeof cfg.siteAddress === 'object' ? cfg.siteAddress : {};
    const last = sa.lastChange && typeof sa.lastChange === 'object' ? sa.lastChange : null;
    const raw: any[] = Array.isArray(sa.changes) ? sa.changes.slice() : [];
    if (last && (!Number.isInteger(last.rev) || last.rev === rev) && !raw.some((e) => e && typeof e === 'object' && e.rev === rev)) {
        raw.push({ ...last, rev });
    }
    const covered = new Set<number>();
    const byRev = new Map<number, ChangeEvent>();
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.rev) || entry.rev <= afterRev || entry.rev > rev) continue;
        if (isBookkeeping(entry)) {
            covered.add(entry.rev);
            continue;
        }
        const event = readChange(entry);
        if (!event) continue;
        covered.add(event.rev);
        byRev.set(event.rev, { ...event, by: null });
    }
    const events = [...byRev.values()].sort((a, b) => a.rev - b.rev);
    // The runs between covered revisions (walked over the covered ones, never revision by revision: a
    // hand-edited revision can be any number).
    const gaps: ChangeGap[] = [];
    let next = afterRev + 1;
    for (const r of [...covered].sort((a, b) => a - b)) {
        if (r > next) gaps.push({ from: next, to: r - 1, revisions: r - next });
        next = r + 1;
    }
    if (next <= rev) gaps.push({ from: next, to: rev, revisions: rev - next + 1 });
    return { events, gaps };
}

/** The interlock's dependents an override went past, as the audit row and the CLI name them. */
function describeDependents(dependents: Dependent[]): string[] {
    return hostList(dependents.map((d) => `${d.kind} ${d.kind === 'recent-use' ? d.host : d.detail}`));
}

// ─── Retired addresses: the sessions a change ended stay ended ─────────────────────────────────────

/**
 * WHY A RECORD (lab finding S6.6 / N2). A session is bound to the address it was minted on (`mh`, see
 * middleware/auth.ts), and the gate used to judge that claim against the CURRENT policy only. Removing
 * an alias ended its sessions, and adding the name back brought every one of them back, cookies held by
 * whoever had the name in between included, and /auth/refresh then extended them indefinitely. So a
 * change that stops answering an address records WHEN, in `siteAddress.retired` of the config file:
 *
 *   hosts        { hostname: unix seconds } — an alias removed, the old main address dropped, an alias
 *                that had expired by the time it was edited or removed (recorded at its expiry);
 *   ipLiterals   [{ at, kept }] — the IP-address rule narrowed (any → own, any/own → none): every IP
 *                session minted until then ends, except on the IPs still answered right after the change
 *                (`kept`: the public edge's own addresses under `own` — publicOwnAddresses — and IPs
 *                declared as the main address, an alias or a WORDJS_ALLOWED_HOSTS entry), which never
 *                stopped being accepted;
 *   overflow     unix seconds — only when the caps below were exceeded: every bound session minted until
 *                then ends (fail closed instead of forgetting a retirement).
 *
 * A session whose `mh` was retired at or after its `iat` is refused for good (sessionRetired), even once
 * the address is accepted again. Only names that STOPPED being accepted are recorded: an address that is
 * still answered by another rule (an IP alias removed while every IP is accepted, an alias that is also a
 * WORDJS_ALLOWED_HOSTS entry) keeps its sessions, exactly as it keeps serving. Changes that do not go
 * through this writer (environment variables, a hand edit of the file) record nothing; their sessions
 * stop while the name is refused and come back with it.
 */
const RETIREMENT_RANK: Record<string, number> = { none: 0, own: 1, any: 2 };
/**
 * How long a retirement is remembered. It only matters for tokens issued before it, and a session JWT
 * lives config/app `jwt.expiresIn` (2 h); a refresh mints a NEW token, which the presented one must
 * already pass. Kept for the 7-day life of the session cookie instead, so raising the JWT lifetime can
 * never make pruning forget a retirement a live token still needs (tests/host-gate pins both bounds).
 */
const RETIRED_SESSION_RETENTION_S = 7 * 24 * 60 * 60;
/**
 * Tokens issued up to this long AFTER the recorded instant also count as retired. Another process (the
 * running backend, after a CLI write) applies the change only when its config cache revalidates (2 s,
 * core/configManager), and could mint a session on the address in that window.
 */
const RETIREMENT_GRACE_S = 5;
const MAX_RETIRED_HOSTS = 1000;
const MAX_RETIRED_IP_EVENTS = 50;
const MAX_KEPT_IPS = 256;

interface RetiredRecord {
    hosts: Record<string, number>;
    ipLiterals: Array<{ at: number; kept: string[] }>;
    overflow?: number;
}

const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** The stored record, with anything malformed (a hand edit) left out rather than trusted. */
function readRetired(raw: any): RetiredRecord {
    const out: RetiredRecord = { hosts: {}, ipLiterals: [] };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    if (raw.hosts && typeof raw.hosts === 'object' && !Array.isArray(raw.hosts)) {
        for (const [host, at] of Object.entries(raw.hosts)) if (host && isSeconds(at)) out.hosts[host] = at;
    }
    if (Array.isArray(raw.ipLiterals)) {
        for (const ev of raw.ipLiterals) {
            if (ev && isSeconds(ev.at) && Array.isArray(ev.kept)) out.ipLiterals.push({ at: ev.at, kept: ev.kept.filter((h: unknown) => typeof h === 'string') });
        }
    }
    if (isSeconds(raw.overflow)) out.overflow = raw.overflow;
    return out;
}

/**
 * The record `next` must carry: the previous one, pruned, plus what this change retires. Pure apart from
 * `ownAddresses` (the writers pass publicOwnAddresses; this machine's interfaces when not given).
 * Undefined when there is nothing to keep.
 */
function retiredRecord(current: any, next: any, meta: { now: number } & PolicyInputs): RetiredRecord | undefined {
    const nowS = Math.floor(meta.now / 1000);
    const live = (at: number) => at + RETIRED_SESSION_RETENTION_S > nowS;
    const previous = readRetired(current.siteAddress && current.siteAddress.retired);
    const record: RetiredRecord = { hosts: {}, ipLiterals: previous.ipLiterals.filter((ev) => live(ev.at)) };
    for (const [host, at] of Object.entries(previous.hosts)) if (live(at)) record.hosts[host] = at;
    if (previous.overflow !== undefined && live(previous.overflow)) record.overflow = previous.overflow;
    const retire = (host: string, at: number) => {
        if (live(at)) record.hosts[host] = Math.max(record.hosts[host] || 0, at);
    };

    const inputs = {
        env: meta.env || process.env,
        nodeEnv: meta.nodeEnv || process.env.NODE_ENV || current.nodeEnv || 'production',
        ...(meta.ownAddresses ? { ownAddresses: meta.ownAddresses } : {}),
    };
    const before: HostPolicy = hostPolicy.buildPolicy({ ...inputs, config: current });
    const after: HostPolicy = hostPolicy.buildPolicy({ ...inputs, config: next });
    const ctx = { now: meta.now };
    const accepted = (hostname: string, policy: HostPolicy) => hostPolicy.classify(hostPolicy.parseHost(hostname), policy, ctx).cls !== 'unknown';

    // Declared names: the main address and every alias the site answered on before this change.
    const declared = new Map<string, number | null>();
    if (before.canonical) declared.set(before.canonical.hostname, null);
    for (const alias of before.aliases.values()) declared.set(alias.hostname, alias.expiresAt);
    for (const [hostname, expiresAt] of declared) {
        if (!accepted(hostname, before)) {
            // An alias that had already expired: nothing can have been minted on it since its expiry,
            // and editing or removing it must not let the sessions it had come back.
            if (expiresAt !== null) retire(hostname, Math.floor(expiresAt / 1000));
        } else if (!accepted(hostname, after)) {
            retire(hostname, nowS);
        }
    }

    // The IP-address rule narrowed: the retired IPs are not enumerable, so the event records the
    // exceptions instead — every IP still answered once the change is made.
    if ((RETIREMENT_RANK[after.ipLiterals] ?? 2) < (RETIREMENT_RANK[before.ipLiterals] ?? 2)) {
        const candidates = [
            ...(after.canonical ? [after.canonical.hostname] : []),
            ...[...after.aliases.values()].map((a) => a.hostname),
            ...[...after.envHosts.values()].map((e) => e.hostname),
            ...(after.ipLiterals === 'own' ? [...after.ownAddresses()] : []),
        ];
        const kept = new Set<string>();
        for (const hostname of candidates) {
            const p = hostPolicy.parseHost(hostname);
            if (p && p.kind !== 'dns' && accepted(hostname, after)) kept.add(p.hostname);
        }
        // Truncating `kept` only ends more sessions (fail closed).
        record.ipLiterals.push({ at: nowS, kept: [...kept].sort().slice(0, MAX_KEPT_IPS) });
    }

    // Bounded: past a cap the OLDEST entries fold into `overflow`, which ends every bound session minted
    // until then — never a retirement silently forgotten.
    const fold = (at: number) => { record.overflow = Math.max(record.overflow || 0, at); };
    const hostEntries = Object.entries(record.hosts).sort((a, b) => a[1] - b[1]);
    if (hostEntries.length > MAX_RETIRED_HOSTS) {
        for (const [host, at] of hostEntries.slice(0, hostEntries.length - MAX_RETIRED_HOSTS)) {
            fold(at);
            delete record.hosts[host];
        }
    }
    if (record.ipLiterals.length > MAX_RETIRED_IP_EVENTS) {
        record.ipLiterals.sort((a, b) => a.at - b.at);
        for (const ev of record.ipLiterals.splice(0, record.ipLiterals.length - MAX_RETIRED_IP_EVENTS)) fold(ev.at);
    }

    if (!Object.keys(record.hosts).length && !record.ipLiterals.length && record.overflow === undefined) return undefined;
    return record;
}

interface RetiredIndex {
    hosts: Map<string, number>;
    ipLiterals: Array<{ at: number; kept: Set<string> }>;
    overflow: number | null;
}

/** One index per config object: configManager.getConfig returns the same object until the file changes. */
const retiredIndexes = new WeakMap<object, RetiredIndex>();
let lastRetiredIndex: RetiredIndex | null = null;

function retiredIndex(opts: { fresh?: boolean } = {}): RetiredIndex | null {
    let cfg: any;
    if (opts.fresh) {
        // The file as it is NOW, not the 2-second cache (core/configManager): a record another process
        // (npm run site) wrote a moment ago counts at once. Unreadable or absent: the cache, as below.
        const current = configManager.readConfigFresh();
        if (current.exists && !current.parseError) cfg = current.parsed;
    }
    if (cfg === undefined) {
        try { cfg = configManager.getConfig(); } catch { cfg = null; }
    }
    // REDTEAM R10 parity with the policy provider: while the file is unreadable, keep the last record.
    if (!cfg || typeof cfg !== 'object') return lastRetiredIndex;
    let index = retiredIndexes.get(cfg);
    if (!index) {
        const record = readRetired(cfg.siteAddress && cfg.siteAddress.retired);
        index = {
            hosts: new Map(Object.entries(record.hosts)),
            ipLiterals: record.ipLiterals.map((ev) => ({ at: ev.at, kept: new Set(ev.kept) })),
            overflow: record.overflow ?? null,
        };
        retiredIndexes.set(cfg, index);
    }
    lastRetiredIndex = index;
    return index;
}

/**
 * Was the address this session was minted on (`mh`) retired at or after the session was issued (`iat`,
 * JWT seconds)? Then the session stays ended even though the address may be accepted again. A token
 * without a readable `iat` counts as issued before every retirement (fail closed).
 */
function sessionRetired(mh: string, iat: unknown): boolean {
    return sessionRetiredUntil(mh, iat) !== null;
}

/**
 * sessionRetired, with WHEN it stops holding: the first JWT second (`iat`) a session minted on `mh` is no
 * longer covered by any retirement (the latest covering instant plus the grace, plus one), or null when
 * none covers this one. Sign-in uses it (middleware/auth.ts refuseRetiringSession): a session minted in
 * the grace window after a retirement — the address added back, or the IP policy widened again, within
 * those seconds — would be refused by the very next request, so none is issued then (lab finding
 * R2V-M-NF1). Sign-in passes `fresh`: the record is read from the file itself, so an address removed and
 * added back with `npm run site` inside one 2-second config-cache window, a removal this process never
 * saw, is not missed either (review R3S-2). Minting a session is rare, and the read is one small file.
 */
function sessionRetiredUntil(mh: string, iat: unknown, opts: { fresh?: boolean } = {}): number | null {
    const index = retiredIndex(opts);
    if (!index) return null;
    const issued = typeof iat === 'number' && Number.isFinite(iat) ? iat : -Infinity;
    let until: number | null = null;
    const cover = (at: number) => {
        if (issued <= at + RETIREMENT_GRACE_S) until = Math.max(until ?? -Infinity, at + RETIREMENT_GRACE_S + 1);
    };
    if (index.overflow !== null) cover(index.overflow);
    const at = index.hosts.get(mh);
    if (at !== undefined) cover(at);
    if (index.ipLiterals.length) {
        const p = hostPolicy.parseHost(mh);
        // Loopback never carries `mh`, and is accepted under every IP policy anyway.
        if (p && p.kind !== 'dns' && !hostPolicy.isLoopbackAuthority(p)) {
            for (const ev of index.ipLiterals) if (!ev.kept.has(p.hostname)) cover(ev.at);
        }
    }
    return until;
}

/**
 * R5 — the legacy /migrate corruption: X-Forwarded-Proto pasted as a LIST in front of `://`, e.g.
 * `https,http://example.com` (a TLS proxy in front of http-proxy appends its own scheme). The FIRST
 * element is the real edge; "keep the last" would pick the gateway's plain-http listener. So: https if
 * any element is https, and nothing at all otherwise — the caller raises a conflict instead of guessing.
 */
function salvageSiteUrl(raw: unknown): SiteUrl | null {
    if (typeof raw !== 'string') return null;
    const m = SCHEME_LIST_PREFIX.exec(raw);
    if (!m) return null;
    const schemes = m[1].split(',').map((s) => s.trim().toLowerCase());
    if (!schemes.includes('https')) return null;
    return hostPolicy.parseSiteUrl('https://' + raw.slice(m[0].length));
}

/** R1: the gateway serves the same host over https where the main address still says http. */
function isAutomaticUpgrade(current: SiteUrl, reported: SiteUrl): boolean {
    return current.scheme === 'http' && reported.scheme === 'https' && current.hostname === reported.hostname;
}

// ─── State shared by the boot path, the watcher and the API ────────────────────────────────────────

let conflict: { config: string; db: string } | null = null;
let gatewayDrift: { gateway: string; config: string } | null = null;
/** The config revision this process has fully applied (file, mirrors, effects). */
let lastAppliedRev: number | null = null;
let reconciled = false;
let resolveReconciled: () => void = () => { /* replaced below */ };
const reconciledPromise = new Promise<void>((resolve) => { resolveReconciled = resolve; });
let watcher: ReturnType<typeof setInterval> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** One change at a time in this process: the API, the watcher and the boot path never interleave. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
}

function policyProvider(): PolicyProvider {
    return require('../middleware/auth').siteHostPolicy;
}

function warn(message: string) {
    console.warn(`[site-address] ${logSafe(message)}`);
}

function notice(id: string, level: 'warning' | 'error', title: string, message: string) {
    try {
        require('./admin-notices').pushAdminNotice({ id, level, title, message }).catch(() => { /* never fatal */ });
    } catch { /* the log line carries it */ }
}

function clearNotice(id: string) {
    try {
        require('./admin-notices').clearAdminNotice(id).catch(() => { /* never fatal */ });
    } catch { /* nothing to clear */ }
}

function raiseConflict(value: { config: string; db: string }) {
    conflict = value;
    warn(`the configured main address (${value.config}) and the database (${value.db}) disagree; links keep using the database value until an administrator chooses (Settings > Site address, or npm run site -- canonical <url>).`);
    notice(NOTICE_IDS.conflict, 'warning', 'The site has two different main addresses.',
        'wordjs-config.json and the database name different main addresses. Links and emails keep using the database value until you choose one in Settings → Site address.');
}

function runtimeReload(cfg: any) {
    try { require('../config/app').reloadFromFile?.(cfg); } catch { /* not loaded yet */ }
}

// ─── The effects of a change ───────────────────────────────────────────────────────────────────────

/**
 * Mirrors in ONE transaction: siteurl/home and the revision move together or not at all. `addresses:
 * false` writes only the revision — the legacy upgrade of an install whose database already names the
 * same address, where rewriting `home` (the frontend's own origin on older split installs) would be a
 * change nobody asked for.
 *
 * `record` writes the audit rows of what is being applied, in the SAME transaction and before the
 * mirrors: the database's revision is what tells a restarted backend that nothing is left to apply, so a
 * process killed after it was committed (a gateway push can take seconds) used to lose those rows for
 * good (review PL-2). Now the revision and its rows are committed together, or neither is.
 */
async function writeMirrors(cfg: any, rev: number, opts: { addresses?: boolean; record?: () => Promise<void> } = {}): Promise<void> {
    const { dbAsync } = require('../config/database');
    const options = require('./options');
    const canonical = opts.addresses === false ? null : hostPolicy.parseSiteUrl(cfg.siteUrl);
    await dbAsync.transaction(async () => {
        if (opts.record) await opts.record();
        if (canonical) {
            await options.updateOption('siteurl', canonical.origin);
            await options.updateOption('home', canonical.origin);
        }
        await options.updateOption('site_address_rev', rev);
    });
}

/**
 * Tell the gateway the new main address (split and separate modes): it builds its own links and pages
 * from it. Sent over the gateway's control plane with the cluster identity (core/cert-manager). The
 * monolith has no gateway, and a node without cluster material has no control plane to reach. A failure
 * is a warning in the response, never a failed change — the address is already stored and mirrored.
 */
async function pushToGateway(cfg: any): Promise<string | null> {
    if (!hasGatewayControlPlane(cfg)) return null;
    try {
        await require('./cert-manager').pushSiteUrlToGateway(cfg.siteUrl);
        return null;
    } catch (e: any) {
        warn(`could not tell the gateway about the new main address: ${e && e.message}`);
        return 'The gateway could not be told about the new main address yet; it keeps its previous value until it is restarted or the change is saved again.';
    }
}

/** Split and separate modes on a node with cluster material: the monolith has no gateway to tell. */
function hasGatewayControlPlane(cfg: any): boolean {
    if (process.env.WORDJS_MODE === 'mono' || process.env.WORDJS_EMBEDDED === '1') return false;
    return !!(cfg && cfg.mtls && cfg.mtls.cert);
}

/** The environment host-policy buildPolicy reads (host-policy.js POLICY_ENV_KEYS). */
const POLICY_ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY'] as const;

/**
 * The body of the gateway's POST /host-policy: exactly the inputs of host-policy buildPolicy, taken from
 * THIS backend — its config, its environment, its NODE_ENV — so the gateway's edge answers the same set
 * of addresses the backend's own gate does (the gateway's process environment is not consulted). The
 * shape is the one gateway/src/host-edge.js sanitizePolicyPush accepts. `enforce` is false until the
 * site is installed: the install wizard must be reachable on any address, as the backend gate allows.
 *
 * `hostPolicy` carries only the two keys buildPolicy reads, with their real types: anything else in a
 * hand-edited file would make the gateway refuse the whole push, where buildPolicy simply ignores it.
 */
function gatewayPolicyPush(cfg: any): { enforce: boolean; config: Record<string, unknown>; env: Record<string, string>; nodeEnv: string | null } {
    const env: Record<string, string> = {};
    for (const key of POLICY_ENV_KEYS) {
        const value = process.env[key];
        if (typeof value === 'string') env[key] = value;
    }
    const stored = cfg && cfg.hostPolicy && typeof cfg.hostPolicy === 'object' && !Array.isArray(cfg.hostPolicy) ? cfg.hostPolicy : {};
    const policy: Record<string, unknown> = {};
    if (typeof stored.ipLiterals === 'string') policy.ipLiterals = stored.ipLiterals;
    if (typeof stored.ipSignIn === 'boolean') policy.ipSignIn = stored.ipSignIn;
    let nodeEnv: string | null = null;
    try {
        const value = require('../config/app').nodeEnv;
        nodeEnv = typeof value === 'string' && value !== '' ? value : null;
    } catch { /* config not loaded: the gateway falls back to its own default */ }
    return {
        enforce: configManager.isInstalledConfig(cfg),
        config: {
            siteUrl: cfg && typeof cfg.siteUrl === 'string' ? cfg.siteUrl : null,
            siteAliases: cfg && Array.isArray(cfg.siteAliases) ? cfg.siteAliases : [],
            hostPolicy: policy,
            ...(cfg && cfg.trustProxy !== undefined && cfg.trustProxy !== null ? { trustProxy: cfg.trustProxy } : {}),
        },
        env,
        nodeEnv,
    };
}

/** Whether the last push to the gateway failed: the log, and whether the next re-send replaces its set. */
let gatewayPushFailing = false;
/** Whether the gateway answered the last re-send by keeping another set (warned once, until it does not). */
let gatewayKeepsOtherSet = false;

/**
 * What the gateway's edge refused, from its answer to the last push (gateway/src/host-edge.js
 * mountHostPolicyPush). Behind an enforcing gateway the backend's own gate never sees an unknown address,
 * so without this "Recently refused" stayed empty in split and separate mode (lab findings X2 / S9.2).
 * Replaced by every answer that carries a list, validated entry by entry (host-policy mergeRefusedHosts).
 */
let edgeRefused: ReturnType<typeof hostPolicy.mergeRefusedHosts> = [];

function noteEdgeRefusals(answer: any) {
    if (!answer || !Array.isArray(answer.refused)) return;
    // Everything in the gateway's list was refused by its edge, whatever an entry says (an older gateway
    // says nothing): stamped here, so "Recently refused" can tell it from this backend's own gate.
    const fromEdge = answer.refused.slice(0, 256).map((e: unknown) => (e && typeof e === 'object' && !Array.isArray(e) ? { ...e, source: 'edge' } : e));
    edgeRefused = hostPolicy.mergeRefusedHosts([fromEdge], { max: MAX_REFUSED });
}

// ─── 'own' IP addresses: the public edge's, which behind a gateway are not this machine's ──────────

/**
 * WHICH MACHINE `own` MEANS (lab finding R2-NEW-1). `hostPolicy.ipLiterals: own` answers the IP
 * addresses of the server browsers connect to. In the monolith that is this process's machine. Behind a
 * gateway it is the GATEWAY's, and in separate mode that is another machine: its edge judged `own` with
 * its own interfaces while this backend judged with its own, so a session started on the backend node's
 * address (reachable through the gateway while every IP was answered) stayed valid after the narrowing,
 * although the public edge refused that address, and the retirement record kept it.
 *
 * So the gateway reports the addresses its edge treats as its own in its answer to every policy push
 * (`ownAddresses`, gateway/src/host-edge.js mountHostPolicyPush), and everything here that judges `own`
 * uses them: the gate and the session check (middleware/auth.ts siteHostPolicy), the IPs a narrowing
 * keeps (retiredRecord, through commit), and GET /site-address. In the monolith, and until a gateway has
 * reported (a new install, an older gateway), this machine's interfaces are used, as before.
 *
 * `npm run site` is another process and never sees an answer, so the last report is also kept in
 * `data/gateway-own-addresses.json` beside the config, which it reads the same way (publicOwnAddresses).
 * Validated like any wire input, both when it arrives and when it is read back: IP literals in the
 * parser's own spelling that an interface can hold as its own unicast address — never a name, a port,
 * loopback, link-local, unspecified, broadcast, multicast or IPv4-mapped (review R3S-4) — at most
 * MAX_OWN_ADDRESSES (the gateway sends no more; past that, the backend refuses an IP its edge answers,
 * which fails closed).
 *
 * A report never outlives the gateway that made it: an answer without one (an older gateway) drops it,
 * and so does a backend that runs with no gateway at all (the monolith, at its boot reconcile), so a
 * file left by an earlier split or separate run on the same tree is not what `npm run site` judges
 * `own` by there (reviews R3S-3 / R3S-5). `own` then means this machine's interfaces again.
 */
const MAX_OWN_ADDRESSES = 64;
/** The gateway's last report in this process, or null (none yet: the monolith, or before the first answer). */
let edgeOwnAddresses: string[] | null = null;
/** When that report arrived (ISO), for GET /site-address and `npm run site`. */
let edgeOwnAddressesAt: string | null = null;
/** The report file as this process last read it: its signature (null = no file) and what it held (null = nothing usable). */
let storedOwnAddresses: { signature: string | null; list: string[] | null; receivedAt: string | null } | null = null;
let ownAddressesWriteWarned = false;

function ownAddressesFile(): string {
    const path = require('path');
    return path.join(path.dirname(path.resolve(configManager.CONFIG_FILE)), 'data', 'gateway-own-addresses.json');
}

/**
 * Whether an interface can hold this IP literal (parser spelling) as its own unicast address: not
 * unspecified (0.0.0.0/8, ::), multicast or reserved (224.0.0.0/4, and 240.0.0.0/4 with the broadcast
 * 255.255.255.255; ff00::/8), nor an IPv4-mapped IPv6 spelling (::ffff:0:0/96). The gate answers every
 * address a report names under `own`.
 */
function ownableUnicast(hostname: string, kind: string): boolean {
    if (kind === 'ipv4') {
        const first = Number(hostname.split('.')[0]);
        return first !== 0 && first < 224;
    }
    const inner = hostname.slice(1, -1);
    return inner !== '::' && !/^ff[0-9a-f]{2}:/.test(inner) && !inner.startsWith('::ffff:');
}

/** A reported list of own addresses, validated entry by entry; null when it is not a list at all. */
function readOwnAddressList(list: unknown): string[] | null {
    if (!Array.isArray(list)) return null;
    const out = new Set<string>();
    for (const item of list.slice(0, 256)) {
        if (typeof item !== 'string' || item.length > 64) continue;
        const p = hostPolicy.parseHost(item);
        if (!p || p.kind === 'dns' || p.port !== null || p.hostname !== item || hostPolicy.isLoopbackAuthority(p)) continue;
        if (p.hostname.startsWith('169.254.') || /^\[fe[89ab][0-9a-f]:/.test(p.hostname) || !ownableUnicast(p.hostname, p.kind)) continue;
        out.add(p.hostname);
        if (out.size >= MAX_OWN_ADDRESSES) break;
    }
    return [...out].sort();
}

function ownAddressesFileSignature(): string | null {
    try {
        const st = require('fs').statSync(ownAddressesFile());
        return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
        return null;
    }
}

/**
 * The report file's addresses, or null. Re-read only when the file changed (one stat per call, and only
 * consulted while this process has no report of its own: `npm run site`, or a backend before its first
 * push is answered).
 */
function readStoredOwnAddresses(): string[] | null {
    return readStoredReport().list;
}

/** readStoredOwnAddresses, with when the report arrived (null when the file does not say). */
function readStoredReport(): { list: string[] | null; receivedAt: string | null } {
    const signature = ownAddressesFileSignature();
    if (storedOwnAddresses && storedOwnAddresses.signature === signature) return storedOwnAddresses;
    let list: string[] | null = null;
    let receivedAt: string | null = null;
    if (signature !== null) {
        try {
            const doc = JSON.parse(require('fs').readFileSync(ownAddressesFile(), 'utf8'));
            list = doc && typeof doc === 'object' ? readOwnAddressList(doc.addresses) : null;
            if (list && typeof doc.receivedAt === 'string' && !Number.isNaN(Date.parse(doc.receivedAt))) receivedAt = new Date(doc.receivedAt).toISOString();
        } catch {
            list = null;
        }
    }
    storedOwnAddresses = { signature, list, receivedAt };
    return storedOwnAddresses;
}

function writeStoredOwnAddresses(list: string[], receivedAt: string): void {
    const fs = require('fs');
    const file = ownAddressesFile();
    const text = JSON.stringify({ format: 1, receivedAt, addresses: list }, null, 2) + '\n';
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(require('path').dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        try {
            fs.renameSync(tmp, file);
        } catch {
            // Windows refuses the rename while a reader holds the target open; a plain write will do.
            fs.writeFileSync(file, text, { mode: 0o600 });
            try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        }
        storedOwnAddresses = { signature: ownAddressesFileSignature(), list, receivedAt };
        ownAddressesWriteWarned = false;
    } catch (e: any) {
        if (!ownAddressesWriteWarned) warn(`could not keep the gateway's own addresses for npm run site (${e && e.message}); the running server uses them anyway.`);
        ownAddressesWriteWarned = true;
    }
}

/**
 * Take the own addresses from a gateway's answer. An answer without a list (a gateway from before the
 * report) drops the previous one, in this process and in the file: that list was another gateway's, and
 * kept, it would decide `own` for good with addresses nothing confirms any more (review R3S-5).
 */
function noteEdgeOwnAddresses(answer: any) {
    if (!answer || typeof answer !== 'object') return;
    const list = readOwnAddressList(answer.ownAddresses);
    if (!list) {
        if (edgeOwnAddresses) warn('the gateway no longer reports its own addresses (a gateway older than this backend): `own` means this machine\'s addresses again, which in separate mode are not the ones the gateway answers. Update the gateway.');
        forgetGatewayReport();
        return;
    }
    const at = new Date().toISOString();
    edgeOwnAddresses = list;
    edgeOwnAddressesAt = at;
    const stored = readStoredOwnAddresses();
    if (!stored || stored.join(',') !== list.join(',')) writeStoredOwnAddresses(list, at);
}

/** Drop the gateway's report, in this process and in the file (see above). */
function forgetGatewayReport(): void {
    edgeOwnAddresses = null;
    edgeOwnAddressesAt = null;
    try {
        require('fs').unlinkSync(ownAddressesFile());
    } catch (e: any) {
        if (!e || e.code !== 'ENOENT') warn(`could not remove ${ownAddressesFile()} (${e && e.message}); npm run site may still read it.`);
    }
    storedOwnAddresses = null;
}

/**
 * The IP addresses `own` answers, and where they come from: the gateway's report when a gateway fronts
 * this backend (this process's last answer, else the report file), this machine's interfaces otherwise.
 */
function ownAddressSource(): { addresses: Set<string>; from: 'gateway' | 'server'; receivedAt: string | null } {
    if (edgeOwnAddresses) return { addresses: new Set(edgeOwnAddresses), from: 'gateway', receivedAt: edgeOwnAddressesAt };
    if (hasGatewayControlPlane(configManager.getConfig())) {
        const stored = readStoredReport();
        if (stored.list) return { addresses: new Set(stored.list), from: 'gateway', receivedAt: stored.receivedAt };
    }
    return { addresses: hostPolicy.ownAddresses(), from: 'server', receivedAt: null };
}

/** What `own` answers, where that comes from, and since when: for `npm run site` list and check. */
function ownAddressReport(): { addresses: string[]; from: 'gateway' | 'server'; receivedAt: string | null } {
    const source = ownAddressSource();
    return { addresses: [...source.addresses].sort(), from: source.from, receivedAt: source.receivedAt };
}

/** The `ownAddresses` input of every host policy this backend (and `npm run site`) builds. */
function publicOwnAddresses(): Set<string> {
    return ownAddressSource().addresses;
}

/**
 * Tell the gateway which addresses the site answers (split and separate modes; phase 2). Its edge — the
 * 421 page for pages, static trees, uploads and WebSockets on an address the site does not answer, the
 * 308 of a redirect alias, and R4, which the backend cannot apply behind the gateway because every
 * request it receives comes from a trusted hop — enforces only a policy this backend pushed. A push only
 * stores a file on the gateway (its workers pick it up; nothing restarts), so it follows EVERY change,
 * including one the gateway itself reported. A failure is a warning, never a failed change: the gateway
 * keeps checking against the last set it received.
 */
async function pushPolicyToGateway(cfg: any, opts: { periodic?: boolean } = {}): Promise<string | null> {
    if (!hasGatewayControlPlane(cfg)) return null;
    // The periodic re-send only ARMS a gateway that holds no valid policy (`onlyIfMissing`): several
    // backends whose files differ would otherwise each re-send its own set in turn, and the gateway's
    // edge would answer an address for half a minute and refuse it for the next (review PL-3). A change,
    // a boot, and the first re-send after a push that failed still replace whatever the gateway holds.
    const onlyIfMissing = opts.periodic === true && !gatewayPushFailing;
    try {
        const answer = await require('./cert-manager').pushHostPolicyToGateway({ ...gatewayPolicyPush(cfg), ...(onlyIfMissing ? { onlyIfMissing: true } : {}) });
        noteEdgeRefusals(answer);
        noteEdgeOwnAddresses(answer);
        if (gatewayPushFailing) console.log('[site-address] the gateway is reachable again and has the site\'s addresses.');
        else if (opts.periodic && answer && answer.stored === 'written') console.log('[site-address] the gateway had no site addresses stored (restarted or replaced); it has them again.');
        if (answer && answer.stored === 'kept') {
            if (!gatewayKeepsOtherSet) warn('the gateway keeps a set of site addresses that differs from this backend\'s: another backend sent it, or a change made here is not applied yet. Every backend must hold the same site-address settings (share wordjs-config.json, or make each change on every node); the gateway takes this backend\'s set at its next change or boot.');
            gatewayKeepsOtherSet = true;
        } else {
            gatewayKeepsOtherSet = false;
        }
        gatewayPushFailing = false;
        return null;
    } catch (e: any) {
        // The periodic re-send repeats every half minute: a gateway that is down is reported when it goes,
        // not on every attempt. A change always says it (its warning is also in the answer).
        if (!opts.periodic || !gatewayPushFailing) warn(`could not tell the gateway which addresses the site answers: ${e && e.message}`);
        gatewayPushFailing = true;
        return 'The gateway could not be told which addresses the site answers; it keeps checking addresses against the last set it received until it can be told again (within about half a minute of it coming back).';
    }
}

/**
 * Push the current addresses to the gateway outside a change: after the boot reconcile, after this backend
 * registers with the gateway (index.ts), and every half minute from then on (startGatewaySync) — the boot
 * push may have run before the gateway listened, and a gateway restarted without its stored file, or a new
 * one, has nothing to enforce. The file is read afresh; an unreadable file pushes nothing, so the gateway
 * keeps the last policy it was given (REDTEAM R10). Never throws.
 */
function armGateway(opts: { periodic?: boolean } = {}): Promise<string | null> {
    return serial(async () => {
        const fresh = configManager.readConfigFresh();
        if (!fresh.exists || fresh.parseError) return null;
        return pushPolicyToGateway(fresh.parsed, opts);
    });
}

let gatewaySync: ReturnType<typeof setTimeout> | null = null;
let gatewaySyncOn = false;
/** Bumped by every start and stop, so a push still in flight from a stopped run never schedules again. */
let gatewaySyncRun = 0;

/**
 * Re-send the addresses to the gateway every `intervalMs` (plus up to 20% jitter, so a fleet of backends
 * restarted together does not push in step). The backend used to push only at its own boot and after a
 * change, so a gateway restarted WITHOUT its stored file — a new container, a deleted file — left pages
 * and static files answered on every address until the backend restarted (lab findings N1 / N4). A
 * re-send only arms a gateway that holds no valid policy (see pushPolicyToGateway); the gateway answers
 * it without rewriting anything otherwise, and with what its edge refused. Started by index.ts once this
 * backend has registered with a gateway; never in the monolith.
 */
function startGatewaySync(intervalMs = GATEWAY_SYNC_MS): void {
    if (gatewaySyncOn) return;
    gatewaySyncOn = true;
    const run = ++gatewaySyncRun;
    const schedule = () => {
        if (!gatewaySyncOn || run !== gatewaySyncRun) return;
        gatewaySync = setTimeout(() => {
            armGateway({ periodic: true }).catch(() => null).finally(schedule);
        }, intervalMs + Math.floor(Math.random() * intervalMs * 0.2));
        if (typeof gatewaySync.unref === 'function') gatewaySync.unref();
    };
    schedule();
}

function stopGatewaySync(): void {
    gatewaySyncOn = false;
    gatewaySyncRun += 1;
    if (gatewaySync) clearTimeout(gatewaySync);
    gatewaySync = null;
}

function purgeEverything() {
    try {
        require('./frontend-purge').purgeFrontend(PURGE_TAGS, ['/']);
    } catch { /* the ISR window still expires */ }
}

/** One literal action per kind, so the audit catalogue gate (tests/audit-trail) sees every name. */
async function auditChange(kind: ChangeKind | 'conflict_resolved' | 'gap', actorId: number | null, detail: Record<string, unknown>) {
    const { recordAudit } = require('./audit');
    switch (kind) {
        case 'canonical': return recordAudit(actorId, 'site.address.canonical', 'site', 'address', detail);
        case 'aliases': return recordAudit(actorId, 'site.address.aliases', 'site', 'address', detail);
        case 'policy': return recordAudit(actorId, 'site.address.policy', 'site', 'address', detail);
        case 'repair': return recordAudit(actorId, 'site.address.repair', 'site', 'address', detail);
        case 'conflict_resolved': return recordAudit(actorId, 'site.address.conflict_resolved', 'site', 'address', detail);
        case 'gap': return recordAudit(actorId, 'site.address.gap', 'site', 'address', detail);
    }
}

/** The audit detail of one revision: what the planner summarised, how it was made, and any override. */
function auditDetail(e: ChangeEvent): Record<string, unknown> {
    return { ...e.summary, via: e.via, force: e.force, rev: e.rev, ...(e.forcedPast ? { forcedPast: e.forcedPast } : {}) };
}

/**
 * `host[:port]` of an origin, for messages: a bare name reads as text, not as a link to click. A value that
 * is not a site address (a corrupted one being repaired) is shown as it is, bounded.
 */
function plainAddress(value: unknown): string {
    const site = hostPolicy.parseSiteUrl(value);
    if (site) return hostPolicy.serialize(site);
    const text = String(value || '').slice(0, 200);
    return text || 'none';
}

/** The IP rule a stored `hostPolicy.ipLiterals` means: no value ('default') is `any`, as buildPolicy reads it. */
function ipRule(value: unknown): string {
    return value === 'own' || value === 'none' ? value : 'any';
}

/**
 * One sentence per revision, for the notice, the email and `npm run site` (lab finding R2-M-NEW1: a
 * sign-in switch read "changed from any to any", and a choice of the address the file already held
 * "changed from X to X"), with the verb that names who did it: a revision that moved nothing says
 * "Confirmed by" or "Saved by", never "Changed by" (review UX-5).
 */
function describeRevision(kind: ChangeKind, summary: Record<string, unknown>): { text: string; verb: 'Changed' | 'Confirmed' | 'Saved' } {
    const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(', ') : 'none');
    switch (kind) {
        case 'canonical':
        case 'repair': {
            const from = hostPolicy.parseSiteUrl(summary.from);
            const to = hostPolicy.parseSiteUrl(summary.to);
            // A choice recorded where the file already named the address (Use A of an upgrade conflict,
            // `npm run site -- canonical <its own address>`): nothing moved.
            if (summary.confirmed === true || (from && to && from.origin === to.origin)) {
                return { text: `${plainAddress(summary.to)} was confirmed as the main address.`, verb: 'Confirmed' };
            }
            // The same host on another scheme (the automatic http → https move): the bare names are equal.
            if (from && to && hostPolicy.serialize(from) === hostPolicy.serialize(to)) {
                return { text: `The main address ${plainAddress(summary.to)} now uses ${to.scheme} instead of ${from.scheme}.`, verb: 'Changed' };
            }
            return { text: `The main address changed from ${plainAddress(summary.from)} to ${plainAddress(summary.to)}.`, verb: 'Changed' };
        }
        case 'aliases':
            return { text: `Other addresses changed. Added: ${list(summary.added)}. Removed: ${list(summary.removed)}. Edited: ${list(summary.changed)}.`, verb: 'Changed' };
        case 'policy': {
            const from = ipRule(summary.from);
            const to = ipRule(summary.to);
            const signIn = summary.ipSignIn === true;
            const turned = `Signing in on IP addresses was turned ${signIn ? 'on' : 'off'}.`;
            if (typeof summary.ipSignInFrom !== 'boolean') {
                // A record from before ipSignInFrom existed (an older `npm run site`, a stale dist/). The
                // switch is known to have moved only when the STORED rule did not (planPolicy writes
                // nothing when neither changes); otherwise only where it stands now is known, so that is
                // what is said (review DOC-3: 'default' → 'any' read as a switch that never moved).
                if (summary.from === summary.to) return { text: turned, verb: 'Changed' };
                const now = `signing in on IP addresses is ${signIn ? 'on' : 'off'}.`;
                return from !== to
                    ? { text: `The IP address policy changed from ${from} to ${to}; ${now}`, verb: 'Changed' }
                    : { text: `The IP address policy was saved as ${to}, and ${now}`, verb: 'Saved' };
            }
            const sentences: string[] = [];
            if (from !== to) sentences.push(`The IP address policy changed from ${from} to ${to}.`);
            if (summary.ipSignInFrom !== signIn) sentences.push(turned);
            return sentences.length
                ? { text: sentences.join(' '), verb: 'Changed' }
                : { text: `The IP address policy was saved as ${to}, which was already in effect.`, verb: 'Saved' };
        }
    }
}

function describeChange(kind: ChangeKind, summary: Record<string, unknown>): string {
    return describeRevision(kind, summary).text;
}

/** The upgrade conflict an apply ended: both values it had, and the address links and emails use now. */
function conflictSentence(resolves: { config: string; db: string }, chosen: string): string {
    const db = hostPolicy.parseSiteUrl(resolves.db);
    const verb = db && db.origin === chosen ? 'keep using' : 'now use';
    return `The two different main addresses, ${plainAddress(resolves.config)} in wordjs-config.json and ${resolves.db ? plainAddress(resolves.db) : 'none'} in the database, `
        + `were reconciled: links and emails ${verb} ${plainAddress(chosen)}.`;
}

async function actorDescription(via: ChangeVia, actorId: number | null): Promise<string> {
    if (via === 'cli') return 'the server command line (npm run site)';
    if (via !== 'ui') return 'an automatic repair';
    try {
        const user = actorId ? await require('../models/User').findById(actorId) : null;
        return user ? `${user.userLogin} (Settings → Site address)` : 'an administrator';
    } catch {
        return 'an administrator';
    }
}

/**
 * Every administrator, in-app — by id, never the broadcast user 0 that every logged-in user receives —
 * and the site's admin email when mail can be delivered. The email carries no link on purpose: a message
 * that says "your site moved, click here" is exactly the template a phishing attempt would copy.
 */
async function tellAdmins(message: string) {
    try {
        const { dbAsync } = require('../config/database');
        const rows: Array<{ user_id: number }> = await dbAsync.all(
            "SELECT DISTINCT user_id FROM user_meta WHERE meta_key = 'role' AND meta_value = 'administrator' ORDER BY user_id LIMIT 100");
        const notifications = require('./notifications');
        for (const row of rows) {
            await notifications.send({
                user_id: Number(row.user_id),
                type: 'warning',
                title: 'Site address changed',
                message,
                icon: 'fa-globe',
                action_url: '/admin/settings/site-address',
                transports: ['db', 'sse'],
            });
        }
        const send = (global as any).wordjs_send_mail;
        if (typeof send === 'function') {
            const { getOption } = require('./options');
            const to = String((await getOption('admin_email', '')) || '').trim();
            if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
                const siteName = String((await getOption('blogname', 'WordJS')) || 'WordJS');
                const text = `${message}\n\nIf you did not expect this change, sign in to your site the way you usually do and review Settings → Site address. This message contains no links on purpose.`;
                // The one HTML escaper every transactional mail body uses.
                const { escHtml: escape } = require('./formatting');
                // Handed to the mail provider, not waited for: this runs inside the serial queue, and every
                // other change (and the watcher) would otherwise wait on the mail server.
                Promise.resolve(send({ to, subject: `${siteName}: site address changed`, text, html: `<p>${escape(text).replace(/\n\n/g, '</p><p>')}</p>` }))
                    .catch((e: any) => warn(`could not email the administrators: ${e && e.message}`));
            }
        }
    } catch (e: any) {
        warn(`could not notify the administrators: ${e && e.message}`);
    }
}

/**
 * What one apply puts on the record: one revision for a commit (plus any the CLI wrote that this process
 * had not applied yet), every revision the file holds beyond the database's for applyExternal — each with
 * its own audit row, so how quickly the CLI was run never decides what is on the record — the runs of
 * revisions the file's log no longer describes, and the upgrade conflict the apply ends, if one is
 * pending: the mirrors are written from the file, so afterwards the file and the database name the same
 * main address, whichever way it ended (an administrator choosing either address — Use A / Use B,
 * `npm run site -- canonical <url>` — or any other change, which writes the file's main address like
 * every change does).
 */
interface Applied {
    events: ChangeEvent[];
    gaps: ChangeGap[];
    rev: number;
    resolves: { config: string; db: string } | null;
    /** The main address the mirrors name once the apply is written (with `resolves`, the conflict's choice). */
    chosen: string | null;
}

function applied(cfg: any, events: ChangeEvent[], gaps: ChangeGap[], rev: number): Applied {
    const canonical = hostPolicy.parseSiteUrl(cfg.siteUrl);
    return { events, gaps, rev, resolves: conflict && canonical ? conflict : null, chosen: canonical ? canonical.origin : null };
}

/** The audit rows of an apply, written inside writeMirrors' transaction (see there). */
async function recordApplied(a: Applied): Promise<void> {
    for (const e of a.events) await auditChange(e.kind, e.by, auditDetail(e));
    for (const gap of a.gaps) await auditChange('gap', null, { from: gap.from, to: gap.to, revisions: gap.revisions, rev: a.rev });
    if (a.resolves && a.chosen) {
        const last = a.events[a.events.length - 1];
        await auditChange('conflict_resolved', last ? last.by : null, {
            config: a.resolves.config, db: a.resolves.db, chosen: a.chosen, via: last ? last.via : 'cli', rev: a.rev, ...(last ? { change: last.kind } : {}),
        });
    }
}

function gapSentence(gap: ChangeGap): string {
    const one = gap.revisions === 1;
    return `${one ? `Revision ${gap.from}` : `Revisions ${gap.from}–${gap.to}`} of the site address ${one ? 'was' : 'were'} written at the server, but no details of ${one ? 'it' : 'them'} are left to record. Review Settings → Site address.`;
}

/**
 * ONE notice to every administrator (and one email) per apply, naming every revision in it: a script that
 * ran the CLI twenty-five times used to send twenty-one of each, waiting on the mail server inside the
 * serial queue (review PL-6). Each revision still has its own audit row. An upgrade conflict the apply
 * ends is named too, with both of its addresses and the one links use now, as its audit row records it.
 */
async function announce(a: Applied): Promise<void> {
    try {
        const lines: string[] = [];
        for (const e of a.events) {
            const { text, verb } = describeRevision(e.kind, e.summary);
            lines.push(`${text} ${verb} by ${await actorDescription(e.via, e.by)}.`);
        }
        for (const gap of a.gaps) lines.push(gapSentence(gap));
        const resolution = a.resolves && a.chosen ? conflictSentence(a.resolves, a.chosen) : null;
        if (!lines.length && !resolution) return;
        const changes = lines.length === 1 ? lines[0] : lines.length ? `${lines.length} changes to the site address were applied. ${lines.join(' ')}` : '';
        await tellAdmins([changes, resolution].filter(Boolean).join(' '));
    } catch (e: any) {
        warn(`could not notify the administrators: ${e && e.message}`);
    }
}

/**
 * Steps 5–7, once the apply and its audit rows are committed (writeMirrors): the notices, the gateway,
 * the caches. Never fatal — the change is durable and on the record already.
 */
async function afterChange(cfg: any, a: Applied, opts: { canonicalChanged: boolean }): Promise<string[]> {
    const warnings: string[] = [];
    const canonical = hostPolicy.parseSiteUrl(cfg.siteUrl);
    if (canonical) clearNotice(NOTICE_IDS.missingCanonical);
    if (a.resolves && conflict === a.resolves) {
        conflict = null;
        clearNotice(NOTICE_IDS.conflict);
    }
    if (gatewayDrift && canonical && gatewayDrift.gateway === canonical.origin) {
        gatewayDrift = null;
        clearNotice(NOTICE_IDS.gatewayDrift);
    }
    // Before anything that waits on the network: a process killed during a gateway push still told them.
    await announce(a);
    // Every kind of change moves the set of addresses the gateway's edge answers (the main address, the
    // aliases, the IP policy) — first, so a new main address is accepted at the edge before the gateway
    // starts building links from it. Also for the gateway's own R1 report: this push restarts nothing.
    const policyWarning = await pushPolicyToGateway(cfg);
    if (policyWarning) warnings.push(policyWarning);
    // The gateway is the source of an automatic R1 upgrade; echoing it back would only restart its workers.
    const fromGateway = a.events.length > 0 && a.events.every((e) => e.via === 'gateway');
    if (opts.canonicalChanged && !fromGateway) {
        const w = await pushToGateway(cfg);
        if (w) warnings.push(w);
    }
    purgeEverything();
    return warnings;
}

// ─── commit ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The single writer. `planner` runs against the config read HERE (fresh, not cached), so the plan, the
 * revision check and the write all see the same snapshot. Throws SiteAddressError:
 *   409 rest_site_address_stale    the revision moved (someone else changed the address meanwhile)
 *   409 rest_site_address_in_use   the interlock (`data.dependents`); `force: true` overrides, audited
 *   503 rest_config_unreadable     the file cannot be parsed right now (R10) — nothing is written
 *   500 rest_site_address_rollback the database refused the mirrors; the previous file bytes are back
 */
async function commitUnlocked(
    planner: (cfg: any) => Plan,
    opts: { expectRev: number; via: ChangeVia; actorId: number | null; force?: boolean; now?: number }
): Promise<CommitResult> {
    const now = opts.now ?? Date.now();
    const fresh = configManager.readConfigFresh();
    if (fresh.exists && fresh.parseError) {
        throw new SiteAddressError(503, 'rest_config_unreadable', 'wordjs-config.json cannot be read right now, so nothing was changed. Try again in a moment.');
    }
    const current = fresh.exists ? fresh.parsed : {};
    const rev = siteAddressRev(current);
    if (opts.expectRev !== rev) {
        throw new SiteAddressError(409, 'rest_site_address_stale', 'The site address was changed in the meantime. Reload and try again.', { rev });
    }
    const plan = planner(current);
    if (plan.unchanged) return { rev, unchanged: true, warnings: [] };

    // The inputs the gate of THIS process builds its policy from, so the addresses this change retires
    // are judged exactly as the gate will judge them — `own` included: the public edge's addresses.
    const policyInputs: PolicyInputs = { env: process.env, nodeEnv: runtimeNodeEnv(), ownAddresses: publicOwnAddresses };
    const next = applyPlan(current, plan, { via: opts.via, actorId: opts.actorId, now, ...policyInputs });
    const dependents = interlock(next, plan.removedHosts, { now });
    if (dependents.length && opts.force !== true) {
        throw new SiteAddressError(409, 'rest_site_address_in_use',
            'Something still uses this address. Change it first, or confirm to remove it anyway.', { dependents });
    }
    // The override and what it went past are recorded with the revision, and audited from that record.
    const meta: ChangeMeta = { via: opts.via, actorId: opts.actorId, now, force: opts.force === true, forcedPast: dependents.length ? describeDependents(dependents) : null, ...policyInputs };

    // Revisions the CLI wrote that this process has not applied yet (the watcher ticks every 2 s, and a
    // commit can land first). This commit writes the database's revision past them, after which the
    // watcher finds nothing to do — so they are put on the record here, with this change (review PL-1).
    const options = require('./options');
    const dbRev = Number(await options.getOption('site_address_rev', 0)) || 0;
    const pending = rev > dbRev ? changesSince(current, dbRev) : { events: [], gaps: [] };
    const mirrored = rev > dbRev ? hostPolicy.parseSiteUrl(await options.getOption('siteurl', null)) : null;

    // The plan is applied to what the writer reads at the moment of writing: with the revision unchanged
    // the site-address keys are the ones planned against, and any other key a different writer stored in
    // the meantime (a purge secret, an ACME setting) is kept rather than overwritten by our snapshot.
    const written = configManager.updateConfig((latest: any) => applyPlan(latest, plan, meta), { expectRev: rev });
    if (!written.ok) {
        if (written.reason === 'stale') throw new SiteAddressError(409, 'rest_site_address_stale', 'The site address was changed in the meantime. Reload and try again.', { rev: written.currentRev ?? null });
        if (written.reason === 'unreadable') throw new SiteAddressError(503, 'rest_config_unreadable', 'wordjs-config.json cannot be read right now, so nothing was changed. Try again in a moment.');
        throw new SiteAddressError(500, 'rest_site_address_write_failed', 'The site address could not be saved.');
    }
    const newRev = rev + 1;
    lastAppliedRev = newRev;
    policyProvider().invalidate();

    const record = applied(written.config, [...pending.events, eventFor(plan, meta, newRev)], pending.gaps, newRev);
    try {
        await writeMirrors(written.config, newRev, { record: () => recordApplied(record) });
    } catch (e: any) {
        // Undo the file so the two stores keep naming the same address — unless the file has moved on
        // (a CLI write landed after ours), in which case that newer change stands.
        const restored = written.previousText !== null && configManager.restoreConfigText(written.previousText, { expectRev: newRev });
        if (restored) {
            // Not "rev is applied": a CLI revision pending before this commit still is not, and the
            // watcher must compare the file with the database again to find it.
            lastAppliedRev = null;
            policyProvider().invalidate();
        }
        console.error(`[site-address] the database refused the address change (${e && e.message}); ${restored ? 'the previous configuration was restored' : 'the configuration file could not be restored'}.`);
        throw new SiteAddressError(500, 'rest_site_address_rollback',
            restored ? 'The change could not be stored in the database, so it was undone. Nothing changed.' : 'The change could not be stored in the database.',
            { restored });
    }

    // A pending CLI revision may have moved the main address the mirrors (and the gateway) still named.
    const canonical = hostPolicy.parseSiteUrl(written.config.siteUrl);
    const pendingMoved = pending.events.length + pending.gaps.length > 0 && !!canonical && (!mirrored || mirrored.origin !== canonical.origin);
    const warnings = await afterChange(written.config, record, { canonicalChanged: plan.canonicalChanged || pendingMoved });
    if (plan.kind === 'policy' && typeof process.env.WORDJS_IP_HOSTS === 'string' && process.env.WORDJS_IP_HOSTS.trim() !== '') {
        warnings.push('WORDJS_IP_HOSTS is set on the server and overrides this setting until it is removed.');
    }
    return { rev: newRev, warnings };
}

/** The NODE_ENV this backend's gate uses (config/app, as middleware/auth's policy provider reads it). */
function runtimeNodeEnv(): string | undefined {
    try {
        const value = require('../config/app').nodeEnv;
        return typeof value === 'string' && value !== '' ? value : undefined;
    } catch {
        return undefined;
    }
}

function commit(planner: (cfg: any) => Plan, opts: { expectRev: number; via: ChangeVia; actorId: number | null; force?: boolean; now?: number }): Promise<CommitResult> {
    return serial(() => commitUnlocked(planner, opts));
}

// ─── Changes made outside this process (the CLI) ───────────────────────────────────────────────────

/**
 * The CLI wrote a new revision to the file (it cannot reach the database or the gateway). Apply the rest
 * here: runtime config, policy, mirrors, gateway, purge, audit, notification. Never rolls the file back
 * (REDTEAM R10): the operator's change at the server stands; if the database refuses, the next check
 * retries.
 */
async function applyExternal(cfg: any, appliedRev: number): Promise<void> {
    const rev = siteAddressRev(cfg);
    const { getOption } = require('./options');
    const before = hostPolicy.parseSiteUrl(await getOption('siteurl', null));

    // EVERY revision since the one the database records, not only the last: two CLI runs inside one
    // watcher tick, or a series made while the backend was stopped, used to leave all but the last with
    // no audit row and no notice (lab finding M-16).
    const { events, gaps } = changesSince(cfg, appliedRev);
    const canonical = hostPolicy.parseSiteUrl(cfg.siteUrl);
    // The links' base moved when the mirror named another origin than the file now does.
    const canonicalChanged = !!canonical && (!before || before.origin !== canonical.origin);
    const last = events[events.length - 1];
    if (canonicalChanged && last && !events.some((e) => e.kind === 'canonical' || e.kind === 'repair') && last.summary.to === undefined) {
        // A hand edit of siteUrl that rode along with this change: the row still says where links moved.
        last.summary = { ...last.summary, from: before ? before.origin : null, to: canonical!.origin };
    }

    runtimeReload(cfg);
    policyProvider().invalidate();
    const record = applied(cfg, events, gaps, rev);
    await writeMirrors(cfg, rev, { record: () => recordApplied(record) });
    lastAppliedRev = rev;
    await afterChange(cfg, record, { canonicalChanged });
}

/**
 * One tick of the watcher: apply a revision the file has and this process has not. A revision LOWER than
 * the database's (an old backup restored over the file) is never applied — that would silently move the
 * site back; it is reported instead.
 */
function checkExternalChange(): Promise<'not-ready' | 'unreadable' | 'unchanged' | 'applied' | 'behind'> {
    return serial(async () => {
        if (!reconciled) return 'not-ready';
        const cfg = configManager.getConfig();
        if (!cfg) return 'unreadable';
        const rev = siteAddressRev(cfg);
        if (rev === lastAppliedRev) return 'unchanged';
        const dbRev = Number(await require('./options').getOption('site_address_rev', 0)) || 0;
        if (rev > dbRev) {
            await applyExternal(cfg, dbRev);
            return 'applied';
        }
        lastAppliedRev = rev;
        if (rev < dbRev) {
            warn(`wordjs-config.json is at site-address revision ${rev} but the database is at ${dbRev}; the file looks older than the last change and is not applied over it.`);
            return 'behind';
        }
        return 'unchanged';
    });
}

/** Poll the file (its mtime cache makes a tick one stat) so a CLI change is live within seconds. */
function startWatching(intervalMs = 2000): void {
    if (watcher) return;
    watcher = setInterval(() => {
        checkExternalChange().catch((e: any) => warn(`could not apply a change made outside the server: ${e && e.message}`));
    }, intervalMs);
    if (typeof watcher.unref === 'function') watcher.unref();
}

function stopWatching(): void {
    if (watcher) clearInterval(watcher);
    watcher = null;
}

// ─── Boot ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The site-address record a fresh install starts with: routes/setup.ts writes it with the rest of the
 * config, and `site_address_rev` 1 with the other options, so the first reconcile finds the two in step
 * and writes nothing. Without it every new site went through the legacy upgrade below and said so for
 * good: `lastChange: { kind: 'repair', via: 'upgrade' }` (lab finding M-03). Not an address change, so
 * nothing is audited for it (changesSince treats it as bookkeeping).
 */
function installRecord(now: number): { rev: number; lastChange: Record<string, unknown> } {
    return { rev: 1, lastChange: { kind: 'install', via: 'install', by: null, at: isoAt(now), rev: 1 } };
}

type ReconcileState = 'unreadable' | 'ok' | 'applied' | 'config-behind' | 'upgraded' | 'mirrored' | 'repaired' | 'conflict' | 'invalid';

/**
 * Bring the file and the database into agreement at boot (idempotent; runs after the options exist).
 *
 * A config WITH a siteAddress key: apply a revision the CLI wrote while the server was down.
 * A legacy config (only siteUrl):
 *   · siteUrl invalid → the R5 salvage of `https,http://host` (https only) when the database names the
 *     same thing; any other invalid value is reported and the gate keeps its "no main address" parity;
 *   · the database has no `siteurl` → write the mirrors, revision 1;
 *   · the database names the same address → revision 1;
 *   · they DIFFER → a conflict: NOTHING is written. The gate keeps using the config's host and links keep
 *     using the database's, exactly as before the upgrade, until an administrator chooses. Neither value
 *     is promoted to an alias: drift values were writable without validation, and widening the accepted
 *     set from them silently is what this redesign exists to stop.
 */
function reconcileAtBoot(): Promise<{ state: ReconcileState; gatewayArmed: Promise<string | null> }> {
    let gatewayArmed: Promise<string | null> = Promise.resolve(null);
    const reconcile = serial(async () => {
        try {
            return await reconcileUnlocked();
        } finally {
            reconciled = true;
            resolveReconciled();
            // No gateway fronts this process (the monolith, or no cluster identity): a report left by an
            // earlier split or separate run on this tree must not decide what `own` means to npm run site.
            let cfg: any = null;
            try { cfg = configManager.getConfig(); } catch { /* unreadable: decided at the next boot */ }
            if (cfg && !hasGatewayControlPlane(cfg)) forgetGatewayReport();
            // Then arm the gateway's edge with what the file now says, whatever the outcome above (the
            // file is the master even when the database could not be reconciled). Queued right behind the
            // reconcile, so no later change can be overtaken by it, but not awaited: a gateway that is not
            // listening yet must not hold up the boot — the push after registration (index.ts) covers it.
            gatewayArmed = armGateway();
        }
    });
    return reconcile.then((state) => ({ state, gatewayArmed }));
}

async function reconcileUnlocked(): Promise<ReconcileState> {
    conflict = null;
    // Nothing is known to be applied until this reconcile says so; a branch that writes nothing (a
    // conflict) leaves the watcher to compare the file with the database itself.
    lastAppliedRev = null;
    const fresh = configManager.readConfigFresh();
    if (!fresh.exists || fresh.parseError) {
        console.error('[site-address] wordjs-config.json cannot be read; the site addresses are not reconciled at this boot.');
        return 'unreadable';
    }
    const cfg = fresh.parsed;
    const options = require('./options');
    const dbValue = await options.getOption('siteurl', null);
    const dbText = typeof dbValue === 'string' && dbValue.trim() !== '' ? dbValue.trim() : null;

    if (cfg.siteAddress !== undefined) {
        const rev = siteAddressRev(cfg);
        const dbRev = Number(await options.getOption('site_address_rev', 0)) || 0;
        if (rev > dbRev) {
            await applyExternal(cfg, dbRev);
            return 'applied';
        }
        lastAppliedRev = rev;
        if (rev < dbRev) {
            warn(`wordjs-config.json is at site-address revision ${rev} but the database is at ${dbRev}; the file is not applied over the newer change.`);
            return 'config-behind';
        }
        return 'ok';
    }

    const current = hostPolicy.parseSiteUrl(cfg.siteUrl);
    if (!current) {
        const salvaged = salvageSiteUrl(cfg.siteUrl);
        const corrupted = typeof cfg.siteUrl === 'string' && SCHEME_LIST_PREFIX.test(cfg.siteUrl);
        if (salvaged) {
            const dbSite = hostPolicy.parseSiteUrl(dbText) || salvageSiteUrl(dbText);
            if (dbText === null || dbText === cfg.siteUrl.trim() || (dbSite && dbSite.origin === salvaged.origin)) {
                await commitUnlocked((c) => planRepair(c, salvaged.origin, 'scheme-list', Date.now()), { expectRev: 0, via: 'repair', actorId: null });
                console.log(`[site-address] repaired the main address ${JSON.stringify(cfg.siteUrl)} → ${salvaged.origin}.`);
                return 'repaired';
            }
            raiseConflict({ config: String(cfg.siteUrl), db: dbText });
            return 'conflict';
        }
        if (corrupted) {
            // Only http in the list: picking http would be a guess, and https would invent a scheme.
            raiseConflict({ config: String(cfg.siteUrl), db: dbText ?? '' });
            return 'conflict';
        }
        console.error(`[site-address] siteUrl ${JSON.stringify(cfg.siteUrl ?? null)} is not a valid site address; set it in Settings → Site address or with npm run site -- canonical <url>.`);
        return 'invalid';
    }

    const dbSite = hostPolicy.parseSiteUrl(dbText);
    if (dbText !== null && (!dbSite || dbSite.origin !== current.origin)) {
        raiseConflict({ config: current.origin, db: dbText });
        return 'conflict';
    }
    const written = configManager.updateConfig((c: any) => ({
        ...c,
        siteAddress: { ...(c.siteAddress && typeof c.siteAddress === 'object' ? c.siteAddress : {}), rev: 1, lastChange: { kind: 'repair', via: 'upgrade', by: null, at: isoAt(Date.now()), reason: 'upgrade' } },
    }), { expectRev: 0 });
    if (!written.ok) {
        warn(`could not record site-address revision 1 (${written.reason}); the upgrade is retried at the next boot.`);
        return 'invalid';
    }
    await writeMirrors(written.config, 1, { addresses: dbText === null });
    lastAppliedRev = 1;
    return dbText === null ? 'mirrored' : 'upgraded';
}

/** Resolves once reconcileAtBoot has run; the gateway sync waits on it before comparing. */
function whenReconciled(): Promise<void> {
    return reconciledPromise;
}

/** For a route reached before any boot reconcile (an install completed in this process): run it now. */
async function ensureStarted(): Promise<void> {
    if (!reconciled && configManager.isInstalled()) await reconcileAtBoot();
    startWatching();
}

// ─── The gateway's view ─────────────────────────────────────────────────────────────────────────────

/**
 * The gateway reported its own main address (GET /info at boot, or the answer to POST /config-update
 * after an SSL or port toggle). It never writes anything by itself any more — except the R1 upgrade:
 * same host, http → https. Anything else is DRIFT: shown to the administrator, who decides.
 */
function noteGatewaySiteUrl(reported: unknown): Promise<{ outcome: 'ignored' | 'in-sync' | 'upgraded' | 'drift'; canonical?: string; gateway?: string; warnings?: string[] }> {
    return serial(async () => {
        const g = hostPolicy.parseSiteUrl(reported);
        if (!g) return { outcome: 'ignored' as const };
        const fresh = configManager.readConfigFresh();
        const cfg = fresh.exists && !fresh.parseError ? fresh.parsed : null;
        const c = cfg ? hostPolicy.parseSiteUrl(cfg.siteUrl) : null;
        if (!cfg || !c) return { outcome: 'ignored' as const };
        if (g.origin === c.origin) {
            if (gatewayDrift) {
                gatewayDrift = null;
                clearNotice(NOTICE_IDS.gatewayDrift);
            }
            return { outcome: 'in-sync' as const, canonical: c.origin };
        }
        // During an unresolved upgrade conflict the database still names another address; an automatic
        // move would silently pick a side, so the gateway's view is only reported then.
        if (isAutomaticUpgrade(c, g) && !conflict) {
            const result = await commitUnlocked((current) => planRepair(current, g.origin, 'gateway-https', Date.now()),
                { expectRev: siteAddressRev(cfg), via: 'gateway', actorId: null });
            console.log(`[site-address] the gateway now serves ${g.origin}; the main address moved from ${c.origin} (same host, http → https).`);
            return { outcome: 'upgraded' as const, canonical: g.origin, warnings: result.warnings };
        }
        gatewayDrift = { gateway: g.origin, config: c.origin };
        warn(`the gateway reports ${g.origin} but the main address is ${c.origin}; nothing was changed. Choose one in Settings → Site address.`);
        notice(NOTICE_IDS.gatewayDrift, 'warning', 'The gateway reports a different site address.',
            'The gateway serves a different address than the configured main address (often after an SSL or port change). Review it in Settings → Site address.');
        return { outcome: 'drift' as const, canonical: c.origin, gateway: g.origin };
    });
}

// ─── What the admin screen shows ───────────────────────────────────────────────────────────────────

async function activeNotices(): Promise<string[]> {
    try {
        const stored = await require('./options').getOption('admin_notices', []);
        const ids = new Set((Array.isArray(stored) ? stored : []).map((n: any) => n && n.id));
        const out: string[] = [];
        if (ids.has(NOTICE_IDS.missingCanonical)) out.push('missing-canonical');
        if (ids.has(NOTICE_IDS.proxyCollapse)) out.push('proxy-collapse');
        return out;
    } catch {
        return [];
    }
}

/**
 * GET /site-address. Administrator + browser session only (REDTEAM R8): `ownAddresses` are the origin's
 * real IPs (a CDN/WAF bypass for anyone else), and the refused list shows what is being probed.
 * `siteHost` is what the gate attached to the admin's own request ("you are connected via").
 */
async function describeState(siteHost: SiteHost | null): Promise<Record<string, unknown>> {
    const cfg = configManager.getConfig() || {};
    const policy: HostPolicy = policyProvider().get();
    const now = Date.now();
    const stored = new Map<string, any>();
    for (const a of configAliases(cfg)) if (a.site && typeof a.raw === 'object' && !stored.has(a.site.hostname)) stored.set(a.site.hostname, a.raw);

    const aliases = [...policy.aliases.values()].map((entry) => {
        const raw = stored.get(entry.hostname) || {};
        const use = hostPolicy.lastSeen.get(entry.hostname);
        return {
            url: entry.origin,
            origin: entry.origin,
            hostname: entry.hostname,
            port: entry.port,
            scheme: entry.scheme,
            kind: entry.kind,
            mode: entry.mode,
            label: entry.label,
            signIn: entry.signIn,
            signInExplicit: entry.signInExplicit,
            risk: entry.risk,
            source: entry.source,
            addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : null,
            expiresAt: entry.expiresAt === null ? null : isoAt(entry.expiresAt),
            expired: entry.expiresAt !== null && now >= entry.expiresAt,
            lastSeen: use ? { seenAt: use.seenAt, authenticatedAt: use.authenticatedAt } : null,
        };
    });
    const envHosts = [...policy.envHosts.values()].map((e) => ({
        origin: e.origin, hostname: e.hostname, port: e.port, scheme: e.scheme, signIn: e.signIn, risk: e.risk,
    }));
    const change = cfg.siteAddress && typeof cfg.siteAddress.lastChange === 'object' ? cfg.siteAddress.lastChange : null;
    return {
        rev: siteAddressRev(cfg),
        canonical: policy.canonical ? policy.canonical.origin : null,
        canonicalError: policy.canonicalError,
        aliases,
        envHosts,
        ipLiterals: policy.ipLiterals,
        ipLiteralsSource: policy.ipLiteralsSource,
        ipSignIn: policy.ipSignIn,
        // The addresses `own` answers: the gateway's (as it reported them) when one fronts the site.
        ownAddresses: [...policy.ownAddresses()].sort(),
        ownAddressesFrom: ownAddressSource().from,
        ownAddressesReportedAt: ownAddressSource().receivedAt,
        devOrigins: [...policy.devOrigins].sort(),
        dev: policy.dev,
        connectedVia: siteHost ? { host: siteHost.host, cls: siteHost.cls } : null,
        // This backend's own gate, and the gateway's edge (split / separate mode) from its last answer.
        recentlyRefused: hostPolicy.mergeRefusedHosts([hostPolicy.refusedHosts.list(), edgeRefused], { max: MAX_REFUSED }),
        conflict,
        gatewayDrift,
        notices: await activeNotices(),
        warnings: [...policy.warnings],
        lastChange: change,
    };
}

module.exports = {
    SiteAddressError,
    TUNNEL_ALIAS_LIFETIME_MS,
    INTERLOCK_WINDOW_MS,
    // reading
    canonicalOrigin,
    linkBase,
    linkHostname,
    // planning (pure; shared with the CLI)
    planCanonical,
    planAliases,
    planPolicy,
    planRepair,
    interlock,
    describeDependents,
    describeChange,
    applyPlan,
    changesSince,
    publicOwnAddresses,
    ownAddressReport,
    salvageSiteUrl,
    isAutomaticUpgrade,
    MAX_CHANGE_LOG,
    // writing
    commit,
    // outside changes, install, boot and the gateway
    checkExternalChange,
    startWatching,
    stopWatching,
    installRecord,
    reconcileAtBoot,
    whenReconciled,
    ensureStarted,
    noteGatewaySiteUrl,
    armGateway,
    startGatewaySync,
    stopGatewaySync,
    GATEWAY_SYNC_MS,
    gatewayPolicyPush,
    // the admin screen
    describeState,
    // sessions on retired addresses (middleware/auth.ts sessionAddressStillAccepted, refuseRetiringSession)
    sessionRetired,
    sessionRetiredUntil,
    RETIRED_SESSION_RETENTION_S,
    RETIREMENT_GRACE_S,
};

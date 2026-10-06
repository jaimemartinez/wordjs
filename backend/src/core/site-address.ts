/**
 * WordJS — THE SITE'S ADDRESSES: the one writer of "where does this site live".
 *
 * THE MODEL. One canonical "main address" (`siteUrl` in wordjs-config.json) is the only base for every
 * link built outside the browser: password-reset and verification emails, feeds, the sitemap, plugins'
 * `site.url()`, the mail domain. Any number of ALIASES (`siteAliases`) are addresses the site also
 * answers on — never a link base. IP literals and loopback are accepted by rule (core/host-policy).
 *
 * WHERE EACH VALUE LIVES, AND WHO WRITES IT.
 *   · wordjs-config.json is the master: siteUrl, siteAliases, hostPolicy, and siteAddress.{rev,lastChange}.
 *     Aliases live ONLY there, a file neither `PUT /settings` nor the plugin bridge can reach.
 *   · The options `siteurl`, `home` and `site_address_rev` are MIRRORS for the readers that have always
 *     read them (the SSR layout, plugins). Only this module writes them.
 *   · Writers: `commit()` (the admin API in routes/site-address.ts, and the automatic upgrade below) and
 *     the server-side CLI (scripts/site-address.js), which writes only the file; the running backend
 *     notices the new revision and applies the rest (`checkExternalChange`).
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

export type OldAddressAction = 'keep' | 'redirect' | 'drop';
/** Who or what made a change: the admin screen, the server CLI, or one of the automatic paths. */
export type ChangeVia = 'ui' | 'cli' | 'repair' | 'upgrade' | 'gateway';
export type ChangeKind = 'canonical' | 'aliases' | 'policy' | 'repair';

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
    if (current && current.origin === next.origin) return unchangedPlan('canonical');

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

/** The complete config a plan produces from `current`: the patch, the next revision and its record. */
function applyPlan(current: any, plan: Plan, meta: { via: ChangeVia; actorId: number | null; now: number }): Record<string, any> {
    const previous = current.siteAddress && typeof current.siteAddress === 'object' ? current.siteAddress : {};
    return {
        ...current,
        ...plan.patch,
        siteAddress: {
            ...previous,
            rev: siteAddressRev(current) + 1,
            lastChange: { kind: plan.kind, via: meta.via, by: meta.actorId, at: isoAt(meta.now), ...plan.summary },
        },
        updatedAt: isoAt(meta.now),
    };
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
    console.warn(`[site-address] ${message}`);
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
 */
async function writeMirrors(cfg: any, rev: number, opts: { addresses?: boolean } = {}): Promise<void> {
    const { dbAsync } = require('../config/database');
    const options = require('./options');
    const canonical = opts.addresses === false ? null : hostPolicy.parseSiteUrl(cfg.siteUrl);
    await dbAsync.transaction(async () => {
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

/**
 * Tell the gateway which addresses the site answers (split and separate modes; phase 2). Its edge — the
 * 421 page for pages, static trees, uploads and WebSockets on an address the site does not answer, the
 * 308 of a redirect alias, and R4, which the backend cannot apply behind the gateway because every
 * request it receives comes from a trusted hop — enforces only a policy this backend pushed. A push only
 * stores a file on the gateway (its workers pick it up; nothing restarts), so it follows EVERY change,
 * including one the gateway itself reported. A failure is a warning, never a failed change: the gateway
 * keeps checking against the last set it received.
 */
async function pushPolicyToGateway(cfg: any): Promise<string | null> {
    if (!hasGatewayControlPlane(cfg)) return null;
    try {
        await require('./cert-manager').pushHostPolicyToGateway(gatewayPolicyPush(cfg));
        return null;
    } catch (e: any) {
        warn(`could not tell the gateway which addresses the site answers: ${e && e.message}`);
        return 'The gateway could not be told which addresses the site answers; it keeps checking addresses against the last set it received until the change is saved again or the backend restarts.';
    }
}

/**
 * Push the current addresses to the gateway outside a change: after the boot reconcile, and after this
 * backend registers with the gateway (index.ts) — the boot push may have run before the gateway listened,
 * and a gateway on a fresh machine has nothing stored. The file is read afresh; an unreadable file pushes
 * nothing, so the gateway keeps the last policy it was given (REDTEAM R10). Never throws.
 */
function armGateway(): Promise<string | null> {
    return serial(async () => {
        const fresh = configManager.readConfigFresh();
        if (!fresh.exists || fresh.parseError) return null;
        return pushPolicyToGateway(fresh.parsed);
    });
}

function purgeEverything() {
    try {
        require('./frontend-purge').purgeFrontend(PURGE_TAGS, ['/']);
    } catch { /* the ISR window still expires */ }
}

/** One literal action per kind, so the audit catalogue gate (tests/audit-trail) sees every name. */
async function auditChange(kind: ChangeKind | 'conflict_resolved', actorId: number | null, detail: Record<string, unknown>) {
    const { recordAudit } = require('./audit');
    switch (kind) {
        case 'canonical': return recordAudit(actorId, 'site.address.canonical', 'site', 'address', detail);
        case 'aliases': return recordAudit(actorId, 'site.address.aliases', 'site', 'address', detail);
        case 'policy': return recordAudit(actorId, 'site.address.policy', 'site', 'address', detail);
        case 'repair': return recordAudit(actorId, 'site.address.repair', 'site', 'address', detail);
        case 'conflict_resolved': return recordAudit(actorId, 'site.address.conflict_resolved', 'site', 'address', detail);
    }
}

/** `host[:port]` of an origin, for messages: a bare name reads as text, not as a link to click. */
function plainAddress(value: unknown): string {
    const site = hostPolicy.parseSiteUrl(value);
    return site ? hostPolicy.serialize(site) : String(value || 'none');
}

function describeChange(kind: ChangeKind, summary: Record<string, unknown>): string {
    const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(', ') : 'none');
    switch (kind) {
        case 'canonical':
        case 'repair':
            return `The main address changed from ${plainAddress(summary.from)} to ${plainAddress(summary.to)}.`;
        case 'aliases':
            return `Other addresses changed. Added: ${list(summary.added)}. Removed: ${list(summary.removed)}. Edited: ${list(summary.changed)}.`;
        case 'policy':
            return `The IP address policy changed from ${String(summary.from)} to ${String(summary.to)}.`;
    }
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
async function notifyAdmins(kind: ChangeKind, summary: Record<string, unknown>, via: ChangeVia, actorId: number | null) {
    try {
        const { dbAsync } = require('../config/database');
        const what = describeChange(kind, summary);
        const who = await actorDescription(via, actorId);
        const message = `${what} Changed by ${who}.`;
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
                const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                await Promise.resolve(send({ to, subject: `${siteName}: site address changed`, text, html: `<p>${escape(text).replace(/\n\n/g, '</p><p>')}</p>` }));
            }
        }
    } catch (e: any) {
        warn(`could not notify the administrators: ${e && e.message}`);
    }
}

/** Steps 4–7: never fatal — the change is durable once the mirrors are written. */
async function afterChange(cfg: any, plan: { kind: ChangeKind; summary: Record<string, unknown>; canonicalChanged: boolean }, meta: { via: ChangeVia; actorId: number | null; force?: boolean; rev: number }): Promise<string[]> {
    const warnings: string[] = [];
    // Every kind of change moves the set of addresses the gateway's edge answers (the main address, the
    // aliases, the IP policy) — first, so a new main address is accepted at the edge before the gateway
    // starts building links from it. Also for the gateway's own R1 report: this push restarts nothing.
    const policyWarning = await pushPolicyToGateway(cfg);
    if (policyWarning) warnings.push(policyWarning);
    // The gateway is the source of an automatic R1 upgrade; echoing it back would only restart its workers.
    if (plan.canonicalChanged && meta.via !== 'gateway') {
        const w = await pushToGateway(cfg);
        if (w) warnings.push(w);
    }
    purgeEverything();
    try {
        await auditChange(plan.kind, meta.actorId, { ...plan.summary, via: meta.via, force: meta.force === true, rev: meta.rev });
    } catch { /* recordAudit never throws; belt and braces */ }

    const canonical = hostPolicy.parseSiteUrl(cfg.siteUrl);
    if (canonical) clearNotice(NOTICE_IDS.missingCanonical);
    if (plan.canonicalChanged && conflict) {
        const resolved = conflict;
        conflict = null;
        clearNotice(NOTICE_IDS.conflict);
        try {
            await auditChange('conflict_resolved', meta.actorId, { config: resolved.config, db: resolved.db, chosen: canonical ? canonical.origin : null, via: meta.via });
        } catch { /* never fatal */ }
    }
    if (gatewayDrift && canonical && gatewayDrift.gateway === canonical.origin) {
        gatewayDrift = null;
        clearNotice(NOTICE_IDS.gatewayDrift);
    }
    await notifyAdmins(plan.kind, plan.summary, meta.via, meta.actorId);
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

    const next = applyPlan(current, plan, { via: opts.via, actorId: opts.actorId, now });
    const dependents = interlock(next, plan.removedHosts, { now });
    if (dependents.length && opts.force !== true) {
        throw new SiteAddressError(409, 'rest_site_address_in_use',
            'Something still uses this address. Change it first, or confirm to remove it anyway.', { dependents });
    }

    // The plan is applied to what the writer reads at the moment of writing: with the revision unchanged
    // the site-address keys are the ones planned against, and any other key a different writer stored in
    // the meantime (a purge secret, an ACME setting) is kept rather than overwritten by our snapshot.
    const written = configManager.updateConfig((latest: any) => applyPlan(latest, plan, { via: opts.via, actorId: opts.actorId, now }), { expectRev: rev });
    if (!written.ok) {
        if (written.reason === 'stale') throw new SiteAddressError(409, 'rest_site_address_stale', 'The site address was changed in the meantime. Reload and try again.', { rev: written.currentRev ?? null });
        if (written.reason === 'unreadable') throw new SiteAddressError(503, 'rest_config_unreadable', 'wordjs-config.json cannot be read right now, so nothing was changed. Try again in a moment.');
        throw new SiteAddressError(500, 'rest_site_address_write_failed', 'The site address could not be saved.');
    }
    const newRev = rev + 1;
    lastAppliedRev = newRev;
    policyProvider().invalidate();

    try {
        await writeMirrors(written.config, newRev);
    } catch (e: any) {
        // Undo the file so the two stores keep naming the same address — unless the file has moved on
        // (a CLI write landed after ours), in which case that newer change stands.
        const restored = written.previousText !== null && configManager.restoreConfigText(written.previousText, { expectRev: newRev });
        if (restored) {
            lastAppliedRev = rev;
            policyProvider().invalidate();
        }
        console.error(`[site-address] the database refused the address change (${e && e.message}); ${restored ? 'the previous configuration was restored' : 'the configuration file could not be restored'}.`);
        throw new SiteAddressError(500, 'rest_site_address_rollback',
            restored ? 'The change could not be stored in the database, so it was undone. Nothing changed.' : 'The change could not be stored in the database.',
            { restored });
    }

    const warnings = await afterChange(written.config, plan, { via: opts.via, actorId: opts.actorId, force: opts.force, rev: newRev });
    if (plan.kind === 'policy' && typeof process.env.WORDJS_IP_HOSTS === 'string' && process.env.WORDJS_IP_HOSTS.trim() !== '') {
        warnings.push('WORDJS_IP_HOSTS is set on the server and overrides this setting until it is removed.');
    }
    return { rev: newRev, warnings };
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
async function applyExternal(cfg: any): Promise<void> {
    const rev = siteAddressRev(cfg);
    const { getOption } = require('./options');
    const before = hostPolicy.parseSiteUrl(await getOption('siteurl', null));
    runtimeReload(cfg);
    policyProvider().invalidate();
    await writeMirrors(cfg, rev);
    lastAppliedRev = rev;

    const change = cfg.siteAddress && typeof cfg.siteAddress.lastChange === 'object' && cfg.siteAddress.lastChange ? cfg.siteAddress.lastChange : {};
    const kinds: ChangeKind[] = ['canonical', 'aliases', 'policy', 'repair'];
    const kind: ChangeKind = kinds.includes(change.kind) ? change.kind : 'aliases';
    const via: ChangeVia = ['ui', 'cli', 'repair', 'upgrade', 'gateway'].includes(change.via) ? change.via : 'cli';
    const canonical = hostPolicy.parseSiteUrl(cfg.siteUrl);
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(change)) {
        if (['kind', 'via', 'by', 'at'].includes(key)) continue;
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) summary[key] = value;
        else if (Array.isArray(value)) summary[key] = hostList(value.filter((v) => typeof v === 'string'));
    }
    const canonicalChanged = !!canonical && (!before || before.origin !== canonical.origin);
    if (canonicalChanged) Object.assign(summary, { from: before ? before.origin : null, to: canonical!.origin });
    await afterChange(cfg, { kind, summary, canonicalChanged }, { via, actorId: null, rev });
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
            await applyExternal(cfg);
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
            await applyExternal(cfg);
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
        ownAddresses: [...policy.ownAddresses()].sort(),
        devOrigins: [...policy.devOrigins].sort(),
        dev: policy.dev,
        connectedVia: siteHost ? { host: siteHost.host, cls: siteHost.cls } : null,
        recentlyRefused: hostPolicy.refusedHosts.list(),
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
    applyPlan,
    salvageSiteUrl,
    isAutomaticUpgrade,
    // writing
    commit,
    // outside changes, boot and the gateway
    checkExternalChange,
    startWatching,
    stopWatching,
    reconcileAtBoot,
    whenReconciled,
    ensureStarted,
    noteGatewaySiteUrl,
    armGateway,
    gatewayPolicyPush,
    // the admin screen
    describeState,
};

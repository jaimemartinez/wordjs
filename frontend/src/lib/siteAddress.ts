/**
 * The site address on the client: the admin screen's rules, the refused-address notice, the install
 * wizard's prefill and the dashboard banners. Everything here is pure (no React, no DOM reads) except
 * `siteAddressApi`, so the decisions can be pinned in node.
 *
 * THE MODEL (one canonical, many accepted addresses). The canonical "main address" is the only base for
 * links built outside the browser (emails, feeds, sitemap, plugins). Aliases are extra addresses the site
 * ANSWERS on, never a link base. IP literals and loopback are accepted by rule. The backend owns every
 * decision; this file only makes the screen honest about what the backend will do, so the admin is not
 * surprised by a 400/409 after typing a password.
 *
 * THE API THIS SPEAKS (backend/src/routes/site-address.ts, mounted at /api/v1/site-address; every call
 * is administrator + browser-session only, and every write also needs `currentPassword` and `rev`):
 *
 *   GET /                → the state, read through `normalizeSiteAddressState` below
 *   PUT /canonical       { url, oldAddress: 'keep'|'redirect'|'drop', currentPassword, rev, force? }
 *   PUT /aliases         { aliases: AliasWrite[], currentPassword, rev, force?, confirmLocal? }
 *   PUT /policy          { ipLiterals: 'any'|'own'|'none', ipSignIn?: boolean, currentPassword, rev }
 *
 * A write answers `{ rev?, warnings?: string[] }`; the screen re-reads the state afterwards rather than
 * trusting a partial echo. Refusals: 403 rest_bad_current_password (sudo), 409 with
 * `data.dependents` (the interlock: something still uses the address; `force: true` overrides and is
 * audited), any other 409 (the rev moved: someone else changed the address in the meantime), 400 (the
 * value itself).
 */
import { api } from "@/lib/api";

// ─── Parsing an operator-typed site address ─────────────────────────────────────────────────────────

export type HostKind = "dns" | "ipv4" | "ipv6";
export type Scheme = "http" | "https";

export interface SiteAddress {
    /** `scheme://hostname[:port]`, default port dropped, one trailing dot removed, IDN as punycode. */
    origin: string;
    scheme: Scheme;
    hostname: string;
    port: number | null;
    kind: HostKind;
}

// Never part of a bare origin, and each one is something WHATWG would silently rewrite or reinterpret:
// '@' userinfo, '\\' (read as '/'), '?' '#' query and fragment, '%' escapes, '*' wildcards (not
// supported: a dangling subdomain would become an attacker's rebinding name), whitespace and controls.
const FORBIDDEN_IN_SITE_URL = /[\s\x00-\x1f\x7f@\\?#%*]/;
const NON_ASCII = /[^\x00-\x7f]/;
const DNS_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const DEC_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const ALL_DIGITS = /^\d+$/;
const PORT = /^[1-9]\d{0,4}$/;

/**
 * The client half of the backend's `parseSiteUrl` (core/host-policy.js): `http(s)://host[:port]` and
 * nothing else. It exists so the screen can say "not a site address" before the password is asked for;
 * the backend parses again and is the authority. The shared conformance vectors
 * (contracts/host-policy-vectors.v1.json) pin the two to the same accept/reject answers.
 *
 * What is typed must be what gets stored: `https://127.1` is NOT quietly "fixed" to 127.0.0.1, and a
 * full-width look-alike is not folded into ASCII. A genuine internationalised name is accepted and comes
 * back as punycode, which is also how the screen shows it (homograph safety).
 */
export function parseSiteAddress(input: unknown): SiteAddress | null {
    if (typeof input !== "string") return null;
    const s = input.trim();
    if (s === "" || s.length > 2048 || FORBIDDEN_IN_SITE_URL.test(s)) return null;
    const shape = /^(https?):\/\/([^/]+)\/?$/i.exec(s);
    if (!shape) return null;
    let u: URL;
    try {
        u = new URL(s);
    } catch {
        return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/") return null;

    const typed = shape[2];
    let typedName = typed;
    let typedPort: string | null = null;
    if (typed.startsWith("[")) {
        const close = typed.indexOf("]");
        if (close === -1) return null;
        typedName = typed.slice(0, close + 1);
        const rest = typed.slice(close + 1);
        if (rest !== "") {
            if (rest[0] !== ":") return null;
            typedPort = rest.slice(1);
        }
    } else {
        const colon = typed.lastIndexOf(":");
        if (colon !== -1) {
            typedName = typed.slice(0, colon);
            typedPort = typed.slice(colon + 1);
        }
    }
    if (typedPort !== null && (!PORT.test(typedPort) || Number(typedPort) > 65535)) return null;

    let hostname = u.hostname.toLowerCase();
    if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
    if (hostname === "" || hostname.length > 253) return null;

    let kind: HostKind;
    if (hostname.startsWith("[")) {
        // WHATWG prints every IPv6 spelling one way; only a typed bracket may produce one.
        if (!typedName.startsWith("[")) return null;
        kind = "ipv6";
    } else {
        const labels = hostname.split(".");
        if (labels.every((label) => ALL_DIGITS.test(label))) {
            if (labels.length !== 4 || !labels.every((label) => DEC_OCTET.test(label))) return null;
            kind = "ipv4";
        } else {
            if (!labels.every((label) => DNS_LABEL.test(label))) return null;
            if (ALL_DIGITS.test(labels[labels.length - 1])) return null;
            kind = "dns";
        }
        const asTyped = typedName.toLowerCase().replace(/\.$/, "");
        if (NON_ASCII.test(asTyped)) {
            if (kind !== "dns" || !labels.some((label) => label.startsWith("xn--"))) return null;
        } else if (asTyped !== hostname) {
            return null;
        }
    }

    const scheme: Scheme = u.protocol === "https:" ? "https" : "http";
    const port = u.port ? Number(u.port) : null;
    return { origin: `${scheme}://${hostname}${port ? `:${port}` : ""}`, scheme, hostname, port, kind };
}

/** Case- and trailing-dot-insensitive hostname equality (`Example.com.` is `example.com`). */
export function sameHostname(a: string | null | undefined, b: string | null | undefined): boolean {
    const norm = (h: string) => h.toLowerCase().replace(/\.$/, "");
    return !!a && !!b && norm(a) === norm(b);
}

/** localhost, *.localhost, 127.0.0.0/8, [::1] and IPv4-mapped loopback: names that mean "this machine". */
export function isLoopbackHostname(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    if (h === "localhost" || h.endsWith(".localhost")) return true;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    return h === "[::1]" || /^\[::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(h);
}

// ─── Risky addresses (REDTEAM R2) ────────────────────────────────────────────────────────────────────

/**
 * Hostnames tunnel services hand out. A name is released when the tunnel restarts and the next customer
 * may receive it, so it gets a short default expiry and no sign-in by default. This list MUST equal
 * TUNNEL_SUFFIXES in backend/src/core/host-policy.js (a test compares them): the screen's default and
 * the backend's default have to be the same default.
 */
export const TUNNEL_SUFFIXES: readonly string[] = Object.freeze([
    "ngrok-free.app", "ngrok-free.dev", "ngrok.app", "ngrok.dev", "ngrok.io",
    "trycloudflare.com", "loca.lt", "localhost.run", "lhr.life", "serveo.net",
]);

export function isTunnelHost(hostname: string): boolean {
    return TUNNEL_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** mDNS names: anyone on the LAN can answer for them. */
export function isLanName(hostname: string): boolean {
    return hostname === "local" || hostname.endsWith(".local");
}

export type AddressRisk = "ip" | "tunnel" | "local" | null;

/** Why an address must not mint sessions by default: the session outlives the name (R2). */
export function addressRisk(address: { hostname: string; kind: HostKind }): AddressRisk {
    if (address.kind !== "dns") return "ip";
    if (isTunnelHost(address.hostname)) return "tunnel";
    if (isLanName(address.hostname)) return "local";
    return null;
}

/** Tunnel names default to a week; the admin can change or clear it. */
export const TUNNEL_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The expiry a NEW address starts with: a week for tunnel names, none otherwise. ISO string or null. */
export function defaultExpiryFor(hostname: string, now: number): string | null {
    return isTunnelHost(hostname) ? new Date(now + TUNNEL_DEFAULT_TTL_MS).toISOString() : null;
}

export type SignInWarning = "plain-http" | "ip" | "tunnel" | "local" | null;

export interface SignInPolicy {
    /** Whether the screen shows the per-address sign-in switch at all. */
    relevant: boolean;
    /** What the backend assumes when the address carries no explicit `signIn`. */
    defaultValue: boolean;
    /** The value in force: the explicit flag, else the default. */
    effective: boolean;
    /** Why turning it on deserves a warning. */
    warning: SignInWarning;
}

/**
 * May a session be started on this address? Mirrors the backend's `defaultSignIn`: an explicit flag
 * wins; otherwise no for IP literals, tunnel names and .local names whatever the scheme (R2), and no for
 * a plain-http address on an https site (the cookie would cross the wire in clear text). For an ordinary
 * https name the answer is yes and there is nothing to choose, so the switch is not shown — the backend
 * still checks the real transport of every sign-in (R9).
 */
export function signInPolicy(
    address: { scheme: Scheme; hostname: string; kind: HostKind; signIn: boolean | null },
    canonical: { scheme: Scheme } | null,
): SignInPolicy {
    const risk = addressRisk(address);
    const plainHttpOnHttps = address.scheme === "http" && canonical?.scheme === "https";
    const defaultValue = !risk && !plainHttpOnHttps;
    return {
        relevant: !defaultValue,
        defaultValue,
        effective: address.signIn ?? defaultValue,
        warning: plainHttpOnHttps ? "plain-http" : risk,
    };
}

// ─── The state the screen renders ───────────────────────────────────────────────────────────────────

export type IpLiteralMode = "any" | "own" | "none";
export type HostClass = "canonical" | "alias" | "env" | "loopback" | "ip" | "dev";
export type RefusalHint = "forward-host" | "tunnel" | "www-apex" | "local";
/** Who refused a host: the public listener's edge check, the backend's own gate, or each of them. */
export type RefusalSource = "edge" | "gate" | "both";
export type SiteNotice = "proxy-collapse" | "missing-canonical";
export type AliasMode = "serve" | "redirect";

export interface AliasView extends SiteAddress {
    mode: AliasMode;
    label: string | null;
    /** The explicit flag as stored; null means the default applies (see signInPolicy). */
    signIn: boolean | null;
    /** admin | cli | install | config — who added it. */
    source: string;
    /** ISO instant after which the backend stops answering on it, or null. */
    expiresAt: string | null;
    /** Epoch ms of the last request the gate accepted on it, or null. */
    lastSeenAt: number | null;
    /** Epoch ms of the last signed-in request on it — the only use the remove interlock counts (R7). */
    lastSignedInAt: number | null;
}

export interface SiteAddressState {
    rev: number;
    canonical: SiteAddress | null;
    aliases: AliasView[];
    /** WORDJS_ALLOWED_HOSTS: read-only, from the server environment. */
    envHosts: string[];
    ipLiterals: IpLiteralMode;
    ipLiteralsSource: "default" | "config" | "env";
    ipSignIn: boolean;
    /** The IP addresses `own` answers. */
    ownAddresses: string[];
    /** Whose they are: the gateway's, as it reported them (split and separate mode), or this server's. */
    ownAddressesFrom: "gateway" | "server";
    devOrigins: string[];
    dev: boolean;
    connectedVia: { host: string; cls: HostClass | string } | null;
    /** `source` is null when the backend did not say (an older version). */
    recentlyRefused: Array<{ host: string; count: number; lastSeen: number | null; hint: RefusalHint | null; source: RefusalSource | null }>;
    /** Upgrade conflict: the config file and the database name different main addresses. */
    conflict: { config: string; db: string } | null;
    /** The gateway reports a main address different from the configured one (typically after an SSL toggle). */
    gatewayDrift: { gateway: string; config: string } | null;
    notices: SiteNotice[];
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const asString = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Epoch ms from a number or an ISO string; null for anything else. */
function toMillis(v: unknown): number | null {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string") {
        const ms = Date.parse(v);
        return Number.isNaN(ms) ? null : ms;
    }
    return null;
}

/** An address given as a URL string or as an object carrying `url`/`origin`. */
function addressOf(v: unknown): SiteAddress | null {
    if (typeof v === "string") return parseSiteAddress(v);
    const r = asRecord(v);
    return r ? parseSiteAddress(r.url ?? r.origin) : null;
}

function aliasFrom(raw: unknown): AliasView | null {
    const r = asRecord(typeof raw === "string" ? { url: raw } : raw);
    if (!r) return null;
    const site = addressOf(r);
    if (!site) return null;
    // The policy's own entries carry the EFFECTIVE flag plus `signInExplicit`; the config's carry only
    // what the operator wrote. Either way only an explicit choice is kept, so a save never freezes a
    // default (an http alias would otherwise stay "off" after the site itself moves to http).
    const explicit = r.signInExplicit === undefined ? typeof r.signIn === "boolean" : r.signInExplicit === true;
    const expires = toMillis(r.expiresAt);
    const seen = asRecord(r.lastSeen);
    return {
        ...site,
        mode: r.mode === "redirect" ? "redirect" : "serve",
        label: asString(r.label),
        signIn: explicit && typeof r.signIn === "boolean" ? r.signIn : null,
        source: asString(r.source) ?? "config",
        expiresAt: expires === null ? null : new Date(expires).toISOString(),
        lastSeenAt: seen ? toMillis(seen.seenAt) : toMillis(r.lastSeen),
        lastSignedInAt: seen ? toMillis(seen.authenticatedAt) : null,
    };
}

function envHostFrom(raw: unknown): string | null {
    if (typeof raw === "string") return asString(raw);
    const r = asRecord(raw);
    if (!r) return null;
    const origin = asString(r.origin);
    if (origin) return origin;
    const hostname = asString(r.hostname);
    return hostname ? `${hostname}${typeof r.port === "number" ? `:${r.port}` : ""}` : null;
}

/**
 * The heading over the addresses `own` answers. Behind a gateway they are the gateway's (it reports
 * them), and saying "this server's" there named the wrong machine in separate mode (lab R2-NEW-1).
 */
export function ownAddressesHeadingKey(from: SiteAddressState["ownAddressesFrom"]): string {
    return from === "gateway" ? "siteAddress.accepted.ownGateway" : "siteAddress.accepted.own";
}

/**
 * The text of an IP-rule choice, in the <option> list and in the confirmation summary. `own` says whose
 * addresses it keeps, as the heading above it does (review UX-1: "Only this server's addresses" sat right
 * under "The gateway's addresses", and meant the gateway's).
 */
export function ipLiteralsLabelKey(mode: IpLiteralMode, from: SiteAddressState["ownAddressesFrom"]): string {
    return mode === "own" && from === "gateway" ? "siteAddress.ip.ownGateway" : `siteAddress.ip.${mode}`;
}

/** The small «Recently refused» label naming who refused a host, or null when the backend did not say. */
export function refusedByKey(source: RefusalSource | null): string | null {
    return source === "edge" || source === "gate" || source === "both" ? `siteAddress.refusedBy.${source}` : null;
}

const HINTS: readonly RefusalHint[] = ["forward-host", "tunnel", "www-apex", "local"];
const SOURCES: readonly RefusalSource[] = ["edge", "gate", "both"];
const NOTICES: readonly SiteNotice[] = ["proxy-collapse", "missing-canonical"];

/** Hosts the screen shows as text. They passed the backend's grammar, so this only drops junk. */
const SAFE_HOST_TEXT = /^[a-z0-9.\-_:[\]]{1,261}$/;

/**
 * GET /site-address → the screen's state. Tolerant of the shapes the backend naturally has (the
 * policy's Maps serialised as arrays, timestamps as epoch ms or ISO strings, the canonical as a URL or
 * a parsed object) and strict about content: an entry that is not a valid address is dropped rather
 * than rendered, so a hostile config value can never become a link.
 */
export function normalizeSiteAddressState(raw: unknown): SiteAddressState {
    const r = asRecord(raw) ?? {};
    const conflict = asRecord(r.conflict);
    const drift = asRecord(r.gatewayDrift);
    const via = asRecord(r.connectedVia);
    const conflictConfig = conflict ? asString(conflict.config ?? conflict.configUrl) : null;
    const conflictDb = conflict ? asString(conflict.db ?? conflict.dbUrl) : null;
    const driftGateway = drift ? asString(drift.gateway ?? drift.gatewayUrl) : null;
    const driftConfig = drift ? asString(drift.config ?? drift.configUrl) : null;
    const ip = r.ipLiterals;
    const ipSource = r.ipLiteralsSource;
    return {
        rev: typeof r.rev === "number" && Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0,
        canonical: addressOf(r.canonical),
        aliases: asList(r.aliases).map(aliasFrom).filter((a): a is AliasView => a !== null),
        envHosts: asList(r.envHosts).map(envHostFrom).filter((h): h is string => h !== null),
        ipLiterals: ip === "own" || ip === "none" ? ip : "any",
        ipLiteralsSource: ipSource === "config" || ipSource === "env" ? ipSource : "default",
        ipSignIn: r.ipSignIn === true,
        ownAddresses: asList(r.ownAddresses).map(asString).filter((h): h is string => h !== null),
        ownAddressesFrom: r.ownAddressesFrom === "gateway" ? "gateway" : "server",
        devOrigins: asList(r.devOrigins).map(asString).filter((h): h is string => h !== null),
        dev: r.dev === true,
        connectedVia: via && asString(via.host) ? { host: asString(via.host) as string, cls: asString(via.cls) ?? "unknown" } : null,
        recentlyRefused: asList(r.recentlyRefused).flatMap((item) => {
            const e = asRecord(item);
            const host = e ? asString(e.host ?? e.hostname) : null;
            if (!e || !host || !SAFE_HOST_TEXT.test(host)) return [];
            const hint = HINTS.find((h) => h === e.hint) ?? null;
            const source = SOURCES.find((s) => s === e.source) ?? null;
            const count = typeof e.count === "number" && e.count > 0 ? Math.floor(e.count) : 1;
            return [{ host, count, lastSeen: toMillis(e.lastSeen), hint, source }];
        }),
        conflict: conflictConfig && conflictDb ? { config: conflictConfig, db: conflictDb } : null,
        gatewayDrift: driftGateway && driftConfig ? { gateway: driftGateway, config: driftConfig } : null,
        notices: asList(r.notices).filter((n): n is SiteNotice => NOTICES.includes(n as SiteNotice)),
    };
}

// ─── Editing the alias list ─────────────────────────────────────────────────────────────────────────

/** One alias as PUT /aliases takes it. Who added it and when stays with the backend's own record. */
export interface AliasWrite {
    url: string;
    mode: AliasMode;
    label?: string;
    signIn?: boolean;
    expiresAt?: string;
}

/**
 * The full list for PUT /aliases (it REPLACES the list). Every explicit choice an entry carries is sent
 * back unchanged — dropping an explicit `signIn: false` on an unrelated save would silently re-enable
 * sign-in on that address.
 */
export function aliasesForWrite(list: readonly AliasView[]): AliasWrite[] {
    return list.map((a) => ({
        url: a.origin,
        mode: a.mode,
        ...(a.label ? { label: a.label } : {}),
        ...(a.signIn !== null ? { signIn: a.signIn } : {}),
        ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
    }));
}

/**
 * Insert `entry`, or put it in the place of the alias being edited (`previousHostname`, which may differ
 * when the admin corrected the address) — else of the one with the same hostname: aliases are matched by
 * hostname, never by port, so two entries for one name cannot coexist.
 */
export function upsertAlias(list: readonly AliasView[], entry: AliasView, previousHostname: string | null = null): AliasView[] {
    const key = previousHostname ?? entry.hostname;
    const i = list.findIndex((a) => a.hostname === key);
    if (i === -1) return [...list, entry];
    const next = [...list];
    next[i] = entry;
    return next;
}

export function withoutAlias(list: readonly AliasView[], hostname: string): AliasView[] {
    return list.filter((a) => a.hostname !== hostname);
}

export type AliasError = "invalid" | "is-canonical" | "duplicate" | "expiry-past" | "expiry-invalid";

/**
 * An alias as the add/edit dialog builds it. Returns the entry, or the reason it cannot be saved.
 * `previous` is the entry being edited: its bookkeeping is kept, and an expiry it already had is not
 * re-judged (editing the label of an expired tunnel must not demand a new date). A NEW expiry must lie
 * after `now`.
 */
export function buildAlias(
    input: { url: string; label: string; mode: AliasMode; signIn: boolean | null; expiresAt: string | null },
    ctx: { canonical: SiteAddress | null; existing: readonly AliasView[]; previous: AliasView | null; now: number },
): { alias: AliasView } | { error: AliasError } {
    const site = parseSiteAddress(input.url);
    if (!site) return { error: "invalid" };
    if (ctx.canonical && site.hostname === ctx.canonical.hostname) return { error: "is-canonical" };
    if (ctx.existing.some((a) => a.hostname === site.hostname && a.hostname !== ctx.previous?.hostname)) {
        return { error: "duplicate" };
    }
    let expiresAt: string | null = null;
    if (input.expiresAt) {
        const ms = Date.parse(input.expiresAt);
        if (Number.isNaN(ms)) return { error: "expiry-invalid" };
        if (ms <= ctx.now && input.expiresAt !== ctx.previous?.expiresAt) return { error: "expiry-past" };
        expiresAt = new Date(ms).toISOString();
    }
    const label = input.label.trim().slice(0, 100);
    const sameName = ctx.previous?.hostname === site.hostname;
    return {
        alias: {
            ...site,
            mode: input.mode,
            label: label || null,
            // The switch is only offered where it matters, and only its value is written there. Elsewhere
            // an explicit choice the entry already carried (from the config file or the CLI) is kept.
            signIn: signInPolicy({ ...site, signIn: null }, ctx.canonical).relevant
                ? input.signIn
                : (sameName ? ctx.previous?.signIn ?? null : null),
            source: ctx.previous?.source ?? "admin",
            expiresAt,
            lastSeenAt: ctx.previous?.lastSeenAt ?? null,
            lastSignedInAt: ctx.previous?.lastSignedInAt ?? null,
        },
    };
}

// ─── Changing the main address ──────────────────────────────────────────────────────────────────────

export type CanonicalNote = "links" | "mail" | "tls" | "seo" | "downgrade" | "dropCurrent";

/**
 * The new main address the change dialog would submit, or why not. Only an exact repeat of the current
 * ORIGIN is refused: the same name with another scheme or port is a real change (moving to https). Not
 * while an upgrade conflict is shown (`conflict`): the database still names another address, and
 * confirming the configured one ("Use A") is how that is resolved; the server records it as a choice.
 */
export function canonicalChoice(url: string, current: SiteAddress | null, opts: { conflict?: boolean } = {}): { site: SiteAddress } | { error: "invalid" | "is-canonical" } {
    const site = parseSiteAddress(url);
    if (!site) return { error: "invalid" };
    if (current && current.origin === site.origin && !opts.conflict) return { error: "is-canonical" };
    return { site };
}

/** Whether "what happens to the current address" is a question: only when the NAME changes. */
export function oldAddressApplies(next: SiteAddress, current: SiteAddress | null): boolean {
    return !!current && current.hostname !== next.hostname;
}

/**
 * What the admin must know before moving the main address, in the order the dialog lists it. The
 * downgrade note is there because every reset and verification link would then travel in clear text;
 * the drop note because dropping the address this tab is using ends the admin's own access through it.
 */
export function canonicalChangeNotes(input: {
    next: SiteAddress;
    current: SiteAddress | null;
    oldAddress: OldAddressAction;
    usingCurrent: boolean;
}): CanonicalNote[] {
    const notes: CanonicalNote[] = ["links", "mail"];
    if (input.next.scheme === "https") notes.push("tls");
    notes.push("seo");
    if (input.current?.scheme === "https" && input.next.scheme === "http") notes.push("downgrade");
    if (input.oldAddress === "drop" && input.usingCurrent && oldAddressApplies(input.next, input.current)) notes.push("dropCurrent");
    return notes;
}

/** `YYYY-MM-DD` in the local calendar (a date input's value) for an ISO instant; '' for none. */
export function expiryToDateInput(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A date input's value → the END of that local day (an address expiring "on the 12th" works all day). */
export function dateInputToExpiry(value: string): string | null {
    return value ? `${value}T23:59:59` : null;
}

/** True when a write must carry `confirmLocal` (a .local name is in the list; see isLanName). */
export function needsLocalConfirmation(list: readonly AliasView[]): boolean {
    return list.some((a) => isLanName(a.hostname));
}

/** Is this the address the admin is browsing on right now? Removing it ends this tab's access. */
export function isCurrentAddress(hostname: string, state: Pick<SiteAddressState, "connectedVia">, locationHostname: string): boolean {
    if (sameHostname(hostname, locationHostname)) return true;
    const via = state.connectedVia?.host;
    return !!via && sameHostname(hostname, via.replace(/:\d+$/, ""));
}

// ─── The IP-address policy ──────────────────────────────────────────────────────────────────────────

export interface PolicyWrite {
    ipLiterals: IpLiteralMode;
    /** Only sent when it changes: the backend keeps the stored value otherwise. */
    ipSignIn?: boolean;
}

/**
 * What the "IP addresses" form would send to PUT /policy, or null when there is nothing to save. The
 * form holds two settings: which IP literals the site answers on, and whether a session may be started
 * on one (hostPolicy.ipSignIn: off by default in production, REDTEAM R2 — the only switch that lets an
 * operator sign in at http://192.168.1.50:3000 on a site whose main address is a name).
 *
 * The endpoint always takes `ipLiterals`, and the screen only knows the EFFECTIVE mode. While
 * WORDJS_IP_HOSTS sets it, that is the variable's value, not the file's, and sending it would copy the
 * override into wordjs-config.json, where it outlives the variable. So the form is read-only then; the
 * CLI (`npm run site -- ip-signin on|off`) reads the file and still works.
 */
export function policyWrite(
    state: Pick<SiteAddressState, "ipLiterals" | "ipLiteralsSource" | "ipSignIn">,
    choice: { ipLiterals: IpLiteralMode; ipSignIn: boolean },
): PolicyWrite | null {
    if (state.ipLiteralsSource === "env") return null;
    const signInChanged = choice.ipSignIn !== state.ipSignIn;
    if (choice.ipLiterals === state.ipLiterals && !signInChanged) return null;
    return { ipLiterals: choice.ipLiterals, ...(signInChanged ? { ipSignIn: choice.ipSignIn } : {}) };
}

// ─── Write refusals ─────────────────────────────────────────────────────────────────────────────────

export interface Dependent {
    /** gatewayUrl | frontendUrl | recent-use — or another reason the backend names. */
    kind: string;
    host: string | null;
    detail: string | null;
}

export type WriteFailure =
    | { kind: "bad-password" }
    | { kind: "in-use"; dependents: Dependent[] }
    | { kind: "stale" }
    | { kind: "rejected"; message: string }
    | { kind: "failed"; message: string };

function dependentFrom(raw: unknown): Dependent | null {
    if (typeof raw === "string") return asString(raw) ? { kind: "other", host: null, detail: raw.trim() } : null;
    const r = asRecord(raw);
    if (!r) return null;
    return {
        kind: asString(r.kind ?? r.reason) ?? "other",
        host: asString(r.host ?? r.hostname),
        detail: asString(r.detail ?? r.url),
    };
}

/** What a failed write means for the screen. `err` is what `api()` threw. */
export function classifyWriteError(err: unknown): WriteFailure {
    const e = (err && typeof err === "object" ? err : {}) as {
        status?: number; code?: string; message?: string; data?: Record<string, unknown>; details?: unknown;
    };
    const message = typeof e.message === "string" && e.message ? e.message : "Request failed";
    if (e.code === "rest_bad_current_password") return { kind: "bad-password" };
    if (e.status === 409) {
        const list = asList(e.data?.dependents ?? asRecord(e.details)?.dependents);
        const dependents = list.map(dependentFrom).filter((d): d is Dependent => d !== null);
        // The interlock always names what depends on the address; a 409 that names nothing is the rev.
        return dependents.length > 0 ? { kind: "in-use", dependents } : { kind: "stale" };
    }
    if (e.status === 400) return { kind: "rejected", message };
    return { kind: "failed", message };
}

// ─── The API ────────────────────────────────────────────────────────────────────────────────────────

export type OldAddressAction = "keep" | "redirect" | "drop";

export interface WriteResult {
    rev?: number;
    /** Non-fatal follow-ups, e.g. the gateway could not be told yet. */
    warnings?: string[];
}

const BASE = "/site-address";

/**
 * Refuse a blank password BEFORE the network: the backend proves it through the same per-account
 * lockout bucket as /auth/login, so an empty field sent by accident would count against the admin.
 */
function requirePassword(currentPassword: string): void {
    if (!currentPassword) throw new Error("Enter your current password to confirm this change.");
}

export const siteAddressApi = {
    get: async (): Promise<SiteAddressState> => normalizeSiteAddressState(await api<unknown>(BASE)),
    putCanonical: (body: { url: string; oldAddress: OldAddressAction; currentPassword: string; rev: number; force?: boolean }) => {
        requirePassword(body.currentPassword);
        return api<WriteResult>(`${BASE}/canonical`, { method: "PUT", body });
    },
    putAliases: (body: { aliases: AliasWrite[]; currentPassword: string; rev: number; force?: boolean; confirmLocal?: boolean }) => {
        requirePassword(body.currentPassword);
        return api<WriteResult>(`${BASE}/aliases`, { method: "PUT", body });
    },
    putPolicy: (body: { ipLiterals: IpLiteralMode; ipSignIn?: boolean; currentPassword: string; rev: number }) => {
        requirePassword(body.currentPassword);
        return api<WriteResult>(`${BASE}/policy`, { method: "PUT", body });
    },
};

// ─── The refused-address notice ─────────────────────────────────────────────────────────────────────

export type NoticeLanguage = "es" | "en" | "pt";

/**
 * Where lib/i18n keeps the admin's language choice. Read here directly because the notice must not
 * import lib/i18n up front (it is the whole admin catalogue); a test pins this to what
 * `setStoredLanguage` writes.
 */
export const ADMIN_LANGUAGE_STORAGE_KEY = "wordjs-lang";

/**
 * The admin's stored language choice, or null when none was made or storage is unavailable. Takes a
 * getter because merely READING `window.localStorage` throws in some privacy modes and sandboxed frames.
 */
export function storedAdminLanguage(getStorage: () => Pick<Storage, "getItem"> | null | undefined): string | null {
    try {
        return getStorage()?.getItem(ADMIN_LANGUAGE_STORAGE_KEY) ?? null;
    } catch {
        return null;
    }
}

/**
 * Which language the notice speaks: the admin's own choice when they made one, else the site's
 * document language, else English — a visitor who reached the wrong address may not read the default
 * admin language.
 */
export function noticeLanguage(stored: string | null, documentLang: string | null): NoticeLanguage {
    const pick = (v: string | null) => {
        const base = (v ?? "").toLowerCase().split(/[-_]/)[0];
        return base === "es" || base === "en" || base === "pt" ? base : null;
    };
    return pick(stored) ?? pick(documentLang) ?? "en";
}

/** `{name}` placeholders → values. Values are inserted as text; React escapes them when rendered. */
export function fillTemplate(template: string, values: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}

/**
 * Where the notice sends the visitor: the configured main address plus the path they were on. Null when
 * there is no usable main address, or when it IS this origin (a link to the page that refused them
 * would be a loop). `configured` comes from the site's own settings, but it is still parsed: a corrupted
 * value must not become an href.
 */
export function canonicalLink(configured: unknown, location: { origin: string; pathname: string }): { href: string; origin: string } | null {
    const site = parseSiteAddress(configured);
    if (!site) return null;
    const here = parseSiteAddress(location.origin);
    if (here && here.origin === site.origin) return null;
    const path = location.pathname.startsWith("/") ? location.pathname : "/";
    return { href: `${site.origin}${path}`, origin: site.origin };
}

// ─── Dashboard banners ──────────────────────────────────────────────────────────────────────────────

export type DashboardBanner =
    | { kind: "link-base"; linkBase: string }
    | { kind: "conflict"; config: string; db: string }
    | { kind: "gateway-drift"; gateway: string; config: string }
    | { kind: "proxy-collapse" }
    | { kind: "missing-canonical" };

/**
 * The admin-shell banners. `linkBase` is the public `siteurl` option, i.e. what emails and feeds really
 * use, so the "you are on another address" banner tells the truth even during an upgrade conflict.
 * `admin` is the site-address state, only fetched for administrators (R8); without it only the link-base
 * banner can show.
 */
export function dashboardBanners(input: { locationHostname: string; linkBase: unknown; admin: SiteAddressState | null }): DashboardBanner[] {
    const out: DashboardBanner[] = [];
    const base = parseSiteAddress(input.linkBase);
    if (base && !sameHostname(base.hostname, input.locationHostname)) out.push({ kind: "link-base", linkBase: base.origin });
    const admin = input.admin;
    if (!admin) return out;
    if (admin.conflict) out.push({ kind: "conflict", ...admin.conflict });
    if (admin.gatewayDrift) out.push({ kind: "gateway-drift", ...admin.gatewayDrift });
    if (admin.notices.includes("proxy-collapse")) out.push({ kind: "proxy-collapse" });
    if (!admin.canonical || admin.notices.includes("missing-canonical")) out.push({ kind: "missing-canonical" });
    return out;
}

// ─── Install wizard (REDTEAM R6) ────────────────────────────────────────────────────────────────────

/**
 * The server-side suggestion (WORDJS_SITE_URL) the wizard may OFFER next to the prefilled address. The
 * field itself is always prefilled from the address being browsed: the default compose file exports
 * `http://localhost:3000`, and taking that as the main address would point every emailed link at the
 * recipient's own machine. So a loopback suggestion is never offered, nor one equal to where we are.
 */
export function installSuggestion(locationOrigin: string, suggested: unknown): string | null {
    const site = parseSiteAddress(suggested);
    if (!site || isLoopbackHostname(site.hostname)) return null;
    const here = parseSiteAddress(locationOrigin);
    return here && here.origin === site.origin ? null : site.origin;
}

/**
 * The address being browsed, when the chosen main address is a different NAME: the wizard offers to
 * keep answering on it (POST /setup/install `acceptCurrentAddress`; the backend takes the address from
 * the request itself, never from the body). IPs and loopback are accepted by rule anyway.
 */
export function currentAddressAsAlias(locationOrigin: string, chosen: string): string | null {
    const here = parseSiteAddress(locationOrigin);
    const main = parseSiteAddress(chosen);
    if (!here || !main || here.kind !== "dns" || isLoopbackHostname(here.hostname)) return null;
    return here.hostname === main.hostname ? null : here.origin;
}

/** A same-origin path (`/x`, never `//host` or `/\host`), or the fallback. */
function localPath(value: unknown, fallback: string): string {
    return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : fallback;
}

/**
 * Where the wizard goes after a successful install. Normally the path the backend returns, on this
 * address. But when it could not sign the admin in HERE (`autoLoginSkipped`: this address is about to
 * be refused, or may not mint a session), the path is opened on the main address the site was just
 * installed with — the backend's own `siteUrl`, parsed, never anything the page derived itself.
 */
export function installLanding(
    res: { redirectTo?: unknown; siteUrl?: unknown; autoLoginSkipped?: unknown } | null | undefined,
    locationOrigin: string,
): { href: string; external: boolean } {
    const path = localPath(res?.redirectTo, "/login?installed=true");
    const main = res?.autoLoginSkipped ? parseSiteAddress(res.siteUrl) : null;
    const here = parseSiteAddress(locationOrigin);
    if (main && (!here || here.origin !== main.origin)) return { href: `${main.origin}${path}`, external: true };
    return { href: path, external: false };
}

// ─── Who may see it ─────────────────────────────────────────────────────────────────────────────────

export const SITE_ADDRESS_SETTINGS_PATH = "/admin/settings/site-address";

/**
 * Whether the client asks for the site-address state at all. The backend answers it to administrators
 * only (REDTEAM R8: it lists the server's own IPs, which would let anyone route around a CDN or WAF),
 * the same role check as its `isAdmin`; asking with any other role would just collect a 403.
 */
export function canManageSiteAddress(user: { role?: unknown } | null | undefined): boolean {
    return user?.role === "administrator";
}

/** Where the retired /migration page sends a visitor: administrators to the settings screen, others home. */
export function migrationRedirectTarget(user: { role?: unknown } | null): string {
    return canManageSiteAddress(user) ? SITE_ADDRESS_SETTINGS_PATH : "/";
}

// ─── After an SSL or port change (Security → Gateway configuration) ─────────────────────────────────

export type GatewayAddressOutcome =
    | { kind: "upgraded"; address: string; warnings: string[] }
    | { kind: "suggest"; address: string; href: string };

/**
 * What POST /system/certs/config said about the main address (SPEC §6, REDTEAM R1):
 *   · `canonicalUpgraded` — the same host moved http → https and the main address followed at once;
 *   · `suggestCanonical` — the gateway now serves ANOTHER address, which only an administrator may adopt,
 *     so the security page sends them to the site-address screen with it as `?suggest=`.
 * Both are parsed: a value that is not a site address is neither shown nor linked.
 */
export function gatewayAddressOutcome(res: unknown): GatewayAddressOutcome | null {
    const r = asRecord(res);
    if (!r) return null;
    const upgraded = parseSiteAddress(r.canonicalUpgraded);
    if (upgraded) {
        const warnings = asList(r.siteAddressWarnings).map(asString).filter((w): w is string => w !== null);
        return { kind: "upgraded", address: upgraded.origin, warnings };
    }
    const suggested = parseSiteAddress(r.suggestCanonical);
    if (suggested) {
        return { kind: "suggest", address: suggested.origin, href: `${SITE_ADDRESS_SETTINGS_PATH}?suggest=${encodeURIComponent(suggested.origin)}` };
    }
    return null;
}

/**
 * Tell the admin what the gateway change did to the main address, after the save. The security page
 * passes its modal and router; the messages are English like the rest of that page. On a suggestion
 * the admin is taken to the site-address screen, which opens the change dialog prefilled.
 */
export async function afterGatewayConfigSave(
    res: unknown,
    io: { alert: (message: string) => unknown; navigate: (href: string) => void },
): Promise<GatewayAddressOutcome | null> {
    const restart = "You may need to restart the gateway.";
    const outcome = gatewayAddressOutcome(res);
    if (outcome?.kind === "upgraded") {
        const notes = outcome.warnings.length ? ` Note: ${outcome.warnings.join(" ")}` : "";
        await io.alert(`Settings saved. The main address is now ${outcome.address}: emails, feeds and the sitemap link to it from now on.${notes} ${restart}`);
    } else if (outcome?.kind === "suggest") {
        await io.alert(`Settings saved. The gateway now serves the site at ${outcome.address}, which is not the main address. Review it in Settings → Site address. ${restart}`);
        io.navigate(outcome.href);
    } else {
        await io.alert(`Settings saved. ${restart}`);
    }
    return outcome;
}

/**
 * The address the site-address screen opens the change dialog with, from its `?suggest=` parameter.
 * The parameter is a HINT, never a source: anyone can send an administrator a link carrying one, and a
 * dialog prefilled with someone else's domain is one password away from re-pointing every emailed link.
 * So it is honoured only when the backend itself reports that very address as the gateway's
 * (`gatewayDrift`, recorded by the SSL or port change that produced the suggestion), and only while it
 * is not already the main address.
 */
export function suggestedCanonical(
    param: string | null | undefined,
    state: Pick<SiteAddressState, "canonical" | "gatewayDrift">,
): string | null {
    const site = parseSiteAddress(param);
    const gateway = state.gatewayDrift ? parseSiteAddress(state.gatewayDrift.gateway) : null;
    if (!site || !gateway || gateway.origin !== site.origin) return null;
    return state.canonical?.origin === site.origin ? null : site.origin;
}

/**
 * Types for core/host-policy.js — the plain-JS host parser, classifier and gate shared byte for byte
 * with gateway/src/host-policy.js. See the module header there for why it is JavaScript.
 */
import type { IncomingMessage, ServerResponse } from 'http';

export type HostKind = 'dns' | 'ipv4' | 'ipv6';

/** A parsed Host value: lower-case hostname (IPv6 bracketed and compressed), optional port. */
export interface ParsedHost {
    hostname: string;
    port: number | null;
    kind: HostKind;
}

/** A parsed operator-supplied site address: `http(s)://host[:port]`, default port dropped. */
export interface SiteUrl extends ParsedHost {
    origin: string;
    scheme: 'http' | 'https';
}

/** Why a declared address does not mint sessions by default (REDTEAM R2). */
export type AddressRisk = 'ip' | 'tunnel' | 'local' | null;

export interface AliasEntry extends SiteUrl {
    mode: 'serve' | 'redirect';
    /** Effective sign-in intent: the explicit flag, or the default from risk and scheme. */
    signIn: boolean;
    signInExplicit: boolean;
    risk: AddressRisk;
    /** Epoch ms; the matcher ignores the alias from this instant on. */
    expiresAt: number | null;
    label: string | null;
    source: string;
}

/** A WORDJS_ALLOWED_HOSTS entry. `scheme`/`origin` are set only for URL entries (REDTEAM R12). */
export interface EnvHostEntry extends ParsedHost {
    scheme: 'http' | 'https' | null;
    origin: string | null;
    signIn: boolean;
    risk: AddressRisk;
    source: 'env';
}

export type IpLiteralMode = 'any' | 'own' | 'none';

export interface HostPolicy {
    canonical: SiteUrl | null;
    canonicalError: 'missing' | 'invalid' | null;
    /** Keyed by hostname. */
    aliases: Map<string, AliasEntry>;
    /** Keyed by hostname. */
    envHosts: Map<string, EnvHostEntry>;
    ipLiterals: IpLiteralMode;
    ipLiteralsSource: 'default' | 'config' | 'env';
    /** hostPolicy.ipSignIn: opt-in for sessions minted on the `ip` class in production. */
    ipSignIn: boolean;
    dev: boolean;
    devOrigins: Set<string>;
    /** The operator's explicit trustProxy / WORDJS_TRUST_PROXY, or null. */
    trustProxy: unknown;
    ownAddresses: () => Set<string>;
    warnings: readonly string[];
}

export type HostClass = 'canonical' | 'alias' | 'env' | 'loopback' | 'ip' | 'dev' | 'unknown';

export type ClassifyReason =
    | 'canonical' | 'alias' | 'env' | 'loopback' | 'localhost-subdomain' | 'ip-any' | 'ip-own' | 'dev-origin'
    | 'invalid' | 'proxied-ip' | 'ip-not-own' | 'ip-literals-none' | 'expired-alias' | 'undeclared';

export interface Classification {
    cls: HostClass;
    reason: ClassifyReason;
    entry: SiteUrl | AliasEntry | EnvHostEntry | null;
}

export interface ClassifyContext {
    /** REDTEAM R4: the authority came from Host on a request with proxy headers from an untrusted peer. */
    proxied?: boolean;
    /** Epoch ms for alias expiry; defaults to Date.now(). */
    now?: number;
}

export type TrustedHop = 'gateway' | 'local' | 'operator' | null;

export interface RequestAuthority {
    /** null when absent, or present but malformed (absent === false then: answer 400). */
    parsed: ParsedHost | null;
    absent: boolean;
    /** The value judged, as received ('' when absent): what a relaying listener forwards as X-Forwarded-Host. */
    raw: string;
    hop: TrustedHop;
    viaTrustedHop: boolean;
    /**
     * Which header named the host. A trusted hop does not imply 'x-forwarded-host': an 'operator' hop's
     * X-Forwarded-Host is read only when its own Host is an IP literal, a loopback authority or a
     * single-label name (a DNS-rebinding page can be such a peer, but always sends its dotted name).
     */
    source: 'host' | 'x-forwarded-host';
    proxied: boolean;
}

/** Anything carrying the operator's explicit trust setting: a HostPolicy or `{ trustProxy }`. */
export interface TrustOptions {
    trustProxy?: unknown;
}

/** What the gate attaches to an accepted request. Informational only: no authorisation may read it. */
export interface SiteHost {
    hostname: string;
    port: number | null;
    kind: HostKind;
    /** `hostname[:port]` */
    host: string;
    cls: Exclude<HostClass, 'unknown'>;
    reason: ClassifyReason;
    entry: SiteUrl | AliasEntry | EnvHostEntry | null;
    hop: TrustedHop;
    viaTrustedHop: boolean;
    /** trustedScheme() for this request. */
    scheme: 'http' | 'https';
}

export type RefusalHint = 'forward-host' | 'tunnel' | 'www-apex' | 'local';
/** Who refused a host: a public listener's edge check, the backend's gate, or each of them. */
export type RefusalSource = 'edge' | 'gate' | 'both';

export interface RefusedHostEntry {
    host: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
    hint: RefusalHint | null;
    /** null only when no recorder named a source; the backend tags the gateway's whole list 'edge' itself (site-address noteEdgeRefusals). */
    source: RefusalSource | null;
}

export interface RefusedHosts {
    /** Count a refusal; true when the caller should log it (per-host and global rate caps). */
    record(hostname: string, hint: RefusalHint | null, source?: 'edge' | 'gate'): boolean;
    /** Most recent first. */
    list(): RefusedHostEntry[];
    clear(): void;
}

export interface LastSeenEntry {
    hostname: string;
    seenAt: number;
    /** Last request with a valid session; the only use the remove-address interlock may count. */
    authenticatedAt: number | null;
}

export interface LastSeen {
    touch(hostname: string, options?: { authenticated?: boolean }): void;
    get(hostname: string): LastSeenEntry | null;
    list(): LastSeenEntry[];
    clear(): void;
}

export interface PolicyProvider {
    get(): HostPolicy;
    invalidate(): void;
}

export interface Logger {
    warn(message: string): void;
    error(message: string): void;
}

export type GateNotice = 'missing-canonical' | 'proxy-collapse';

export interface HostGateOptions {
    getPolicy(): HostPolicy;
    isInstalled(): boolean;
    logger?: Logger;
    onNotice?: (kind: GateNotice, detail: Record<string, unknown>) => void;
    refused?: RefusedHosts;
    lastSeen?: LastSeen;
    exemptPaths?: readonly string[];
    now?: () => number;
}

export type GateRequest = IncomingMessage & { path?: string; siteHost?: SiteHost };
export type HostGate = (req: GateRequest, res: ServerResponse, next: (err?: unknown) => void) => void;

export interface NetworkInterfaceLike {
    address: string;
    family: string | number;
    internal: boolean;
}
export type InterfaceMap = Record<string, NetworkInterfaceLike[] | null | undefined>;

export function parseHost(raw: unknown): ParsedHost | null;
export function serialize(p: { hostname: string; port: number | null }): string;
export function parseSiteUrl(input: unknown): SiteUrl | null;
export function isLoopbackAuthority(p: { hostname: string; kind: HostKind } | null | undefined): boolean;
export function isLoopbackIp(addr: unknown): boolean;

/** This machine's non-internal, non-link-local IPv4 and IPv6 addresses (cached 5 s). */
export function ownAddresses(): Set<string>;
export function createOwnAddresses(opts?: { networkInterfaces?: () => InterfaceMap; ttlMs?: number; now?: () => number }): () => Set<string>;
export function addressesFromInterfaces(interfaces: InterfaceMap | null | undefined): Set<string>;

/** REDTEAM R11: a peer test for address-based settings only; null for hop counts, booleans, invalid input. */
export function compileTrustProxy(setting: unknown): ((peer: string) => boolean) | null;
export function trustedHop(req: IncomingMessage, opts?: TrustOptions | null): TrustedHop;
export function hasProxyMarkers(req: IncomingMessage): boolean;
export function requestAuthority(req: IncomingMessage, opts?: TrustOptions | null): RequestAuthority;
/** `serialize(requestAuthority(req).parsed)`, or undefined when absent or malformed. */
export function requestHost(req: IncomingMessage, opts?: TrustOptions | null): string | undefined;
export function trustedScheme(req: IncomingMessage, opts?: TrustOptions | null): 'http' | 'https';

export function classify(p: ParsedHost | null, pol: HostPolicy | null, ctx?: ClassifyContext): Classification;
export function refusalHint(p: ParsedHost | null, pol: HostPolicy | null, reason?: ClassifyReason): RefusalHint | null;
export const REFUSAL_HINTS: Readonly<Record<RefusalHint, string>>;
export const TUNNEL_SUFFIXES: readonly string[];
export function isTunnelHost(hostname: string): boolean;
export function isLanName(hostname: string): boolean;

export function buildPolicy(input?: {
    config?: Record<string, any> | null;
    env?: Record<string, string | undefined>;
    nodeEnv?: string;
    ownAddresses?: () => Set<string>;
}): HostPolicy;
export function createPolicyProvider(opts: {
    getConfig: () => Record<string, any> | null;
    env?: Record<string, string | undefined>;
    nodeEnv?: string | (() => string);
    ownAddresses?: () => Set<string>;
    logger?: Pick<Logger, 'warn'>;
}): PolicyProvider;

export const REFUSAL_SOURCES: readonly RefusalSource[];
export function createRefusedHosts(opts?: { max?: number; logsPerMinute?: number; now?: () => number }): RefusedHosts;
/** Several refusal lists as one (per host: counts added, sources combined, latest lastSeen first); invalid entries are dropped. */
export function mergeRefusedHosts(lists: unknown, opts?: { max?: number }): RefusedHostEntry[];
export function createLastSeen(opts?: { max?: number; now?: () => number }): LastSeen;
/** Shared trackers the default gate writes and GET /site-address reads. */
export const refusedHosts: RefusedHosts;
export const lastSeen: LastSeen;
export function noteAuthenticatedUse(req: { siteHost?: SiteHost } | null | undefined, tracker?: LastSeen): void;

export const EXEMPT_PATHS: readonly string[];
/** A dot segment (literal or percent-encoded, also before ';') or a raw backslash: what a URL parser resolves into another path. */
export function hasDotSegments(path: string): boolean;
/** A dot segment (literal or percent-encoded), an encoded slash, backslash or '%', or a raw backslash: never exempt. */
export function isAmbiguousPath(path: string): boolean;
export function hostGateFactory(opts: HostGateOptions): HostGate;
export function sendHostNotAllowed(res: ServerResponse): void;
export function sendInvalidHost(res: ServerResponse): void;

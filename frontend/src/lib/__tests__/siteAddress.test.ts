/**
 * The client half of the site address (lib/siteAddress.ts), pinned two ways:
 *
 *   1. AGAINST THE BACKEND'S OWN MODULE where both sides make the same decision — the address grammar
 *      (through the shared conformance vectors), the tunnel list, and the per-address sign-in default
 *      (REDTEAM R2). A screen that disagrees with the backend either refuses what would be accepted or,
 *      worse, shows "sign-in off" for an address that mints sessions.
 *   2. Against the rules the screen alone owns: what is written back (explicit choices survive a save),
 *      how refusals are read, which suggestion the install wizard may offer (R6), what the notice links to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as hostPolicy from "../../../../backend/src/core/host-policy.js";
import {
    ADMIN_LANGUAGE_STORAGE_KEY,
    TUNNEL_DEFAULT_TTL_MS,
    TUNNEL_SUFFIXES,
    addressRisk,
    afterGatewayConfigSave,
    aliasesForWrite,
    buildAlias,
    canManageSiteAddress,
    canonicalChangeNotes,
    canonicalChoice,
    canonicalLink,
    classifyWriteError,
    currentAddressAsAlias,
    dashboardBanners,
    dateInputToExpiry,
    defaultExpiryFor,
    expiryToDateInput,
    fillTemplate,
    gatewayAddressOutcome,
    installLanding,
    installSuggestion,
    isCurrentAddress,
    isLanName,
    isLoopbackHostname,
    isTunnelHost,
    migrationRedirectTarget,
    needsLocalConfirmation,
    noticeLanguage,
    normalizeSiteAddressState,
    oldAddressApplies,
    parseSiteAddress,
    policyWrite,
    sameHostname,
    signInPolicy,
    siteAddressApi,
    storedAdminLanguage,
    suggestedCanonical,
    upsertAlias,
    withoutAlias,
    type AliasView,
    type SiteAddress,
    type SiteAddressState,
} from "../siteAddress";
import { setStoredLanguage } from "../i18n";

const VECTORS = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../../../../contracts/host-policy-vectors.v1.json"), "utf8"),
) as { parseSiteUrl: { accept: Array<Record<string, unknown>>; reject: Array<{ in: string; why: string }> } };

const site = (url: string): SiteAddress => {
    const s = parseSiteAddress(url);
    if (!s) throw new Error(`not a site address: ${url}`);
    return s;
};

const alias = (url: string, extra: Partial<AliasView> = {}): AliasView => ({
    ...site(url),
    mode: "serve",
    label: null,
    signIn: null,
    source: "admin",
    expiresAt: null,
    lastSeenAt: null,
    lastSignedInAt: null,
    ...extra,
});

const emptyState = (extra: Partial<SiteAddressState> = {}): SiteAddressState => ({ ...normalizeSiteAddressState({}), ...extra });

// ─── 1 · the same answers as the backend ────────────────────────────────────────────────────────────

describe("parseSiteAddress agrees with the backend's parseSiteUrl on every shared vector", () => {
    for (const v of VECTORS.parseSiteUrl.accept) {
        it(`accepts ${JSON.stringify(v.in)}`, () => {
            expect(parseSiteAddress(v.in)).toEqual({ origin: v.origin, scheme: v.scheme, hostname: v.hostname, port: v.port, kind: v.kind });
        });
    }
    for (const v of VECTORS.parseSiteUrl.reject) {
        it(`refuses ${JSON.stringify(v.in)} (${v.why})`, () => {
            expect(parseSiteAddress(v.in)).toBeNull();
            expect(hostPolicy.parseSiteUrl(v.in)).toBeNull();
        });
    }

    it("refuses anything that is not a string", () => {
        for (const v of [null, undefined, 42, {}, ["https://example.com"]]) expect(parseSiteAddress(v)).toBeNull();
    });

    it("refuses label characters WHATWG lets through but the backend grammar does not", () => {
        for (const url of ["https://exa!mple.com", "https://a..b.example", "https://-x.example", "https://x.123"]) {
            expect(parseSiteAddress(url), url).toBeNull();
            expect(hostPolicy.parseSiteUrl(url), url).toBeNull();
        }
    });
});

describe("tunnel names", () => {
    it("are the same list the backend uses", () => {
        expect([...TUNNEL_SUFFIXES]).toEqual([...hostPolicy.TUNNEL_SUFFIXES]);
    });

    it("match a suffix or the bare suffix, never a look-alike", () => {
        expect(isTunnelHost("ab12.ngrok-free.app")).toBe(true);
        expect(isTunnelHost("loca.lt")).toBe(true);
        expect(isTunnelHost("notngrok-free.app")).toBe(false);
        expect(isTunnelHost("ngrok-free.app.example.com")).toBe(false);
    });

    it("default to a one-week expiry; other names to none", () => {
        const now = Date.UTC(2026, 9, 6, 12, 0, 0);
        expect(defaultExpiryFor("ab12.ngrok-free.app", now)).toBe(new Date(now + TUNNEL_DEFAULT_TTL_MS).toISOString());
        expect(TUNNEL_DEFAULT_TTL_MS).toBe(7 * 24 * 3600 * 1000);
        expect(defaultExpiryFor("www.example.com", now)).toBeNull();
    });
});

describe("the per-address sign-in default is the backend's (REDTEAM R2/R9)", () => {
    const URLS = [
        "https://www.example.com",
        "http://intranet.example.com",
        "https://ab12.ngrok-free.app",
        "http://ab12.ngrok-free.app",
        "https://printer.local",
        "http://192.168.1.50:3000",
        "https://[2001:db8::5]",
    ];
    for (const canonicalUrl of ["https://example.com", "http://example.com"]) {
        for (const explicit of [undefined, true, false] as const) {
            it(`canonical ${canonicalUrl}, signIn ${String(explicit)}`, () => {
                const config = {
                    siteUrl: canonicalUrl,
                    siteAliases: URLS.map((url) => (explicit === undefined ? { url } : { url, signIn: explicit })),
                };
                const policy = hostPolicy.buildPolicy({ config, env: {}, nodeEnv: "production" });
                const canonical = site(canonicalUrl);
                for (const url of URLS) {
                    const a = alias(url, { signIn: explicit ?? null });
                    const backend = policy.aliases.get(a.hostname);
                    expect(backend, url).toBeTruthy();
                    expect(signInPolicy(a, canonical).effective, url).toBe(backend!.signIn);
                }
            });
        }
    }

    it("offers the switch only where the default is 'no', and says why", () => {
        const https = site("https://example.com");
        expect(signInPolicy(alias("https://www.example.com"), https)).toEqual({ relevant: false, defaultValue: true, effective: true, warning: null });
        expect(signInPolicy(alias("http://intranet.example.com"), https).warning).toBe("plain-http");
        expect(signInPolicy(alias("http://intranet.example.com"), site("http://example.com")).relevant).toBe(false);
        expect(signInPolicy(alias("https://x.trycloudflare.com"), https).warning).toBe("tunnel");
        expect(signInPolicy(alias("https://printer.local"), https).warning).toBe("local");
        expect(signInPolicy(alias("http://10.0.0.5"), site("http://example.com")).warning).toBe("ip");
    });

    it("classifies the risk the way the backend does", () => {
        expect(addressRisk(site("https://[::1]"))).toBe("ip");
        expect(addressRisk(site("https://x.loca.lt"))).toBe("tunnel");
        expect(addressRisk(site("https://nas.local"))).toBe("local");
        expect(addressRisk(site("https://www.example.com"))).toBeNull();
        expect(isLanName("local")).toBe(true);
        expect(isLanName("localhost")).toBe(false);
    });
});

// ─── 2 · the screen's own rules ─────────────────────────────────────────────────────────────────────

describe("normalizeSiteAddressState reads the shapes the backend naturally has", () => {
    it("takes the policy's own entries (effective signIn + signInExplicit, epoch-ms expiry, lastSeen object)", () => {
        const s = normalizeSiteAddressState({
            rev: 4,
            canonical: { origin: "https://example.com", scheme: "https", hostname: "example.com", port: null, kind: "dns" },
            aliases: [
                { url: "http://192.168.1.50:3000", signIn: false, signInExplicit: false, expiresAt: null, mode: "serve", source: "cli",
                    lastSeen: { seenAt: 1_700_000_000_000, authenticatedAt: 1_700_000_100_000 } },
                { origin: "https://ab12.ngrok-free.app", signIn: true, signInExplicit: true, expiresAt: Date.UTC(2026, 9, 12), mode: "redirect", label: "demo" },
            ],
            envHosts: [{ hostname: "ingress.example.net", port: null, origin: null }, { hostname: "tls.example.net", port: null, origin: "https://tls.example.net" }, "192.168.9.9"],
            ipLiterals: "own",
            ipLiteralsSource: "env",
            ipSignIn: true,
            ownAddresses: ["192.168.1.11", "[2001:db8::11]"],
            devOrigins: ["devbox"],
            dev: true,
            connectedVia: { host: "192.168.1.11:3000", cls: "ip" },
            recentlyRefused: [{ host: "attacker.example", count: 3, lastSeen: 1_700_000_200_000, hint: null }, { host: "w_x", count: 1, lastSeen: 5, hint: "forward-host" }],
            notices: ["proxy-collapse", "bogus"],
        });
        expect(s.rev).toBe(4);
        expect(s.canonical?.origin).toBe("https://example.com");
        expect(s.aliases[0]).toMatchObject({ origin: "http://192.168.1.50:3000", signIn: null, source: "cli", lastSeenAt: 1_700_000_000_000, lastSignedInAt: 1_700_000_100_000 });
        expect(s.aliases[1]).toMatchObject({ origin: "https://ab12.ngrok-free.app", signIn: true, mode: "redirect", label: "demo", expiresAt: "2026-10-12T00:00:00.000Z", source: "config" });
        expect(s.envHosts).toEqual(["ingress.example.net", "https://tls.example.net", "192.168.9.9"]);
        expect(s).toMatchObject({ ipLiterals: "own", ipLiteralsSource: "env", ipSignIn: true, dev: true, devOrigins: ["devbox"] });
        expect(s.connectedVia).toEqual({ host: "192.168.1.11:3000", cls: "ip" });
        expect(s.recentlyRefused).toEqual([
            { host: "attacker.example", count: 3, lastSeen: 1_700_000_200_000, hint: null },
            { host: "w_x", count: 1, lastSeen: 5, hint: "forward-host" },
        ]);
        expect(s.notices).toEqual(["proxy-collapse"]);
    });

    it("takes the config's own entries (only what the operator wrote, ISO expiry)", () => {
        const s = normalizeSiteAddressState({
            canonical: "https://example.com",
            aliases: [{ url: "https://www.example.com", signIn: false, expiresAt: "2026-10-12T00:00:00Z", source: "admin" }, "https://plain.example"],
        });
        expect(s.aliases.map((a) => [a.origin, a.signIn, a.expiresAt])).toEqual([
            ["https://www.example.com", false, "2026-10-12T00:00:00.000Z"],
            ["https://plain.example", null, null],
        ]);
    });

    it("drops what cannot be an address instead of rendering it", () => {
        const s = normalizeSiteAddressState({
            canonical: "javascript:alert(1)",
            aliases: [{ url: "https://a@b.example" }, { url: "https,https://x" }, null, 7],
            recentlyRefused: [{ host: "<img src=x>", count: 1 }, { host: "" }, "x"],
            ipLiterals: "everything",
            rev: -1,
        });
        expect(s.canonical).toBeNull();
        expect(s.aliases).toEqual([]);
        expect(s.recentlyRefused).toEqual([]);
        expect(s.ipLiterals).toBe("any");
        expect(s.rev).toBe(0);
    });

    it("reads the conflict and the gateway drift", () => {
        const s = normalizeSiteAddressState({
            conflict: { config: "https://example.com", db: "https://old.example.com" },
            gatewayDrift: { gatewayUrl: "https://example.com:8443", configUrl: "http://example.com:3000" },
        });
        expect(s.conflict).toEqual({ config: "https://example.com", db: "https://old.example.com" });
        expect(s.gatewayDrift).toEqual({ gateway: "https://example.com:8443", config: "http://example.com:3000" });
        expect(normalizeSiteAddressState({ conflict: { config: "x" } }).conflict).toBeNull();
    });
});

describe("what a save writes back", () => {
    it("keeps every explicit choice — an explicit signIn:false is NOT dropped by an unrelated save", () => {
        const list = [
            alias("https://www.example.com", { signIn: false, label: "www" }),
            alias("http://192.168.1.50:3000", { signIn: true }),
            alias("https://ab12.ngrok-free.app", { expiresAt: "2026-10-12T00:00:00.000Z", mode: "redirect" }),
            alias("https://plain.example"),
        ];
        expect(aliasesForWrite(list)).toEqual([
            { url: "https://www.example.com", mode: "serve", label: "www", signIn: false },
            { url: "http://192.168.1.50:3000", mode: "serve", signIn: true },
            { url: "https://ab12.ngrok-free.app", mode: "redirect", expiresAt: "2026-10-12T00:00:00.000Z" },
            { url: "https://plain.example", mode: "serve" },
        ]);
    });

    it("replaces the edited entry in place, even when its address was corrected", () => {
        const list = [alias("https://a.example"), alias("https://b.example"), alias("https://c.example")];
        expect(upsertAlias(list, alias("https://b2.example"), "b.example").map((a) => a.hostname)).toEqual(["a.example", "b2.example", "c.example"]);
        expect(upsertAlias(list, alias("https://b.example", { label: "B" })).map((a) => a.label)).toEqual([null, "B", null]);
        expect(upsertAlias(list, alias("https://d.example")).map((a) => a.hostname)).toEqual(["a.example", "b.example", "c.example", "d.example"]);
        expect(withoutAlias(list, "b.example").map((a) => a.hostname)).toEqual(["a.example", "c.example"]);
    });

    it("asks for the .local confirmation whenever a .local name is in the list", () => {
        expect(needsLocalConfirmation([alias("https://www.example.com")])).toBe(false);
        expect(needsLocalConfirmation([alias("https://www.example.com"), alias("https://nas.local")])).toBe(true);
    });
});

describe("buildAlias — the add/edit dialog", () => {
    const now = Date.UTC(2026, 9, 6);
    const canonical = site("https://example.com");
    const ctx = (extra: Partial<Parameters<typeof buildAlias>[1]> = {}) => ({ canonical, existing: [alias("https://www.example.com")], previous: null, now, ...extra });
    const input = (extra: Partial<Parameters<typeof buildAlias>[0]> = {}) => ({ url: "https://blog.example.com", label: "", mode: "serve" as const, signIn: null, expiresAt: null, ...extra });

    it("refuses what the backend would refuse, before the password is asked for", () => {
        expect(buildAlias(input({ url: "https://*.example.com" }), ctx())).toEqual({ error: "invalid" });
        expect(buildAlias(input({ url: "https://example.com:8443" }), ctx())).toEqual({ error: "is-canonical" });
        expect(buildAlias(input({ url: "http://www.example.com" }), ctx())).toEqual({ error: "duplicate" });
        expect(buildAlias(input({ expiresAt: "2026-10-05T00:00:00Z" }), ctx())).toEqual({ error: "expiry-past" });
        expect(buildAlias(input({ expiresAt: "2026-13-45T23:59:59" }), ctx())).toEqual({ error: "expiry-invalid" });
    });

    it("builds the entry, normalised", () => {
        const built = buildAlias(input({ url: " HTTPS://Blog.Example.com/ ", label: "  blog  ", expiresAt: "2026-10-12T00:00:00Z" }), ctx());
        expect(built).toEqual({ alias: alias("https://blog.example.com", { label: "blog", expiresAt: "2026-10-12T00:00:00.000Z" }) });
    });

    it("editing keeps its own name, its bookkeeping and an expiry it already had", () => {
        const previous = alias("https://old.ngrok-free.app", { source: "cli", expiresAt: "2026-10-01T00:00:00.000Z", lastSeenAt: 9, lastSignedInAt: 8 });
        const built = buildAlias(input({ url: previous.origin, label: "renamed", expiresAt: previous.expiresAt }), ctx({ existing: [previous], previous }));
        expect(built).toEqual({ alias: { ...previous, label: "renamed" } });
    });

    it("writes the sign-in switch only where it is offered, and keeps an explicit choice elsewhere", () => {
        const http = buildAlias(input({ url: "http://lan.example.com", signIn: true }), ctx());
        expect("alias" in http && http.alias.signIn).toBe(true);
        const https = buildAlias(input({ url: "https://blog.example.com", signIn: true }), ctx());
        expect("alias" in https && https.alias.signIn).toBeNull();
        const previous = alias("https://www.example.com", { signIn: false });
        const kept = buildAlias(input({ url: previous.origin, label: "x" }), ctx({ existing: [previous], previous }));
        expect("alias" in kept && kept.alias.signIn).toBe(false);
    });

    it("date input round trip: the end of the chosen local day", () => {
        expect(dateInputToExpiry("")).toBeNull();
        const iso = new Date(dateInputToExpiry("2026-10-12") as string).toISOString();
        expect(expiryToDateInput(iso)).toBe("2026-10-12");
        expect(new Date(iso).getHours()).toBe(23);
        expect(expiryToDateInput(null)).toBe("");
        expect(expiryToDateInput("garbage")).toBe("");
    });
});

describe("changing the main address", () => {
    const current = site("https://example.com");

    it("refuses only an exact repeat of the current origin", () => {
        expect(canonicalChoice("https://example.com/", current)).toEqual({ error: "is-canonical" });
        expect(canonicalChoice("nope", current)).toEqual({ error: "invalid" });
        expect(canonicalChoice("https://example.com:8443", current)).toEqual({ site: site("https://example.com:8443") });
        expect(canonicalChoice("https://new.example", null)).toEqual({ site: site("https://new.example") });
    });

    it("asks what happens to the old address only when the NAME changes", () => {
        expect(oldAddressApplies(site("https://new.example"), current)).toBe(true);
        expect(oldAddressApplies(site("http://example.com:3000"), current)).toBe(false);
        expect(oldAddressApplies(site("https://new.example"), null)).toBe(false);
    });

    it("lists the consequences, with the downgrade and the self-lockout called out", () => {
        expect(canonicalChangeNotes({ next: site("https://new.example"), current, oldAddress: "keep", usingCurrent: true })).toEqual(["links", "mail", "tls", "seo"]);
        expect(canonicalChangeNotes({ next: site("http://new.example"), current, oldAddress: "drop", usingCurrent: true })).toEqual(["links", "mail", "seo", "downgrade", "dropCurrent"]);
        expect(canonicalChangeNotes({ next: site("https://new.example"), current, oldAddress: "drop", usingCurrent: false })).not.toContain("dropCurrent");
    });

    it("knows which address the admin is on", () => {
        const state = emptyState({ connectedVia: { host: "www.example.com:443", cls: "alias" } });
        expect(isCurrentAddress("www.example.com", state, "10.0.0.5")).toBe(true);
        expect(isCurrentAddress("10.0.0.5", state, "10.0.0.5")).toBe(true);
        expect(isCurrentAddress("blog.example.com", state, "10.0.0.5")).toBe(false);
        expect(sameHostname("Example.COM.", "example.com")).toBe(true);
        expect(sameHostname(null, "example.com")).toBe(false);
    });
});

describe("classifyWriteError — what a refused write means", () => {
    const err = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error("boom"), { status, ...extra });

    it("reads the sudo refusal as a password problem", () => {
        expect(classifyWriteError(err(403, { code: "rest_bad_current_password" }))).toEqual({ kind: "bad-password" });
    });

    it("reads a 409 that names dependents as the interlock, from `data` or `details`", () => {
        const dependents = [{ kind: "gatewayUrl", host: "old.example", detail: "https://old.example" }];
        expect(classifyWriteError(err(409, { data: { status: 409, dependents } }))).toEqual({ kind: "in-use", dependents });
        expect(classifyWriteError(err(409, { details: { dependents: ["recent sign-in"] } }))).toEqual({
            kind: "in-use",
            dependents: [{ kind: "other", host: null, detail: "recent sign-in" }],
        });
    });

    it("reads any other 409 as a stale rev (someone changed it meanwhile)", () => {
        expect(classifyWriteError(err(409, { code: "rest_site_address_stale" }))).toEqual({ kind: "stale" });
        expect(classifyWriteError(err(409, { data: { dependents: [] } }))).toEqual({ kind: "stale" });
    });

    it("passes the backend's words through for a refused value and anything else", () => {
        expect(classifyWriteError(err(400))).toEqual({ kind: "rejected", message: "boom" });
        expect(classifyWriteError(err(500))).toEqual({ kind: "failed", message: "boom" });
        expect(classifyWriteError(null)).toEqual({ kind: "failed", message: "Request failed" });
    });
});

describe("siteAddressApi — the wire", () => {
    type Call = { url: string; method: string; body?: string };
    let calls: Call[];
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        calls = [];
        globalThis.fetch = (async (input: unknown, init: { method?: string; body?: string } = {}) => {
            calls.push({ url: String(input), method: init.method || "GET", body: init.body });
            const raw = JSON.stringify({ rev: 5, canonical: "https://example.com", aliases: ["https://www.example.com"] });
            return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => JSON.parse(raw), text: async () => raw };
        }) as unknown as typeof fetch;
    });
    afterEach(() => { globalThis.fetch = realFetch; });

    const pathOf = (url: string) => url.slice(url.indexOf("/api/v1") + "/api/v1".length);

    it("GET reads and normalises the state", async () => {
        const state = await siteAddressApi.get();
        expect(`${calls[0].method} ${pathOf(calls[0].url)}`).toBe("GET /site-address");
        expect(state.rev).toBe(5);
        expect(state.aliases.map((a) => a.origin)).toEqual(["https://www.example.com"]);
    });

    it("every write carries the password and the rev, on its own path", async () => {
        await siteAddressApi.putCanonical({ url: "https://new.example", oldAddress: "keep", currentPassword: "pw", rev: 5 });
        await siteAddressApi.putAliases({ aliases: [{ url: "https://www.example.com", mode: "serve" }], currentPassword: "pw", rev: 5, force: true, confirmLocal: true });
        await siteAddressApi.putPolicy({ ipLiterals: "own", currentPassword: "pw", rev: 5 });
        expect(calls.map((c) => `${c.method} ${pathOf(c.url)}`)).toEqual(["PUT /site-address/canonical", "PUT /site-address/aliases", "PUT /site-address/policy"]);
        expect(calls.map((c) => JSON.parse(c.body as string))).toEqual([
            { url: "https://new.example", oldAddress: "keep", currentPassword: "pw", rev: 5 },
            { aliases: [{ url: "https://www.example.com", mode: "serve" }], currentPassword: "pw", rev: 5, force: true, confirmLocal: true },
            { ipLiterals: "own", currentPassword: "pw", rev: 5 },
        ]);
    });

    it("refuses a blank password BEFORE the network (a failed proof counts against the account)", () => {
        expect(() => siteAddressApi.putCanonical({ url: "https://x.example", oldAddress: "keep", currentPassword: "", rev: 1 })).toThrow(/current password/i);
        expect(() => siteAddressApi.putAliases({ aliases: [], currentPassword: "", rev: 1 })).toThrow(/current password/i);
        expect(() => siteAddressApi.putPolicy({ ipLiterals: "any", currentPassword: "", rev: 1 })).toThrow(/current password/i);
        expect(calls).toHaveLength(0);
    });
});

describe("the refused-address notice", () => {
    it("links to the configured main address plus the current path", () => {
        expect(canonicalLink("https://example.com/", { origin: "http://192.168.1.9:3000", pathname: "/admin/posts" }))
            .toEqual({ href: "https://example.com/admin/posts", origin: "https://example.com" });
    });

    it("offers no link when there is no usable main address, or when it is this very origin", () => {
        for (const bad of [null, "", "javascript:alert(1)", "https,https://example.com", "https://example.com/blog", "//evil.example"]) {
            expect(canonicalLink(bad, { origin: "http://x.example", pathname: "/" }), String(bad)).toBeNull();
        }
        expect(canonicalLink("https://example.com", { origin: "https://example.com", pathname: "/" })).toBeNull();
    });

    it("speaks the admin's language, else the site's, else English", () => {
        expect(noticeLanguage("pt", "es-ES")).toBe("pt");
        expect(noticeLanguage(null, "es-ES")).toBe("es");
        expect(noticeLanguage("fr", "pt_BR")).toBe("pt");
        expect(noticeLanguage(null, "ar")).toBe("en");
        expect(noticeLanguage(null, null)).toBe("en");
    });

    it("reads the admin's choice from the key lib/i18n writes", () => {
        const store = new Map<string, string>();
        const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
        vi.stubGlobal("window", { localStorage: storage });
        vi.stubGlobal("localStorage", storage);
        try {
            setStoredLanguage("pt");
        } finally {
            vi.unstubAllGlobals();
        }
        expect([...store.keys()]).toEqual([ADMIN_LANGUAGE_STORAGE_KEY]);
        expect(storedAdminLanguage(() => storage)).toBe("pt");
        expect(storedAdminLanguage(() => { throw new Error("SecurityError"); })).toBeNull();
        expect(storedAdminLanguage(() => null)).toBeNull();
    });

    it("fills placeholders as text and leaves unknown ones alone", () => {
        expect(fillTemplate("at {host} — {nope}", { host: "<b>x</b>" })).toBe("at <b>x</b> — {nope}");
    });
});

describe("dashboard banners", () => {
    it("tells anyone on another address which address links use", () => {
        expect(dashboardBanners({ locationHostname: "192.168.1.9", linkBase: "https://example.com", admin: null }))
            .toEqual([{ kind: "link-base", linkBase: "https://example.com" }]);
        expect(dashboardBanners({ locationHostname: "EXAMPLE.com", linkBase: "https://example.com/", admin: null })).toEqual([]);
        expect(dashboardBanners({ locationHostname: "x", linkBase: "javascript:alert(1)", admin: null })).toEqual([]);
    });

    it("adds the administrator's conflict, drift, proxy and missing-address banners", () => {
        const admin = emptyState({
            canonical: null,
            conflict: { config: "https://a.example", db: "https://b.example" },
            gatewayDrift: { gateway: "https://a.example:8443", config: "http://a.example" },
            notices: ["proxy-collapse"],
        });
        expect(dashboardBanners({ locationHostname: "a.example", linkBase: "https://a.example", admin }).map((b) => b.kind))
            .toEqual(["conflict", "gateway-drift", "proxy-collapse", "missing-canonical"]);
        const healthy = emptyState({ canonical: site("https://a.example") });
        expect(dashboardBanners({ locationHostname: "a.example", linkBase: "https://a.example", admin: healthy })).toEqual([]);
    });
});

describe("install wizard (REDTEAM R6)", () => {
    it("never offers a loopback suggestion — the compose default would point every link at the reader's own machine", () => {
        for (const suggested of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://app.localhost"]) {
            expect(installSuggestion("https://blog.example.com", suggested), suggested).toBeNull();
            expect(installSuggestion("http://localhost:3000", suggested), suggested).toBeNull();
        }
    });

    it("offers a real suggestion that differs from where we are, and nothing invalid", () => {
        expect(installSuggestion("http://localhost:3000", "https://blog.example.com/")).toBe("https://blog.example.com");
        expect(installSuggestion("https://blog.example.com", "https://blog.example.com")).toBeNull();
        expect(installSuggestion("https://blog.example.com", "https,https://x")).toBeNull();
        expect(installSuggestion("https://blog.example.com", undefined)).toBeNull();
    });

    it("lands on the main address when the backend could not sign the admin in here", () => {
        expect(installLanding({ redirectTo: "/admin", siteUrl: "https://blog.example.com" }, "http://blog.lan:3000"))
            .toEqual({ href: "/admin", external: false });
        expect(installLanding({ redirectTo: "/login?installed=true", siteUrl: "https://blog.example.com", autoLoginSkipped: "address-not-accepted" }, "http://blog.lan:3000"))
            .toEqual({ href: "https://blog.example.com/login?installed=true", external: true });
        expect(installLanding({ redirectTo: "/login?installed=true", siteUrl: "https://blog.example.com", autoLoginSkipped: "sign-in-refused" }, "http://192.168.1.9:3000"))
            .toEqual({ href: "https://blog.example.com/login?installed=true", external: true });
        // Already on the main address: stay in the app.
        expect(installLanding({ redirectTo: "/login?installed=true", siteUrl: "https://blog.example.com", autoLoginSkipped: "sign-in-refused" }, "https://blog.example.com"))
            .toEqual({ href: "/login?installed=true", external: false });
    });

    it("never lands anywhere a response value could smuggle in", () => {
        expect(installLanding({ redirectTo: "//evil.example/x" }, "https://a.example")).toEqual({ href: "/login?installed=true", external: false });
        expect(installLanding({ redirectTo: "https://evil.example" }, "https://a.example")).toEqual({ href: "/login?installed=true", external: false });
        expect(installLanding({ redirectTo: "/\\evil.example" }, "https://a.example")).toEqual({ href: "/login?installed=true", external: false });
        expect(installLanding({ redirectTo: "/admin", siteUrl: "javascript:alert(1)", autoLoginSkipped: "address-not-accepted" }, "https://a.example"))
            .toEqual({ href: "/admin", external: false });
        expect(installLanding(null, "https://a.example")).toEqual({ href: "/login?installed=true", external: false });
    });

    it("offers to keep answering on the NAME being browsed when the main address differs", () => {
        expect(currentAddressAsAlias("https://old.example.com", "https://new.example.com")).toBe("https://old.example.com");
        expect(currentAddressAsAlias("https://new.example.com:8443", "https://new.example.com")).toBeNull();
        expect(currentAddressAsAlias("http://192.168.1.9:3000", "https://new.example.com")).toBeNull();
        expect(currentAddressAsAlias("http://localhost:3000", "https://new.example.com")).toBeNull();
        expect(isLoopbackHostname("[::ffff:7f00:1]")).toBe(true);
        expect(isLoopbackHostname("127.0.0.1")).toBe(true);
        expect(isLoopbackHostname("128.0.0.1")).toBe(false);
    });
});

describe("who may see it (REDTEAM R8, client side)", () => {
    it("only administrators ask for the state", () => {
        expect(canManageSiteAddress({ role: "administrator" })).toBe(true);
        for (const role of ["editor", "author", "subscriber", undefined]) expect(canManageSiteAddress({ role }), String(role)).toBe(false);
        expect(canManageSiteAddress(null)).toBe(false);
    });

    it("the retired /migration page sends administrators to the screen and everyone else home", () => {
        expect(migrationRedirectTarget({ role: "administrator" })).toBe("/admin/settings/site-address");
        expect(migrationRedirectTarget({ role: "editor" })).toBe("/");
        expect(migrationRedirectTarget(null)).toBe("/");
    });
});

// ─── 3 · the IP-address policy form and the SSL/port-change suggestion ──────────────────────────────

/** A screen's source, for the wiring a node test cannot render (no DOM here; the decisions are pinned above). */
const screenSource = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", rel), "utf8");

describe("the IP-address policy form: hostPolicy.ipSignIn has a control (REDTEAM R2)", () => {
    const loaded = (extra: Partial<SiteAddressState> = {}) => emptyState({ ipLiterals: "any", ipLiteralsSource: "default", ipSignIn: false, ...extra });

    it("sends the sign-in switch when it changes, with the mode the form shows", () => {
        expect(policyWrite(loaded(), { ipLiterals: "any", ipSignIn: true })).toEqual({ ipLiterals: "any", ipSignIn: true });
        expect(policyWrite(loaded({ ipLiterals: "own", ipLiteralsSource: "config", ipSignIn: true }), { ipLiterals: "own", ipSignIn: false }))
            .toEqual({ ipLiterals: "own", ipSignIn: false });
        expect(policyWrite(loaded(), { ipLiterals: "none", ipSignIn: true })).toEqual({ ipLiterals: "none", ipSignIn: true });
    });

    it("leaves the switch to the backend's stored value when only the mode changes, and saves nothing when nothing changed", () => {
        expect(policyWrite(loaded({ ipSignIn: true }), { ipLiterals: "own", ipSignIn: true })).toEqual({ ipLiterals: "own" });
        expect(policyWrite(loaded({ ipSignIn: true }), { ipLiterals: "any", ipSignIn: true })).toBeNull();
        expect(policyWrite(loaded(), { ipLiterals: "any", ipSignIn: false })).toBeNull();
    });

    it("is read-only while WORDJS_IP_HOSTS sets the mode: the override is never copied into the file", () => {
        const env = loaded({ ipLiterals: "none", ipLiteralsSource: "env" });
        expect(policyWrite(env, { ipLiterals: "none", ipSignIn: true })).toBeNull();
        expect(policyWrite(env, { ipLiterals: "any", ipSignIn: false })).toBeNull();
    });

    it("PUT /policy carries ipSignIn on the wire", async () => {
        const realFetch = globalThis.fetch;
        const bodies: unknown[] = [];
        globalThis.fetch = (async (_input: unknown, init: { body?: string } = {}) => {
            bodies.push(JSON.parse(init.body as string));
            return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => ({ rev: 6 }), text: async () => "{\"rev\":6}" };
        }) as unknown as typeof fetch;
        try {
            await siteAddressApi.putPolicy({ ipLiterals: "any", ipSignIn: true, currentPassword: "pw", rev: 5 });
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(bodies).toEqual([{ ipLiterals: "any", ipSignIn: true, currentPassword: "pw", rev: 5 }]);
    });

    it("the screen binds a checkbox to it and saves what policyWrite builds", () => {
        const page = screenSource("app/admin/settings/site-address/page.tsx");
        expect(page).toMatch(/setIpSignInChoice\(next\.ipSignIn\)/);
        expect(page).toMatch(/type="checkbox"\s+checked=\{ipSignInChoice\}[\s\S]{0,300}onChange=\{\(e\) => setIpSignInChoice\(e\.target\.checked\)\}/);
        expect(page).toMatch(/policyWrite\(state, \{ ipLiterals: ipChoice, ipSignIn: ipSignInChoice \}\)/);
        expect(page).toMatch(/siteAddressApi\.putPolicy\(\{ \.\.\.body, currentPassword, rev \}\)/);
    });
});

describe("after an SSL or port change: the main address is followed or suggested (SPEC §6, REDTEAM R1)", () => {
    const PATH = "/admin/settings/site-address";

    it("reads canonicalUpgraded and suggestCanonical from POST /system/certs/config, parsed", () => {
        expect(gatewayAddressOutcome({ siteUrl: "https://example.com", canonicalUpgraded: "https://example.com", siteAddressWarnings: ["gateway not told yet", 7] }))
            .toEqual({ kind: "upgraded", address: "https://example.com", warnings: ["gateway not told yet"] });
        expect(gatewayAddressOutcome({ suggestCanonical: "http://Example.com:3000" }))
            .toEqual({ kind: "suggest", address: "http://example.com:3000", href: `${PATH}?suggest=${encodeURIComponent("http://example.com:3000")}` });
        for (const junk of [{}, { suggestCanonical: "javascript:alert(1)" }, { suggestCanonical: "https://x.example/path" }, { canonicalUpgraded: 42 }, null, "ok"]) {
            expect(gatewayAddressOutcome(junk), JSON.stringify(junk)).toBeNull();
        }
    });

    it("a suggestion takes the admin to the site-address screen; an upgrade is announced by name; nothing else navigates", async () => {
        const run = async (res: unknown) => {
            const alerts: string[] = [];
            const went: string[] = [];
            await afterGatewayConfigSave(res, { alert: async (m) => { alerts.push(m); }, navigate: (href) => went.push(href) });
            return { alerts, went };
        };
        const suggested = await run({ suggestCanonical: "http://example.com:3000" });
        expect(suggested.alerts).toHaveLength(1);
        expect(suggested.alerts[0]).toContain("http://example.com:3000");
        expect(suggested.went).toEqual([`${PATH}?suggest=http%3A%2F%2Fexample.com%3A3000`]);

        const upgraded = await run({ canonicalUpgraded: "https://example.com", siteAddressWarnings: ["The gateway could not be told yet."] });
        expect(upgraded.alerts[0]).toMatch(/main address is now https:\/\/example\.com.*The gateway could not be told yet\./);
        expect(upgraded.went).toEqual([]);

        const plain = await run({ siteUrl: "https://example.com" });
        expect(plain.alerts).toEqual(["Settings saved. You may need to restart the gateway."]);
        expect(plain.went).toEqual([]);
    });

    it("?suggest= is a hint: honoured only for the address the backend itself reports as the gateway's", () => {
        const drift = emptyState({ canonical: site("https://example.com"), gatewayDrift: { gateway: "http://example.com:3000", config: "https://example.com" } });
        // The href the security page builds comes back through the query string intact.
        const href = (gatewayAddressOutcome({ suggestCanonical: "http://example.com:3000" }) as { href: string }).href;
        const param = new URLSearchParams(href.slice(href.indexOf("?"))).get("suggest");
        expect(suggestedCanonical(param, drift)).toBe("http://example.com:3000");
        expect(suggestedCanonical("http://EXAMPLE.com:3000/", drift)).toBe("http://example.com:3000");
        // A crafted link: no drift reported, or another address than the drift — no prefilled dialog.
        expect(suggestedCanonical("https://evil.example", drift)).toBeNull();
        expect(suggestedCanonical("http://example.com:3000", emptyState({ canonical: site("https://example.com") }))).toBeNull();
        expect(suggestedCanonical("javascript:alert(1)", drift)).toBeNull();
        expect(suggestedCanonical(null, drift)).toBeNull();
        // Already the main address (the admin adopted it, the drift entry is stale): nothing to open.
        expect(suggestedCanonical("https://example.com", emptyState({ canonical: site("https://example.com"), gatewayDrift: { gateway: "https://example.com", config: "http://example.com" } })))
            .toBeNull();
    });

    it("the security page routes the save answer through it, and the site-address screen opens the change dialog from ?suggest=", () => {
        const security = screenSource("app/admin/security/page.tsx");
        expect(security).toMatch(/const (\w+) = await apiPost<unknown>\('\/system\/certs\/config'[\s\S]*?afterGatewayConfigSave\(\1, \{ alert, navigate: \(href\) => router\.push\(href\) \}\)/);
        const screen = screenSource("app/admin/settings/site-address/page.tsx");
        expect(screen).toMatch(/const suggestParam = useSearchParams\(\)\.get\("suggest"\)/);
        expect(screen).toMatch(/suggestedCanonical\(suggestParam, next\)[\s\S]{0,200}setDialog\(\{ kind: "canonical", prefillUrl: suggestion \}\)/);
    });
});

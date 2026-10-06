/**
 * What an API refusal may do to the BROWSER (SPEC §3, client side).
 *
 * `api()` used to follow any `redirect` field in an error body: `window.location.href = error.redirect`.
 * Any route could put a URL there (plugin routes included), so every API response was a potential open
 * redirect, and the old host guard used it to steer visitors to /migration, the page that adopted the
 * request's host as the site address. Now exactly ONE navigation exists — a fresh install's 503
 * setup_required goes to the fixed /install path — and a 421 (this address is not served) becomes a typed
 * error plus one page-level event that HostNotAllowedNotice explains.
 *
 * Node environment: `fetch` and a minimal `window` are substituted per test, and the module is re-imported
 * each time because the 421 announcement is deliberately once per page (module state).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type ApiModule = typeof import("../api");

let api: ApiModule;
let events: Event[];
const realFetch = globalThis.fetch;

function stubFetch(status: number, body: unknown, raw = false) {
    globalThis.fetch = (async () => {
        const text = raw ? String(body) : JSON.stringify(body);
        return {
            ok: status < 400,
            status,
            statusText: "X",
            headers: { get: () => null },
            json: async () => JSON.parse(text),
            text: async () => text,
        };
    }) as unknown as typeof fetch;
}

function stubWindow(pathname: string) {
    events = [];
    const location = { pathname, href: `https://example.com${pathname}`, host: "evil.example:3000", origin: "https://evil.example:3000" };
    vi.stubGlobal("window", { location, dispatchEvent: (e: Event) => { events.push(e); return true; } });
    return location;
}

beforeEach(async () => {
    vi.resetModules();
    api = await import("../api");
});

afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
});

describe("a response body can no longer navigate the browser", () => {
    it("ignores an absolute `redirect` in an error body", async () => {
        const location = stubWindow("/admin/posts");
        stubFetch(409, { code: "rest_conflict", message: "Nope", redirect: "https://evil.example/phish" });
        await expect(api.apiGet("/posts")).rejects.toThrow("Nope");
        expect(location.href).toBe("https://example.com/admin/posts");
    });

    it("ignores the old host guard's relative `/migration` redirect", async () => {
        const location = stubWindow("/admin");
        stubFetch(409, { error: "migration_required", message: "Domain change detected", redirect: "/migration" });
        await expect(api.apiGet("/settings")).rejects.toThrow();
        expect(location.href).toBe("https://example.com/admin");
    });

    it("ignores a plugin route's `redirect`, whatever the status", async () => {
        const location = stubWindow("/");
        for (const status of [400, 401, 403, 404, 500]) {
            stubFetch(status, { error: "x", redirect: "//evil.example" });
            await expect(api.apiGet("/plugins/acme/thing")).rejects.toThrow();
        }
        expect(location.href).toBe("https://example.com/");
    });

    it("still sends a fresh install to the FIXED /install path — not to the body's redirect", async () => {
        const location = stubWindow("/admin");
        stubFetch(503, { error: "setup_required", message: "WordJS is not installed.", redirect: "https://evil.example/install" });
        await expect(api.apiGet("/settings")).rejects.toThrow(/Redirecting to \/install/);
        expect(location.href).toBe("/install");
    });

    it("does not loop on the wizard itself, and keeps the message callers match on", async () => {
        const location = stubWindow("/install");
        stubFetch(503, { error: "setup_required", message: "WordJS is not installed.", redirect: "/install" });
        await expect(api.apiGet("/fonts")).rejects.toThrow("WordJS is not installed.");
        expect(location.href).toBe("https://example.com/install");
    });

    it("a 503 that is not setup_required navigates nowhere", async () => {
        const location = stubWindow("/admin");
        stubFetch(503, { status: "starting", redirect: "/install" });
        await expect(api.apiGet("/settings")).rejects.toThrow();
        expect(location.href).toBe("https://example.com/admin");
    });
});

describe("421 — this address is not served", () => {
    const refusal = { code: "rest_host_not_allowed", error: "host_not_allowed", message: "This address is not configured for this site.", data: { status: 421 } };

    it("throws the typed error, never navigates, and announces the page-level event", async () => {
        const location = stubWindow("/admin");
        stubFetch(421, refusal);
        const err = await api.apiGet("/settings").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(api.HostNotAllowedError);
        expect(api.isHostNotAllowed(err)).toBe(true);
        expect((err as InstanceType<ApiModule["HostNotAllowedError"]>).status).toBe(421);
        expect((err as InstanceType<ApiModule["HostNotAllowedError"]>).code).toBe("rest_host_not_allowed");
        expect((err as Error).message).toBe(refusal.message);
        expect(location.href).toBe("https://example.com/admin");
        expect(events.map((e) => e.type)).toEqual([api.HOST_NOT_ALLOWED_EVENT]);
        expect((events[0] as CustomEvent).detail).toEqual({ host: "evil.example:3000" });
        expect(api.hostNotAllowedWasAnnounced()).toBe(true);
    });

    it("announces ONCE per page however many calls are refused", async () => {
        stubWindow("/");
        stubFetch(421, refusal);
        for (let i = 0; i < 5; i++) await expect(api.apiGet("/fonts")).rejects.toBeInstanceOf(api.HostNotAllowedError);
        await expect(api.apiGetPaged("/posts")).rejects.toBeInstanceOf(api.HostNotAllowedError);
        expect(events).toHaveLength(1);
    });

    it("is recognised even when the body is not JSON (an edge page or a proxy)", async () => {
        stubWindow("/");
        stubFetch(421, "<html>Misdirected Request</html>", true);
        await expect(api.apiGet("/fonts")).rejects.toBeInstanceOf(api.HostNotAllowedError);
        expect(events).toHaveLength(1);
    });

    it("ignores any redirect the 421 carries", async () => {
        const location = stubWindow("/login");
        stubFetch(421, { ...refusal, redirect: "https://evil.example" });
        await expect(api.apiGet("/auth/password-reset-available")).rejects.toBeInstanceOf(api.HostNotAllowedError);
        expect(location.href).toBe("https://example.com/login");
    });

    it("isHostNotAllowed is false for other refusals", () => {
        expect(api.isHostNotAllowed(Object.assign(new Error("x"), { code: "rest_forbidden" }))).toBe(false);
        expect(api.isHostNotAllowed(null)).toBe(false);
        expect(api.isHostNotAllowed({ code: "rest_host_not_allowed" })).toBe(true);
    });

    it("server-side (no window) the error is still typed and nothing is dispatched", async () => {
        stubFetch(421, refusal);
        await expect(api.apiGet("/settings")).rejects.toBeInstanceOf(api.HostNotAllowedError);
        expect(api.hostNotAllowedWasAnnounced()).toBe(false);
    });
});

describe("error structure reaches the caller", () => {
    it("keeps the WordPress-style `data` member (the site-address interlock's dependents)", async () => {
        stubWindow("/admin/settings/site-address");
        const dependents = [{ kind: "gatewayUrl", host: "old.example" }];
        stubFetch(409, { code: "rest_site_address_in_use", message: "In use", data: { status: 409, dependents } });
        const err = (await api.apiPut("/site-address/aliases", {}).catch((e: unknown) => e)) as { status: number; code: string; data: { dependents: unknown } };
        expect(err.status).toBe(409);
        expect(err.code).toBe("rest_site_address_in_use");
        expect(err.data.dependents).toEqual(dependents);
    });
});

/**
 * `themesApi.restoreDefault` — the client half of POST /api/v1/themes/default.
 *
 * The backend has told admins to call this endpoint for a while (core/themes names it in the "you
 * cannot delete the last theme" refusal, index.ts names it in the boot warning), and nothing in the
 * frontend could. That is worse than an ordinary missing button: boot no longer re-creates
 * themes/default, so restoring is the ONLY way out of the `active_theme_missing` state, and an
 * instruction whose only implementation is curl is not a recovery path a product has.
 *
 * What is pinned here is the wire contract — verb, path and credentials — because those are what
 * make the call reach the handler at all. A GET, or a call without the cookie, is a 404/401 that
 * would look exactly like "restore doesn't work" to whoever hits it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { themesApi } from "../api";

type Call = { url: string; init: RequestInit };

function stubFetch(response: unknown = { success: true, message: "Default theme restored in /themes/default" }) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return {
            ok: true,
            status: 200,
            json: async () => response,
        } as unknown as Response;
    });
    return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("themesApi.restoreDefault", () => {
    it("POSTs to /themes/default with the session cookie", async () => {
        const calls = stubFetch();
        await themesApi.restoreDefault();

        expect(calls).toHaveLength(1);
        const [{ url, init }] = calls;
        // The path the backend router actually registers (backend/src/routes/themes.ts). It must not
        // be confused with /themes/:slug/activate — restoring REWRITES files, activating does not.
        expect(url.endsWith("/themes/default")).toBe(true);
        expect(init.method).toBe("POST");
        // The route is authenticate + isAdmin; the JWT lives in an HttpOnly cookie, so omitting
        // credentials turns every restore into a 401.
        expect(init.credentials).toBe("include");
    });

    it("returns the handler's payload so the screen can show the backend's own message", async () => {
        stubFetch({ success: true, message: "Default theme restored in /themes/default" });
        const res = await themesApi.restoreDefault();
        expect(res.success).toBe(true);
        expect(res.message).toContain("Default theme restored");
    });

    it("does not swallow a failure — the caller must be able to surface it", async () => {
        vi.stubGlobal("fetch", async () => ({
            ok: false,
            status: 403,
            statusText: "Forbidden",
            text: async () => JSON.stringify({ error: "Forbidden" }),
        } as unknown as Response));
        await expect(themesApi.restoreDefault()).rejects.toThrow(/Forbidden/);
    });
});

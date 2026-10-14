/**
 * getPortalPage (lib/server-api.ts) — how the server page of /portal/<slug> reads the backend's answer.
 *
 * The backend's 404 means "no active plugin serves this portal" and the page answers a real 404. Anything
 * that is not an answer (backend down, a 5xx, a body that is not this portal's) must NOT become that 404:
 * the portal may well exist, so the page renders and the client reports the outage instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getPortalPage } from "@/lib/server-api";

function backendAnswers(status: number, body?: unknown) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        calls.push(String(url));
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => {
                if (body === undefined) throw new SyntaxError("not JSON");
                return body;
            },
        };
    }));
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("getPortalPage", () => {
    it("asks GET /plugins/<slug>/portal and returns the head details of a served portal", async () => {
        const calls = backendAnswers(200, { slug: "sala-de-comando", title: "Sala", themeColor: "#2563eb", viewportFit: "cover" });
        await expect(getPortalPage("sala-de-comando")).resolves.toEqual({
            status: "served",
            info: { slug: "sala-de-comando", title: "Sala", themeColor: "#2563eb", viewportFit: "cover" },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatch(/\/api\/v1\/plugins\/sala-de-comando\/portal$/);
    });

    it("the backend's 404 is 'missing'", async () => {
        backendAnswers(404, { error: "Portal not found" });
        await expect(getPortalPage("no-such-portal")).resolves.toEqual({ status: "missing" });
    });

    it("no usable answer is 'unavailable', never 'missing'", async () => {
        backendAnswers(503, { error: "setup_required" });
        await expect(getPortalPage("portal-a")).resolves.toEqual({ status: "unavailable" });
        backendAnswers(200);
        await expect(getPortalPage("portal-b")).resolves.toEqual({ status: "unavailable" });
        backendAnswers(200, { slug: "someone-else" });
        await expect(getPortalPage("portal-c")).resolves.toEqual({ status: "unavailable" });
        vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
        await expect(getPortalPage("portal-d")).resolves.toEqual({ status: "unavailable" });
    });
});

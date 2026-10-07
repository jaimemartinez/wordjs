/**
 * AuthContext where no session can be had (SPEC §3, REDTEAM R13):
 *
 *   • a 421 on /auth/me — the site does not serve this address at all. A page on an undeclared address
 *     may be a phishing or DNS-rebinding page, and a password typed into it goes to that address;
 *   • a 401 whose body says `data.signIn: false` — the address is served, but may not START a session
 *     (plain http to an https site, an IP not enabled for sign-in). The backend would refuse the login,
 *     but only after the password had crossed the wire, possibly in clear text.
 *
 * In both cases the sign-in form must not render. Node environment, no DOM: `probeSession` (the one
 * place statuses are mapped) is driven with a fake fetch, and the gate that replaces the tree is
 * rendered to static markup.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthGate, probeSession } from "../AuthContext";

const fetchAnswering = (status: number, body: unknown = {}) =>
    (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;

const notLoggedIn = (data: Record<string, unknown>) => ({ code: "rest_not_logged_in", message: "x", data: { status: 401, ...data } });

describe("probeSession — what GET /auth/me means", () => {
    it("200 → the user", async () => {
        expect(await probeSession(fetchAnswering(200, { id: 1, username: "admin" }))).toEqual({ kind: "user", user: { id: 1, username: "admin" } });
    });

    it("401 → signed out, and free to sign in unless the body says otherwise", async () => {
        expect(await probeSession(fetchAnswering(401, notLoggedIn({ signIn: true })))).toEqual({ kind: "signed-out", signInRefused: null });
        // An older backend sends no eligibility at all: nothing is refused on the client's own initiative.
        expect(await probeSession(fetchAnswering(401, notLoggedIn({})))).toEqual({ kind: "signed-out", signInRefused: null });
        expect(await probeSession(fetchAnswering(401, "not json"))).toEqual({ kind: "signed-out", signInRefused: null });
    });

    it("401 with data.signIn:false → signed out AND this address may not start a session (R13)", async () => {
        expect(await probeSession(fetchAnswering(401, notLoggedIn({ signIn: false, signInRefused: "transport" }))))
            .toEqual({ kind: "signed-out", signInRefused: "transport" });
        expect(await probeSession(fetchAnswering(401, notLoggedIn({ signIn: false, signInRefused: "address" }))))
            .toEqual({ kind: "signed-out", signInRefused: "address" });
        // A reason this client does not know is still a refusal.
        expect(await probeSession(fetchAnswering(401, notLoggedIn({ signIn: false, signInRefused: "something-new" }))))
            .toEqual({ kind: "signed-out", signInRefused: "address" });
    });

    it("421 → this address is refused (not 'signed out', which would show the login form)", async () => {
        expect(await probeSession(fetchAnswering(421, { code: "rest_host_not_allowed" }))).toEqual({ kind: "host-refused" });
    });

    it("403, 5xx and network errors → unknown, so a transient failure never logs anyone out", async () => {
        expect(await probeSession(fetchAnswering(403))).toEqual({ kind: "unknown" });
        expect(await probeSession(fetchAnswering(502))).toEqual({ kind: "unknown" });
        const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await probeSession((async () => { throw new TypeError("network"); }) as unknown as typeof fetch)).toEqual({ kind: "unknown" });
        quiet.mockRestore();
    });

    it("asks the session endpoint with the cookie", async () => {
        const seen: Array<[string, RequestInit | undefined]> = [];
        await probeSession((async (url: string, init?: RequestInit) => {
            seen.push([url, init]);
            return { ok: false, status: 401, json: async () => ({}) };
        }) as unknown as typeof fetch);
        expect(seen).toEqual([["/api/v1/auth/me", { credentials: "include" }]]);
    });
});

describe("AuthGate — what renders under AuthProvider", () => {
    const loginForm = <form id="login"><input name="password" type="password" /></form>;
    const gate = (props: { hostRefused: boolean; signInRefused: "transport" | "address" | null; signedIn: boolean }) =>
        renderToStaticMarkup(<AuthGate {...props}>{loginForm}</AuthGate>);

    const assertNoForm = (html: string) => {
        expect(html).toContain("data-wjs-host-refused");
        for (const tag of ["<form", "<input", "<button", "password"]) expect(html).not.toContain(tag);
    };

    it("a refused address renders the panel INSTEAD of the tree", () => {
        assertNoForm(gate({ hostRefused: true, signInRefused: null, signedIn: false }));
    });

    it("an address that may not start a session renders the panel for a signed-out visitor (R13)", () => {
        assertNoForm(gate({ hostRefused: false, signInRefused: "transport", signedIn: false }));
        assertNoForm(gate({ hostRefused: false, signInRefused: "address", signedIn: false }));
        expect(gate({ hostRefused: false, signInRefused: "transport", signedIn: false })).toContain('data-wjs-host-refused="transport"');
    });

    it("never locks out a session that already exists", () => {
        expect(gate({ hostRefused: false, signInRefused: "transport", signedIn: true })).toBe(renderToStaticMarkup(loginForm));
    });

    it("an accepted address renders the tree untouched", () => {
        expect(gate({ hostRefused: false, signInRefused: null, signedIn: false })).toBe(renderToStaticMarkup(loginForm));
    });
});

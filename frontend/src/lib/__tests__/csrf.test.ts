/**
 * THE BROWSER HALF OF THE DOUBLE-SUBMIT CSRF TOKEN.
 *
 * The backend refuses any cookie-authenticated mutation whose `X-CSRF-Token` header does not match the
 * `wjs_csrf` cookie (backend/src/middleware/auth.ts, `csrfTokenGate`, proved end to end in
 * backend/src/tests/csrf-double-submit.test.ts). Everything on this side depends on one function
 * finding that cookie inside `document.cookie` — a flat string that also holds every OTHER cookie the
 * site sets, in an order nothing guarantees. A reader that matches the wrong entry, or misses the token
 * when it is not first, does not fail loudly: it produces a 403 on a request the user was perfectly
 * entitled to make, from a header the browser never sent.
 *
 * `document` is STUBBED rather than emulated: this suite runs in vitest's default node environment (the
 * project does not ship jsdom), and what is under test is the parsing of one string, which a stub
 * expresses more precisely than a cookie jar would — a raw jar cannot even hold the malformed values
 * asserted below.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_COOKIE, CSRF_HEADER, csrfHeaders, readCsrfToken } from "../csrf";

const g = globalThis as unknown as { document?: { cookie: string } };

/** Present `document.cookie` as the given raw string for the duration of one assertion. */
function withCookieJar(raw: string): void {
    g.document = { cookie: raw };
}

afterEach(() => {
    delete g.document;
});

describe("readCsrfToken", () => {
    it("returns null with no document at all (SSR) — never throws", () => {
        delete g.document;
        expect(readCsrfToken()).toBeNull();
        expect(csrfHeaders()).toEqual({});
    });

    it("returns null when the cookie is absent — never a stale or invented value", () => {
        withCookieJar("wordjs_token=a.jwt.value; locale=es");
        expect(readCsrfToken()).toBeNull();
    });

    it("finds the token wherever it sits in the jar", () => {
        withCookieJar(`wordjs_token=a.jwt.value; ${CSRF_COOKIE}=tok-123; locale=es`);
        expect(readCsrfToken()).toBe("tok-123");
    });

    it("finds it as the FIRST entry, where there is no leading space to trim", () => {
        withCookieJar(`${CSRF_COOKIE}=tok-first; locale=es`);
        expect(readCsrfToken()).toBe("tok-first");
    });

    it("does NOT match a cookie whose name merely ENDS with the token's name", () => {
        // `document.cookie` is a flat string, so a naive `includes('wjs_csrf=')` — or any match that
        // does not anchor at the start of the entry — happily returns the impostor's value here, and
        // every request then carries a header that can never equal the real cookie: a permanent,
        // silent 403 on a site that looks correctly configured.
        withCookieJar(`other_${CSRF_COOKIE}=impostor; ${CSRF_COOKIE}=genuine`);
        expect(readCsrfToken()).toBe("genuine");
    });

    it("returns null for an empty value rather than sending an empty header", () => {
        // The gate refuses an empty token anyway; sending one turns a clear "no token" into a mismatch
        // that reads like an attack in the server log.
        withCookieJar(`${CSRF_COOKIE}=; locale=es`);
        expect(readCsrfToken()).toBeNull();
    });

    it("percent-decodes the value the way express encodes it", () => {
        withCookieJar(`${CSRF_COOKIE}=${encodeURIComponent("a+b/c=")}`);
        expect(readCsrfToken()).toBe("a+b/c=");
    });

    it("survives a malformed percent-escape instead of throwing mid-request", () => {
        // decodeURIComponent throws a URIError on a lone '%'. Thrown from inside a fetch wrapper it
        // would abort the request entirely; the server rejecting a wrong token is the better failure.
        withCookieJar(`${CSRF_COOKIE}=100%`);
        expect(readCsrfToken()).toBe("100%");
    });
});

describe("csrfHeaders", () => {
    it("produces the header the backend compares against", () => {
        withCookieJar(`${CSRF_COOKIE}=tok-abc`);
        expect(csrfHeaders()).toEqual({ [CSRF_HEADER]: "tok-abc" });
    });

    it("produces NOTHING when there is no token, so spreading it never sends an empty header", () => {
        withCookieJar("locale=es");
        expect(csrfHeaders()).toEqual({});
    });

    it("names the header and cookie exactly as the backend does", () => {
        // These two literals are the contract. Asserted rather than merely used, because a rename on
        // either side is otherwise invisible until every mutation in the app starts 403ing.
        expect(CSRF_COOKIE).toBe("wjs_csrf");
        expect(CSRF_HEADER).toBe("X-CSRF-Token");
    });
});

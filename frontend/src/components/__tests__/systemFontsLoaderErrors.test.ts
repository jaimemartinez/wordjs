/**
 * SystemFontsLoader runs on every page, so on an address the site does not serve its /fonts call is
 * the first thing to be refused (421). That refusal is explained by HostNotAllowedNotice; logging it as
 * a font failure would put an error in every visitor's console and raise the dev overlay on top of the
 * notice. Same for the "not installed" answer during first-run setup.
 */
import { describe, it, expect } from "vitest";
import { isFontLoadFailure } from "../SystemFontsLoader";
import { HostNotAllowedError } from "@/lib/api";

describe("isFontLoadFailure", () => {
    it("is silent about a refused address", () => {
        expect(isFontLoadFailure(new HostNotAllowedError())).toBe(false);
        expect(isFontLoadFailure(Object.assign(new Error("whatever"), { code: "rest_host_not_allowed" }))).toBe(false);
    });

    it("is silent about the first-run 'not installed' answer", () => {
        expect(isFontLoadFailure(new Error("WordJS is not installed."))).toBe(false);
    });

    it("reports everything else", () => {
        expect(isFontLoadFailure(new Error("HTTP 500 Internal Server Error"))).toBe(true);
        expect(isFontLoadFailure(Object.assign(new Error("Forbidden"), { code: "rest_forbidden" }))).toBe(true);
        expect(isFontLoadFailure(null)).toBe(true);
    });
});

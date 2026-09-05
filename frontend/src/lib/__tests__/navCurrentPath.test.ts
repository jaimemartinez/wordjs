import { describe, it, expect } from "vitest";
import { isCurrentMenuPath, menuAriaCurrent } from "../chromeData";

/**
 * The MATCHER behind aria-current on menu links — the one definition every nav surface shares
 * (composed chrome nav + its drawer, the NavMenu/MegaMenu blocks, the default Header/Footer).
 *
 * What is pinned here is deliberately as much about what must NOT match as about what must. A wrong
 * aria-current is worse than a missing one: a screen reader then announces the wrong page as the
 * current one, and a theme underlines the wrong item. So: exact pathname only, no url-prefix
 * "ancestor" guessing, and nothing that is not root-relative.
 *
 * Mutation proof: drop the `path.startsWith("/")` guard in normalizeNavPath and the absolute-url case
 * goes red; compare with startsWith instead of === and the "/" and ancestor cases go red.
 */
describe("isCurrentMenuPath — exact pathname match", () => {
    it("matches the same path", () => {
        expect(isCurrentMenuPath("/contact", "/contact")).toBe(true);
    });

    it("treats trailing slashes as equal, on either side", () => {
        expect(isCurrentMenuPath("/contact/", "/contact")).toBe(true);
        expect(isCurrentMenuPath("/contact", "/contact/")).toBe(true);
        expect(isCurrentMenuPath("/contact/", "/contact/")).toBe(true);
    });

    it('keeps "/" matching ONLY "/" — the home link is not current on every page', () => {
        expect(isCurrentMenuPath("/", "/")).toBe(true);
        expect(isCurrentMenuPath("/", "/about")).toBe(false);
        expect(isCurrentMenuPath("/", "/about/team")).toBe(false);
    });

    it("compares the pathname only — a query string is dropped from either side", () => {
        expect(isCurrentMenuPath("/contact?ref=footer", "/contact")).toBe(true);
        expect(isCurrentMenuPath("/contact", "/contact?utm=x")).toBe(true);
        expect(isCurrentMenuPath("/contact?a=1", "/contact?b=2")).toBe(true);
    });

    it("does NOT mark a link with a fragment — it names a section, not a page", () => {
        // The case that made this rule: a one-page menu whose items are "/", "/#venues", "/#prices".
        // Stripping the hash would light up all three at once on the home page.
        expect(isCurrentMenuPath("/#venues", "/")).toBe(false);
        expect(isCurrentMenuPath("/contact#form", "/contact")).toBe(false);
        // An EMPTY fragment names nothing, so it does not disqualify the link.
        expect(isCurrentMenuPath("/contact#", "/contact")).toBe(true);
    });

    it("folds percent-encoding, so a stored escape matches a decoded pathname", () => {
        expect(isCurrentMenuPath("/pages/qu%C3%A9", "/pages/qué")).toBe(true);
        expect(isCurrentMenuPath("/pages/qué", "/pages/qu%C3%A9")).toBe(true);
    });

    it("does NOT treat an ancestor path as current (no url-prefix guessing)", () => {
        expect(isCurrentMenuPath("/products", "/products/widgets")).toBe(false);
        expect(isCurrentMenuPath("/products/widgets", "/products")).toBe(false);
        // …and a shared prefix that is not a path boundary must never match either.
        expect(isCurrentMenuPath("/pro", "/products")).toBe(false);
    });

    it("never matches a link that is not root-relative", () => {
        // Absolute — even to what may be this very site: the origin is not knowable identically on the
        // server and in the browser, and guessing it is how a hydration mismatch is born.
        expect(isCurrentMenuPath("https://example.com/contact", "/contact")).toBe(false);
        expect(isCurrentMenuPath("http://localhost:3000/contact", "/contact")).toBe(false);
        // Protocol-relative (external by our own safeMenuHref rules).
        expect(isCurrentMenuPath("//example.com/contact", "/contact")).toBe(false);
        // Non-navigational schemes and bare fragments/queries.
        expect(isCurrentMenuPath("mailto:hi@example.com", "/contact")).toBe(false);
        expect(isCurrentMenuPath("tel:+34600000000", "/contact")).toBe(false);
        expect(isCurrentMenuPath("#section", "/contact")).toBe(false);
        expect(isCurrentMenuPath("?page=2", "/contact")).toBe(false);
        // The inert href a rejected menu url collapses to must never look like the current page.
        expect(isCurrentMenuPath("#", "/contact")).toBe(false);
    });

    it("is total: any non-string on either side is simply not current", () => {
        expect(isCurrentMenuPath(undefined, "/contact")).toBe(false);
        expect(isCurrentMenuPath(null, "/contact")).toBe(false);
        expect(isCurrentMenuPath(42, "/contact")).toBe(false);
        // usePathname returns null outside a router context — that must not throw or mark anything.
        expect(isCurrentMenuPath("/contact", null)).toBe(false);
        expect(isCurrentMenuPath("/contact", undefined)).toBe(false);
        expect(isCurrentMenuPath("", "")).toBe(false);
    });
});

describe("menuAriaCurrent — the attribute value", () => {
    it('is "page" for the current link', () => {
        expect(menuAriaCurrent("/contact", "/contact")).toBe("page");
    });

    it("is undefined (not false) elsewhere, so React omits the attribute entirely", () => {
        expect(menuAriaCurrent("/about", "/contact")).toBeUndefined();
    });
});

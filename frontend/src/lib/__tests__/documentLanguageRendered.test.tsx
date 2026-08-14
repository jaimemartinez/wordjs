/**
 * `<html lang>` / `<html dir>` — THE RENDERED ATTRIBUTE.
 *
 * documentLanguage.test.ts proves the resolver is fail-closed, and backend/src/tests/
 * document-language.test.ts proves the write side refuses anything outside the allowed shapes.
 * Neither of those proves the thing that actually protects a visitor: that the root layout CONSUMES
 * the resolver, and that what lands between the quotes of `lang=` and `dir=` in the shipped HTML is
 * the sanitized value.
 *
 * That gap is not hypothetical in this repo — a validator whose result nothing consumed has shipped
 * here more than once, and it is invisible to every other check: `<html lang="en">` hardcoded back
 * into layout.tsx would keep the whole resolver suite green, keep `tsc` green, keep `next build`
 * green, and silently un-ship RTL. So these tests render the REAL RootLayout and read the real
 * opening tag out of the real markup.
 *
 * WPLANG and site_text_direction are the only two site options that reach an HTML ATTRIBUTE rather
 * than text, which is why they get this second, render-level pass: an attribute value is the one
 * place where a stray quote stops being data and starts being structure.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The settings the layout will read. A mutable box (vi.hoisted) because vi.mock factories are
// hoisted above every other statement in the file.
const site = vi.hoisted(() => ({ settings: null as Record<string, unknown> | null }));

vi.mock("@/lib/server-api", () => ({
    getSettings: async () => site.settings,
    getFonts: async () => [],
}));

// next/font/google runs inside the Next compiler, not in a plain Node ESM graph, so the shared font
// instance is stubbed down to the one field the layout uses.
vi.mock("@/app/fonts", () => ({ inter: { variable: "font-inter-var" } }));

// useSearchParams needs a router context that renderToStaticMarkup has no way to provide. It sits
// behind a <Suspense fallback={null}> in the layout, but renderToStaticMarkup cannot suspend, so the
// error would propagate. Nothing about this component touches <html>.
vi.mock("@/components/AnalyticsTracker", () => ({ AnalyticsTracker: () => null }));

const { default: RootLayout } = await import("@/app/layout");

/** Render the real (async) root layout and return the shipped HTML. */
async function render(settings: Record<string, unknown> | null): Promise<string> {
    site.settings = settings;
    return renderToStaticMarkup(await RootLayout({ children: null }));
}

/** The opening `<html …>` tag exactly as it is written to the wire. */
function htmlTag(markup: string): string {
    const m = /^<html\b[^>]*>/.exec(markup);
    expect(m, "the layout must render an <html> element").not.toBeNull();
    return m![0];
}

/** Every `name="value"` pair in a tag, in source order — duplicates preserved on purpose. */
function attributes(tag: string): Array<[string, string]> {
    return [...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]] as [string, string]);
}

const attr = (tag: string, name: string) => attributes(tag).filter(([n]) => n === name).map(([, v]) => v);

describe("RootLayout renders <html lang dir> from the site's options", () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
        ["a fresh site with nothing configured", {}, "en", "ltr"],
        ["a Spanish site", { WPLANG: "es_ES" }, "es-ES", "ltr"],
        ["an Arabic site — no direction configured, derived", { WPLANG: "ar_SA" }, "ar-SA", "rtl"],
        ["a Hebrew site", { WPLANG: "he_IL" }, "he-IL", "rtl"],
        ["the script subtag outranking the language", { WPLANG: "pa_Arab_PK" }, "pa-Arab-PK", "rtl"],
        ["an explicit override beating the locale", { WPLANG: "en_US", site_text_direction: "rtl" }, "en-US", "rtl"],
        ["an explicit override the other way", { WPLANG: "ar", site_text_direction: "ltr" }, "ar", "ltr"],
        ["dir=auto, a real HTML value", { WPLANG: "en", site_text_direction: "auto" }, "en", "auto"],
    ];

    for (const [name, settings, lang, dir] of cases) {
        it(`${name} → lang="${lang}" dir="${dir}"`, async () => {
            const tag = htmlTag(await render(settings));
            expect(attr(tag, "lang")).toEqual([lang]);
            expect(attr(tag, "dir")).toEqual([dir]);
        });
    }

    it("reads the SITE's options — it is not a constant baked into the layout", async () => {
        // The regression this exists for: `lang="en"` hardcoded (which is what layout.tsx did before
        // this feature). Two different settings objects must produce two different documents.
        const english = htmlTag(await render({ WPLANG: "en_US" }));
        const arabic = htmlTag(await render({ WPLANG: "ar" }));
        expect(english).not.toEqual(arabic);
        expect(attr(english, "dir")).toEqual(["ltr"]);
        expect(attr(arabic, "dir")).toEqual(["rtl"]);
    });

    it("still emits both attributes when /settings is unreachable", async () => {
        // getSettings returns null on a fresh install or a backend hiccup. A document with no `dir`
        // is what this feature replaced; falling back must not fall back to THAT.
        const tag = htmlTag(await render(null));
        expect(attr(tag, "lang")).toEqual(["en"]);
        expect(attr(tag, "dir")).toEqual(["ltr"]);
    });
});

describe("a hostile option value cannot become markup", () => {
    // Every one of these is an attempt to stop being a value and start being structure: close the
    // attribute and open another, close the tag and open an element, or simply be enormous.
    const hostileLocales: unknown[] = [
        'en" dir="rtl',
        'en" onload="alert(1)',
        'en"><script>alert(1)</script>',
        "en' autofocus onfocus='x",
        'en"><style>*{display:none}</style>',
        "en US",
        "en\nUS",
        "javascript:alert(1)",
        "<img src=x onerror=alert(1)>",
        "a".repeat(5000),
        42,
        true,
        {},
        ["ar"],
    ];

    for (const value of hostileLocales) {
        it(`WPLANG ${JSON.stringify(value) ?? String(value)} renders as lang="en"`, async () => {
            const markup = await render({ WPLANG: value });
            const tag = htmlTag(markup);
            expect(attr(tag, "lang")).toEqual(["en"]);
            // A rejected locale cannot smuggle a direction either — the derived direction reads the
            // PARSED locale, and there isn't one.
            expect(attr(tag, "dir")).toEqual(["ltr"]);
            // Not merely escaped somewhere in the page: absent. The resolver rebuilds the tag from
            // matched subtags, so the attacker's string never exists as a string.
            if (typeof value === "string" && value.length < 200) {
                expect(markup).not.toContain(value);
            }
            expect(markup).not.toContain("<script>");
            expect(markup).not.toContain("onerror");
        });
    }

    const hostileDirections: unknown[] = [
        'rtl" lang="ar',
        'ltr" onmouseover="alert(1)',
        "rtl><script>alert(1)</script>",
        "inherit",
        "RTL",
        "rtl ",
        "ltr;",
        0,
        {},
        ["rtl"],
    ];

    for (const value of hostileDirections) {
        it(`site_text_direction ${JSON.stringify(value) ?? String(value)} falls back to the derived direction`, async () => {
            // Fail-closed here means falling back to DERIVING, so an RTL locale stays RTL: refusing a
            // bad override must not also break a correct site.
            const rtl = htmlTag(await render({ WPLANG: "ar", site_text_direction: value }));
            expect(attr(rtl, "dir")).toEqual(["rtl"]);
            const ltr = htmlTag(await render({ WPLANG: "en", site_text_direction: value }));
            expect(attr(ltr, "dir")).toEqual(["ltr"]);
            // The break-out attempts carry a second attribute name; it must not have become one.
            expect(attr(ltr, "lang")).toEqual(["en"]);
            expect(attr(ltr, "onmouseover")).toEqual([]);
        });
    }

    it("the opening tag always carries exactly one lang and one dir, from their closed sets", async () => {
        const dirs = new Set(["ltr", "rtl", "auto"]);
        for (const WPLANG of [...hostileLocales, "ar", "he_IL", "es_ES", "pa_Arab", "", null]) {
            for (const site_text_direction of [...hostileDirections, "ltr", "rtl", "auto", "", null]) {
                const tag = htmlTag(await render({ WPLANG, site_text_direction }));
                const lang = attr(tag, "lang");
                const dir = attr(tag, "dir");
                expect(lang, `lang for ${JSON.stringify(WPLANG)}`).toHaveLength(1);
                expect(dir, `dir for ${JSON.stringify(site_text_direction)}`).toHaveLength(1);
                // Letters, digits and hyphens only: nothing that can terminate an attribute or a tag.
                expect(lang[0]).toMatch(/^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|\d{3}))?$/);
                expect(dirs.has(dir[0]), `dir="${dir[0]}" is outside the enum`).toBe(true);
            }
        }
    });
});

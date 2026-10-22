/**
 * Form controls show their edge at rest (WCAG 1.4.11: 3:1 for a UI component's boundary — FALLOS 130).
 *
 * Every field of the admin rested on a decorative grey (border-gray-100/200/300, 1.1–1.5:1 on a white card),
 * the sign-in screens on gray-300, the public forms on --wjs-border-subtle: invisible until focused. The fix
 * lives in the base styles, not screen by screen; this pins the rules and computes the contrast of the
 * colours they use, so a later "softer" border cannot slip back under 3:1.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");
const REPO = resolve(SRC, "../..");
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

type RGB = [number, number, number];
const hex = (h: string): RGB => {
    const v = h.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as RGB;
};
const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** `color-mix(in srgb, fg P%, transparent)` painted over `bg`. */
const mixOver = (fg: RGB, pct: number, bg: RGB): RGB => fg.map((c, i) => c * pct + bg[i] * (1 - pct)) as RGB;

const WHITE = hex("#ffffff");
const GRAY_50 = hex("#f9fafb");
const GRAY_100 = hex("#f3f4f6");

/** The selector every rule targets: text-like inputs, selects and textareas, never at focus or when invalid. */
function expectRestingControlRule(css: string, colour: string) {
    const rule = stripComments(css).match(/:is\(\s*input:not\([^)]*\)[\s\S]*?\)\s*:not\(([^{]*)\)\s*\{\s*border-color:\s*([^;]+);/);
    expect(rule, "a resting border rule for form controls").not.toBeNull();
    const [, excluded, value] = rule!;
    for (const kept of [":focus", '[aria-invalid="true"]', '[class*=" border-transparent"]', '[class^="border-red-"]', '[class*=" border-red-"]']) {
        expect(excluded, `the rule must leave ${kept} alone`).toContain(kept);
    }
    // Only a RESTING colour class opts a field out: `[class*="border-amber-"]` also matched
    // `focus:border-amber-500` and left the Security Center's fields invisible.
    expect(excluded).not.toMatch(/\[class\*="border-/);
    expect(value.trim()).toBe(colour);
}

describe("form controls have a visible border at rest", () => {
    it("admin: every text control and the custom select's trigger, ≥3:1 on white, gray-50 and gray-100 cards", () => {
        const css = read(resolve(SRC, "app/admin/admin-globals.css"));
        expectRestingControlRule(css, "var(--wjs-admin-control-border)");
        expect(css).toContain("button[data-modern-select]:not([aria-expanded=\"true\"])");
        const token = stripComments(css).match(/--wjs-admin-control-border:\s*(#[0-9a-f]{6})/i)?.[1];
        expect(token).toBeTruthy();
        for (const bg of [WHITE, GRAY_50, GRAY_100]) expect(contrast(hex(token!), bg)).toBeGreaterThanOrEqual(3);
        // The admin stylesheet is unlayered: the rule must win over the Tailwind utilities that set the faint grey.
        expect(css).not.toMatch(/@layer/);
    });

    it("Verso: the editor's outline token, ≥3:1 in its light and dark palettes", () => {
        const css = read(resolve(SRC, "app/admin/admin-globals.css"));
        expect(css).toMatch(/:where\(\.verso-editor-ui, \.verso-container, \.verso-shell\)\s*\{\s*--wjs-admin-control-border:\s*var\(--ed-outline/);
        const editor = read(resolve(SRC, "components/editor-theme.css"));
        const outlines = [...editor.matchAll(/--ed-outline:\s*(#[0-9a-f]{6})/gi)].map((m) => hex(m[1]));
        const surfaces = [...editor.matchAll(/--ed-surface(?:-container-lowest)?:\s*(#[0-9a-f]{6})/gi)].map((m) => hex(m[1]));
        expect(outlines.length).toBeGreaterThanOrEqual(2);
        const [light, dark] = outlines;
        expect(contrast(light, WHITE)).toBeGreaterThanOrEqual(3);
        const darkSurface = surfaces.find((s) => lum(s) < 0.05)!;
        expect(contrast(dark, darkSurface)).toBeGreaterThanOrEqual(3);
    });

    it("system screens (sign-in, register, reset, verify, install, migration) get the same rule", () => {
        expectRestingControlRule(read(resolve(SRC, "app/globals.css")), "#7c8594");
        for (const file of ["app/_root/AuthScreen.tsx", "app/install/layout.tsx", "app/migration/layout.tsx"]) {
            expect(read(resolve(SRC, file)), file).toContain("data-wjs-system-screen");
        }
    });

    it("public site and plugin UI kit: no decorative token as a control's default edge; text colour at 60% instead", () => {
        const css = stripComments(read(resolve(REPO, "backend/public/css/wordjs-ui.css")));
        const formControl = css.match(/\.form-control,\n\.form-select,[\s\S]*?\{([\s\S]*?)\}/)![1];
        const formInput = css.match(/\.wjs-form-input,\n\.wjs-form-textarea,\n\.wjs-form-select \{([\s\S]*?)\}/)![1];
        for (const [name, body] of [[".form-control", formControl], [".wjs-form-input", formInput]] as const) {
            expect(body, name).not.toContain("--wjs-border-subtle");
            expect(body, name).toContain("color-mix(in srgb, currentColor 60%, transparent)");
        }
        // 60% of the default text colour reads at ≥3:1 over the default light surface…
        const text = hex(css.match(/--wjs-color-text-main:\s*(#[0-9a-f]{6})/i)![1]);
        expect(contrast(mixOver(text, 0.6, WHITE), WHITE)).toBeGreaterThanOrEqual(3);
        // …and, since it follows the text, over a dark section too (light text on near-black).
        const darkBg = hex("#0b1120");
        expect(contrast(mixOver(hex("#f8f9ff"), 0.6, darkBg), darkBg)).toBeGreaterThanOrEqual(3);
    });
});

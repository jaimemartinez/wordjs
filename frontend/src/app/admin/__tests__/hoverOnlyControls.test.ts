/**
 * NO ADMIN CONTROL IS REVEALED ONLY BY HOVERING.
 *
 * Tailwind v4 compiles `group-hover:` (and `hover:`) inside `@media (hover: hover)`. On a phone or a
 * tablet (`hover: none`) that reveal never matches, so an element styled
 * `opacity-0 group-hover:opacity-100` stays at opacity 0 for ever: invisible, yet still laid out and
 * still tappable. On the Users, Categories, Menus and Tokens screens that element was a DELETE (or
 * revoke) button, so a tap on an empty-looking corner of a row acted on it. A width-gated hide
 * (`md:opacity-0 md:group-hover:opacity-100`) fails the same way on a tablet, which is wider than `md`
 * and has no hover either.
 *
 * The rule: an interactive control is visible by default and hidden only where hover exists,
 *
 *     opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-within:opacity-100
 *
 * (`focus-visible:` / `group-focus-within:` serve as the keyboard reveal too). A decorative layer (an
 * overlay gradient, a hint arrow) may stay hover-only, and then it carries `pointer-events-none`, so
 * it can never swallow a tap meant for what lies under it.
 *
 * SCOPE: every .tsx under app/admin and components (the latter render inside the admin: the posts
 * table, the notification centre, the media picker, the editor's panels). A class list is
 *   · each `className` attribute, as the union of every string fragment in its expression (template
 *     literals, ternaries, cn(...) arguments), and
 *   · each string or template literal on its own (class constants defined outside JSX).
 * NOT COVERED: a class list assembled with `+` across separate literals in a constant. The one such
 * list today is the public site's ChromeNav submenu, which is also `invisible` (not tappable) while
 * hidden.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOTS = ["app/admin", "components"];

// The screens that shipped the bug; each keeps at least one hover-gated control.
const FIXED_SCREENS = [
    "app/admin/users/page.tsx",
    "app/admin/users/roles/page.tsx",
    "app/admin/categories/page.tsx",
    "app/admin/media/page.tsx",
    "app/admin/menus/page.tsx",
    "app/admin/tokens/page.tsx",
    "app/admin/plugins/page.tsx",
    "app/admin/settings/page.tsx",
    "app/admin/settings/backups/page.tsx",
    "components/ContentTable.tsx",
    "components/NotificationCenter.tsx",
    "components/verso/editor/PatternsPanel.tsx",
];

const WIDTH = String.raw`(?:(?:sm|md|lg|xl|2xl):)?`;
/** Hidden everywhere (or above a width), i.e. also where there is no hover. */
const HIDDEN = new RegExp(String.raw`^${WIDTH}opacity-0$`);
/** A reveal that only a hovering pointer can trigger. */
const HOVER_REVEAL = new RegExp(String.raw`^${WIDTH}(?:(?:group|peer)-hover(?:\/[\w-]+)?|hover):opacity-100$`);
/** Hidden only where hover exists: the gate an interactive control uses. */
const HOVER_GATED_HIDE = "[@media(hover:hover)]:opacity-0";
const FOCUS_REVEAL = /^(?:group-)?focus(?:-within|-visible)?(?:\/[\w-]+)?:opacity-100$/;

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full, out);
        } else if (entry.name.endsWith(".tsx") && !/\.test\.tsx$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/** The static text of a string or template literal; `${…}` holes become spaces. */
function literalText(node: ts.Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
    return null;
}

/** Every class list of a TSX source (see SCOPE above). */
function classLists(fileName: string, src: string): string[] {
    const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const lists: string[] = [];
    const visit = (node: ts.Node) => {
        const text = literalText(node);
        if (text !== null) lists.push(text);
        if (ts.isJsxAttribute(node) && node.name.getText(sf) === "className" && node.initializer) {
            const parts: string[] = [];
            const collect = (n: ts.Node) => {
                const t = literalText(n);
                if (t !== null) parts.push(t);
                n.forEachChild(collect);
            };
            collect(node.initializer);
            if (parts.length > 1) lists.push(parts.join(" "));
        }
        node.forEachChild(visit);
    };
    visit(sf);
    return lists;
}

const tokensOf = (list: string) => list.split(/\s+/).filter(Boolean);

/** A list that hides an element everywhere and reveals it only on hover, with no tap protection. */
function isHoverOnlyReveal(list: string): boolean {
    const tokens = tokensOf(list);
    return tokens.some((t) => HIDDEN.test(t))
        && tokens.some((t) => HOVER_REVEAL.test(t))
        && !tokens.includes("pointer-events-none");
}

const FILES = ROOTS.flatMap((root) => walk(path.join(SRC, root)));
const SCANNED = FILES.map((file) => ({
    rel: path.relative(SRC, file).split(path.sep).join("/"),
    lists: classLists(file, readFileSync(file, "utf8")),
}));

describe("the detector", () => {
    it("flags a hover-only reveal, including a width-gated one and one split across a className expression", () => {
        expect(isHoverOnlyReveal("flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity")).toBe(true);
        expect(isHoverOnlyReveal("opacity-100 md:opacity-0 md:group-hover:opacity-100")).toBe(true);
        expect(isHoverOnlyReveal("opacity-0 hover:opacity-100")).toBe(true);
        expect(isHoverOnlyReveal("opacity-0 group-hover/row:opacity-100")).toBe(true);
        const src = 'const A = () => <button className={cn("w-10 opacity-0", active && `group-hover:opacity-100 ${x}`)} />;';
        expect(classLists("a.tsx", src).some(isHoverOnlyReveal)).toBe(true);
    });

    it("passes the hover-gated pattern and a decorative layer that cannot take a tap", () => {
        expect(isHoverOnlyReveal("opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-within:opacity-100")).toBe(false);
        expect(isHoverOnlyReveal("absolute inset-0 opacity-0 group-hover:opacity-100 pointer-events-none")).toBe(false);
        expect(isHoverOnlyReveal("opacity-0 transition-opacity")).toBe(false);
    });
});

describe("admin controls on screens without hover", () => {
    it("the scan reaches the admin screens and the shared components", () => {
        expect(SCANNED.length).toBeGreaterThan(100);
        const scanned = new Set(SCANNED.map((f) => f.rel));
        for (const screen of FIXED_SCREENS) expect(scanned, screen).toContain(screen);
    });

    it("no control is revealed only by hovering: interactive ones are hover-gated, decorative ones take no taps", () => {
        const offenders = SCANNED.flatMap(({ rel, lists }) =>
            lists.filter(isHoverOnlyReveal).map((list) => `${rel}: ${list.trim().replace(/\s+/g, " ").slice(0, 140)}`));
        expect(offenders).toEqual([]);
    });

    it("a hover-gated control is visible by default and revealed on hover and on keyboard focus", () => {
        const gated = SCANNED.flatMap(({ rel, lists }) =>
            lists.filter((list) => tokensOf(list).includes(HOVER_GATED_HIDE)).map((list) => ({ rel, tokens: tokensOf(list) })));
        const broken = gated
            .filter(({ tokens }) => tokens.some((t) => HIDDEN.test(t))
                || !tokens.some((t) => HOVER_REVEAL.test(t))
                || !tokens.some((t) => FOCUS_REVEAL.test(t)))
            .map(({ rel, tokens }) => `${rel}: ${tokens.join(" ").slice(0, 140)}`);
        expect(broken).toEqual([]);
        const gatedScreens = new Set(gated.map((g) => g.rel));
        for (const screen of FIXED_SCREENS) expect(gatedScreens, screen).toContain(screen);
    });
});

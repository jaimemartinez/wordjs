import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { placeDropdown, DROPDOWN_COVER_GAP, DROPDOWN_EDGE, DROPDOWN_GAP, DROPDOWN_MAX_HEIGHT, type DropdownPlacementInput } from "../dropdownPlacement";
import { dropdownBounds, dropdownContext, type BoundsNode } from "../useDropdownPlacement";
import { OPTION_LABEL_CLASS, GROUP_HEADING_CLASS, EMPTY_LIST_CLASS, PLACEHOLDER_CLASS } from "@/components/ModernSelect";
import { AA, contrastOf, textClassOf } from "./helpers/tailwindContrast";

/**
 * A DROPDOWN LIST ALWAYS FITS THE VISIBLE VIEWPORT (ModernSelect, ui/Select) — AND IS WHOLE WHENEVER IT CAN BE.
 *
 * Live findings, «Nuevo usuario» dialog, role field with the plugin-roles group: on a desktop, scrolled
 * down, the list opened DOWNWARDS past the dialog and the bottom of the screen (the old rule only asked
 * for 180px below, then drew up to 260px with a 120px floor) — «ROLES DE PLUGINS» cut, the plugin role
 * out of reach. On a phone the upward list covered the field's label and the plugin option was cut to
 * «… plugin confe…». Round 2: on an iPhone SE the list was clamped and the plugin option cut at its edge;
 * on an iPhone 13 its top edge cut the dialog's subtitle in half.
 */

/** The box the list occupies on screen for a placement (the browser draws min(content, maxHeight)). */
function box(input: DropdownPlacementInput, content: number) {
    const p = placeDropdown({ ...input, contentHeight: content });
    const height = Math.min(content, p.maxHeight);
    const top = p.top !== undefined ? p.top : input.layoutHeight - (p.bottom as number) - height;
    return { p, top, bottom: top + height, height };
}

const DESKTOP = { viewportTop: 0, viewportHeight: 800, viewportLeft: 0, viewportWidth: 1280, layoutHeight: 800 };
// 5 core roles + 1 plugin role + 2 group headings, measured live: ~312px.
const ROLE_LIST = 312;

describe("placeDropdown", () => {
    it("opens below when the whole list fits there", () => {
        const trigger = { top: 200, bottom: 242, left: 300, width: 600 };
        const { p, top } = box({ ...DESKTOP, trigger, labelTop: 174 }, ROLE_LIST);
        expect(p.side).toBe("below");
        expect(top).toBe(242 + DROPDOWN_GAP);
        expect(p.maxHeight).toBe(DROPDOWN_MAX_HEIGHT);
        expect(p.scrollBy).toBe(0);
    });

    it("the desktop dialog case: 258px below is not enough — it opens ABOVE the label, whole, nothing cut", () => {
        // Shot 04: the role trigger at y 484-526 of an 800px window, its label at y 458.
        const input = { ...DESKTOP, trigger: { top: 484, bottom: 526, left: 337, width: 606 }, labelTop: 458 };
        const { p, top, bottom, height } = box(input, ROLE_LIST);
        expect(p.side).toBe("above-label");
        expect(height).toBe(ROLE_LIST); // every option visible, no inner scroll needed
        expect(bottom).toBeLessThanOrEqual(458 - DROPDOWN_GAP + 0.5); // the label stays readable
        expect(top).toBeGreaterThanOrEqual(DROPDOWN_EDGE);
    });

    it("the phone case: the list clears the field's label instead of covering it", () => {
        // iPhone 13 (390x844 css px): the role field at the bottom of the dialog.
        const phone = { viewportTop: 0, viewportHeight: 844, viewportLeft: 0, viewportWidth: 390, layoutHeight: 844 };
        const input = { ...phone, trigger: { top: 690, bottom: 732, left: 49, width: 292 }, labelTop: 660 };
        const { p, bottom, top } = box(input, ROLE_LIST + 48); // wrapped plugin label: one more line
        expect(p.side).toBe("above-label");
        expect(bottom).toBeLessThanOrEqual(660);
        expect(top).toBeGreaterThanOrEqual(DROPDOWN_EDGE);
    });

    it("when it fits nowhere whole, it takes the roomier side and SCROLLS inside — never past the screen", () => {
        const input = { ...DESKTOP, viewportHeight: 300, layoutHeight: 300, trigger: { top: 120, bottom: 160, left: 10, width: 200 }, labelTop: 96 };
        const { p, top, bottom } = box(input, 900);
        expect(p.side).toBe("below"); // 124px below vs 80px above the label (and 110px over it: not enough either)
        expect(p.maxHeight).toBe(300 - DROPDOWN_EDGE - 160 - DROPDOWN_GAP);
        expect(top).toBeGreaterThanOrEqual(DROPDOWN_EDGE);
        expect(bottom).toBeLessThanOrEqual(300 - DROPDOWN_EDGE);
    });

    it("no 120px floor any more: a field near the bottom edge gets only the room there is", () => {
        const input = { ...DESKTOP, viewportHeight: 200, layoutHeight: 200, trigger: { top: 70, bottom: 110, left: 0, width: 100 } };
        const { bottom, top } = box(input, 500);
        expect(top).toBeGreaterThanOrEqual(DROPDOWN_EDGE);
        expect(bottom).toBeLessThanOrEqual(200 - DROPDOWN_EDGE);
    });

    it("measures against the VISIBLE viewport (on-screen keyboard / pinch-zoom), not the layout one", () => {
        // The keyboard leaves 400px visible at the top of an 844px layout viewport.
        const input = { viewportTop: 0, viewportHeight: 400, viewportLeft: 0, viewportWidth: 390, layoutHeight: 844, trigger: { top: 300, bottom: 340, left: 20, width: 350 } };
        const { p, top, bottom } = box(input, 200);
        expect(p.side).toBe("above");
        expect(bottom).toBeLessThanOrEqual(400 - DROPDOWN_EDGE);
        expect(top).toBeGreaterThanOrEqual(DROPDOWN_EDGE);
    });

    it("keeps the list inside the viewport horizontally", () => {
        const p = placeDropdown({ ...DESKTOP, viewportWidth: 390, trigger: { top: 100, bottom: 140, left: 300, width: 300 }, contentHeight: 100 });
        expect(p.left + p.width).toBeLessThanOrEqual(390 - DROPDOWN_EDGE);
        expect(p.left).toBeGreaterThanOrEqual(DROPDOWN_EDGE);
    });

    // Round 1, iPhone SE (375x667), «Nuevo usuario» scrolled to the bottom: the role list (331px) did not fit
    // above the label, so it was drawn above the FIELD, ending at the label's foot — a sliver of the «Rol»
    // label showed under the list's rounded corner. Round 2: forbidden to cover the label, the list was
    // CLAMPED to 300px above it and its last option («Equipo de conferencia · plugin conference-manager») was
    // cut at the list's edge. A whole list beside the field comes first; over the label only when that is
    // the one way to show it whole, and then over ALL of it.
    const SE = { viewportTop: 0, viewportHeight: 667, viewportLeft: 0, viewportWidth: 375, layoutHeight: 667 };
    const SE_FIELD = { trigger: { top: 357, bottom: 400, left: 49, width: 276 }, labelTop: 331 };

    it("a labelled field's list never covers PART of its label: beside it, or over all of it when only that shows it whole", () => {
        const { p, top, bottom, height } = box({ ...SE, ...SE_FIELD }, 331);
        expect(p.side).toBe("over-label"); // 251px below, 315px above the label: neither holds 331px
        expect(height).toBe(331); // whole: no option cut
        expect(bottom).toBe(357 - DROPDOWN_COVER_GAP); // ends just above the trigger...
        expect(top).toBeLessThanOrEqual(331); // ...and starts above the label: no sliver of it shows
        expect(top).toBeGreaterThanOrEqual(DROPDOWN_EDGE);
        // With room beside the field, the label is never covered.
        expect(box({ ...SE, ...SE_FIELD }, 300).p.side).toBe("above-label");
        expect(box({ ...SE, ...SE_FIELD }, 250).p.side).toBe("below");
    });

    it("a list that fits nowhere whole is clamped beside the field, clear of the label", () => {
        const { p, bottom } = box({ ...SE, ...SE_FIELD }, 600);
        expect(p.side).toBe("above-label");
        expect(bottom).toBeLessThanOrEqual(331 - DROPDOWN_GAP + 0.5);
        expect(p.maxHeight).toBe(331 - DROPDOWN_GAP - DROPDOWN_EDGE);
    });

    // Round 2, measured live (iPhone SE, «Nuevo usuario» scrolled to the bottom): label at 316, trigger
    // 344-387, the list's natural height 332, the dialog card 33-633, its scrolling body 150-528 (scrolled to
    // its end, 400px down). The body is too short for field + list, and so is the screen beside the field.
    const SE_LIVE = {
        ...SE, trigger: { top: 344, bottom: 387, left: 49, width: 276 }, labelTop: 316,
        bounds: { top: 150, bottom: 528 }, card: { top: 33, bottom: 633 }, scroll: { top: 400, max: 400 },
    };
    const SE_LIST = 332;

    it("the SE dialog case: the body scrolls a little and the WHOLE list fits in the dialog card, above the label", () => {
        const { p, top, bottom, height } = box(SE_LIVE, SE_LIST);
        expect(p.side).toBe("above-label");
        expect(height).toBe(SE_LIST); // every option whole — «… plugin conference-manager» included
        expect(p.scrollBy).toBe(-65); // the field moves down 65px...
        const labelAfter = 316 - p.scrollBy, triggerBottomAfter = 387 - p.scrollBy;
        expect(bottom).toBeLessThanOrEqual(labelAfter - DROPDOWN_GAP + 0.5); // ...its label stays readable...
        expect(triggerBottomAfter).toBeLessThanOrEqual(SE_LIVE.bounds.bottom); // ...the field stays in the body...
        expect(top).toBeGreaterThanOrEqual(SE_LIVE.card.top + DROPDOWN_EDGE); // ...and the list does not stick out of the dialog
    });

    it("the SE dialog case without the scroll: still whole (over the label), never clamped with an option cut", () => {
        const { p, height } = box({ ...SE_LIVE, scroll: null }, SE_LIST);
        expect(height).toBe(SE_LIST);
        expect(p.scrollBy).toBe(0);
        expect(p.side).toBe("over-label");
    });

    // Round 2, measured live (iPhone 13, 390x844): the list rose above the dialog body and its top edge
    // (y 145) cut the dialog subtitle's second line «…USUARIO» in half.
    const I13_LIVE = {
        viewportTop: 0, viewportHeight: 844, viewportLeft: 0, viewportWidth: 390, layoutHeight: 844,
        trigger: { top: 513, bottom: 556, left: 49, width: 292 }, labelTop: 489,
        bounds: { top: 146, bottom: 697 }, card: { top: 42, bottom: 802 }, scroll: { top: 300, max: 300 },
    };
    const I13_LIST = 332; // the list measured in that shot: y 145 to 477

    it("the iPhone 13 dialog case: the body scrolls a little and the whole list stays INSIDE the body (under the subtitle)", () => {
        const { p, top, bottom, height } = box(I13_LIVE, I13_LIST);
        expect(p.side).toBe("above-label");
        expect(height).toBe(I13_LIST);
        expect(top).toBeGreaterThanOrEqual(I13_LIVE.bounds.top + DROPDOWN_EDGE); // the dialog's header is not touched
        expect(p.scrollBy).toBe(-5); // 489 − 8 − 332 − (146 + 8): five pixels
        expect(bottom).toBeLessThanOrEqual(489 - p.scrollBy - DROPDOWN_GAP + 0.5);
        expect(556 - p.scrollBy).toBeLessThanOrEqual(I13_LIVE.bounds.bottom);
    });

    it("scrolls the body only as far as it can, only once the list's height is known, and only in a dialog", () => {
        // A body that cannot scroll moves nothing: the card (over the header) is used, the list still whole.
        const stuck = box({ ...I13_LIVE, scroll: { top: 0, max: 0 } }, I13_LIST);
        expect(stuck.p.scrollBy).toBe(0);
        expect(stuck.height).toBe(I13_LIST);
        expect(stuck.top).toBeGreaterThanOrEqual(I13_LIVE.card.top + DROPDOWN_EDGE);
        // At the top of its scroll the field can only move UP: the list then fits under it.
        const atTop = box({ ...I13_LIVE, scroll: { top: 0, max: 300 } }, I13_LIST);
        expect(atTop.p.side).toBe("below");
        expect(atTop.p.scrollBy).toBe(556 + DROPDOWN_GAP + I13_LIST - (697 - DROPDOWN_EDGE));
        // Before the list has rendered (no height yet) nothing scrolls.
        expect(placeDropdown({ ...I13_LIVE, contentHeight: null }).scrollBy).toBe(0);
        // Outside a dialog (no body) nothing scrolls either.
        expect(box({ ...I13_LIVE, bounds: null, card: null }, I13_LIST).p.scrollBy).toBe(0);
        // A list that already fits in the body moves nothing.
        expect(box(I13_LIVE, 200).p.scrollBy).toBe(0);
    });

    it("may scroll the body the other way: the field moves up so the list fits under it", () => {
        const input = { ...I13_LIVE, trigger: { top: 400, bottom: 443, left: 49, width: 292 }, labelTop: 376, scroll: { top: 0, max: 500 } };
        const { p, top, bottom } = box(input, 300);
        // Above the label 376-8-154 = 214 < 300; below 689-451 = 238 < 300: 62px of scroll make it fit below.
        expect(p.side).toBe("below");
        expect(p.scrollBy).toBe(443 + DROPDOWN_GAP + 300 - (697 - DROPDOWN_EDGE));
        expect(top).toBe(443 - p.scrollBy + DROPDOWN_GAP);
        expect(bottom).toBeLessThanOrEqual(697 - DROPDOWN_EDGE);
        expect(376 - p.scrollBy).toBeGreaterThanOrEqual(input.bounds.top); // the field stays in the body
    });

    it("in a dialog, a list that fits whole on the screen is still shown whole (the desktop case)", () => {
        const input = { ...DESKTOP, trigger: { top: 484, bottom: 526, left: 337, width: 606 }, labelTop: 458, bounds: { top: 150, bottom: 670 } };
        const { p, height, bottom } = box(input, ROLE_LIST);
        expect(p.side).toBe("above-label");
        expect(height).toBe(ROLE_LIST);
        expect(bottom).toBeLessThanOrEqual(458 - DROPDOWN_GAP + 0.5);
        // ...and inside the body when 20px of scroll allow it, instead of over the dialog's header.
        const scrolled = box({ ...input, scroll: { top: 200, max: 200 } }, ROLE_LIST);
        expect(scrolled.p.scrollBy).toBe(-20);
        expect(scrolled.top).toBeGreaterThanOrEqual(150 + DROPDOWN_EDGE);
    });

    it("in a dialog, a list that fits whole in the body stays in the body", () => {
        const input = { ...DESKTOP, trigger: { top: 200, bottom: 242, left: 0, width: 300 }, labelTop: 174, bounds: { top: 150, bottom: 670 } };
        const { p, bottom } = box(input, 200);
        expect(p.side).toBe("below");
        expect(bottom).toBeLessThanOrEqual(670 - DROPDOWN_EDGE);
    });

    it("a cramped dialog body (under the minimum) does not shrink the list: the screen is used", () => {
        const input = { ...SE, ...SE_FIELD, bounds: { top: 300, bottom: 420 } };
        const { height } = box(input, 331);
        expect(height).toBeGreaterThan(420 - 300);
    });

    it("a clamped list in a dialog stays in the body when the body leaves enough room", () => {
        const input = { ...DESKTOP, viewportHeight: 500, layoutHeight: 500, trigger: { top: 300, bottom: 340, left: 0, width: 300 }, labelTop: 276, bounds: { top: 60, bottom: 460 } };
        const { p, top } = box(input, 900);
        expect(p.side).toBe("above-label");
        expect(top).toBeGreaterThanOrEqual(60 + DROPDOWN_EDGE);
        expect(p.maxHeight).toBe(276 - DROPDOWN_GAP - (60 + DROPDOWN_EDGE));
    });

    it("invariant: for any field on screen and any list, the list is drawn inside the visible viewport — whole whenever it could be", () => {
        let seed = 7;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        for (let n = 0; n < 3000; n++) {
            const vh = 200 + Math.floor(rnd() * 900);
            const vTop = Math.floor(rnd() * 40);
            const tTop = vTop + Math.floor(rnd() * (vh - 44));
            const withLabel = rnd() < 0.5;
            const input = {
                viewportTop: vTop, viewportHeight: vh, viewportLeft: 0, viewportWidth: 800, layoutHeight: vh + vTop + Math.floor(rnd() * 300),
                trigger: { top: tTop, bottom: tTop + 40, left: 20, width: 300 },
                labelTop: withLabel ? tTop - 28 : null,
            };
            const content = 40 + Math.floor(rnd() * 900);
            const bTop = vTop + Math.floor(rnd() * vh * 0.4);
            const bounds = rnd() < 0.5 ? { top: bTop, bottom: bTop + Math.floor(rnd() * vh) } : null;
            const card = bounds && rnd() < 0.7 ? { top: bounds.top - Math.floor(rnd() * 100), bottom: bounds.bottom + Math.floor(rnd() * 100) } : null;
            const scroll = bounds && rnd() < 0.6 ? { top: Math.floor(rnd() * 400), max: 400 + Math.floor(rnd() * 400) } : null;
            const { p, top, bottom, height } = box({ ...input, bounds, card, scroll }, content);
            const s = p.scrollBy;
            expect(top).toBeGreaterThanOrEqual(vTop + DROPDOWN_EDGE - 1);
            expect(bottom).toBeLessThanOrEqual(vTop + vh - DROPDOWN_EDGE + 1);
            const want = Math.min(content, DROPDOWN_MAX_HEIGHT);
            if (s !== 0) {
                // A scroll only within the body's range, the field still in the body afterwards, and only to
                // show the list whole.
                expect(scroll).toBeTruthy();
                expect(s).toBeGreaterThanOrEqual(-scroll!.top);
                expect(s).toBeLessThanOrEqual(scroll!.max - scroll!.top);
                expect((input.labelTop ?? tTop) - s).toBeGreaterThanOrEqual(Math.max(vTop, bounds!.top) - 1);
                expect(tTop + 40 - s).toBeLessThanOrEqual(Math.min(vTop + vh, bounds!.bottom) + 1);
                expect(height).toBe(want);
            }
            // Whole whenever the screen has room for it beside the field, or over its label.
            const roomBelow = vTop + vh - DROPDOWN_EDGE - (tTop + 40 + DROPDOWN_GAP);
            const roomAbove = (withLabel ? tTop - DROPDOWN_COVER_GAP : tTop - DROPDOWN_GAP) - (vTop + DROPDOWN_EDGE);
            if (roomBelow >= want || roomAbove >= want) expect(height).toBe(want);
            // ...and never over PART of its own label.
            if (withLabel) {
                const labelAfter = (input.labelTop as number) - s;
                expect(p.side).not.toBe("above");
                if (p.side === "above-label") expect(bottom).toBeLessThanOrEqual(labelAfter - DROPDOWN_GAP + 1);
                if (p.side === "over-label") {
                    expect(height).toBe(want);
                    expect(top).toBeLessThanOrEqual(labelAfter);
                    expect(bottom).toBeGreaterThanOrEqual(tTop - s - DROPDOWN_COVER_GAP - 1);
                }
            } else {
                expect(p.side).not.toBe("over-label");
            }
        }
    });
});

describe("dropdownContext: the dialog a list stays in", () => {
    type Fake = BoundsNode & { overflowY: string };
    const node = (parent: Fake | null, opts: { layer?: boolean; overflowY?: string; top?: number; bottom?: number } = {}): Fake => ({
        parentElement: parent,
        overflowY: opts.overflowY ?? "visible",
        hasAttribute: (name: string) => !!opts.layer && name === "data-wjs-dialog-layer",
        getBoundingClientRect: () => ({ top: opts.top ?? 0, bottom: opts.bottom ?? 0 }),
    });
    const overflowOf = (n: BoundsNode) => (n as Fake).overflowY;

    it("inside a dialog: the nearest ancestor that scrolls vertically, and the dialog's card", () => {
        const layer = node(null, { layer: true, top: 0, bottom: 667 });
        const card = node(layer, { overflowY: "hidden", top: 33, bottom: 634 });
        const body = node(card, { overflowY: "auto", top: 130, bottom: 540 });
        const field = node(node(body));
        expect(dropdownBounds(field, overflowOf)).toEqual({ top: 130, bottom: 540 });
        const ctx = dropdownContext(field, overflowOf)!;
        expect(ctx.bounds).toEqual({ top: 130, bottom: 540 });
        expect(ctx.card).toEqual({ top: 33, bottom: 634 });
        expect(ctx.scroller).toBe(body);
    });
    it("inside a dialog with no scrolling body: the dialog's card, nothing to scroll", () => {
        const layer = node(null, { layer: true, top: 0, bottom: 667 });
        const card = node(layer, { overflowY: "hidden", top: 33, bottom: 634 });
        expect(dropdownBounds(node(node(card)), overflowOf)).toEqual({ top: 33, bottom: 634 });
        expect(dropdownContext(node(node(card)), overflowOf)!.scroller).toBeNull();
    });
    it("outside a dialog: nothing (a page keeps the whole viewport and is never scrolled by a list)", () => {
        const main = node(null, { overflowY: "auto", top: 64, bottom: 800 });
        expect(dropdownBounds(node(node(main)), overflowOf)).toBeNull();
        expect(dropdownContext(node(node(main)), overflowOf)).toBeNull();
        expect(dropdownBounds(null, overflowOf)).toBeNull();
    });
    it("the hook passes the body, the card and — only when it may scroll — the body's scroll to the placement, and applies scrollBy", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../useDropdownPlacement.ts"), "utf8");
        expect(src).toMatch(/const ctx = dropdownContext\(el as unknown as BoundsNode\);/);
        expect(src).toMatch(/bounds: ctx\?\.bounds \?\? null,/);
        expect(src).toMatch(/card: ctx\?\.card \?\? null,/);
        expect(src).toMatch(/const scroller = mayScroll && ctx\?\.scroller/);
        expect(src).toMatch(/scroll: scroller \? \{ top: scroller\.scrollTop, max: scroller\.scrollHeight - scroller\.clientHeight \} : null,/);
        expect(src).toMatch(/if \(scroller && next\.scrollBy\) scroller\.scrollTop \+= next\.scrollBy;/);
        // Only the measured placement right after the list renders may scroll; the listeners never do.
        expect(src).toMatch(/const update = useCallback\(\(\) => place\(false\), \[place\]\);/);
        expect(src).toMatch(/if \(isOpen && placed\) place\(true\);/);
        expect((src.match(/place\(true\)/g) || []).length).toBe(1);
    });
});

describe("both portalled selects use it", () => {
    it("the select (ui/Select; ModernSelect is a shim over it) places its list through useDropdownPlacement, not its own arithmetic", () => {
        expect(fs.readFileSync(path.resolve(__dirname, "../../components/ModernSelect.tsx"), "utf8")).toContain('from "./ui/Select"');
        for (const file of ["../../components/ui/Select.tsx"]) {
            const src = fs.readFileSync(path.resolve(__dirname, file), "utf8");
            expect(src, file).toMatch(/useDropdownPlacement\(isOpen,/);
            expect(src, file).not.toMatch(/window\.innerHeight/);
            expect(src, file).toMatch(/zIndex: ADMIN_Z\.popover/);
        }
    });

    it("a ModernSelect option label wraps instead of being truncated", () => {
        const tokens = OPTION_LABEL_CLASS.split(/\s+/);
        expect(tokens).toEqual(expect.arrayContaining(["whitespace-normal", "break-words", "min-w-0"]));
        expect(tokens).not.toContain("truncate");
        const src = fs.readFileSync(path.resolve(__dirname, "../../components/ui/Select.tsx"), "utf8");
        expect(src).toMatch(/<span className=\{OPTION_LABEL_CLASS\}>\s*\{opt\.label\}/);
    });

    // Live finding: the group headings «ROLES DEL SISTEMA» / «ROLES DE PLUGINS» of the role dropdown were
    // gray-400 on the menu's white, ~2.5:1. The menu is bg-white/95 with a backdrop blur, so the worst
    // case behind it is black (a dialog's scrim over the dark sidebar): AA must hold there too.
    it("ModernSelect group headings meet AA on the menu even over a black backdrop (gray-500 would not)", () => {
        const text = textClassOf(GROUP_HEADING_CLASS);
        expect(contrastOf(text, "white")).toBeGreaterThanOrEqual(AA);
        expect(contrastOf(text, "black", "white/95")).toBeGreaterThanOrEqual(AA);
        expect(contrastOf("text-gray-500", "black", "white/95")).toBeLessThan(AA); // why gray-600 and not gray-500
        const src = fs.readFileSync(path.resolve(__dirname, "../../components/ui/Select.tsx"), "utf8");
        expect(src).toContain('<div role="presentation" className={GROUP_HEADING_CLASS} data-option-group="">');
        // the surface the heading is measured on (a template literal: inside the Verso editor the menu
        // also joins the editor's palette, components/editor-theme.css)
        expect(src).toMatch(/className=\{?[`"]bg-white\/95 backdrop-blur-xl/);
    });

    it("ModernSelect's empty-list line (same menu surface) and the trigger's placeholder meet AA", () => {
        expect(contrastOf(textClassOf(EMPTY_LIST_CLASS), "black", "white/95")).toBeGreaterThanOrEqual(AA);
        expect(contrastOf(textClassOf(PLACEHOLDER_CLASS), "gray-50")).toBeGreaterThanOrEqual(AA);
        const src = fs.readFileSync(path.resolve(__dirname, "../../components/ui/Select.tsx"), "utf8");
        expect(src).toContain("<div className={EMPTY_LIST_CLASS}>");
        expect(src).toContain('!selectedOption ? PLACEHOLDER_CLASS : ""');
        expect(src).not.toMatch(/text-gray-400 (?:italic|break-words)|['"]text-gray-400['"]/);
    });
});

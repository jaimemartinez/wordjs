import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * SEARCHABLE SELECT: SCROLLING THE LIST MUST NOT JUMP (components/ui/Select.tsx).
 *
 * Live finding: in a long searchable select the option list jumped up and down under the wheel or a finger.
 * Hovering a row highlights it, and the highlight effect scrolled the highlighted row into view. While the
 * list scrolls under a still pointer, each row that passes under it fires mouseenter, so every scroll step
 * re-highlighted a row and scrolled back to it.
 *
 * The highlight is revealed only on open and on the arrow keys; hovering still highlights, but never scrolls.
 * No DOM test environment in this project, so the contract is pinned on the source.
 */

const src = fs.readFileSync(path.join(__dirname, "..", "ui", "Select.tsx"), "utf8");

describe("Select — hover never scrolls the list", () => {
    it("the scroll-into-view effect runs only when a reveal was asked for, and consumes it", () => {
        const effect = src.match(/useEffect\(\(\) => \{\s*if \(!isOpen \|\| !revealHighlight\.current\) return;\s*revealHighlight\.current = false;[\s\S]*?scrollIntoView/);
        expect(effect, "scrollIntoView must be gated on revealHighlight").not.toBeNull();
        expect(src.match(/scrollIntoView/g)?.length).toBe(1);
    });

    it("opening and the arrow keys ask for a reveal", () => {
        expect(src).toMatch(/revealHighlight\.current = true;\s*setHighlight\(idx >= 0 \? idx : 0\)/);
        expect(src).toMatch(/"ArrowDown"\) \{ e\.preventDefault\(\); revealHighlight\.current = true; setHighlight/);
        expect(src).toMatch(/"ArrowUp"\) \{ e\.preventDefault\(\); revealHighlight\.current = true; setHighlight/);
    });

    it("a new options array (a parent re-rendering mid-scroll) does not reset or reveal the highlight", () => {
        expect(src).toMatch(/if \(highlightKey\.current === key\) return;\s*highlightKey\.current = key;[\s\S]*?revealHighlight\.current = true;\s*setHighlight\(idx >= 0 \? idx : 0\)/);
        expect(src).toMatch(/const key = `\$\{value \?\? ""\}\u0000\$\{query\}`;/);
    });

    it("hovering a row highlights it without asking for a reveal", () => {
        const hover = src.match(/onMouseEnter=\{[^\n]*\}/);
        expect(hover?.[0]).toContain("setHighlight(i)");
        expect(hover?.[0]).not.toContain("revealHighlight");
    });

    it("the list keeps its scroll to itself", () => {
        expect(src).toMatch(/ref=\{listRef\}[^>]*overflow-y-auto overscroll-contain/);
    });
});

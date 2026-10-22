/**
 * Which blocks are dimmed while a text is edited in place (FALLOS 128): every block except the edited
 * one and the ones that contain it — a container's opacity is applied to the text written inside it.
 */
import { describe, expect, it } from "vitest";
import { ROOT_ID, type VersoNode } from "@/lib/verso/types";
import { INLINE_PATH_ATTR, INLINE_PATH_CSS, dimmedWhileEditing, inlineEditRole } from "../inlineDim";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const node = (id: string, parentId: string): VersoNode =>
    ({ id, type: "X", props: { id }, slots: {}, parentId, slotKey: "children", index: 0 }) as VersoNode;

// sec > col > heading ; sec > other ; top (root level)
const nodes: Record<string, VersoNode> = {
    sec: node("sec", ROOT_ID),
    col: node("col", "sec"),
    heading: node("heading", "col"),
    other: node("other", "sec"),
    top: node("top", ROOT_ID),
};

describe("dimmedWhileEditing", () => {
    it("nothing is dimmed when no text is being edited", () => {
        for (const id of Object.keys(nodes)) expect(dimmedWhileEditing(nodes, id, null)).toBe(false);
    });

    it("the edited block and every block containing it stay at full opacity", () => {
        for (const id of ["heading", "col", "sec"]) expect(dimmedWhileEditing(nodes, id, "heading"), id).toBe(false);
    });

    it("siblings, cousins and other root blocks are dimmed", () => {
        for (const id of ["other", "top"]) expect(dimmedWhileEditing(nodes, id, "heading"), id).toBe(true);
    });

    it("a block inside the edited one is dimmed (it is not the text being written)", () => {
        expect(dimmedWhileEditing(nodes, "col", "sec")).toBe(true);
    });

    it("a missing or cyclic parent chain ends instead of looping", () => {
        const cyclic: Record<string, VersoNode> = { a: node("a", "b"), b: node("b", "a") };
        expect(dimmedWhileEditing(cyclic, "z", "a")).toBe(true);
        expect(dimmedWhileEditing(nodes, "sec", "gone")).toBe(true);
        expect(dimmedWhileEditing(nodes, "constructor", "heading")).toBe(true);
    });
});

describe("the inline path stops its own animations (canvas CSS)", () => {
    it("the edited block and its containers are the path; the rest is dimmed; nothing when idle", () => {
        expect(inlineEditRole(nodes, "heading", "heading")).toBe("path");
        expect(inlineEditRole(nodes, "sec", "heading")).toBe("path");
        expect(inlineEditRole(nodes, "other", "heading")).toBe("dimmed");
        expect(inlineEditRole(nodes, "heading", null)).toBe("idle");
    });

    it("the rule shows the resting state of the path's interaction and entrance layers, at full opacity", () => {
        expect(INLINE_PATH_CSS).toContain(`[${INLINE_PATH_ATTR}] > [data-wjs-ix-on]`);
        expect(INLINE_PATH_CSS).toContain(`[${INLINE_PATH_ATTR}] > [data-wjs-anim]`);
        for (const decl of ["animation:none!important", "opacity:1!important", "transform:none!important", "filter:none!important"]) {
            expect(INLINE_PATH_CSS).toContain(decl);
        }
    });

    it("the canvas engine always writes it into the frame, with or without interactions on the page", () => {
        const engine = readFileSync(resolve(__dirname, "../../canvas/IxCanvasEngine.tsx"), "utf8");
        expect(engine).toContain('const css = page.css === "" ? INLINE_PATH_CSS : `${page.css}\\n${INLINE_PATH_CSS}`;');
    });
});

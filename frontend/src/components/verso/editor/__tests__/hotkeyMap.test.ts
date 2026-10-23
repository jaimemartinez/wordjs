/**
 * F3 — mapa de atajos del VersoEditor (paridad W03 núcleo con EditorHotkeys del wrapper actual).
 */
import { describe, expect, it } from "vitest";
import { bypassesTypingGuard, hotkeyActionOf, yieldsToInlineText } from "../hotkeyMap";

const ev = (key: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {}) => ({
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
});

describe("hotkeyActionOf", () => {
    it("Ctrl/Cmd+S → save · Ctrl/Cmd+K → palette", () => {
        expect(hotkeyActionOf(ev("s", { ctrl: true }))).toBe("save");
        expect(hotkeyActionOf(ev("S", { meta: true }))).toBe("save");
        expect(hotkeyActionOf(ev("k", { ctrl: true }))).toBe("palette");
        expect(hotkeyActionOf(ev("k", { meta: true }))).toBe("palette");
    });

    it("undo/redo: Ctrl+Z · Ctrl+Shift+Z · Ctrl+Y", () => {
        expect(hotkeyActionOf(ev("z", { ctrl: true }))).toBe("undo");
        expect(hotkeyActionOf(ev("Z", { meta: true, shift: true }))).toBe("redo");
        expect(hotkeyActionOf(ev("y", { ctrl: true }))).toBe("redo");
    });

    it("Supr y Retroceso → delete (Mac no tiene Supr) · Ctrl+D → duplicate", () => {
        expect(hotkeyActionOf(ev("Delete"))).toBe("delete");
        expect(hotkeyActionOf(ev("Backspace"))).toBe("delete");
        expect(hotkeyActionOf(ev("Backspace", { meta: true }))).toBe(null);
        expect(hotkeyActionOf(ev("d", { ctrl: true }))).toBe("duplicate");
        expect(hotkeyActionOf(ev("d", { meta: true }))).toBe("duplicate");
    });

    it("Ctrl+C → copy · Ctrl+V → paste (clipboard de bloques, W03 completo)", () => {
        expect(hotkeyActionOf(ev("c", { ctrl: true }))).toBe("copy");
        expect(hotkeyActionOf(ev("C", { meta: true }))).toBe("copy");
        expect(hotkeyActionOf(ev("v", { ctrl: true }))).toBe("paste");
        expect(hotkeyActionOf(ev("V", { meta: true }))).toBe("paste");
    });

    it("Escape → escape · ? → shortcuts", () => {
        expect(hotkeyActionOf(ev("Escape"))).toBe("escape");
        expect(hotkeyActionOf(ev("?", { shift: true }))).toBe("shortcuts");
        expect(hotkeyActionOf(ev("?", { ctrl: true, shift: true }))).toBe(null);
    });

    it("no-atajos → null (letras solas)", () => {
        expect(hotkeyActionOf(ev("s"))).toBe(null);
        expect(hotkeyActionOf(ev("c"))).toBe(null);
        expect(hotkeyActionOf(ev("v"))).toBe(null);
        expect(hotkeyActionOf(ev("d"))).toBe(null);
    });

    it("save/palette saltan el guard de escritura; el resto no", () => {
        expect(bypassesTypingGuard("save")).toBe(true);
        expect(bypassesTypingGuard("palette")).toBe(true);
        expect(bypassesTypingGuard("undo")).toBe(false);
        expect(bypassesTypingGuard("redo")).toBe(false);
        expect(bypassesTypingGuard("delete")).toBe(false);
        expect(bypassesTypingGuard("duplicate")).toBe(false);
        expect(bypassesTypingGuard("copy")).toBe(false);
        expect(bypassesTypingGuard("paste")).toBe(false);
        expect(bypassesTypingGuard("escape")).toBe(false);
        expect(bypassesTypingGuard("shortcuts")).toBe(false);
    });
});

describe("yieldsToInlineText — Ctrl/⌘+K inside a text being edited is the link (FALLOS 140)", () => {
    it("lets the text surface have Ctrl+K while inline editing owns the focus", () => {
        expect(yieldsToInlineText("palette", true, true)).toBe(true);
    });
    it("still opens the palette from anywhere else", () => {
        expect(yieldsToInlineText("palette", false, false)).toBe(false);
        expect(yieldsToInlineText("palette", true, false)).toBe(false); // an inspector field
        expect(yieldsToInlineText("palette", false, true)).toBe(false);
    });
    it("only concerns the palette: Ctrl+S still saves while editing text", () => {
        expect(yieldsToInlineText("save", true, true)).toBe(false);
    });
});

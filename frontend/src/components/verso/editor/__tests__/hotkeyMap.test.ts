/**
 * F3 — mapa de atajos del VersoEditor (paridad W03 núcleo con EditorHotkeys del wrapper actual).
 */
import { describe, expect, it } from "vitest";
import { bypassesTypingGuard, hotkeyActionOf } from "../hotkeyMap";

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

    it("Supr → delete · Ctrl+D → duplicate", () => {
        expect(hotkeyActionOf(ev("Delete"))).toBe("delete");
        expect(hotkeyActionOf(ev("d", { ctrl: true }))).toBe("duplicate");
        expect(hotkeyActionOf(ev("d", { meta: true }))).toBe("duplicate");
    });

    it("no-atajos → null (letras solas, Backspace, Ctrl+C/V que son de otra capa)", () => {
        expect(hotkeyActionOf(ev("s"))).toBe(null);
        expect(hotkeyActionOf(ev("Backspace"))).toBe(null);
        expect(hotkeyActionOf(ev("c", { ctrl: true }))).toBe(null);
        expect(hotkeyActionOf(ev("v", { ctrl: true }))).toBe(null);
        expect(hotkeyActionOf(ev("d"))).toBe(null);
    });

    it("save/palette saltan el guard de escritura; el resto no", () => {
        expect(bypassesTypingGuard("save")).toBe(true);
        expect(bypassesTypingGuard("palette")).toBe(true);
        expect(bypassesTypingGuard("undo")).toBe(false);
        expect(bypassesTypingGuard("redo")).toBe(false);
        expect(bypassesTypingGuard("delete")).toBe(false);
        expect(bypassesTypingGuard("duplicate")).toBe(false);
    });
});

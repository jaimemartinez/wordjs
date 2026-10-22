/**
 * useModal().prompt() — the host's replacement for the browser's prompt(), which WordJS never uses
 * (lib/__tests__/noNativeDialogs.test.ts). Resolves to what the reader typed, or null when they cancel.
 *
 * Node environment, no DOM: the controller is driven directly, and the dialog is rendered to static markup.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createModalController, modalText, ModalDialog, ModalProvider, useModal } from "../ModalContext";

afterEach(() => { vi.unstubAllGlobals(); });

describe("useModal().prompt()", () => {
    it("resolves to the typed text on OK, and to null on Cancel / Escape / the backdrop", async () => {
        const c = createModalController();
        const typed = c.prompt("Email for the test send", undefined, { defaultValue: "a@example.com" });
        expect(c.current()?.type).toBe("prompt");
        expect(c.current()?.input).toEqual({ defaultValue: "a@example.com", placeholder: undefined, inputType: "text" });
        c.answer(true, "b@example.com");
        await expect(typed).resolves.toBe("b@example.com");
        expect(c.current()).toBeNull();

        const cancelled = c.prompt("Link URL");
        c.answer(false, "ignored");
        await expect(cancelled).resolves.toBeNull();
    });

    it("an OK without a value keeps the default; the first answer wins", async () => {
        const c = createModalController();
        const p = c.prompt("Name", "Rename", { defaultValue: "old" });
        c.answer(true);
        c.answer(false);
        await expect(p).resolves.toBe("old");
    });

    it("renders a text box with its default, type and placeholder, and the reader's language", () => {
        vi.stubGlobal("window", {});
        vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "wordjs-lang" ? "en" : null) });
        const c = createModalController();
        void c.prompt("Link URL", undefined, { defaultValue: "https://", inputType: "url", placeholder: "https://example.com" });
        const html = renderToStaticMarkup(<ModalDialog controller={c} />);
        expect(html).toMatch(/<input[^>]*type="url"/);
        expect(html).toMatch(/<input[^>]*value="https:\/\/"/);
        expect(html).toMatch(/<input[^>]*placeholder="https:\/\/example.com"/);
        expect(html).toContain("Link URL");
        const text = modalText(c.current()!, "en");
        expect([text.title, text.confirmText, text.cancelText]).toEqual(["Enter a value", "OK", "Cancel"]);
        expect(modalText(c.current()!, "es").title).toBe("Escribe un valor");
    });

    it("is on useModal() beside alert and confirm, and alert/confirm render no text box", () => {
        let asked: ReturnType<typeof useModal> | null = null;
        function Asks() { asked = useModal(); void asked.confirm("Delete?"); return null; }
        const html = renderToStaticMarkup(<ModalProvider><Asks /></ModalProvider>);
        expect(typeof asked!.prompt).toBe("function");
        expect(html).not.toContain("<input");
    });
});

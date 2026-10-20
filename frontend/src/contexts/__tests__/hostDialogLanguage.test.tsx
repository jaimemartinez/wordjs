/**
 * THE HOST CONFIRM/ALERT DIALOG SPEAKS THE ADMIN'S LANGUAGE.
 *
 * Live finding: every `useModal().confirm(message, title, isDanger)` in a Spanish admin — core pages and
 * plugin admin pages such as conference-manager — showed «Confirm» / «Cancel» next to a
 * Spanish message, and `alert()` showed «OK». ModalProvider passed hard-coded English labels to
 * ConfirmationModal, whose own defaults were English too. ModalProvider is mounted in app/_root/RootDocument.tsx, ABOVE
 * the admin's and the portals' I18nProvider, so the dialog reads the language every provider reads and
 * writes ('wordjs-lang' in localStorage, 'es' when unset).
 *
 * Node environment, no DOM: the dialog's state lives in a controller driven directly, and the dialog —
 * alone or through ModalProvider + useModal() — is rendered to static markup.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { createModalController, modalText, ModalDialog, ModalProvider, useModal, type ModalRequest } from "../ModalContext";
import ConfirmationModal from "@/components/ConfirmationModal";
import { I18nProvider } from "../I18nContext";
import { getStoredLanguage, translations, type Language } from "@/lib/i18n";

const flat = (html: string) => html.replace(/<!-- -->/g, "");
const buttonsOf = (html: string) => [...flat(html).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
const titleOf = (html: string) => /<h3[^>]*>([^<]*)<\/h3>/.exec(flat(html))?.[1];

/** A browser whose localStorage holds `stored` under 'wordjs-lang' (or whose storage throws). */
function storedLanguage(stored: string | null | Error) {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => {
            if (stored instanceof Error) throw stored;
            return key === "wordjs-lang" ? stored : null;
        },
    });
}

/** Renders the host dialog through the real provider: `ask` runs inside it with useModal() in hand. */
function renderAsked(ask: (modal: ReturnType<typeof useModal>) => void, wrap = (node: React.ReactNode) => node) {
    function Asks() {
        ask(useModal());
        return null;
    }
    return renderToStaticMarkup(<>{wrap(<ModalProvider><Asks /></ModalProvider>)}</>);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("useModal().confirm() — in the admin's language", () => {
    it("a Spanish admin gets «Cancelar» / «Confirmar», never «Cancel» / «Confirm»", () => {
        const html = renderAsked((modal) => { void modal.confirm("¿Eliminar la conferencia?", "Eliminar", true); });
        expect(buttonsOf(html)).toEqual(["Cancelar", "Confirmar"]);
        expect(html).toContain("¿Eliminar la conferencia?");
        expect(titleOf(html)).toBe("Eliminar");
    });

    it("Spanish is also the default with no stored choice, or with an I18nProvider above the provider", () => {
        storedLanguage(null);
        expect(buttonsOf(renderAsked((modal) => { void modal.confirm("m"); }))).toEqual(["Cancelar", "Confirmar"]);
        vi.unstubAllGlobals();
        const inProvider = renderAsked((modal) => { void modal.confirm("m"); }, (node) => <I18nProvider>{node}</I18nProvider>);
        expect(buttonsOf(inProvider)).toEqual(["Cancelar", "Confirmar"]);
    });

    it.each<[Language, string, string, string]>([
        ["en", "Cancel", "Confirm", "Confirm"],
        ["pt", "Cancelar", "Confirmar", "Confirmar"],
        ["es", "Cancelar", "Confirmar", "Confirmar"],
    ])("follows the stored language outside any I18nProvider (%s)", (lang, cancel, confirm, title) => {
        storedLanguage(lang);
        const html = renderAsked((modal) => { void modal.confirm("m"); });
        expect(buttonsOf(html)).toEqual([cancel, confirm]);
        expect(titleOf(html)).toBe(title);
    });

    it("the default title is localized; a caller's title (even an empty one) wins", () => {
        expect(titleOf(renderAsked((modal) => { void modal.confirm("m"); }))).toBe(translations.es["dialog.confirm.title"]);
        expect(titleOf(renderAsked((modal) => { void modal.confirm("m", "Rechazar pago", true); }))).toBe("Rechazar pago");
        expect(titleOf(renderAsked((modal) => { void modal.confirm("m", ""); }))).toBe("");
    });

    it("accepts custom button labels as a 4th argument; a label left out keeps its localized default", () => {
        const both = renderAsked((modal) => { void modal.confirm("m", "t", true, { confirmText: "Eliminar", cancelText: "Volver" }); });
        expect(buttonsOf(both)).toEqual(["Volver", "Eliminar"]);
        const one = renderAsked((modal) => { void modal.confirm("m", undefined, false, { confirmText: "Aplicar" }); });
        expect(buttonsOf(one)).toEqual(["Cancelar", "Aplicar"]);
        storedLanguage("en");
        const inEnglish = renderAsked((modal) => { void modal.confirm("m", undefined, undefined, { cancelText: "Keep" }); });
        expect(buttonsOf(inEnglish)).toEqual(["Keep", "Confirm"]);
    });

    it("isDanger still paints the confirming button red", () => {
        expect(renderAsked((modal) => { void modal.confirm("m", undefined, true); })).toContain("bg-red-600");
        expect(renderAsked((modal) => { void modal.confirm("m"); })).not.toContain("bg-red-600");
    });
});

describe("useModal().alert() — in the admin's language", () => {
    it("«Aceptar» and a localized default title in Spanish, «OK» / «Alert» in English", () => {
        const es = renderAsked((modal) => { void modal.alert("Guardado"); });
        expect(buttonsOf(es)).toEqual(["Cancelar", "Aceptar"]);
        expect(titleOf(es)).toBe("Aviso");
        storedLanguage("en");
        const en = renderAsked((modal) => { void modal.alert("Saved"); });
        expect(buttonsOf(en)).toEqual(["Cancel", "OK"]);
        expect(titleOf(en)).toBe("Alert");
    });

    it("accepts a custom label as a 3rd argument", () => {
        expect(buttonsOf(renderAsked((modal) => { void modal.alert("m", "t", { confirmText: "Entendido" }); }))).toEqual(["Cancelar", "Entendido"]);
    });
});

describe("the controller behind useModal()", () => {
    it("confirm() resolves true on the confirming button and false on Cancel / Escape / the backdrop", async () => {
        const c = createModalController();
        const yes = c.confirm("m");
        expect(c.current()).toMatchObject({ type: "confirm", message: "m", isDanger: false, labels: {} });
        // ConfirmationModal's confirming button calls onConfirm and THEN onClose: the first answer wins.
        c.answer(true);
        c.answer(false);
        expect(await yes).toBe(true);
        expect(c.current()).toBeNull();

        const no = c.confirm("m", "t", true);
        c.answer(false);
        expect(await no).toBe(false);
    });

    it("alert() resolves (to undefined) whichever button closes it", async () => {
        const c = createModalController();
        const viaOk = c.alert("m");
        c.answer(true);
        expect(await viaOk).toBeUndefined();
        const viaCancel = c.alert("m");
        c.answer(false);
        expect(await viaCancel).toBeUndefined();
    });

    it("notifies the dialog when a request opens and when it is answered", () => {
        const c = createModalController();
        const seen: (ModalRequest | null)[] = [];
        const unsubscribe = c.subscribe(() => seen.push(c.current()));
        void c.confirm("m");
        c.answer(true);
        unsubscribe();
        void c.confirm("ignored");
        expect(seen.map((r) => r?.message ?? null)).toEqual(["m", null]);
    });

    it("ModalDialog renders nothing until something is asked", () => {
        expect(renderToStaticMarkup(<ModalDialog controller={createModalController()} />)).toBe("");
        expect(renderToStaticMarkup(<ModalProvider><p>page</p></ModalProvider>)).toBe("<p>page</p>");
    });

    it("modalText fills in every default in the language it is given", () => {
        const request: ModalRequest = { type: "confirm", message: "m", isDanger: false, labels: {} };
        for (const lang of ["es", "en", "pt"] as const) {
            expect(modalText(request, lang)).toEqual({
                title: translations[lang]["dialog.confirm.title"],
                confirmText: translations[lang]["dialog.confirm"],
                cancelText: translations[lang]["dialog.cancel"],
            });
            expect(modalText({ ...request, type: "alert" }, lang)).toEqual({
                title: translations[lang]["dialog.alert.title"],
                confirmText: translations[lang]["dialog.ok"],
                cancelText: translations[lang]["dialog.cancel"],
            });
        }
    });
});

describe("ConfirmationModal used directly (media, menus) — its defaults are localized too", () => {
    const render = (props: { confirmText?: string; cancelText?: string } = {}) => renderToStaticMarkup(
        <ConfirmationModal isOpen onClose={() => undefined} onConfirm={() => undefined} title="T" message="M" {...props} />,
    );

    it("a page that passes only its confirming label gets a Spanish «Cancelar», or the stored language's", () => {
        expect(buttonsOf(render({ confirmText: "Eliminar" }))).toEqual(["Cancelar", "Eliminar"]);
        expect(buttonsOf(render())).toEqual(["Cancelar", "Confirmar"]);
        storedLanguage("en");
        expect(buttonsOf(render({ confirmText: "Delete" }))).toEqual(["Cancel", "Delete"]);
        storedLanguage("pt");
        expect(buttonsOf(render())).toEqual(["Cancelar", "Confirmar"]);
    });

    it("the unsaved-changes guard takes its words from the admin's I18nProvider, not English literals", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../UnsavedChangesContext.tsx"), "utf8");
        for (const english of ["Unsaved Changes", "You have unsaved changes", "Leave Page"]) {
            expect(src, english).not.toContain(english);
        }
        for (const key of ["dialog.unsaved.title", "dialog.unsaved.message", "dialog.unsaved.leave", "dialog.cancel"]) {
            expect(src, key).toContain(`t("${key}")`);
        }
    });
});

describe("the stored language never breaks the dialog", () => {
    it("an unknown or blocked value falls back to Spanish instead of crashing t()", () => {
        storedLanguage("fr");
        expect(getStoredLanguage()).toBe("es");
        expect(buttonsOf(renderAsked((modal) => { void modal.confirm("m"); }))).toEqual(["Cancelar", "Confirmar"]);
        storedLanguage("toString");
        expect(getStoredLanguage()).toBe("es");
        storedLanguage(new Error("SecurityError: storage is disabled"));
        expect(getStoredLanguage()).toBe("es");
        expect(buttonsOf(renderAsked((modal) => { void modal.alert("m"); }))).toEqual(["Cancelar", "Aceptar"]);
    });

    it("every dialog key exists, non-empty, in es, en and pt", () => {
        const keys = Object.keys(translations.en).filter((k) => k.startsWith("dialog."));
        expect(keys.length).toBeGreaterThanOrEqual(8);
        for (const lang of ["es", "en", "pt"] as const) {
            expect(Object.keys(translations[lang]).filter((k) => k.startsWith("dialog.")).sort(), lang).toEqual([...keys].sort());
            for (const key of keys) expect(translations[lang][key], `${lang} ${key}`).toBeTruthy();
        }
    });
});

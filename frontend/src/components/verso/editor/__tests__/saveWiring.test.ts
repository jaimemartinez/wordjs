/**
 * F3 — cableado de guards del camino de guardado Verso (checklist W10/W11/W44/W49/W50):
 *
 *  - runBackgroundSave pasa EXACTAMENTE {autosave:true} (el flag que el backend usa para saltar
 *    el snapshot de revisión) y un ok===false / excepción NO se trata como éxito.
 *  - runManualSave llama a onSave() sin flag y respeta el contrato false=bloqueado.
 *  - El payload que arma handleSubmit se alimenta del HANDLE VIVO de Verso: getData().root.props →
 *    resolveWjsTemplateForSave → meta._wjs_template SIEMPRE presente ('' limpia; omitir dejaría
 *    stale — contrato del backend que mergea meta por clave).
 *  - unhydratedSaveBlocked bloquea manual Y autosave de un registro existente sin hidratar.
 */
import { describe, expect, it, vi } from "vitest";
import { createEditor } from "@/lib/verso/store";
import { resolveWjsTemplateForSave, unhydratedSaveBlocked, applyLegacyHtmlFallback } from "@/lib/editorGuards";
import { buildAutosaveSaveOptions } from "@/lib/autosavePolicy";
import { runBackgroundSave, runManualSave } from "../saveFlow";

describe("runBackgroundSave (autosave)", () => {
    it("pasa exactamente {autosave:true} y estampa en éxito", async () => {
        const onSave = vi.fn().mockResolvedValue(true);
        await expect(runBackgroundSave(onSave)).resolves.toBe(true);
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith({ autosave: true });
        expect(onSave.mock.calls[0][0]).toEqual(buildAutosaveSaveOptions());
    });

    it("void/undefined cuenta como éxito (compat del contrato onSave)", async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        await expect(runBackgroundSave(onSave)).resolves.toBe(true);
    });

    it("false = bloqueado/fallido → no estampa", async () => {
        const onSave = vi.fn().mockResolvedValue(false);
        await expect(runBackgroundSave(onSave)).resolves.toBe(false);
    });

    it("una excepción de red en background NUNCA lanza — devuelve false", async () => {
        const onSave = vi.fn().mockRejectedValue(new Error("red caída"));
        await expect(runBackgroundSave(onSave)).resolves.toBe(false);
    });
});

describe("runManualSave", () => {
    it("llama a onSave() SIN flag de autosave", async () => {
        const onSave = vi.fn().mockResolvedValue(true);
        await expect(runManualSave(onSave)).resolves.toBe(true);
        expect(onSave).toHaveBeenCalledWith();
    });

    it("false → sin toast/savedAt (el llamador no estampa)", async () => {
        const onSave = vi.fn().mockResolvedValue(false);
        await expect(runManualSave(onSave)).resolves.toBe(false);
    });
});

describe("payload de guardado alimentado por el handle VIVO de Verso", () => {
    it("meta._wjs_template siempre presente: valor asignado, '' cuando falta o no es string", () => {
        const withTemplate = createEditor({
            initialData: { content: [], root: { props: { title: "T", _wjs_template: "landing" } } },
        });
        expect(resolveWjsTemplateForSave(withTemplate.getData().root.props)).toBe("landing");

        const without = createEditor({ initialData: { content: [], root: { props: { title: "T" } } } });
        expect(resolveWjsTemplateForSave(without.getData().root.props)).toBe("");

        const stale = createEditor({ initialData: { content: [], root: { props: { _wjs_template: 7 } } } });
        expect(resolveWjsTemplateForSave(stale.getData().root.props)).toBe("");
    });

    it("editar la plantilla vía setRootProps fluye a getData() → payload (sin mirrors)", () => {
        const handle = createEditor({ initialData: { content: [], root: { props: { title: "T" } } } });
        handle.transact((tx) => tx.setRootProps({ _wjs_template: "page-full" }));
        expect(resolveWjsTemplateForSave(handle.getData().root.props)).toBe("page-full");
        // '' explícito LIMPIA (el backend mergea por clave; omitir dejaría stale)
        handle.transact((tx) => tx.setRootProps({ _wjs_template: "" }));
        expect(resolveWjsTemplateForSave(handle.getData().root.props)).toBe("");
    });

    it("rama legacy-HTML: un lienzo Verso vacío con legacyHtml preserva el cuerpo y quita _puck_data", () => {
        const handle = createEditor({ initialData: { content: [], root: { props: {} } } });
        const liveData = handle.getData();
        const payload = {
            content: "",
            meta: { _puck_data: liveData, _wjs_template: "" } as Record<string, unknown>,
        };
        const out = applyLegacyHtmlFallback(payload, liveData.content.length, "<p>cuerpo legacy</p>");
        expect(out.content).toBe("<p>cuerpo legacy</p>");
        expect("_puck_data" in out.meta).toBe(false);
        expect(out.meta._wjs_template).toBe(""); // el resto de meta sobrevive
    });

    it("unhydratedSaveBlocked: existente sin hidratar bloqueado; nuevo siempre guardable", () => {
        expect(unhydratedSaveBlocked({ isNew: false, loaded: false })).toBe(true);
        expect(unhydratedSaveBlocked({ isNew: false, loaded: true })).toBe(false);
        expect(unhydratedSaveBlocked({ isNew: true, loaded: false })).toBe(false);
    });
});

/**
 * F3 — SaveStateChip: los estados/textos EXACTOS de la tabla del blueprint (§d), en su orden de
 * evaluación (saving → hasChanges → savedAt → vacío). Los textos son ES fuente (trStr los traduce
 * en el componente); "hace {m}m" queda SIN interpolar para que la traducción matchee el literal.
 */
import { describe, expect, it } from "vitest";
import { saveChipModel } from "../saveChipModel";

const base = { saving: false, hasChanges: false, status: "draft", savedAtMs: null, wasAuto: false, nowMs: 1_000_000 };

describe("saveChipModel", () => {
    it("guardando (gana a todo)", () => {
        const m = saveChipModel({ ...base, saving: true, hasChanges: true, savedAtMs: 1 });
        expect(m).toMatchObject({ icon: "sync", spin: true, text: "Guardando…", cls: "text-[var(--ed-outline)]" });
    });

    it("cambios sin guardar — draft vs publicado", () => {
        expect(saveChipModel({ ...base, hasChanges: true })).toMatchObject({
            icon: "cloud_upload",
            text: "Sin guardar",
            cls: "text-amber-700",
        });
        expect(saveChipModel({ ...base, hasChanges: true, status: "publish" })).toMatchObject({
            text: "Cambios sin publicar",
            cls: "text-amber-700",
        });
    });

    it("guardado hace <1m — manual vs auto", () => {
        const now = 10 * 60000;
        expect(saveChipModel({ ...base, nowMs: now, savedAtMs: now - 10_000 })).toMatchObject({
            icon: "cloud_done",
            fill: true,
            text: "Guardado",
            minutes: null,
        });
        expect(saveChipModel({ ...base, nowMs: now, savedAtMs: now - 10_000, wasAuto: true })).toMatchObject({
            text: "Autoguardado",
        });
    });

    it("guardado hace ≥1m — plantilla {m} sin interpolar + minutos aparte", () => {
        const now = 60 * 60000;
        const m = saveChipModel({ ...base, nowMs: now, savedAtMs: now - 3 * 60000 });
        expect(m.text).toBe("Guardado hace {m}m");
        expect(m.minutes).toBe(3);
        const auto = saveChipModel({ ...base, nowMs: now, savedAtMs: now - 7 * 60000, wasAuto: true });
        expect(auto.text).toBe("Autoguardado hace {m}m");
        expect(auto.minutes).toBe(7);
    });

    it("redondeo de minutos idéntico al chip actual (Math.round, clamp a 0)", () => {
        const now = 100 * 60000;
        // 29s → round(0.48) = 0 → "<1m"
        expect(saveChipModel({ ...base, nowMs: now, savedAtMs: now - 29_000 }).minutes).toBe(null);
        // 31s → round(0.52) = 1 → "hace 1m"
        expect(saveChipModel({ ...base, nowMs: now, savedAtMs: now - 31_000 }).minutes).toBe(1);
        // reloj hacia atrás → clamp a 0 → "<1m", nunca negativo
        expect(saveChipModel({ ...base, nowMs: now, savedAtMs: now + 120_000 }).minutes).toBe(null);
    });

    it("sin nada que contar → chip vacío pero montable (región aria-live estable)", () => {
        expect(saveChipModel(base)).toMatchObject({ icon: null, text: "" });
    });
});

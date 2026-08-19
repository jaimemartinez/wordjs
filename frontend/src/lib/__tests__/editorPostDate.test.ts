/**
 * La FECHA del registro en el editor (mitad frontend del defecto "una fecha futura huérfana
 * reprograma la entrada").
 *
 * QUÉ SE ARREGLÓ. `post_date` sobrevive a desprogramar: una entrada programada para diciembre que se
 * pasa a Borrador conserva diciembre en `post_date_gmt` (un guardado normal no toca las columnas de
 * fecha). El editor escondía el campo salvo cuando el estado YA era 'future', así que el autor no
 * podía ver la fecha que le estaba mordiendo, pulsaba "Publicar" y la entrada volvía a "Programado".
 * El campo se enseña ahora siempre que haya fecha que enseñar, y lo que el autor escriba en él
 * VIAJA — un control editable cuyo valor se tira es la misma clase de UI que miente.
 *
 * Se prueban las dos piezas que el editor usa de verdad: el predicado con el que VersoEditor decide
 * si pinta el input, y el constructor del payload que el host llama en cada guardado.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    shouldShowPostDateField,
    buildStatusPatch,
    isFutureInput,
    dbDateToLocalInput,
    SCHEDULED_STATUS,
} from "../editorSchedule";

const NOW = new Date("2026-08-18T10:00:00.000Z");

describe("shouldShowPostDateField — se enseña la fecha que hay, no sólo al programar", () => {
    it("un borrador con fecha futura ALMACENADA enseña el campo (era invisible: el defecto)", () => {
        const stored = dbDateToLocalInput("2026-12-01 09:00:00");
        expect(stored).not.toBe("");
        expect(shouldShowPostDateField({ canSchedule: true, status: "draft", scheduleDate: stored })).toBe(true);
    });

    it("una entrada publicada enseña su fecha de publicación", () => {
        expect(shouldShowPostDateField({ canSchedule: true, status: "publish", scheduleDate: "2026-01-02T08:30" })).toBe(true);
    });

    it("programando se enseña siempre, incluso sin fecha aún elegida", () => {
        expect(shouldShowPostDateField({ canSchedule: true, status: SCHEDULED_STATUS, scheduleDate: "" })).toBe(true);
    });

    it("una entrada NUEVA (sin fecha) no enseña un campo vacío hasta que se programa", () => {
        expect(shouldShowPostDateField({ canSchedule: true, status: "draft", scheduleDate: "" })).toBe(false);
    });

    it("un host que no sabe armar el payload no recibe control ninguno", () => {
        expect(shouldShowPostDateField({ canSchedule: false, status: SCHEDULED_STATUS, scheduleDate: "2026-12-01T09:00" })).toBe(false);
    });
});

describe("VersoEditor pinta el input POR ese predicado", () => {
    // Gate barato contra la regresión concreta que hubo: el input volvía a esconderse detrás de
    // `status === 'future'`. El render completo del editor no cabe en el entorno node de esta suite.
    it("el gate del input de fecha es shouldShowPostDateField, no una comparación de estado", () => {
        const src = readFileSync(
            fileURLToPath(new URL("../../components/verso/editor/VersoEditor.tsx", import.meta.url)),
            "utf8",
        );
        const gate = src.match(/\{onStatusChange &&[^\n]*\n?[^\n]*<input\s+type="datetime-local"/);
        expect(gate, "no se encontró el input datetime-local del editor").not.toBeNull();
        expect(gate![0]).toContain("shouldShowPostDateField");
        expect(gate![0]).not.toContain('status === "future"');
    });
});

describe("buildStatusPatch — la fecha visible sólo viaja si el autor la tocó", () => {
    it("sin tocarla, un guardado normal NO reescribe post_date", () => {
        expect(buildStatusPatch("draft", "2026-12-01T09:00", "draft", NOW)).toEqual({ status: "draft" });
        expect(buildStatusPatch("publish", "2026-12-01T09:00", "draft", NOW)).toEqual({ status: "publish" });
    });

    it("tocándola, viaja con el estado que sea (el backend decide el resultado)", () => {
        expect(buildStatusPatch("draft", "2026-09-01T09:00", "draft", NOW, { dateEdited: true })).toEqual({
            status: "draft",
            date: new Date("2026-09-01T09:00").toISOString(),
        });
    });

    it("dejar de estar programado sigue publicando AHORA… salvo que el autor diera otra fecha", () => {
        expect(buildStatusPatch("publish", "2026-12-01T09:00", SCHEDULED_STATUS, NOW)).toEqual({
            status: "publish",
            date: NOW.toISOString(),
        });
        expect(buildStatusPatch("publish", "2026-12-01T09:00", SCHEDULED_STATUS, NOW, { dateEdited: true })).toEqual({
            status: "publish",
            date: new Date("2026-12-01T09:00").toISOString(),
        });
    });

    it("una fecha ilegible no se cuela como patch de fecha", () => {
        expect(buildStatusPatch("draft", "vaya fecha", "draft", NOW, { dateEdited: true })).toEqual({ status: "draft" });
    });

    it("programar sigue exigiendo fecha válida y viaja como publish + date", () => {
        expect(buildStatusPatch(SCHEDULED_STATUS, "", "draft", NOW)).toBeNull();
        expect(buildStatusPatch(SCHEDULED_STATUS, "2026-12-01T09:00", "draft", NOW)).toEqual({
            status: "publish",
            date: new Date("2026-12-01T09:00").toISOString(),
        });
    });
});

describe("isFutureInput — por qué pasar a «Programada» re-siembra la fecha", () => {
    it("la fecha de una entrada ya publicada es PASADA: programar con ella la publicaría al instante", () => {
        expect(isFutureInput("2026-01-02T08:30", NOW)).toBe(false);
        expect(isFutureInput("2026-12-01T09:00", NOW)).toBe(true);
        expect(isFutureInput("", NOW)).toBe(false);
    });
});

/**
 * Los interruptores del export → el query string que el backend lee. El valor de esta prueba está en
 * la ASIMETRÍA del backend (incluir por defecto todo menos usuarios): equivocarse en un sentido se
 * lleva datos que nadie pidió, y en el otro entrega un fichero incompleto sin decirlo.
 */
import { describe, it, expect } from "vitest";
import { buildExportQuery } from "@/lib/api";
import {
    EXPORT_SECTIONS,
    defaultExportToggles,
    hasAnySection,
    includedSections,
    toggleSection,
    togglesToExportOptions,
} from "../exportLogic";

/** El query string como pares ordenados, para comparar sin depender del orden de emisión. */
const params = (qs: string) => [...new URLSearchParams(qs).entries()].sort();

describe("defaultExportToggles — arranca en los defectos DEL BACKEND", () => {
    it("todo encendido menos usuarios", () => {
        expect(defaultExportToggles()).toEqual({
            posts: true,
            pages: true,
            media: true,
            menus: true,
            settings: true,
            users: false,
        });
    });

    it("con el estado inicial el query string va VACÍO: nada que decir, el servidor ya hace eso", () => {
        expect(buildExportQuery(togglesToExportOptions(defaultExportToggles()))).toBe("");
    });

    it("devuelve un objeto nuevo cada vez", () => {
        expect(defaultExportToggles()).not.toBe(defaultExportToggles());
    });
});

describe("togglesToExportOptions + buildExportQuery", () => {
    it("apagar una sección incluida-por-defecto la manda como 'false'", () => {
        const toggles = toggleSection(defaultExportToggles(), "media");
        expect(params(buildExportQuery(togglesToExportOptions(toggles)))).toEqual([["media", "false"]]);
    });

    it("encender usuarios (opt-in) la manda como 'true'", () => {
        const toggles = toggleSection(defaultExportToggles(), "users");
        expect(params(buildExportQuery(togglesToExportOptions(toggles)))).toEqual([["users", "true"]]);
    });

    it("usuarios APAGADO no manda nada: el backend ya los deja fuera salvo que se pidan", () => {
        expect(buildExportQuery(togglesToExportOptions(defaultExportToggles()))).not.toContain("users");
    });

    it("varias exclusiones a la vez viajan todas", () => {
        let toggles = defaultExportToggles();
        toggles = toggleSection(toggles, "media");
        toggles = toggleSection(toggles, "menus");
        toggles = toggleSection(toggles, "users");
        expect(params(buildExportQuery(togglesToExportOptions(toggles)))).toEqual([
            ["media", "false"],
            ["menus", "false"],
            ["users", "true"],
        ]);
    });

    it("todo apagado excluye las cinco incluidas-por-defecto y no pide usuarios", () => {
        const off = { posts: false, pages: false, media: false, menus: false, settings: false, users: false };
        expect(params(buildExportQuery(togglesToExportOptions(off)))).toEqual([
            ["media", "false"],
            ["menus", "false"],
            ["pages", "false"],
            ["posts", "false"],
            ["settings", "false"],
        ]);
    });
});

describe("toggleSection", () => {
    it("no muta el estado anterior (React nunca recibe el mismo objeto)", () => {
        const before = defaultExportToggles();
        const after = toggleSection(before, "posts");
        expect(before.posts).toBe(true);
        expect(after.posts).toBe(false);
        expect(after).not.toBe(before);
    });

    it("dos veces vuelve al punto de partida", () => {
        const before = defaultExportToggles();
        expect(toggleSection(toggleSection(before, "users"), "users")).toEqual(before);
    });
});

describe("hasAnySection / includedSections", () => {
    it("con todo apagado no hay nada que descargar", () => {
        const off = { posts: false, pages: false, media: false, menus: false, settings: false, users: false };
        expect(hasAnySection(off)).toBe(false);
        expect(includedSections(off)).toEqual([]);
    });

    it("una sola sección basta", () => {
        const only = { posts: false, pages: false, media: false, menus: false, settings: false, users: true };
        expect(hasAnySection(only)).toBe(true);
        expect(includedSections(only)).toEqual(["users"]);
    });

    it("el resumen respeta el ORDEN declarado, no el de las claves del objeto", () => {
        expect(includedSections(defaultExportToggles())).toEqual(["posts", "pages", "media", "menus", "settings"]);
    });

    it("EXPORT_SECTIONS cubre exactamente las claves del estado", () => {
        expect([...EXPORT_SECTIONS].sort()).toEqual(Object.keys(defaultExportToggles()).sort());
    });
});

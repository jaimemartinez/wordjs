/**
 * SEO de los campos ROOT: siembra desde la meta y emisión en el payload.
 *
 * POR QUÉ EXISTE ESTE FICHERO. El editor manda `meta.seo_title/seo_description/og_image/noindex` en
 * CADA guardado leyéndolos de `root.props`, pero la carga no los sembraba desde la meta: solo
 * llegaban dentro de `_puck_data`. Un registro cuyo SEO se puso por la API o por importación perdía
 * los cuatro valores en el primer guardado, en silencio — y con `buildPostMetadata` honrando ya los
 * overrides y el sitemap el `noindex`, ese borrado cambia el <title> real y re-lista una página que
 * se ocultó a propósito. Estos tests fijan la regla: LA META MANDA sobre `_puck_data`.
 */
import { describe, it, expect } from "vitest";
import type { Post } from "@/lib/api";
import {
    isNoindexMetaValue,
    seedSeoRootProps,
    seoMetaForSave,
    withRecordRootFields,
    SEO_META_KEYS,
} from "../editorRootFields";
import { rootFieldsPost, rootFieldsPage } from "@/lib/verso/coreBlocks";

/** Un registro mínimo con la meta indicada — solo se lee `meta`. */
function postWithMeta(meta: Record<string, unknown>): Post {
    return { id: 1, title: "t", slug: "t", meta } as unknown as Post;
}

/* ------------------------------------------------------------------ */
/* noindex: fail-open.                                                 */
/* ------------------------------------------------------------------ */

describe("isNoindexMetaValue", () => {
    it("reconoce lo que escribe este editor (booleano) y las grafías de la API/importación", () => {
        for (const v of [true, 1, "1", "true", "TRUE", " yes ", "on"]) {
            expect(isNoindexMetaValue(v), `debería ocultar: ${String(v)}`).toBe(true);
        }
    });

    it("es FAIL-OPEN: de un valor irreconocible no se deduce «oculto»", () => {
        for (const v of [false, 0, "0", "false", "", "   ", "nope", "2", null, undefined, {}, []]) {
            expect(isNoindexMetaValue(v), `no debería ocultar: ${JSON.stringify(v)}`).toBe(false);
        }
    });
});

/* ------------------------------------------------------------------ */
/* Siembra.                                                            */
/* ------------------------------------------------------------------ */

describe("seedSeoRootProps", () => {
    it("devuelve SIEMPRE las cuatro claves, para pisar de forma determinista un _puck_data viejo", () => {
        expect(Object.keys(seedSeoRootProps(postWithMeta({}))).sort()).toEqual([...SEO_META_KEYS].sort());
    });

    it("un registro sin meta de SEO se siembra vacío e indexable", () => {
        expect(seedSeoRootProps(postWithMeta({}))).toEqual({
            seo_title: "",
            seo_description: "",
            og_image: "",
            noindex: "false",
        });
        expect(seedSeoRootProps(undefined)).toEqual({
            seo_title: "",
            seo_description: "",
            og_image: "",
            noindex: "false",
        });
    });

    it("lee la meta real, recortando, y traduce noindex al string que espera el radio", () => {
        expect(
            seedSeoRootProps(
                postWithMeta({
                    seo_title: "  Título a medida  ",
                    seo_description: "Resumen para buscadores",
                    og_image: "/uploads/social.png",
                    noindex: true,
                }),
            ),
        ).toEqual({
            seo_title: "Título a medida",
            seo_description: "Resumen para buscadores",
            og_image: "/uploads/social.png",
            noindex: "true",
        });
    });

    it("acepta un valor numérico ya parseado (getOption convierte '1' en 1)", () => {
        expect(seedSeoRootProps(postWithMeta({ seo_title: 2026, noindex: 1 }))).toMatchObject({
            seo_title: "2026",
            noindex: "true",
        });
    });

    it("REGRESIÓN: la meta gana al _puck_data — es la mezcla que hace la carga del editor", () => {
        const stale = { seo_title: "lo que había en _puck_data", noindex: "false" };
        const seeded = seedSeoRootProps(postWithMeta({ seo_title: "puesto por la API", noindex: "1" }));
        const merged = { ...stale, ...seeded };
        expect(merged.seo_title).toBe("puesto por la API");
        expect(merged.noindex).toBe("true");
    });
});

/* ------------------------------------------------------------------ */
/* Emisión en el payload.                                              */
/* ------------------------------------------------------------------ */

describe("seoMetaForSave", () => {
    it("emite las cuatro claves, con noindex como BOOLEANO (lo que el body mandaba ya)", () => {
        expect(seoMetaForSave({ seo_title: "T", seo_description: "D", og_image: "/i.png", noindex: "true" })).toEqual({
            seo_title: "T",
            seo_description: "D",
            og_image: "/i.png",
            noindex: true,
        });
    });

    it("sin props, manda vacíos: '' es la única forma de BORRAR un override anterior", () => {
        expect(seoMetaForSave(undefined)).toEqual({
            seo_title: "",
            seo_description: "",
            og_image: "",
            noindex: false,
        });
    });

    it("no cuela un valor no-string en la meta (un objeto no puede acabar en el <title>)", () => {
        expect(seoMetaForSave({ seo_title: { toString: () => "x" }, og_image: ["/a.png"] })).toMatchObject({
            seo_title: "",
            og_image: "",
        });
    });

    it("un guardado justo después de la siembra es IDEMPOTENTE (no reescribe otra cosa)", () => {
        const post = postWithMeta({
            seo_title: "Título",
            seo_description: "Desc",
            og_image: "/uploads/x.png",
            noindex: "1",
        });
        expect(seoMetaForSave({ ...seedSeoRootProps(post) })).toEqual({
            seo_title: "Título",
            seo_description: "Desc",
            og_image: "/uploads/x.png",
            noindex: true,
        });
    });
});

/* ------------------------------------------------------------------ */
/* Composición de campos.                                              */
/* ------------------------------------------------------------------ */

describe("withRecordRootFields({ seo: true })", () => {
    it("PÁGINAS: añade los cuatro controles que faltaban (el lector ya los honraba)", () => {
        const fields = withRecordRootFields(rootFieldsPage, { seo: true });
        for (const key of SEO_META_KEYS) {
            expect(fields[key], `falta el campo ${key}`).toBeDefined();
        }
        expect(fields.noindex.type).toBe("radio");
        expect(fields.seo_description.type).toBe("textarea");
    });

    it("el radio de noindex guarda los strings 'true'/'false' que lee seedSeoRootProps", () => {
        const noindex = withRecordRootFields(rootFieldsPage, { seo: true }).noindex;
        const values = (noindex as { options: readonly { value: unknown }[] }).options.map((o) => o.value);
        expect(values).toEqual(["false", "true"]);
    });

    it("sin la opción no aparece ningún campo de SEO", () => {
        const fields = withRecordRootFields(rootFieldsPage);
        for (const key of SEO_META_KEYS) expect(fields[key]).toBeUndefined();
    });

    it("ENTRADAS: no duplica ni pisa los campos de SEO que el registro ya trae", () => {
        const fields = withRecordRootFields(rootFieldsPost, { seo: true });
        for (const key of SEO_META_KEYS) {
            expect(fields[key], `${key} debería seguir siendo el del registro`).toBe(rootFieldsPost[key]);
        }
        expect(Object.keys(fields).filter((k) => k === "seo_title")).toHaveLength(1);
    });

    it("no muta los registros de origen", () => {
        const before = Object.keys(rootFieldsPage).join(",");
        withRecordRootFields(rootFieldsPage, { seo: true });
        expect(Object.keys(rootFieldsPage).join(",")).toBe(before);
    });
});

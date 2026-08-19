/**
 * El selector de categorías del editor, de punta a punta: cliente HTTP → opciones del campo.
 *
 * QUÉ SE ARREGLÓ. `categoriesApi.list()` pedía `GET /categories` SIN paginar y el router tapa
 * `per_page` a 100 ordenando por nombre, así que el editor sólo veía las 100 primeras. Abrir una
 * entrada cuya categoría cayera fuera pintaba la etiqueta literal «150 (sin asignar)» encima de una
 * entrada que SÍ tenía categoría; y si el autor se lo creía y elegía "Sin categoría",
 * `resolveCategoriesForSave` devolvía `[]` y `Post.setTerms` borraba la primaria de verdad.
 *
 * POR QUÉ ESTE TEST NO FABRICA LA LISTA. El fallo vivía justamente en el trozo que un fixture se
 * salta: la petición. Aquí se sustituye `fetch` por un servidor de mentira que se comporta como el
 * router REAL (tope de 100 por página, `X-WP-Total`/`X-WP-TotalPages`) y se recorre el camino
 * entero: `categoriesApi.listAll()` → `withRecordRootFields(rootFieldsPost, …)` → opciones del
 * select → `resolveCategoriesForSave`. Un test que construyese a mano el array de 150 categorías
 * habría seguido en verde con el defecto puesto.
 *
 * Entorno node (ver vitest.config.mts): `fetch` es global y se sustituye por test.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { categoriesApi, CATEGORY_PAGE_SIZE, type Category, type PostTermRef } from "../api";
import {
    withRecordRootFields,
    mergeCategoryOptions,
    resolveCategoriesForSave,
    categoryField,
} from "../editorRootFields";
import { rootFieldsPost } from "@/lib/verso/coreBlocks";

const realFetch = globalThis.fetch;

/** 150 categorías con nombres ordenables, como las deja una importación WXR. */
const ALL: Category[] = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    name: `Cat ${String(i + 1).padStart(3, "0")}`,
    slug: `cat-${i + 1}`,
    count: 0,
}));

let requested: string[];

/** Un `fetch` que imita `routes/categories.ts`: page/per_page (tapado a 100) + cabeceras de total. */
function stubCategoriesEndpoint(rows: Category[] = ALL) {
    requested = [];
    globalThis.fetch = (async (input: any) => {
        const url = new URL(String(input), "http://localhost");
        requested.push(url.pathname + url.search);
        const limit = Math.min(parseInt(url.searchParams.get("per_page") || "100", 10) || 100, 100);
        const page = Math.max(parseInt(url.searchParams.get("page") || "1", 10) || 1, 1);
        const slice = rows.slice((page - 1) * limit, page * limit);
        const headers: Record<string, string> = {
            "X-WP-Total": String(rows.length),
            "X-WP-TotalPages": String(Math.ceil(rows.length / limit)),
        };
        return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: (h: string) => headers[h] ?? null },
            json: async () => slice,
        };
    }) as unknown as typeof fetch;
}

beforeEach(() => stubCategoriesEndpoint());
afterEach(() => { globalThis.fetch = realFetch; });

describe("categoriesApi.listAll — recorre el pager que el router impone", () => {
    it("trae las 150, en dos páginas de 100, y no se declara truncado", async () => {
        const res = await categoriesApi.listAll();
        expect(res.data).toHaveLength(150);
        expect(res.total).toBe(150);
        expect(res.truncated).toBe(false);
        expect(requested).toHaveLength(2);
        expect(requested[0]).toContain(`per_page=${CATEGORY_PAGE_SIZE}`);
        expect(requested[0]).toContain("page=1");
        expect(requested[1]).toContain("page=2");
        // La 150 es exactamente la que la lectura sin paginar no podía ver.
        expect(res.data.some((c) => c.id === 150)).toBe(true);
    });

    it("con el tope de páginas por debajo del total, DICE que va truncado (no lo disimula)", async () => {
        const res = await categoriesApi.listAll({ maxPages: 1 });
        expect(res.data).toHaveLength(100);
        expect(res.total).toBe(150);
        expect(res.truncated).toBe(true);
        expect(requested).toHaveLength(1);
    });
});

describe("el select del editor con lo que devuelve la API real", () => {
    it("ofrece la categoría 150 con su NOMBRE, y ninguna opción afirma «sin asignar»", async () => {
        const { data } = await categoriesApi.listAll();
        const fields = withRecordRootFields(rootFieldsPost, { categories: data, currentCategory: "150" });
        const options = (fields.category as any).options as Array<{ label: string; value: string }>;
        expect(options).toContainEqual({ label: "Cat 150", value: "150" });
        expect(options.some((o) => /sin asignar/i.test(o.label))).toBe(false);
        // Y la elección se puede resolver a un id de término, que es lo que setTerms espera.
        expect(resolveCategoriesForSave({ current: "150", seeded: [3], categories: data })).toEqual([150]);
    });
});

describe("recordCategories — la segunda defensa, gemela de recordTags", () => {
    // Con el tope de páginas rebasado (o con `hide_empty`), la categoría del propio registro puede
    // seguir sin estar en lo cargado. Entonces manda el registro: la opción existe igualmente.
    const RECORD: PostTermRef[] = [{ id: 150, name: "Cat 150", slug: "cat-150" }];

    it("la categoría del registro tiene opción aunque no venga en la página cargada", async () => {
        const { data } = await categoriesApi.listAll({ maxPages: 1 }); // sólo 1..100
        expect(data.some((c) => c.id === 150)).toBe(false);

        const fields = withRecordRootFields(rootFieldsPost, {
            categories: data,
            currentCategory: "150",
            recordCategories: RECORD,
        });
        const options = (fields.category as any).options as Array<{ label: string; value: string }>;
        expect(options).toContainEqual({ label: "Cat 150", value: "150" });
        expect(options.filter((o) => o.value === "150")).toHaveLength(1); // sin duplicar
    });

    it("y el guardado resuelve contra la MISMA unión, así que se puede cambiar de categoría", async () => {
        const { data } = await categoriesApi.listAll({ maxPages: 1 });
        const union = mergeCategoryOptions(data, RECORD);
        // El autor abre el post (categoría 150, fuera de página) y elige la 7.
        expect(resolveCategoriesForSave({ current: "7", seeded: [150], categories: union })).toEqual([7]);
        // Y si no toca nada, la taxonomía NO viaja: nada que reescribir.
        expect(resolveCategoriesForSave({ current: "150", seeded: [150], categories: union })).toBeUndefined();
    });

    it("un id que nadie puede resolver se enseña como `#150`, sin afirmar que no está asignado", () => {
        const f = categoryField([], "150") as unknown as { options: Array<{ label: string; value: string }> };
        expect(f.options.at(-1)).toEqual({ label: "#150", value: "150" });
    });
});

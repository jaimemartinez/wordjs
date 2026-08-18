/**
 * Campos ROOT de registro: imagen destacada (meta `_thumbnail_id`), extracto (columna `excerpt`) y
 * categoría (array `categories` → Post.setTerms, que espera IDs de término).
 *
 * Lo que se prueba es la lógica PURA que decide qué viaja en el payload y qué se siembra al abrir —
 * el repo no tiene jsdom, así que los controles se declaran como datos y aquí se comprueba el dato.
 */
import { describe, it, expect } from "vitest";
import type { Category, Post } from "@/lib/api";
import {
    toFeaturedMediaRef,
    featuredMediaSummary,
    featuredImageMetaValue,
    featuredMediaFromPost,
    resolveExcerptForSave,
    resolveCategoryId,
    resolveCategoriesForSave,
    categoryField,
    withRecordRootFields,
    seedRootPropsFromPost,
} from "../editorRootFields";
import { rootFieldsPost, rootFieldsPage } from "@/lib/verso/coreBlocks";
import type { VersoField } from "@/lib/verso/registry";

const CATS: Category[] = [
    { id: 3, name: "Noticias", slug: "noticias", count: 4 },
    { id: 7, name: "Tutoriales", slug: "tutoriales", count: 1 },
];

/* ------------------------------------------------------------------ */
/* Imagen destacada.                                                   */
/* ------------------------------------------------------------------ */

describe("toFeaturedMediaRef — solo un id de media usable entra en el dato", () => {
    it("toma el MediaItem del picker y guarda id + URL RELATIVA + título", () => {
        expect(
            toFeaturedMediaRef({ id: 42, sourceUrl: "/uploads/2026/08/foto.jpg", guid: "http://otro-host/foto.jpg", title: "Foto" }),
        ).toEqual({ id: 42, url: "/uploads/2026/08/foto.jpg", title: "Foto" });
    });

    it("acepta la forma {id,url,title} que la API emite como featuredMedia", () => {
        expect(toFeaturedMediaRef({ id: 9, url: "https://sitio.tld/uploads/a.png", title: "A" })).toEqual({
            id: 9,
            url: "https://sitio.tld/uploads/a.png",
            title: "A",
        });
    });

    it("acepta un id suelto (número o string numérico): es lo que la meta devuelve", () => {
        expect(toFeaturedMediaRef(42)).toEqual({ id: 42 });
        expect(toFeaturedMediaRef("42")).toEqual({ id: 42 });
    });

    it("RECHAZA ids que no son enteros positivos en vez de arrastrar basura a la meta", () => {
        expect(toFeaturedMediaRef({ id: 0 })).toBeUndefined();
        expect(toFeaturedMediaRef({ id: -3 })).toBeUndefined();
        expect(toFeaturedMediaRef({ id: 1.5 })).toBeUndefined();
        expect(toFeaturedMediaRef({ id: "; DROP TABLE posts" })).toBeUndefined();
        expect(toFeaturedMediaRef(null)).toBeUndefined();
        expect(toFeaturedMediaRef("")).toBeUndefined();
    });

    it("SEGURIDAD: descarta esquemas peligrosos en la URL y conserva el id", () => {
        // El valor acaba en _puck_data y podría llegar a un src: solo rutas relativas o http(s).
        expect(toFeaturedMediaRef({ id: 5, sourceUrl: "javascript:alert(1)" })).toEqual({ id: 5 });
        expect(toFeaturedMediaRef({ id: 5, sourceUrl: "data:text/html;base64,PHNjcmlwdD4=" })).toEqual({ id: 5 });
        expect(toFeaturedMediaRef({ id: 5, sourceUrl: "//evil.tld/x.png" })).toEqual({ id: 5 });
    });
});

describe("featuredImageMetaValue — lo que se escribe en _thumbnail_id", () => {
    it("emite el id como string", () => {
        expect(featuredImageMetaValue({ featuredImage: { id: 42, url: "/uploads/f.jpg" } })).toBe("42");
    });

    it("sin imagen emite '' — la ÚNICA forma de borrar una asignación previa", () => {
        // getFeaturedImage() devuelve null con cualquier valor falsy; omitir la clave dejaría la
        // asignación anterior fija para siempre (el backend mergea meta por clave).
        expect(featuredImageMetaValue({})).toBe("");
        expect(featuredImageMetaValue({ featuredImage: undefined })).toBe("");
        expect(featuredImageMetaValue(null)).toBe("");
    });

    it("un valor manipulado no llega a la meta", () => {
        expect(featuredImageMetaValue({ featuredImage: { id: "42 OR 1=1" } })).toBe("");
    });
});

describe("featuredMediaFromPost — sembrar el control desde el registro cargado", () => {
    it("usa featuredMedia, que es lo que la API emite de verdad", () => {
        const post = { id: 1, featuredMedia: { id: 8, url: "/uploads/x.jpg", title: "X" } } as unknown as Post;
        expect(featuredMediaFromPost(post)).toEqual({ id: 8, url: "/uploads/x.jpg", title: "X" });
    });

    it("cae a la meta _thumbnail_id cuando el adjunto ya no existe", () => {
        const post = { id: 1, meta: { _thumbnail_id: 12 } } as unknown as Post;
        expect(featuredMediaFromPost(post)).toEqual({ id: 12 });
    });

    it("sin imagen no inventa nada", () => {
        expect(featuredMediaFromPost({ id: 1 } as unknown as Post)).toBeUndefined();
        expect(featuredMediaFromPost(null)).toBeUndefined();
    });
});

describe("featuredMediaSummary — el texto del control external", () => {
    it("prefiere el título, luego el fichero, luego el id", () => {
        expect(featuredMediaSummary({ id: 4, url: "/uploads/a.jpg", title: "Portada" })).toBe("Portada");
        expect(featuredMediaSummary({ id: 4, sourceUrl: "/uploads/2026/a.jpg" })).toBe("a.jpg");
        expect(featuredMediaSummary({ id: 4 })).toBe("#4");
        expect(featuredMediaSummary(undefined)).toBe("Sin imagen destacada");
    });
});

/* ------------------------------------------------------------------ */
/* Extracto.                                                           */
/* ------------------------------------------------------------------ */

describe("resolveExcerptForSave — el extracto solo viaja si el autor lo cambió", () => {
    it("no manda la clave cuando no ha cambiado", () => {
        // La API devuelve `postExcerpt || generateExcerpt(content)`: reenviar un extracto DERIVADO
        // lo congelaría como extracto almacenado y dejaría de seguir al contenido.
        expect(resolveExcerptForSave({ current: "Resumen automático…", seeded: "Resumen automático…" })).toBeUndefined();
    });

    it("manda el texto nuevo cuando el autor lo escribe", () => {
        expect(resolveExcerptForSave({ current: "Mi resumen", seeded: "" })).toBe("Mi resumen");
    });

    it("un root sin la prop equivale a cadena vacía (no dispara un envío fantasma)", () => {
        expect(resolveExcerptForSave({ current: undefined, seeded: "" })).toBeUndefined();
        expect(resolveExcerptForSave({ current: 123, seeded: "" })).toBeUndefined();
    });

    it("vaciarlo SÍ se manda (que el backend lo ignore es limitación suya, no nuestra)", () => {
        expect(resolveExcerptForSave({ current: "", seeded: "Algo" })).toBe("");
    });
});

/* ------------------------------------------------------------------ */
/* Categoría.                                                          */
/* ------------------------------------------------------------------ */

describe("resolveCategoryId — el backend quiere IDs de término", () => {
    it("resuelve por id", () => {
        expect(resolveCategoryId("7", CATS)).toBe(7);
        expect(resolveCategoryId(7, CATS)).toBe(7);
    });

    it("resuelve el NOMBRE que guardaba el control viejo (y el slug), sin distinguir mayúsculas", () => {
        expect(resolveCategoryId("Noticias", CATS)).toBe(3);
        expect(resolveCategoryId("  noticias ", CATS)).toBe(3);
        expect(resolveCategoryId("tutoriales", CATS)).toBe(7);
    });

    it("null cuando no casa con NADA — jamás se adivina un término", () => {
        expect(resolveCategoryId("Categoría borrada", CATS)).toBeNull();
        expect(resolveCategoryId("999", CATS)).toBeNull();
        expect(resolveCategoryId("", CATS)).toBeNull();
    });
});

describe("resolveCategoriesForSave — nunca borrar términos que el editor no puede ver", () => {
    it("sin cambios NO manda `categories` (setTerms REEMPLAZA, y la API no devuelve los términos)", () => {
        expect(resolveCategoriesForSave({ current: "3", seeded: "3", categories: CATS })).toBeUndefined();
        expect(resolveCategoriesForSave({ current: "", seeded: "", categories: CATS })).toBeUndefined();
    });

    it("elegir una categoría manda su ID numérico", () => {
        expect(resolveCategoriesForSave({ current: "7", seeded: "", categories: CATS })).toEqual([7]);
    });

    it("migra un valor legacy por nombre al id al cambiarlo", () => {
        expect(resolveCategoriesForSave({ current: "Noticias", seeded: "", categories: CATS })).toEqual([3]);
    });

    it("vaciar la selección manda [] (desasignar es una intención legítima)", () => {
        expect(resolveCategoriesForSave({ current: "", seeded: "3", categories: CATS })).toEqual([]);
    });

    it("un valor irresoluble no manda nada en vez de mandar basura", () => {
        expect(resolveCategoriesForSave({ current: "fantasma", seeded: "3", categories: CATS })).toBeUndefined();
        expect(resolveCategoriesForSave({ current: "3", seeded: "", categories: [] })).toBeUndefined();
    });
});

describe("categoryField — el select guarda ids, y no esconde lo que hay guardado", () => {
    it("una opción por categoría, con el id como valor", () => {
        const f = categoryField(CATS) as unknown as { type: string; options: Array<{ label: string; value: string }> };
        expect(f.type).toBe("select");
        expect(f.options).toEqual([
            { label: "Sin categoría", value: "" },
            { label: "Noticias", value: "3" },
            { label: "Tutoriales", value: "7" },
        ]);
    });

    it("SINTETIZA la opción de un valor guardado que ya no casa (el nombre del control viejo)", () => {
        const f = categoryField(CATS, "Categoría borrada") as unknown as { options: Array<{ label: string; value: string }> };
        expect(f.options.at(-1)).toEqual({ label: "Categoría borrada (sin asignar)", value: "Categoría borrada" });
    });

    it("un valor que YA casa no se duplica", () => {
        const f = categoryField(CATS, "3") as unknown as { options: Array<{ value: string }> };
        expect(f.options.filter((o) => o.value === "3")).toHaveLength(1);
    });
});

/* ------------------------------------------------------------------ */
/* Composición de los campos ROOT.                                     */
/* ------------------------------------------------------------------ */

describe("withRecordRootFields — composición sobre los campos del registro", () => {
    it("ENTRADAS: añade imagen destacada y extracto tras el slug y conserva todo lo demás", () => {
        const fields = withRecordRootFields(rootFieldsPost, { categories: CATS });
        expect(Object.keys(fields)).toEqual([
            "title",
            "slug",
            "featuredImage",
            "excerpt",
            "category",
            "allowComments",
            "_wjs_template",
            "seo_title",
            "seo_description",
            "og_image",
            "noindex",
        ]);
        expect(fields.featuredImage.type).toBe("external");
        expect(fields.excerpt.type).toBe("textarea");
        // Los campos del registro llegan intactos (misma referencia).
        expect(fields.allowComments).toBe(rootFieldsPost.allowComments);
    });

    it("PÁGINAS: los mismos dos campos, y NINGUNA categoría — la asimetría del CMS se respeta", () => {
        const fields = withRecordRootFields(rootFieldsPage);
        expect(Object.keys(fields)).toEqual(["title", "slug", "featuredImage", "excerpt", "_wjs_template"]);
        expect(fields.category).toBeUndefined();
    });

    it("NO muta los objetos del registro (el gate anti-drift compara sus claves)", () => {
        const before = Object.keys(rootFieldsPost);
        withRecordRootFields(rootFieldsPost, { categories: CATS });
        expect(Object.keys(rootFieldsPost)).toEqual(before);
        expect(rootFieldsPost.featuredImage).toBeUndefined();
        expect(rootFieldsPage.excerpt).toBeUndefined();
    });

    it("la categoría solo se sustituye cuando hay lista cargada (si falla el fetch, el campo del registro sigue)", () => {
        const fields = withRecordRootFields(rootFieldsPost);
        expect(fields.category).toBe(rootFieldsPost.category);
    });

    it("sin `slug` los campos nuevos van al final, no se pierden", () => {
        const fields = withRecordRootFields({ title: { type: "text", label: "Title" } as VersoField });
        expect(Object.keys(fields)).toEqual(["title", "featuredImage", "excerpt"]);
    });

    it("es idempotente: recomponer no duplica ni acumula", () => {
        const once = withRecordRootFields(rootFieldsPost, { categories: CATS });
        expect(Object.keys(withRecordRootFields(once, { categories: CATS }))).toEqual(Object.keys(once));
    });

    it("el campo external declara el mapProp que valida lo que elige el picker", () => {
        const f = withRecordRootFields(rootFieldsPage).featuredImage as unknown as {
            mapProp: (v: unknown) => unknown;
            getItemSummary: (v: unknown) => string;
        };
        expect(f.mapProp({ id: 3, sourceUrl: "/uploads/z.png", title: "Z" })).toEqual({
            id: 3,
            url: "/uploads/z.png",
            title: "Z",
        });
        expect(f.getItemSummary({ id: 3, title: "Z" })).toBe("Z");
    });
});

/* ------------------------------------------------------------------ */
/* Siembra.                                                            */
/* ------------------------------------------------------------------ */

describe("seedRootPropsFromPost — reabrir enseña lo que hay en la BD", () => {
    it("devuelve la imagen y el extracto del registro cargado", () => {
        const post = {
            id: 1,
            excerpt: "Resumen guardado",
            featuredMedia: { id: 8, url: "/uploads/x.jpg", title: "X" },
        } as unknown as Post;
        expect(seedRootPropsFromPost(post)).toEqual({
            featuredImage: { id: 8, url: "/uploads/x.jpg", title: "X" },
            excerpt: "Resumen guardado",
        });
    });

    it("devuelve las claves SIEMPRE, para pisar un _puck_data viejo que enseñaba otra portada", () => {
        const seed = seedRootPropsFromPost({ id: 1 } as unknown as Post);
        expect(Object.keys(seed).sort()).toEqual(["excerpt", "featuredImage"]);
        expect(seed.featuredImage).toBeUndefined();
        expect(seed.excerpt).toBe("");
        // El spread debe BORRAR la imagen fantasma del _puck_data, no conservarla.
        const merged = { ...{ featuredImage: { id: 99 }, title: "T" }, ...seed };
        expect(merged.featuredImage).toBeUndefined();
        expect(merged.title).toBe("T");
    });
});

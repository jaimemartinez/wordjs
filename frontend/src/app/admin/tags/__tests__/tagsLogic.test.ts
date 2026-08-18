/**
 * Lógica de la pantalla de etiquetas: qué borrador es válido, qué viaja en el cuerpo y a qué página
 * saltar tras un borrado. Todo puro (vitest, entorno node — el repo no tiene jsdom).
 */
import { describe, it, expect } from "vitest";
import {
    TAG_NAME_MAX,
    emptyTagDraft,
    normalizeTagName,
    normalizeTagSlug,
    pageAfterDelete,
    suggestSlug,
    tagCreatePayload,
    tagUpdatePayload,
    validateTagDraft,
    type TagLike,
} from "../tagsLogic";

const EXISTING: TagLike[] = [
    { id: 1, name: "Noticias", slug: "noticias" },
    { id: 2, name: "Tutoriales", slug: "tutoriales" },
];

/* ------------------------------------------------------------------ */
/* Normalización.                                                      */
/* ------------------------------------------------------------------ */

describe("normalizeTagName", () => {
    it("recorta y colapsa los espacios interiores", () => {
        expect(normalizeTagName("  dos   palabras \n")).toBe("dos palabras");
    });

    it("null/undefined son la cadena vacía, no 'null'", () => {
        expect(normalizeTagName(null)).toBe("");
        expect(normalizeTagName(undefined)).toBe("");
    });
});

describe("normalizeTagSlug", () => {
    it("recorta y baja a minúsculas", () => {
        expect(normalizeTagSlug("  Mi-Slug  ")).toBe("mi-slug");
    });
});

describe("suggestSlug — solo para ENSEÑAR el slug previsto", () => {
    it("quita los acentos y une con guiones", () => {
        expect(suggestSlug("Programación Avanzada")).toBe("programacion-avanzada");
    });

    it("no deja guiones colgando en los extremos", () => {
        expect(suggestSlug("  ¡Hola!  ")).toBe("hola");
    });

    it("un nombre sin letras ASCII se queda vacío (que el backend lo derive)", () => {
        expect(suggestSlug("...")).toBe("");
    });
});

/* ------------------------------------------------------------------ */
/* Validación.                                                         */
/* ------------------------------------------------------------------ */

describe("validateTagDraft", () => {
    it("acepta un borrador con solo nombre", () => {
        expect(validateTagDraft({ name: "Recetas", slug: "", description: "" }, EXISTING)).toBeNull();
    });

    it("rechaza el nombre vacío (y el que solo tiene espacios)", () => {
        expect(validateTagDraft({ name: "   ", slug: "", description: "" }, EXISTING)).toBe("empty");
    });

    it("rechaza un nombre por encima del límite", () => {
        const long = "a".repeat(TAG_NAME_MAX + 1);
        expect(validateTagDraft({ name: long, slug: "", description: "" }, EXISTING)).toBe("tooLong");
    });

    it("LISTA BLANCA del slug: nada de mayúsculas, espacios, barras ni caracteres exóticos", () => {
        const rejected = ["Con Mayúsculas", "con espacio", "con/barra", "-empieza", "termina-", "doble--guion", "<script>"];
        for (const slug of rejected) {
            expect(validateTagDraft({ name: "Ok", slug, description: "" }, EXISTING), slug).toBe("slugInvalid");
        }
    });

    it("acepta el slug que sí pasa la lista blanca", () => {
        expect(validateTagDraft({ name: "Ok", slug: "un-slug-2", description: "" }, EXISTING)).toBeNull();
    });

    it("caza el nombre duplicado sin importar mayúsculas ni espacios de más", () => {
        expect(validateTagDraft({ name: "  noticias ", slug: "", description: "" }, EXISTING)).toBe("duplicateName");
    });

    it("caza el slug duplicado", () => {
        expect(validateTagDraft({ name: "Otra cosa", slug: "tutoriales", description: "" }, EXISTING)).toBe("duplicateSlug");
    });

    it("al renombrar, una etiqueta NO choca consigo misma", () => {
        expect(validateTagDraft({ name: "Noticias", slug: "noticias", description: "x" }, EXISTING, 1)).toBeNull();
    });

    it("al renombrar sí choca con OTRA", () => {
        expect(validateTagDraft({ name: "Tutoriales", slug: "", description: "" }, EXISTING, 1)).toBe("duplicateName");
    });
});

/* ------------------------------------------------------------------ */
/* Cuerpos de petición.                                                */
/* ------------------------------------------------------------------ */

describe("tagCreatePayload", () => {
    it("un slug vacío NO viaja: mandar '' pondría un slug vacío en vez de derivarlo", () => {
        expect(tagCreatePayload({ name: "  Recetas  ", slug: "  ", description: "  " })).toEqual({ name: "Recetas" });
    });

    it("cuando hay slug y descripción, viajan normalizados", () => {
        expect(tagCreatePayload({ name: "Recetas", slug: " Recetas-Ricas ", description: " Comida " })).toEqual({
            name: "Recetas",
            slug: "recetas-ricas",
            description: "Comida",
        });
    });
});

describe("tagUpdatePayload — solo lo que cambió", () => {
    const current = { name: "Noticias", slug: "noticias", description: "Actualidad" };

    it("sin cambios devuelve null (no se gasta una petición)", () => {
        expect(tagUpdatePayload({ name: "Noticias", slug: "noticias", description: "Actualidad" }, current)).toBeNull();
    });

    it("un cambio de nombre viaja solo", () => {
        expect(tagUpdatePayload({ name: "Actualidad", slug: "noticias", description: "Actualidad" }, current)).toEqual({
            name: "Actualidad",
        });
    });

    it("un slug VACIADO no borra el que había (el backend no acepta slug vacío)", () => {
        expect(tagUpdatePayload({ name: "Noticias", slug: "", description: "Actualidad" }, current)).toBeNull();
    });

    it("una descripción VACIADA sí viaja: borrarla es una edición legítima", () => {
        expect(tagUpdatePayload({ name: "Noticias", slug: "noticias", description: "" }, current)).toEqual({ description: "" });
    });

    it("un cambio de espacios en blanco NO cuenta como cambio", () => {
        expect(tagUpdatePayload({ name: "  Noticias  ", slug: " NOTICIAS ", description: " Actualidad " }, current)).toBeNull();
    });

    it("una descripción ausente en el original cuenta como vacía", () => {
        expect(tagUpdatePayload({ name: "X", slug: "x", description: "" }, { name: "X", slug: "x" })).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* Paginación tras borrar.                                             */
/* ------------------------------------------------------------------ */

describe("pageAfterDelete", () => {
    it("borrar la ÚLTIMA fila de una página posterior retrocede una página", () => {
        expect(pageAfterDelete(1, 3)).toBe(2);
    });

    it("borrar la última fila de la PRIMERA página se queda en la primera", () => {
        expect(pageAfterDelete(1, 1)).toBe(1);
    });

    it("si quedan filas, no se mueve", () => {
        expect(pageAfterDelete(7, 3)).toBe(3);
    });
});

describe("emptyTagDraft", () => {
    it("devuelve un objeto NUEVO cada vez (no se comparte el estado entre formularios)", () => {
        const a = emptyTagDraft();
        const b = emptyTagDraft();
        expect(a).toEqual({ name: "", slug: "", description: "" });
        expect(a).not.toBe(b);
    });
});

/**
 * Lógica PURA de la pantalla de etiquetas (/admin/tags).
 *
 * Vive fuera de page.tsx a propósito: el repo no tiene jsdom ni @testing-library, así que todo lo
 * que decide algo — qué es un borrador válido, qué viaja en el cuerpo, a qué página saltar tras un
 * borrado — se declara aquí como funciones sin React y se prueba en node (vitest, entorno node).
 *
 * Contrato con el backend, LEÍDO en backend/src/routes/tags.ts, no supuesto:
 *  - POST /tags exige `name`; `slug` y `description` son opcionales (el modelo deriva el slug del
 *    nombre cuando no se manda). Un `slug` vacío NO se manda: mandar '' pondría un slug vacío.
 *  - PUT /tags/:id acepta name/slug/description sueltos.
 *  - Un nombre o slug repetido devuelve 400 `rest_term_exists`. Lo validamos ADEMÁS aquí para dar el
 *    aviso antes del viaje, pero el servidor sigue siendo la autoridad (esta lista está paginada:
 *    un duplicado en otra página solo lo caza el backend).
 */

/** Lo que el formulario tiene en la mano (creación o renombrado). */
export interface TagDraft {
    name: string;
    slug: string;
    description: string;
}

/** Motivo por el que un borrador no se puede enviar. `null` = enviable. */
export type TagDraftError =
    | "empty"          // sin nombre
    | "tooLong"        // nombre por encima del límite
    | "slugInvalid"    // el slug escrito a mano no pasa la lista blanca
    | "duplicateName"  // ya hay una etiqueta con ese nombre en la página cargada
    | "duplicateSlug"  // ídem por slug
    | null;

/** Lo mínimo que necesitamos de una etiqueta ya existente para detectar duplicados. */
export interface TagLike {
    id: number;
    name: string;
    slug: string;
}

export const TAG_NAME_MAX = 200;

/**
 * LISTA BLANCA del slug escrito a mano: minúsculas ASCII, dígitos y guiones simples interiores.
 * El slug acaba en una URL pública (/tag/<slug>) y en una consulta, así que aquí no entra nada que
 * no sea exactamente esto — preferimos rechazar y que el autor lo deje vacío (el backend lo deriva).
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Marcas diacríticas combinantes (el bloque U+0300–U+036F que deja `normalize("NFD")`). Se construye
 * desde escapes en vez de escribirse como literal: en el fichero serían caracteres INVISIBLES, y ya
 * hemos perdido un rango así una vez a manos de una herramienta que reescribió la codificación.
 */
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/** Colapsa espacios y recorta. Un nombre es TEXTO: nunca se interpreta como marcado en ningún sitio. */
export function normalizeTagName(raw: unknown): string {
    return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/** Normaliza el slug tal cual lo escribió el autor (minúsculas, sin espacios sobrantes). */
export function normalizeTagSlug(raw: unknown): string {
    return String(raw ?? "").trim().toLowerCase();
}

/**
 * Sugerencia de slug a partir del nombre — SOLO para enseñar al autor qué saldrá. No se manda: quien
 * decide el slug definitivo cuando el campo va vacío es el backend.
 */
export function suggestSlug(name: unknown): string {
    return normalizeTagName(name)
        .toLowerCase()
        .normalize("NFD")
        .replace(COMBINING_MARKS, "") // quita los diacriticos ya descompuestos
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Valida un borrador contra las etiquetas ya cargadas.
 * @param existing  las etiquetas de la lista visible (la comprobación es de cortesía, ver cabecera).
 * @param editingId el id que se está renombrando, para no chocar consigo mismo.
 */
export function validateTagDraft(
    draft: TagDraft,
    existing: readonly TagLike[] = [],
    editingId: number | null = null,
): TagDraftError {
    const name = normalizeTagName(draft.name);
    if (!name) return "empty";
    if (name.length > TAG_NAME_MAX) return "tooLong";

    const slug = normalizeTagSlug(draft.slug);
    if (slug && !SLUG_RE.test(slug)) return "slugInvalid";

    const others = existing.filter((tag) => tag.id !== editingId);
    const lowerName = name.toLowerCase();
    if (others.some((tag) => normalizeTagName(tag.name).toLowerCase() === lowerName)) return "duplicateName";
    if (slug && others.some((tag) => normalizeTagSlug(tag.slug) === slug)) return "duplicateSlug";

    return null;
}

/**
 * Cuerpo de POST /tags. Las claves opcionales solo viajan cuando tienen contenido: mandar `slug: ''`
 * no es «derívalo tú», es «ponlo vacío».
 */
export function tagCreatePayload(draft: TagDraft): { name: string; slug?: string; description?: string } {
    const name = normalizeTagName(draft.name);
    const slug = normalizeTagSlug(draft.slug);
    const description = String(draft.description ?? "").trim();
    return {
        name,
        ...(slug ? { slug } : {}),
        ...(description ? { description } : {}),
    };
}

/**
 * Cuerpo de PUT /tags/:id: SOLO lo que cambió respecto de la etiqueta cargada. Devuelve `null`
 * cuando no cambió nada, para no gastar una petición (y no tocar `count` ni la fecha por gusto).
 *
 * `description` sí puede viajar vacía: vaciarla es una edición legítima, al contrario que el slug.
 */
export function tagUpdatePayload(
    draft: TagDraft,
    current: { name: string; slug: string; description?: string },
): { name?: string; slug?: string; description?: string } | null {
    const patch: { name?: string; slug?: string; description?: string } = {};

    const name = normalizeTagName(draft.name);
    if (name && name !== normalizeTagName(current.name)) patch.name = name;

    const slug = normalizeTagSlug(draft.slug);
    if (slug && slug !== normalizeTagSlug(current.slug)) patch.slug = slug;

    const description = String(draft.description ?? "").trim();
    if (description !== String(current.description ?? "").trim()) patch.description = description;

    return Object.keys(patch).length ? patch : null;
}

/**
 * A qué página ir después de borrar una fila: si era la ÚLTIMA de una página que no es la primera,
 * esa página deja de existir y hay que retroceder; si no, se queda donde está.
 */
export function pageAfterDelete(rowsOnPage: number, page: number): number {
    return rowsOnPage <= 1 && page > 1 ? page - 1 : page;
}

/** El borrador vacío con el que arranca (y al que vuelve) el formulario. */
export function emptyTagDraft(): TagDraft {
    return { name: "", slug: "", description: "" };
}

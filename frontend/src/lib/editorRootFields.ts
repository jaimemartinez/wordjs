/**
 * Campos ROOT de REGISTRO (no de bloque): imagen destacada, extracto y categoría.
 *
 * POR QUÉ ESTE MÓDULO Y NO `coreBlocks.rootFieldsPost/rootFieldsPage`: esos dos objetos están bajo un
 * gate anti-drift (verso-coreBlocks.test.ts) que compara sus claves UNA A UNA con las del registro
 * legacy `versoConfig.postConfig/pageConfig.root.fields`; añadir claves allí pone el gate en rojo y
 * el registro legacy no es nuestro para tocar. Además estos tres campos NO son del registro de
 * bloques: son el contrato del EDITOR con la API de posts (meta `_thumbnail_id`, columna `excerpt`,
 * taxonomía `category`), la misma familia que `editorGuards.resolveWjsTemplateForSave`. Por eso se
 * COMPONEN en el punto de montaje: `withRecordRootFields(rootFieldsPost, …)`.
 *
 * Todo lo de aquí es PURO (sin React, sin fetch, sin imports en runtime) para poder testearlo en
 * node — el repo no tiene jsdom.
 *
 * Contrato con el backend, verificado en el código, no supuesto:
 *  - IMAGEN DESTACADA → meta `_thumbnail_id` (Post.getFeaturedImage lo resuelve; toJSON lo serializa
 *    como `featuredMedia:{id,url,title}`). Se manda SIEMPRE, igual que `_wjs_template`: '' es la
 *    única forma de BORRAR una asignación previa (omitir la clave la dejaría fija para siempre).
 *  - EXTRACTO → columna `excerpt` del body (routes/posts.ts la sanea en create y update).
 *  - CATEGORÍA → array `categories` del body; `Post.setTerms` consulta `term_id IN (…)`, o sea que
 *    espera IDs NUMÉRICOS de término (no nombres ni slugs). De ahí que el select guarde el id.
 */
import type { Category, Post } from "@/lib/api";
import type { VersoField } from "@/lib/verso/registry";

/** Lo que el campo `featuredImage` guarda en `root.props` (y viaja dentro de `_puck_data`). */
export interface FeaturedMediaRef {
    id: number;
    url?: string;
    title?: string;
}

/* ------------------------------------------------------------------ */
/* Imagen destacada.                                                   */
/* ------------------------------------------------------------------ */

/** Id de media válido: entero positivo (venga como número o como string numérico). */
function toMediaId(raw: unknown): number | null {
    const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * URL de media ACEPTABLE. Solo rutas relativas (`/uploads/…`) o http(s) absolutas: el valor acaba en
 * `_puck_data` y podría llegar a un `src`, así que ni `javascript:` ni `data:` ni nada exótico.
 */
function safeMediaUrl(raw: unknown): string | undefined {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url) return undefined;
    if (url.startsWith("/") && !url.startsWith("//")) return url;
    if (/^https?:\/\//i.test(url)) return url;
    return undefined;
}

/**
 * MediaItem del picker (o cualquier cosa) → la referencia mínima que guardamos. `undefined` si no hay
 * un id usable: preferimos vaciar el campo antes que guardar basura que luego se mande como meta.
 */
export function toFeaturedMediaRef(item: unknown): FeaturedMediaRef | undefined {
    if (!item || typeof item !== "object") {
        const bare = toMediaId(item);
        return bare === null ? undefined : { id: bare };
    }
    const src = item as Record<string, unknown>;
    const id = toMediaId(src.id);
    if (id === null) return undefined;
    // sourceUrl es RELATIVA; guid incrusta el host de subida (ver media-url-relative-not-guid).
    const url = safeMediaUrl(src.sourceUrl) ?? safeMediaUrl(src.url) ?? safeMediaUrl(src.guid);
    const title = typeof src.title === "string" ? src.title.slice(0, 200) : undefined;
    return { id, ...(url ? { url } : {}), ...(title ? { title } : {}) };
}

/** Texto que el control `external` muestra cuando hay selección. */
export function featuredMediaSummary(item: unknown): string {
    const ref = toFeaturedMediaRef(item);
    if (!ref) return "Sin imagen destacada";
    if (ref.title) return ref.title;
    if (ref.url) return ref.url.split("/").pop() || `#${ref.id}`;
    return `#${ref.id}`;
}

/**
 * Valor de la meta `_thumbnail_id` a mandar. '' BORRA la asignación (getFeaturedImage devuelve null
 * con cualquier valor falsy), y solo emitimos un entero positivo — nunca el string del autor.
 */
export function featuredImageMetaValue(rootProps: Record<string, unknown> | undefined | null): string {
    const ref = toFeaturedMediaRef(rootProps?.featuredImage);
    return ref ? String(ref.id) : "";
}

/** La imagen destacada REAL del registro cargado: la API manda `featuredMedia`; meta como respaldo. */
export function featuredMediaFromPost(post: Post | undefined | null): FeaturedMediaRef | undefined {
    if (!post) return undefined;
    const fromApi = toFeaturedMediaRef(post.featuredMedia);
    if (fromApi) return fromApi;
    // Respaldo: la meta cruda (un adjunto borrado deja el id sin `featuredMedia` que lo acompañe).
    return toFeaturedMediaRef(post.meta?._thumbnail_id);
}

/* ------------------------------------------------------------------ */
/* Extracto.                                                           */
/* ------------------------------------------------------------------ */

/**
 * Extracto a mandar en el body, o `undefined` para NO mandar la clave.
 *
 * FAIL-CLOSED igual que la categoría, y por una razón concreta: `toJSON` devuelve
 * `postExcerpt || generateExcerpt(postContent)`, o sea que un registro SIN extracto propio nos
 * entrega uno DERIVADO del cuerpo. Si lo mandásemos tal cual, el primer guardado congelaría ese
 * resumen automático como extracto almacenado y dejaría de seguir al contenido. Solo viaja cuando el
 * autor lo cambió.
 *
 * LIMITACIÓN CONOCIDA (del backend, no de aquí): `routes/posts.ts` hace `excerpt ? sanitize… :
 * undefined`, así que un extracto VACIADO no se puede borrar por la API — se manda '' y la columna
 * se queda como estaba.
 */
export function resolveExcerptForSave(args: { current: unknown; seeded: unknown }): string | undefined {
    const current = typeof args.current === "string" ? args.current : "";
    const seeded = typeof args.seeded === "string" ? args.seeded : "";
    return current === seeded ? undefined : current;
}

/* ------------------------------------------------------------------ */
/* Categoría.                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resuelve el valor guardado a un ID de término REAL de la lista cargada. Acepta el id (el formato
 * nuevo) y, por compatibilidad, el NOMBRE o el slug que guardaba el control viejo. `null` = no se
 * puede resolver: quien llama JAMÁS debe adivinar con eso.
 */
export function resolveCategoryId(value: unknown, categories: readonly Category[]): number | null {
    const raw = typeof value === "number" ? String(value) : String(value ?? "").trim();
    if (!raw) return null;
    const asId = Number(raw);
    if (Number.isInteger(asId) && asId > 0) {
        const byId = categories.find((c) => c.id === asId);
        if (byId) return byId.id;
    }
    const lower = raw.toLowerCase();
    const byName = categories.find((c) => (c.name || "").trim().toLowerCase() === lower);
    if (byName) return byName.id;
    const bySlug = categories.find((c) => (c.slug || "").trim().toLowerCase() === lower);
    return bySlug ? bySlug.id : null;
}

/**
 * El array `categories` del body — o `undefined` para NO TOCAR la taxonomía.
 *
 * FAIL-CLOSED a propósito: hoy ninguna ruta de la API devuelve los términos de un post
 * (`toJSON` no los serializa), así que el editor no puede saber qué categorías tiene un registro que
 * se etiquetó por importación o por API. Si el autor no tocó el select, no mandamos nada y esos
 * términos quedan intactos; `setTerms` REEMPLAZA, y mandar la selección de un campo que nunca se
 * sembró borraría lo que hay.
 */
export function resolveCategoriesForSave(args: {
    current: unknown;
    seeded: unknown;
    categories: readonly Category[];
}): number[] | undefined {
    const current = typeof args.current === "number" ? String(args.current) : String(args.current ?? "").trim();
    const seeded = typeof args.seeded === "number" ? String(args.seeded) : String(args.seeded ?? "").trim();
    if (current === seeded) return undefined; // el autor no tocó la categoría
    if (!current) return []; // la vació explícitamente
    const id = resolveCategoryId(current, args.categories);
    return id === null ? undefined : [id];
}

/* ------------------------------------------------------------------ */
/* Composición de los campos ROOT.                                     */
/* ------------------------------------------------------------------ */

const featuredImageField: VersoField = {
    type: "external",
    label: "Imagen destacada",
    placeholder: "Sin imagen destacada",
    // El picker se INYECTA (VersoEditor pasa MediaPickerModal como renderExternalPicker), así que
    // ExternalControl nunca llama a fetchList; el contrato del tipo la exige igualmente.
    fetchList: async () => null,
    mapProp: (item: unknown) => toFeaturedMediaRef(item),
    getItemSummary: (item: unknown) => featuredMediaSummary(item),
};

const excerptField: VersoField = {
    type: "textarea",
    label: "Extracto",
    placeholder: "Resumen breve (listados y descripción SEO)",
};

/** Select de categorías con el ID como valor — que es lo que `Post.setTerms` espera. */
export function categoryField(categories: readonly Category[], currentValue?: unknown): VersoField {
    const options: Array<{ label: string; value: string }> = [
        { label: "Sin categoría", value: "" },
        ...categories.map((c) => ({ label: c.name, value: String(c.id) })),
    ];
    // Un valor guardado que no case con ninguna opción (el NOMBRE que guardaba el control viejo, o
    // una categoría borrada) se sintetiza como opción visible en vez de desaparecer del select —
    // mismo criterio que TemplateField con una plantilla que el tema ya no trae.
    const current = typeof currentValue === "number" ? String(currentValue) : String(currentValue ?? "").trim();
    if (current && !options.some((o) => o.value === current)) {
        options.push({ label: `${current} (sin asignar)`, value: current });
    }
    return { type: "select", label: "Categoría", options };
}

/**
 * Los campos ROOT del editor: los del registro (`rootFieldsPost`/`rootFieldsPage`) MÁS imagen
 * destacada y extracto, con la categoría sustituida por el select por ID cuando existe.
 *
 * Orden: los nuevos entran justo detrás de `slug` (o al final si no lo hay), para que el inspector
 * ponga identidad → presentación → resto sin reordenar nada de lo que ya había.
 */
export function withRecordRootFields(
    base: Record<string, VersoField>,
    opts: { categories?: readonly Category[]; currentCategory?: unknown; seo?: boolean } = {},
): Record<string, VersoField> {
    const out: Record<string, VersoField> = {};
    let inserted = false;
    const insert = () => {
        out.featuredImage = featuredImageField;
        out.excerpt = excerptField;
        inserted = true;
    };
    for (const [key, field] of Object.entries(base)) {
        if (key === "category" && opts.categories) {
            out.category = categoryField(opts.categories, opts.currentCategory);
        } else if (key !== "featuredImage" && key !== "excerpt") {
            out[key] = field;
        }
        if (key === "slug") insert();
    }
    if (!inserted) insert();
    // SEO al final, y solo si el registro base no lo trae ya (entradas SÍ lo traen, páginas no).
    if (opts.seo) {
        for (const [key, field] of Object.entries(seoFields)) {
            if (!(key in out)) out[key] = field;
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Siembra desde el registro cargado.                                  */
/* ------------------------------------------------------------------ */

/**
 * Props ROOT que la CARGA impone sobre lo que traiga `_puck_data`: la BD manda. Las claves se
 * devuelven SIEMPRE (con `undefined` cuando no hay valor) para que un `_puck_data` viejo con una
 * imagen que ya no está no siga enseñándola.
 */
export function seedRootPropsFromPost(post: Post | undefined | null): {
    featuredImage: FeaturedMediaRef | undefined;
    excerpt: string;
} {
    return {
        featuredImage: featuredMediaFromPost(post),
        excerpt: typeof post?.excerpt === "string" ? post.excerpt : "",
    };
}

/* ------------------------------------------------------------------ */
/* SEO (título, descripción, imagen social, noindex).                  */
/* ------------------------------------------------------------------ */

/**
 * POR QUÉ ESTO EXISTE. El editor de entradas MANDA `meta.seo_title/seo_description/og_image/noindex`
 * en CADA guardado, leyéndolos de `root.props` — pero la carga NUNCA los sembraba desde la meta: solo
 * llegaban si venían dentro de `_puck_data`. O sea que un registro cuyo SEO se puso por la API, por
 * importación WXR o por un plugin perdía esos cuatro valores en el primer guardado del editor, en
 * silencio. Con `buildPostMetadata` honrando ya los overrides (y el sitemap el `noindex`), ese borrado
 * dejó de ser cosmético: cambia el <title> real y puede volver a listar una página oculta a propósito.
 *
 * Mismo criterio que `_wjs_template` y que la imagen destacada: la META MANDA sobre `_puck_data`.
 */
export const SEO_META_KEYS = ["seo_title", "seo_description", "og_image", "noindex"] as const;

/** Props ROOT del SEO tal y como las esperan los campos del inspector (el radio guarda strings). */
export interface SeoRootProps {
    seo_title: string;
    seo_description: string;
    og_image: string;
    /** El radio de "ocultar a buscadores" tiene opciones "true"/"false" — strings, no booleanos. */
    noindex: "true" | "false";
}

/** Texto de una meta que puede llegar como string o como número ya parseado por `getOption`. */
function metaTextValue(raw: unknown): string {
    if (typeof raw === "string") return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
    return "";
}

/**
 * ¿Esta meta dice "no indexes"? FAIL-OPEN a propósito, igual que el lector de `server-api.metaFlag` y
 * el del sitemap: de un valor irreconocible NO se deduce "oculto", porque eso des-listaría en silencio
 * una página viva. Se acepta el booleano (lo que escribe este editor) y las grafías que dejan la API,
 * una importación o un plugin.
 */
export function isNoindexMetaValue(raw: unknown): boolean {
    if (raw === true || raw === 1) return true;
    const v = metaTextValue(raw).toLowerCase();
    return v === "true" || v === "1" || v === "yes" || v === "on";
}

/**
 * Los cuatro props ROOT de SEO derivados de la meta del registro. Se devuelven SIEMPRE las cuatro
 * claves (con '' / "false" cuando no hay nada) para que la siembra pise de forma determinista lo que
 * traiga un `_puck_data` viejo, en vez de dejar una mezcla de las dos fuentes.
 */
export function seedSeoRootProps(post: Post | undefined | null): SeoRootProps {
    const meta = (post?.meta ?? {}) as Record<string, unknown>;
    return {
        seo_title: metaTextValue(meta.seo_title),
        seo_description: metaTextValue(meta.seo_description),
        og_image: metaTextValue(meta.og_image),
        noindex: isNoindexMetaValue(meta.noindex) ? "true" : "false",
    };
}

/**
 * La meta de SEO a mandar en el body, tomada de `root.props` y normalizada. Existía ya inline en el
 * editor de entradas; aquí es una función para que ENTRADAS y PÁGINAS emitan exactamente lo mismo y
 * un solo test cubra las dos.
 */
export function seoMetaForSave(rootProps: Record<string, unknown> | undefined | null): {
    seo_title: string;
    seo_description: string;
    og_image: string;
    noindex: boolean;
} {
    const props = rootProps ?? {};
    return {
        seo_title: metaTextValue(props.seo_title),
        seo_description: metaTextValue(props.seo_description),
        og_image: metaTextValue(props.og_image),
        noindex: isNoindexMetaValue(props.noindex),
    };
}

/**
 * Campos SEO del inspector. Son los MISMOS cuatro que `rootFieldsPost` declara en el registro legacy,
 * replicados aquí (no importados) porque este módulo es puro y `coreBlocks.tsx` arrastra React. Se
 * componen solo donde el registro no los trae ya — hoy, PÁGINAS: `buildPostMetadata` y el sitemap
 * honran esa meta también en páginas, pero `rootFieldsPage` no tenía con qué escribirla.
 */
const seoFields: Record<string, VersoField> = {
    seo_title: { type: "text", label: "🔍 Título SEO (máx. 60 caracteres)" },
    seo_description: { type: "textarea", label: "🔍 Meta descripción (máx. 160 caracteres)" },
    og_image: { type: "text", label: "🔍 URL de la imagen social" },
    noindex: {
        type: "radio",
        label: "🔍 Ocultar a los buscadores",
        options: [
            { label: "No (indexable)", value: "false" },
            { label: "Sí (oculta)", value: "true" },
        ],
    },
};

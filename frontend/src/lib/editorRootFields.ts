/**
 * Campos ROOT de REGISTRO (no de bloque): imagen destacada, extracto, categoría y etiquetas.
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
 *  - EXTRACTO → columna `excerpt` del body (routes/posts.ts la sanea en create y update). Mandar ''
 *    BORRA el extracto almacenado; omitir la clave lo deja como estaba.
 *  - CATEGORÍA → array `categories` del body; `Post.setTerms` consulta `term_id IN (…)`, o sea que
 *    espera IDs NUMÉRICOS de término (no nombres ni slugs). De ahí que el select guarde el id.
 *  - ETIQUETAS → array `tags` del body, MISMO contrato: `Post.setTerms(id, tags, 'post_tag')` también
 *    resuelve por `term_id`. Por eso el control es una lista de SELECTS sobre etiquetas existentes y
 *    no un campo de texto libre: la API de posts no crea términos, así que un nombre inventado se
 *    perdería en silencio. Crear etiquetas nuevas es cosa de la pantalla de etiquetas (`tagsApi`).
 *
 * SIEMBRA DE TAXONOMÍA (lo que arregla el agujero de raíz): `Post.toJSON` ya emite `categories` y
 * `tags`, así que el registro —no `_puck_data`— es la fuente de verdad de los dos controles, igual
 * que con la imagen destacada y el SEO. Antes de eso el editor no podía saber qué términos tenía un
 * post etiquetado por importación o por API, y como `setTerms` REEMPLAZA, cualquier control que
 * mandase su valor los habría borrado sin que nadie los llegase a ver.
 */
import type { Category, Post, PostTermRef, Tag } from "@/lib/api";
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
 * Vaciarlo SÍ funciona: `routes/posts.ts` distingue la clave ausente (no tocar) de la cadena vacía
 * (borrar), así que el '' que sale de aquí cuando el autor borra el texto vacía la columna de verdad.
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
 * Los ids de término de una lista serializada por la API (`[{id,name,slug}]`), o de una lista de ids
 * pelados. Únicos, positivos y en orden de llegada — cualquier otra cosa se descarta.
 */
export function normalizeTermIds(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    const out: number[] = [];
    for (const entry of raw) {
        const value = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : entry;
        const id = typeof value === "number" ? value : Number(String(value ?? "").trim());
        if (!Number.isInteger(id) || id <= 0 || out.includes(id)) continue;
        out.push(id);
    }
    return out;
}

/** Referencias de término USABLES de lo que mande la API: sin id entero positivo no entran. */
export function toTermRefs(raw: unknown): PostTermRef[] {
    if (!Array.isArray(raw)) return [];
    const out: PostTermRef[] = [];
    const seen = new Set<number>();
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const src = entry as Record<string, unknown>;
        const id = typeof src.id === "number" ? src.id : Number(String(src.id ?? "").trim());
        if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        out.push({
            id,
            name: typeof src.name === "string" && src.name.trim() ? src.name : `#${id}`,
            slug: typeof src.slug === "string" ? src.slug : "",
        });
    }
    return out;
}

/**
 * El array `categories` del body — o `undefined` para NO TOCAR la taxonomía.
 *
 * `seeded` son AHORA los ids reales del registro (`post.categories`), no lo que arrastrase
 * `_puck_data`: un post categorizado por importación ya no se ve "sin categoría", y por tanto ya no
 * se arriesga un borrado a ciegas.
 *
 * Sigue siendo FAIL-SAFE en tres puntos, y los tres importan porque `setTerms` REEMPLAZA:
 *  1. si la selección resuelta coincide con la sembrada, no se manda la clave y la taxonomía no se toca;
 *  2. un valor que NO se puede resolver (una categoría borrada, o el nombre que guardaba el control
 *     viejo sin equivalente vivo) no se adivina: no se manda nada;
 *  3. el select sólo enseña UNA categoría — la primera —, así que las demás del registro se REENVÍAN
 *     junto a la nueva elección en vez de desaparecer. Asignar varias categorías no es algo que esta
 *     pantalla ofrezca; destruir las que ya había, tampoco.
 */
export function resolveCategoriesForSave(args: {
    current: unknown;
    /** Ids del registro, o la lista `[{id,…}]` tal cual la manda la API. El primero es el que se enseña. */
    seeded: unknown;
    categories: readonly Category[];
}): number[] | undefined {
    const seededIds = normalizeTermIds(args.seeded);
    const seededPrimary = seededIds.length ? seededIds[0] : null;
    const current = typeof args.current === "number" ? String(args.current) : String(args.current ?? "").trim();
    const resolved = current ? resolveCategoryId(current, args.categories) : null;

    if (current && resolved === null) return undefined; // (2) irresoluble: mejor no tocar nada
    if (resolved === seededPrimary) return undefined; // (1) el autor no tocó la categoría

    const rest = seededIds.filter((id) => id !== seededPrimary && id !== resolved); // (3)
    return resolved === null ? rest : [resolved, ...rest];
}

/** La categoría que el select debe enseñar al abrir el registro: la PRIMERA del post, o ninguna. */
export function seedCategoryFromPost(post: Post | undefined | null): string {
    const ids = normalizeTermIds(post?.categories);
    return ids.length ? String(ids[0]) : "";
}

/* ------------------------------------------------------------------ */
/* Etiquetas.                                                          */
/* ------------------------------------------------------------------ */

/** Una entrada del campo `array` de etiquetas: el id del término, como string (lo que guarda el select). */
export interface TagSelection {
    tag: string;
}

/** `post.tags` → el valor inicial del campo `array`. */
export function seedTagsFromPost(post: Post | undefined | null): TagSelection[] {
    return normalizeTermIds(post?.tags).map((id) => ({ tag: String(id) }));
}

/**
 * Ids de etiqueta de lo que hay en el campo `array`. Cada entrada es `{ tag: "<id>" }` porque su
 * valor SALE de un select cuyas opciones ya son ids; lo que no sea un id positivo se descarta (una
 * entrada recién añadida y aún sin elegir vale "", y no debe viajar como término).
 */
export function resolveTagIds(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    return normalizeTermIds(value.map((item) => (item && typeof item === "object" ? (item as TagSelection).tag : item)));
}

/**
 * El array `tags` del body — o `undefined` para NO TOCAR la taxonomía.
 *
 * Misma regla que las categorías: sólo viaja cuando el CONJUNTO cambió. Se compara como conjunto y no
 * como lista porque `setTerms` escribe `term_order = 0` en todas las filas, así que reordenar en el
 * panel no es un cambio que el backend pueda almacenar — mandarlo sólo gastaría una reescritura de la
 * taxonomía (y un recuento) por nada.
 */
export function resolveTagsForSave(args: { current: unknown; seeded: unknown }): number[] | undefined {
    const current = resolveTagIds(args.current);
    const seeded = resolveTagIds(args.seeded);
    const same =
        current.length === seeded.length && current.every((id) => seeded.includes(id));
    return same ? undefined : current;
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
 * Lista de etiquetas: un `array` de selects, uno por etiqueta asignada.
 *
 * POR QUÉ SELECTS Y NO TEXTO LIBRE: `Post.setTerms(id, tags, 'post_tag')` resuelve por `term_id`, y
 * `PUT /posts/:id` no crea términos. Un campo de texto aceptaría "fotografía", no habría id que
 * mandar y la etiqueta se perdería en silencio — justo el fallo que este encargo viene a cerrar. Con
 * selects, todo valor elegible ya EXISTE en la base de datos.
 *
 * Las opciones son la UNIÓN de las etiquetas cargadas y las del PROPIO registro: la lista viene
 * paginada, así que una etiqueta del post que caiga fuera de la página cargada seguiría teniendo
 * opción y no desaparecería del panel al abrirlo (que es como se borran términos sin querer).
 */
export function tagsField(available: readonly Tag[], recordTags: readonly PostTermRef[] = []): VersoField {
    const byId = new Map<string, string>();
    for (const t of available) {
        if (Number.isInteger(t.id) && t.id > 0) byId.set(String(t.id), t.name || `#${t.id}`);
    }
    for (const t of recordTags) byId.set(String(t.id), t.name || `#${t.id}`);
    const options: Array<{ label: string; value: string }> = [
        { label: "Elige una etiqueta", value: "" },
        ...[...byId.entries()]
            .map(([value, label]) => ({ label, value }))
            .sort((a, b) => a.label.localeCompare(b.label, "es")),
    ];
    return {
        type: "array",
        label: "Etiquetas",
        arrayFields: { tag: { type: "select", label: "Etiqueta", options } },
        defaultItemProps: { tag: "" },
        getItemSummary: (item: Record<string, unknown>, index?: number) => {
            const value = String(item?.tag ?? "");
            return byId.get(value) || (value ? `#${value}` : `Etiqueta ${(index ?? 0) + 1}`);
        },
    };
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
    opts: {
        categories?: readonly Category[];
        currentCategory?: unknown;
        seo?: boolean;
        /** Etiquetas existentes del sitio. Sin ellas no se compone el campo (páginas no lo llevan). */
        tags?: readonly Tag[];
        /** Las etiquetas del registro abierto, para que ninguna se quede sin opción en el select. */
        recordTags?: readonly PostTermRef[];
    } = {},
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
        } else if (key !== "featuredImage" && key !== "excerpt" && key !== "tags") {
            out[key] = field;
        }
        // Las etiquetas van pegadas a la categoría: son la otra mitad de la taxonomía del registro.
        if (key === "category" && opts.tags) out.tags = tagsField(opts.tags, opts.recordTags);
        if (key === "slug") insert();
    }
    if (!inserted) insert();
    // Un registro base sin `category` (hoy ninguno pide etiquetas) igualmente las recibe al final.
    if (opts.tags && !("tags" in out)) out.tags = tagsField(opts.tags, opts.recordTags);
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

/**
 * Props ROOT de TAXONOMÍA que la carga impone sobre `_puck_data`, más lo que el guardado necesita
 * para comparar. Va aparte de `seedRootPropsFromPost` porque el editor de PÁGINAS comparte aquella y
 * no tiene taxonomía: inyectarle `category`/`tags` sólo dejaría props muertas en su `_puck_data`.
 *
 * `categoryIds` lleva TODAS las categorías del registro (no sólo la que el select enseña) porque es
 * lo que `resolveCategoriesForSave` necesita para reenviar las que no caben en un select simple.
 */
export function seedTaxonomyRootProps(post: Post | undefined | null): {
    category: string;
    tags: TagSelection[];
    categoryIds: number[];
    tagRefs: PostTermRef[];
} {
    return {
        category: seedCategoryFromPost(post),
        tags: seedTagsFromPost(post),
        categoryIds: normalizeTermIds(post?.categories),
        tagRefs: toTermRefs(post?.tags),
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

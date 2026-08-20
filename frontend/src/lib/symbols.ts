import { apiGet, apiPost, postsApi, type Post } from "@/lib/api";

/**
 * Símbolos — componentes reutilizables estilo Figma/Webflow.
 *
 * Un símbolo es un post de tipo `wjs_symbol` (status publish) cuyo meta `_puck_data` guarda
 * `{ content: [bloques Puck...] }` — EXACTAMENTE el mismo formato con el que el editor de páginas
 * persiste su árbol (admin/pages/[id]/page.tsx handleSubmit → meta: { _puck_data }), así el backend
 * lo sanitiza por el mismo camino (core/sanitize-meta.ts) y las revisiones/exports funcionan gratis.
 *
 * El tipo `wjs_symbol` NO existe de fábrica y POST /api/v1/posts RECHAZA tipos no registrados
 * (backend/src/routes/posts.ts: capsForType(type) === null → 400 rest_invalid_post_type). El
 * backend expone un registro idempotente y PERSISTENTE de tipos custom — POST /api/v1/types
 * (routes/post-types.ts) → saveCustomPostType guarda en la option `custom_post_types` y
 * initPostTypes lo re-registra en cada boot — así que `ensureSymbolType()` lo registra al vuelo
 * la primera vez y no vuelve a hacer red en la sesión.
 *
 * GOTCHA del backend: la ruta POST /types NO hace await de saveCustomPostType (responde 201 antes
 * de que registerPostType haya corrido), así que tras registrar verificamos con GET /types/:name
 * (con reintentos cortos) antes de dar el tipo por disponible.
 */

/** Tipo de post que almacena los símbolos. */
export const SYMBOL_POST_TYPE = "wjs_symbol";

/** Nombre del bloque Puck (clave en config.components y `type` en el árbol de datos). */
export const SYMBOL_BLOCK_TYPE = "Symbol";

export interface SymbolSummary {
    id: number;
    name: string;
    /** Bloques Puck del símbolo (el `content` de su _puck_data). */
    items: unknown[];
}

/* ------------------------------------------------------------------ */
/* Registro idempotente del tipo de post                               */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<boolean> | null = null;

async function typeExists(): Promise<boolean> {
    try {
        await apiGet(`/types/${SYMBOL_POST_TYPE}`);
        return true;
    } catch {
        return false;
    }
}

/**
 * Garantiza que el tipo `wjs_symbol` está registrado en el backend. Idempotente y cacheado por
 * sesión. Devuelve false si no se pudo garantizar (p. ej. usuario sin permiso de admin y el tipo
 * aún no existe) — en ese caso create() fallará con un error claro y el resto del sitio sigue
 * funcionando (el resolver SSR simplemente no encontrará símbolos).
 */
export function ensureSymbolType(): Promise<boolean> {
    return (ensurePromise ||= (async () => {
        if (await typeExists()) return true;
        try {
            await apiPost("/types", {
                name: SYMBOL_POST_TYPE,
                label: "Símbolos",
                labels: { singular: "Símbolo", plural: "Símbolos" },
                // Interno: fuera del menú admin y del listado REST de tipos; los POSTS publicados
                // siguen siendo legibles (el render público los necesita vía el resolver SSR).
                public: false,
                showInMenu: false,
                showInRest: false,
                hasArchive: false,
                supports: ["title", "editor", "revisions"],
                taxonomies: [],
                // Familia de capacidades 'post' (edit_posts/publish_posts): cualquier usuario que
                // pueda crear posts puede crear símbolos, sin capacidades nuevas que seedear.
                capability_type: "post",
            });
        } catch (err: unknown) {
            // 409 = otro cliente lo registró primero — perfecto. Cualquier otro fallo (403 no-admin,
            // red) cae a la verificación de abajo por si el tipo existe igualmente.
            const status = (err as { status?: number })?.status;
            if (status !== 409 && (await typeExists())) return true;
            if (status !== 409 && status !== undefined && status !== 201) {
                // seguimos: la verificación con reintentos decide.
            }
        }
        // La ruta responde antes de completar el registro (sin await en el backend): verificar con
        // reintentos cortos hasta que getPostType lo vea.
        for (let i = 0; i < 5; i++) {
            if (await typeExists()) return true;
            await new Promise((r) => setTimeout(r, 200));
        }
        return false;
    })().catch(() => {
        ensurePromise = null; // permitir reintento en el siguiente uso
        return false;
    }));
}

/* ------------------------------------------------------------------ */
/* Caché client-side                                                   */
/* ------------------------------------------------------------------ */

const TTL_MS = 30_000;

let listCache: { at: number; data: SymbolSummary[] } | null = null;
let listInflight: Promise<SymbolSummary[]> | null = null;
const byIdCache = new Map<number, { at: number; data: SymbolSummary | null }>();

function invalidate(id?: number) {
    listCache = null;
    listInflight = null;
    if (id !== undefined) byIdCache.delete(id);
    else byIdCache.clear();
}

function toSymbol(p: Post): SymbolSummary {
    const content = (p.meta?._puck_data as { content?: unknown } | undefined)?.content;
    return {
        id: p.id,
        name: p.title || `Símbolo ${p.id}`,
        items: Array.isArray(content) ? content : [],
    };
}

/** Meta en el formato EXACTO del editor de páginas: objeto (no string) bajo _puck_data. */
function symbolMeta(items: unknown[]) {
    return { _puck_data: { content: items, root: {} } };
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

export const symbolsApi = {
    /**
     * Todos los símbolos publicados, ordenados por nombre. Si el tipo aún no está registrado el
     * backend devuelve una lista vacía (filtra por columna post_type), así que esto nunca rompe.
     */
    list(): Promise<SymbolSummary[]> {
        if (listCache && Date.now() - listCache.at < TTL_MS) return Promise.resolve(listCache.data);
        return (listInflight ||= apiGet<Post[]>(
            `/posts?type=${encodeURIComponent(SYMBOL_POST_TYPE)}&status=publish&per_page=100`
        )
            .then((posts) => {
                const data = (posts || []).map(toSymbol).sort((a, b) => a.name.localeCompare(b.name));
                listCache = { at: Date.now(), data };
                for (const s of data) byIdCache.set(s.id, { at: listCache.at, data: s });
                listInflight = null;
                return data;
            })
            .catch((err) => {
                listInflight = null;
                throw err;
            }));
    },

    /**
     * Un símbolo por id, con caché. Devuelve null si no existe / fue borrado (404) o si el post
     * referenciado no es un símbolo; lanza en errores de red para que el bloque distinga
     * "eliminado" de "no se pudo cargar".
     */
    async get(id: number): Promise<SymbolSummary | null> {
        const hit = byIdCache.get(id);
        if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
        try {
            const post = await postsApi.get(id);
            const data = post && post.type === SYMBOL_POST_TYPE ? toSymbol(post) : null;
            byIdCache.set(id, { at: Date.now(), data });
            return data;
        } catch (err: unknown) {
            if ((err as { status?: number })?.status === 404) {
                byIdCache.set(id, { at: Date.now(), data: null });
                return null;
            }
            throw err;
        }
    },

    /** Crea un símbolo (registrando el tipo de post si es la primera vez). */
    async create(name: string, items: unknown[]): Promise<SymbolSummary> {
        const ok = await ensureSymbolType();
        if (!ok) {
            throw new Error(
                "No se pudo registrar el tipo de contenido de símbolos (requiere un administrador la primera vez)."
            );
        }
        const post = await postsApi.create({
            title: name,
            content: "",
            status: "publish",
            type: SYMBOL_POST_TYPE,
            meta: symbolMeta(items),
        });
        invalidate();
        const sym = toSymbol(post);
        byIdCache.set(sym.id, { at: Date.now(), data: sym });
        return sym;
    },

    /** Actualiza los bloques (y opcionalmente el nombre) de un símbolo. */
    async update(id: number, items: unknown[], name?: string): Promise<SymbolSummary> {
        const post = await postsApi.update(id, {
            ...(name ? { title: name } : {}),
            status: "publish",
            meta: symbolMeta(items),
        });
        invalidate(id);
        const sym = toSymbol(post);
        byIdCache.set(id, { at: Date.now(), data: sym });
        return sym;
    },

    /** Elimina un símbolo. Las páginas que lo usaban lo renderizan vacío (aviso en el editor). */
    async remove(id: number): Promise<void> {
        await postsApi.delete(id);
        invalidate(id);
    },

    /** Vacía la caché (p. ej. tras editar un símbolo en otra pestaña). */
    invalidate,
};

"use client";
/**
 * Verso — plantilla del tema activo envolviendo el canvas (F3, checklist W30).
 *
 * Espec: CanvasThemeTemplate del editor legacy (components/editor/CanvasThemeTemplate.tsx) — el
 * canvas envuelve los bloques de la página en la MISMA plantilla (Section/Grid/partes) que la ruta
 * pública renderizará, con la MISMA cadena de candidatos del resolver público
 * (canvasTemplateCandidates → templateCandidates + hoisting del `_wjs_template` del autor,
 * shape-checked contra TEMPLATE_NAME — fail-closed) y el MISMO TemplateRenderer/decorateForCanvas,
 * así el canvas emite markup wp-block-* byte-idéntico y hereda los tokens --wjs-* de la hoja del
 * tema que el iframe del canvas ya carga (app/admin/canvas-frame).
 *
 * DIFERENCIAS DELIBERADAS respecto al legacy, por arquitectura Verso:
 *  - No hay CanvasTemplateContext: el árbol React fluye al iframe por el portal de FrameController
 *    (no existe el remount de AutoFrame), así que `kind`/`postType` llegan como PROPS y el
 *    `assignedTemplate` se lee EN VIVO del store (root.props._wjs_template) vía useStoreSlice —
 *    el dropdown de plantilla del panel root (TemplateField, W31) re-envuelve el canvas al
 *    instante por construcción: setRootProps → notificación del slice → re-resolución.
 *  - El slug de la página sigue sin participar en la resolución (misma decisión documentada del
 *    legacy: se regenera por tecla al titular un borrador y re-envolvería el canvas por letra).
 *
 * DISPLAY-ONLY: se renderiza FUERA del documento del editor (envuelve a EditorRenderer, cuyo slot
 * raíz es el hueco PageContent) — jamás toca _puck_data. Degrada en silencio a `children` sin
 * envolver si el tema no trae plantilla o el backend no responde (el caso normal sin plantilla).
 *
 * Cachés de sesión a nivel de módulo (mismo criterio que el legacy): un remount no re-fetchea el
 * tema, los ficheros de plantilla ni la lista de posts.
 */
import React from "react";
import { themesApi, postsApi, type Post } from "@/lib/api";
import type { TemplateKind, TemplateTree } from "@/lib/templateData";
import { TemplateRenderer } from "@/components/content/TemplateRenderer";
import { canvasTemplateCandidates, decorateForCanvas, parseCanvasTemplate } from "@/lib/canvasTemplate";
import type { EditorHandle } from "@/lib/verso/store";
import type { VersoEditorState } from "@/lib/verso/types";
import { useStoreSlice } from "../render/context";

export type FetchTemplateRaw = (name: string) => Promise<string | null>;

/**
 * PURA (testeable en node): recorre los candidatos MÁS-ESPECÍFICO-PRIMERO y devuelve el primer
 * template que el tema realmente trae y VALIDA (parseCanvasTemplate, fail-closed: un JSON roto o
 * fuera de contrato cuenta como miss y la cadena sigue). Un fetcher que lanza también es un miss —
 * backend inalcanzable degrada al siguiente candidato y, agotados todos, a null (canvas intacto).
 */
export async function resolveCanvasTemplate(
    candidates: readonly string[],
    fetchRaw: FetchTemplateRaw,
): Promise<{ name: string; tree: TemplateTree } | null> {
    for (const name of candidates) {
        let raw: string | null = null;
        try {
            raw = await fetchRaw(name);
        } catch {
            raw = null;
        }
        const tree = parseCanvasTemplate(raw);
        if (tree) return { name, tree };
    }
    return null;
}

/* ── cachés de sesión (sobreviven remounts del editor, mismo criterio que el legacy) ─────────── */

const templateRawCache = new Map<string, string | null>();
let activeSlugPromise: Promise<string> | null = null;
let publishedPromise: Promise<Post[]> | null = null;

function resolveActiveSlug(): Promise<string> {
    return (activeSlugPromise ||= themesApi
        .list()
        .then((list) => (list.find((t) => t.active) || list.find((t) => t.slug === "default"))?.slug || "default")
        .catch(() => {
            activeSlugPromise = null; // un lookup fallido puede reintentar en el próximo mount
            return "default";
        }));
}

function fetchPublished(): Promise<Post[]> {
    return (publishedPromise ||= postsApi.list("post", "publish").catch(() => {
        publishedPromise = null;
        return [] as Post[];
    }));
}

/**
 * Un candidato, relativo al origin de la app (misma ruta y alcanzabilidad que la hoja del tema del
 * iframe). 404 = el tema no trae ese template (el miss normal); cualquier fallo cachea null para
 * no re-fetchear el miss en la sesión. El nombre viene de la jerarquía cerrada ([a-z0-9-]) y aun
 * así pasa por encodeURIComponent — defensa en profundidad antes de aterrizar en la URL.
 */
async function fetchTemplateRaw(themeSlug: string, name: string): Promise<string | null> {
    const key = `${themeSlug}|${name}`;
    const cached = templateRawCache.get(key);
    if (cached !== undefined) return cached;
    try {
        const res = await fetch(`/themes/${encodeURIComponent(themeSlug)}/templates/${encodeURIComponent(name)}.json`, {
            credentials: "same-origin",
        });
        const raw = res.ok ? await res.text() : null;
        templateRawCache.set(key, raw);
        return raw;
    } catch {
        templateRawCache.set(key, null); // backend inalcanzable — el canvas conserva su disposición
        return null;
    }
}

/** El pick del autor, EN VIVO del root del documento (el dropdown _wjs_template edita root.props). */
const selectAssignedTemplate = (s: VersoEditorState): string => {
    const v = (s.doc.root.props as Record<string, unknown> | undefined)?._wjs_template;
    return typeof v === "string" ? v : "";
};

export interface VersoThemeTemplateProps {
    handle: EditorHandle;
    /** Qué ES la ruta editada: `page` (editor de páginas) o `single` (posts). Default `page`. */
    kind?: TemplateKind;
    /** `post` en el editor de posts — deja que `single` prefiera single-post antes que single. */
    postType?: string;
    /** El contenido editable (EditorRenderer) — cae en el hueco PageContent de la plantilla. */
    children: React.ReactNode;
}

export default function VersoThemeTemplate({ handle, kind = "page", postType, children }: VersoThemeTemplateProps) {
    const assignedTemplate = useStoreSlice(handle, selectAssignedTemplate);
    const [tree, setTree] = React.useState<TemplateTree | null>(null);

    React.useEffect(() => {
        let dead = false;
        (async () => {
            const themeSlug = await resolveActiveSlug();
            const resolved = await resolveCanvasTemplate(
                // Mismas reglas que el resolver público y el legacy: jerarquía page/single con el
                // pick del autor izado al FRENTE (y descartado si no pasa TEMPLATE_NAME) — nunca
                // sustituyendo los fallbacks: un template que el tema no trae degrada igual que
                // degradará la página publicada.
                canvasTemplateCandidates(kind, undefined, postType, assignedTemplate || undefined),
                (name) => fetchTemplateRaw(themeSlug, name),
            );
            if (dead) return;
            if (!resolved) {
                setTree(null); // sin plantilla ⇒ children tal cual (el caso normal)
                return;
            }
            // Solo ahora se paga la lista de posts, y solo para rellenar los listings.
            const posts = await fetchPublished();
            if (!dead) setTree(decorateForCanvas(resolved.tree, posts));
        })().catch(() => {
            if (!dead) setTree(null);
        });
        return () => {
            dead = true;
        };
    }, [kind, postType, assignedTemplate]);

    // Sin plantilla (aún, o en absoluto): el contenido editable renderiza exactamente como antes
    // de que este componente existiera — el camino sin regresión.
    if (!tree) return <>{children}</>;

    // Los bloques de la página (el slot raíz vivo) caen en el hueco PageContent. `canvasPreview`
    // hace inertes los bloques dinámicos (los enlaces no navegan el iframe) y convierte una PARTE
    // no resuelta en un placeholder etiquetado en vez de nada.
    return (
        <TemplateRenderer template={tree} canvasPreview>
            {children}
        </TemplateRenderer>
    );
}

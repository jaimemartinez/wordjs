"use client";

/**
 * Wraps the Puck editor canvas's editable content in the ACTIVE theme's matching page template, so the
 * author composes inside the same Section/Grid arrangement, containers and template parts the public
 * page will render (OLA 3 — editor parity).
 *
 * WHY A CLIENT MIRROR. On the public site ThemeTemplate.tsx (an async Server Component) resolves the
 * template and its posts before render. The canvas is a "use client" tree rendered into an iframe via a
 * React portal (Puck's AutoFrame), so it cannot render an async server component. This component does
 * the same job with client fetches: resolve the active theme, fetch the first template the theme ships
 * for this route KIND, fill its listings with real posts (a sample set when the site is empty), and hand
 * the tree to the SAME TemplateRenderer the public side uses — so the canvas emits byte-identical
 * `wp-block-*` markup and inherits every `--wjs-*` token the iframe's theme stylesheet already carries.
 *
 * DISPLAY ONLY — IT NEVER TOUCHES SAVED DATA. It is rendered from `config.root.render` (StablePuckRoot),
 * whose output Puck never serializes; the page's own blocks arrive as `children` (the live DropZone) and
 * drop into the template's PageContent hole. The theme template is the theme's, not the page's, so it
 * can never leak into `_puck_data`.
 *
 * FALLS BACK SILENTLY. No template for this route, an unreachable backend, an invalid file: `children`
 * renders exactly as it did before this component existed. A theme with no template is the normal case.
 */

import React from "react";
import { themesApi, postsApi, type Post } from "@/lib/api";
import { type TemplateTree, type TemplateKind } from "@/lib/templateData";
import { TemplateRenderer } from "@/components/content/TemplateRenderer";
import { canvasTemplateCandidates, decorateForCanvas, parseCanvasTemplate } from "@/lib/canvasTemplate";

/** What the route being edited IS — provided by PuckEditor, read across the iframe portal by context. */
export interface CanvasTemplateInfo {
    kind: TemplateKind;
    /**
     * The post/page slug. Reserved, but deliberately NOT used to pick a more specific `page-<slug>` /
     * `single-post-<slug>` template in the canvas: the slug auto-regenerates on every keystroke while
     * titling a draft, and keying the resolution on it would re-fetch and re-wrap the canvas per letter.
     * The canvas previews at the stable `page` / `single` level — which is the template the vast
     * majority of pages actually resolve to on the public side anyway.
     */
    slug?: string;
    /** `post` for the post editor — lets `single` prefer single-post before single. */
    postType?: string;
}

/**
 * Carries the route identity from PuckEditor (parent document) to CanvasThemeTemplate (rendered inside
 * the canvas iframe). React context propagates through Puck's AutoFrame portal, so a Provider around
 * <Puck> reaches the module-scope canvas root. Absent ⇒ default to `page`, the index template.
 */
export const CanvasTemplateContext = React.createContext<CanvasTemplateInfo | null>(null);

// ── session-scoped caches ────────────────────────────────────────────────────────────────────────
// The canvas root may remount (AutoFrame reloads its iframe); these keep a remount from re-fetching the
// theme, the template files or the post list. Keyed by what actually varies.

const templateRawCache = new Map<string, string | null>();
let activeSlugPromise: Promise<string> | null = null;
let publishedPromise: Promise<Post[]> | null = null;

function resolveActiveSlug(): Promise<string> {
    return (activeSlugPromise ||= themesApi
        .list()
        .then((list) => (list.find((t) => t.active) || list.find((t) => t.slug === "default"))?.slug || "default")
        .catch(() => {
            activeSlugPromise = null; // a failed lookup may retry on the next mount
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
 * Fetch one candidate template file, relative to the app origin — the SAME path (and reachability) the
 * canvas already uses for the theme stylesheet. 404 = the theme ships no such template (the normal
 * miss); any failure caches `null` so the miss is not re-fetched for the session.
 *
 * The name is one of a closed set the hierarchy produced ([a-z0-9-]); it still passes through
 * encodeURIComponent for defence in depth before landing in the URL.
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
        templateRawCache.set(key, null); // backend unreachable — canvas keeps its default arrangement
        return null;
    }
}

export function CanvasThemeTemplate({ children }: { children: React.ReactNode }) {
    const info = React.useContext(CanvasTemplateContext);
    const kind: TemplateKind = info?.kind ?? "page";
    const postType = info?.postType;

    const [tree, setTree] = React.useState<TemplateTree | null>(null);

    React.useEffect(() => {
        let dead = false;
        (async () => {
            const themeSlug = await resolveActiveSlug();
            // Most-specific-first, stopping at the first template the theme actually ships — the public
            // hierarchy at the page/single level (see CanvasTemplateInfo.slug for why the volatile
            // per-slug candidate is intentionally skipped). A pure miss leaves the canvas unchanged.
            for (const name of canvasTemplateCandidates(kind, undefined, postType)) {
                const parsed = parseCanvasTemplate(await fetchTemplateRaw(themeSlug, name));
                if (parsed) {
                    // Only now pay for the post list, and only to fill this template's listings.
                    const posts = await fetchPublished();
                    if (!dead) setTree(decorateForCanvas(parsed, posts));
                    return;
                }
                if (dead) return;
            }
            if (!dead) setTree(null); // no template ⇒ render children as today
        })().catch(() => {
            if (!dead) setTree(null);
        });
        return () => {
            dead = true;
        };
    }, [kind, postType]);

    // No template resolved (yet, or at all): the editable content renders exactly as it did before this
    // component existed — the no-regression path.
    if (!tree) return <>{children}</>;

    // The page's own blocks (the live DropZone) drop into the template's PageContent hole. `canvasPreview`
    // makes the dynamic blocks render inert (links do not navigate the iframe) and turns an unresolved
    // template PART into a labelled placeholder instead of nothing.
    return (
        <TemplateRenderer template={tree} canvasPreview>
            {children}
        </TemplateRenderer>
    );
}

export default CanvasThemeTemplate;

"use client";

/**
 * EDITOR-CANVAS side of the theme page-template preview (OLA 3).
 *
 * The public site wraps a route's content in the active theme's matching template on the SERVER
 * (components/content/ThemeTemplate.tsx → resolveTemplateBlocks + TemplateRenderer). The Puck editor
 * canvas is a "use client" tree inside an iframe and cannot run that async server path, so this module
 * is the client mirror of the ONE thing the canvas needs from it: fill a template's dynamic listings
 * with posts so the author sees the arrangement they will publish into — not a blank frame.
 *
 * IT REUSES THE SAME MAPPER. The `resolvedPosts` derivation (filter → count → toResolved) is the single
 * source in lib/resolvedPost.ts that both resolveDynamicBlocks (public) and useEditorPosts (canvas)
 * already share; decorateForCanvas walks the theme template with that exact derivation. If the fields
 * ever drift, the author preview and the published page drift together.
 *
 * PREVIEW-ONLY, and honest about it. When the site has no published posts yet, the listings show a small
 * clearly-fake sample set so the layout is still visible; named template PARTS (chrome) are not resolved
 * here (that needs the server's declaration + validation gates) — TemplateRenderer renders them as a
 * labelled placeholder in this mode instead. None of this touches the page's own `_puck_data`: the
 * template is the theme's, and the canvas wraps the editable content for DISPLAY only.
 */

import type { Post } from "@/lib/api";
import { toResolved, filterByCategory, type ResolvedPost } from "@/lib/resolvedPost";
import {
    parseTemplate,
    templateCandidates,
    type TemplateTree,
    type TemplateBlock,
    type TemplateKind,
} from "@/lib/templateData";

/**
 * Fallback listing content for a site that has published nothing yet — so a template's PostsGrid /
 * CategoryPosts still shows its arrangement in the canvas instead of an empty state. Deliberately fake
 * (the hrefs go nowhere; the block renders them inert under `isEditing`) and never used on the public
 * side, which only ever renders real posts the route supplied.
 */
export const SAMPLE_POSTS: ResolvedPost[] = [
    { id: -1, title: "Ejemplo de entrada", excerpt: "Así se verá una entrada publicada dentro de esta plantilla.", href: "#", date: "2026-01-01 12:00:00" },
    { id: -2, title: "Otra entrada de ejemplo", excerpt: "El contenido real reemplazará a estos ejemplos en la página publicada.", href: "#", date: "2026-01-02 12:00:00" },
    { id: -3, title: "Vista previa de la plantilla", excerpt: "Estas tarjetas son solo una muestra para componer el diseño.", href: "#", date: "2026-01-03 12:00:00" },
];

/** Only these derive content from the site; everything else in a template is structure. */
const NEEDS_POSTS = new Set(["PostsGrid", "CategoryPosts"]);

/**
 * Pick the resolved posts for ONE dynamic block, with the SAME filter/count/map derivation the public
 * server resolver and useEditorPosts use. Falls back to the sample set only when the site is empty, so
 * a real site always previews with its real posts.
 */
export function pickCanvasPosts(all: Post[], categorySlug: string | undefined, count: number): ResolvedPost[] {
    const n = Math.max(1, Number(count) || 6);
    if (!all.length) return SAMPLE_POSTS.slice(0, n);
    const inCategory = filterByCategory(all, categorySlug);
    return (inCategory.length ? inCategory : all).slice(0, n).map(toResolved);
}

/**
 * Return a NEW template tree with every dynamic listing given its `resolvedPosts`, ready for
 * TemplateRenderer. Copy-on-write: the input tree is never mutated (the caller's parsed template is
 * cached and may be decorated more than once with different post sets), and a structure-only subtree is
 * returned untouched apart from the wrapping arrays.
 */
export function decorateForCanvas(tree: TemplateTree, all: Post[]): TemplateTree {
    const walk = (list: TemplateBlock[]): TemplateBlock[] =>
        list.map((node): TemplateBlock => {
            if (!node || typeof node !== "object") return node;
            const original = node.props as Record<string, unknown> | undefined;
            let props = original;

            // Containers first: a listing may sit inside a Section, a Grid or a column.
            if (props && Array.isArray(props.items)) {
                props = { ...props, items: walk(props.items as TemplateBlock[]) };
            }

            if (node.type && NEEDS_POSTS.has(node.type)) {
                const slug = String(props?.categorySlug ?? "").trim().toLowerCase() || undefined;
                props = {
                    ...props,
                    resolvedPosts: pickCanvasPosts(all, slug, Number(props?.count)),
                    // In the canvas we always show a filled listing, so the "showing latest instead"
                    // note (resolvedFiltered:false) stays off — it is a public-route honesty signal.
                    resolvedFiltered: true,
                };
            }

            return props === original ? node : { ...node, props: props ?? {} };
        });
    return { ...tree, content: walk(tree.content) };
}

/**
 * The template names the canvas asks for, most-specific-first — the SAME hierarchy the public route
 * uses, so the editor previews the exact template the published page will pick. Only `page` and
 * `single` are reachable from the editor (a page editor and a post editor); the chain always ends at
 * `page`, the theme's index template.
 */
export function canvasTemplateCandidates(kind: TemplateKind, slug?: string, postType?: string): string[] {
    return templateCandidates(kind, { slug, postType });
}

/**
 * Parse a fetched candidate. Thin wrapper so callers do not import templateData directly and so the
 * fail-closed behaviour (null on anything invalid) lives behind one name.
 */
export function parseCanvasTemplate(raw: string | null | undefined): TemplateTree | null {
    return parseTemplate(raw);
}

import React from 'react';
import { getSettings, getThemeTemplate } from '@/lib/server-api';
import { parseTemplate, templateCandidates, TEMPLATE_NAME, type TemplateKind } from '@/lib/templateData';
import { TemplateRenderer } from './TemplateRenderer';
import { resolveTemplateBlocks, type RouteContext } from '@/lib/resolveTemplateBlocks';

/**
 * Wraps a route's content in the active theme's page template, when it ships one.
 *
 * Server Component. It sits in the PAGE rather than the layout because the template a route wants
 * depends on what the route IS — a single post asks for `single.json` before `page.json` — and a Next
 * layout does not know which of its children rendered. `kind` is that knowledge, passed explicitly.
 *
 * FALLS BACK SILENTLY. No template, an invalid one, an unreachable backend: `children` renders exactly
 * as it did before this component existed. A theme adding a broken template must not be able to blank
 * the site's content, and a theme with no template at all is the normal case.
 */

export interface ThemeTemplateProps {
    kind: TemplateKind;
    /**
     * What makes a template name more specific than `single`/`page`: the thing's own slug and, for a
     * single, its post type. The route knows both; the hierarchy composes `single-post-hello` /
     * `page-about` out of them and drops any name that is not a legal file name.
     */
    slug?: string;
    postType?: string;
    /**
     * The AUTHOR's per-page choice, from the post's `_wjs_template` meta (WordPress "Page Attributes →
     * Template" / Ghost custom-{name}.hbs). When it names a template the active theme actually ships, it
     * wins over the whole hierarchy; when it names one the theme no longer has, resolution falls straight
     * through to the hierarchy — an assignment is a preference, never a requirement, so a deleted template
     * degrades to the default arrangement instead of erroring. Shape-checked against the same TEMPLATE_NAME
     * the fetch enforces, so a junk meta value is simply ignored rather than turned into a bogus fetch.
     */
    assignedTemplate?: string;
    /**
     * What this route is already about, forwarded to any listing the template contains. A search
     * route passes its results; an archive passes its category's posts. Omit it and a listing falls
     * back to latest-published — right for a home page, wrong for a search page, which is exactly
     * why this is the route's job to say and not the resolver's to guess.
     */
    context?: RouteContext;
    children: React.ReactNode;
}

export async function ThemeTemplate({ kind, slug, postType, assignedTemplate, context, children }: ThemeTemplateProps) {
    const settings = await getSettings();          // cache()d — the layout already fetched this
    const themeSlug = (settings?.template as string) || 'default';

    // The author's assignment, if it is a legal file name, is tried BEFORE the hierarchy — but it never
    // replaces it. A theme that no longer ships the assigned template simply misses on this first name and
    // resolution continues down the normal chain (fail-closed: an assignment can only ever MOVE a candidate
    // to the front, never remove the fallbacks). It is hoisted even when the hierarchy would also produce it
    // — an author who assigns `page` wants the generic page template over a more-specific `page-<slug>` —
    // and de-duplicated from its later position so nothing is fetched twice.
    const hierarchy = templateCandidates(kind, { slug, postType });
    const assigned = typeof assignedTemplate === 'string' && TEMPLATE_NAME.test(assignedTemplate) ? assignedTemplate : null;
    const candidates = assigned ? [assigned, ...hierarchy.filter((n) => n !== assigned)] : hierarchy;

    // Most specific first, stopping at the first template the theme actually ships. Sequential on
    // purpose: the common case is one hit (or a few misses that the ISR window turns into zero fetches),
    // and firing the whole chain in parallel would fetch templates we then throw away.
    for (const name of candidates) {
        const tree = parseTemplate(await getThemeTemplate(themeSlug, name));
        if (!tree) continue;
        // Resolve BEFORE rendering: the posts and the template parts must be in the server HTML, not
        // fetched by the browser. A template made only of structure costs nothing here — the resolver
        // returns it untouched.
        const resolved = await resolveTemplateBlocks(tree, context, themeSlug);
        return <TemplateRenderer template={resolved}>{children}</TemplateRenderer>;
    }
    return <>{children}</>;
}

export default ThemeTemplate;

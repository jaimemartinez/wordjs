import React from 'react';
import { getSettings, getThemeTemplate } from '@/lib/server-api';
import { parseTemplate, templateCandidates } from '@/lib/templateData';
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
    kind: 'home' | 'single' | 'page' | 'archive' | 'search';
    /**
     * What this route is already about, forwarded to any listing the template contains. A search
     * route passes its results; an archive passes its category's posts. Omit it and a listing falls
     * back to latest-published — right for a home page, wrong for a search page, which is exactly
     * why this is the route's job to say and not the resolver's to guess.
     */
    context?: RouteContext;
    children: React.ReactNode;
}

export async function ThemeTemplate({ kind, context, children }: ThemeTemplateProps) {
    const settings = await getSettings();          // cache()d — the layout already fetched this
    const slug = (settings?.template as string) || 'default';

    // Most specific first, stopping at the first template the theme actually ships. Sequential on
    // purpose: the common case is one hit (or three misses that the ISR window turns into zero fetches),
    // and firing all three in parallel would fetch templates we then throw away.
    for (const name of templateCandidates(kind)) {
        const tree = parseTemplate(await getThemeTemplate(slug, name));
        if (!tree) continue;
        // Resolve BEFORE rendering: the posts must be in the server HTML, not fetched by the browser.
        // A template made only of structure costs nothing here — the resolver returns it untouched.
        const resolved = await resolveTemplateBlocks(tree, context);
        return <TemplateRenderer template={resolved}>{children}</TemplateRenderer>;
    }
    return <>{children}</>;
}

export default ThemeTemplate;

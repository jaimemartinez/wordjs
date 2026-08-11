import React from 'react';
import { getSettings, getThemeTemplate } from '@/lib/server-api';
import { parseTemplate, templateCandidates } from '@/lib/templateData';
import { TemplateRenderer } from './TemplateRenderer';

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
    children: React.ReactNode;
}

export async function ThemeTemplate({ kind, children }: ThemeTemplateProps) {
    const settings = await getSettings();          // cache()d — the layout already fetched this
    const slug = (settings?.template as string) || 'default';

    // Most specific first, stopping at the first template the theme actually ships. Sequential on
    // purpose: the common case is one hit (or three misses that the ISR window turns into zero fetches),
    // and firing all three in parallel would fetch templates we then throw away.
    for (const name of templateCandidates(kind)) {
        const tree = parseTemplate(await getThemeTemplate(slug, name));
        if (tree) return <TemplateRenderer template={tree}>{children}</TemplateRenderer>;
    }
    return <>{children}</>;
}

export default ThemeTemplate;

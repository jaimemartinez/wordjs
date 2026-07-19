"use client";

/**
 * Renders the configured static home page (Puck layout, or HTML with [shortcode] plugin embeds).
 * Receives the already-fetched `post` from the Server Component, so the text content server-renders
 * for SEO; only the plugin embeds ([cards], [vgallery]) hydrate client-side via PluginLoader.
 */
import { Fragment } from "react";
import PluginLoader from "@/components/PluginLoader";
import { Render } from "@wordjs/puck";
import "@wordjs/puck/puck.css";
import { pageConfig } from "@/components/puckConfig";
import { sanitizeHTML } from "@/lib/sanitize";
import type { Post } from "@/lib/api";

// Map supported shortcodes to the plugin slug that renders them.
const SHORTCODES: { tag: string; slug: string }[] = [
    { tag: '[cards]', slug: 'card-gallery' },
    { tag: '[vgallery]', slug: 'video-gallery' },
];

function renderContent(htmlContent: string) {
    if (!htmlContent) return null;

    const markerPrefix = '___PLUGIN_MARKER___';
    let processed = htmlContent;
    SHORTCODES.forEach((sc, idx) => {
        processed = processed.split(sc.tag).join(`${markerPrefix}${idx}${markerPrefix}`);
    });

    if (!processed.includes(markerPrefix)) {
        return <div suppressHydrationWarning dangerouslySetInnerHTML={{ __html: sanitizeHTML(htmlContent) }} />;
    }

    const regex = new RegExp(`${markerPrefix}(\\d+)${markerPrefix}`, 'g');
    const parts: (string | { type: 'plugin'; slug: string })[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(processed)) !== null) {
        if (match.index > lastIndex) parts.push(processed.slice(lastIndex, match.index));
        parts.push({ type: 'plugin', slug: SHORTCODES[parseInt(match[1])].slug });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < processed.length) parts.push(processed.slice(lastIndex));

    return (
        <div>
            {parts.map((part, index) => (
                <Fragment key={index}>
                    {typeof part === 'string' ? (
                        <div suppressHydrationWarning dangerouslySetInnerHTML={{ __html: sanitizeHTML(part) }} />
                    ) : (
                        <PluginLoader slug={part.slug} />
                    )}
                </Fragment>
            ))}
        </div>
    );
}

export default function HomeContent({ post }: { post: Post }) {
    if (post.meta?._puck_data) {
        return (
            <div className="puck-content w-full">
                <Render config={pageConfig} data={post.meta._puck_data} />
            </div>
        );
    }
    return (
        <div className="prose prose-lg max-w-none px-4">
            <h1 className="text-4xl font-bold mb-4 text-center">{post.title}</h1>
            {renderContent(post.content)}
        </div>
    );
}

/**
 * Renders the configured static home page (Puck layout, or HTML with [shortcode] plugin embeds) —
 * SERVER COMPONENT (perf F3). The Puck body renders through ContentRenderer (same shared block
 * components as the editor canvas, wrapped in SharedBlockShell); only the genuinely interactive
 * pieces hydrate: PluginLoader embeds and whatever islands the content itself contains. Before F3
 * this was a client component importing <Render> + the entire editor config on every home view.
 */
import { Fragment } from "react";
import PluginLoader from "@/components/PluginLoader";
import ContentRenderer from "@/components/content/ContentRenderer";
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

export default function HomeContent({ post, settings }: { post: Post; settings?: Record<string, string> | null }) {
    if (post.meta?._puck_data) {
        return (
            <div className="puck-content w-full">
                {/* `wjs_ix_presets` = los preajustes de interacción del sitio (motor F9). Se pasan
                    desde aquí, y no se leen dentro de ContentRenderer, porque ese módulo también lo
                    importa código de cliente y no puede tocar la capa de servidor. */}
                <ContentRenderer data={post.meta._puck_data} ixPresets={settings?.wjs_ix_presets} />
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

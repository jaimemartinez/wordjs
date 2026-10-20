/**
 * Renders the configured static home page (Puck layout, or HTML with [shortcode] plugin embeds — the tags
 * the active plugins declare, see splitShortcodes) —
 * SERVER COMPONENT (perf F3). The Puck body renders through ContentRenderer (same shared block
 * components as the editor canvas, wrapped in SharedBlockShell); only the genuinely interactive
 * pieces hydrate: PluginLoader embeds and whatever islands the content itself contains. Before F3
 * this was a client component importing <Render> + the entire editor config on every home view.
 */
import { Fragment } from "react";
import PluginLoader from "@/components/PluginLoader";
import ContentRenderer from "@/components/content/ContentRenderer";
import { publicUiStrings, membersGateStrings } from "@/lib/public/uiStrings";
import MembersOnlyGate from "./MembersOnlyGate";
import { sanitizeHTML } from "@/lib/sanitize";
import type { Post } from "@/lib/api";

/** A shortcode tag an active plugin declares and renders with its own site component (GET /plugins/shortcodes). */
export type PluginShortcode = { tag: string; plugin: string };

const ATTR = /([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"/g;

/**
 * Split HTML on the `[tag]` / `[tag key="value" …]` embeds of the declared shortcodes. The tags are
 * whatever the active plugins declare in their manifests — the core keeps no list of its own — and a tag
 * no active plugin declares stays plain text. Attributes become the component's props.
 */
export function splitShortcodes(html: string, shortcodes: PluginShortcode[]):
    (string | { type: 'plugin'; slug: string; props: Record<string, string> })[] {
    const tags = (shortcodes || []).filter((s) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s.tag));
    if (!html || tags.length === 0) return [html];
    const owner = new Map(tags.map((s) => [s.tag.toLowerCase(), s.plugin]));
    // The tags are identifiers (checked above), so they need no escaping inside the pattern.
    const re = new RegExp(`\\[(${tags.map((s) => s.tag).join('|')})((?:\\s+[a-zA-Z_][\\w-]*\\s*=\\s*"[^"]*")*)\\s*\\]`, 'gi');
    const parts: (string | { type: 'plugin'; slug: string; props: Record<string, string> })[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        if (m.index > last) parts.push(html.slice(last, m.index));
        const props: Record<string, string> = {};
        let a: RegExpExecArray | null;
        ATTR.lastIndex = 0;
        while ((a = ATTR.exec(m[2] || '')) !== null) props[a[1]] = a[2];
        parts.push({ type: 'plugin', slug: owner.get(m[1].toLowerCase()) as string, props });
        last = m.index + m[0].length;
    }
    if (last < html.length) parts.push(html.slice(last));
    return parts;
}

function renderContent(htmlContent: string, shortcodes: PluginShortcode[]) {
    if (!htmlContent) return null;
    const parts = splitShortcodes(htmlContent, shortcodes);
    if (parts.length === 1 && typeof parts[0] === 'string') {
        return <div suppressHydrationWarning dangerouslySetInnerHTML={{ __html: sanitizeHTML(htmlContent) }} />;
    }
    return (
        <div>
            {parts.map((part, index) => (
                <Fragment key={index}>
                    {typeof part === 'string' ? (
                        <div suppressHydrationWarning dangerouslySetInnerHTML={{ __html: sanitizeHTML(part) }} />
                    ) : (
                        <PluginLoader slug={part.slug} props={part.props} />
                    )}
                </Fragment>
            ))}
        </div>
    );
}

export default function HomeContent({ post, settings, shortcodes = [] }: { post: Post; settings?: Record<string, string> | null; shortcodes?: PluginShortcode[] }) {
    // A members-only front page (backend core/content-access) arrives as its teaser, like any gated entry
    // on this anonymous, cached render: MembersOnlyGate swaps in the full body for a member.
    const access = post.access;
    if (access && access.gated && !access.granted) {
        const data = post.meta?._puck_data as any;
        const verso = !!data;
        const teaserEmpty = !String(post.content || '').trim() && !(Array.isArray(data?.content) && data.content.length > 0);
        return (
            <MembersOnlyGate
                postId={post.id}
                mode={verso ? 'verso' : 'html'}
                htmlClassName="prose prose-lg max-w-none px-4"
                ixPresets={settings?.wjs_ix_presets}
                motion={settings?.wjs_motion}
                ui={publicUiStrings(settings)}
                strings={membersGateStrings(settings)}
                showNotice={teaserEmpty}
                commentsWhenGranted={false}
            >
                {verso ? (
                    <div className="puck-content w-full">
                        <ContentRenderer data={data} ixPresets={settings?.wjs_ix_presets} motion={settings?.wjs_motion} ui={publicUiStrings(settings)} />
                    </div>
                ) : (
                    <div className="prose prose-lg max-w-none px-4">{renderContent(post.content, shortcodes)}</div>
                )}
            </MembersOnlyGate>
        );
    }
    if (post.meta?._puck_data) {
        return (
            <div className="puck-content w-full">
                {/* `wjs_ix_presets` = los preajustes de interacción del sitio (motor F9). Se pasan
                    desde aquí, y no se leen dentro de ContentRenderer, porque ese módulo también lo
                    importa código de cliente y no puede tocar la capa de servidor. */}
                <ContentRenderer data={post.meta._puck_data} ixPresets={settings?.wjs_ix_presets} motion={settings?.wjs_motion} ui={publicUiStrings(settings)} />
            </div>
        );
    }
    return (
        <div className="prose prose-lg max-w-none px-4">
            <h1 className="text-4xl font-bold mb-4 text-center">{post.title}</h1>
            {post.protected && !post.content
                ? <p className="text-center">This content is password protected.</p>
                : renderContent(post.content, shortcodes)}
        </div>
    );
}

import React from 'react';
import { CONTENT_SLOT, type TemplateBlock, type TemplateTree } from '@/lib/templateData';
import {
    SectionBlock,
    GridBlock,
    FlexRowBlock,
    ColumnsBlock,
    SpacerBlock,
    DividerBlock,
    PostsGridBlock,
    CategoryPostsBlock,
} from './blocks';
import SearchBarBlock from './SearchBarBlock';
import ChromeRenderer from '@/components/chrome/ChromeRenderer';
import type { ChromeBindings, ChromeData } from '@/lib/chromeData';
import { THEME_CONTRACT } from '@/generated/visual-contract.generated';
import type { TemplateBlockType } from '@/generated/visual-contract.types.generated';

/**
 * Renders a theme's page template: the arrangement comes from `templates/<name>.json`, and the page's
 * own content drops into the single `PageContent` hole.
 *
 * IT REUSES THE PAGE BLOCKS. Every layout block here is the SAME component a page uses, given the same
 * props — so a template emits byte-identical markup (`wp-block-section`, `wp-block-grid__items`, the
 * `--wjs-*` custom properties) and inherits every theme token for free. Re-emitting a parallel set of
 * divs was the alternative and it would have been a second layout system to keep in step with the
 * first: a token that started applying to pages would silently skip templates.
 *
 * That reuse is why the contract's prop names are what they are. `PROPS` below maps each contract prop
 * onto the component's own prop, and a contract prop only exists when the component can honour it —
 * accepting `minColumnWidth` and dropping it on the floor would validate cleanly and do nothing, which
 * is the failure this contract exists to prevent.
 *
 * `tag` and `className` are the one place a template touches the wrapper itself, and they are the
 * Shopify affordance adapted to this grammar: the element name comes from a closed enum, and the class
 * is APPENDED to the block's own `wp-block-*` class rather than replacing it — so a theme can mark one
 * Section as its hero without any framework selector, token or stylesheet hook losing its grip. Both are
 * re-checked inside the block components (see CONTAINER_TAGS in blocks.tsx), because those same
 * components are also fed author-controlled `_puck_data` by ContentRenderer.
 *
 * The tree is already validated (parseTemplate) before it gets here, so this file does no checking of
 * its own beyond skipping a type it does not know — belt and braces if the two ever drift.
 */

type Rendered = React.ReactNode;
/** A slot the way the page blocks expect it: `(className?) => ReactNode`, emitting a wrapper div. */
type SlotFn = (className?: string) => Rendered;

/**
 * The wrapper a template part renders into, chosen by its `area` — the closed enum theme.json and the
 * template both declare. A LOOKUP, never the value itself: `area` is data, and data does not name
 * elements here. `main` is absent for the same reason `tag` excludes it — the layout already wraps
 * every template in one.
 */
const PART_TAGS: Readonly<Record<string, 'header' | 'footer' | 'aside' | 'div'>> = THEME_CONTRACT.templateParts.areaWrappers;

/** Equal-width distribution for a Columns block — the contract exposes a count, not pixel widths. */
function distribution(count: number) {
    const n = Math.min(Math.max(Math.trunc(count) || 2, 2), 4);
    return { columnCount: n, widths: Array.from({ length: n }, () => 100 / n) };
}

export interface TemplateRendererProps {
    template: TemplateTree;
    /** The page's own content, substituted for the `PageContent` slot. */
    children: Rendered;
    /**
     * EDITOR CANVAS ONLY. When true (CanvasThemeTemplate passes it), dynamic listings render inert so a
     * post link never navigates the canvas iframe, and an UNRESOLVED template part renders a labelled
     * placeholder instead of nothing — so the author can see where a part sits even though the canvas
     * does not run the server's chrome resolution. Off (the public default) ⇒ behaviour is unchanged:
     * links are live and an unresolved part renders nothing, the fail-closed contract.
     */
    canvasPreview?: boolean;
}

export function TemplateRenderer({ template, children, canvasPreview }: TemplateRendererProps) {
    return <>{renderList(template.content, children, 't', !!canvasPreview)}</>;
}

function renderList(list: TemplateBlock[], content: Rendered, key: string, preview: boolean): Rendered {
    return list.map((block, i) => renderBlock(block, content, `${key}-${i}`, preview));
}

interface TemplateRenderContext {
    content: Rendered;
    items: TemplateBlock[];
    key: string;
    p: Record<string, any>;
    preview: boolean;
    slot: SlotFn;
}

type TemplateBlockRenderer = (context: TemplateRenderContext) => Rendered;

const TEMPLATE_RENDERERS = {
    [CONTENT_SLOT]: ({ content, key }) => <React.Fragment key={key}>{content}</React.Fragment>,
    Section: ({ key, p, slot }) => <SectionBlock key={key} maxWidth={p.maxWidth} pad={p.padding} bg={p.background} tag={p.tag} className={p.className} slot={slot} />,
    Grid: ({ key, p, slot }) => <GridBlock key={key} columns={p.columns} gap={p.gap} columnsTablet={p.columnsTablet} columnsMobile={p.columnsMobile} tag={p.tag} className={p.className} slot={slot} />,
    FlexRow: ({ key, p, slot }) => <FlexRowBlock key={key} gap={p.gap} align={p.align} justify={p.justify} wrap={p.wrap} direction={p.direction} tag={p.tag} className={p.className} slot={slot} />,
    Columns: ({ content, items, key, p, preview }) => {
        const dist = distribution(Number(p.columns ?? 2));
        const buckets: TemplateBlock[][] = Array.from({ length: dist.columnCount }, () => []);
        items.forEach((child, i) => buckets[i % dist.columnCount].push(child));
        const slots: SlotFn[] = buckets.map((bucket, i) => () => renderList(bucket, content, `${key}-c${i}`, preview));
        return <ColumnsBlock key={key} distribution={dist} gap={p.gap} tag={p.tag} className={p.className} slots={slots} />;
    },
    Spacer: ({ key, p }) => <SpacerBlock key={key} height={p.height} />,
    Divider: ({ key, p }) => <DividerBlock key={key} color={p.color} width={p.width} length={p.length} gap={p.gap} />,
    PostsGrid: ({ key, p, preview }) => <PostsGridBlock key={key} {...p} posts={p.resolvedPosts} isEditing={preview} />,
    CategoryPosts: ({ key, p, preview }) => <CategoryPostsBlock key={key} {...p} posts={p.resolvedPosts} isEditing={preview} />,
    SearchBar: ({ key, p }) => <SearchBarBlock key={key} {...p} />,
    TemplatePart: ({ key, p, preview }) => {
        const data = (p as { resolvedPart?: ChromeData }).resolvedPart;
        const bindings = (p as { resolvedBindings?: ChromeBindings }).resolvedBindings;
        const area = String(p.area ?? 'general');
        const Wrapper = PART_TAGS[area] || 'div';
        if (!data || !bindings) {
            if (!preview) return null;
            return (
                <Wrapper
                    key={key}
                    className={`wjs-template-part wjs-template-part--${area} wjs-canvas-part-placeholder`}
                    style={{
                        border: '1px dashed var(--wjs-color-border, #cbd5e1)',
                        borderRadius: '0.5rem',
                        padding: '0.75rem 1rem',
                        margin: '0.5rem 0',
                        color: 'var(--wjs-color-muted, #64748b)',
                        fontSize: '0.8125rem',
                        textAlign: 'center',
                    }}
                >
                    {`Parte de plantilla: ${String(p.name ?? '')} (${area}) — vista previa`}
                </Wrapper>
            );
        }
        return (
            <Wrapper key={key} className={`wjs-template-part wjs-template-part--${area}`}>
                <ChromeRenderer data={data} bindings={bindings} location={area === 'header' ? 'header' : 'footer'} />
            </Wrapper>
        );
    },
} satisfies Record<TemplateBlockType, TemplateBlockRenderer>;

function renderBlock(block: TemplateBlock, content: Rendered, key: string, preview: boolean): Rendered {
    const p = (block.props || {}) as Record<string, any>;
    const items = Array.isArray(p.items) ? (p.items as TemplateBlock[]) : [];
    const slot: SlotFn = (className) => (
        <div className={className}>{renderList(items, content, key, preview)}</div>
    );
    const renderer = TEMPLATE_RENDERERS[block.type as TemplateBlockType];
    return renderer ? renderer({ content, items, key, p, preview, slot }) : null;
}

export default TemplateRenderer;

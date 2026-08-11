import React from 'react';
import { CONTENT_SLOT, type TemplateBlock, type TemplateTree } from '@/lib/templateData';
import {
    SectionBlock,
    GridBlock,
    FlexRowBlock,
    ColumnsBlock,
    SpacerBlock,
    DividerBlock,
} from './blocks';

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
 * The tree is already validated (parseTemplate) before it gets here, so this file does no checking of
 * its own beyond skipping a type it does not know — belt and braces if the two ever drift.
 */

type Rendered = React.ReactNode;
/** A slot the way the page blocks expect it: `(className?) => ReactNode`, emitting a wrapper div. */
type SlotFn = (className?: string) => Rendered;

/** Equal-width distribution for a Columns block — the contract exposes a count, not pixel widths. */
function distribution(count: number) {
    const n = Math.min(Math.max(Math.trunc(count) || 2, 2), 4);
    return { columnCount: n, widths: Array.from({ length: n }, () => 100 / n) };
}

export interface TemplateRendererProps {
    template: TemplateTree;
    /** The page's own content, substituted for the `PageContent` slot. */
    children: Rendered;
}

export function TemplateRenderer({ template, children }: TemplateRendererProps) {
    return <>{renderList(template.content, children, 't')}</>;
}

function renderList(list: TemplateBlock[], content: Rendered, key: string): Rendered {
    return list.map((block, i) => renderBlock(block, content, `${key}-${i}`));
}

function renderBlock(block: TemplateBlock, content: Rendered, key: string): Rendered {
    const p = block.props || {};
    const items = Array.isArray(p.items) ? (p.items as TemplateBlock[]) : [];

    // The slot every container hands to its block: a wrapper div carrying whichever class the block
    // asks for (Grid and FlexRow put the layout on the slot's own wrapper, not on themselves).
    const slot: SlotFn = (className) => (
        <div className={className}>{renderList(items, content, key)}</div>
    );

    switch (block.type) {
        case CONTENT_SLOT:
            return <React.Fragment key={key}>{content}</React.Fragment>;

        case 'Section':
            return (
                <SectionBlock
                    key={key}
                    maxWidth={p.maxWidth}
                    pad={p.padding}
                    bg={p.background}
                    slot={slot}
                />
            );

        case 'Grid':
            return (
                <GridBlock
                    key={key}
                    columns={p.columns}
                    gap={p.gap}
                    columnsTablet={p.columnsTablet}
                    columnsMobile={p.columnsMobile}
                    slot={slot}
                />
            );

        case 'FlexRow':
            return (
                <FlexRowBlock
                    key={key}
                    gap={p.gap}
                    align={p.align}
                    justify={p.justify}
                    wrap={p.wrap}
                    direction={p.direction}
                    slot={slot}
                />
            );

        case 'Columns': {
            // A template's columns are filled ROUND-ROBIN from the child list: `columns: 2` with three
            // children puts 1 and 3 in the first column. The alternative — one child per column — would
            // silently drop the rest, and the contract has no per-column child lists to be explicit
            // with (nesting a Section inside a column is how an author groups content deliberately).
            const dist = distribution(Number(p.columns ?? 2));
            const buckets: TemplateBlock[][] = Array.from({ length: dist.columnCount }, () => []);
            items.forEach((child, i) => buckets[i % dist.columnCount].push(child));
            const slots: SlotFn[] = buckets.map((bucket, i) => () => renderList(bucket, content, `${key}-c${i}`));
            return <ColumnsBlock key={key} distribution={dist} gap={p.gap} slots={slots} />;
        }

        case 'Spacer':
            return <SpacerBlock key={key} height={p.height} />;

        case 'Divider':
            return <DividerBlock key={key} color={p.color} width={p.width} length={p.length} gap={p.gap} />;

        default:
            // Unreachable for a validated tree. Rendering nothing (rather than throwing) keeps a drift
            // between validator and renderer from taking the whole page down with it.
            return null;
    }
}

export default TemplateRenderer;

/**
 * SERVER renderer for public Puck content (perf F3) — the content twin of ChromeRenderer.
 *
 * Walks `meta._puck_data` and renders every core block through the SAME shared components the
 * editor canvas uses (components/content/blocks.tsx + the islands), each wrapped in
 * SharedBlockShell — the server twin of withSharedBlockFields. The page body therefore ships as
 * server HTML: the only hydrated pieces are the genuinely interactive islands (accordion, tabs,
 * audio, search, forms, animated blocks) and PluginBlockIsland for plugin/Symbol blocks, whose
 * chunk code-splits away from pages that don't use them.
 *
 * DECISION — why not @wordjs/puck's ./rsc <Render>: same evidence as ChromeRenderer.tsx (its dist
 * entry drags a ~30KB shared chunk with client hooks and requires the full editor Config).
 *
 * Slot semantics mirror Puck's SlotRender exactly: a slot renders as ONE wrapper div (optionally
 * classed by the container — the grid/flex layout lives there) containing the slot's items.
 */
import React from "react";
import SharedBlockShell from "./SharedBlockShell";
import {
    HeadingBlock, TextBlock, ImageBlock, DividerBlock, ButtonBlock, SpacerBlock,
    SectionBlock, GridBlock, FlexRowBlock, ColumnsBlock,
    CardBlock, QuoteBlock, TableBlock, IconListBlock, SocialLinksBlock, StatsBlock, HTMLEmbedBlock,
    PricingTableBlock, TestimonialBlock, CTABannerBlock, VideoEmbedBlock, HeroBlock,
    PostsGridBlock, CategoryPostsBlock, AudioPlayerBlock,
} from "./blocks";
import AccordionBlock from "./AccordionBlock";
import TabsBlock from "./TabsBlock";
import SearchBarBlock from "./SearchBarBlock";
import PluginBlockIsland from "./PluginBlockIsland";
import { FormBlockRender } from "@/components/puck/FormBlock";

export default function ContentRenderer({ data }: { data: any }) {
    const content = Array.isArray(data?.content) ? data.content : [];
    return <>{content.map((item: any, i: number) => renderItem(item, `c${i}`))}</>;
}

/**
 * Subárbol de items sobre el MISMO switch de este módulo (una sola fuente de verdad de render).
 * `exclude` corta tipos en CUALQUIER profundidad devolviendo null — es el mecanismo del cap de
 * anidamiento de Symbol en Verso (excluir "Symbol" del subárbol = profundidad máxima 1, igual que
 * el config anidado sin Symbol del editor actual). Sin `exclude`, comportamiento idéntico al
 * renderer público.
 */
export function RenderSubtree({ items, exclude }: { items: unknown[]; exclude?: ReadonlySet<string> }) {
    const list = Array.isArray(items) ? items : [];
    return <>{list.map((item: any, i: number) => renderItem(item, `s${i}`, exclude))}</>;
}

// One wrapper div per slot — identical DOM to Puck's SlotRender (className carries the container's
// layout class; items keyed by their stable editor id).
function slotOf(props: any, name: string, exclude?: ReadonlySet<string>) {
    const items = Array.isArray(props?.[name]) ? props[name] : [];
    // eslint-disable-next-line react/display-name
    return (className?: string) => (
        <div className={className}>
            {items.map((it: any, i: number) => renderItem(it, `${name}.${i}`, exclude))}
        </div>
    );
}

function renderItem(item: any, fallbackKey: string, exclude?: ReadonlySet<string>): React.ReactNode {
    if (!item || typeof item !== "object" || typeof item.type !== "string") return null;
    if (exclude?.has(item.type)) return null;
    const props = (item.props || {}) as Record<string, any>;
    const key = typeof props.id === "string" ? props.id : fallbackKey;
    const core = renderCore(item.type, props, item, exclude);
    if (core === undefined) {
        // Plugin block or Symbol: the client machinery renders it exactly as before F3.
        return <PluginBlockIsland key={key} item={item} />;
    }
    return (
        <SharedBlockShell key={key} hide={props.hide} anim={props.anim} look={props.look}>
            {core}
        </SharedBlockShell>
    );
}

/** Core-block dispatch. Returns undefined for unknown types (→ PluginBlockIsland). */
function renderCore(type: string, props: Record<string, any>, item: any, exclude?: ReadonlySet<string>): React.ReactNode | undefined {
    switch (type) {
        case "Heading": return <HeadingBlock {...props} />;
        case "Text": return <TextBlock {...props} />;
        case "Image": return <ImageBlock {...props} />;
        case "Divider": return <DividerBlock {...props} />;
        case "Button": return <ButtonBlock {...props} />;
        case "Spacer": return <SpacerBlock {...props} />;
        case "Section": return <SectionBlock {...props} slot={slotOf(props, "children", exclude)} />;
        case "Grid": return <GridBlock {...props} slot={slotOf(props, "children", exclude)} />;
        case "FlexRow": return <FlexRowBlock {...props} slot={slotOf(props, "children", exclude)} />;
        case "Columns": return (
            <ColumnsBlock
                {...props}
                slots={["col-0", "col-1", "col-2"].map((name) => slotOf(props, name, exclude))}
            />
        );
        case "Card": return <CardBlock {...props} />;
        case "Quote": return <QuoteBlock {...props} />;
        case "Table": return <TableBlock {...props} />;
        case "IconList": return <IconListBlock {...props} />;
        case "SocialLinks": return <SocialLinksBlock {...props} />;
        case "Stats": return <StatsBlock {...props} />;
        case "HTMLEmbed": return <HTMLEmbedBlock {...props} />;
        case "PricingTable": return <PricingTableBlock {...props} />;
        case "Testimonial": return <TestimonialBlock {...props} />;
        case "CTABanner": return <CTABannerBlock {...props} />;
        case "VideoEmbed": return <VideoEmbedBlock {...props} />;
        case "Hero": return <HeroBlock {...props} />;
        // Dynamic blocks: resolveDynamicBlocks already injected the real posts server-side — the
        // hook's public branch returns that injection untouched, so passing it straight through is
        // the same derivation.
        case "PostsGrid": return <PostsGridBlock {...props} posts={props.resolvedPosts} />;
        case "CategoryPosts": return <CategoryPostsBlock {...props} posts={props.resolvedPosts} />;
        case "AudioPlayer": return <AudioPlayerBlock {...props} />;
        // Interactive islands — their own 'use client' modules, code-split per page.
        case "Accordion": return <AccordionBlock {...props} />;
        case "Tabs": return <TabsBlock {...props} />;
        case "SearchBar": return <SearchBarBlock {...props} />;
        case "Form": return <FormBlockRender {...(props as any)} />;
        // Symbol needs the full component map → client machinery.
        case "Symbol": return undefined;
        default: return undefined;
    }
    void item;
}

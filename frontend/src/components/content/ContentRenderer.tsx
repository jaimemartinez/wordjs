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
 *
 * ── INTERACCIONES (motor F9) ────────────────────────────────────────────────────────────────
 * Este componente es el ÚNICO sitio que ve la página entera antes de pintarla, así que es el que
 * compila sus interacciones: `collectIxSpecs` recoge las props `ix` del árbol y `compileIxPage`
 * las convierte en UN texto CSS (deduplicado por cuerpo: N bloques con el mismo preajuste comparten
 * una clase y unos `@keyframes`) más el manifiesto de lo que el CSS no puede expresar.
 *
 *  · El CSS sale en un `<style href precedence="wjs-ix">`. React 19 lo HOISTEA al `<head>` como
 *    recurso render-blocking y lo deduplica por `href`: cero FOUC, cero CLS y una sola etiqueta
 *    aunque 40 bloques compartan preajuste. El grupo `wjs-ix` se declara después de `wjs-base` y
 *    `wjs-theme` (ThemeLoader), así que el orden de cascada es framework < tema < interacciones.
 *  · El JS solo aparece si `page.runtime` no está vacío — clic, latch de "una sola vez", objetivo
 *    externo, o un navegador sin `animation-timeline`. Una página sin interacciones no paga NADA.
 *  · Los presets del SITIO llegan por prop (`ixPresets`, el ajuste `wjs_ix_presets` crudo) porque
 *    este módulo lo importa también código de cliente (PluginBlockHeavy → RenderSubtree) y no puede
 *    tocar la capa de servidor. Quien lo pinta ya tiene los ajustes leídos.
 */
import React from "react";
import {
    collectIxSpecs,
    compileIxPage,
    fnv1a32,
    ixCtxFromSite,
    parseSiteIxPresets,
    type IxCompileCtx,
    type IxPage,
    type IxPreset,
} from "@/lib/verso/interactions";
import IxRuntimeIsland from "./IxRuntimeIsland";
import MotionPause from "./MotionPause";
import SharedBlockShell from "./SharedBlockShell";
import {
    HeadingBlock, TextBlock, ImageBlock, DividerBlock, ButtonBlock, SpacerBlock,
    SectionBlock, GridBlock, FlexRowBlock, ColumnsBlock,
    CardBlock, QuoteBlock, TableBlock, IconListBlock, SocialLinksBlock, StatsBlock, HTMLEmbedBlock,
    PricingTableBlock, TestimonialBlock, CTABannerBlock, VideoEmbedBlock, HeroBlock,
    PostsGridBlock, CategoryPostsBlock, AudioPlayerBlock, ParticleFieldBlock, NavMenuBlock,
    SiteLogoBlock, OffCanvasBlock, BreadcrumbsBlock, LangSwitcherBlock, TableOfContentsBlock,
    MegaMenuBlock, MEGA_MENU_PANEL_SLOTS,
} from "./blocks";
import AccordionBlock from "./AccordionBlock";
import BackToTopBlock from "./BackToTop";
import TabsBlock from "./TabsBlock";
import SearchBarBlock from "./SearchBarBlock";
import PluginBlockIsland from "./PluginBlockIsland";
import { FormBlockRender } from "@/components/blocks/FormBlock";

/**
 * Lo que el motor de interacciones necesita saber en CADA punto del recorrido. Viaja por parámetro
 * y no por contexto de React a propósito: `renderItem` es una función pura de servidor a la que
 * también llama código de cliente (RenderSubtree), y un contexto obligaría a montar un provider en
 * las dos superficies para decir lo mismo.
 */
interface IxEnv {
    ctx: IxCompileCtx;
    /** Solo en la pasada de la página completa: resuelve las colisiones de hash. */
    page?: IxPage;
    /** Presets del SITIO, serializables — lo único que puede cruzar a un componente de cliente. */
    site?: Record<string, IxPreset>;
}

export default function ContentRenderer({ data, ixPresets }: { data: any; ixPresets?: unknown }) {
    const content = Array.isArray(data?.content) ? data.content : [];

    // Los presets del sitio son dato hostil (los escribe un admin, pero también pueden llegar por
    // importación o restauración): `parseSiteIxPresets` los pasa entero por el normalizador.
    const site = parseSiteIxPresets(ixPresets);
    const ctx = ixCtxFromSite(site);
    const page = compileIxPage(collectIxSpecs(data), ctx);
    const hasSite = Object.keys(site).length > 0;
    const env: IxEnv = { ctx, page, ...(hasSite ? { site } : {}) };

    return (
        <>
            {page.css !== "" && (
                // `href` sin espacios (React avisa) y derivado del CONTENIDO: dos páginas con las
                // mismas interacciones comparten etiqueta, y editar un preajuste cambia el hash de
                // su cuerpo → cambia el href → el navegador no puede servir CSS viejo.
                <style href={`wjs-ix-${fnv1a32(page.css).toString(36)}`} precedence="wjs-ix">
                    {page.css}
                </style>
            )}
            {content.map((item: any, i: number) => renderItem(item, `c${i}`, undefined, env))}
            {/* Movimiento PERPETUO en la página ⇒ el visitante tiene que poder pararlo (WCAG 2.2.2,
                nivel A). El control es una casilla nativa y una regla `:has()`: cero JavaScript, y
                solo aparece cuando hay algo que pausar. */}
            {page.hasInfinite && <MotionPause />}
            {page.runtime.length > 0 && <IxRuntimeIsland units={page.runtime} />}
        </>
    );
}

/**
 * Subárbol de items sobre el MISMO switch de este módulo (una sola fuente de verdad de render).
 * `exclude` corta tipos en CUALQUIER profundidad devolviendo null — es el mecanismo del cap de
 * anidamiento de Symbol en Verso (excluir "Symbol" del subárbol = profundidad máxima 1, igual que
 * el config anidado sin Symbol del editor actual). Sin `exclude`, comportamiento idéntico al
 * renderer público.
 *
 * `ixPresets` (el catálogo del SITIO ya normalizado) viaja hasta aquí desde el servidor para que un
 * bloque dentro de un Symbol pueda usar un preajuste del sitio igual que uno de primer nivel. Lo
 * que NO viaja es la página compilada: contiene un `Map` y este componente puede renderizarse en el
 * cliente. Sin ella la clase sale del hash desnudo, que es el mismo salvo colisión.
 */
export function RenderSubtree({ items, exclude, ixPresets }: { items: unknown[]; exclude?: ReadonlySet<string>; ixPresets?: Record<string, IxPreset> }) {
    const list = Array.isArray(items) ? items : [];
    const env: IxEnv | undefined = ixPresets
        ? { ctx: ixCtxFromSite(ixPresets), site: ixPresets }
        : undefined;
    return <>{list.map((item: any, i: number) => renderItem(item, `s${i}`, exclude, env))}</>;
}

// One wrapper div per slot — identical DOM to Puck's SlotRender (className carries the container's
// layout class; items keyed by their stable editor id).
function slotOf(props: any, name: string, exclude?: ReadonlySet<string>, ix?: IxEnv) {
    const items = Array.isArray(props?.[name]) ? props[name] : [];
    // eslint-disable-next-line react/display-name
    return (className?: string) => (
        <div className={className}>
            {items.map((it: any, i: number) => renderItem(it, `${name}.${i}`, exclude, ix))}
        </div>
    );
}

function renderItem(item: any, fallbackKey: string, exclude?: ReadonlySet<string>, ix?: IxEnv): React.ReactNode {
    if (!item || typeof item !== "object" || typeof item.type !== "string") return null;
    if (exclude?.has(item.type)) return null;
    const props = (item.props || {}) as Record<string, any>;
    const key = typeof props.id === "string" ? props.id : fallbackKey;
    const core = renderCore(item.type, props, item, exclude, ix);
    if (core === undefined) {
        // Plugin block or Symbol: the client machinery renders it exactly as before F3.
        return <PluginBlockIsland key={key} item={item} ixPresets={ix?.site} />;
    }
    return (
        <SharedBlockShell key={key} hide={props.hide} anim={props.anim} look={props.look} ix={props.ix} ixCtx={ix?.ctx} ixPage={ix?.page}>
            {core}
        </SharedBlockShell>
    );
}

/** Core-block dispatch. Returns undefined for unknown types (→ PluginBlockIsland). */
function renderCore(type: string, props: Record<string, any>, item: any, exclude?: ReadonlySet<string>, ix?: IxEnv): React.ReactNode | undefined {
    switch (type) {
        // `ixCtx` DESPUÉS del spread, nunca antes: es el catálogo de preajustes con el que el
        // bloque decide si parte su texto en palabras, y un `_puck_data` hostil no puede
        // sustituirlo colando una clave con ese nombre en sus props.
        case "Heading": return <HeadingBlock {...props} ixCtx={ix?.ctx} />;
        case "Text": return <TextBlock {...props} />;
        case "Image": return <ImageBlock {...props} />;
        case "Divider": return <DividerBlock {...props} />;
        case "Button": return <ButtonBlock {...props} />;
        case "Spacer": return <SpacerBlock {...props} />;
        case "Section": return <SectionBlock {...props} slot={slotOf(props, "children", exclude, ix)} />;
        case "Grid": return <GridBlock {...props} slot={slotOf(props, "children", exclude, ix)} />;
        case "FlexRow": return <FlexRowBlock {...props} slot={slotOf(props, "children", exclude, ix)} />;
        case "Columns": return (
            <ColumnsBlock
                {...props}
                slots={["col-0", "col-1", "col-2"].map((name) => slotOf(props, name, exclude, ix))}
            />
        );
        case "Card": return <CardBlock {...props} />;
        case "Quote": return <QuoteBlock {...props} ixCtx={ix?.ctx} />;
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
        // Background layer with its own client island (canvas). Code-splits away from pages
        // that don't use it, exactly like the other islands.
        case "ParticleField": return <ParticleFieldBlock {...props} />;
        // Binds to the site menu: resolveDynamicBlocks injected the resolved item array server-side
        // (resolvedMenu), so the full <nav> + every <a> land in the SSR HTML; only the mobile toggle
        // is a client island. An empty/missing binding renders nothing on the public page.
        case "NavMenu": return <NavMenuBlock {...props} menu={props.resolvedMenu} />;
        // Hybrid: the menu structure is BOUND (resolvedMenu, same injection as NavMenu) while each
        // top-level item's flyout panel is an inline slot (panel0…panel5 → first 6 items in order,
        // the Columns multi-slot precedent). An EMPTY panel passes null so the item renders as a
        // plain link with no flyout markup; panel children render server-side (crawlable).
        case "MegaMenu": return (
            <MegaMenuBlock
                {...props}
                menu={props.resolvedMenu}
                panels={MEGA_MENU_PANEL_SLOTS.map((name) =>
                    Array.isArray(props[name]) && props[name].length > 0 ? slotOf(props, name, exclude, ix) : null,
                )}
            />
        );
        // Binds to the site identity: resolveDynamicBlocks injected the resolved { blogname, siteLogo }
        // server-side (resolvedIdentity), so the real logo/title land in the SSR HTML.
        case "SiteLogo": return <SiteLogoBlock {...props} identity={props.resolvedIdentity} />;
        // Floating scroll-to-top control: a whole-block client island (no SSR content needed).
        case "BackToTop": return <BackToTopBlock {...props} />;
        // Drawer with a CONTENT slot: panel + slotted children render server-side (crawlable); only the
        // open/close toggle is a client island. Slot resolved exactly like Section's `children`.
        case "OffCanvas": return <OffCanvasBlock {...props} slot={slotOf(props, "content", exclude, ix)} />;
        // Per-post site chrome: resolveDynamicBlocks' post-context pass injected resolvedTrail /
        // resolvedTranslations for THIS page; ToC's resolvedHeadings comes from the cached tree pass.
        // Each renders its links server-side (crawlable); an empty binding renders nothing on public.
        case "Breadcrumbs": return <BreadcrumbsBlock {...props} />;
        case "LangSwitcher": return <LangSwitcherBlock {...props} />;
        case "TableOfContents": return <TableOfContentsBlock {...props} />;
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

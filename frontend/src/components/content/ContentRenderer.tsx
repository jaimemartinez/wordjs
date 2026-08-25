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
    normalizeIxMotion,
    fnv1a32,
    ixCtxFromSite,
    parseSiteIxPresets,
    type IxCompileCtx,
    type IxMotionPolicy,
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
    MegaMenuBlock,
} from "./blocks";
import AccordionBlock from "./AccordionBlock";
import BackToTopBlock from "./BackToTop";
import TabsBlock from "./TabsBlock";
import SearchBarBlock from "./SearchBarBlock";
import PluginBlockIsland from "./PluginBlockIsland";
import { FormBlockRender } from "@/components/blocks/FormBlock";
import { CORE_BLOCK_SLOTS, CORE_BLOCK_TYPES } from "@/generated/verso-registry.generated";
import type { CoreBlockType } from "@/generated/visual-contract.types.generated";

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

export default function ContentRenderer({
    data,
    ixPresets,
    motion,
}: {
    data: any;
    ixPresets?: unknown;
    /** Política de movimiento del SITIO (C5), tal cual viene del ajuste: se normaliza aquí. */
    motion?: unknown;
}) {
    const content = Array.isArray(data?.content) ? data.content : [];

    // Los presets del sitio son dato hostil (los escribe un admin, pero también pueden llegar por
    // importación o restauración): `parseSiteIxPresets` los pasa entero por el normalizador.
    const site = parseSiteIxPresets(ixPresets);
    const ctx: IxCompileCtx = { ...ixCtxFromSite(site), motion: normalizeIxMotion(motion) };
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
export function RenderSubtree({ items, exclude, ixPresets, motion }: { items: unknown[]; exclude?: ReadonlySet<string>; ixPresets?: Record<string, IxPreset>; motion?: IxMotionPolicy }) {
    const list = Array.isArray(items) ? items : [];
    // La política del sitio (C5) también baja hasta aquí: un bloque dentro de un Symbol no es una
    // excepción al ajuste, y sin esto «apagar el movimiento» dejaba moviéndose justo lo anidado.
    const env: IxEnv | undefined = ixPresets || motion
        ? { ctx: { ...(ixPresets ? ixCtxFromSite(ixPresets) : {}), ...(motion ? { motion } : {}) }, ...(ixPresets ? { site: ixPresets } : {}) }
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
        return <PluginBlockIsland key={key} item={item} ixPresets={ix?.site} motion={ix?.ctx.motion} />;
    }
    return (
        <SharedBlockShell key={key} hide={props.hide} anim={props.anim} look={props.look} ix={props.ix} ixCtx={ix?.ctx} ixPage={ix?.page}>
            {core}
        </SharedBlockShell>
    );
}

type CoreRenderer = (
    props: Record<string, any>,
    item: any,
    exclude?: ReadonlySet<string>,
    ix?: IxEnv,
) => React.ReactNode | undefined;

/**
 * Implementation bindings for the generated registry. `satisfies Record<CoreBlockType, …>` is the
 * renderer gate: adding/removing a canonical block makes TypeScript fail until its implementation is
 * explicit. Slot names come from the generated registry as well.
 */
const CORE_RENDERERS = {
    Heading: (props, _item, _exclude, ix) => <HeadingBlock {...props} ixCtx={ix?.ctx} />,
    Text: (props) => <TextBlock {...props} />,
    Image: (props) => <ImageBlock {...props} />,
    Divider: (props) => <DividerBlock {...props} />,
    Button: (props) => <ButtonBlock {...props} />,
    Spacer: (props) => <SpacerBlock {...props} />,
    Section: (props, _item, exclude, ix) => <SectionBlock {...props} slot={slotOf(props, CORE_BLOCK_SLOTS.Section[0], exclude, ix)} />,
    Grid: (props, _item, exclude, ix) => <GridBlock {...props} slot={slotOf(props, CORE_BLOCK_SLOTS.Grid[0], exclude, ix)} />,
    FlexRow: (props, _item, exclude, ix) => <FlexRowBlock {...props} slot={slotOf(props, CORE_BLOCK_SLOTS.FlexRow[0], exclude, ix)} />,
    Columns: (props, _item, exclude, ix) => <ColumnsBlock {...props} slots={CORE_BLOCK_SLOTS.Columns.map((name) => slotOf(props, name, exclude, ix))} />,
    Card: (props) => <CardBlock {...props} />,
    Quote: (props, _item, _exclude, ix) => <QuoteBlock {...props} ixCtx={ix?.ctx} />,
    Table: (props) => <TableBlock {...props} />,
    IconList: (props) => <IconListBlock {...props} />,
    SocialLinks: (props) => <SocialLinksBlock {...props} />,
    Stats: (props) => <StatsBlock {...props} />,
    HTMLEmbed: (props) => <HTMLEmbedBlock {...props} />,
    PricingTable: (props) => <PricingTableBlock {...props} />,
    Testimonial: (props) => <TestimonialBlock {...props} />,
    CTABanner: (props) => <CTABannerBlock {...props} />,
    VideoEmbed: (props) => <VideoEmbedBlock {...props} />,
    Hero: (props) => <HeroBlock {...props} />,
    PostsGrid: (props) => <PostsGridBlock {...props} posts={props.resolvedPosts} />,
    CategoryPosts: (props) => <CategoryPostsBlock {...props} posts={props.resolvedPosts} />,
    AudioPlayer: (props) => <AudioPlayerBlock {...props} />,
    Accordion: (props) => <AccordionBlock {...props} />,
    Tabs: (props) => <TabsBlock {...props} />,
    SearchBar: (props) => <SearchBarBlock {...props} />,
    Form: (props) => <FormBlockRender {...(props as any)} />,
    Symbol: () => undefined,
    ParticleField: (props) => <ParticleFieldBlock {...props} />,
    NavMenu: (props) => <NavMenuBlock {...props} menu={props.resolvedMenu} />,
    SiteLogo: (props) => <SiteLogoBlock {...props} identity={props.resolvedIdentity} />,
    BackToTop: (props) => <BackToTopBlock {...props} />,
    OffCanvas: (props, _item, exclude, ix) => <OffCanvasBlock {...props} slot={slotOf(props, CORE_BLOCK_SLOTS.OffCanvas[0], exclude, ix)} />,
    Breadcrumbs: (props) => <BreadcrumbsBlock {...props} />,
    LangSwitcher: (props) => <LangSwitcherBlock {...props} />,
    TableOfContents: (props) => <TableOfContentsBlock {...props} />,
    MegaMenu: (props, _item, exclude, ix) => (
        <MegaMenuBlock
            {...props}
            menu={props.resolvedMenu}
            panels={CORE_BLOCK_SLOTS.MegaMenu.map((name) =>
                Array.isArray(props[name]) && props[name].length > 0 ? slotOf(props, name, exclude, ix) : null,
            )}
        />
    ),
} satisfies Record<CoreBlockType, CoreRenderer>;

const CORE_RENDERER_TYPES: ReadonlySet<string> = new Set(CORE_BLOCK_TYPES);

/** Core-block dispatch. Returns undefined for plugin/unknown types (→ PluginBlockIsland). */
function renderCore(type: string, props: Record<string, any>, item: any, exclude?: ReadonlySet<string>, ix?: IxEnv): React.ReactNode | undefined {
    if (!CORE_RENDERER_TYPES.has(type)) return undefined;
    return CORE_RENDERERS[type as CoreBlockType](props, item, exclude, ix);
}

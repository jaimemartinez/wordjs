"use client";
/**
 * Verso — registro de los 32 bloques core como TABLA DE DATOS (F3).
 *
 * Porta el registro de frontend/src/components/versoConfig.tsx al formato `BlockDefinition`:
 *  - `type`: EXACTAMENTE los strings del switch de ContentRenderer.tsx — contrato de serialización
 *    de `_puck_data`; renombrar uno rompe el render público de páginas ya guardadas.
 *  - `fields` / `defaultProps`: MISMA semántica byte a byte que versoConfig (nombres de prop,
 *    opciones de select/radio, labels literales ES que casan con el diccionario de editorI18n, y
 *    defaults idénticos) — el gate anti-drift (verso-coreBlocks.test.ts) los compara
 *    PROGRAMÁTICAMENTE contra versoConfig importado.
 *  - slots: declarados como `type: "slot"` (Section/Grid/FlexRow `children`; Columns
 *    `col-0`/`col-1`/`col-2`); Card NO tiene slots (title/description son props planas).
 *  - `inline`: los dos del editor actual (Text.content rich, Heading.title plain) MÁS la extensión
 *    ratificada del programa: Quote.text, Button.label, Card.title y CTABanner.title (plain).
 *    NOTA: el contrato `inline` es mono-prop; en Card se elige `title` (description quedará para
 *    una extensión multi-prop futura si se ratifica).
 *  - `render`: los MISMOS componentes compartidos que hoy (content/blocks.tsx + islas
 *    Accordion/Tabs/SearchBar/AudioTransport/SelfHostedVideo/FormBlock) con los adaptadores
 *    slot→prop que versoConfig ya hace. En Verso el slot llega como función `(className?)=>ReactNode`
 *    (VersoBlock), así que el adaptador es pasarlo como `slot`/`slots`, no envolver un componente.
 *    Symbol usa la variante Verso (components/verso/blocks/VersoSymbolBlock.tsx — RenderSubtree
 *    sobre el switch compartido, cap de profundidad 1) sin tocar el SymbolBlock público.
 *
 * Los controles custom se REUTILIZAN, nunca se duplican: CSSPropertiesControl, LinkField,
 * MediaPickerModal, y los cuatro que versoConfig ahora exporta (CategoryField, TemplateField,
 * ColumnDistributionControl, ColumnStyleAccordion). Una sola implementación, dos registros
 * durante la convivencia Puck↔Verso.
 *
 * NO PORTADO A PROPÓSITO (documentado, pendiente de una ola F3 posterior):
 *  - `resolveData` de Image (persistencia de srcSet/imgWidth/imgHeight desde la media library y
 *    saneo de srcSet ajeno) y de Columns (sync columnStyles↔columnCount + migración de props
 *    legacy css.gap/minHeight/backgroundColor/borderRadius). `BlockDefinition` aún no modela
 *    resolución async por bloque; el picker de Image SÍ registra el media elegido
 *    (rememberPickedMedia) para que el equivalente Verso pueda derivar el srcSet igual que hoy.
 *
 * Campos ROOT: la asimetría postConfig/pageConfig (SEO/category/allowComments SOLO en post) se
 * porta a DOS definiciones exportadas — rootFieldsPost / rootFieldsPage — jamás colapsadas.
 */
import React, { useState } from "react";
import { t as translate, getStoredLanguage } from "@/lib/i18n";
import { rememberPickedMedia } from "@/lib/imageSrcset";
import { useEditorPosts } from "@/lib/useEditorPosts";
import { useEditorMenu } from "@/lib/useEditorMenu";
import type { ChromeMenuItem } from "@/lib/chromeData";
import MediaPickerModal from "@/components/MediaPickerModal";
import LinkField from "@/components/blocks/LinkField";
import { CSSPropertiesControl, type CSSData } from "@/components/blocks/CSSControls";
import {
    CategoryField,
    TemplateField,
    ColumnDistributionControl,
    ColumnStyleAccordion,
    type ColumnDistribution,
    type ColumnStyle,
} from "@/components/versoConfig";
import { formBlockFields, formBlockDefaults, FormBlockRender } from "@/components/blocks/FormBlock";
import { symbolBlockFields, symbolBlockDefaults } from "@/components/blocks/SymbolBlock";
import VersoSymbolRender from "@/components/verso/blocks/VersoSymbolBlock";
import SearchBarBlockIsland from "@/components/content/SearchBarBlock";
import AccordionBlockIsland from "@/components/content/AccordionBlock";
import TabsBlockIsland from "@/components/content/TabsBlock";
import {
    HeadingBlock, TextBlock, ImageBlock, DividerBlock, ButtonBlock, SpacerBlock,
    SectionBlock, GridBlock, FlexRowBlock, ColumnsBlock, CardBlock, QuoteBlock,
    TableBlock, IconListBlock, SocialLinksBlock, StatsBlock, HTMLEmbedBlock,
    PricingTableBlock, TestimonialBlock, CTABannerBlock, VideoEmbedBlock, HeroBlock,
    PostsGridBlock, CategoryPostsBlock, AudioPlayerBlock, ParticleFieldBlock, NavMenuBlock,
    SiteLogoBlock, OffCanvasBlock,
} from "@/components/content/blocks";
import BackToTopBlock from "@/components/content/BackToTop";
import { useEditorIdentity } from "@/lib/useEditorIdentity";
import type { BlockDefinition, BlockRegistry, VersoField } from "./registry";
import { withSharedVersoFields } from "./sharedFields";

/* ------------------------------------------------------------------ */
/* Contrato de tipos (el switch público) y categorías.                 */
/* ------------------------------------------------------------------ */

/**
 * Los 35 `item.type` EXACTOS del switch de ContentRenderer.tsx, en su orden. Es el contrato de
 * serialización con el sitio público — el test lo compara contra su propia lista literal.
 * (ParticleField, el 31º, es el fondo animado de partículas: una isla de cliente con `<canvas>`.
 *  NavMenu, el 32º, VINCULA al menú del sitio por referencia: guarda solo la referencia y el store
 *  nav_menu sigue siendo la fuente de verdad — cero pérdida de datos.
 *  SiteLogo (33º) BINDS a la identidad del sitio (blogname + site_logo) igual que NavMenu al menú.
 *  BackToTop (34º) es un control flotante — el bloque ENTERO es una isla de cliente, sin SSR.
 *  OffCanvas (35º) es un cajón con SLOT de contenido: el panel y sus hijos se renderizan en servidor
 *  (rastreable) y solo el toggle es isla de cliente.)
 */
export const CORE_BLOCK_TYPES = [
    "Heading", "Text", "Image", "Divider", "Button", "Spacer",
    "Section", "Grid", "FlexRow", "Columns",
    "Card", "Quote", "Table", "IconList", "SocialLinks", "Stats", "HTMLEmbed",
    "PricingTable", "Testimonial", "CTABanner", "VideoEmbed", "Hero",
    "PostsGrid", "CategoryPosts", "AudioPlayer",
    "Accordion", "Tabs", "SearchBar", "Form", "Symbol",
    "ParticleField", "NavMenu", "SiteLogo", "BackToTop", "OffCanvas",
] as const;

export type CoreBlockType = (typeof CORE_BLOCK_TYPES)[number];

/** Las 5 categorías actuales de versoConfig (mismas claves, mismos labels vía i18n). */
export const coreBlockCategories: Record<string, string> = {
    layout: translate("editor.category.layout", getStoredLanguage()),
    content: translate("editor.category.content", getStoredLanguage()),
    "Card Gallery": translate("editor.category.cardGallery", getStoredLanguage()),
    "Video Gallery": translate("editor.category.videoGallery", getStoredLanguage()),
    "Photo Carousel": translate("editor.category.photoCarousel", getStoredLanguage()),
};

/* ------------------------------------------------------------------ */
/* Helpers de campos (misma semántica que los literales de versoConfig). */
/* ------------------------------------------------------------------ */

/** El escape hatch `css` presente en LOS 30 bloques — mismo label, mismo control. */
const cssField = (): VersoField => ({
    type: "custom",
    label: "Estilos CSS",
    render: ({ value, onChange }) => (
        <CSSPropertiesControl value={value as CSSData} onChange={onChange} />
    ),
});

const linkField = (label: string): VersoField => ({
    type: "custom",
    label,
    render: ({ value, onChange }) => <LinkField value={value as string} onChange={onChange} />,
});

/**
 * Campo de URL de media (input + «elegir de la biblioteca»). Réplica del custom inline de
 * versoConfig; `remember` reproduce la diferencia real entre Image (registra el MediaItem completo
 * para derivar srcSet) y Hero.bgImage (solo guarda la URL).
 */
function MediaUrlField({ value, onChange, placeholder, remember }: {
    value: unknown;
    onChange: (v: unknown) => void;
    placeholder: string;
    remember?: boolean;
}) {
    const [isModalOpen, setIsModalOpen] = useState(false);
    return (
        <div className="flex flex-col gap-2">
            <input
                className="p-2 border rounded text-sm w-full"
                value={(value as string) || ""}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
            />
            <button
                type="button"
                className="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-sm text-gray-700 border"
                onClick={() => setIsModalOpen(true)}
            >
                {translate("editor.field.selectFromMedia", getStoredLanguage())}
            </button>
            <MediaPickerModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                onSelect={(item) => {
                    if (remember) rememberPickedMedia(item);
                    // URL RELATIVA (sourceUrl), no guid — el guid incrusta el host de subida.
                    onChange(item.sourceUrl || item.guid);
                    setIsModalOpen(false);
                }}
            />
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Adaptadores de render (slot Verso → prop del componente compartido). */
/* ------------------------------------------------------------------ */

type BlockProps = Record<string, unknown>;
type SlotFn = (className?: string) => React.ReactNode;

/** En Verso el slot llega como función; si el nodo aún no tiene el slot, un slot vacío. */
const asSlot = (v: unknown): SlotFn => (typeof v === "function" ? (v as SlotFn) : () => null);

function SectionRender(props: BlockProps) {
    const { children, ...rest } = props;
    return <SectionBlock {...rest} slot={asSlot(children)} />;
}

function GridRender(props: BlockProps) {
    const { children, ...rest } = props;
    return <GridBlock {...rest} slot={asSlot(children)} />;
}

function FlexRowRender(props: BlockProps) {
    const { children, ...rest } = props;
    return <FlexRowBlock {...rest} slot={asSlot(children)} />;
}

function ColumnsRender(props: BlockProps) {
    const { "col-0": c0, "col-1": c1, "col-2": c2, ...rest } = props;
    return (
        <ColumnsBlock
            {...rest}
            slots={[c0, c1, c2].map((c) => (typeof c === "function" ? (c as SlotFn) : null))}
        />
    );
}

type InjectedPosts = Parameters<typeof useEditorPosts>[1];

function PostsGridRender(props: BlockProps) {
    const { count, resolvedPosts, isEditing, ...rest } = props;
    // Mismo contrato que versoConfig: posts reales inyectados por el resolver del servidor en el
    // público, o fetch cliente (mismo mapper) dentro del canvas del editor.
    const editing = !!isEditing;
    const posts = useEditorPosts(editing, resolvedPosts as InjectedPosts, undefined, count as number);
    return <PostsGridBlock {...rest} posts={posts} isEditing={editing} />;
}

function CategoryPostsRender(props: BlockProps) {
    const { categorySlug, count, resolvedPosts, isEditing, ...rest } = props;
    const editing = !!isEditing;
    const posts = useEditorPosts(
        editing,
        resolvedPosts as InjectedPosts,
        categorySlug as string | undefined,
        count as number,
    );
    return (
        <CategoryPostsBlock {...rest} posts={posts} categorySlug={categorySlug} isEditing={editing} />
    );
}

// NavMenu (canvas): el editor no tiene pase de servidor, así que el menú vinculado lo trae
// useEditorMenu del mismo store nav_menu (una vez por sesión). Inerte en público (resolvedMenu ya
// inyectado). Misma forma que PostsGridRender.
function NavMenuRender(props: BlockProps) {
    const { source, location, menuId, resolvedMenu, isEditing, ...rest } = props;
    const editing = !!isEditing;
    const menu = useEditorMenu(
        editing,
        resolvedMenu as ChromeMenuItem[] | undefined,
        { source: source as string, location: location as string, menuId: menuId as number | string },
    );
    return <NavMenuBlock {...rest} menu={menu} isEditing={editing} />;
}

// SiteLogo (canvas): the editor has no server pass, so the bound identity (blogname + site_logo) comes
// from useEditorIdentity reading the same /settings store. Inert in público (resolvedIdentity injected).
function SiteLogoRender(props: BlockProps) {
    const { resolvedIdentity, isEditing, ...rest } = props;
    const editing = !!isEditing;
    const identity = useEditorIdentity(editing, resolvedIdentity as { blogname: string; siteLogo: string } | undefined);
    return <SiteLogoBlock {...rest} identity={identity} isEditing={editing} />;
}

// OffCanvas (canvas): the content slot arrives as a function (Puck DropZone); pass it straight through
// as `slot`, exactly like SectionRender. `isEditing` drives the empty-slot authoring hint.
function OffCanvasRender(props: BlockProps) {
    const { content, isEditing, ...rest } = props;
    return <OffCanvasBlock {...rest} slot={asSlot(content)} isEditing={!!isEditing} />;
}

/* ------------------------------------------------------------------ */
/* La tabla: los 35 bloques.                                            */
/* ------------------------------------------------------------------ */

export const coreBlockDefinitions: BlockDefinition[] = [
    {
        type: "Heading",
        label: translate("editor.block.heading", getStoredLanguage()),
        category: "content",
        fields: {
            title: { type: "text" },
            level: {
                type: "select",
                options: [
                    { label: "H1", value: "h1" },
                    { label: "H2", value: "h2" },
                    { label: "H3", value: "h3" },
                ],
            },
            color: { type: "text", label: "Color del título (vacío = tema)" },
            size: { type: "text", label: "Tamaño (p. ej. 48 o 3rem)" },
            weight: {
                type: "select",
                label: "Grosor",
                options: [
                    { label: "Del tema", value: "" },
                    { label: "Normal", value: "400" },
                    { label: "Media", value: "500" },
                    { label: "Seminegrita", value: "600" },
                    { label: "Negrita", value: "700" },
                    { label: "Extranegrita", value: "800" },
                    { label: "Black", value: "900" },
                ],
            },
            tracking: { type: "text", label: "Espaciado entre letras (p. ej. -1)" },
            elementId: { type: "text", label: "ID / Ancla (opcional)" },
            css: cssField(),
        },
        defaultProps: {
            title: "Heading",
            level: "h2",
            color: "",
            size: "",
            weight: "",
            tracking: "",
            elementId: "",
            css: {},
        },
        inline: { prop: "title", schema: "plain" },
        // El render de este bloque emite los `<span class="wjs-ixw">` cuando su `ix` apunta a
        // `words` (blocks.tsx → splitForBlock). Sin esta declaración el panel no ofrece el objetivo.
        ixText: true,
        render: HeadingBlock,
    },
    {
        type: "Text",
        label: translate("editor.block.text", getStoredLanguage()),
        category: "content",
        fields: {
            color: { type: "text", label: "Color del texto (vacío = tema)" },
            size: { type: "text", label: "Tamaño (p. ej. 18 o 1.125rem)" },
            leading: { type: "text", label: "Interlineado (p. ej. 1.8)" },
            measure: { type: "text", label: "Ancho de línea máx. (p. ej. 680)" },
            elementId: { type: "text", label: "ID / Ancla (opcional)" },
            css: cssField(),
        },
        defaultProps: {
            content: "Escribe aquí...",
            color: "",
            size: "",
            leading: "",
            measure: "",
            elementId: "",
            css: {},
        },
        inline: { prop: "content", schema: "rich" },
        render: TextBlock,
    },
    {
        type: "Image",
        label: translate("editor.block.image", getStoredLanguage()),
        category: "content",
        fields: {
            src: {
                type: "custom",
                render: ({ value, onChange }) => (
                    <MediaUrlField
                        value={value}
                        onChange={onChange}
                        placeholder={translate("editor.field.imageUrl", getStoredLanguage())}
                        remember
                    />
                ),
            },
            alt: { type: "text", label: "Texto alternativo (SEO / accesibilidad)" },
            radius: { type: "text", label: "Redondeo (p. ej. 16)" },
            shadow: { type: "text", label: "Sombra CSS (vacío = tema)" },
            width: { type: "text", label: "Ancho (p. ej. 480 o 60%)" },
            fit: {
                type: "select",
                label: "Ajuste",
                options: [
                    { label: "Del tema", value: "" },
                    { label: "Cubrir", value: "cover" },
                    { label: "Contener", value: "contain" },
                ],
            },
            elementId: { type: "text", label: "ID / Ancla (opcional)" },
            css: cssField(),
        },
        defaultProps: {
            src: "/placeholder-image.svg",
            alt: "",
            borderRadius: 0,
            radius: "",
            shadow: "",
            width: "",
            fit: "",
            elementId: "",
            css: {},
        },
        render: ImageBlock,
    },
    {
        type: "Columns",
        label: translate("editor.block.columns", getStoredLanguage()),
        category: "layout",
        fields: {
            distribution: {
                type: "custom",
                label: "Distribución de columnas",
                render: ({ value, onChange }) => (
                    <ColumnDistributionControl value={value as ColumnDistribution} onChange={onChange} />
                ),
            },
            columnStyles: {
                type: "custom",
                label: "Estilos de columnas",
                render: ({ value, onChange }) => {
                    const currentStyles = (value as ColumnStyle[]) || [];
                    return (
                        <ColumnStyleAccordion
                            value={currentStyles}
                            onChange={onChange}
                            columnCount={currentStyles.length || 2}
                        />
                    );
                },
            },
            "col-0": { type: "slot" },
            "col-1": { type: "slot" },
            "col-2": { type: "slot" },
            gap: { type: "text", label: "Separación (p. ej. 24)" },
            minHeight: { type: "text", label: "Altura mínima (p. ej. 320)" },
            bg: { type: "text", label: "Fondo (vacío = tema)" },
            radius: { type: "text", label: "Redondeo (p. ej. 16)" },
            elementId: { type: "text", label: "ID / Ancla (opcional)" },
            css: cssField(),
        },
        defaultProps: {
            distribution: { columnCount: 2, widths: [50, 50] },
            "col-2": [],
            gap: "",
            minHeight: "",
            bg: "",
            radius: "",
            elementId: "",
            css: {},
        },
        render: ColumnsRender,
    },
    {
        type: "Card",
        label: translate("editor.block.card", getStoredLanguage()),
        category: "content",
        fields: {
            title: { type: "text" },
            description: { type: "textarea" },
            icon: { type: "text", label: "FontAwesome Icon (e.g. fa-star)" },
            theme: {
                type: "select",
                options: [
                    { label: "Light", value: "light" },
                    { label: "Dark", value: "dark" },
                    { label: "Accent", value: "accent" },
                ],
            },
            bg: { type: "text", label: "Fondo (vacío = tema)" },
            color: { type: "text", label: "Color del texto (vacío = tema)" },
            borderColor: { type: "text", label: "Color del borde" },
            radius: { type: "text", label: "Redondeo (p. ej. 24)" },
            pad: { type: "text", label: "Relleno (p. ej. 40)" },
            shadow: { type: "text", label: "Sombra CSS" },
            iconSize: { type: "text", label: "Tamaño del icono (p. ej. 64)" },
            iconBg: { type: "text", label: "Fondo del icono" },
            iconColor: { type: "text", label: "Color del icono" },
            titleSize: { type: "text", label: "Tamaño del título (p. ej. 28)" },
            titleWeight: {
                type: "select",
                label: "Grosor del título",
                options: [
                    { label: "Del tema", value: "" },
                    { label: "Seminegrita", value: "600" },
                    { label: "Negrita", value: "700" },
                    { label: "Extranegrita", value: "800" },
                    { label: "Black", value: "900" },
                ],
            },
            titleTransform: {
                type: "select",
                label: "Título en mayúsculas",
                options: [
                    { label: "Del tema", value: "" },
                    { label: "MAYÚSCULAS", value: "uppercase" },
                    { label: "Normal", value: "none" },
                ],
            },
            css: cssField(),
        },
        defaultProps: {
            title: "Card Title",
            description: "This is a card description. You can use it to highlight features or services.",
            icon: "fa-rocket",
            theme: "light",
            bg: "", color: "", borderColor: "", radius: "", pad: "", shadow: "",
            iconSize: "", iconBg: "", iconColor: "",
            titleSize: "", titleWeight: "", titleTransform: "",
            css: {},
        },
        inline: { prop: "title", schema: "plain" },
        render: CardBlock,
    },
    {
        type: "Divider",
        label: translate("editor.block.divider", getStoredLanguage()),
        category: "layout",
        fields: {
            type: {
                type: "select",
                options: [
                    { label: "Solid", value: "solid" },
                    { label: "Dashed", value: "dashed" },
                    { label: "Gradient", value: "gradient" },
                ],
            },
            color: { type: "text", label: "Color (vacío = tema)" },
            width: { type: "text", label: "Grosor (p. ej. 2)" },
            length: { type: "text", label: "Ancho (p. ej. 120 o 40%)" },
            gap: { type: "text", label: "Separación vertical (p. ej. 64)" },
            css: cssField(),
        },
        defaultProps: {
            type: "solid",
            color: "",
            width: "",
            length: "",
            gap: "",
            css: {},
        },
        render: DividerBlock,
    },
    {
        type: "Button",
        label: translate("editor.block.button", getStoredLanguage()),
        category: "content",
        fields: {
            label: { type: "text" },
            href: linkField("Enlace"),
            variant: {
                type: "radio",
                options: [
                    { label: "Primary", value: "primary" },
                    { label: "Secondary", value: "secondary" },
                    { label: "Outline", value: "outline" },
                ],
            },
            align: {
                type: "radio",
                options: [
                    { label: "Left", value: "left" },
                    { label: "Center", value: "center" },
                    { label: "Right", value: "right" },
                ],
            },
            bg: { type: "text", label: "Fondo (vacío = tema)" },
            color: { type: "text", label: "Color del texto (vacío = tema)" },
            radius: { type: "text", label: "Redondeo (p. ej. 999 para píldora)" },
            padY: { type: "text", label: "Relleno vertical (p. ej. 14)" },
            padX: { type: "text", label: "Relleno horizontal (p. ej. 32)" },
            size: { type: "text", label: "Tamaño de letra (p. ej. 15)" },
            weight: {
                type: "select",
                label: "Grosor",
                options: [
                    { label: "Del tema", value: "" },
                    { label: "Media", value: "500" },
                    { label: "Seminegrita", value: "600" },
                    { label: "Negrita", value: "700" },
                    { label: "Extranegrita", value: "800" },
                ],
            },
            css: cssField(),
        },
        defaultProps: {
            label: "Click Me",
            href: "#",
            variant: "primary",
            align: "left",
            bg: "",
            color: "",
            radius: "",
            padY: "",
            padX: "",
            size: "",
            weight: "",
            css: {},
        },
        inline: { prop: "label", schema: "plain" },
        render: ButtonBlock,
    },
    {
        type: "Spacer",
        label: translate("editor.block.spacer", getStoredLanguage()),
        category: "layout",
        fields: {
            height: { type: "text", label: "Altura (p. ej. 48 o 4rem)" },
            css: cssField(),
        },
        defaultProps: {
            height: "",
            css: {},
        },
        render: SpacerBlock,
    },
    {
        type: "Section",
        label: translate("editor.block.section", getStoredLanguage()),
        category: "layout",
        fields: {
            children: { type: "slot" },
            maxWidth: {
                type: "select",
                label: "Max Width",
                options: [
                    { label: "Full", value: "100%" },
                    { label: "Large (1280px)", value: "1280px" },
                    { label: "Medium (1024px)", value: "1024px" },
                    { label: "Small (768px)", value: "768px" },
                ],
            },
            pad: { type: "text", label: "Relleno (p. ej. 96 o 96px 24px)" },
            bg: { type: "text", label: "Fondo (vacío = tema)" },
            css: cssField(),
        },
        defaultProps: {
            maxWidth: "1280px",
            pad: "",
            bg: "",
            css: {},
        },
        render: SectionRender,
    },
    {
        type: "Grid",
        label: translate("editor.block.grid", getStoredLanguage()),
        category: "layout",
        fields: {
            children: { type: "slot" },
            columns: {
                type: "select",
                label: "Columns",
                options: [
                    { label: "2 Columns", value: "2" },
                    { label: "3 Columns", value: "3" },
                    { label: "4 Columns", value: "4" },
                    { label: "5 Columns", value: "5" },
                    { label: "6 Columns", value: "6" },
                ],
            },
            gap: { type: "text", label: "Gap (e.g. 20px)" },
            columnsTablet: {
                type: "select",
                label: "Columnas en tablet",
                options: [
                    { label: "Del tema (2)", value: "" },
                    { label: "1", value: "1" },
                    { label: "2", value: "2" },
                    { label: "3", value: "3" },
                ],
            },
            columnsMobile: {
                type: "select",
                label: "Columnas en móvil",
                options: [
                    { label: "Del tema (1)", value: "" },
                    { label: "1", value: "1" },
                    { label: "2", value: "2" },
                ],
            },
            css: cssField(),
        },
        defaultProps: {
            columns: "3",
            gap: "",
            columnsTablet: "",
            columnsMobile: "",
            css: {},
        },
        render: GridRender,
    },
    {
        type: "FlexRow",
        label: translate("editor.block.flexRow", getStoredLanguage()),
        category: "layout",
        fields: {
            children: { type: "slot" },
            justify: {
                type: "select",
                label: "Justify Content",
                options: [
                    { label: "Start", value: "flex-start" },
                    { label: "Center", value: "center" },
                    { label: "End", value: "flex-end" },
                    { label: "Space Between", value: "space-between" },
                    { label: "Space Around", value: "space-around" },
                ],
            },
            align: {
                type: "select",
                label: "Align Items",
                options: [
                    { label: "Start", value: "flex-start" },
                    { label: "Center", value: "center" },
                    { label: "End", value: "flex-end" },
                    { label: "Stretch", value: "stretch" },
                ],
            },
            gap: { type: "text", label: "Gap (e.g. 16px)" },
            wrap: {
                type: "radio",
                label: "Wrap",
                options: [
                    { label: "Yes", value: "wrap" },
                    { label: "No", value: "nowrap" },
                ],
            },
            direction: {
                type: "select",
                label: "Dirección",
                options: [
                    { label: "Fila", value: "row" },
                    { label: "Fila invertida", value: "row-reverse" },
                    { label: "Columna", value: "column" },
                    { label: "Columna invertida", value: "column-reverse" },
                ],
            },
            css: cssField(),
        },
        defaultProps: {
            justify: "flex-start",
            align: "center",
            gap: "",
            wrap: "wrap",
            direction: "row",
            css: {},
        },
        render: FlexRowRender,
    },
    {
        type: "Accordion",
        label: translate("editor.block.accordion", getStoredLanguage()),
        category: "layout",
        fields: {
            items: {
                type: "array",
                label: "Accordion Items",
                arrayFields: {
                    title: { type: "text" },
                    content: { type: "textarea" },
                },
            },
            bg: { type: "text", label: "Fondo (vacío = tema)" },
            borderColor: { type: "text", label: "Color del borde" },
            radius: { type: "text", label: "Redondeo (p. ej. 12)" },
            pad: { type: "text", label: "Relleno de la cabecera (p. ej. 16px 20px)" },
            headerBg: { type: "text", label: "Fondo de la cabecera" },
            headerColor: { type: "text", label: "Color de la cabecera" },
            activeColor: { type: "text", label: "Color al abrir" },
            panelBg: { type: "text", label: "Fondo del contenido" },
            panelColor: { type: "text", label: "Color del contenido" },
            css: cssField(),
        },
        defaultProps: {
            items: [
                { title: "Section 1", content: "Content for section 1" },
                { title: "Section 2", content: "Content for section 2" },
            ],
            bg: "", borderColor: "", radius: "", pad: "",
            headerBg: "", headerColor: "", activeColor: "", panelBg: "", panelColor: "",
            css: {},
        },
        render: AccordionBlockIsland,
    },
    {
        type: "Tabs",
        label: translate("editor.block.tabs", getStoredLanguage()),
        category: "layout",
        fields: {
            tabs: {
                type: "array",
                label: "Tabs",
                arrayFields: {
                    label: { type: "text" },
                    content: { type: "textarea" },
                },
            },
            color: { type: "text", label: "Color de las pestañas (vacío = tema)" },
            activeColor: { type: "text", label: "Color de la pestaña activa" },
            borderColor: { type: "text", label: "Color de la línea" },
            borderWidth: { type: "text", label: "Grosor de la línea (p. ej. 2)" },
            tabPad: { type: "text", label: "Relleno de la pestaña (p. ej. 12px 24px)" },
            panelBg: { type: "text", label: "Fondo del panel" },
            panelPad: { type: "text", label: "Relleno del panel (p. ej. 24)" },
            panelRadius: { type: "text", label: "Redondeo del panel (p. ej. 12)" },
            css: cssField(),
        },
        defaultProps: {
            tabs: [
                { label: "Tab 1", content: "Content for Tab 1" },
                { label: "Tab 2", content: "Content for Tab 2" },
                { label: "Tab 3", content: "Content for Tab 3" },
            ],
            color: "", activeColor: "", borderColor: "", borderWidth: "", tabPad: "",
            panelBg: "", panelPad: "", panelRadius: "",
            css: {},
        },
        render: TabsBlockIsland,
    },
    {
        type: "VideoEmbed",
        label: translate("editor.block.videoEmbed", getStoredLanguage()),
        category: "content",
        fields: {
            url: { type: "text", label: "Video URL (YouTube, Vimeo, o un archivo propio: /public/media/x.mp4)" },
            poster: { type: "text", label: "Póster (solo archivos propios)" },
            aspectRatio: {
                type: "select",
                label: "Aspect Ratio",
                options: [
                    { label: "16:9", value: "56.25%" },
                    { label: "4:3", value: "75%" },
                    { label: "1:1", value: "100%" },
                ],
            },
            radius: { type: "text", label: "Redondeo (p. ej. 12)" },
            bg: { type: "text", label: "Fondo mientras carga (vacío = tema)" },
            css: cssField(),
        },
        defaultProps: {
            url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
            poster: "",
            aspectRatio: "56.25%",
            radius: "",
            bg: "",
            css: {},
        },
        render: VideoEmbedBlock,
    },
    {
        type: "AudioPlayer",
        label: translate("editor.block.audioPlayer", getStoredLanguage()),
        category: "content",
        fields: {
            src: { type: "text", label: "Audio URL" },
            title: { type: "text", label: "Track Title" },
            bg: { type: "text", label: "Fondo (vacío = tema)" },
            borderColor: { type: "text", label: "Color del borde" },
            radius: { type: "text", label: "Redondeo (p. ej. 12)" },
            pad: { type: "text", label: "Relleno (p. ej. 24)" },
            iconSize: { type: "text", label: "Tamaño del icono (p. ej. 48)" },
            iconBg: { type: "text", label: "Fondo del icono" },
            iconColor: { type: "text", label: "Color del icono" },
            css: cssField(),
        },
        defaultProps: {
            src: "",
            title: "Audio Track",
            bg: "", borderColor: "", radius: "", pad: "",
            iconSize: "", iconBg: "", iconColor: "",
            css: {},
        },
        render: AudioPlayerBlock,
    },
    {
        type: "PricingTable",
        label: translate("editor.block.pricingTable", getStoredLanguage()),
        category: "content",
        fields: {
            plans: {
                type: "array",
                label: "Plans",
                arrayFields: {
                    name: { type: "text" },
                    price: { type: "text" },
                    period: { type: "text" },
                    features: { type: "textarea" },
                    highlighted: { type: "radio", options: [{ label: "Yes", value: "true" }, { label: "No", value: "false" }] },
                    buttonText: { type: "text" },
                    buttonLink: { type: "text" },
                },
            },
            accent: { type: "text", label: "Color de acento (plan destacado)" },
            bg: { type: "text", label: "Fondo de los planes" },
            pad: { type: "text", label: "Relleno (p. ej. 48)" },
            radius: { type: "text", label: "Redondeo (p. ej. 24)" },
            gap: { type: "text", label: "Separación (p. ej. 32)" },
            priceSize: { type: "text", label: "Tamaño del precio (p. ej. 56)" },
            highlightScale: { type: "text", label: "Escala del destacado (p. ej. 1.08; 1 = sin escalar)" },
            css: cssField(),
        },
        defaultProps: {
            plans: [
                { name: "Basic", price: "$9", period: "/month", features: "Feature 1\nFeature 2\nFeature 3", highlighted: "false", buttonText: "Get Started", buttonLink: "#" },
                { name: "Pro", price: "$29", period: "/month", features: "Everything in Basic\nFeature 4\nFeature 5\nPriority Support", highlighted: "true", buttonText: "Get Started", buttonLink: "#" },
                { name: "Enterprise", price: "$99", period: "/month", features: "Everything in Pro\nCustom Features\nDedicated Support\nSLA", highlighted: "false", buttonText: "Contact Us", buttonLink: "#" },
            ],
            accent: "", bg: "", pad: "", radius: "", gap: "", priceSize: "", highlightScale: "",
            css: {},
        },
        render: PricingTableBlock,
    },
    {
        type: "Testimonial",
        label: translate("editor.block.testimonial", getStoredLanguage()),
        category: "content",
        fields: {
            quote: { type: "textarea", label: "Quote" },
            author: { type: "text", label: "Author Name" },
            role: { type: "text", label: "Role / Company" },
            avatar: { type: "text", label: "Avatar URL" },
            bg: { type: "text", label: "Fondo (vacío = tema)" },
            pad: { type: "text", label: "Relleno (p. ej. 48)" },
            radius: { type: "text", label: "Redondeo (p. ej. 24)" },
            quoteSize: { type: "text", label: "Tamaño de la cita (p. ej. 24)" },
            accent: { type: "text", label: "Color de acento (comillas y avatar)" },
            avatarSize: { type: "text", label: "Tamaño del avatar (p. ej. 72)" },
            css: cssField(),
        },
        defaultProps: {
            quote: "This product has completely transformed how we work. I can't imagine going back to the old way.",
            author: "Jane Doe",
            role: "CEO, Acme Inc.",
            avatar: "",
            bg: "", pad: "", radius: "", quoteSize: "", accent: "", avatarSize: "",
            css: {},
        },
        render: TestimonialBlock,
    },
    {
        type: "CTABanner",
        label: translate("editor.block.ctaBanner", getStoredLanguage()),
        category: "content",
        fields: {
            title: { type: "text", label: "Title" },
            subtitle: { type: "text", label: "Subtitle" },
            buttonText: { type: "text", label: "Button Text" },
            buttonLink: linkField("Button Link"),
            variant: {
                type: "select",
                label: "Style",
                options: [
                    { label: "Primary", value: "primary" },
                    { label: "Dark", value: "dark" },
                    { label: "Gradient", value: "gradient" },
                ],
            },
            bg: { type: "text", label: "Fondo o degradado (vacío = variante)" },
            color: { type: "text", label: "Color del texto" },
            pad: { type: "text", label: "Relleno (p. ej. 80px 40px)" },
            radius: { type: "text", label: "Redondeo (p. ej. 32)" },
            titleSize: { type: "text", label: "Tamaño del título (p. ej. 48)" },
            buttonBg: { type: "text", label: "Fondo del botón" },
            buttonColor: { type: "text", label: "Color del botón" },
            css: cssField(),
        },
        defaultProps: {
            title: "Ready to get started?",
            subtitle: "Join thousands of satisfied customers today.",
            buttonText: "Get Started Free",
            buttonLink: "#",
            variant: "gradient",
            bg: "", color: "", pad: "", radius: "", titleSize: "", buttonBg: "", buttonColor: "",
            css: {},
        },
        inline: { prop: "title", schema: "plain" },
        render: CTABannerBlock,
    },
    {
        type: "PostsGrid",
        label: translate("editor.block.postsGrid", getStoredLanguage()),
        category: "content",
        fields: {
            count: { type: "number", label: "Number of Posts", min: 1, max: 12 },
            columns: {
                type: "select",
                label: "Columns",
                options: [
                    { label: "2", value: "2" },
                    { label: "3", value: "3" },
                    { label: "4", value: "4" },
                ],
            },
            gap: { type: "text", label: "Separación (p. ej. 24)" },
            bg: { type: "text", label: "Fondo de las tarjetas (vacío = tema)" },
            borderColor: { type: "text", label: "Color del borde" },
            radius: { type: "text", label: "Redondeo (p. ej. 12)" },
            pad: { type: "text", label: "Relleno (p. ej. 24)" },
            thumbHeight: { type: "text", label: "Alto de la miniatura (p. ej. 160)" },
            css: cssField(),
        },
        defaultProps: {
            count: 6,
            columns: "3",
            gap: "", bg: "", borderColor: "", radius: "", pad: "", thumbHeight: "",
            css: {},
        },
        render: PostsGridRender,
    },
    {
        type: "Form",
        label: "Formulario",
        category: "content",
        fields: { ...(formBlockFields as unknown as Record<string, VersoField>) },
        defaultProps: { ...formBlockDefaults },
        render: FormBlockRender,
    },
    {
        type: "Symbol",
        // Variante Verso: RenderSubtree sobre el switch compartido de ContentRenderer con cap de
        // profundidad 1 (exclusión de Symbol en el subárbol) — el SymbolBlock público (que depende
        // de <Render> de @wordjs/puck) queda intacto.
        label: "Símbolo",
        category: "content",
        fields: { ...(symbolBlockFields as unknown as Record<string, VersoField>) },
        defaultProps: { ...symbolBlockDefaults },
        render: VersoSymbolRender,
    },
    {
        type: "CategoryPosts",
        label: translate("editor.block.categoryPosts", getStoredLanguage()),
        category: "content",
        fields: {
            categorySlug: { type: "text", label: "Category Slug" },
            count: { type: "number", label: "Number of Posts", min: 1, max: 10 },
            layout: {
                type: "select",
                label: "Layout",
                options: [
                    { label: "List", value: "list" },
                    { label: "Grid", value: "grid" },
                ],
            },
            columns: {
                type: "select",
                label: "Columnas (rejilla)",
                options: [
                    { label: "Del tema (2)", value: "" },
                    { label: "1", value: "1" },
                    { label: "2", value: "2" },
                    { label: "3", value: "3" },
                ],
            },
            gap: { type: "text", label: "Separación (p. ej. 20)" },
            bg: { type: "text", label: "Fondo de las tarjetas (vacío = tema)" },
            borderColor: { type: "text", label: "Color de las líneas" },
            radius: { type: "text", label: "Redondeo (p. ej. 12)" },
            linkColor: { type: "text", label: "Color de los enlaces" },
            headingColor: { type: "text", label: "Color del título" },
            css: cssField(),
        },
        defaultProps: {
            categorySlug: "news",
            count: 5,
            layout: "list",
            columns: "", gap: "", bg: "", borderColor: "", radius: "", linkColor: "", headingColor: "",
            css: {},
        },
        render: CategoryPostsRender,
    },
    {
        type: "SearchBar",
        label: translate("editor.block.searchBar", getStoredLanguage()),
        category: "content",
        fields: {
            placeholder: { type: "text", label: "Placeholder Text" },
            buttonText: { type: "text", label: "Button Text (leave empty for icon only)" },
            searchPage: { type: "text", label: "Search Results Page URL" },
            align: {
                type: "select",
                label: "Alignment",
                options: [
                    { label: "Left", value: "flex-start" },
                    { label: "Center", value: "center" },
                    { label: "Right", value: "flex-end" },
                ],
            },
            width: {
                type: "select",
                label: "Width",
                options: [
                    { label: "Small (300px)", value: "300px" },
                    { label: "Medium (500px)", value: "500px" },
                    { label: "Large (700px)", value: "700px" },
                    { label: "Full Width", value: "100%" },
                ],
            },
            inputBg: { type: "text", label: "Fondo del campo (vacío = tema)" },
            inputBorderColor: { type: "text", label: "Color del borde del campo" },
            inputRadius: { type: "text", label: "Redondeo del campo (p. ej. 8)" },
            buttonBg: { type: "text", label: "Fondo del botón" },
            buttonColor: { type: "text", label: "Color del botón" },
            buttonRadius: { type: "text", label: "Redondeo del botón (p. ej. 8)" },
            css: cssField(),
        },
        defaultProps: {
            placeholder: "Search...",
            buttonText: "Search",
            searchPage: "/search",
            align: "flex-start",
            width: "500px",
            inputBg: "", inputBorderColor: "", inputRadius: "",
            buttonBg: "", buttonColor: "", buttonRadius: "",
            css: {},
        },
        render: SearchBarBlockIsland,
    },
    {
        type: "Hero",
        label: "Hero",
        category: "layout",
        fields: {
            title: { type: "text", label: "Título" },
            subtitle: { type: "textarea", label: "Subtítulo" },
            bgImage: {
                type: "custom",
                label: "Imagen de fondo",
                render: ({ value, onChange }) => (
                    <MediaUrlField value={value} onChange={onChange} placeholder="URL de la imagen" />
                ),
            },
            overlay: {
                type: "select",
                label: "Oscurecer fondo",
                options: [
                    { label: "Sin capa", value: "0" },
                    { label: "Suave (30%)", value: "0.3" },
                    { label: "Media (50%)", value: "0.5" },
                    { label: "Fuerte (70%)", value: "0.7" },
                ],
            },
            height: {
                type: "select",
                label: "Altura",
                options: [
                    { label: "Compacto (40vh)", value: "40vh" },
                    { label: "Medio (60vh)", value: "60vh" },
                    { label: "Grande (80vh)", value: "80vh" },
                    { label: "Pantalla completa", value: "100vh" },
                ],
            },
            align: {
                type: "radio",
                label: "Alineación",
                options: [
                    { label: "Izquierda", value: "flex-start" },
                    { label: "Centro", value: "center" },
                ],
            },
            buttons: {
                type: "array",
                label: "Botones",
                arrayFields: {
                    label: { type: "text", label: "Texto" },
                    href: linkField("Enlace"),
                    variant: {
                        type: "radio",
                        options: [
                            { label: "Primario", value: "primary" },
                            { label: "Contorno", value: "outline" },
                        ],
                    },
                },
            },
            overlayColor: { type: "text", label: "Color de la capa (vacío = negro)" },
            gradientFrom: { type: "text", label: "Degradado — desde (sin imagen)" },
            gradientTo: { type: "text", label: "Degradado — hasta" },
            gradientAngle: { type: "text", label: "Degradado — ángulo (p. ej. 135)" },
            titleSize: { type: "text", label: "Tamaño del titular (p. ej. 72)" },
            titleWeight: {
                type: "select",
                label: "Grosor del titular",
                options: [
                    { label: "Del tema", value: "" },
                    { label: "Negrita", value: "700" },
                    { label: "Extranegrita", value: "800" },
                    { label: "Black", value: "900" },
                ],
            },
            titleTracking: { type: "text", label: "Espaciado del titular (p. ej. -2)" },
            subtitleSize: { type: "text", label: "Tamaño del subtítulo (p. ej. 22)" },
            color: { type: "text", label: "Color del texto (vacío = blanco)" },
            pad: { type: "text", label: "Relleno (p. ej. 96 o 96px 24px)" },
            measure: { type: "text", label: "Ancho del contenido (p. ej. 900)" },
            elementId: { type: "text", label: "ID / Ancla (opcional)" },
            css: cssField(),
        },
        defaultProps: {
            title: "Un titular que atrapa",
            subtitle: "Explica en una frase el valor de tu sitio. Cambia la imagen, la altura y la capa oscura desde el panel.",
            bgImage: "",
            overlay: "0.5",
            overlayColor: "",
            height: "60vh",
            align: "center",
            buttons: [{ label: "Empezar", href: "#", variant: "primary" }],
            gradientFrom: "", gradientTo: "", gradientAngle: "",
            titleSize: "", titleWeight: "", titleTracking: "", subtitleSize: "",
            color: "", pad: "", measure: "",
            elementId: "",
            css: {},
        },
        render: HeroBlock,
    },
    {
        type: "Quote",
        label: "Cita",
        category: "content",
        fields: {
            text: { type: "textarea", label: "Cita" },
            cite: { type: "text", label: "Autor / fuente" },
            style: {
                type: "radio",
                label: "Estilo",
                options: [
                    { label: "Barra lateral", value: "bar" },
                    { label: "Grande centrada", value: "large" },
                ],
            },
            accent: { type: "text", label: "Color de acento (barra / comillas)" },
            size: { type: "text", label: "Tamaño del texto (p. ej. 24)" },
            color: { type: "text", label: "Color del texto" },
            quoteStyle: {
                type: "select",
                label: "Cursiva",
                options: [
                    { label: "Del tema (cursiva)", value: "" },
                    { label: "Cursiva", value: "italic" },
                    { label: "Normal", value: "normal" },
                ],
            },
            css: cssField(),
        },
        defaultProps: {
            text: "El mejor momento para plantar un árbol fue hace veinte años. El segundo mejor momento es ahora.",
            cite: "Proverbio",
            style: "bar",
            accent: "", size: "", color: "", quoteStyle: "",
            css: {},
        },
        inline: { prop: "text", schema: "plain" },
        ixText: true,
        render: QuoteBlock,
    },
    {
        type: "Table",
        label: "Tabla",
        category: "content",
        fields: {
            header: { type: "text", label: "Cabecera (columnas separadas por | )" },
            rows: {
                type: "array",
                label: "Filas",
                arrayFields: {
                    cells: { type: "text", label: "Celdas (separadas por | )" },
                },
            },
            striped: {
                type: "radio",
                label: "Filas alternas",
                options: [
                    { label: "Sí", value: "true" },
                    { label: "No", value: "false" },
                ],
            },
            stripeBg: { type: "text", label: "Color de las filas alternas" },
            css: cssField(),
        },
        defaultProps: {
            header: "Plan | Precio | Soporte",
            rows: [
                { cells: "Básico | 9 € | Email" },
                { cells: "Pro | 29 € | Prioritario" },
            ],
            striped: "true",
            stripeBg: "",
            css: {},
        },
        render: TableBlock,
    },
    {
        type: "IconList",
        label: "Lista con iconos",
        category: "content",
        fields: {
            items: {
                type: "array",
                label: "Elementos",
                arrayFields: {
                    icon: { type: "text", label: "Icono FontAwesome (fa-check)" },
                    title: { type: "text", label: "Título" },
                    text: { type: "textarea", label: "Descripción" },
                },
            },
            columns: {
                type: "select",
                label: "Columnas",
                options: [
                    { label: "1", value: "1" },
                    { label: "2", value: "2" },
                    { label: "3", value: "3" },
                ],
            },
            gap: { type: "text", label: "Separación (p. ej. 40)" },
            iconSize: { type: "text", label: "Tamaño del icono (p. ej. 56)" },
            iconBg: { type: "text", label: "Fondo del icono" },
            iconColor: { type: "text", label: "Color del icono" },
            css: cssField(),
        },
        defaultProps: {
            items: [
                { icon: "fa-bolt", title: "Rápido", text: "Describe una ventaja clave en una frase." },
                { icon: "fa-shield", title: "Seguro", text: "Describe una ventaja clave en una frase." },
                { icon: "fa-heart", title: "Cuidado", text: "Describe una ventaja clave en una frase." },
            ],
            columns: "3",
            gap: "", iconSize: "", iconBg: "", iconColor: "",
            css: {},
        },
        render: IconListBlock,
    },
    {
        type: "SocialLinks",
        label: "Redes sociales",
        category: "content",
        fields: {
            items: {
                type: "array",
                label: "Redes",
                arrayFields: {
                    network: {
                        type: "select",
                        label: "Red",
                        options: [
                            { label: "Facebook", value: "facebook" },
                            { label: "Instagram", value: "instagram" },
                            { label: "X (Twitter)", value: "x-twitter" },
                            { label: "LinkedIn", value: "linkedin" },
                            { label: "YouTube", value: "youtube" },
                            { label: "TikTok", value: "tiktok" },
                            { label: "GitHub", value: "github" },
                            { label: "WhatsApp", value: "whatsapp" },
                        ],
                    },
                    url: { type: "text", label: "URL del perfil" },
                },
            },
            align: {
                type: "radio",
                label: "Alineación",
                options: [
                    { label: "Izquierda", value: "flex-start" },
                    { label: "Centro", value: "center" },
                    { label: "Derecha", value: "flex-end" },
                ],
            },
            size: { type: "text", label: "Tamaño (p. ej. 52)" },
            radius: { type: "text", label: "Redondeo (p. ej. 12; vacío = círculo)" },
            bg: { type: "text", label: "Fondo" },
            color: { type: "text", label: "Color del icono" },
            hoverBg: { type: "text", label: "Fondo al pasar el ratón" },
            gap: { type: "text", label: "Separación (p. ej. 16)" },
            css: cssField(),
        },
        defaultProps: {
            items: [
                { network: "instagram", url: "#" },
                { network: "facebook", url: "#" },
                { network: "x-twitter", url: "#" },
            ],
            align: "flex-start",
            size: "", radius: "", bg: "", color: "", hoverBg: "", gap: "",
            css: {},
        },
        render: SocialLinksBlock,
    },
    {
        type: "Stats",
        label: "Cifras",
        category: "content",
        fields: {
            items: {
                type: "array",
                label: "Cifras",
                arrayFields: {
                    value: { type: "text", label: "Valor (ej. 1.200+)" },
                    label: { type: "text", label: "Etiqueta" },
                },
            },
            gap: { type: "text", label: "Separación (p. ej. 40)" },
            valueSize: { type: "text", label: "Tamaño de la cifra (p. ej. 56)" },
            valueColor: { type: "text", label: "Color de la cifra" },
            labelColor: { type: "text", label: "Color de la etiqueta" },
            labelTransform: {
                type: "select",
                label: "Etiqueta en mayúsculas",
                options: [
                    { label: "Del tema", value: "" },
                    { label: "MAYÚSCULAS", value: "uppercase" },
                    { label: "Normal", value: "none" },
                ],
            },
            css: cssField(),
        },
        defaultProps: {
            items: [
                { value: "1.200+", label: "Clientes" },
                { value: "98%", label: "Satisfacción" },
                { value: "24/7", label: "Soporte" },
            ],
            gap: "", valueSize: "", valueColor: "", labelColor: "", labelTransform: "",
            css: {},
        },
        render: StatsBlock,
    },
    {
        type: "HTMLEmbed",
        label: "HTML personalizado",
        category: "content",
        fields: {
            html: { type: "textarea", label: "Código HTML" },
            css: cssField(),
        },
        defaultProps: {
            html: "<p>Pega aquí tu HTML. Se limpia automáticamente (sin scripts).</p>",
            css: {},
        },
        render: HTMLEmbedBlock,
    },
    {
        // Fondo animado de partículas (constelación). Isla de cliente con `<canvas>`: el motor de
        // interacciones compila a CSS sin JS y un tema jamás envía JS, así que el efecto vive aquí.
        type: "ParticleField",
        label: "Campo de partículas",
        category: "layout",
        fields: {
            count: { type: "number", label: "Número de partículas", min: 0, max: 200 },
            color: { type: "text", label: "Color (vacío = color primario del tema)" },
            speed: {
                type: "select",
                label: "Velocidad",
                options: [
                    { label: "Lenta", value: "slow" },
                    { label: "Media", value: "medium" },
                    { label: "Rápida", value: "fast" },
                ],
            },
            linkLines: {
                type: "radio",
                label: "Conectar con líneas (constelación)",
                options: [
                    { label: "Sí", value: "true" },
                    { label: "No", value: "false" },
                ],
            },
            linkDistance: { type: "number", label: "Distancia máx. de las líneas (px)", min: 0, max: 400 },
            pointer: {
                type: "radio",
                label: "Reaccionar al puntero",
                options: [
                    { label: "Sí", value: "true" },
                    { label: "No", value: "false" },
                ],
            },
            css: cssField(),
        },
        defaultProps: {
            count: 70,
            color: "",
            speed: "medium",
            linkLines: "true",
            linkDistance: 130,
            pointer: "false",
            css: {},
        },
        render: ParticleFieldBlock,
    },
    {
        // NavMenu: BINDS al menú del sitio por referencia (ubicación o id) — el store nav_menu sigue
        // siendo la fuente de verdad. Render SSR completo del <nav> + cada <a>; solo el toggle móvil
        // es isla de cliente. Los campos deben coincidir BYTE A BYTE con versoConfig.NavMenu.
        type: "NavMenu",
        label: "Menú de navegación",
        category: "layout",
        fields: {
            source: {
                type: "select",
                label: "Origen",
                options: [
                    { label: "Ubicación", value: "location" },
                    { label: "Menú", value: "menu" },
                ],
            },
            location: { type: "text", label: "Ubicación del menú (p. ej. header)" },
            menuId: { type: "number", label: "ID del menú (si el origen es Menú)", min: 0 },
            orientation: {
                type: "select",
                label: "Orientación",
                options: [
                    { label: "Horizontal", value: "horizontal" },
                    { label: "Vertical", value: "vertical" },
                ],
            },
            depth: { type: "number", label: "Profundidad de submenús (1–3)", min: 1, max: 3 },
            submenuTrigger: {
                type: "select",
                label: "Apertura de submenús",
                options: [
                    { label: "Hover", value: "hover" },
                    { label: "Click", value: "click" },
                ],
            },
            mobileBehavior: {
                type: "select",
                label: "En móvil",
                options: [
                    { label: "Colapsar", value: "collapse" },
                    { label: "Cajón", value: "drawer" },
                    { label: "Ninguno", value: "none" },
                ],
            },
            align: {
                type: "select",
                label: "Alineación",
                options: [
                    { label: "Inicio", value: "start" },
                    { label: "Centro", value: "center" },
                    { label: "Fin", value: "end" },
                ],
            },
            css: cssField(),
        },
        defaultProps: {
            source: "location",
            location: "header",
            menuId: 0,
            orientation: "horizontal",
            depth: 2,
            submenuTrigger: "hover",
            mobileBehavior: "drawer",
            align: "start",
            css: {},
        },
        render: NavMenuRender,
    },
    {
        // SiteLogo: BINDS a la identidad del sitio (blogname + site_logo) — el store de ajustes es la
        // fuente de verdad. Los campos deben coincidir BYTE A BYTE con versoConfig.SiteLogo.
        type: "SiteLogo",
        label: "Logotipo del sitio",
        category: "layout",
        fields: {
            mode: {
                type: "select",
                label: "Mostrar",
                options: [
                    { label: "Logotipo", value: "logo" },
                    { label: "Título", value: "title" },
                    { label: "Ambos", value: "both" },
                ],
            },
            linkToHome: {
                type: "radio",
                label: "Enlazar al inicio",
                options: [
                    { label: "Sí", value: true },
                    { label: "No", value: false },
                ],
            },
            maxHeight: { type: "number", label: "Altura máx. del logo (px)", min: 0 },
            altOverride: { type: "text", label: "Texto alternativo (opcional)" },
            css: cssField(),
        },
        defaultProps: {
            mode: "both",
            linkToHome: true,
            maxHeight: 40,
            altOverride: "",
            css: {},
        },
        render: SiteLogoRender,
    },
    {
        // BackToTop: el bloque ENTERO es una isla de cliente (control flotante, sin contenido SSR).
        type: "BackToTop",
        label: "Volver arriba",
        category: "layout",
        fields: {
            showAfter: { type: "number", label: "Aparece tras (px)", min: 0 },
            position: {
                type: "select",
                label: "Posición",
                options: [
                    { label: "Abajo derecha", value: "br" },
                    { label: "Abajo izquierda", value: "bl" },
                ],
            },
            smoothScroll: {
                type: "radio",
                label: "Desplazamiento suave",
                options: [
                    { label: "Sí", value: true },
                    { label: "No", value: false },
                ],
            },
            label: { type: "text", label: "Etiqueta accesible" },
            icon: { type: "text", label: "Icono (Font Awesome, p. ej. fa-arrow-up)" },
            css: cssField(),
        },
        defaultProps: {
            showAfter: 400,
            position: "br",
            smoothScroll: true,
            label: "Arriba",
            icon: "fa-arrow-up",
            css: {},
        },
        render: BackToTopBlock,
    },
    {
        // OffCanvas: cajón con SLOT de contenido. El panel y sus hijos se renderizan en SERVIDOR; solo
        // el toggle es isla de cliente. `content` es un slot como el `children` de Section.
        type: "OffCanvas",
        label: "Cajón lateral (OffCanvas)",
        category: "layout",
        fields: {
            content: { type: "slot" },
            triggerLabel: { type: "text", label: "Texto del botón" },
            triggerIcon: { type: "text", label: "Icono del botón (Font Awesome)" },
            side: {
                type: "select",
                label: "Lado",
                options: [
                    { label: "Izquierda", value: "left" },
                    { label: "Derecha", value: "right" },
                ],
            },
            breakpoint: {
                type: "select",
                label: "Mostrar como cajón",
                options: [
                    { label: "Siempre", value: "always" },
                    { label: "Solo en móvil (< md)", value: "md" },
                    { label: "Móvil y tablet (< lg)", value: "lg" },
                ],
            },
            closeOnEsc: {
                type: "radio",
                label: "Cerrar con Escape",
                options: [
                    { label: "Sí", value: true },
                    { label: "No", value: false },
                ],
            },
            scrollLock: {
                type: "radio",
                label: "Bloquear scroll al abrir",
                options: [
                    { label: "Sí", value: true },
                    { label: "No", value: false },
                ],
            },
            css: cssField(),
        },
        defaultProps: {
            triggerLabel: "Menú",
            triggerIcon: "fa-bars",
            side: "left",
            breakpoint: "always",
            closeOnEsc: true,
            scrollLock: true,
            css: {},
        },
        render: OffCanvasRender,
    },
];

/**
 * Alta de los 35 bloques core en un registry, pasando CADA definición por el seam
 * `withSharedVersoFields` — el mismo punto de inyección único que withSharedBlockFields hoy.
 */
export function registerCoreBlocks(registry: BlockRegistry): void {
    registry.register(coreBlockDefinitions.map(withSharedVersoFields));
}

/* ------------------------------------------------------------------ */
/* Campos ROOT: post ≠ page (asimetría del CMS, jamás colapsarla).      */
/* ------------------------------------------------------------------ */

/** Root de POSTS: título/slug + category/allowComments/plantilla + SEO (postConfig.root.fields). */
export const rootFieldsPost: Record<string, VersoField> = {
    title: { type: "text", label: "Title" },
    slug: { type: "text", label: "Slug (Permalink)" },
    category: {
        type: "custom",
        label: "Category",
        render: ({ value, onChange }) => (
            <CategoryField value={value as string} onChange={onChange} />
        ),
    },
    allowComments: {
        type: "radio",
        label: "Allow Comments",
        options: [
            { label: "Yes", value: "open" },
            { label: "No", value: "closed" },
        ],
    },
    // Plantilla de tema por página (meta `_wjs_template`; '' = jerarquía normal).
    _wjs_template: {
        type: "custom",
        label: "Theme template",
        render: ({ value, onChange }) => (
            <TemplateField value={value as string} onChange={onChange} />
        ),
    },
    seo_title: {
        type: "text",
        label: "🔍 SEO Title (60 chars max)",
    },
    seo_description: {
        type: "textarea",
        label: "🔍 Meta Description (160 chars max)",
    },
    og_image: {
        type: "text",
        label: "🔍 Social Image URL",
    },
    noindex: {
        type: "radio",
        label: "🔍 Hide from Search Engines",
        options: [
            { label: "No (Indexable)", value: "false" },
            { label: "Yes (Hidden)", value: "true" },
        ],
    },
};

/** Root de PAGES: solo título/slug/plantilla (pageConfig.root.fields) — SIN SEO ni comentarios. */
export const rootFieldsPage: Record<string, VersoField> = {
    title: { type: "text", label: "Title" },
    slug: { type: "text", label: "Slug (Permalink)" },
    _wjs_template: {
        type: "custom",
        label: "Theme template",
        render: ({ value, onChange }) => (
            <TemplateField value={value as string} onChange={onChange} />
        ),
    },
};

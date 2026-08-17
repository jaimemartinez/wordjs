/**
 * Block catalog — the single source of truth for how blocks are PRESENTED in the editor (icon,
 * group, description). The raw block definitions live in the Puck config; this adds the cosmetic
 * metadata + grouping shared by the sidebar palette (BlockInserter) and the ⌘K command palette
 * (CommandPalette), so both stay in sync. Display labels still come from each block's own
 * `def.label` (already i18n'd); this only supplies icon/group/description and a label fallback for
 * plugin blocks that ship without one. Unknown blocks fall back to a generic icon in a "Más" group,
 * so nothing is ever hidden.
 */

/**
 * `icon` is the legacy Font Awesome class (still consumed elsewhere); `ms` is the Material Symbols
 * ligature name for the Stitch editor chrome (<MSym/>). The MS font is a NAMED-ICON SUBSET — a name
 * outside it renders as an empty box — so `ms` values MUST exist in the subset (see editor-theme.css);
 * consumers fall back to "widgets" when `ms` is missing.
 */
export type BlockMeta = { icon: string; ms?: string; group: string; desc?: string; label?: string };

export const BLOCK_META: Record<string, BlockMeta> = {
    // Layout
    Hero: { icon: "fa-mountain-sun", ms: "web", group: "Diseño", desc: "Cabecera a pantalla con imagen y botones" },
    Section: { icon: "fa-square-full", ms: "crop_16_9", group: "Diseño", desc: "Sección a todo el ancho" },
    Columns: { icon: "fa-table-columns", ms: "view_column", group: "Diseño", desc: "Columnas" },
    Grid: { icon: "fa-table-cells", ms: "grid_view", group: "Diseño", desc: "Cuadrícula responsive" },
    FlexRow: { icon: "fa-grip-lines", ms: "view_stream", group: "Diseño", desc: "Fila flexible" },
    Spacer: { icon: "fa-arrows-up-down", ms: "unfold_more", group: "Diseño", desc: "Espaciado vertical" },
    Divider: { icon: "fa-minus", ms: "horizontal_rule", group: "Diseño", desc: "Línea divisoria" },
    // `ms: "web"` (a connected network) is reused because it already ships in the Material Symbols
    // subset — an unlisted glyph name renders as an empty box (see BlockMeta note above).
    ParticleField: { icon: "fa-atom", ms: "web", group: "Diseño", desc: "Fondo animado de partículas (constelación)", label: "Campo de partículas" },
    // Content
    Heading: { icon: "fa-heading", ms: "title", group: "Contenido", desc: "Título" },
    Text: { icon: "fa-align-left", ms: "subject", group: "Contenido", desc: "Párrafo de texto enriquecido" },
    Button: { icon: "fa-hand-pointer", ms: "smart_button", group: "Contenido", desc: "Botón / llamada a la acción" },
    Card: { icon: "fa-id-card", ms: "badge", group: "Contenido", desc: "Tarjeta con imagen y texto" },
    Accordion: { icon: "fa-chevron-down", ms: "expand_more", group: "Contenido", desc: "Acordeón / FAQ" },
    Tabs: { icon: "fa-folder", ms: "web_asset", group: "Contenido", desc: "Pestañas" },
    Quote: { icon: "fa-quote-left", ms: "format_quote", group: "Contenido", desc: "Cita destacada" },
    Table: { icon: "fa-table", ms: "table_chart", group: "Contenido", desc: "Tabla de datos" },
    IconList: { icon: "fa-list-check", ms: "list_alt", group: "Contenido", desc: "Lista de ventajas con iconos" },
    HTMLEmbed: { icon: "fa-code", ms: "code", group: "Contenido", desc: "HTML personalizado (limpio)" },
    // Media
    Image: { icon: "fa-image", ms: "image", group: "Medios", desc: "Imagen" },
    VideoEmbed: { icon: "fa-video", ms: "play_circle", group: "Medios", desc: "Video incrustado" },
    AudioPlayer: { icon: "fa-music", ms: "music_note", group: "Medios", desc: "Reproductor de audio" },
    CardGallery: { icon: "fa-images", ms: "collections", group: "Medios", desc: "Galería de tarjetas", label: "Card Gallery" },
    PhotoCarousel: { icon: "fa-images", ms: "view_carousel", group: "Medios", desc: "Carrusel de fotos", label: "Photo Carousel" },
    VideoGallery: { icon: "fa-film", ms: "movie", group: "Medios", desc: "Galería de videos", label: "Video Gallery" },
    // Marketing
    PricingTable: { icon: "fa-tags", ms: "storefront", group: "Marketing", desc: "Tabla de precios" },
    Testimonial: { icon: "fa-quote-left", ms: "forum", group: "Marketing", desc: "Testimonio" },
    CTABanner: { icon: "fa-bullhorn", ms: "call_to_action", group: "Marketing", desc: "Banner de conversión" },
    Stats: { icon: "fa-chart-simple", ms: "insert_chart", group: "Marketing", desc: "Cifras destacadas" },
    SocialLinks: { icon: "fa-share-nodes", ms: "share", group: "Marketing", desc: "Iconos de redes sociales" },
    // Navegación — `ms: "menu"` ships in the Material Symbols subset (an unlisted glyph renders as an
    // empty box; see the BlockMeta note above).
    NavMenu: { icon: "fa-bars", ms: "menu", group: "Navegación", desc: "Menú del sitio vinculado (por ubicación o id)", label: "Menú de navegación" },
    // `ms` values below REUSE names already shipping in the Material Symbols subset (an unlisted glyph
    // renders as an empty box; see the BlockMeta note above): "image"/"unfold_more"/"menu" are all in use.
    SiteLogo: { icon: "fa-image", ms: "image", group: "Navegación", desc: "Logotipo o título del sitio (enlazado al inicio)", label: "Logotipo del sitio" },
    BackToTop: { icon: "fa-arrow-up", ms: "unfold_more", group: "Navegación", desc: "Botón flotante para volver arriba", label: "Volver arriba" },
    OffCanvas: { icon: "fa-bars-staggered", ms: "menu", group: "Navegación", desc: "Cajón lateral con contenido (drawer)", label: "Cajón lateral (OffCanvas)" },
    Breadcrumbs: { icon: "fa-angle-right", ms: "subject", group: "Navegación", desc: "Rastro de ancestros de la página", label: "Migas de pan" },
    LangSwitcher: { icon: "fa-language", ms: "web", group: "Navegación", desc: "Traducciones de la página (multilingüe)", label: "Selector de idioma" },
    TableOfContents: { icon: "fa-list-ol", ms: "list_alt", group: "Navegación", desc: "Índice de los títulos de la página", label: "Tabla de contenidos" },
    // Dynamic
    PostsGrid: { icon: "fa-newspaper", ms: "newspaper", group: "Dinámicos", desc: "Cuadrícula de entradas" },
    CategoryPosts: { icon: "fa-folder-tree", ms: "category", group: "Dinámicos", desc: "Entradas por categoría" },
    SearchBar: { icon: "fa-magnifying-glass", ms: "search", group: "Dinámicos", desc: "Barra de búsqueda" },
    Form: { icon: "fa-envelope-open-text", ms: "mail", group: "Marketing", desc: "Formulario con envíos guardados" },
    Symbol: { icon: "fa-clone", ms: "collections", group: "Diseño", desc: "Grupo reutilizable sincronizado: editas el símbolo y cambia en todas las páginas" },
};

export const FALLBACK_GROUP = "Más";
export const GROUP_ORDER = ["Diseño", "Contenido", "Medios", "Marketing", "Dinámicos", "Navegación", FALLBACK_GROUP];
export const GROUP_ICON: Record<string, string> = {
    "Diseño": "fa-layer-group",
    "Contenido": "fa-pen-nib",
    "Medios": "fa-photo-film",
    "Marketing": "fa-bullhorn",
    "Dinámicos": "fa-bolt",
    "Navegación": "fa-compass",
    [FALLBACK_GROUP]: "fa-puzzle-piece",
};
/** Material Symbols counterpart of GROUP_ICON (same subset constraint as BlockMeta.ms). */
export const GROUP_MS_ICON: Record<string, string> = {
    "Diseño": "space_dashboard",
    "Contenido": "edit",
    "Medios": "imagesmode",
    "Marketing": "bolt",
    "Dinámicos": "rss_feed",
    "Navegación": "menu",
    [FALLBACK_GROUP]: "widgets",
};

export type BlockItem = { name: string; label: string; icon: string; ms: string; desc?: string; group: string };

/**
 * Flatten the live Puck components into a display-ready, filtered, group-ordered list. Optional
 * `query` matches against label + type name + description (case-insensitive). Within a group, items
 * are sorted by label; groups follow GROUP_ORDER, with any unknown group appended after.
 */
export function getBlockItems(components: Record<string, any> | undefined, query = ""): BlockItem[] {
    const q = query.trim().toLowerCase();
    const items: BlockItem[] = [];
    for (const [name, def] of Object.entries(components || {})) {
        const meta = BLOCK_META[name];
        const label = (def?.label as string) || meta?.label || name;
        const icon = meta?.icon || "fa-cube";
        const ms = meta?.ms || "widgets";
        const desc = meta?.desc;
        const group = meta?.group || FALLBACK_GROUP;
        if (q && !`${label} ${name} ${desc || ""}`.toLowerCase().includes(q)) continue;
        items.push({ name, label, icon, ms, desc, group });
    }
    const groupRank = (g: string) => {
        const i = GROUP_ORDER.indexOf(g);
        return i === -1 ? GROUP_ORDER.length : i;
    };
    return items.sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.label.localeCompare(b.label));
}

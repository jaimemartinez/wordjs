/**
 * Block catalog — the single source of truth for how blocks are PRESENTED in the editor (icon,
 * group, description). The raw block definitions live in the Puck config; this adds the cosmetic
 * metadata + grouping shared by the sidebar palette (BlockInserter) and the ⌘K command palette
 * (CommandPalette), so both stay in sync. Display labels still come from each block's own
 * `def.label` (already i18n'd); this only supplies icon/group/description and a label fallback for
 * plugin blocks that ship without one. Unknown blocks fall back to a generic icon in a "Más" group,
 * so nothing is ever hidden.
 */

export type BlockMeta = { icon: string; group: string; desc?: string; label?: string };

export const BLOCK_META: Record<string, BlockMeta> = {
    // Layout
    Hero: { icon: "fa-mountain-sun", group: "Diseño", desc: "Cabecera a pantalla con imagen y botones" },
    Section: { icon: "fa-square-full", group: "Diseño", desc: "Sección a todo el ancho" },
    Columns: { icon: "fa-table-columns", group: "Diseño", desc: "Columnas" },
    Grid: { icon: "fa-table-cells", group: "Diseño", desc: "Cuadrícula responsive" },
    FlexRow: { icon: "fa-grip-lines", group: "Diseño", desc: "Fila flexible" },
    Spacer: { icon: "fa-arrows-up-down", group: "Diseño", desc: "Espaciado vertical" },
    Divider: { icon: "fa-minus", group: "Diseño", desc: "Línea divisoria" },
    // Content
    Heading: { icon: "fa-heading", group: "Contenido", desc: "Título" },
    Text: { icon: "fa-align-left", group: "Contenido", desc: "Párrafo de texto enriquecido" },
    Button: { icon: "fa-hand-pointer", group: "Contenido", desc: "Botón / llamada a la acción" },
    Card: { icon: "fa-id-card", group: "Contenido", desc: "Tarjeta con imagen y texto" },
    Accordion: { icon: "fa-chevron-down", group: "Contenido", desc: "Acordeón / FAQ" },
    Tabs: { icon: "fa-folder", group: "Contenido", desc: "Pestañas" },
    Quote: { icon: "fa-quote-left", group: "Contenido", desc: "Cita destacada" },
    Table: { icon: "fa-table", group: "Contenido", desc: "Tabla de datos" },
    IconList: { icon: "fa-list-check", group: "Contenido", desc: "Lista de ventajas con iconos" },
    HTMLEmbed: { icon: "fa-code", group: "Contenido", desc: "HTML personalizado (limpio)" },
    // Media
    Image: { icon: "fa-image", group: "Medios", desc: "Imagen" },
    VideoEmbed: { icon: "fa-video", group: "Medios", desc: "Video incrustado" },
    AudioPlayer: { icon: "fa-music", group: "Medios", desc: "Reproductor de audio" },
    CardGallery: { icon: "fa-images", group: "Medios", desc: "Galería de tarjetas", label: "Card Gallery" },
    PhotoCarousel: { icon: "fa-images", group: "Medios", desc: "Carrusel de fotos", label: "Photo Carousel" },
    VideoGallery: { icon: "fa-film", group: "Medios", desc: "Galería de videos", label: "Video Gallery" },
    // Marketing
    PricingTable: { icon: "fa-tags", group: "Marketing", desc: "Tabla de precios" },
    Testimonial: { icon: "fa-quote-left", group: "Marketing", desc: "Testimonio" },
    CTABanner: { icon: "fa-bullhorn", group: "Marketing", desc: "Banner de conversión" },
    Stats: { icon: "fa-chart-simple", group: "Marketing", desc: "Cifras destacadas" },
    SocialLinks: { icon: "fa-share-nodes", group: "Marketing", desc: "Iconos de redes sociales" },
    // Dynamic
    PostsGrid: { icon: "fa-newspaper", group: "Dinámicos", desc: "Cuadrícula de entradas" },
    CategoryPosts: { icon: "fa-folder-tree", group: "Dinámicos", desc: "Entradas por categoría" },
    SearchBar: { icon: "fa-magnifying-glass", group: "Dinámicos", desc: "Barra de búsqueda" },
};

export const FALLBACK_GROUP = "Más";
export const GROUP_ORDER = ["Diseño", "Contenido", "Medios", "Marketing", "Dinámicos", FALLBACK_GROUP];
export const GROUP_ICON: Record<string, string> = {
    "Diseño": "fa-layer-group",
    "Contenido": "fa-pen-nib",
    "Medios": "fa-photo-film",
    "Marketing": "fa-bullhorn",
    "Dinámicos": "fa-bolt",
    [FALLBACK_GROUP]: "fa-puzzle-piece",
};

export type BlockItem = { name: string; label: string; icon: string; desc?: string; group: string };

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
        const desc = meta?.desc;
        const group = meta?.group || FALLBACK_GROUP;
        if (q && !`${label} ${name} ${desc || ""}`.toLowerCase().includes(q)) continue;
        items.push({ name, label, icon, desc, group });
    }
    const groupRank = (g: string) => {
        const i = GROUP_ORDER.indexOf(g);
        return i === -1 ? GROUP_ORDER.length : i;
    };
    return items.sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.label.localeCompare(b.label));
}

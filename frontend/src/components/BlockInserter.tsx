"use client";

import React, { useMemo, useState } from "react";
import { Drawer } from "@measured/puck";
import { PATTERNS, insertPattern } from "@/lib/puckPatterns";

/**
 * BlockInserter — a searchable, categorized, icon-based block palette + a one-click Patterns library,
 * replacing Puck's bare <Puck.Components/> list. Each block is a draggable <Drawer.Item> (Puck owns
 * the drag); this supplies the look (icon + label + description), grouping, instant search, and the
 * "Plantillas" tab — the biggest discoverability win vs the old text-only drawer (and vs WordPress).
 *
 * Display labels come from each block's own config (def.label, already i18n'd); this map adds the
 * icon, the (re)grouping, an optional description, and a label override for plugin blocks that ship
 * without one. Unknown/new blocks fall back to a generic icon in a "Más" group, so nothing is hidden.
 */
type Meta = { icon: string; group: string; desc?: string; label?: string };

const BLOCK_META: Record<string, Meta> = {
    // Layout
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
    // Dynamic
    PostsGrid: { icon: "fa-newspaper", group: "Dinámicos", desc: "Cuadrícula de entradas" },
    CategoryPosts: { icon: "fa-folder-tree", group: "Dinámicos", desc: "Entradas por categoría" },
    SearchBar: { icon: "fa-magnifying-glass", group: "Dinámicos", desc: "Barra de búsqueda" },
};

const FALLBACK_GROUP = "Más";
const GROUP_ORDER = ["Diseño", "Contenido", "Medios", "Marketing", "Dinámicos", FALLBACK_GROUP];
const GROUP_ICON: Record<string, string> = {
    "Diseño": "fa-layer-group",
    "Contenido": "fa-pen-nib",
    "Medios": "fa-photo-film",
    "Marketing": "fa-bullhorn",
    "Dinámicos": "fa-bolt",
    [FALLBACK_GROUP]: "fa-puzzle-piece",
};

type Item = { name: string; label: string; icon: string; desc?: string };
type Entry =
    | { kind: "header"; group: string; icon: string; count: number }
    | { kind: "item"; item: Item };

export default function BlockInserter({ components }: { components: Record<string, any> }) {
    const [tab, setTab] = useState<"blocks" | "patterns">("blocks");
    const [query, setQuery] = useState("");

    const entries = useMemo<Entry[]>(() => {
        const q = query.trim().toLowerCase();
        const byGroup: Record<string, Item[]> = {};

        for (const [name, def] of Object.entries(components || {})) {
            const meta = BLOCK_META[name];
            const label = (def?.label as string) || meta?.label || name;
            const icon = meta?.icon || "fa-cube";
            const desc = meta?.desc;
            const group = meta?.group || FALLBACK_GROUP;
            if (q && !`${label} ${name} ${desc || ""}`.toLowerCase().includes(q)) continue;
            (byGroup[group] ||= []).push({ name, label, icon, desc });
        }

        const orderedGroups = [
            ...GROUP_ORDER.filter((g) => byGroup[g]?.length),
            ...Object.keys(byGroup).filter((g) => !GROUP_ORDER.includes(g)),
        ];

        const out: Entry[] = [];
        for (const g of orderedGroups) {
            const items = byGroup[g].sort((a, b) => a.label.localeCompare(b.label));
            out.push({ kind: "header", group: g, icon: GROUP_ICON[g] || "fa-cube", count: items.length });
            for (const item of items) out.push({ kind: "item", item });
        }
        return out;
    }, [components, query]);

    const hasResults = entries.some((e) => e.kind === "item");

    const tabBtn = (id: "blocks" | "patterns", icon: string, text: string) => (
        <button
            type="button"
            onClick={() => setTab(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition ${
                tab === id ? "bg-white shadow-sm text-editor-primary" : "text-gray-500 hover:text-gray-700"
            }`}
        >
            <i className={`fa-solid ${icon} text-[11px]`}></i> {text}
        </button>
    );

    return (
        <div className="w-[360px]">
            {/* Sticky header: tab toggle + (blocks) search */}
            <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm px-6 pt-5 pb-3 border-b border-gray-100">
                <div className="flex items-center bg-gray-100 rounded-xl p-1 mb-3">
                    {tabBtn("blocks", "fa-shapes", "Bloques")}
                    {tabBtn("patterns", "fa-table-cells-large", "Plantillas")}
                </div>

                {tab === "blocks" && (
                    <div className="relative">
                        <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none"></i>
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Buscar bloque…"
                            aria-label="Buscar bloque"
                            className="w-full pl-9 pr-8 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-editor-primary/30 focus:border-editor-primary transition"
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={() => setQuery("")}
                                title="Limpiar"
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                            >
                                <i className="fa-solid fa-xmark text-sm"></i>
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* BLOCKS tab */}
            {tab === "blocks" && (
                <div className="px-6 py-4">
                    <Drawer>
                        <div className="space-y-1">
                            {entries.map((e) =>
                                e.kind === "header" ? (
                                    <div
                                        key={`h-${e.group}`}
                                        className="flex items-center gap-2 px-1 pt-4 pb-1.5 first:pt-0"
                                    >
                                        <i className={`fa-solid ${e.icon} text-[11px] text-gray-400`}></i>
                                        <span className="text-[11px] font-bold uppercase tracking-widest text-gray-500">
                                            {e.group}
                                        </span>
                                        <span className="text-[10px] text-gray-300 ml-0.5">{e.count}</span>
                                    </div>
                                ) : (
                                    <Drawer.Item key={e.item.name} name={e.item.name} label={e.item.label}>
                                        {() => (
                                            <div className="group flex items-center gap-3 px-3 py-2.5 rounded-xl border border-gray-200 bg-white hover:border-editor-primary hover:shadow-sm hover:-translate-y-px cursor-grab active:cursor-grabbing transition-all">
                                                <span className="w-9 h-9 rounded-lg bg-gray-50 group-hover:bg-editor-primary/10 flex items-center justify-center text-gray-500 group-hover:text-editor-primary transition-colors shrink-0">
                                                    <i className={`fa-solid ${e.item.icon} text-sm`}></i>
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block text-sm font-semibold text-gray-800 truncate">
                                                        {e.item.label}
                                                    </span>
                                                    {e.item.desc && (
                                                        <span className="block text-[11px] text-gray-400 truncate">
                                                            {e.item.desc}
                                                        </span>
                                                    )}
                                                </span>
                                                <i className="fa-solid fa-grip-vertical text-gray-300 text-xs opacity-0 group-hover:opacity-100 transition-opacity"></i>
                                            </div>
                                        )}
                                    </Drawer.Item>
                                )
                            )}
                        </div>
                    </Drawer>

                    {!hasResults && (
                        <div className="text-center py-10 text-gray-400 text-sm">
                            <i className="fa-solid fa-magnifying-glass text-2xl mb-2 block opacity-40"></i>
                            Sin resultados para “{query}”.
                        </div>
                    )}
                </div>
            )}

            {/* PATTERNS tab */}
            {tab === "patterns" && (
                <div className="px-6 py-4 space-y-2">
                    {PATTERNS.map((p) => (
                        <button
                            key={p.id}
                            type="button"
                            onClick={() => insertPattern(p, components)}
                            className="w-full group flex items-center gap-3 px-3 py-3 rounded-xl border border-gray-200 bg-white hover:border-editor-primary hover:shadow-sm hover:-translate-y-px text-left transition-all"
                        >
                            <span className="w-10 h-10 rounded-lg bg-gray-50 group-hover:bg-editor-primary/10 flex items-center justify-center text-gray-500 group-hover:text-editor-primary transition-colors shrink-0">
                                <i className={`fa-solid ${p.icon}`}></i>
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-semibold text-gray-800">{p.name}</span>
                                <span className="block text-[11px] text-gray-400 truncate">{p.description}</span>
                            </span>
                            <i className="fa-solid fa-plus text-gray-300 group-hover:text-editor-primary text-xs transition-colors"></i>
                        </button>
                    ))}
                    <p className="text-[11px] text-gray-400 text-center pt-2">
                        Se añaden al final de la página. Luego puedes editarlas.
                    </p>
                </div>
            )}
        </div>
    );
}

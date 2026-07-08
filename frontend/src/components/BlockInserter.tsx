"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Drawer, Render } from "@measured/puck";
import {
    PATTERNS,
    insertPattern,
    buildPatternBlocks,
    loadUserPatterns,
    saveCurrentPageAsPattern,
    deleteUserPattern,
    insertUserPattern,
    UserPattern,
} from "@/lib/puckPatterns";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";

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

/**
 * Live miniature of a pattern: the REAL blocks rendered through Puck's <Render> at ~24% scale, so
 * what you see is exactly what lands on the canvas (theme tokens included). pointer-events-none —
 * the wrapping button owns the click.
 */
function PatternPreview({ items, components }: { items: any[]; components: Record<string, any> }) {
    const config = useMemo(
        () => ({ components, root: { render: ({ children }: any) => <div style={{ padding: 16 }}>{children}</div> } }),
        [components]
    );
    const data = useMemo(() => ({ content: items, root: {} }), [items]);
    if (!items?.length) return null;
    return (
        <div className="relative h-[110px] overflow-hidden rounded-t-xl bg-white pointer-events-none select-none">
            <div className="absolute top-0 left-0 origin-top-left" style={{ width: 1180, transform: "scale(0.236)" }}>
                <Render config={config as any} data={data as any} />
            </div>
            {/* soft fade so cropped previews don't end abruptly */}
            <div className="absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-white to-transparent" />
        </div>
    );
}

export default function BlockInserter({ components }: { components: Record<string, any> }) {
    const { language } = useI18n();
    const [tab, setTab] = useState<"blocks" | "patterns">("blocks");
    const [query, setQuery] = useState("");

    // Patterns tab state: prebuilt preview items (stable per config) + the user's saved patterns.
    const builtPatterns = useMemo(
        () => PATTERNS.map((p) => ({ pattern: p, items: buildPatternBlocks(p, components) })).filter((b) => b.items.length),
        [components]
    );
    const [userPatterns, setUserPatterns] = useState<UserPattern[]>([]);
    const [newPatternName, setNewPatternName] = useState("");
    const [patternNotice, setPatternNotice] = useState<string | null>(null);
    useEffect(() => {
        if (tab === "patterns") setUserPatterns(loadUserPatterns());
    }, [tab]);

    const handleSavePattern = () => {
        const saved = saveCurrentPageAsPattern(newPatternName);
        if (saved) {
            setUserPatterns(loadUserPatterns());
            setNewPatternName("");
            setPatternNotice(`${trStr("Guardada", language)} “${saved.name}”.`);
        } else {
            setPatternNotice(trStr("La página está vacía: añade bloques antes de guardarla como plantilla.", language));
        }
        setTimeout(() => setPatternNotice(null), 4000);
    };

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
                    {tabBtn("blocks", "fa-shapes", trStr("Bloques", language))}
                    {tabBtn("patterns", "fa-table-cells-large", trStr("Plantillas", language))}
                </div>

                {tab === "blocks" && (
                    <div className="relative">
                        <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none"></i>
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={trStr("Buscar bloque…", language)}
                            aria-label={trStr("Buscar bloque", language)}
                            className="w-full pl-9 pr-8 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-editor-primary/30 focus:border-editor-primary transition"
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={() => setQuery("")}
                                title={trStr("Limpiar", language)}
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
                                            {trStr(e.group, language)}
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
                                                            {trStr(e.item.desc, language)}
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
                            {trStr("Sin resultados para", language)} “{query}”.
                        </div>
                    )}
                </div>
            )}

            {/* PATTERNS tab */}
            {tab === "patterns" && (
                <div className="px-6 py-4 space-y-3">
                    {/* Save the current page as a reusable pattern (stored in this browser). */}
                    <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-3">
                        <div className="flex items-center gap-2 mb-2">
                            <i className="fa-solid fa-floppy-disk text-[11px] text-gray-400"></i>
                            <span className="text-[11px] font-bold uppercase tracking-widest text-gray-500">{trStr("Guardar como plantilla", language)}</span>
                        </div>
                        <div className="flex gap-1.5">
                            <input
                                value={newPatternName}
                                onChange={(e) => setNewPatternName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") handleSavePattern(); }}
                                placeholder={trStr("Nombre (ej. Landing base)", language)}
                                className="flex-1 min-w-0 px-2.5 py-2 rounded-lg bg-white border border-gray-200 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-editor-primary/30 focus:border-editor-primary"
                            />
                            <button
                                type="button"
                                onClick={handleSavePattern}
                                className="px-3 py-2 rounded-lg bg-editor-primary text-white text-xs font-bold hover:opacity-90 transition"
                            >
                                {trStr("Guardar", language)}
                            </button>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-1.5">{trStr("Captura la página actual completa para reutilizarla en otras páginas.", language)}</p>
                        {patternNotice && <p className="text-[11px] text-editor-primary font-semibold mt-1">{patternNotice}</p>}
                    </div>

                    {/* User patterns */}
                    {userPatterns.length > 0 && (
                        <>
                            <div className="flex items-center gap-2 px-1 pt-1">
                                <i className="fa-solid fa-user text-[11px] text-gray-400"></i>
                                <span className="text-[11px] font-bold uppercase tracking-widest text-gray-500">{trStr("Mis plantillas", language)}</span>
                                <span className="text-[10px] text-gray-300">{userPatterns.length}</span>
                            </div>
                            {userPatterns.map((p) => (
                                <div key={p.id} className="relative group rounded-xl border border-gray-200 bg-white overflow-hidden hover:border-editor-primary hover:shadow-sm transition-all">
                                    {/* div+role, NOT <button>: the live preview renders real blocks
                                        (Accordion/Tabs/Search) that contain their own buttons, and
                                        nested <button> is invalid HTML (hydration error). */}
                                    <div
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => insertUserPattern(p, components)}
                                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); insertUserPattern(p, components); } }}
                                        className="w-full text-left cursor-pointer"
                                        title={trStr("Insertar al final de la página", language)}
                                    >
                                        <PatternPreview items={p.items} components={components} />
                                        <span className="flex items-center gap-2 px-3 py-2.5 border-t border-gray-100">
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-sm font-semibold text-gray-800 truncate">{p.name}</span>
                                                <span className="block text-[11px] text-gray-400">{p.items.length} {trStr(p.items.length === 1 ? "bloque" : "bloques", language)}</span>
                                            </span>
                                            <i className="fa-solid fa-plus text-gray-300 group-hover:text-editor-primary text-xs transition-colors"></i>
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        title={trStr("Eliminar plantilla", language)}
                                        onClick={(e) => { e.stopPropagation(); setUserPatterns(deleteUserPattern(p.id)); }}
                                        className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-white/90 border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-200 opacity-0 group-hover:opacity-100 transition"
                                    >
                                        <i className="fa-solid fa-trash text-[11px]"></i>
                                    </button>
                                </div>
                            ))}
                        </>
                    )}

                    {/* Built-in patterns with live previews */}
                    <div className="flex items-center gap-2 px-1 pt-1">
                        <i className="fa-solid fa-table-cells-large text-[11px] text-gray-400"></i>
                        <span className="text-[11px] font-bold uppercase tracking-widest text-gray-500">{trStr("Plantillas", language)}</span>
                    </div>
                    {builtPatterns.map(({ pattern: p, items }) => (
                        // div+role, NOT <button> — see the user-patterns note (nested buttons).
                        <div
                            key={p.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => insertPattern(p, components)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); insertPattern(p, components); } }}
                            className="w-full group rounded-xl border border-gray-200 bg-white overflow-hidden hover:border-editor-primary hover:shadow-sm text-left cursor-pointer transition-all"
                            title="Insertar al final de la página"
                        >
                            <PatternPreview items={items} components={components} />
                            <span className="flex items-center gap-3 px-3 py-2.5 border-t border-gray-100">
                                <span className="w-8 h-8 rounded-lg bg-gray-50 group-hover:bg-editor-primary/10 flex items-center justify-center text-gray-500 group-hover:text-editor-primary transition-colors shrink-0">
                                    <i className={`fa-solid ${p.icon} text-sm`}></i>
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-semibold text-gray-800">{trStr(p.name, language)}</span>
                                    <span className="block text-[11px] text-gray-400 truncate">{trStr(p.description, language)}</span>
                                </span>
                                <i className="fa-solid fa-plus text-gray-300 group-hover:text-editor-primary text-xs transition-colors"></i>
                            </span>
                        </div>
                    ))}
                    <p className="text-[11px] text-gray-400 text-center pt-2">
                        {trStr("Se añaden al final de la página. Luego puedes editarlas.", language)}
                    </p>
                </div>
            )}
        </div>
    );
}

"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Drawer, Render } from "@wordjs/puck";
import {
    PATTERNS,
    insertPattern,
    buildPatternBlocks,
    loadUserPatterns,
    saveCurrentPageAsPattern,
    deleteUserPattern,
    insertUserPattern,
    regenIds,
    UserPattern,
} from "@/lib/puckPatterns";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";
import { BLOCK_META, FALLBACK_GROUP, GROUP_ORDER, GROUP_MS_ICON } from "@/lib/blockCatalog";
import MSym from "./editor/MSym";

/**
 * BlockInserter — a searchable, categorized, icon-based block palette + a one-click Patterns library,
 * replacing Puck's bare <Puck.Components/> list. Each block is a draggable <Drawer.Item> (Puck owns
 * the drag); this supplies the look (icon card + label), grouping, instant search, and the
 * "Plantillas" tab — the biggest discoverability win vs the old text-only drawer (and vs WordPress).
 *
 * Display labels come from each block's own config (def.label, already i18n'd); the shared
 * BLOCK_META (see lib/blockCatalog) adds the Material Symbols icon, the (re)grouping, an optional
 * description (shown as the card's hover tooltip — a 2-col card has no room for it), and a label
 * override for plugin blocks that ship without one. Unknown/new blocks fall back to a generic icon
 * in a "Más" group, so nothing is hidden. BLOCK_META + the group constants are shared with the
 * ⌘K command palette so both palettes present blocks identically.
 *
 * Drawer.Item renders its custom markup TWICE (an absolutely-positioned ghost copy behind the real
 * one, for the drag placeholder) — card styling must never depend on :nth-child / sibling counts.
 */
type Item = { name: string; label: string; ms: string; desc?: string };
type Group = { group: string; ms: string; items: Item[] };

/* PATTERNS still declares Font Awesome icon classes (shared with other consumers); map the known
 * ones onto Material Symbols subset names for the restyled cards. */
const PATTERN_MS_ICON: Record<string, string> = {
    "fa-mountain-sun": "web",
    "fa-heading": "title",
    "fa-list-check": "list_alt",
    "fa-grip": "grid_view",
    "fa-chart-simple": "insert_chart",
    "fa-tags": "storefront",
    "fa-quote-left": "format_quote",
    "fa-circle-question": "help",
    "fa-bullhorn": "call_to_action",
};

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
        <div className="relative h-[110px] overflow-hidden rounded-t-lg bg-white pointer-events-none select-none">
            <div className="absolute top-0 left-0 origin-top-left" style={{ width: 1180, transform: "scale(0.236)" }}>
                <Render config={config as any} data={data as any} />
            </div>
            {/* soft fade so cropped previews don't end abruptly */}
            <div className="absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-white to-transparent" />
        </div>
    );
}

export default function BlockInserter({
    components,
    view,
    onInsert,
}: {
    components: Record<string, any>;
    /** Controlled view: set by the editor's nav rail. When provided, the internal tab switcher is
     *  hidden and this view is shown; when absent, the component keeps its own tabs. */
    view?: "blocks" | "patterns";
    /** Tap-to-insert mode (mobile sheet): the panel covers the canvas there, so drag-and-drop has
     *  nowhere to land — a TAP appends the block at the end of the page and this callback fires
     *  (the editor closes the sheet). Absent on desktop, where drag stays the only insert gesture
     *  so a stray click can't add blocks. */
    onInsert?: () => void;
}) {
    const { language } = useI18n();
    const [internalTab, setInternalTab] = useState<"blocks" | "patterns">("blocks");
    const tab = view ?? internalTab;
    const [query, setQuery] = useState("");
    // Category chip filter (the design's mobile block library); "" = Todos.
    const [activeGroup, setActiveGroup] = useState("");

    const tapInsert = (name: string) => {
        const def = components[name];
        const block = regenIds({ type: name, props: { ...(def?.defaultProps || {}) } });
        (window as any).puckDispatch?.({
            type: "setData",
            data: (prev: any) => ({ ...prev, content: [...(prev.content || []), block] }),
            recordHistory: true,
        });
        onInsert?.();
    };

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

    // Every group present in the live config (query-independent) — feeds the chip row, so chips
    // don't vanish while the user types.
    const allGroups = useMemo(() => {
        const present = new Set<string>();
        for (const name of Object.keys(components || {})) {
            present.add(BLOCK_META[name]?.group || FALLBACK_GROUP);
        }
        return [
            ...GROUP_ORDER.filter((g) => present.has(g)),
            ...[...present].filter((g) => !GROUP_ORDER.includes(g)),
        ];
    }, [components]);

    const groups = useMemo<Group[]>(() => {
        const q = query.trim().toLowerCase();
        const byGroup: Record<string, Item[]> = {};

        for (const [name, def] of Object.entries(components || {})) {
            const meta = BLOCK_META[name];
            const label = (def?.label as string) || meta?.label || name;
            const ms = meta?.ms || "widgets";
            const desc = meta?.desc;
            const group = meta?.group || FALLBACK_GROUP;
            if (activeGroup && group !== activeGroup) continue;
            if (q && !`${label} ${name} ${desc || ""}`.toLowerCase().includes(q)) continue;
            (byGroup[group] ||= []).push({ name, label, ms, desc });
        }

        const orderedGroups = [
            ...GROUP_ORDER.filter((g) => byGroup[g]?.length),
            ...Object.keys(byGroup).filter((g) => !GROUP_ORDER.includes(g)),
        ];

        return orderedGroups.map((g) => ({
            group: g,
            ms: GROUP_MS_ICON[g] || "widgets",
            items: byGroup[g].sort((a, b) => a.label.localeCompare(b.label)),
        }));
    }, [components, query, activeGroup]);

    const hasResults = groups.length > 0;
    const showTabs = view === undefined;

    const tabBtn = (id: "blocks" | "patterns", ms: string, text: string) => (
        <button
            type="button"
            onClick={() => setInternalTab(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-bold transition-colors ${
                tab === id
                    ? "bg-[var(--ed-surface-container-lowest)] shadow-sm text-[var(--ed-primary)]"
                    : "text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-on-surface)]"
            }`}
        >
            <MSym name={ms} size={14} /> {text}
        </button>
    );

    return (
        <div className="w-full">
            {/* Sticky header: tab toggle (uncontrolled mode only) + (blocks) search */}
            {(showTabs || tab === "blocks") && (
                <div className="sticky top-0 z-10 bg-[var(--ed-surface-container-lowest)] px-3 pt-3 pb-2 border-b border-[var(--ed-outline-variant)]">
                    {showTabs && (
                        <div className="flex items-center bg-[var(--ed-surface-container)] rounded-lg p-0.5 mb-2">
                            {tabBtn("blocks", "add_box", trStr("Bloques", language))}
                            {tabBtn("patterns", "dashboard_customize", trStr("Plantillas", language))}
                        </div>
                    )}

                    {tab === "blocks" && (
                        <div className="relative">
                            <MSym
                                name="search"
                                size={18}
                                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ed-outline)] pointer-events-none"
                            />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={trStr("Buscar bloque…", language)}
                                aria-label={trStr("Buscar bloque", language)}
                                className="w-full pl-8 pr-8 py-2 rounded-md bg-[var(--ed-surface-container)] border border-transparent text-[13px] text-[var(--ed-on-surface)] placeholder:text-[var(--ed-outline)] focus:outline-none focus:ring-1 focus:ring-[var(--ed-primary)] focus:border-[var(--ed-primary)] transition"
                            />
                            {query && (
                                <button
                                    type="button"
                                    onClick={() => setQuery("")}
                                    title={trStr("Limpiar", language)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center text-[var(--ed-outline)] hover:text-[var(--ed-on-surface)]"
                                >
                                    <MSym name="close" size={16} />
                                </button>
                            )}
                        </div>
                    )}

                    {/* Category chips (the design's mobile block library filter) */}
                    {tab === "blocks" && allGroups.length > 1 && (
                        <div className="flex gap-1.5 mt-2 overflow-x-auto scrollbar-hide">
                            {["", ...allGroups].map((g) => {
                                const active = activeGroup === g;
                                return (
                                    <button
                                        key={g || "__all"}
                                        type="button"
                                        onClick={() => setActiveGroup(g)}
                                        className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap transition-colors ${
                                            active
                                                ? "bg-[var(--ed-primary)] text-white"
                                                : "bg-[var(--ed-surface-container)] text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-on-surface)]"
                                        }`}
                                    >
                                        {g ? trStr(g, language) : trStr("Todos", language)}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* BLOCKS view */}
            {tab === "blocks" && (
                <div className="px-3 py-3">
                    <Drawer>
                        <div className="space-y-4">
                            {groups.map((g) => (
                                <div key={g.group}>
                                    <div className="flex items-center gap-1.5 px-0.5 pb-1.5">
                                        <MSym name={g.ms} size={14} className="text-[var(--ed-outline)]" />
                                        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ed-outline)]">
                                            {trStr(g.group, language)}
                                        </span>
                                        {/* on-surface-variant, NOT outline: outline is exactly 4.50:1 on white — zero AA headroom */}
                                        <span className="text-[10px] text-[var(--ed-on-surface-variant)]">{g.items.length}</span>
                                    </div>
                                    <div className="grid grid-cols-3 md:grid-cols-2 gap-2">
                                        {g.items.map((item) => (
                                            <Drawer.Item key={item.name} name={item.name} label={item.label}>
                                                {() => (
                                                    <div
                                                        title={item.desc ? trStr(item.desc, language) : item.label}
                                                        onClick={onInsert ? () => tapInsert(item.name) : undefined}
                                                        className={`group flex flex-col items-center gap-1 p-2 rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] hover:border-[var(--ed-primary)] transition-colors ${onInsert ? "cursor-pointer active:scale-95" : "cursor-grab active:cursor-grabbing"}`}
                                                    >
                                                        <MSym
                                                            name={item.ms}
                                                            size={20}
                                                            className="text-[var(--ed-on-surface-variant)] group-hover:text-[var(--ed-primary)] transition-colors"
                                                        />
                                                        <span className="w-full text-[11px] leading-tight text-center text-[var(--ed-on-surface)] truncate">
                                                            {item.label}
                                                        </span>
                                                    </div>
                                                )}
                                            </Drawer.Item>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </Drawer>

                    {!hasResults && (
                        <div className="text-center py-10 text-[var(--ed-outline)] text-[12px]">
                            <MSym name="search" size={24} className="block mx-auto mb-2 opacity-50" />
                            {trStr("Sin resultados para", language)} “{query}”.
                        </div>
                    )}
                </div>
            )}

            {/* PATTERNS view */}
            {tab === "patterns" && (
                <div className="px-3 py-3 space-y-3">
                    {/* Save the current page as a reusable pattern (stored in this browser). */}
                    <div className="rounded-lg border border-dashed border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)] p-3">
                        <div className="flex items-center gap-1.5 mb-2">
                            <MSym name="cloud_upload" size={14} className="text-[var(--ed-outline)]" />
                            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ed-outline)]">
                                {trStr("Guardar como plantilla", language)}
                            </span>
                        </div>
                        <div className="flex gap-1.5">
                            <input
                                value={newPatternName}
                                onChange={(e) => setNewPatternName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") handleSavePattern(); }}
                                placeholder={trStr("Nombre (ej. Landing base)", language)}
                                className="flex-1 min-w-0 px-2.5 py-2 rounded-md bg-[var(--ed-surface-container-lowest)] border border-[var(--ed-outline-variant)] text-[12px] text-[var(--ed-on-surface)] placeholder:text-[var(--ed-outline)] focus:outline-none focus:ring-1 focus:ring-[var(--ed-primary)] focus:border-[var(--ed-primary)]"
                            />
                            <button
                                type="button"
                                onClick={handleSavePattern}
                                className="px-3 py-2 rounded-md bg-[var(--ed-primary)] text-white text-[11px] font-bold hover:opacity-90 transition-opacity"
                            >
                                {trStr("Guardar", language)}
                            </button>
                        </div>
                        <p className="text-[10px] text-[var(--ed-outline)] mt-1.5">
                            {trStr("Captura la página actual completa para reutilizarla en otras páginas.", language)}
                        </p>
                        {/* Always-mounted live region: a region that appears WITH its first message is
                            not announced — only text swapped into an existing one is. */}
                        <p role="status" className={`text-[11px] text-[var(--ed-primary)] font-semibold ${patternNotice ? "mt-1" : "sr-only"}`}>
                            {patternNotice}
                        </p>
                    </div>

                    {/* User patterns */}
                    {userPatterns.length > 0 && (
                        <>
                            <div className="flex items-center gap-1.5 px-0.5 pt-1">
                                <MSym name="person" size={14} className="text-[var(--ed-outline)]" />
                                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ed-outline)]">
                                    {trStr("Mis plantillas", language)}
                                </span>
                                <span className="text-[10px] text-[var(--ed-on-surface-variant)]">{userPatterns.length}</span>
                            </div>
                            {userPatterns.map((p) => (
                                <div
                                    key={p.id}
                                    className="relative group rounded-lg border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] overflow-hidden hover:border-[var(--ed-primary)] transition-colors"
                                >
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
                                        <span className="flex items-center gap-2 px-3 py-2 border-t border-[var(--ed-outline-variant)]">
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-[12px] font-semibold text-[var(--ed-on-surface)] truncate">{p.name}</span>
                                                <span className="block text-[11px] text-[var(--ed-outline)]">
                                                    {p.items.length} {trStr(p.items.length === 1 ? "bloque" : "bloques", language)}
                                                </span>
                                            </span>
                                            <MSym
                                                name="add_circle"
                                                size={16}
                                                className="text-[var(--ed-outline-variant)] group-hover:text-[var(--ed-primary)] transition-colors"
                                            />
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        title={trStr("Eliminar plantilla", language)}
                                        onClick={(e) => { e.stopPropagation(); setUserPatterns(deleteUserPattern(p.id)); }}
                                        className="absolute top-2 right-2 w-7 h-7 rounded-md bg-[var(--ed-surface-container-lowest)] border border-[var(--ed-outline-variant)] flex items-center justify-center text-[var(--ed-outline)] hover:text-[var(--ed-error)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 transition"
                                    >
                                        <MSym name="delete" size={14} />
                                    </button>
                                </div>
                            ))}
                        </>
                    )}

                    {/* Built-in patterns with live previews */}
                    <div className="flex items-center gap-1.5 px-0.5 pt-1">
                        <MSym name="dashboard_customize" size={14} className="text-[var(--ed-outline)]" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ed-outline)]">
                            {trStr("Plantillas", language)}
                        </span>
                    </div>
                    {builtPatterns.map(({ pattern: p, items }) => (
                        // div+role, NOT <button> — see the user-patterns note (nested buttons).
                        <div
                            key={p.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => insertPattern(p, components)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); insertPattern(p, components); } }}
                            className="w-full group rounded-lg border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] overflow-hidden hover:border-[var(--ed-primary)] text-left cursor-pointer transition-colors"
                            title={trStr("Insertar al final de la página", language)}
                        >
                            <PatternPreview items={items} components={components} />
                            <span className="flex items-center gap-2.5 px-3 py-2 border-t border-[var(--ed-outline-variant)]">
                                <span className="w-8 h-8 rounded-md bg-[var(--ed-surface-container)] group-hover:bg-[var(--ed-primary-fixed)] flex items-center justify-center text-[var(--ed-on-surface-variant)] group-hover:text-[var(--ed-primary)] transition-colors shrink-0">
                                    <MSym name={PATTERN_MS_ICON[p.icon] || "dashboard_customize"} size={18} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[12px] font-semibold text-[var(--ed-on-surface)]">{trStr(p.name, language)}</span>
                                    <span className="block text-[11px] text-[var(--ed-outline)] truncate">{trStr(p.description, language)}</span>
                                </span>
                                <MSym
                                    name="add_circle"
                                    size={16}
                                    className="text-[var(--ed-outline-variant)] group-hover:text-[var(--ed-primary)] transition-colors"
                                />
                            </span>
                        </div>
                    ))}
                    <p className="text-[11px] text-[var(--ed-outline)] text-center pt-2">
                        {trStr("Se añaden al final de la página. Luego puedes editarlas.", language)}
                    </p>
                </div>
            )}
        </div>
    );
}

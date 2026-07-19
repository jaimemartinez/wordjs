"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGetPuck } from "@wordjs/puck";
import { getBlockItems, GROUP_ICON, type BlockItem } from "@/lib/blockCatalog";
import { insertBlock } from "@/lib/puckPatterns";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";

/**
 * CommandPalette — a ⌘K / Ctrl+K "insert block" launcher (Notion / Gutenberg style). It rides Puck's
 * PUBLIC API, not the fork: getBlockItems() flattens the live config, and insertBlock() dispatches
 * into Puck's store via window.puckDispatch (after the current selection, else appended). Rendered
 * through a portal to <body> so it stays viewport-fixed and on top regardless of the editor's
 * transformed canvas ancestors — while React context (the Puck store via useGetPuck, i18n) still
 * flows through the portal because portals preserve the React tree.
 *
 * Keyboard: ↑/↓ move (headers are skipped — the list is flat), ↵ inserts, Esc/backdrop-click close.
 * Opening/closing is driven by the parent (EditorHotkeys catches ⌘K, cross-frame, and toggles it).
 */
export default function CommandPalette({
    open,
    onClose,
    components,
}: {
    open: boolean;
    onClose: () => void;
    components: Record<string, any>;
}) {
    const { language } = useI18n();
    const getPuck = useGetPuck();
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const items = useMemo(() => getBlockItems(components, query), [components, query]);

    // Reset + focus each time it opens.
    useEffect(() => {
        if (!open) return;
        setQuery("");
        setActive(0);
        const t = setTimeout(() => inputRef.current?.focus(), 20);
        return () => clearTimeout(t);
    }, [open]);

    // Keep the active index in range as the filtered list shrinks.
    useEffect(() => {
        setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
    }, [items.length]);

    // Scroll the active row into view on keyboard navigation.
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }, [active]);

    if (!open || typeof document === "undefined") return null;

    const insertAt = (item: BlockItem) => {
        const sel = (getPuck().appState.ui.itemSelector as { index: number; zone?: string } | null) ?? null;
        insertBlock(item.name, components, sel);
        onClose();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
        else if (e.key === "Enter") { e.preventDefault(); if (items[active]) insertAt(items[active]); }
        else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };

    let lastGroup: string | null = null;

    return createPortal(
        <div
            className="fixed inset-0 z-[9999] flex items-start justify-center pt-[14vh] px-4 bg-gray-900/40 backdrop-blur-sm"
            onMouseDown={onClose}
        >
            <div
                className="w-[600px] max-w-full bg-white rounded-2xl shadow-2xl ring-1 ring-black/5 overflow-hidden flex flex-col max-h-[70vh]"
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={onKeyDown}
                role="dialog"
                aria-modal="true"
            >
                {/* Search */}
                <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
                    <i className="fa-solid fa-magnifying-glass text-gray-400"></i>
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                        placeholder={trStr("Buscar un bloque para insertar…", language)}
                        aria-label={trStr("Buscar un bloque para insertar", language)}
                        className="flex-1 bg-transparent text-[15px] text-gray-800 placeholder-gray-400 focus:outline-none"
                    />
                    <kbd className="hidden sm:inline text-[10px] font-bold text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">ESC</kbd>
                </div>

                {/* Results */}
                <div ref={listRef} className="overflow-y-auto custom-scrollbar py-2">
                    {items.length === 0 ? (
                        <div className="text-center py-12 text-gray-400 text-sm">
                            <i className="fa-solid fa-magnifying-glass text-2xl mb-2 block opacity-40"></i>
                            {trStr("Sin resultados para", language)} “{query}”.
                        </div>
                    ) : (
                        items.map((item, i) => {
                            const header = item.group !== lastGroup ? item.group : null;
                            lastGroup = item.group;
                            const isActive = i === active;
                            return (
                                <React.Fragment key={item.name}>
                                    {header && (
                                        <div className="flex items-center gap-2 px-5 pt-3 pb-1">
                                            <i className={`fa-solid ${GROUP_ICON[header] || "fa-cube"} text-[10px] text-gray-400`}></i>
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                                                {trStr(header, language)}
                                            </span>
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        data-idx={i}
                                        onMouseEnter={() => setActive(i)}
                                        onClick={() => insertAt(item)}
                                        className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors ${
                                            isActive ? "bg-editor-primary/10" : "hover:bg-gray-50"
                                        }`}
                                    >
                                        <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                                            isActive ? "bg-editor-primary/15 text-editor-primary" : "bg-gray-50 text-gray-500"
                                        }`}>
                                            <i className={`fa-solid ${item.icon} text-sm`}></i>
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm font-semibold text-gray-800 truncate">{item.label}</span>
                                            {item.desc && (
                                                <span className="block text-[11px] text-gray-400 truncate">{trStr(item.desc, language)}</span>
                                            )}
                                        </span>
                                        {isActive && (
                                            <span className="hidden sm:flex items-center gap-1.5 text-[11px] font-bold text-editor-primary shrink-0">
                                                <span className="text-sm leading-none">↵</span> {trStr("Insertar", language)}
                                            </span>
                                        )}
                                    </button>
                                </React.Fragment>
                            );
                        })
                    )}
                </div>

                {/* Footer hints */}
                <div className="flex items-center justify-between px-5 py-2.5 border-t border-gray-100 bg-gray-50/50 text-[11px] text-gray-400 select-none">
                    <span className="flex items-center gap-3">
                        <span><span className="font-bold">↑↓</span> {trStr("navegar", language)}</span>
                        <span><span className="font-bold">↵</span> {trStr("insertar", language)}</span>
                        <span><span className="font-bold">esc</span> {trStr("cerrar", language)}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                        <i className="fa-solid fa-bolt text-editor-primary/60"></i>
                        {items.length} {trStr("bloques", language)}
                    </span>
                </div>
            </div>
        </div>,
        document.body
    );
}

"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGetPuck } from "@wordjs/puck";
import { getBlockItems, BLOCK_META, type BlockItem } from "@/lib/blockCatalog";
import { insertBlock } from "@/lib/puckPatterns";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";
import MSym from "./editor/MSym";

/**
 * CommandPalette — a ⌘K / Ctrl+K launcher (Notion / Gutenberg style): editor ACTIONS first (save,
 * preview, export/import, block operations — supplied by the editor via the `actions` prop), then
 * every insertable block. It rides Puck's PUBLIC API, not the fork: getBlockItems() flattens the
 * live config, and insertBlock() dispatches into Puck's store via window.puckDispatch (after the
 * current selection, else appended). Rendered through a portal to <body> so it stays viewport-fixed
 * and on top regardless of the editor's transformed canvas ancestors — while React context (the
 * Puck store via useGetPuck, i18n) still flows through the portal because portals preserve the
 * React tree.
 *
 * Keyboard: ↑/↓ move (headers are skipped — the list is flat), ↵ runs/inserts, Tab is trapped
 * inside the dialog, Esc/backdrop-click close (focus returns to where it was).
 *
 * Styling follows the Stitch editor spec (--ed-* tokens). Icons are Material Symbols via <MSym>: the
 * font is a SUBSET, so a block's `ms` meta must name a bundled glyph — anything missing falls back
 * to "widgets" (the meta field is read defensively: it lands in blockCatalog.ts separately).
 */
export type PaletteAction = {
    id: string;
    ms: string;
    label: string;
    hint?: string;
    run: () => void;
};

// Real app version (root package.json), inlined at build time by next.config.ts. ASSET_VERSION is a
// cache-busting stamp, NOT the release number — showing it here printed a version that never shipped.
const APP_VERSION = process.env.NEXT_PUBLIC_WORDJS_VERSION;

export default function CommandPalette({
    open,
    onClose,
    components,
    actions = [],
}: {
    open: boolean;
    onClose: () => void;
    components: Record<string, any>;
    actions?: PaletteAction[];
}) {
    const { language } = useI18n();
    const getPuck = useGetPuck();
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    const items = useMemo(() => getBlockItems(components, query), [components, query]);
    // Actions filter on the same query; with an empty query they all show (they lead the list, like
    // the design's "ACCIONES SUGERIDAS").
    const matchedActions = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions;
    }, [actions, query]);
    const total = matchedActions.length + items.length;

    // Reset + focus each time it opens; restore focus where it was on close.
    useEffect(() => {
        if (!open) return;
        const prev = document.activeElement as HTMLElement | null;
        setQuery("");
        setActive(0);
        const t = setTimeout(() => inputRef.current?.focus(), 20);
        return () => {
            clearTimeout(t);
            prev?.focus?.();
        };
    }, [open]);

    // Keep the active index in range as the filtered list shrinks.
    useEffect(() => {
        setActive((a) => Math.min(a, Math.max(0, total - 1)));
    }, [total]);

    // Scroll the active row into view on keyboard navigation.
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }, [active]);

    if (!open || typeof document === "undefined") return null;

    const runRow = (idx: number) => {
        if (idx < matchedActions.length) {
            const a = matchedActions[idx];
            onClose();
            a.run();
            return;
        }
        const item = items[idx - matchedActions.length];
        if (!item) return;
        const sel = (getPuck().appState.ui.itemSelector as { index: number; zone?: string } | null) ?? null;
        insertBlock(item.name, components, sel);
        onClose();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, total - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
        else if (e.key === "Enter") { e.preventDefault(); runRow(active); }
        else if (e.key === "Escape") { e.preventDefault(); onClose(); }
        else if (e.key === "Tab") {
            // Focus trap: the dialog is the whole world while open.
            const focusables = dialogRef.current?.querySelectorAll<HTMLElement>("input, button");
            if (!focusables?.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    };

    // JetBrains Mono for kbd/shortcut chrome — matches the rest of the editor's mono chrome.
    const mono = { fontFamily: "var(--puck-font-family-monospaced)" };

    let lastGroup: string | null = null;

    const row = (
        idx: number,
        ms: string,
        label: string,
        trailing: string | undefined,
        onRun: () => void,
    ) => {
        const isActive = idx === active;
        return (
            <button
                key={`row-${idx}`}
                type="button"
                data-idx={idx}
                onMouseEnter={() => setActive(idx)}
                onClick={onRun}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                    isActive ? "bg-[var(--ed-surface-container)]" : ""
                }`}
            >
                <MSym name={ms} size={20} className={isActive ? "text-[var(--ed-primary)]" : "text-[var(--ed-on-surface-variant)]"} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ed-on-surface)]">{label}</span>
                {isActive && trailing && (
                    <span className="hidden sm:inline shrink-0 text-[10px] text-[var(--ed-outline)]" style={mono}>
                        {trailing}
                    </span>
                )}
            </button>
        );
    };

    return createPortal(
        <div
            className="puck-editor-ui fixed inset-0 z-[9999] flex items-start justify-center pt-[14vh] px-4 bg-[rgba(27,27,34,0.4)] backdrop-blur-sm"
            onMouseDown={onClose}
        >
            <div
                ref={dialogRef}
                className="w-full max-w-xl bg-white rounded-xl shadow-2xl border border-[var(--ed-outline-variant)] overflow-hidden flex flex-col max-h-[70vh]"
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={onKeyDown}
                role="dialog"
                aria-modal="true"
            >
                {/* Search */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--ed-outline-variant)]">
                    <MSym name="search" size={18} className="text-[var(--ed-primary)]" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                        placeholder={trStr("Buscar un bloque para insertar…", language)}
                        aria-label={trStr("Buscar un bloque para insertar", language)}
                        className="flex-1 bg-transparent text-[14px] text-[var(--ed-on-surface)] placeholder:text-[var(--ed-outline)] focus:outline-none"
                    />
                    <kbd
                        className="hidden sm:inline px-1.5 py-0.5 rounded border border-[var(--ed-outline-variant)] text-[10px] text-[var(--ed-outline)]"
                        style={mono}
                    >
                        ESC
                    </kbd>
                </div>

                {/* Results */}
                <div ref={listRef} className="overflow-y-auto custom-scrollbar p-2 max-h-[400px]">
                    {total === 0 ? (
                        <div className="text-center py-12 text-[13px] text-[var(--ed-on-surface-variant)]">
                            <MSym name="search" size={32} className="mx-auto mb-2 opacity-40 text-[var(--ed-outline)]" />
                            <p>{trStr("Sin resultados para", language)} “{query}”.</p>
                        </div>
                    ) : (
                        <>
                            {matchedActions.length > 0 && (
                                <div className="px-3 py-2 text-[10px] font-semibold text-[var(--ed-outline)] uppercase tracking-widest">
                                    {trStr("Acciones", language)}
                                </div>
                            )}
                            {matchedActions.map((a, i) => row(i, a.ms, a.label, a.hint, () => runRow(i)))}
                            {items.map((item, i) => {
                                const idx = matchedActions.length + i;
                                const header = item.group !== lastGroup ? item.group : null;
                                lastGroup = item.group;
                                // `ms` is read loosely — falls back to a subset glyph.
                                const msName = ((BLOCK_META[item.name] as any)?.ms as string) || "widgets";
                                return (
                                    <React.Fragment key={item.name}>
                                        {header && (
                                            <div className="px-3 py-2 text-[10px] font-semibold text-[var(--ed-outline)] uppercase tracking-widest">
                                                {trStr(header, language)}
                                            </div>
                                        )}
                                        {row(idx, msName, item.label, `↵ ${trStr("Insertar", language)}`, () => runRow(idx))}
                                    </React.Fragment>
                                );
                            })}
                        </>
                    )}
                </div>

                {/* Footer hints */}
                <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)] text-[10px] text-[var(--ed-on-surface-variant)] select-none">
                    <span>{trStr("Usa ↑↓ para navegar · ↵ para insertar", language)}</span>
                    <span>{APP_VERSION ? `WordJS v${APP_VERSION}` : "WordJS"}</span>
                </div>
            </div>
        </div>,
        document.body
    );
}

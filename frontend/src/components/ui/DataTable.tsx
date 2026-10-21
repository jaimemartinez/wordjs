"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { RowActionsMenu } from "./RowActionsMenu";

/**
 * DataTable — the one responsive table every core admin list renders through.
 *
 * It is a single semantic `<table>` at every width, and it fits the room it is GIVEN, not the window: the
 * same screen can be 1280px wide with a 320px sidebar, a two-column layout or a dialog. It measures its own
 * container and steps down — full table → table without its low-priority columns (`showFrom`) → cards —
 * as soon as the current step would overflow, and back up when the room it needed is there again, so it
 * never scrolls sideways. Below `stackBelow` (a phone, or a tablet for wide tables) it is cards outright.
 * In a card the primary column is the title, every other column a labelled line, and the row's actions a
 * row of labelled 44px buttons. Display changes on table elements make browsers drop their
 * implicit table semantics, so every element carries its ARIA role explicitly and the header row stays in
 * the accessibility tree (visually hidden) — a screen reader still announces "Email, column 2" in the card.
 *
 * The step is `data-dt` on the wrapper ("table" | "compact" | "cards"); the card layout is plain
 * Tailwind under `in-data-[dt=cards]:`. Less frequent row actions can wait in a "More actions"
 * menu (`menu: true`), so a narrow table keeps one or two buttons per row. Nothing scrolls the page
 * sideways; as a last resort the table scrolls inside its own box.
 *
 * Row actions are never hover-only on a touch screen: they are always visible where the device cannot hover
 * and whenever the row holds focus, and fade in on hover only where a pointer can hover.
 */

export type DataTableBreakpoint = "md" | "lg";

export interface DataTableColumn<T> {
    key: string;
    /** Column header. */
    header: React.ReactNode;
    /** Text for the card's line label when `header` is not a plain string (or should read differently). */
    label?: string;
    cell: (row: T) => React.ReactNode;
    /** The row's title: rendered first and unlabelled in the card. One per table. */
    primary?: boolean;
    /** Low priority: the first column(s) to leave the TABLE when it runs out of room (the card always
     *  shows it). The value is kept for compatibility; any value marks the column as low priority. */
    showFrom?: "lg" | "xl";
    /** Leave this column out of the card (e.g. an avatar the primary cell already shows). */
    hideWhenStacked?: boolean;
    align?: "left" | "right" | "center";
    /** Extra classes for the cell / header (widths, nowrap...). */
    className?: string;
    headerClassName?: string;
}

export type DataTableActionTone = "neutral" | "primary" | "success" | "warning" | "danger";

export interface DataTableAction {
    key: string;
    label: string;
    icon: string;
    onClick?: () => void;
    href?: string;
    /** Open `href` in a new tab (a plain anchor, not a client-side Link). */
    external?: boolean;
    tone?: DataTableActionTone;
    disabled?: boolean;
    /** In table mode, list this action in the row's "More actions" menu instead of as a button. The card
     *  always shows every action as a labelled button. */
    menu?: boolean;
}

export interface DataTableSelection<K extends React.Key> {
    selected: Set<K>;
    onToggle: (key: K) => void;
    onToggleAll: () => void;
    /** Accessible name of the "select all" checkbox. */
    allLabel: string;
}

export interface DataTableProps<T, K extends React.Key = React.Key> {
    rows: T[];
    rowKey: (row: T) => K;
    columns: DataTableColumn<T>[];
    /** The table's accessible name (rendered as a visually hidden caption). */
    caption: string;
    actions?: (row: T) => DataTableAction[];
    /** Header of the actions column ("Actions"). */
    actionsLabel?: string;
    /** Name of the "More actions" menu button. */
    moreActionsLabel?: string;
    /** Names a row for the per-row checkbox and the actions group ("Select «Hello»"). */
    rowLabel?: (row: T) => string;
    /** Template for the row checkbox's name; `{title}` is replaced by rowLabel(row). */
    selectRowLabel?: string;
    selection?: DataTableSelection<K>;
    /** Rows become cards below this breakpoint. `lg` suits tables with many columns. */
    stackBelow?: DataTableBreakpoint;
    rowClassName?: (row: T) => string;
    /** A full-width row rendered under a row (an inline editor); null for none. */
    expandedRow?: (row: T) => React.ReactNode | null;
    density?: "comfortable" | "compact";
    /** Extra attributes for each row (data-* hooks used by tests and plugins). */
    rowProps?: (row: T) => React.HTMLAttributes<HTMLTableRowElement> & Record<`data-${string}`, string>;
    className?: string;
}

// The card layout, applied when the wrapper says `data-dt="cards"`. Literal strings: Tailwind only generates
// the classes it can read in the source.
const S = {
    table: "in-data-[dt=cards]:block",
    thead: "in-data-[dt=cards]:sr-only",
    tbody: "in-data-[dt=cards]:grid in-data-[dt=cards]:gap-3 in-data-[dt=cards]:p-3 in-data-[dt=cards]:divide-y-0 in-data-[dt=cards]:@2xl:grid-cols-2",
    tr: "in-data-[dt=cards]:flex in-data-[dt=cards]:flex-wrap in-data-[dt=cards]:items-start in-data-[dt=cards]:content-start in-data-[dt=cards]:rounded-2xl in-data-[dt=cards]:border in-data-[dt=cards]:border-gray-100 in-data-[dt=cards]:p-4 in-data-[dt=cards]:shadow-sm",
    td: "in-data-[dt=cards]:flex in-data-[dt=cards]:basis-full in-data-[dt=cards]:items-start in-data-[dt=cards]:justify-between in-data-[dt=cards]:gap-4 in-data-[dt=cards]:px-0 in-data-[dt=cards]:py-1.5 in-data-[dt=cards]:text-right",
    label: "hidden in-data-[dt=cards]:inline",
    primary: "in-data-[dt=cards]:order-first in-data-[dt=cards]:block in-data-[dt=cards]:min-w-0 in-data-[dt=cards]:px-0 in-data-[dt=cards]:pt-0 in-data-[dt=cards]:pb-2 in-data-[dt=cards]:text-left",
    // Beside the checkbox the title takes the rest of the line; alone, the whole line.
    primaryWithSelect: "in-data-[dt=cards]:flex-1 in-data-[dt=cards]:basis-0",
    primaryAlone: "in-data-[dt=cards]:basis-full",
    select: "in-data-[dt=cards]:order-first in-data-[dt=cards]:w-11 in-data-[dt=cards]:shrink-0 in-data-[dt=cards]:p-0 in-data-[dt=cards]:-ml-2",
    actions: "in-data-[dt=cards]:basis-full in-data-[dt=cards]:px-0 in-data-[dt=cards]:pt-3 in-data-[dt=cards]:pb-0 in-data-[dt=cards]:mt-auto in-data-[dt=cards]:border-t in-data-[dt=cards]:border-gray-100",
    actionsInner: "in-data-[dt=cards]:justify-start in-data-[dt=cards]:flex-wrap",
    actionText: "sr-only in-data-[dt=cards]:not-sr-only",
    actionButton: "in-data-[dt=cards]:w-auto in-data-[dt=cards]:px-4 in-data-[dt=cards]:flex-1 whitespace-nowrap",
    // A `menu` action is a button in the card and an entry of «More actions» in the table.
    inMenu: "hidden in-data-[dt=cards]:inline-flex",
    menuButton: "in-data-[dt=cards]:hidden",
    hiddenStacked: "in-data-[dt=cards]:hidden",
    expandedCell: "in-data-[dt=cards]:block in-data-[dt=cards]:border-0 in-data-[dt=cards]:p-0",
    // Card actions always show; table actions fade in on hover only where a pointer can hover.
    hoverGate: "opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 in-data-[dt=cards]:!opacity-100",
    // A low-priority column leaves the table first («compact»), and is back as a line in the card.
    lowPriority: "in-data-[dt=compact]:hidden",
} as const;

export type DtMode = "table" | "compact" | "cards";

/**
 * One step of the fit: in table/compact mode `natural` is the table's measured width in that mode (it is
 * remembered in `need`); overflowing steps down; otherwise it steps up only to a mode whose measured
 * need fits the room. Pure, so the rule is testable without a DOM.
 */
export function nextFitMode(m: DtMode, room: number, natural: number | null, need: Partial<Record<DtMode, number>>, hasLowPriority: boolean): DtMode {
    if (m !== "cards" && natural !== null) {
        need[m] = natural;
        if (natural > room + 1) return m === "table" && hasLowPriority ? "compact" : "cards";
    }
    const up: DtMode | null = m === "cards" ? (hasLowPriority ? "compact" : "table") : m === "compact" ? "table" : null;
    if (up && need[up] !== undefined && room >= (need[up] as number)) return up;
    return m;
}

/** Below this viewport width the table is cards outright (a phone; a tablet for wide tables). */
const FORCE_QUERY: Record<DataTableBreakpoint, string> = { md: "(max-width: 767.98px)", lg: "(max-width: 1023.98px)" };
function useForcedCards(bp: DataTableBreakpoint): boolean {
    const query = FORCE_QUERY[bp];
    const subscribe = useCallback((cb: () => void) => {
        const mq = window.matchMedia(query);
        mq.addEventListener("change", cb);
        return () => mq.removeEventListener("change", cb);
    }, [query]);
    return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The step that fits: measures the table's natural width against its container in the current step,
 * steps down when it overflows, and steps back up only when the container has the width the upper step
 * was MEASURED to need (never on a guess, so it cannot oscillate). Content changes re-measure from the
 * top, before paint.
 */
function useFitMode(wrapRef: React.RefObject<HTMLDivElement | null>, forced: boolean, hasLowPriority: boolean, contentKey: unknown): DtMode {
    const [mode, setMode] = useState<DtMode>("table");
    const need = useRef<Partial<Record<DtMode, number>>>({});
    const measure = useCallback(() => {
        const wrap = wrapRef.current;
        const table = wrap?.querySelector("table");
        if (!wrap || !table) return;
        if (forced) { setMode("cards"); return; }
        const room = wrap.clientWidth;
        setMode((m) => nextFitMode(m, room, m === "cards" ? null : table.scrollWidth, need.current, hasLowPriority));
    }, [wrapRef, forced, hasLowPriority]);
    // New content: forget what the old content needed and measure again from the full table.
    useIsoLayoutEffect(() => {
        need.current = {};
        setMode(forced ? "cards" : "table");
    }, [contentKey, forced, hasLowPriority]);
    // Each step re-measures before paint (a step down is never seen overflowing).
    useIsoLayoutEffect(() => { measure(); }, [mode, measure, contentKey]);
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => measure());
        ro.observe(wrap);
        return () => ro.disconnect();
    }, [wrapRef, measure]);
    return mode;
}

const TONE: Record<DataTableActionTone, string> = {
    neutral: "hover:bg-gray-700 hover:text-white focus-visible:bg-gray-700 focus-visible:text-white",
    primary: "hover:bg-blue-600 hover:text-white focus-visible:bg-blue-600 focus-visible:text-white",
    success: "hover:bg-emerald-600 hover:text-white focus-visible:bg-emerald-600 focus-visible:text-white",
    warning: "hover:bg-amber-500 hover:text-white focus-visible:bg-amber-500 focus-visible:text-white",
    danger: "text-red-500 hover:bg-red-600 hover:text-white focus-visible:bg-red-600 focus-visible:text-white",
};

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

/** One row action: an icon button in the table, an icon + text button in the card (44px either way). */
export function RowActionButton({ action, className = "" }: { action: DataTableAction; stackBelow?: DataTableBreakpoint; className?: string }) {
    const s = S;
    const cls = `${className} h-11 min-w-11 w-11 shrink-0 inline-flex items-center justify-center gap-2 rounded-xl bg-gray-50 text-gray-500 text-xs font-bold transition-all shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 disabled:pointer-events-none ${s.actionButton} ${TONE[action.tone ?? "neutral"]}`;
    const content = (
        <>
            <i className={`fa-solid ${action.icon} text-xs`} aria-hidden="true"></i>
            <span className={s.actionText}>{action.label}</span>
        </>
    );
    if (action.href && !action.disabled) {
        return action.external
            ? <a href={action.href} target="_blank" rel="noopener noreferrer" className={cls} title={action.label}>{content}</a>
            : <Link href={action.href} className={cls} title={action.label}>{content}</Link>;
    }
    return (
        <button type="button" onClick={action.onClick} disabled={action.disabled} className={cls} title={action.label}>
            {content}
        </button>
    );
}

export function DataTable<T, K extends React.Key = React.Key>({
    rows,
    rowKey,
    columns,
    caption,
    actions,
    actionsLabel = "Actions",
    moreActionsLabel = "More actions",
    rowLabel,
    selectRowLabel = "Select {title}",
    selection,
    stackBelow = "md",
    rowClassName,
    expandedRow,
    density = "comfortable",
    rowProps,
    className = "",
}: DataTableProps<T, K>) {
    const s = S;
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const forced = useForcedCards(stackBelow);
    const hasLowPriority = columns.some((c) => c.showFrom);
    // Re-measure when the rows or columns change — by identity of their keys, not of the array (a caller may
    // pass a fresh array on every render).
    const contentKey = rows.map((r) => String(rowKey(r))).join("|") + "#" + columns.map((c) => c.key).join(",");
    const mode = useFitMode(wrapRef, forced, hasLowPriority, contentKey);
    const pad = density === "compact" ? "px-4 py-3" : "px-4 xl:px-6 py-5";
    const headPad = density === "compact" ? "px-4 py-3" : "px-4 xl:px-6 py-4";
    const allSelected = !!selection && rows.length > 0 && rows.every((r) => selection.selected.has(rowKey(r)));
    const someSelected = !!selection && !allSelected && rows.some((r) => selection.selected.has(rowKey(r)));
    const labelOf = (c: DataTableColumn<T>) => c.label ?? (typeof c.header === "string" ? c.header : c.key);
    const showFromCls = (c: DataTableColumn<T>) => (c.showFrom ? s.lowPriority : "");

    return (
        <div ref={wrapRef} data-dt={mode} className={`@container overflow-x-auto ${className}`} data-wjs-data-table="">
            <table role="table" className={`w-full text-left ${s.table}`}>
                <caption className="sr-only">{caption}</caption>
                <thead role="rowgroup" className={s.thead}>
                    <tr role="row" className="border-b border-gray-100 bg-gray-50/40">
                        {selection && (
                            <th role="columnheader" scope="col" className={`w-12 pl-4 pr-0 ${headPad.split(" ")[1]}`}>
                                <label className="inline-flex h-11 w-11 shrink-0 items-center justify-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={allSelected}
                                        ref={(el) => { if (el) el.indeterminate = someSelected; }}
                                        onChange={selection.onToggleAll}
                                        aria-label={selection.allLabel}
                                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
                                    />
                                </label>
                            </th>
                        )}
                        {columns.map((c) => (
                            <th
                                key={c.key}
                                role="columnheader"
                                scope="col"
                                // The primary column (the row's name) takes the free width: in an auto-layout table it
                                // got the same share as the hover-only actions, and a page title was clamped to
                                // "Welcome …" next to half a table of empty space.
                                className={`${headPad} text-[11px] font-black text-gray-500 uppercase tracking-widest whitespace-nowrap ${c.primary ? "w-full" : ""} ${ALIGN[c.align ?? "left"]} ${showFromCls(c)} ${c.headerClassName ?? ""}`}
                            >
                                {c.header}
                            </th>
                        ))}
                        {actions && (
                            <th role="columnheader" scope="col" className={`${headPad} text-right text-[11px] font-black text-gray-500 uppercase tracking-widest`}>
                                {actionsLabel}
                            </th>
                        )}
                    </tr>
                </thead>
                <tbody role="rowgroup" className={`divide-y divide-gray-50 ${s.tbody}`}>
                    {rows.map((row) => {
                        const key = rowKey(row);
                        const name = rowLabel ? rowLabel(row) : String(key);
                        const isSelected = !!selection?.selected.has(key);
                        const rowActions = actions ? actions(row) : [];
                        const expanded = expandedRow ? expandedRow(row) : null;
                        return (
                            <React.Fragment key={key}>
                            <tr
                                role="row"
                                {...(rowProps ? rowProps(row) : {})}
                                className={`group transition-colors ${isSelected ? "bg-blue-50/50" : "hover:bg-blue-50/20"} ${s.tr} ${rowClassName ? rowClassName(row) : ""}`}
                            >
                                {selection && (
                                    <td role="cell" className={`w-12 pl-4 pr-0 align-middle ${s.select}`}>
                                        <label className="inline-flex h-11 w-11 shrink-0 items-center justify-center cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={isSelected}
                                                onChange={() => selection.onToggle(key)}
                                                aria-label={selectRowLabel.replace("{title}", name)}
                                                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
                                            />
                                        </label>
                                    </td>
                                )}
                                {columns.map((c) => (
                                    <td
                                        key={c.key}
                                        role="cell"
                                        className={`${pad} align-middle ${ALIGN[c.align ?? "left"]} ${c.primary ? `${s.primary} ${selection ? s.primaryWithSelect : s.primaryAlone}` : s.td} ${c.hideWhenStacked ? s.hiddenStacked : ""} ${showFromCls(c)} ${c.className ?? ""}`}
                                    >
                                        {!c.primary && (
                                            <span aria-hidden="true" className={`shrink-0 pt-0.5 text-left text-[11px] font-black uppercase tracking-widest text-gray-400 ${s.label}`}>
                                                {labelOf(c)}
                                            </span>
                                        )}
                                        <div className="min-w-0 break-words">{c.cell(row)}</div>
                                    </td>
                                ))}
                                {actions && (
                                    <td role="cell" className={`${pad} text-right align-middle ${s.actions}`}>
                                        <div
                                            role="group"
                                            aria-label={`${actionsLabel}: ${name}`}
                                            className={`flex items-center justify-end gap-2 ${s.hoverGate} transition-opacity duration-200 ${s.actionsInner}`}
                                        >
                                            {rowActions.map((a) => <RowActionButton key={a.key} action={a} className={a.menu ? s.inMenu : ""} />)}
                                            {rowActions.some((a) => a.menu) && (
                                                <span className={s.menuButton}>
                                                    <RowActionsMenu
                                                        actions={rowActions.filter((a) => a.menu)}
                                                        label={`${moreActionsLabel}: ${name}`}
                                                        buttonClassName="h-11 w-11 inline-flex items-center justify-center rounded-xl bg-gray-50 text-gray-500 shadow-sm hover:bg-gray-700 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-blue-400 aria-expanded:bg-gray-700 aria-expanded:text-white"
                                                    />
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                )}
                            </tr>
                            {expanded && (
                                <tr role="row" className={'bg-gray-50/60 ' + s.tr}>
                                    <td role="cell" colSpan={columns.length + (selection ? 1 : 0) + (actions ? 1 : 0)} className={'w-full px-4 sm:px-8 py-6 border-t border-gray-100 ' + s.expandedCell}>
                                        {expanded}
                                    </td>
                                </tr>
                            )}
                            </React.Fragment>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

export default DataTable;

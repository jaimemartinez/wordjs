"use client";

import React from "react";
import Link from "next/link";
import { RowActionsMenu } from "./RowActionsMenu";

/**
 * DataTable — the one responsive table every core admin list renders through.
 *
 * It is a single semantic `<table>` at every width. Below its `stackBelow` breakpoint each row turns into a
 * card: the primary column becomes the card's title, every other column a labelled line, and the row's
 * actions a row of labelled 44px buttons. Display changes on table elements make browsers drop their
 * implicit table semantics, so every element carries its ARIA role explicitly and the header row stays in
 * the accessibility tree (visually hidden) — a screen reader still announces "Email, column 2" in the card.
 *
 * In table mode a column can wait for room (`showFrom`): it is left out until the viewport reaches that
 * width, and is back as a labelled line in the card. Less frequent row actions can wait in a "More actions"
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
    /** Table mode only shows this column from this width up (the card always shows it). */
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

// Literal class sets per breakpoint (Tailwind only generates classes it can read in the source).
const STACK = {
    md: {
        table: "max-md:block",
        thead: "max-md:sr-only",
        tbody: "max-md:block max-md:space-y-3 max-md:p-3",
        tr: "max-md:flex max-md:flex-wrap max-md:items-start max-md:rounded-2xl max-md:border max-md:border-gray-100 max-md:p-4 max-md:shadow-sm",
        td: "max-md:flex max-md:basis-full max-md:items-start max-md:justify-between max-md:gap-4 max-md:px-0 max-md:py-1.5 max-md:text-right",
        label: "md:hidden",
        primary: "max-md:order-first max-md:block max-md:min-w-0 max-md:px-0 max-md:pt-0 max-md:pb-2 max-md:text-left",
        // Beside the checkbox the title takes the rest of the line; alone, the whole line.
        primaryWithSelect: "max-md:flex-1 max-md:basis-0",
        primaryAlone: "max-md:basis-full",
        select: "max-md:order-first max-md:w-11 max-md:shrink-0 max-md:p-0 max-md:-ml-2",
        actions: "max-md:basis-full max-md:px-0 max-md:pt-3 max-md:pb-0 max-md:mt-2 max-md:border-t max-md:border-gray-100",
        actionsInner: "max-md:justify-start max-md:flex-wrap",
        actionText: "md:sr-only",
        actionButton: "max-md:w-auto max-md:px-4 max-md:flex-1 whitespace-nowrap",
        inMenu: "md:hidden",
        menuButton: "max-md:hidden",
        hiddenStacked: "max-md:hidden",
        expandedCell: "max-md:block max-md:border-0 max-md:p-0",
        // Card actions always show; table actions fade in on hover only where a pointer can hover.
        hoverGate: "opacity-100 md:[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        showFrom: { lg: "md:max-lg:hidden", xl: "md:max-xl:hidden" },
    },
    lg: {
        table: "max-lg:block",
        thead: "max-lg:sr-only",
        tbody: "max-lg:grid max-lg:gap-3 max-lg:p-3 md:max-lg:grid-cols-2",
        tr: "max-lg:flex max-lg:flex-wrap max-lg:items-start max-lg:content-start max-lg:rounded-2xl max-lg:border max-lg:border-gray-100 max-lg:p-4 max-lg:shadow-sm",
        td: "max-lg:flex max-lg:basis-full max-lg:items-start max-lg:justify-between max-lg:gap-4 max-lg:px-0 max-lg:py-1.5 max-lg:text-right",
        label: "lg:hidden",
        primary: "max-lg:order-first max-lg:block max-lg:min-w-0 max-lg:px-0 max-lg:pt-0 max-lg:pb-2 max-lg:text-left",
        primaryWithSelect: "max-lg:flex-1 max-lg:basis-0",
        primaryAlone: "max-lg:basis-full",
        select: "max-lg:order-first max-lg:w-11 max-lg:shrink-0 max-lg:p-0 max-lg:-ml-2",
        actions: "max-lg:basis-full max-lg:px-0 max-lg:pt-3 max-lg:pb-0 max-lg:mt-auto max-lg:border-t max-lg:border-gray-100",
        actionsInner: "max-lg:justify-start max-lg:flex-wrap",
        actionText: "lg:sr-only",
        actionButton: "max-lg:w-auto max-lg:px-4 max-lg:flex-1 whitespace-nowrap",
        inMenu: "lg:hidden",
        menuButton: "max-lg:hidden",
        hiddenStacked: "max-lg:hidden",
        expandedCell: "max-lg:block max-lg:border-0 max-lg:p-0",
        hoverGate: "opacity-100 lg:[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        showFrom: { lg: "", xl: "lg:max-xl:hidden" },
    },
} as const;

const TONE: Record<DataTableActionTone, string> = {
    neutral: "hover:bg-gray-700 hover:text-white focus-visible:bg-gray-700 focus-visible:text-white",
    primary: "hover:bg-blue-600 hover:text-white focus-visible:bg-blue-600 focus-visible:text-white",
    success: "hover:bg-emerald-600 hover:text-white focus-visible:bg-emerald-600 focus-visible:text-white",
    warning: "hover:bg-amber-500 hover:text-white focus-visible:bg-amber-500 focus-visible:text-white",
    danger: "text-red-500 hover:bg-red-600 hover:text-white focus-visible:bg-red-600 focus-visible:text-white",
};

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

/** One row action: an icon button in the table, an icon + text button in the card (44px either way). */
export function RowActionButton({ action, stackBelow = "md", className = "" }: { action: DataTableAction; stackBelow?: DataTableBreakpoint; className?: string }) {
    const s = STACK[stackBelow];
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
    const s = STACK[stackBelow];
    const pad = density === "compact" ? "px-4 py-3" : "px-4 xl:px-6 py-5";
    const headPad = density === "compact" ? "px-4 py-3" : "px-4 xl:px-6 py-4";
    const allSelected = !!selection && rows.length > 0 && rows.every((r) => selection.selected.has(rowKey(r)));
    const someSelected = !!selection && !allSelected && rows.some((r) => selection.selected.has(rowKey(r)));
    const labelOf = (c: DataTableColumn<T>) => c.label ?? (typeof c.header === "string" ? c.header : c.key);
    const showFromCls = (c: DataTableColumn<T>) => (c.showFrom ? s.showFrom[c.showFrom] : "");

    return (
        <div className={`overflow-x-auto ${className}`} data-wjs-data-table="">
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
                                className={`${headPad} text-[11px] font-black text-gray-500 uppercase tracking-widest whitespace-nowrap ${ALIGN[c.align ?? "left"]} ${showFromCls(c)} ${c.headerClassName ?? ""}`}
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
                                            {rowActions.map((a) => <RowActionButton key={a.key} action={a} stackBelow={stackBelow} className={a.menu ? s.inMenu : ""} />)}
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

"use client";

import React from "react";
import { useI18n } from "@/contexts/I18nContext";

interface PaginationProps {
    page: number;
    /** Known page count. Leave it out for a list that only knows whether a next page exists (`hasNext`). */
    totalPages?: number;
    hasNext?: boolean;
    /** Replaces the "page X of Y" text (e.g. a "21–40 of 312" range). */
    label?: string;
    onChange: (page: number) => void;
    className?: string;
}

/**
 * Pagination — previous / "page X of Y" / next under a list. 44px targets; on a phone the buttons keep only
 * their arrows (the label stays their accessible name) so the bar never wraps or scrolls.
 */
export function Pagination({ page, totalPages, hasNext, label, onChange, className = "" }: PaginationProps) {
    const { t } = useI18n();
    const canNext = totalPages !== undefined ? page < totalPages : !!hasNext;
    // A single page needs no pager, unless it carries a range label worth reading.
    if (page <= 1 && !canNext && label === undefined) return null;
    const btn = "inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 sm:px-4 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 disabled:pointer-events-none transition-all outline-none focus-visible:ring-2 focus-visible:ring-blue-400";
    return (
        <nav aria-label={t("table.pagination")} className={`flex items-center justify-between gap-3 px-4 sm:px-8 py-4 border-t border-gray-100/50 bg-gray-50/30 ${className}`}>
            <button type="button" onClick={() => onChange(Math.max(1, page - 1))} disabled={page <= 1} className={btn} aria-label={t("table.previous")}>
                <i className="fa-solid fa-chevron-left" aria-hidden="true"></i>
                <span className="hidden sm:inline">{t("table.previous")}</span>
            </button>
            <span className="text-[11px] font-black text-gray-500 uppercase tracking-widest text-center" aria-live="polite">
                {label ?? (totalPages !== undefined
                    ? t("table.pageOf").replace("{page}", String(page)).replace("{total}", String(totalPages))
                    : t("table.page").replace("{page}", String(page)))}
            </span>
            <button type="button" onClick={() => onChange(page + 1)} disabled={!canNext} className={btn} aria-label={t("table.next")}>
                <span className="hidden sm:inline">{t("table.next")}</span>
                <i className="fa-solid fa-chevron-right" aria-hidden="true"></i>
            </button>
        </nav>
    );
}

export default Pagination;

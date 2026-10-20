// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * Small shared pieces of the inscription tables and «Pagos de cuotas» (2.18.0):
 *
 * - `Pager`: below 768 px «‹ Anterior | 2 / 9 | Siguiente ›» with 44 px buttons and «21–40 de 183» under it;
 *   from 768 px «Mostrando 21–40 de 183» and a numbered window `‹ 1 … 4 5 6 … 20 ›`. Hidden when every row
 *   fits on one page. A polite live region announces «Página 2 de 9». The switch is PAGER_CSS (unlayered).
 * - `MoreButton`: the row's «⋮», 44×44, labelled with the person's name, `aria-haspopup="dialog"`.
 * - `InfoRow`: one label / value pair of a details list (`<dt>` / `<dd>`), the value never truncated.
 * - `SoftWrap`: a value that may wrap at an e-mail's or address's natural points (lib/roster.ts softBreaks).
 */
import React from "react";
import { pageCount, pageWindow, rangeOf } from "../lib/paging";
import { softBreaks } from "../lib/roster";
import { useTx } from "./MealScanner";

export const PAGER_CSS = `
[data-cm-pager-desk] { display: none; }
@media (min-width: 768px) {
  [data-cm-pager-phone] { display: none; }
  [data-cm-pager-desk] { display: flex; }
}
[data-cm-pager] button { min-height: 44px; min-width: 44px; }
`;

export function Pager({ page, size, total, onPage, label }: { page: number; size: number; total: number; onPage: (p: number) => void; label?: string }) {
    const tx = useTx();
    const count = pageCount(total, size);
    if (total <= size) return null;
    const r = rangeOf(page, size, total);
    const go = (p: number) => onPage(Math.min(Math.max(1, p), count));
    const base = 'inline-flex items-center justify-center gap-2 px-4 rounded-xl border-2 text-xs font-black uppercase tracking-widest disabled:opacity-40';
    const btn = `${base} border-gray-100 bg-white text-gray-700 hover:border-blue-400 hover:text-blue-700`;
    const current = `${base} border-blue-600 bg-blue-600 text-white`;
    const rangeText = tx('pager.range', '{from}–{to} de {total}', { from: r.from, to: r.to, total: r.total });
    return (
        <nav data-cm-pager="" aria-label={label || tx('pager.label', 'Paginación')} className="pt-3">
            <style>{PAGER_CSS}</style>
            <span className="sr-only" aria-live="polite">{tx('pager.live', 'Página {page} de {count}', { page, count })}</span>
            <div data-cm-pager-phone="">
                <div className="flex items-center justify-between gap-2">
                    <button type="button" className={btn} onClick={() => go(page - 1)} disabled={page <= 1} data-pager-prev="">
                        <i className="fa-solid fa-chevron-left" aria-hidden="true"></i>{tx('pager.prev', 'Anterior')}
                    </button>
                    <span className="text-sm font-black text-gray-700 tabular-nums" aria-current="page">{page} / {count}</span>
                    <button type="button" className={btn} onClick={() => go(page + 1)} disabled={page >= count} data-pager-next="">
                        {tx('pager.next', 'Siguiente')}<i className="fa-solid fa-chevron-right" aria-hidden="true"></i>
                    </button>
                </div>
                <p className="text-center text-[11px] font-bold text-gray-500 mt-1">{rangeText}</p>
            </div>
            <div data-cm-pager-desk="" className="items-center justify-between gap-3 flex-wrap">
                <span className="text-xs font-bold text-gray-500">{tx('pager.showing', 'Mostrando {range}', { range: rangeText })}</span>
                <div className="flex items-center gap-1">
                    <button type="button" className={btn} onClick={() => go(page - 1)} disabled={page <= 1} aria-label={tx('pager.prev', 'Anterior')}>
                        <i className="fa-solid fa-chevron-left" aria-hidden="true"></i>
                    </button>
                    {pageWindow(page, count).map((p, i) => p === '…'
                        ? <span key={`gap-${i}`} className="px-2 text-gray-400 font-black" aria-hidden="true">…</span>
                        : <button key={p} type="button" onClick={() => go(p)} aria-current={p === page ? 'page' : undefined}
                            className={p === page ? current : btn}>{p}</button>)}
                    <button type="button" className={btn} onClick={() => go(page + 1)} disabled={page >= count} aria-label={tx('pager.next', 'Siguiente')}>
                        <i className="fa-solid fa-chevron-right" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
        </nav>
    );
}

/** The «⋮» of a row: opens the person sheet. `id` ends up in data-cm-more so the focus can come back to it. */
export function MoreButton({ id, name, expanded, onClick, className = '' }: { id: number | string; name: string; expanded?: boolean; onClick: () => void; className?: string }) {
    const tx = useTx();
    return (
        <button type="button" onClick={onClick} data-cm-more={String(id)}
            aria-label={tx('roster.more', 'Más información de {name}', { name })} aria-haspopup="dialog" aria-expanded={expanded ? 'true' : 'false'}
            className={`shrink-0 inline-flex items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 ${className}`}>
            <i className="fa-solid fa-ellipsis-vertical text-base" aria-hidden="true"></i>
        </button>
    );
}

/** `text` with a <wbr> wherever softBreaks allows a break (an e-mail wraps at «@» and «.», never mid-word). */
export function SoftWrap({ text }: { text: unknown }) {
    const parts = softBreaks(text);
    return <>{parts.map((p, i) => <React.Fragment key={i}>{i > 0 ? <wbr /> : null}{p}</React.Fragment>)}</>;
}

/**
 * One label / value of a details list: `<div><dt/><dd/></div>`, a direct child of its `<dl>` (a list item may be
 * a div that holds a dt and a dd — never a div inside a div). `className` goes on that div (`sm:col-span-2` for a
 * wide value): wrapping it in another div broke the list, and a screen reader no longer paired the term with its
 * value (2.18.0 review PUX-11).
 */
export function InfoRow({ label, children, className = '' }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
    return (
        <div className={`min-w-0 ${className}`.trim()}>
            <dt className="text-[10px] font-black uppercase tracking-widest text-gray-500">{label}</dt>
            <dd className="text-sm text-gray-900 font-medium break-words">{children}</dd>
        </div>
    );
}

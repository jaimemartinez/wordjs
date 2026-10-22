// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * One location card of «Inscripciones» (2.18.0; owner decisions D2–D6, D8, D9):
 *
 * - a sticky header (you always know which location you are in) with collapse, the name and its counters
 *   (participants · paid · por validar · cancelled);
 * - below 768 px a compact LIST: each row one full-width button (opens the person sheet) with the name
 *   (struck through + «Cancelada» when cancelled), the payment pill · $paid / $due · the room, the chips that
 *   apply («⏱ $X por validar», «↩ devuelto») and a visible ⋮ — no horizontal scroll, nothing hover-only;
 * - from 768 px a TABLE with fixed columns: Participante (opens the sheet) · up to 3 chosen form fields ·
 *   Código (opens the barcode, inscriptions:view) · Pago (the pill opens the sheet at «Pago») · Alojamiento ·
 *   ⋮. Edit / room / delete live in the sheet (D6). Its column headers stay in view under the card's sticky
 *   header (ROSTER_CSS, the header's measured height);
 * - its own pager (20 per page by default, D2).
 * Both layouts are in the DOM (bounded by the page size) and ROSTER_CSS shows one — never `md:` classes. The
 * card is a size container: the table shows only when its columns fit the CARD, and each chosen form column
 * only while it fits at its minimum (lib/roster.ts ROSTER_COLUMNS_REM / rosterTableCss) — Participante never
 * shrinks below 12rem, so a name never breaks mid-word. A chosen column that does not fit folds under the
 * name («Iglesia: Betel»); values and the room wrap — nothing is cut behind a hover-only title.
 *
 * Screen readers: a phone row's name is the person AND their state («Ana Pérez: Abono, $200,00 de $250,00,
 * Sin habitación, $50,00 por validar»), never just «Ver ficha de Ana Pérez»; the desktop Pago pill says its
 * state too («Abono: pagos de Ana Pérez»).
 */
import React, { useEffect, useRef, useState } from "react";
import { pageSlice } from "../lib/paging";
import { personBalance } from "../lib/feePayments";
import { fieldDisplayValue, rawFieldValue, rosterColWidth } from "../lib/roster";
import { Pager, MoreButton, SoftWrap } from "./RosterBits";
import { BalanceChips, PayPill, money } from "./FeeBits";
import { useTx } from "./MealScanner";
import { needsLodging } from "../lib/lodgingView";

// «Requiere hospedaje: No» (2.31.0) is no «Sin habitación»: nobody is looking for a bed for them.
const noRoomText = (tx, p) => (needsLodging(p) ? tx('roster.room.none', 'Sin habitación') : tx('roster.room.not.needed', 'No requiere hospedaje'));
const roomText = (tx, p) => (p.room_id ? tx('roster.room.short', 'Hab {room}{hotel}', { room: p.room_number || '—', hotel: p.hotel_name ? ` · ${p.hotel_name}` : '' }) : noRoomText(tx, p));
const PILL_TEXT = { paid: ['fees.pill.paid', 'Pagado'], partial: ['fees.pill.partial', 'Abono'], unpaid: ['fees.pill.unpaid', 'Sin pagar'] };
const pillText = (tx, state) => { const k = PILL_TEXT[state] || PILL_TEXT.unpaid; return tx(k[0], k[1]); };

/**
 * What a screen reader says for a person's row: their name and everything the row shows — «Tomás Acosta:
 * Sin pagar, $0,00 de $250,00, Sin habitación, $50,00 por validar» (or «…: Cancelada, Sin habitación»).
 */
export function rosterRowLabel(tx, name: string, p: any): string {
    const b = personBalance(p);
    const parts = p.status === 'cancelled'
        ? [tx('roster.cancelled', 'Cancelada')]
        : [pillText(tx, b.state), tx('fees.person.paid.of', '{paid} de {due}', { paid: money(b.validated), due: money(b.due) })];
    parts.push(roomText(tx, p));
    if (p.status !== 'cancelled' && b.pending > 0) parts.push(tx('fees.chip.pending', '{amount} por validar', { amount: money(b.pending) }));
    if (p.status !== 'cancelled' && b.returned > 0) parts.push(tx('fees.chip.returned', '{amount} devuelto', { amount: money(b.returned) }));
    return `${name}: ${parts.join(', ')}`;
}

/** The height of the card's sticky header, for the column headers that stick right under it. */
function useHeadHeight() {
    const ref = useRef<HTMLDivElement | null>(null);
    const [h, setH] = useState<number | null>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof el.getBoundingClientRect !== 'function') return undefined;
        const measure = () => { const v = Math.round(el.getBoundingClientRect().height); if (v > 0) setH(v); };
        measure();
        let ro: any = null;
        try { ro = new ResizeObserver(measure); ro.observe(el); } catch { /* old browser: the CSS fallback */ }
        return () => { if (ro) ro.disconnect(); };
    }, []);
    return [ref, h] as const;
}

export function RosterGroup({ group, page, size, onPage, collapsed, onToggle, columns, nameOf, canSeeCodes, onOpen, onBarcode, openId, cardRef }: any) {
    const tx = useTx();
    const rows = pageSlice(group.rows, page, size);
    const c = group.counts;
    const headId = `cm-roster-group-${group.key}`;
    const [measureRef, headH] = useHeadHeight();
    return (
        <section ref={cardRef} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-100/30" data-cm-roster-card="" data-codes={canSeeCodes ? '1' : '0'} data-fcols={columns.length} data-roster-group={group.key} aria-labelledby={headId}
            style={headH ? ({ '--cm-roster-head-h': `${headH}px` } as any) : undefined}>
            <div ref={measureRef} className="bg-white border-b border-gray-100 px-4 sm:px-6 py-4 flex items-center gap-3 rounded-t-3xl" data-cm-roster-head="">
                <button type="button" onClick={onToggle} aria-expanded={collapsed ? 'false' : 'true'} aria-controls={`${headId}-body`}
                    aria-label={collapsed ? tx('roster.expand', 'Mostrar {name}', { name: group.name }) : tx('roster.collapse', 'Ocultar {name}', { name: group.name })}
                    className="w-11 h-11 shrink-0 rounded-xl bg-gray-50 hover:bg-blue-50 text-gray-500 hover:text-blue-700 flex items-center justify-center">
                    <i className={`fa-solid fa-chevron-${collapsed ? 'down' : 'up'} text-xs`} aria-hidden="true"></i>
                </button>
                <div className="min-w-0 flex-1">
                    <h3 id={headId} className="text-lg sm:text-xl font-black text-gray-900 italic tracking-tighter break-words">{group.name}</h3>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] font-black uppercase tracking-widest text-gray-500" data-group-counts="">
                        <span>{c.total === 1 ? tx('roster.count.one', '{n} participante', { n: c.total }) : tx('roster.count', '{n} participantes', { n: c.total })}</span>
                        <span className="text-emerald-700">{c.paid === 1 ? tx('roster.count.paid.one', '{n} pagado', { n: 1 }) : tx('roster.count.paid', '{n} pagados', { n: c.paid })}</span>
                        {c.pending > 0 && <span className="text-amber-800"><i className="fa-solid fa-clock mr-1" aria-hidden="true"></i>{tx('roster.count.pending', '{n} por validar', { n: c.pending })}</span>}
                        {c.cancelled > 0 && <span className="text-gray-600">{c.cancelled === 1 ? tx('roster.count.cancelled.one', '1 cancelada') : tx('roster.count.cancelled', '{n} canceladas', { n: c.cancelled })}</span>}
                    </p>
                </div>
            </div>
            {!collapsed && (
                <div id={`${headId}-body`} className="px-2 sm:px-4 pb-4">
                    {/* Phone: compact rows */}
                    <ul data-cm-roster-list="" className="divide-y divide-gray-100">
                        {rows.map((p) => {
                            const b = personBalance(p);
                            const name = nameOf(p);
                            const cancelled = p.status === 'cancelled';
                            return (
                                <li key={p.id}>
                                    <button type="button" onClick={() => onOpen(p)} data-cm-roster-row={p.id} aria-haspopup="dialog"
                                        aria-label={rosterRowLabel(tx, name, p)}
                                        className="w-full text-left px-2 py-3 flex items-center gap-3 hover:bg-blue-50/40 rounded-xl">
                                        <span className="min-w-0 flex-1 space-y-1">
                                            <span className="flex flex-wrap items-center gap-2">
                                                <span className={`text-sm font-black text-gray-900 break-words ${cancelled ? 'line-through decoration-2 text-gray-500' : ''}`}>{name}</span>
                                                {cancelled && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-[9px] font-black uppercase tracking-widest">{tx('roster.cancelled', 'Cancelada')}</span>}
                                            </span>
                                            {/* Wraps between its parts, never cut: on a 390 px phone the room used to end as «Sin h…». */}
                                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 text-[11px] font-bold text-gray-600" data-row-facts="">
                                                {!cancelled && <PayPill state={b.state} />}
                                                {!cancelled && <span className="whitespace-nowrap tabular-nums">{money(b.validated)} / {money(b.due)}</span>}
                                                <span className="min-w-0 break-words" data-row-room="">{roomText(tx, p)}</span>
                                            </span>
                                            {(b.pending > 0 || b.returned > 0) && <BalanceChips balance={{ ...b, credit: 0, cancelled: false }} />}
                                        </span>
                                        <span className="shrink-0 w-11 h-11 flex items-center justify-center text-gray-500" aria-hidden="true" data-cm-more-glyph="">
                                            <i className="fa-solid fa-ellipsis-vertical"></i>
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    {/* Desktop: a slim table */}
                    <div data-cm-roster-table="">
                        {/* The header cells set the columns (fixed layout); the form columns share the rest and
                            hide one by one when the card is too narrow for them (data-cm-fcol, ROSTER_CSS). */}
                        <table className="text-sm text-left border-collapse">
                            <thead>
                                <tr className="bg-gray-50/60">
                                    <th scope="col" style={{ width: rosterColWidth('name') }} className="px-4 py-3 text-[10px] font-black text-gray-500 uppercase tracking-widest truncate">{tx('participant.singular', 'Participante')}</th>
                                    {columns.map((f, i) => <th key={f.name} scope="col" data-cm-fcol={i + 1} className="px-3 py-3 text-[10px] font-black text-gray-500 uppercase tracking-widest break-words">{f.label || f.name}</th>)}
                                    {canSeeCodes && <th scope="col" style={{ width: rosterColWidth('code') }} className="px-3 py-3 text-[10px] font-black text-gray-500 uppercase tracking-widest truncate">{tx('reg.code', 'Código')}</th>}
                                    <th scope="col" style={{ width: rosterColWidth('pay') }} className="px-3 py-3 text-[10px] font-black text-gray-500 uppercase tracking-widest truncate">{tx('payment', 'Pago')}</th>
                                    <th scope="col" style={{ width: rosterColWidth('lodging') }} data-cm-col="lodging" className="px-3 py-3 text-[10px] font-black text-gray-500 uppercase tracking-widest truncate">{tx('lodging', 'Alojamiento')}</th>
                                    <th scope="col" style={{ width: rosterColWidth('more') }} className="px-1.5 py-3"><span className="sr-only">{tx('actions', 'Acciones')}</span></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {rows.map((p) => {
                                    const b = personBalance(p);
                                    const name = nameOf(p);
                                    const cancelled = p.status === 'cancelled';
                                    return (
                                        <tr key={p.id} className="hover:bg-blue-50/30" data-roster-tr={p.id}>
                                            <td className="px-4 py-2.5">
                                                <button type="button" onClick={() => onOpen(p)} className="text-left min-h-[44px] w-full">
                                                    <span className={`block font-black text-gray-900 break-words ${cancelled ? 'line-through decoration-2 text-gray-500' : ''}`}>{name}</span>
                                                    {cancelled && <span className="inline-block mt-0.5 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-[9px] font-black uppercase tracking-widest">{tx('roster.cancelled', 'Cancelada')}</span>}
                                                </button>
                                                {/* A chosen column the card has no room for: its value here (ROSTER_CSS shows it then). */}
                                                {columns.map((f, i) => {
                                                    const v = fieldDisplayValue(rawFieldValue(p, f.name), f.type);
                                                    return v ? <span key={f.name} data-cm-ffold={i + 1} className="mt-0.5 text-[11px] font-medium text-gray-600 break-words"><span className="font-black text-gray-500">{f.label || f.name}:</span> <SoftWrap text={v} /></span> : null;
                                                })}
                                            </td>
                                            {columns.map((f, i) => {
                                                const v = fieldDisplayValue(rawFieldValue(p, f.name), f.type);
                                                return <td key={f.name} data-cm-fcol={i + 1} className="px-3 py-2.5 text-xs font-medium text-gray-700 break-words">{v ? <SoftWrap text={v} /> : <span className="text-gray-400">—</span>}</td>;
                                            })}
                                            {canSeeCodes && (
                                                <td className="px-3 py-2.5">
                                                    {p.reg_code ? (
                                                        <button type="button" onClick={() => onBarcode(p)} title={tx('reg.code.title', 'Código de inscripción')}
                                                            className="inline-flex items-center gap-1.5 min-h-[44px] px-2.5 rounded-xl bg-gray-50 hover:bg-blue-600 hover:text-white text-gray-700 border border-gray-100">
                                                            <i className="fa-solid fa-qrcode text-xs" aria-hidden="true"></i>
                                                            <span className="font-mono text-[11px] font-black tracking-wider">{p.reg_code}</span>
                                                        </button>
                                                    ) : <span className="text-gray-400 text-xs">—</span>}
                                                </td>
                                            )}
                                            <td className="px-3 py-2.5">
                                                {cancelled ? <span className="text-xs font-bold text-gray-500">—</span> : (
                                                    <div className="space-y-1">
                                                        <PayPill state={b.state} onClick={() => onOpen(p, { pay: true })} label={tx('roster.pay.open.state', '{state}: pagos de {name}', { state: pillText(tx, b.state), name })} />
                                                        <div className="text-[11px] font-bold text-gray-600 tabular-nums">{money(b.validated)} / {money(b.due)}</div>
                                                        {(b.pending > 0 || b.returned > 0) && <BalanceChips wrap balance={{ ...b, credit: 0, cancelled: false }} />}
                                                    </div>
                                                )}
                                            </td>
                                            {/* Wraps, never «Hab 101 · Hotel …» behind a hover title (the column widens when the card has room). */}
                                            <td className="px-3 py-2.5 text-xs font-bold text-gray-700 break-words" data-cell="lodging">
                                                {p.room_id ? roomText(tx, p) : <span className={needsLodging(p) ? 'text-amber-800' : 'text-gray-600'}>{noRoomText(tx, p)}</span>}
                                            </td>
                                            <td className="px-1.5 py-2.5 text-right">
                                                <MoreButton id={p.id} name={name} expanded={openId === p.id} onClick={() => onOpen(p)} />
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <Pager page={page} size={size} total={group.rows.length} onPage={onPage} label={tx('roster.pager', 'Páginas de {name}', { name: group.name })} />
                </div>
            )}
        </section>
    );
}

export default RosterGroup;

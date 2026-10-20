// @ts-nocheck
"use client";

/**
 * «Últimas entregas» (2.17.0) — the delivery history beside «Entrega»'s scan input: WHAT was delivered, to
 * whom. The site owner, testing on an iPhone: «en la parte de alimentación en últimas entregas no muestra qué
 * se le entregó» — each row named the person, the location, the method and who recorded it, never the meal.
 *
 * The card's header names the service; every row shows
 *   - the person's name (the row's heading; it wraps, it is never cut),
 *   - the meal — «Desayuno · Vie 11/12» (« — label» after the meal), from the `service` the server answered
 *     with the rows (GET /meals/services/:id/deliveries),
 *   - how it was recorded as a chip («Escaneo», «Manual», «Sin derecho (autorizado)» in amber), then the
 *     time, the location and who recorded it,
 *   - «Deshacer»: a 44 px target, confirmed inline (a dialog would take the focus from a USB scanner's
 *     input) with a question that names the meal and the person. The question opens under the row's
 *     undo; on an iPhone SE (375×667) its buttons landed at the bottom edge — it now scrolls itself into
 *     view, its buttons included (smooth unless reduced motion, the focus untouched).
 * 2.17.0 live round at 320×460: the question's nearest edge came into view and the top of its row — the person's
 * name — stayed above the band, sliced by the edge under the admin header. Now the WHOLE ROW comes into view
 * (revealAsk with the row as the card: the visible band, the row's scroll-margins), its question's buttons share
 * one row («Cancelar» had dropped to a row of its own, 52 px), and while the row with the whole question would
 * still be taller than the band the question is the short one, «¿Deshacer la entrega de Almuerzo?»
 * (undoAskStepDown; the row right above names the person and the meal, the whole question stays the dialog's
 * accessible name). Only a row taller than the screen on its own shows the question, or its buttons, first.
 * Nothing is truncated: on a 320 px phone every line wraps. The buttons never take the focus from the scan
 * input (the scanner's Enter would press them).
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { MEAL_ICON, mealLine, mealName, methodLabel, useTx } from "./MealScanner";
import { stampTime } from "../lib/meals";
import { REVEAL_MARGIN_PX, revealAsk, undoAskStepDown } from "../lib/mealConfirm";

/** The method chip: neutral for a scan, blue for a person picked by name, amber for an authorised override. */
export const METHOD_CHIP: Record<string, string> = {
    scan: 'bg-gray-100 text-gray-700 border-gray-200',
    manual: 'bg-blue-50 text-blue-800 border-blue-200',
    override: 'bg-amber-50 text-amber-900 border-amber-300',
};
/** A 44 × 44 px target (Apple HIG / WCAG 2.5.5) for the row's undo. */
export const UNDO_TARGET = 'w-11 h-11';
/**
 * The question's «Deshacer» / «Cancelar»: one row under the question, as wide as each other, 44 px targets whose
 * labels wrap rather than push the other one out (at 320 px, with 16 px paddings and their natural widths, they
 * took a row each). Structure inline: a plugin installed from the marketplace cannot count on its new Tailwind
 * classes in the site's stylesheet.
 */
export const UNDO_ASK_BUTTON = 'rounded-xl font-black text-[11px] uppercase tracking-widest';
export const UNDO_ASK_BUTTON_STYLE: React.CSSProperties = { flex: '1 1 0%', minWidth: 0, minHeight: 44, paddingLeft: 8, paddingRight: 8, overflowWrap: 'break-word' };
/** The question as it shows (the dialog's accessible name is always `whole`): level 1, the short one with the meal. */
export const undoQuestion = (tx, service, whole: string, level: number): string =>
    (level >= 1 && service ? tx('meals.undo.confirm', '¿Deshacer la entrega de {service}?', { service: mealName(tx, service.meal) }) : whole);

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

/**
 * `service` = the service the rows delivered; `undoAsk` = the row whose undo is asking for confirmation
 * (owned by «Entrega», which clears it when the service changes); `onAskUndo(id | null)`, `onUndo(id)`.
 */
export function RecentDeliveries({ service, rows, busy = false, undoAsk = null, onAskUndo, onUndo }: any) {
    const tx = useTx();
    const { language } = useI18n();
    const what = service ? mealLine(tx, service, language) : '';
    const icon = `fa-solid ${MEAL_ICON[service?.meal] || 'fa-utensils'}`;
    const list = rows || [];
    // The question that just opened (one at a time), in its row.
    const askRef = useRef<HTMLDivElement | null>(null);
    const askButtonsRef = useRef<HTMLDivElement | null>(null);
    const rowRef = useRef<HTMLLIElement | null>(null);
    /** 0: the whole question; 1: the short one, while the row with the whole one is taller than the band (undoAskStepDown). */
    const [askLevel, setAskLevel] = useState(0);
    useLayoutEffect(() => { setAskLevel(0); }, [undoAsk]);
    useLayoutEffect(() => {
        if (undoAsk == null || typeof window === 'undefined') return;
        const next = undoAskStepDown(askLevel, rowRef.current, window);
        if (next !== askLevel) setAskLevel(next);
    });
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const refit = () => setAskLevel(0);
        window.addEventListener('resize', refit);
        return () => window.removeEventListener('resize', refit);
    }, []);
    // Once it has settled (the next frame: the short question taken when needed), bring the WHOLE ROW into view —
    // the name at its top included — else the question, else its buttons (revealAsk).
    useEffect(() => {
        if (undoAsk == null || typeof window === 'undefined') return;
        const reveal = () => { revealAsk(askRef.current, window, askButtonsRef.current, rowRef.current); };
        if (typeof window.requestAnimationFrame !== 'function') { reveal(); return; }
        const frame = window.requestAnimationFrame(reveal);
        return () => window.cancelAnimationFrame(frame);
    }, [undoAsk]);
    /** Room kept between the row (its question, its buttons) and the edges of the band when it is brought into view. */
    const margins = { scrollMarginTop: REVEAL_MARGIN_PX, scrollMarginBottom: REVEAL_MARGIN_PX };
    return (
        <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-5 space-y-2" data-recent="">
            <div>
                <h4 className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{tx('meals.recent', 'Últimas entregas')}</h4>
                {what && <p className="mt-1 ml-1 text-sm font-black text-gray-900 break-words" data-recent-service=""><i className={`${icon} mr-1.5 text-orange-600`} aria-hidden="true"></i>{what}</p>}
            </div>
            {!list.length && <p className="text-xs font-semibold text-gray-500">{tx('meals.recent.none', 'Aún no hay entregas en este servicio.')}</p>}
            <ul className="divide-y divide-gray-100">
                {list.map((r) => {
                    const place = r.location_id == null ? tx('meals.no.location', 'Sin localidad') : r.location;
                    const ask = tx('meals.undo.confirm.meal', '¿Deshacer la entrega de {meal} a {name}?', { meal: what, name: r.name });
                    const asking = undoAsk === r.delivery_id;
                    return (
                        <li key={r.delivery_id} ref={asking ? rowRef : undefined} className="py-2.5" style={margins} data-recent-row={r.delivery_id}>
                            <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-black text-gray-900 break-words" data-recent-name="">{r.name}</div>
                                    {what && <div className="text-[13px] font-bold leading-snug text-orange-800 break-words" data-recent-meal=""><i className={`${icon} mr-1`} aria-hidden="true"></i>{what}</div>}
                                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-gray-600">
                                        {r.method && <span className={`max-w-full break-words px-2 py-0.5 rounded-lg border text-[10px] font-black uppercase tracking-wide ${METHOD_CHIP[r.method] || METHOD_CHIP.scan}`} data-recent-method={r.method}>{methodLabel(tx, r.method)}</span>}
                                        <span className="tabular-nums" data-recent-time="">{stampTime(r.delivered_at)}</span>
                                        <span className="min-w-0 break-words">{[place, r.delivered_by].filter(Boolean).join(' · ')}</span>
                                    </div>
                                </div>
                                {!asking && (
                                    <button type="button" disabled={busy} onMouseDown={keepFocus} onClick={() => onAskUndo?.(r.delivery_id)} data-recent-undo=""
                                        className={`${UNDO_TARGET} shrink-0 inline-flex items-center justify-center rounded-xl text-gray-500 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40`}
                                        aria-label={tx('meals.undo.meal', 'Deshacer la entrega de {meal} a {name}', { meal: what, name: r.name })}><i className="fa-solid fa-rotate-left" aria-hidden="true"></i></button>
                                )}
                            </div>
                            {asking && (
                                <div ref={askRef} className="mt-2 rounded-xl bg-rose-50 px-3 py-2" style={{ display: 'flex', flexDirection: 'column', gap: 8, ...margins }} role="alertdialog" aria-label={ask} data-recent-undo-ask="">
                                    <span className="text-xs font-bold text-rose-800 break-words" data-recent-undo-question={askLevel}>{undoQuestion(tx, service, ask, askLevel)}</span>
                                    {/* One row, as wide as each other (at 320 px «Cancelar» dropped to a row of its own). */}
                                    <div ref={askButtonsRef} style={{ display: 'flex', gap: 8, ...margins }} data-recent-undo-buttons="">
                                        <button type="button" disabled={busy} onMouseDown={keepFocus} onClick={() => onUndo?.(r.delivery_id)} data-recent-undo-confirm=""
                                            className={`${UNDO_ASK_BUTTON} bg-rose-600 text-white disabled:opacity-50`} style={UNDO_ASK_BUTTON_STYLE}>{tx('meals.undo', 'Deshacer')}</button>
                                        <button type="button" onMouseDown={keepFocus} onClick={() => onAskUndo?.(null)} data-recent-undo-cancel=""
                                            className={`${UNDO_ASK_BUTTON} bg-white border-2 border-rose-100 text-gray-700`} style={UNDO_ASK_BUTTON_STYLE}>{tx('cancel', 'Cancelar')}</button>
                                    </div>
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

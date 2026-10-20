// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * Administration adjustments (2.17.0) — the admin changes a lodging arrangement that a location SUBMITTED, or
 * that the admin VALIDATED, without reopening it. The server lets every admin lodging write through on such a
 * location (Hospedaje › gestionar), keeps its status and records the change on it: `lodging_admin_changed_at`,
 * `lodging_admin_changed_by` (only for Localidades › ver) and `lodging_admin_changes` (since the coordinator's
 * last submission). Each write answers `lodging_adjusted`: the locations it adjusted.
 *
 * What this module gives the admin screens:
 *   - adjustState / adjustRelease / adjustText: the texts that name a reviewed location say its ACTUAL state
 *     («ya está validado» / «está enviado a validación»), never «en validación o validado», and the way back
 *     to a draft that state has («cuando se reabra» / «cuando se devuelva al encargado»);
 *   - withAdjusted: ONE toast for a lodging write — its own text plus «Registrado como ajuste …» when it
 *     adjusted something (two stacked toasts covered a fifth of a phone screen);
 *   - adjustConfirmText: the sentence a confirmation adds when the write changes reviewed arrangements;
 *   - reviewSeen: what the review modal sends back with «Validar» / «Devolver» (the server answers 409
 *     `lodging_changed` when the arrangement changed after the admin opened the review);
 *   - AdjustStamp: «Ajustado por la administración el … · N cambios desde el envío · Último cambio: …», in the
 *     lodging review; on the narrow location card, the same in two lines (`compact`);
 *   - DotList: «a · b · c» that wraps between items only, never leaving a «·» alone at a line's start or end
 *     (the stamp, and the card's lodging counts).
 * The coordinator's portal shows its own line (frontend/src/app/portal/conference/lodging.ts adminAdjustLine).
 */
import React from "react";
import { adjustedNames, lodgingStatusMeta } from "../lib/lodgingView";

type Tx = (key: string, fallback: string, vars?: Record<string, string | number>) => string;

/**
 * A server timestamp for display. The plugin stamps CURRENT_TIMESTAMP, which SQLite returns as
 * `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker (Chrome would read it as local time, Safari as invalid):
 * that form is parsed as UTC; anything unparseable is shown verbatim.
 */
export const fmtStamp = (v: unknown, locale?: string): string => {
    if (v == null || v === '') return '';
    const s = String(v).trim();
    const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s);
    const d = new Date(sql ? `${sql[1]}T${sql[2]}Z` : s);
    return isNaN(d.getTime()) ? s : d.toLocaleString(locale);
};

/** «ya está validado» / «está enviado a validación» — the {state} of a reviewed location in the adjustment texts. */
export const adjustState = (tx: Tx, status?: string | null): string =>
    status === 'validated'
        ? tx('lodging.adjust.state.validated', 'ya está validado')
        : tx('lodging.adjust.state.submitted', 'está enviado a validación');

/**
 * «cuando se reabra desde Localidades» / «cuando se devuelva al encargado desde Localidades» — the {release} of
 * a reviewed location: how it becomes a draft again. A VALIDATED one is reopened («Reabrir»); a SUBMITTED one
 * cannot be (POST …/lodging/reopen answers 409 «no está validado») — the review returns it to its coordinator
 * («Devolver»). Impersonal: the reader of a refusal (a role that may only manage inscriptions) may not be the
 * one who can do either.
 */
export const adjustRelease = (tx: Tx, status?: string | null): string =>
    status === 'validated'
        ? tx('lodging.adjust.release.validated', 'cuando se reabra desde Localidades')
        : tx('lodging.adjust.release.submitted', 'cuando se devuelva al encargado desde Localidades');

/** An adjustment text about ONE reviewed location: its {name}, its actual {state} and how it is {release}d. */
export const adjustText = (tx: Tx, key: string, fallback: string, location: { name: string; lodging_status?: string | null }): string =>
    tx(key, fallback, { name: location.name, state: adjustState(tx, location.lodging_status), release: adjustRelease(tx, location.lodging_status) });

/** The toast after a lodging write — null when it adjusted no submitted / validated arrangement. */
export const adjustedToastText = (tx: Tx, result: unknown): string | null => {
    const names = adjustedNames(result as any);
    return names ? tx('lodging.adjusted.toast', 'Registrado como ajuste de la administración en {names}.', { names }) : null;
};

/** ONE toast text for a lodging write: `text`, plus the adjustment sentence when the write adjusted something. */
export const withAdjusted = (tx: Tx, text: string, result: unknown): string => {
    const adjusted = adjustedToastText(tx, result);
    return adjusted ? `${String(text).replace(/[.\s]+$/, '')}. ${adjusted}` : text;
};

/**
 * The sentence a confirmation appends when the write changes reviewed arrangements ('' when none): each one
 * named with its own state — «Norte» (validado), «Sur» (enviado a validación).
 */
export const adjustConfirmText = (tx: Tx, reviewed: { name: string; lodging_status?: string | null }[] | null | undefined): string => {
    if (!reviewed || !reviewed.length) return '';
    const names = reviewed.map(l => {
        const meta = lodgingStatusMeta(l.lodging_status);
        return `«${l.name}» (${tx(meta.key, meta.fallback).toLocaleLowerCase()})`;
    }).join(', ');
    return tx('lodging.adjust.confirm', 'Afecta al hospedaje de {names}: el cambio quedará registrado como ajuste de la administración y sus encargados lo verán.', { names });
};

/**
 * What the review modal saw (GET /locations/:id/lodging): sent back with «Validar» / «Devolver», so a change
 * made after the admin opened the review (an adjustment, or a coordinator's new submission) is a 409
 * `lodging_changed` and not a validation of something nobody reviewed.
 */
export const reviewSeen = (review: any): { submitted_at: string | null; admin_changes: number } => ({
    submitted_at: review && review.location && review.location.lodging_submitted_at != null ? review.location.lodging_submitted_at : null,
    admin_changes: Number(review && review.location && review.location.lodging_admin_changes) || 0,
});

/** The same timestamp, short — day / month and hour:minute («8/10, 11:39») — for a narrow card. */
export const fmtStampShort = (v: unknown, locale?: string): string => {
    if (v == null || v === '') return '';
    const s = String(v).trim();
    const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s);
    const d = new Date(sql ? `${sql[1]}T${sql[2]}Z` : s);
    return isNaN(d.getTime()) ? s : d.toLocaleString(locale, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/**
 * Short items separated by «·» that wrap ONLY between items and never leave a separator alone at either end
 * of a line (the location card's counts and stamp used to: «5 alojados ·» / «· 0 sin habitación», a lone «·»
 * on a line of its own). Each item carries its separator IN FRONT of it, so none trails a line.
 *
 * The geometry: the list is pulled left by the separator's width (-ml-3) inside a clipping box; each item is
 * pushed back right by that same width (ml-3), so its BOX — every line of it — starts inside the clipping box,
 * and its separator hangs in that margin (-ml-3 on a w-3 inline block): between two items it fills the gap,
 * and in front of an item that starts a line it falls outside the box, clipped. An item wider than the line
 * shrinks to it and wraps inside itself, its wrapped lines starting where its first line's text does. (The
 * first version hung the ITEM in the margin instead: a wrapped line started 12 px outside the clipping box and
 * lost its first characters — «:09:31» for «14:09:31» in the review's stamp on a phone.) An item keeps its
 * words together unless it alone is wider than the line.
 */
export function DotList({ items, className = '', sepClassName = 'text-gray-300', ...rest }: { items: React.ReactNode[]; className?: string; sepClassName?: string } & Record<string, any>) {
    const shown = (items || []).filter(it => it != null && it !== false && it !== '');
    return (
        <span className={`block min-w-0 overflow-hidden ${className}`} data-dot-list="" {...rest}>
            <span className="-ml-3 flex flex-wrap">
                {shown.map((it, i) => (
                    <span key={i} className="ml-3 min-w-0 break-words">
                        <span aria-hidden="true" className={`-ml-3 inline-block w-3 text-center ${sepClassName}`}>·</span>{it}
                    </span>
                ))}
            </span>
        </span>
    );
}

/**
 * «Ajustado por la administración el {date}» with the date and time kept together («8/10/2026, 14:09:31» does not
 * split between the day and the hour): on a phone the sentence wraps before the date instead. An inline block
 * moves to the next line whole, and only a line narrower than the date itself wraps inside it (max-w-full) —
 * whitespace-nowrap would run past the line's end there and be clipped.
 */
function stampTitle(tx: Tx, date: string): React.ReactNode {
    const MARK = '\u0000';
    const parts = tx('lodging.adjusted.stamp', 'Ajustado por la administración el {date}', { date: MARK }).split(MARK);
    if (parts.length !== 2) return tx('lodging.adjusted.stamp', 'Ajustado por la administración el {date}', { date });
    return <>{parts[0]}<span className="inline-block max-w-full" data-adjust-stamp-date="">{date}</span>{parts[1]}</>;
}

/**
 * The stamp's pencil, in a column of its own: it always sits on the FIRST line of the text beside it (the
 * old wrapping row left it alone on line 1, the text below it), centred on that line.
 */
const StampIcon = () => (
    <span className="flex h-[1.375em] items-center text-[11px]" aria-hidden="true"><i className="fa-solid fa-pen-to-square text-[10px]"></i></span>
);

/** The stamp of a location row (GET /locations, or the `location` of GET /locations/:id/lodging); null = none. */
export const adjustStampOf = (location: any): { at: string; changes: number; by: string | null } | null => {
    const at = location && location.lodging_admin_changed_at;
    if (at == null || at === '') return null;
    return { at: String(at), changes: Math.max(1, Number(location.lodging_admin_changes) || 0), by: location.lodging_admin_changed_by || null };
};

/**
 * «Ajustado por la administración el {date}» · «N cambios desde el envío» · «Último cambio: {who}». Nothing
 * without a stamp. `detail` adds the review's explanation (the changes are already in what is shown, the
 * coordinator sees the notice, the next submission resets it). A plain block: it takes the full width of its
 * container (the location card renders it BELOW its icon / text / button row, never inside that row's squeezed
 * column), its padding and border included whatever the box-sizing.
 *
 * `compact` is the location card's: about 145 px of text on a 1280 px screen with the sidebar open cannot hold
 * the whole sentence in fewer than five lines, so the card says it in TWO — «Ajustado · N cambios» and «8/10,
 * 11:39 · who» — and keeps the whole sentence for the tooltip and for screen readers; the review shows it all
 * (on a phone its first item wraps: before the date, which stays whole with its time). Either way the pencil
 * stays with the first line and no «·» is left alone at a line's start or end.
 */
export function AdjustStamp({ location, tx, detail = false, compact = false, className = '' }: { location: any; tx: Tx; detail?: boolean; compact?: boolean; className?: string }) {
    const stamp = adjustStampOf(location);
    if (!stamp) return null;
    const title = tx('lodging.adjusted.stamp', 'Ajustado por la administración el {date}', { date: fmtStamp(stamp.at) });
    const changes = stamp.changes === 1
        ? tx('lodging.adjusted.changes.one', '{n} cambio desde el envío', { n: stamp.changes })
        : tx('lodging.adjusted.changes', '{n} cambios desde el envío', { n: stamp.changes });
    const by = stamp.by ? tx('lodging.adjusted.by', 'Último cambio: {who}', { who: stamp.by }) : null;
    const box = `min-w-0 rounded-xl border border-blue-200 bg-blue-50 text-blue-900 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1.5 ${className}`;
    if (compact) {
        const whole = [title, changes, by].filter(Boolean).join(' · ');
        const count = stamp.changes === 1
            ? tx('lodging.adjusted.card.changes.one', '{n} cambio', { n: stamp.changes })
            : tx('lodging.adjusted.card.changes', '{n} cambios', { n: stamp.changes });
        return (
            <div className={`${box} px-2.5 py-1.5`} data-adjust-stamp={stamp.changes} data-adjust-stamp-compact="" title={whole}>
                <StampIcon />
                <div className="min-w-0 leading-snug">
                    <span className="sr-only">{whole}</span>
                    <DotList aria-hidden="true" className="text-[11px] font-bold" sepClassName="text-blue-300"
                        items={[tx('lodging.adjusted.card', 'Ajustado'), count]} />
                    {/* ONE line: the time never wraps; a long login is cut with «…» (the tooltip has it whole). */}
                    <span aria-hidden="true" className="flex min-w-0 items-baseline text-[10px] font-semibold text-blue-800/80 whitespace-nowrap" data-adjust-stamp-when="">
                        <span className="shrink-0">{fmtStampShort(stamp.at)}</span>
                        {stamp.by && (<>
                            <span className="shrink-0 inline-block w-3 text-center text-blue-300">·</span>
                            <span className="min-w-0 truncate"><i className="fa-solid fa-user mr-1 text-[8px]"></i>{stamp.by}</span>
                        </>)}
                    </span>
                </div>
            </div>
        );
    }
    return (
        <div className={`${box} px-3 py-2`} data-adjust-stamp={stamp.changes}>
            <StampIcon />
            <div className="min-w-0 leading-snug">
                <DotList className="text-[11px] font-bold" sepClassName="text-blue-300" items={[stampTitle(tx, fmtStamp(stamp.at)), changes, by]} />
                {detail && <p className="text-[11px] font-medium mt-1">{tx('lodging.adjusted.review.hint', 'Lo que ves ya incluye esos cambios. El encargado ve el aviso en su portal; su próximo envío lo reinicia.')}</p>}
            </div>
        </div>
    );
}

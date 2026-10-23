// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * One fee payment (2.18.0): `TransferPanel` is its content — inline in the desktop review queue (master-
 * detail) — and `TransferSheet` the same content in an Overlay (a bottom sheet on a phone, centred from
 * 640 px), opened from «Pagos de cuotas», the person sheet's «Pago» section and «Contabilidad».
 *
 * Header: «Pago #123» + status; method · date · reference; location or «Varias»; who recorded it and when;
 * who reviewed it and when (stored since 2.x, shown for the first time). Then the receipt (fetched on
 * demand), the split («Reparto»: each person's part and where it leaves them once validated, with
 * «Cancelada» and the location when the payment mixes locations), the sum line, the notes and the history.
 *
 * Actions follow the server's state machine (lib/feePayments.ts transferActions) and every one sends
 * `expected` — the status and split generation shown — so the admin acts on exactly what they saw; a 409
 * reloads it. «Devolver» / «Rechazar» ask for the note INLINE (quick reasons, no extra layer). A payment
 * that would take someone past what they owe cannot be validated (owner decision D-P9 «Nunca»): the sheet
 * says so and offers «Editar reparto». A validated payment is never edited: «Anular validación» (a reject
 * with a reason); once voided, «Duplicar» re-uses its receipt (never while it still counts, D-P10).
 * In the desktop review queue (`inline`) «Editar reparto · Duplicar · Eliminar» come first, above the
 * receipt: at the end of a short payment they sat under the pinned decision bar.
 *
 * One handover counts in ONE payment: a voided payment that another payment records again («Duplicar») says
 * so («Registrado de nuevo en el pago #N») and offers neither «Validar» nor «Duplicar» while that one counts;
 * the copy says which payment it records again. «Revisado por» describes the review of the payment as it is:
 * a payment back in «Por validar» (resent or corrected) has none yet. Such a voided payment says nothing of
 * what validating it would do («Supera lo que debe…»): it cannot be validated.
 *
 * Keyboard and screen readers (2.18.0 review round 4): after a decision the focus goes to the payment shown
 * next (its heading) — «Validar y siguiente» moves on with the keyboard, and never drops the focus to <body>,
 * outside the dialog; the reason form takes the focus when it opens and «Cancelar» gives it back to the button
 * that opened it. A blocked «Validar» says why in words right above the bar (no hover-only title), a quick
 * reason is ADDED to what was typed, and a tap beside the sheet never throws a typed reason away.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { feePaymentsApi } from "../lib/conference";
import { LAYER, canAutoFocus, pushEscape } from "../lib/overlay";
import { toCents } from "../lib/feeSplit";
import { REVIEW_REASONS, RELOAD_CODES, actorText, expectedOf, feeErrorText, fmtDay, fmtStamp, isReused, recorderKind, transferActions, validationBlocked } from "../lib/feePayments";
import { Overlay, useShortTouch } from "./Overlay";
import { ProofThumb, forgetProof } from "./ProofViewer";
import { StatusPill, SumState, Spinner, factsOf, money } from "./FeeBits";
import { useTx } from "./MealScanner";
import { paymentMethodLabel, switchLabel } from "../lib/labels";

/** The people of a payment (to refresh their rows after an action). */
const idsOf = (t: any): number[] => (t && Array.isArray(t.allocations) ? t.allocations.map((a) => Number(a.inscription_id)) : []);

const btnBase = 'min-h-[44px] px-4 rounded-2xl font-black text-[11px] uppercase tracking-widest inline-flex items-center justify-center gap-2 disabled:opacity-50';
const BTN = {
    primary: `${btnBase} bg-emerald-600 text-white hover:bg-emerald-700 shadow-lg shadow-emerald-500/20`,
    ghost: `${btnBase} bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400`,
    warn: `${btnBase} bg-white border-2 border-orange-200 text-orange-800 hover:border-orange-400`,
    danger: `${btnBase} bg-white border-2 border-rose-200 text-rose-700 hover:border-rose-400`,
};

/** The after-state line of one part: «Queda pagado» / «Debe $X» / «Supera lo que debe por $Y». */
export function afterText(tx, a, status: string): { text: string; tone: 'ok' | 'owed' | 'over' } {
    const after = a.after || { paid: 0, owed: 0, credit: 0 };
    if (toCents(after.credit) > 0) return { text: tx('fees.after.over', 'Supera lo que debe por {amount}', { amount: money(toCents(after.credit)) }), tone: 'over' };
    if (toCents(after.owed) > 0) return { text: tx('fees.after.owes', 'Debe {amount}', { amount: money(toCents(after.owed)) }), tone: 'owed' };
    return { text: status === 'validated' ? tx('fees.after.paid', 'Queda pagado') : tx('fees.after.paid.when', 'Queda pagado al validarse'), tone: 'ok' };
}

/**
 * A history line's actor: «Portal de Bogotá» for a coordinator (stored as 'portal:<id>'), else the login. One fact:
 * «Portal · Bogotá» read as two beside the line's other «·» separators (2.18.0 review UX6-3).
 */
export function actorLabel(tx, actor: string | null, t: any, locationName?: (id: number) => string | null | undefined): string {
    const a = actorText(actor, t, locationName);
    if (!a) return '';
    return a.kind === 'user' ? a.text : a.location ? tx('fees.by.portal', 'Portal de {location}', { location: a.location }) : tx('fees.by.portal.short', 'Portal');
}

/** Bring the note form into view once it opens (a phone keeps the actions pinned off it): smooth unless reduced motion. */
export function revealNoteForm(el: { scrollIntoView?: (o: any) => void } | null, reduced: boolean) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try { el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch { /* old browser */ }
}

/**
 * A quick reason chip ADDED to the reason box (it used to replace what was typed: «La foto no deja leer la
 * referencia; además falta Luis» became «Comprobante ilegible»): an empty box takes the chip, a box that already
 * says it stays as it is, else « · » joins them.
 */
export function appendReason(current: string, chip: string): string {
    const now = String(current || '').trim();
    if (!now) return chip;
    if (now.split(' · ').includes(chip) || now === chip) return now;
    return `${now} · ${chip}`;
}

/**
 * Could this payment be validated (now or once corrected)? Pending and returned ones, and a voided one that no
 * other payment records again. Only then do «Supera lo que debe» and each person's after-state mean anything.
 */
export const canStillValidate = (t: { status?: string; reused_by?: unknown[] | null }): boolean =>
    t.status === 'pending' || t.status === 'returned' || (t.status === 'rejected' && !isReused(t as any));

/** A tap beside the sheet closes it — unless a «Devolver» / «Rechazar» reason is typed in it (as Escape). */
export const backdropCloser = (onClose: () => void, dirty: { current: boolean }) => () => { if (!dirty.current) onClose(); };

/** Focus an element without scrolling (the heading of the payment shown next, a form, a button). */
export function focusQuietly(el: { focus?: (o?: any) => void } | null | undefined): boolean {
    if (!el || typeof el.focus !== 'function') return false;
    try { el.focus({ preventScroll: true }); return true; } catch { return false; }
}

/**
 * «Validar» (2.18.0 review R5-M1): a voided transfer validated again while ANOTHER live payment uses its reference
 * is refused (409 duplicate_reference) — the same bank transfer recorded again by hand would count twice. The
 * admin is asked «Esa referencia ya cuenta en el pago #N. ¿Validar de todas formas?» and, on yes, it is sent
 * again with the flag. `validate(allow)` sends; resolves to the server's answer, or `{ cancelled: true }` when
 * the admin said no. Any other failure is thrown as it came.
 */
export async function validateWithConfirm(t: any, { validate, confirm, tx }: { validate: (allow: boolean) => Promise<any>; confirm?: (message: string, label: string, danger?: boolean) => Promise<boolean>; tx: any }): Promise<any> {
    try {
        return await validate(false);
    } catch (e: any) {
        if (!e || e.code !== 'duplicate_reference' || !confirm) throw e;
        const otherId = Number((e.details && e.details.other && e.details.other.id) || (t && t.flags && t.flags.duplicate_reference_of)) || null;
        const message = otherId
            ? tx('fees.confirm.validate.reference', 'Esa referencia ya cuenta en el pago #{id}. ¿Validar de todas formas?', { id: otherId })
            : tx('fees.confirm.validate.reference.any', 'Esa referencia ya cuenta en otro pago. ¿Validar de todas formas?');
        if (!await confirm(message, tx('fees.action.validate.anyway', 'Validar de todas formas'), false)) return { cancelled: true };
        return validate(true);
    }
}

/**
 * The facts line of a payment («$250,00 · Efectivo · 07/10/2026 · Ref. X»): FeeBits factsOf — each fact whole,
 * carrying its own leading «· », so a narrow line breaks BETWEEN facts (2.18.0 review PUX-10). Re-exported here.
 */
export { factsOf };

/**
 * A history line («Validado · 11/10/2026 22:19 · Portal de Bogotá»): its facts, each with its leading «·» (2.18.0
 * review UX6-3). `reference_confirmed` (the admin validated a payment whose transfer reference another live
 * payment uses, «Validar de todas formas») says which payment in words — its note is that payment's number.
 */
export function eventFacts(tx, e: { action: string; at?: string | null; actor?: string | null; note?: string | null }, actor: string): React.ReactNode[] {
    const title = e.action === 'reference_confirmed'
        ? tx('fees.event.reference_confirmed', 'Referencia repetida confirmada: también cuenta en el pago #{id}', { id: String(e.note || '?') })
        : (() => { const [k, f] = EVENT_TEXT[e.action] || [`fees.event.${e.action}`, e.action]; return tx(k, f); })();
    return factsOf([<span className="font-black text-gray-900">{title}</span>, fmtStamp(e.at, true), actor || null], null, { long: true });
}

/** «Revisado por …» only describes a decision on the payment as it is now: never while it awaits one. */
export const showsReview = (t: { reviewed_at?: string | null; status?: string }): boolean => !!t.reviewed_at && t.status !== 'pending';

const EVENT_TEXT: Record<string, [string, string]> = {
    created: ['fees.event.created', 'Registrado'],
    validated: ['fees.event.validated', 'Validado'],
    returned: ['fees.event.returned', 'Devuelto'],
    rejected: ['fees.event.rejected', 'Rechazado'],
    edited: ['fees.event.edited', 'Corregido'],
    resent: ['fees.event.resent', 'Corregido y reenviado'],
};

/**
 * Props: `id`; `canManage` (payments:manage); `onChanged(change)` after an action (`{ action, transfer?, ids,
 * id }`; action 'reload' when the shown data was stale); `onEdit(detail)` / `onDuplicate(detail)` open the
 * register sheet (absent → the buttons are not offered, e.g. from «Contabilidad»); `queue`: the review
 * queue's «Validar y siguiente» wording; `confirm(message, label, danger)` → Promise<boolean>; `notify(message,
 * type)` replaces the toast (the desktop review queue says it above the list: the toast at the bottom right
 * covered «Rechazar…» and «Validar y siguiente»); `onShown(detail)` once a payment is drawn.
 */
export function TransferPanel({ id, canManage, onChanged, onEdit, onDuplicate, queue = false, confirm, reloadKey = 0, onClose, inline = false, titleId, initial = null, locationName, notify = null, onShown = null, dirtyRef = null }: any) {
    const tx = useTx();
    const { addToast: toast } = useToast();
    const shortTouch = useShortTouch();
    // What an action did: the parent's notice (the desktop queue), else — in a sheet — a line in the sheet's
    // header (pinned on a phone): a toast sits at the bottom of the screen, over the pinned «Devolver… /
    // Rechazar… / Validar» bar. A payment deleted closes its sheet: that one is a toast (nothing left to cover).
    const [notice, setNotice] = useState<{ text: string; type: string; n: number } | null>(null);
    useEffect(() => {
        if (!notice) return undefined;
        const h = setTimeout(() => setNotice((cur) => (cur && cur.n === notice.n ? null : cur)), notice.type === 'error' ? 10000 : 6000);
        return () => clearTimeout(h);
    }, [notice]);
    const addToast = notify || (inline ? toast : (text: string, type = 'info') => setNotice((cur) => ({ text, type, n: (cur ? cur.n : 0) + 1 })));
    // `initial`: a detail already in hand (no first spinner); it is re-read anyway.
    const [t, setT] = useState<any>(initial && Number(initial.id) === Number(id) ? initial : null);
    const [loadErr, setLoadErr] = useState('');
    const [busy, setBusy] = useState('');
    const [noteFor, setNoteFor] = useState<'return' | 'reject' | null>(null);
    const [note, setNote] = useState('');
    const [seq, setSeq] = useState(0);
    const noteRef = useRef<HTMLElement | null>(null);
    const noteBoxRef = useRef<HTMLTextAreaElement | null>(null);
    const noteText = useRef('');
    noteText.current = note;
    // The sheet's backdrop asks this before closing (backdropCloser): a typed reason is never thrown away.
    if (dirtyRef) dirtyRef.current = !!noteFor && !!note.trim();
    const headRef = useRef<HTMLHeadingElement | null>(null);
    const barRef = useRef<HTMLDivElement | null>(null);
    // After a decision the focus goes INTO the payment shown (the next one in the queue, or this one with its
    // new actions): the button pressed is gone, and the focus would fall to <body>, outside the dialog.
    const focusAfter = useRef<number | null>(null);
    // «Cancelar» of the reason form (or Escape in an empty one) gives the focus back to the button that opened it.
    const focusBack = useRef<string | null>(null);
    const openedBy = useRef<string | null>(null);
    // While the reason form is open, Escape is ITS: an empty reason closes the form (the payment stays open),
    // a typed one is kept — never the whole sheet with the reason in it (2.18.0 review).
    useEffect(() => (noteFor ? pushEscape(() => { if (!noteText.current.trim()) { focusBack.current = openedBy.current; setNoteFor(null); setNote(''); } return true; }) : undefined), [noteFor]);
    // «Devolver…» / «Rechazar…» open the reason form at the END of the sheet, below the receipt and the
    // split, while the pinned action bar goes away: bring the form into view (with a mouse the cursor goes
    // in it too; a phone keeps its keyboard closed until the reason box is tapped).
    useEffect(() => {
        if (!noteFor) return;
        const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        revealNoteForm(noteRef.current, reduced);
        if (canAutoFocus()) focusQuietly(noteBoxRef.current);
        else focusQuietly(noteRef.current);
    }, [noteFor]);
    useEffect(() => {
        if (noteFor || !focusBack.current) return;
        const act = focusBack.current;
        focusBack.current = null;
        focusQuietly(barRef.current ? barRef.current.querySelector(`[data-act="${act}"]`) : null);
    }, [noteFor]);

    const load = useCallback(async () => {
        setLoadErr('');
        try { setT(await feePaymentsApi.getTransfer(id)); }
        catch (e: any) { setT(null); setLoadErr(feeErrorText(e, tx)); }
    }, [id]);
    useEffect(() => { setT((cur) => (cur && Number(cur.id) === Number(id) ? cur : null)); setNoteFor(null); setNote(''); load(); }, [id, reloadKey, seq]);
    useEffect(() => { if (t && onShown) onShown(t); }, [t]);
    useEffect(() => {
        if (!t || focusAfter.current == null) return;
        focusQuietly(headRef.current);
        // In the queue the decided payment shows once more before the next one: the focus waits for that one.
        if (!queue || Number(t.id) !== focusAfter.current) focusAfter.current = null;
    }, [t]);

    const fail = (e: any) => {
        addToast(feeErrorText(e, tx), 'error');
        if (e && RELOAD_CODES.has(e.code)) { setSeq((n) => n + 1); if (onChanged) onChanged({ action: 'reload', id, ids: idsOf(t) }); }
    };
    const run = async (action: string, fn: () => Promise<any>, ok: string) => {
        setBusy(action);
        try {
            const r = await fn();
            if (r && r.cancelled) return;   // the admin said no to a confirmation: nothing happened
            addToast(ok, 'success');
            focusAfter.current = Number(t.id);
            setNoteFor(null); setNote('');
            if (r && r.transfer) setT(r.transfer);
            if (onChanged) onChanged({ action, id, transfer: r && r.transfer, ids: idsOf((r && r.transfer) || t) });
        } catch (e: any) { fail(e); }
        finally { setBusy(''); }
    };

    if (!t) {
        return loadErr
            ? <div className="p-6 space-y-3" role="alert"><p className="text-sm font-bold text-rose-700">{loadErr}</p><button type="button" className={BTN.ghost} onClick={() => setSeq((n) => n + 1)}>{tx('staff.retry', 'Reintentar')}</button></div>
            : <Spinner label={tx('loading', 'Cargando...')} />;
    }

    const can = transferActions(t.status, canManage, t);
    const blocked = validationBlocked(t);
    // People cancelled since the payment was recorded: they owe nothing, so it cannot be validated with them
    // (the server answers 409 cancelled_people) — correct the split, reactivate them or reject the payment.
    const cancelled = [...new Set([...(t.flags?.cancelled_people || []), ...(t.allocations || []).filter((a) => a.cancelled).map((a) => a.inscription_id)])];
    const overBlocked = blocked.filter((id) => !cancelled.includes(id));
    // A voided payment that another one records again cannot be validated: what validating it would do («Supera
    // lo que debe…», each person's after-state) is no question for it (it read like a call to correct the split).
    const validatable = canStillValidate(t);
    const blockReason = cancelled.length && validatable
        ? tx('fees.flag.cancelled.block', 'Persona cancelada: ya no debe nada. Corrige el reparto, reactívala o rechaza el pago.')
        : tx('fees.flag.over', 'Supera lo que debe: corrige el reparto antes de validar');
    const sumC = (t.allocations || []).reduce((s, a) => s + toCents(a.amount), 0);
    const recorder = recorderKind(t);
    const who = recorder === 'portal' ? tx('fees.by.portal', 'Portal de {location}', { location: t.location || tx('no.location', 'Sin localidad') })
        : recorder === 'legacy' ? tx('fees.by.legacy', 'el sistema anterior') : (t.recorded_by || tx('fees.by.admin', 'Administración'));
    // The header's lines under the title (facts, recorder, reviewer, «Duplicar» source): in the header — except in a
    // sheet on a phone held sideways, where they scroll at the top of the body and the pinned header keeps only
    // «Pago #N · status», the ✕ and the notice (2.18.0 review UX6-8: pinned, they left a 176 px slit for the receipt).
    const extrasInBody = !inline && shortTouch;
    const headExtras = (
        <>
            <p className="flex flex-wrap gap-x-1 text-sm font-black text-gray-900" data-cm-head-extra="" data-transfer-facts="">{factsOf([<span className="tabular-nums">{money(toCents(t.amount))}</span>, t.method ? paymentMethodLabel(tx, t.method) : '—', fmtDay(t.paid_on)], t.reference ? tx('fees.ref', 'Ref. {ref}', { ref: t.reference }) : null)}</p>
            <p className="flex flex-wrap gap-x-1 text-xs font-bold text-gray-600" data-cm-head-extra="" data-transfer-recorded="">
                {factsOf([<><i className="fa-solid fa-location-dot mr-1" aria-hidden="true"></i>{t.mixed ? tx('fees.location.mixed', 'Varias localidades') : (t.location || tx('no.location', 'Sin localidad'))}</>,
                    tx('fees.recorded', 'Registrado por {who} el {at}', { who, at: fmtStamp(t.submitted_at || t.created_at, true) })], null, { long: true })}
            </p>
            {showsReview(t) && <p className="text-xs font-bold text-gray-600" data-cm-head-extra="" data-reviewed="">{tx('fees.reviewed', 'Revisado por {who} el {at}', { who: t.reviewed_by || '—', at: fmtStamp(t.reviewed_at, true) })}</p>}
            {t.duplicate_of != null && <p className="text-xs font-bold text-gray-600" data-cm-head-extra="" data-duplicate-of={t.duplicate_of}><i className="fa-solid fa-copy mr-1" aria-hidden="true"></i>{tx('fees.duplicate.of', 'Registra de nuevo el pago anulado #{id}', { id: t.duplicate_of })}</p>}
        </>
    );
    const submitNote = async () => {
        const text = note.trim();
        if (!text) { addToast(tx('fees.error.note_required', 'Escribe el motivo.'), 'error'); return; }
        if (noteFor === 'return') await run('return', () => feePaymentsApi.giveBack(t.id, text, expectedOf(t)), tx('fees.done.returned', 'Pago devuelto a quien lo registró.'));
        else await run('reject', () => feePaymentsApi.reject(t.id, text, expectedOf(t)), t.status === 'validated' ? tx('fees.done.voided', 'Validación anulada.') : tx('fees.done.rejected', 'Pago rechazado.'));
    };
    const remove = async () => {
        if (confirm && !await confirm(tx('fees.confirm.delete', '¿Eliminar el pago #{id}? Sus partes dejan de contar.', { id: t.id }), tx('delete', 'Eliminar'), true)) return;
        setBusy('remove');
        try {
            await feePaymentsApi.remove(t.id, expectedOf(t));
            forgetProof(t.id);
            focusAfter.current = Number(t.id);
            (notify || toast)(tx('fees.done.deleted', 'Pago eliminado.'), 'success');
            if (onChanged) onChanged({ action: 'remove', id: t.id, ids: idsOf(t) });
        } catch (e: any) { fail(e); }
        finally { setBusy(''); }
    };

    const secondary = canManage && !noteFor && ((can.edit && onEdit) || (can.duplicate && onDuplicate) || can.remove) ? (
        <div className="flex flex-wrap gap-2 pt-1" data-transfer-secondary={inline ? 'top' : 'end'}>
            {can.edit && onEdit && <button type="button" className={BTN.ghost} disabled={!!busy} onClick={() => onEdit(t)} data-act="edit"><i className="fa-solid fa-pen" aria-hidden="true"></i>{t.status === 'pending' ? tx('fees.action.edit.split', 'Editar reparto') : tx('edit', 'Editar')}</button>}
            {can.duplicate && onDuplicate && <button type="button" className={BTN.ghost} disabled={!!busy} onClick={() => onDuplicate(t)} data-act="duplicate"><i className="fa-solid fa-copy" aria-hidden="true"></i>{tx('fees.action.duplicate', 'Duplicar')}</button>}
            {can.remove && <button type="button" className={BTN.danger} disabled={!!busy} onClick={remove} data-act="remove"><i className="fa-solid fa-trash-can" aria-hidden="true"></i>{tx('delete', 'Eliminar')}</button>}
        </div>
    ) : null;

    // A fragment: in the sheet the header is the card's FIRST CHILD, which the overlay pins to the top on a
    // phone (OVERLAY_CSS), and the actions row its data-cm-sheet-foot, pinned to the bottom.
    return (
        <>
            {/* Header */}
            <div className={`${inline ? '' : 'bg-gray-50/50 border-b border-gray-100'} px-5 sm:px-8 py-5 flex items-start justify-between gap-3`}
                data-transfer-panel={t.id} data-transfer-status={t.status}>
                <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 id={titleId} ref={headRef} tabIndex={-1} data-transfer-heading="" className="font-black text-xl sm:text-2xl text-gray-900 italic tracking-tighter outline-none">{tx('fees.transfer.title', 'Pago #{id}', { id: t.id })}</h3>
                        <StatusPill status={t.status} />
                    </div>
                    {!extrasInBody && headExtras}
                    {notice && (
                        <p role={notice.type === 'error' ? 'alert' : 'status'} data-panel-notice={notice.type}
                            className={`rounded-xl px-3 py-2 text-xs font-bold break-words ${notice.type === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}>
                            <i className={`fa-solid ${notice.type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'} mr-1.5`} aria-hidden="true"></i>{notice.text}
                        </p>
                    )}
                </div>
                {!inline && onClose && (
                    <button type="button" onClick={onClose} aria-label={tx('close', 'Cerrar')} className="shrink-0 w-11 h-11 flex items-center justify-center rounded-2xl text-gray-500 hover:bg-gray-100">
                        <i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i>
                    </button>
                )}
            </div>

            {/* The body: in the desktop review queue the only part that scrolls (FEES_CSS), above the bar. */}
            <div className="px-5 sm:px-8 py-5 space-y-6" data-transfer-body="">
                {/* A phone held sideways: the header's lines under the title scroll with the body (useShortTouch). */}
                {extrasInBody && <div className="space-y-1.5" data-head-extras-in-body="">{headExtras}</div>}
                {/* In the review queue (inline, beside the list) the corrections sit at the TOP: at the end of a
                    short payment they started under the pinned decision bar until the panel was scrolled. */}
                {inline && secondary}
                {/* Warnings */}
                {(cancelled.length > 0 || t.flags?.duplicate_reference || (validatable && blocked.length > 0) || t.legacy) && (
                    <div className="flex flex-wrap gap-2" data-transfer-flags="">
                        {cancelled.length > 0 && <span data-flag="cancelled" className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-800 text-[11px] font-black"><i className="fa-solid fa-ban mr-1" aria-hidden="true"></i>{validatable ? tx('fees.flag.cancelled.block', 'Persona cancelada: ya no debe nada. Corrige el reparto, reactívala o rechaza el pago.') : tx('fees.flag.cancelled', 'Persona cancelada')}</span>}
                        {t.flags?.duplicate_reference && <span data-flag="reference" className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 text-[11px] font-black"><i className="fa-solid fa-clone mr-1" aria-hidden="true"></i>{tx('fees.flag.reference', 'Referencia repetida')}</span>}
                        {overBlocked.length > 0 && validatable && <span data-flag="over" className="px-2.5 py-1 rounded-full bg-rose-50 text-rose-800 text-[11px] font-black"><i className="fa-solid fa-triangle-exclamation mr-1" aria-hidden="true"></i>{tx('fees.flag.over', 'Supera lo que debe: corrige el reparto antes de validar')}</span>}
                        {t.legacy && <span data-flag="legacy" className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 text-[11px] font-black">{tx('fees.flag.legacy', 'Registrado antes de «Pagos de cuotas»')}</span>}
                    </div>
                )}
                {t.status === 'rejected' && isReused(t) && (
                    <p className="rounded-2xl bg-sky-50 text-sky-900 px-4 py-3 text-sm font-bold" data-reused-by={t.reused_by[0].id}>
                        <i className="fa-solid fa-copy mr-1.5" aria-hidden="true"></i>{tx('fees.reused.by', 'Registrado de nuevo en el pago #{id}, que cuenta: este no puede volver a validarse ni duplicarse mientras aquel cuente.', { id: t.reused_by[0].id })}
                    </p>
                )}
                {t.review_note && (t.status === 'returned' || t.status === 'rejected') && (
                    <div className={`rounded-2xl px-4 py-3 text-sm font-bold ${t.status === 'returned' ? 'bg-orange-50 text-orange-900' : 'bg-rose-50 text-rose-900'}`} data-review-note="">
                        <span className="block text-[10px] font-black uppercase tracking-widest opacity-80">{t.status === 'returned' ? tx('fees.note.returned', 'Motivo de la devolución') : tx('fees.note.rejected', 'Motivo del rechazo')}</span>
                        {t.review_note}
                    </div>
                )}

                {/* Receipt */}
                <section>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-2">{tx('fees.proof', 'Comprobante')}</h4>
                    <ProofThumb transferId={t.id} hasProof={!!t.has_proof} allocGen={t.alloc_gen} large={inline} />
                </section>

                {/* Split */}
                <section>
                    <h4 className="flex flex-wrap gap-x-1 text-[10px] font-black uppercase tracking-widest text-gray-500 mb-2" data-split-title="">{factsOf([tx('fees.split', 'Reparto'), t.people === 1 ? tx('fees.people.count.one', '{n} persona', { n: 1 }) : tx('fees.people.count', '{n} personas', { n: t.people })])}</h4>
                    <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-100" data-transfer-parts="">
                        {(t.allocations || []).map((a) => {
                            const after = validatable || t.status === 'validated' ? afterText(tx, a, t.status) : null;
                            return (
                                <li key={a.id} className="px-4 py-3 flex flex-wrap items-start gap-x-3 gap-y-1" data-part={a.inscription_id}>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-black text-gray-900 break-words">{a.name || `#${a.inscription_id}`}</span>
                                        <span className="flex flex-wrap items-center gap-1.5 mt-0.5">
                                            {t.mixed && <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-800 text-[10px] font-black">{a.location || tx('no.location', 'Sin localidad')}</span>}
                                            {a.cancelled && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-[10px] font-black uppercase tracking-widest">{tx('roster.cancelled', 'Cancelada')}</span>}
                                            {after && <span data-after={after.tone} className={`text-[11px] font-bold ${after.tone === 'over' ? 'text-rose-700' : after.tone === 'owed' ? 'text-amber-800' : 'text-emerald-700'}`}>{after.text}</span>}
                                        </span>
                                    </span>
                                    <span className="text-sm font-black text-gray-900 tabular-nums">{money(toCents(a.amount))}</span>
                                </li>
                            );
                        })}
                    </ul>
                    <div className="mt-2" data-sum-line=""><SumState assignedC={sumC} totalC={toCents(t.amount)} /></div>
                </section>

                {/* Notes + history */}
                {t.note && (
                    <section>
                        <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-1">{tx('fees.note', 'Nota de quien lo registró')}</h4>
                        <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{t.note}</p>
                    </section>
                )}
                {Array.isArray(t.events) && t.events.length > 0 && (
                    <section>
                        <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-2">{tx('fees.history', 'Historial')}</h4>
                        <ol className="space-y-1.5" data-history="">
                            {t.events.map((e) => {
                                return (
                                    <li key={e.id} className="text-xs text-gray-700" data-history-event={e.action}>
                                        <span className="flex flex-wrap gap-x-1">{eventFacts(tx, e, e.actor ? actorLabel(tx, e.actor, t, locationName) : '')}</span>
                                        {e.note && e.action !== 'reference_confirmed' && <span className="block text-gray-600 italic break-words">«{e.note}»</span>}
                                    </li>
                                );
                            })}
                        </ol>
                    </section>
                )}

                {/* Inline note form (Devolver / Rechazar) */}
                {noteFor && (
                    <section ref={noteRef} tabIndex={-1} aria-labelledby={`fee-note-label-${t.id}`} className={`rounded-2xl border-2 p-4 space-y-3 outline-none ${noteFor === 'return' ? 'border-orange-200 bg-orange-50/40' : 'border-rose-200 bg-rose-50/40'}`} data-note-form={noteFor}>
                        <label id={`fee-note-label-${t.id}`} htmlFor={`fee-note-${t.id}`} className="block text-[10px] font-black uppercase tracking-widest text-gray-600">
                            {noteFor === 'return' ? tx('fees.return.note', 'Qué debe corregir quien lo registró') : t.status === 'validated' ? tx('fees.void.note', 'Por qué se anula la validación') : tx('fees.reject.note', 'Motivo del rechazo')}
                        </label>
                        <div className="flex flex-wrap gap-2" data-reasons="">
                            {REVIEW_REASONS.map((r) => (
                                <button key={r.key} type="button" onClick={() => setNote((n) => appendReason(n, tx(r.key, r.fallback)))} className="min-h-[44px] px-3 rounded-full bg-white border border-gray-200 text-[11px] font-bold text-gray-700 hover:border-blue-400">{tx(r.key, r.fallback)}</button>
                            ))}
                        </div>
                        <textarea ref={noteBoxRef} id={`fee-note-${t.id}`} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} autoFocus={canAutoFocus()}
                            className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-white focus:border-blue-500 outline-none text-base text-gray-900 resize-none" />
                        <div className="flex flex-wrap justify-end gap-2">
                            <button type="button" className={BTN.ghost} onClick={() => { focusBack.current = openedBy.current; setNoteFor(null); setNote(''); }} data-note-cancel="">{tx('cancel', 'Cancelar')}</button>
                            <button type="button" className={noteFor === 'return' ? BTN.warn : BTN.danger} disabled={!!busy || !note.trim()} onClick={submitNote} data-note-submit="">
                                {noteFor === 'return' ? tx('fees.action.return', 'Devolver') : t.status === 'validated' ? tx('fees.action.void', 'Anular validación') : tx('fees.action.reject', 'Rechazar')}
                            </button>
                        </div>
                    </section>
                )}

                {/* Secondary actions: correct, copy, delete (never in the pinned bar; at the top when inline) */}
                {!inline && secondary}
            </div>

            {/* The review actions (pinned to the bottom on a phone: the overlay sticks data-cm-sheet-foot) */}
            {canManage && !noteFor && (can.validate || can.return || can.reject) && (
                <div ref={barRef} className="px-5 sm:px-8 py-4 border-t border-gray-100 bg-white flex flex-wrap items-center justify-end gap-2" data-cm-sheet-foot="" data-transfer-actions="">
                    {/* Why «Validar» is off, in words beside it — a phone has no hover, and the warning chip at the top of
                        the body has scrolled away by the time the admin reaches the bar. */}
                    {can.validate && blocked.length > 0 && (
                        <p id={`fee-blocked-${t.id}`} className="basis-full text-xs font-bold text-rose-700" role="status" data-foot-issue="" data-validate-blocked="">
                            <i className="fa-solid fa-circle-info mr-1.5" aria-hidden="true"></i>{blockReason}
                        </p>
                    )}
                    {can.return && <button type="button" className={BTN.warn} disabled={!!busy} onClick={() => { openedBy.current = 'return'; setNoteFor('return'); setNote(''); }} data-act="return"><i className="fa-solid fa-rotate-left" aria-hidden="true"></i>{tx('fees.action.return.ask', 'Devolver…')}</button>}
                    {can.reject && <button type="button" className={BTN.danger} disabled={!!busy} onClick={() => { openedBy.current = can.voids ? 'void' : 'reject'; setNoteFor('reject'); setNote(''); }} data-act={can.voids ? 'void' : 'reject'}><i className="fa-solid fa-circle-xmark" aria-hidden="true"></i>{can.voids ? tx('fees.action.void.ask', 'Anular validación…') : tx('fees.action.reject.ask', 'Rechazar…')}</button>}
                    {can.validate && (
                        <button type="button" className={BTN.primary} disabled={!!busy || blocked.length > 0} data-act="validate"
                            aria-describedby={blocked.length ? `fee-blocked-${t.id}` : undefined}
                            onClick={() => run('validate', () => validateWithConfirm(t, { validate: (allow) => feePaymentsApi.validate(t.id, expectedOf(t), allow), confirm, tx }), tx('fees.done.validated', 'Pago validado.'))}>
                            <i className={`fa-solid ${busy === 'validate' ? 'fa-spinner fa-spin' : 'fa-circle-check'}`} aria-hidden="true"></i>
                            {queue ? tx('fees.action.validate.next', 'Validar y siguiente') : tx('fees.action.validate', 'Validar')}
                        </button>
                    )}
                </div>
            )}
        </>
    );
}

/** The panel in an Overlay (layer 2 by default: above the person sheet). */
export function TransferSheet({ id, onClose, layer = LAYER.modal, returnFocus, ...rest }: any) {
    const titleId = `fee-transfer-title-${id}`;
    const dirty = useRef(false);
    return (
        <Overlay layer={layer} onBackdrop={backdropCloser(onClose, dirty)} onEscape={onClose} returnFocus={returnFocus}>
            <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-white rounded-[32px] shadow-2xl w-full max-w-2xl border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                <TransferPanel id={id} onClose={onClose} titleId={titleId} dirtyRef={dirty} {...rest} />
            </div>
        </Overlay>
    );
}

export default TransferSheet;

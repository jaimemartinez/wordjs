// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Registrar pago» (2.18.0): one receipt split among several people — also «Editar reparto» of a pending or
 * returned payment and «Duplicar» of a voided one (its receipt is re-used on the server).
 *
 * Opened from «Pagos de cuotas» (empty, or with the «Saldos» selection) and from the person sheet (that
 * person; «+ Añadir su grupo familiar (n)»). Sections, in order:
 *   1. Personas — chips with «debe $X · falta $Y»; «+ Añadir» opens the picker inline (people of several
 *      locations allowed, D-P3, with a notice; cancelled people never offered).
 *   2. Pago — the total (prefilled with what the chosen people still have to cover), the method, the date
 *      (today by default, never after tomorrow), the reference (transfer), an optional note.
 *   3. Reparto — «Iguales» (default; leftover cents to the first people) or «Manual» (typing in a part
 *      switches to it). A live «Asignado $X de $Y» says ✓ / «Faltan $Z» / «Sobran $Z»; each person says
 *      where the part leaves them, and a part above what they still owe is refused inline (D-P9 «Nunca»).
 *   4. Comprobante — required for a transfer, optional for cash (D-P12); compressed on the device.
 *   5. «Dejar por validar» — off: an admin payment is born validated (D-P8).
 * The footer button stays disabled until the draft is valid. The draft keeps one `client_key`, so a retry
 * after a network failure never records the payment twice. A send that fails (the network, a refusal) says
 * why in the footer, above the button, until the draft changes — never only in a toast, which covered that
 * footer for three seconds and was never announced (2.18.0 review round 4). A part over what the person may
 * receive names its «máximo» to a screen reader (aria-describedby).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { PAYMENT_METHODS, feePaymentsApi } from "../lib/conference";
import { DateField } from "../lib/DateField";
import { paymentMethodLabel } from "../lib/labels";
import { LAYER, revealFocused } from "../lib/overlay";
import { MAX_PARTS, centsToInput, parseMoneyInput, splitEqual, tidyMoneyInput, toCents } from "../lib/feeSplit";
import { buildFeeBody, checkDraft, chosenPersonLine, draftIsDirty, expectedOf, feeErrorText, localDay, manualOnSwitch, maxPaidOn, newClientKey, partAfterKind, proofRequired, RELOAD_CODES, sumMismatchText } from "../lib/feePayments";
import type { FeeDraft } from "../lib/feePayments";
import { personBalance } from "../lib/feePayments";
import { rawFieldValue } from "../lib/roster";
import { Overlay } from "./Overlay";
import { ProofPicker, forgetProof } from "./ProofViewer";
import { PersonPicker } from "./PersonPicker";
import type { PersonOption } from "./PersonPicker";
import { SegmentedControl, SumState, factsOf, money } from "./FeeBits";
import { useTx } from "./MealScanner";
import { useFieldErrors, FieldError } from "../lib/useFieldErrors";

const LAST_METHOD_KEY = 'cm:fees:lastMethod';
const readLastMethod = (methods: string[]) => {
    try { const v = localStorage.getItem(LAST_METHOD_KEY); if (v && methods.includes(v)) return v; } catch { /* blocked */ }
    return methods.includes('Efectivo') ? 'Efectivo' : methods[0] || '';
};
const writeLastMethod = (m: string) => { try { localStorage.setItem(LAST_METHOD_KEY, m); } catch { /* blocked */ } };

/**
 * The payment sheets' view of every person: name, location, family group and money (cents). `balances`
 * (GET /fee-payments people, by id) wins over the roster row's own figures when given.
 */
export function buildPersonOptions(rows: any[], nameOf: (p: any) => string, locations: { id: number; name: string }[], balances?: Map<number, any>): PersonOption[] {
    const locName = new Map((locations || []).map((l) => [Number(l.id), l.name]));
    return (rows || []).map((p) => {
        const b = balances && balances.get(Number(p.id)) ? balances.get(Number(p.id)) : personBalance(p);
        const lid = p.location_id == null || p.location_id === '' ? null : Number(p.location_id);
        return {
            id: Number(p.id), name: nameOf(p), locationId: lid, locationName: lid != null ? (locName.get(lid) || p.location || '') : (p.location || ''),
            family: String(rawFieldValue(p, 'family_group') || ''), cancelled: !!b.cancelled,
            dueC: b.due, validatedC: b.validated, pendingC: b.pending, toCoverC: b.toCover,
        };
    });
}

/** The first draft of the sheet for its mode. */
export function initialDraft({ mode, ids, transfer, options, methods }: { mode: 'create' | 'edit' | 'duplicate'; ids?: number[]; transfer?: any; options: PersonOption[]; methods: string[] }): FeeDraft {
    if (transfer && (mode === 'edit' || mode === 'duplicate')) {
        const people = (transfer.allocations || []).map((a) => Number(a.inscription_id));
        const manual: Record<number, string> = {};
        for (const a of transfer.allocations || []) manual[Number(a.inscription_id)] = centsToInput(toCents(a.amount));
        const totalC = toCents(transfer.amount);
        const eq = splitEqual(totalC, people.length);
        const isEqual = (transfer.allocations || []).every((a, i) => toCents(a.amount) === eq[i]);
        return {
            people, amount: centsToInput(totalC), method: methods.includes(transfer.method) ? transfer.method : readLastMethod(methods),
            paidOn: mode === 'edit' && transfer.paid_on ? String(transfer.paid_on).slice(0, 10) : (mode === 'duplicate' && transfer.paid_on ? String(transfer.paid_on).slice(0, 10) : localDay()),
            reference: transfer.reference || '', note: transfer.note || '', mode: isEqual ? 'equal' : 'manual', manual,
            // A split of the payment's own that is not «Iguales» is what «Manual» gives back after a look at «Iguales».
            manualTyped: !isEqual,
            proof: undefined, keepsProof: mode === 'edit' && !!transfer.has_proof,
            copyProofFrom: mode === 'duplicate' && transfer.has_proof ? Number(transfer.id) : null,
            // «Duplicar» names the voided payment it records again, with or without its receipt: the server keeps
            // one receipt counting in ONE payment (409 source_used for a second copy).
            duplicateOf: mode === 'duplicate' ? Number(transfer.id) : null,
            leavePending: false, clientKey: newClientKey(),
        };
    }
    const chosen = (ids || []).filter((id) => options.some((o) => o.id === id && !o.cancelled)).slice(0, MAX_PARTS);
    const owed = chosen.reduce((s, id) => s + (options.find((o) => o.id === id)?.toCoverC || 0), 0);
    return {
        people: chosen, amount: owed > 0 ? centsToInput(owed) : '', method: readLastMethod(methods), paidOn: localDay(),
        reference: '', note: '', mode: 'equal', manual: {}, proof: null, keepsProof: false, copyProofFrom: null, duplicateOf: null,
        leavePending: false, clientKey: newClientKey(),
    };
}

const ISSUE_TEXT: Record<string, [string, string]> = {
    empty: ['fees.error.empty', 'Selecciona al menos una persona.'],
    too_many: ['fees.error.too_many', 'Máximo 200 personas por pago.'],
    invalid_amount: ['fees.error.invalid_amount', 'El monto debe ser mayor que cero.'],
    no_method: ['fees.issue.method', 'Elige la forma de pago.'],
    invalid_date: ['fees.error.invalid_date', 'Fecha del pago inválida.'],
    future_date: ['fees.error.future_date', 'La fecha del pago no puede ser futura.'],
    non_positive: ['fees.error.non_positive', 'Cada parte del reparto debe ser mayor que cero.'],
    sum_mismatch: ['fees.error.sum_mismatch', 'El reparto no suma el monto del pago.'],
    over_cap: ['fees.error.over_cap', 'El pago supera lo que falta por pagar de alguna persona.'],
    cancelled_people: ['fees.error.cancelled_people', 'Una inscripción cancelada no puede recibir pagos.'],
    proof_required: ['fees.error.proof_required', 'El comprobante es obligatorio para una transferencia.'],
    proof_working: ['fees.issue.proof.working', 'Espera: la foto del comprobante se está preparando.'],
};

const inputCls = 'w-full min-h-[44px] border-2 border-gray-100 rounded-xl px-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none text-base text-gray-900 font-medium';
const labelCls = 'block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 mb-1';
const section = 'space-y-3';
const sectionTitle = 'text-[11px] font-black uppercase tracking-widest text-gray-500';

/**
 * Props: `mode` ('create' | 'edit' | 'duplicate'), `conferenceId`, `options` (buildPersonOptions),
 * `locations`, `ids` (create: the people chosen beforehand), `transfer` (edit / duplicate: the payment's
 * detail from GET /fee-payments/:id), `methods`, `layer`, `onClose`, `onSaved({ id, transfer, ids })`,
 * `onStale()` (the people's money changed on the server: reload it), `confirm(message, label)`, `notify(message,
 * type)` in place of the toast for the result of a send.
 */
export function RegisterPaymentSheet({ mode = 'create', conferenceId, options, locations = [], ids = [], transfer = null, methods = PAYMENT_METHODS as any, layer = LAYER.modal, onClose, onSaved, onStale, confirm, notify = null }: any) {
    const tx = useTx();
    const fe = useFieldErrors();
    const { addToast: toast } = useToast();
    // What a send did, once the sheet has closed: the desktop review queue says it above its list (`notify`) —
    // a toast at the bottom right covers the queue's decision bar.
    const addToast = notify || toast;
    const methodList = (methods && methods.length ? [...methods] : [...PAYMENT_METHODS]) as string[];
    const [draft, setDraft] = useState<FeeDraft>(() => initialDraft({ mode, ids, transfer, options, methods: methodList }));
    // The draft as the sheet opened: Escape (or the backdrop) asks before throwing changes away.
    const startDraft = useRef<FeeDraft>(draft).current;
    const [picking, setPicking] = useState(mode === 'create' && !(ids || []).length);
    const [showNote, setShowNote] = useState(!!draft.note);
    const [busy, setBusy] = useState(false);
    const [touched, setTouched] = useState(false);
    // The last send's failure, said in the footer until the draft changes (as the portal's sheet does).
    const [sendError, setSendError] = useState('');
    const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
    // Edit: what each person ALREADY in this payment may receive = due − validated − pending of their OTHER payments.
    const editCap = useMemo(() => {
        const m = new Map<number, number>();
        if (mode === 'edit' && transfer) {
            for (const a of transfer.allocations || []) {
                m.set(Number(a.inscription_id), Math.max(0, toCents(a.due) - toCents(a.validated_other) - toCents(a.pending_other)));
            }
        }
        return m;
    }, [mode, transfer]);
    const capOf = (id: number) => (editCap.has(id) ? editCap.get(id) : byId.has(id) ? byId.get(id).toCoverC : null);
    // A person's money awaiting validation in OTHER payments (an edited payment's own parts left out).
    const editPending = useMemo(() => {
        const m = new Map<number, number>();
        if (mode === 'edit' && transfer) for (const a of transfer.allocations || []) m.set(Number(a.inscription_id), Math.max(0, toCents(a.pending_other)));
        return m;
    }, [mode, transfer]);
    const pendingOf = (id: number) => (editPending.has(id) ? editPending.get(id) : (byId.get(id)?.pendingC || 0));
    const check = useMemo(() => checkDraft(draft, { capOf, cancelled: (id) => !!byId.get(id)?.cancelled, methods: methodList }), [draft, byId, editCap]);
    const set = (patch: Partial<FeeDraft>) => setDraft((d) => ({ ...d, ...patch }));
    // Any change to the draft ends the last send's message: the footer says again what the button waits for.
    const firstDraft = useRef(true);
    useEffect(() => { if (firstDraft.current) { firstDraft.current = false; return; } setSendError(''); }, [draft]);
    const titleId = 'fee-register-title';
    // D-P3: a payment a location's portal recorded only ever holds that location's people (the server refuses
    // anyone else, 400 unknown_people) — the picker offers only them.
    const lockLocationId = mode === 'edit' && transfer && transfer.recorded_via === 'portal' && transfer.location_id != null ? Number(transfer.location_id) : null;

    const chosen = draft.people.map((id) => byId.get(id)).filter(Boolean);
    const locs = new Set(chosen.map((o) => (o.locationId == null ? 'none' : String(o.locationId))));
    const owedC = chosen.reduce((s, o) => s + (capOf(o.id) || 0), 0);
    const totalC = check.totalC ?? 0;
    const isTransfer = proofRequired(draft.method);

    const addPeople = (add: number[]) => setDraft((d) => {
        const people = [...d.people];
        for (const id of add) if (!people.includes(id) && people.length < MAX_PARTS) people.push(id);
        // The total follows what is owed while the admin has not typed one of their own.
        const auto = d.amount === '' || parseMoneyInput(d.amount) === d.people.reduce((s, id) => s + (capOf(id) || 0), 0);
        const owed = people.reduce((s, id) => s + (capOf(id) || 0), 0);
        const manual = { ...d.manual };
        for (const id of add) if (manual[id] === undefined) manual[id] = centsToInput(capOf(id) || 0);
        return { ...d, people, manual, amount: auto && owed > 0 ? centsToInput(owed) : d.amount };
    });
    const removePerson = (id: number) => setDraft((d) => {
        const people = d.people.filter((x) => x !== id);
        const auto = parseMoneyInput(d.amount) === d.people.reduce((s, x) => s + (capOf(x) || 0), 0);
        const owed = people.reduce((s, x) => s + (capOf(x) || 0), 0);
        const manual = { ...d.manual }; delete manual[id];
        return { ...d, people, manual, amount: auto ? (owed > 0 ? centsToInput(owed) : '') : d.amount };
    });
    // Typing in a part switches to «Manual», starting from the parts shown.
    const typePart = (id: number, text: string) => setDraft((d) => {
        if (d.mode === 'manual') return { ...d, manual: { ...d.manual, [id]: text }, manualTyped: true };
        const eq = splitEqual(parseMoneyInput(d.amount) ?? 0, d.people.length);
        const manual: Record<number, string> = {};
        d.people.forEach((pid, i) => { manual[pid] = centsToInput(eq[i] || 0); });
        manual[id] = text;
        return { ...d, mode: 'manual', manual, manualTyped: true };
    });
    // «Manual» gives back the amounts typed before a look at «Iguales» (the strip's arrow keys go Manual → Iguales →
    // Manual in two keystrokes: 2.18.0 review UX6-6); without any, it starts from what each person owes when the
    // total is that sum (as in the portal), else from «Iguales» (lib/feePayments.ts manualOnSwitch).
    const setMode = (m: string) => setDraft((d) => {
        if (m === d.mode) return d;
        if (m === 'manual') return { ...d, mode: 'manual', manual: manualOnSwitch(d, parseMoneyInput(d.amount) ?? 0, capOf) };
        return { ...d, mode: 'equal' };
    });

    const submit = async (allowDuplicateReference = false) => {
        setTouched(true);
        if (!check.ok || busy) return;
        setBusy(true);
        setSendError('');
        try {
            let res: any;
            if (mode === 'edit') {
                res = await feePaymentsApi.update(transfer.id, buildFeeBody(draft, check, { allowDuplicateReference, expected: expectedOf(transfer) }));
                forgetProof(transfer.id);
                addToast(tx('fees.done.edited', 'Pago corregido — queda por validar.'), 'success');
            } else {
                res = await feePaymentsApi.create(buildFeeBody(draft, check, { conferenceId, allowDuplicateReference }));
                writeLastMethod(draft.method);
                const st = res?.transfer?.status;
                addToast(st === 'validated' ? tx('fees.done.created.validated', 'Pago registrado y validado.') : tx('fees.done.created.pending', 'Pago registrado — queda por validar.'), 'success');
            }
            const before = mode === 'edit' ? (transfer.allocations || []).map((a) => Number(a.inscription_id)) : [];
            onSaved && onSaved({ id: res?.id ?? transfer?.id, transfer: res?.transfer || null, ids: [...new Set([...before, ...draft.people])] });
        } catch (e: any) {
            if (e?.code === 'duplicate_reference' && !allowDuplicateReference) {
                setBusy(false);
                const go = confirm ? await confirm(tx('fees.confirm.duplicate.reference', 'Esa referencia ya se usó en otro pago. ¿Registrar de todas formas?'), tx('fees.action.register.anyway', 'Registrar de todas formas'), false) : false;
                if (go) return submit(true);
                return;
            }
            setSendError(feeErrorText(e, tx));
            if (e && RELOAD_CODES.has(e.code) && onStale) onStale();
        } finally {
            setBusy(false);
        }
    };

    const firstIssue = check.issues[0];
    const diff = check.split.diff;
    // A part turning over its «máximo» while it is typed into: its line under the field becomes the red reason,
    // and the overlay revealed the field only when it was focused — bring the field AND that line into sight again
    // (lib/overlay.ts revealFocused → describedBox), clear of the pinned footer (2.18.0 review PUX-1).
    const overKey = check.overCap.map((x) => x.inscription_id).join(',');
    useEffect(() => {
        if (typeof document === 'undefined') return;
        revealFocused(document, typeof window !== 'undefined' ? (window as any) : null, (el) => /^fee-part-\d+$/.test(String(el.id || '')));
    }, [overKey]);
    // The same for «Monto total»: «Usar lo que falta», the line that describes it, appears only once the typed total
    // differs from what is owed — after the field was focused and revealed. On a phone held sideways it appeared
    // under the pinned footer while the amount was typed (2.18.0 review UX6-2): reveal the field with it again.
    const useOwedShown = owedC > 0 && totalC !== owedC;
    useEffect(() => {
        if (typeof document === 'undefined') return;
        revealFocused(document, typeof window !== 'undefined' ? (window as any) : null, (el) => el.id === 'fee-amount');
    }, [useOwedShown]);
    // Escape: closes an untouched sheet; with changes (people, a split, a receipt…) it asks first — one key
    // must never throw away a compressed receipt and a typed split (2.18.0 review). «Cancelar» / ✕ close.
    const escapeClose = async () => {
        if (busy) return;
        if (!draftIsDirty(startDraft, draft) || !confirm) { onClose(); return; }
        if (await confirm(tx('fees.register.discard.confirm', '¿Descartar este pago? Se pierden las personas, el reparto y el comprobante.'), tx('fees.register.discard', 'Descartar'), true)) onClose();
    };
    return (
        <Overlay layer={layer} onEscape={escapeClose}>
            <form role="dialog" aria-modal="true" aria-labelledby={titleId} data-register-sheet={mode}
                {...fe.form((e) => { e.preventDefault(); submit(false); })}
                className="bg-white rounded-[32px] shadow-2xl w-full max-w-2xl border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="bg-gray-50/50 px-5 sm:px-8 py-5 border-b border-gray-100 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h3 id={titleId} className="font-black text-xl sm:text-2xl text-gray-900 italic tracking-tighter">
                            {mode === 'edit' ? tx('fees.register.edit', 'Corregir pago #{id}', { id: transfer?.id }) : mode === 'duplicate' ? tx('fees.register.duplicate', 'Duplicar pago #{id}', { id: transfer?.id }) : tx('fees.register', 'Registrar pago')}
                        </h3>
                        {mode === 'duplicate' && draft.copyProofFrom && <p className="text-xs font-bold text-gray-500 mt-1">{tx('fees.register.duplicate.hint', 'Se usa el mismo comprobante.')}</p>}
                    </div>
                    <button type="button" onClick={onClose} disabled={busy} aria-label={tx('close', 'Cerrar')} className="shrink-0 w-11 h-11 flex items-center justify-center rounded-2xl text-gray-500 hover:bg-gray-100 disabled:opacity-40">
                        <i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i>
                    </button>
                </div>

                <div className="px-5 sm:px-8 py-5 space-y-7">
                    {/* What was asked to be corrected, while correcting it (the payment sheet that showed it is closed). */}
                    {mode === 'edit' && transfer?.status === 'returned' && transfer?.review_note && (
                        <div className="rounded-2xl bg-orange-50 text-orange-900 px-4 py-3 text-sm font-bold" data-return-note="">
                            <span className="block text-[10px] font-black uppercase tracking-widest opacity-80">{tx('fees.note.returned', 'Motivo de la devolución')}</span>
                            {transfer.review_note}
                        </div>
                    )}
                    {/* 1. People */}
                    <section className={section} data-register-people="">
                        <div className="flex items-center justify-between gap-2">
                            <h4 className={sectionTitle}>{tx('fees.register.people', 'Personas ({n})', { n: draft.people.length })}</h4>
                            {!picking && <button type="button" onClick={() => setPicking(true)} className="min-h-[44px] px-3 rounded-xl text-xs font-black uppercase tracking-widest text-blue-700 hover:bg-blue-50"><i className="fa-solid fa-plus mr-1" aria-hidden="true"></i>{tx('fees.register.add', 'Añadir')}</button>}
                        </div>
                        {chosen.length > 0 && (
                            <ul className="space-y-1.5">
                                {chosen.map((o) => (
                                    <li key={o.id} className="flex items-center gap-2 rounded-xl border border-gray-100 bg-gray-50/60 pl-3" data-chosen={o.id}>
                                        <span className="min-w-0 flex-1 py-2">
                                            <span className="block text-sm font-black text-gray-900 break-words">{o.name}</span>
                                            {/* «debe $X · Norte»: the location is a fact of its own, its «·» leading (UX6-3 twin). */}
                                            <span className="flex flex-wrap gap-x-1 text-[11px] font-bold text-gray-500" data-chosen-facts="">
                                                {factsOf([(() => { const l = chosenPersonLine(capOf(o.id) || 0, pendingOf(o.id)); return tx(l.key, l.fallback, { left: money(l.vars.left), pending: money(l.vars.pending || 0) }); })(),
                                                    locs.size > 1 ? (o.locationName || tx('no.location', 'Sin localidad')) : null], null, { long: true })}
                                            </span>
                                        </span>
                                        <button type="button" onClick={() => removePerson(o.id)} aria-label={tx('fees.register.remove.person', 'Quitar a {name}', { name: o.name })}
                                            className="shrink-0 w-11 h-11 flex items-center justify-center rounded-xl text-gray-500 hover:text-rose-700 hover:bg-rose-50"><i className="fa-solid fa-xmark" aria-hidden="true"></i></button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {locs.size > 1 && <p className="text-xs font-bold text-indigo-800 bg-indigo-50 rounded-xl px-3 py-2" data-mixed-notice=""><i className="fa-solid fa-circle-info mr-1.5" aria-hidden="true"></i>{tx('fees.register.mixed', 'Incluye {n} localidades: cada encargado verá solo su parte.', { n: locs.size })}</p>}
                        {picking && <PersonPicker options={options} chosen={draft.people} locations={locations} onAdd={addPeople} onDone={() => setPicking(false)} lockLocationId={lockLocationId} />}
                    </section>

                    {/* 2. Payment */}
                    <section className={section}>
                        <h4 className={sectionTitle}>{tx('fees.register.payment', 'Pago')}</h4>
                        <div>
                            <label htmlFor="fee-amount" className={labelCls}>{tx('fees.register.amount', 'Monto total')}</label>
                            <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-black text-lg" aria-hidden="true">$</span>
                                {/* «Usar lo que falta» describes the field: a focused «Monto total» is revealed with it (describedBox). */}
                                <input id="fee-amount" inputMode="decimal" autoComplete="off" value={draft.amount} onChange={(e) => set({ amount: e.target.value })}
                                    aria-describedby={useOwedShown ? 'fee-use-owed' : undefined}
                                    onBlur={() => { const tidy = tidyMoneyInput(draft.amount); if (tidy !== draft.amount) set({ amount: tidy }); }}
                                    className="w-full min-h-[52px] border-2 border-gray-100 rounded-xl pl-8 pr-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none text-xl font-black text-gray-900 tabular-nums" />
                            </div>
                            {useOwedShown && <button type="button" id="fee-use-owed" onClick={() => set({ amount: centsToInput(owedC) })} className="mt-1 inline-flex items-center text-[11px] font-black text-blue-700 underline min-h-[44px]" data-use-owed="">{tx('fees.register.use.owed', 'Usar lo que falta: {amount}', { amount: money(owedC) })}</button>}
                        </div>
                        <div>
                            <span className={labelCls}>{tx('payment.method', 'Forma de pago')}</span>
                            <SegmentedControl variant="radio" label={tx('payment.method', 'Forma de pago')} value={draft.method} onChange={(m) => set({ method: m })}
                                options={methodList.map((m) => ({ key: m, label: paymentMethodLabel(tx, m) }))} />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label htmlFor="fee-date" className={labelCls}>{tx('fees.register.date', 'Fecha del pago')}</label>
                                <DateField id="fee-date" value={draft.paidOn} max={maxPaidOn()} clearable={false} onChange={(v) => set({ paidOn: v })} dataField="fee_date" />
                                <FieldError message={fe.error('fee_date')} id={fe.errorId('fee_date')} />
                            </div>
                            {(isTransfer || draft.reference) && (
                                <div>
                                    {/* The portal's words: «Referencia de la transferencia» / «Referencia (opcional)». */}
                                    <label htmlFor="fee-ref" className={labelCls}>{isTransfer ? tx('fees.register.reference.transfer', 'Referencia de la transferencia') : tx('fees.register.reference.optional', 'Referencia (opcional)')}</label>
                                    <input id="fee-ref" value={draft.reference} maxLength={100} onChange={(e) => set({ reference: e.target.value })} className={inputCls} autoComplete="off" />
                                </div>
                            )}
                        </div>
                        {showNote ? (
                            <div>
                                <label htmlFor="fee-note" className={labelCls}>{tx('fees.register.note', 'Nota')}</label>
                                <textarea id="fee-note" rows={2} maxLength={500} value={draft.note} onChange={(e) => set({ note: e.target.value })} className={`${inputCls} py-2 resize-none`} />
                            </div>
                        ) : (
                            <button type="button" onClick={() => setShowNote(true)} className="min-h-[44px] text-xs font-black uppercase tracking-widest text-blue-700"><i className="fa-solid fa-plus mr-1" aria-hidden="true"></i>{tx('fees.register.add.note', 'Añadir nota')}</button>
                        )}
                    </section>

                    {/* 3. Split */}
                    {draft.people.length > 0 && (
                        <section className={section} data-register-split="">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h4 className={sectionTitle}>{tx('fees.split', 'Reparto')}</h4>
                                <SegmentedControl variant="radio" label={tx('fees.split', 'Reparto')} value={draft.mode} onChange={setMode}
                                    options={[{ key: 'equal', label: tx('fees.split.equal', 'Iguales') }, { key: 'manual', label: tx('fees.split.manual', 'Manual') }]} />
                            </div>
                            <ul className="space-y-2">
                                {check.parts.map((p, i) => {
                                    const o = byId.get(p.inscription_id);
                                    const cap = capOf(p.inscription_id);
                                    const over = check.overCap.find((x) => x.inscription_id === p.inscription_id);
                                    const shownText = draft.mode === 'manual' ? (draft.manual[p.inscription_id] ?? '') : centsToInput(p.cents || 0);
                                    const left = cap != null && p.cents != null ? cap - p.cents : null;
                                    const after = partAfterKind(cap, p.cents, { bornValidated: mode !== 'edit' && !draft.leavePending, otherPendingC: pendingOf(p.inscription_id) });
                                    return (
                                        <li key={p.inscription_id} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-split-row={p.inscription_id}>
                                            <label htmlFor={`fee-part-${p.inscription_id}`} className="min-w-0 flex-1 text-sm font-bold text-gray-900 break-words">{o ? o.name : `#${p.inscription_id}`}</label>
                                            <div className="relative w-40 shrink-0" data-part-box="">
                                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-black" aria-hidden="true">$</span>
                                                <input id={`fee-part-${p.inscription_id}`} inputMode="decimal" autoComplete="off" value={shownText} onChange={(e) => typePart(p.inscription_id, e.target.value)}
                                                    onBlur={() => { if (draft.mode !== 'manual') return; const tidy = tidyMoneyInput(shownText); if (tidy !== shownText) typePart(p.inscription_id, tidy); }}
                                                    aria-invalid={over || p.cents == null || p.cents <= 0 ? 'true' : 'false'} aria-describedby={`fee-part-after-${p.inscription_id}`}
                                                    className={`w-full min-h-[44px] border-2 rounded-xl pl-7 pr-2 bg-white outline-none text-base font-black text-right tabular-nums ${over || (touched && (p.cents == null || p.cents <= 0)) ? 'border-rose-400' : 'border-gray-100 focus:border-blue-500'}`} />
                                            </div>
                                            <span id={`fee-part-after-${p.inscription_id}`} className={`basis-full text-[11px] font-bold ${over ? 'text-rose-700' : 'text-gray-500'}`} data-part-after="">
                                                {over ? tx('fees.part.over.max', 'Supera lo que falta: máximo {amount}', { amount: money(over.max) })
                                                    : after === 'left' ? tx('fees.part.left', 'Faltará {amount}', { amount: money(left) })
                                                    : after === 'paid' ? tx('fees.after.paid', 'Queda pagado')
                                                    : after === 'paid_after_pending' ? tx('fees.after.paid.after.pending', 'Queda pagado al validarse lo pendiente')
                                                    : after === 'paid_when' ? tx('fees.after.paid.when', 'Queda pagado al validarse') : ''}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                            {/* «✓ Cuadra» only when the whole split can go: a sum that adds up beside a part refused in red read
                                as a success and a failure at once (2.18.0 skeptic round 6). */}
                            <SumState assignedC={check.split.assigned} totalC={totalC} invalid={diff !== 0 ? '' : !check.split.ok ? tx('fees.error.non_positive', 'Cada parte del reparto debe ser mayor que cero.') : check.overCap.length ? tx('fees.split.over.cap', 'Una parte supera lo que falta') : ''} />
                            {draft.mode === 'equal' && check.overCap.length > 0 && !draft.manualTyped && <p className="text-xs font-bold text-gray-600">{tx('fees.split.use.manual', 'Cambia a «Manual» para repartir según lo que debe cada uno.')}</p>}
                        </section>
                    )}

                    {/* 4. Receipt */}
                    <section className={section}>
                        <h4 className={sectionTitle}>{tx('fees.proof', 'Comprobante')}{isTransfer ? ' *' : ''}</h4>
                        {draft.copyProofFrom && draft.proof === undefined ? (
                            <p className="text-sm font-bold text-gray-700 rounded-2xl border border-gray-100 bg-gray-50 p-3"><i className="fa-solid fa-paperclip mr-1.5" aria-hidden="true"></i>{tx('fees.proof.copied', 'Se usa el comprobante del pago #{id}.', { id: draft.copyProofFrom })}</p>
                        ) : (
                            <ProofPicker value={draft.proof} onChange={(v) => set({ proof: v })} onBusy={(b) => set({ proofWorking: b })} required={isTransfer} existingId={mode === 'edit' && transfer?.has_proof ? transfer.id : null} />
                        )}
                    </section>

                    {/* 5. Leave pending (admin payments are born validated) */}
                    {mode !== 'edit' && (
                        <label className="flex items-start gap-3 rounded-2xl border-2 border-gray-100 px-4 py-3 cursor-pointer min-h-[44px]" data-leave-pending="">
                            <input type="checkbox" checked={draft.leavePending} onChange={(e) => set({ leavePending: e.target.checked })} className="w-5 h-5 mt-0.5 accent-blue-600 shrink-0" />
                            <span>
                                <span className="block text-sm font-black text-gray-900">{tx('fees.register.leave.pending', 'Dejar por validar')}</span>
                                <span className="block text-[11px] font-bold text-gray-500">{tx('fees.register.leave.pending.hint', 'Sin marcar, el pago queda validado al registrarlo.')}</span>
                            </span>
                        </label>
                    )}
                    {mode === 'edit' && <p className="text-xs font-bold text-gray-600"><i className="fa-solid fa-circle-info mr-1.5" aria-hidden="true"></i>{tx('fees.register.edit.hint', 'Al guardar, el pago vuelve a quedar por validar.')}</p>}
                </div>

                {/* ONE row on a phone (OVERLAY_CSS data-cm-foot-grid): «Cancelar» at its width, the main button takes the
                    rest and wraps its own label — two wrapped rows (133 px) covered the focused «Monto total». */}
                <div className="px-5 sm:px-8 py-4 border-t border-gray-100 bg-white flex flex-wrap items-center justify-end gap-3" data-cm-sheet-foot="" data-cm-foot-grid="">
                    {/* A failed send first (role=alert: said at once), then why the button is still disabled — the first
                        thing left to fix, always in words. */}
                    {sendError && (
                        <p className="basis-full text-xs font-bold text-rose-700" role="alert" data-register-send-error="" data-foot-issue="">
                            <i className="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden="true"></i>{sendError}
                        </p>
                    )}
                    {!sendError && firstIssue && (
                        <p className={`basis-full text-xs font-bold ${touched || firstIssue === 'over_cap' ? 'text-rose-700' : 'text-gray-600'}`} role="status" data-register-issue={firstIssue} data-foot-issue="">
                            <i className="fa-solid fa-circle-info mr-1.5" aria-hidden="true"></i>{firstIssue === 'sum_mismatch'
                                ? (() => { const m = sumMismatchText(diff); return tx(m.key, m.fallback, { amount: money(m.cents) }); })()
                                : tx(ISSUE_TEXT[firstIssue][0], ISSUE_TEXT[firstIssue][1])}
                        </p>
                    )}
                    <button type="button" onClick={onClose} disabled={busy} className="min-h-[44px] px-5 rounded-2xl text-gray-600 font-bold hover:bg-gray-100 disabled:opacity-40">{tx('cancel', 'Cancelar')}</button>
                    <button type="submit" disabled={busy || !check.ok} data-register-submit="" data-foot-main=""
                        className="min-h-[44px] px-6 py-2 rounded-2xl bg-emerald-600 text-white font-black text-[11px] uppercase tracking-widest shadow-lg shadow-emerald-500/30 hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-2">
                        <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-check'}`} aria-hidden="true"></i>
                        {/* No «$0,00» on an empty sheet (the portal hides it too). */}
                        {mode === 'edit'
                            ? (totalC > 0 ? tx('fees.register.save', 'Guardar {amount}', { amount: money(totalC) }) : tx('save', 'Guardar'))
                            : (totalC > 0 ? tx('fees.register.submit', 'Registrar pago {amount}', { amount: money(totalC) }) : tx('fees.register', 'Registrar pago'))}
                    </button>
                </div>
            </form>
        </Overlay>
    );
}

export default RegisterPaymentSheet;

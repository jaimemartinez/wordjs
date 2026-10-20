// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Pagos de cuotas» in the coordinator portal (conference-manager ≥ 2.18.0, payments-design section 1).
 *
 * - `useFeeHub` (one per dashboard, in page.tsx): the section's data and its sheets. The view is loaded
 *   with ONE `GET /portal/fee-payments` — when the tab mounts, or when «Registrar pago de esta persona» is
 *   tapped in a participant's sheet — and every write answers with the whole view, which also patches the
 *   Participantes rows (page.tsx `onView` → mergeBalances) and the tab's badge. No polling: the plugin caps
 *   a location's authenticated requests in flight (the login throttle).
 * - `FeePaymentsTab`: «Resumen» (the location's figures and «Saldos por persona» with the multi-select)
 *   and «Pagos» (every payment, the returned ones first).
 * - `FeeSheets`: the payment sheets and their confirms, rendered once by the page so both tabs can open
 *   them (a participant's sheet stays underneath, layer 1).
 * The draft of a new payment survives closing and reopening the sheet (it is kept in memory, never in
 * storage: it can hold a receipt photo) — for other people too: their receipt, reference, method and date stay
 * (reopenDraft). So does a CORRECTION («Editar», «Corregir y reenviar», «Registrar de nuevo») closed with
 * changes: reopened for the same payment, as it was left — said so, with «Empezar de cero» (keepCorrection /
 * recoverCorrection). Escape in a filled field of the sheet is the field's (ui.tsx Modal).
 *
 * What the hub has to say goes where the coordinator is looking (noticeTarget): into the sheet that is open — a
 * payment sheet or the participant's sheet (`sheetOpen`) — never as a toast over that sheet's footer («Enviar
 * pago», «Eliminar»); the toast only when no sheet is open. «Registrar pago» opened for people of whom some
 * cannot be paid says so at the top of the sheet (registerNotice).
 *
 * A shared phone: everything the hub loads or sends belongs to ONE session (createFeeSession). Sign-out and
 * sign-in end it (`reset`): an answer that arrives afterwards is dropped, the load in flight and the receipts
 * downloading are forgotten — the next coordinator never sees the previous one's payments.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    LAST_METHOD_KEY, noticeTarget, createFeeSession, createPortalFeeApi, correctionKey, createProofCache, draftFromTransfer, feeErrorAction, keepCorrection, money, newClientKey, recoverCorrection, registerLoadNotice, registerNeedsLoad, registerTargets, reopenDraft,
    sendDraft, summarize, viewBalanceC, type BalanceC, type HubNotice, type DraftContext, type FeeDraft, type LoadOutcome, type PortalFeeApi, type PortalFeeView, type PortalTransfer,
} from "./feePayments";
import { type FamilyGroup } from "./participants";
import FeeSummary from "./FeeSummary";
import FeeBalances from "./FeeBalances";
import FeeTransfers from "./FeeTransfers";
import RegisterPaymentSheet from "./RegisterPaymentSheet";
import TransferSheet from "./TransferSheet";
import { Button, Card, CardHeader, Modal, Notice, SegmentedControl, Spinner } from "./ui";

type HeaderMap = Record<string, string>;
type ToastType = "success" | "error" | "info" | "warning";

export type FeeSegment = "summary" | "transfers";
export type FeeSheet = { kind: "register" } | { kind: "transfer"; id: number } | null;

export type FeeHubOptions = {
    authHeaders: (extra?: HeaderMap) => HeaderMap;
    /** Every fresh view (load or write): the page patches its rows and badge from it. */
    onView: (v: PortalFeeView) => void;
    onUnauthorized: () => void;
    notify: (message: string, type?: ToastType) => void;
    /** Is a sheet of the page open (the participant's)? Then a message goes into it, not into a toast over it. */
    sheetOpen?: () => boolean;
    /** Tests inject a fake API. */
    api?: PortalFeeApi;
};

const readLast = (): string | null => { try { return localStorage.getItem(LAST_METHOD_KEY); } catch { return null; } };
const writeLast = (m: string) => { try { localStorage.setItem(LAST_METHOD_KEY, m); } catch { /* private mode */ } };

/** The people of a view by id, in cents. */
export const balancesOf = (v: PortalFeeView | null): Map<number, BalanceC> => new Map((v?.people ?? []).map((b) => [b.id, viewBalanceC(b)]));
export const contextOf = (v: PortalFeeView | null, balances: ReadonlyMap<number, BalanceC>): DraftContext => ({
    balances,
    methods: v?.methods ?? [],
    proofRequiredFor: v?.proof.required_for ?? ["Transferencia"],
    maxPeople: v?.max_people,
});

/** The page's latest auth headers at CALL time (the token can change after the hub was created). */
const headersFrom = (ref: { current: Pick<FeeHubOptions, "authHeaders"> }) => (extra?: HeaderMap): HeaderMap => ref.current.authHeaders(extra);

const NO_ERRORS = { message: null as string | null, people: {} as Record<number, string> };

const NOTICE_TONE: Record<ToastType, HubNotice["tone"]> = { success: "emerald", error: "rose", warning: "amber", info: "blue" };

export function useFeeHub(opts: FeeHubOptions) {
    const optsRef = useRef(opts);
    useEffect(() => { optsRef.current = opts; });
    // The ref is read when a request is made (in effects and handlers), never while rendering.
    // eslint-disable-next-line react-hooks/refs
    const api = useMemo<PortalFeeApi>(() => opts.api ?? createPortalFeeApi(headersFrom(optsRef)), [opts.api]);
    const proofs = useMemo(() => createProofCache(api), [api]);
    const session = useMemo(() => createFeeSession(api, () => proofs.clear()), [api, proofs]);
    const [view, setView] = useState<PortalFeeView | null>(null);
    const viewRef = useRef<PortalFeeView | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sheet, setSheetState] = useState<FeeSheet>(null);
    // The sheet open NOW (read by `say` in the same tick a sheet opens or closes).
    const sheetRef = useRef<FeeSheet>(null);
    const [notice, setNotice] = useState<HubNotice | null>(null);
    const [registerNotice, setRegisterNotice] = useState<string | null>(null);
    /** Open / close a payment sheet: the last sheet's message goes with it. */
    const setSheet = useCallback((s: FeeSheet) => { sheetRef.current = s; setSheetState(s); setNotice(null); }, []);
    /** Say something where the coordinator is looking: in the open sheet, else a toast (noticeTarget). */
    const say = useCallback((text: string, type: ToastType) => {
        const where = noticeTarget({ sheetOpen: sheetRef.current != null || !!optsRef.current.sheetOpen?.() });
        if (where === "sheet") setNotice((cur) => ({ text, tone: NOTICE_TONE[type], n: (cur?.n ?? 0) + 1 }));
        else optsRef.current.notify(text, type);
    }, []);
    const [draft, setDraftState] = useState<FeeDraft | null>(null);
    const keptNew = useRef<FeeDraft | null>(null);
    // Corrections closed with changes, by payment (keepCorrection), and the draft each sheet opened with.
    const keptCorrections = useRef(new Map<string, FeeDraft>());
    const openedWith = useRef<FeeDraft | null>(null);
    const [busy, setBusy] = useState(false);
    const [preparing, setPreparing] = useState(false);
    const [sheetErrors, setSheetErrors] = useState(NO_ERRORS);
    const [dupRef, setDupRef] = useState<{ message: string; otherId: number | null } | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<PortalTransfer | null>(null);
    const [selected, setSelected] = useState<number[]>([]);
    const [segment, setSegment] = useState<FeeSegment>("summary");
    const [personFilter, setPersonFilter] = useState<number | null>(null);
    const [lastSent, setLastSent] = useState<number | null>(null);

    const apply = useCallback((v: PortalFeeView) => {
        viewRef.current = v;
        setView(v);
        optsRef.current.onView(v);
    }, []);

    /** THE load: one request (a second call while it runs shares it); an answer of an ended session is dropped. */
    const loadOutcome = useCallback(async (): Promise<LoadOutcome> => {
        setLoading(true);
        setError(null);
        const o = await session.load();
        if (o.kind === "ended") return o;
        setLoading(false);
        if (o.kind === "ok") apply(o.view);
        else if (o.kind === "unauthorized") optsRef.current.onUnauthorized();
        else setError(o.message);
        return o;
    }, [session, apply]);
    const load = useCallback(async (): Promise<PortalFeeView | null> => {
        const o = await loadOutcome();
        return o.kind === "ok" ? o.view : null;
    }, [loadOutcome]);

    // Any change to the draft ends the last send's errors: the footer goes back to the LIVE reason «Enviar»
    // waits for, and the chips' server messages («Supera lo que falta…») go with the amounts they were about.
    const setDraft = useCallback((fn: (d: FeeDraft) => FeeDraft) => {
        setDraftState((d) => (d ? fn(d) : d));
        setSheetErrors(NO_ERRORS);
    }, []);

    const openRegister = useCallback(async (ids: number[]) => {
        const e = session.epoch();
        setPreparing(true);
        let v = viewRef.current;
        let loadNotice: string | null = null;
        if (registerNeedsLoad(v, ids)) {
            // «Registrar pago de esta persona» before the tab was ever opened, or for someone registered after
            // the view was loaded (no polling: it never re-reads itself): ONE load first. It may fail (a flaky
            // connection) — say so, the button alone just went back to normal.
            const o = await loadOutcome();
            if (o.kind === "ok") v = o.view;
            loadNotice = registerLoadNotice(o);
        }
        if (!session.isCurrent(e)) return;
        setPreparing(false);
        const balances = v ? balancesOf(v) : null;
        const { want, notice } = balances ? registerTargets(balances, ids) : { want: [] as number[], notice: null };
        // Asked for people of whom nobody can be paid (or nothing loaded): no sheet — never an empty one, nor
        // someone else's unsent draft (reopenDraft with nobody asked would hand it back). Said where they look.
        if (!v || !balances || (ids.length && !want.length)) {
            const why = loadNotice || notice;
            if (why) say(why, loadNotice ? "error" : "info");
            return;
        }
        const kept = keptNew.current;
        keptNew.current = null;
        setDraftState(reopenDraft(kept, want, v.methods, readLast(), balances));
        setSheetErrors(NO_ERRORS);
        setSheet({ kind: "register" });
        // Who was left out (or that the payments could not be reloaded), at the TOP of the sheet that opens —
        // a toast would sit over its «Enviar pago» while the coordinator reads the people.
        setRegisterNotice(loadNotice || notice);
    }, [loadOutcome, session, say, setSheet]);

    const openFromTransfer = useCallback((t: PortalTransfer, kind: "edit" | "duplicate") => {
        const v = viewRef.current;
        if (!v) return;
        const fresh = draftFromTransfer(t, kind, v.methods);
        openedWith.current = fresh;
        setDraftState(recoverCorrection(keptCorrections.current, fresh));
        setSheetErrors(NO_ERRORS);
        setRegisterNotice(null);
        setSheet({ kind: "register" });
    }, [setSheet]);
    /** «Empezar de cero» on a recovered correction: the payment as it is on the server. */
    const restartCorrection = useCallback(() => {
        const start = openedWith.current;
        // A fresh idempotency key: what was typed since is gone, and a «Registrar de nuevo» is a new send.
        if (start) setDraftState({ ...start, clientKey: newClientKey() });
        setSheetErrors(NO_ERRORS);
    }, []);

    const closeSheet = useCallback(() => {
        setDraftState((d) => {
            if (d && d.kind === "new") keptNew.current = d;
            else keepCorrection(keptCorrections.current, openedWith.current, d);
            return null;
        });
        setSheet(null);
        setRegisterNotice(null);
        setSheetErrors(NO_ERRORS);
    }, [setSheet]);

    const submit = useCallback(async (override?: Partial<FeeDraft>) => {
        const v = viewRef.current;
        if (!v || !draft) return;
        const d: FeeDraft = override ? { ...draft, ...override } : draft;
        if (override) setDraftState(d);
        setBusy(true);
        setSheetErrors(NO_ERRORS);
        const e = session.epoch();
        const out = await sendDraft(api, d, contextOf(v, balancesOf(v)));
        if (!session.isCurrent(e)) return;
        setBusy(false);
        switch (out.kind) {
            case "sent":
                // An edit may have replaced the receipt: none of its cached ones may show again.
                if (d.kind === "edit" && d.editId != null) proofs.forget(d.editId);
                apply(out.view);
                writeLast(d.method);
                keptNew.current = null;
                { const k = correctionKey(d); if (k) keptCorrections.current.delete(k); }
                setDraftState(null);
                setSheet(null);
                setRegisterNotice(null);
                // The sheet closed: said in the participant's sheet still open under it, else a toast.
                say(out.toast, "success");
                if (d.kind !== "edit") setSelected([]);
                setLastSent(out.id || null);
                break;
            case "invalid": break;   // the button was enabled on stale data: the sheet already lists why
            case "unauthorized": optsRef.current.onUnauthorized(); break;
            case "retry": setSheetErrors({ message: out.message, people: {} }); break;
            case "fix":
                setSheetErrors({ message: out.message, people: out.people });
                if (out.reload) void load();   // fresh balances, so the caps on screen are the server's
                break;
            case "confirm_reference": setDupRef({ message: out.message, otherId: out.otherId }); break;
            case "stale":
                { const k = correctionKey(d); if (k) keptCorrections.current.delete(k); }
                setDraftState(null);
                setSheet(null);
                setRegisterNotice(null);
                say(out.message, "warning");
                void load();
                break;
        }
    }, [api, apply, draft, load, proofs, session, say, setSheet]);

    const remove = useCallback(async (t: PortalTransfer) => {
        setBusy(true);
        const e = session.epoch();
        try {
            const r = await api.remove(t.id, { status: t.status, alloc_gen: t.alloc_gen });
            if (!session.isCurrent(e)) return;
            apply(r.view);
            setConfirmDelete(null);
            setSheet(null);
            say("Pago eliminado.", "success");
        } catch (err) {
            if (!session.isCurrent(e)) return;
            const a = feeErrorAction(err);
            setConfirmDelete(null);
            if (a.kind === "unauthorized") optsRef.current.onUnauthorized();
            else if (a.kind === "stale") { setSheet(null); say(`${a.message} Se recargaron los pagos.`, "warning"); void load(); }
            // The payment's sheet is still open (only the confirm closed): said in it, above its buttons.
            else say(a.message, "error");
        } finally {
            if (session.isCurrent(e)) setBusy(false);
        }
    }, [api, apply, load, session, say, setSheet]);

    /**
     * Sign-out / sign-in: nothing of the previous location may stay on screen or in memory, and nothing it
     * still had in flight may land later (the session ends: createFeeSession; its receipts are cleared too).
     */
    const reset = useCallback(() => {
        session.reset();
        viewRef.current = null;
        keptNew.current = null;
        keptCorrections.current.clear();
        openedWith.current = null;
        setView(null);
        setLoading(false);
        setBusy(false);
        setPreparing(false);
        setError(null);
        setSheet(null);
        setRegisterNotice(null);
        setDraftState(null);
        setSheetErrors(NO_ERRORS);
        setDupRef(null);
        setConfirmDelete(null);
        setSelected([]);
        setSegment("summary");
        setPersonFilter(null);
        setLastSent(null);
    }, [session, setSheet]);

    return {
        api, proofs, view, loading, error, load, reset,
        sheet, setSheet, draft, setDraft, busy, preparing, sheetErrors,
        notice, clearNotice: () => setNotice(null), registerNotice,
        openRegister, openEdit: (t: PortalTransfer) => openFromTransfer(t, "edit"), openDuplicate: (t: PortalTransfer) => openFromTransfer(t, "duplicate"),
        openTransfer: (id: number) => setSheet({ kind: "transfer", id }), closeSheet, submit, restartCorrection,
        dupRef, setDupRef, confirmDelete, setConfirmDelete, remove,
        selected, setSelected, segment, setSegment, personFilter, setPersonFilter, lastSent, setLastSent,
    };
}
export type FeeHub = ReturnType<typeof useFeeHub>;

export type FeePaymentsTabProps = {
    hub: FeeHub;
    nameOf: (id: number) => string;
    groups: FamilyGroup[];
    onOpenPerson: (id: number) => void;
};

/** The «Pagos de cuotas» tab. Mounted only while selected; its mount makes the ONE load. */
export default function FeePaymentsTab({ hub, nameOf, groups, onOpenPerson }: FeePaymentsTabProps) {
    const { view, loading, error, load } = hub;
    useEffect(() => { void load(); }, [load]);
    const balances = useMemo(() => balancesOf(view), [view]);
    const summary = useMemo(() => summarize([...balances.values()]), [balances]);
    const returnedOwn = view ? view.transfers.filter((t) => !t.foreign && t.status === "returned").length : 0;
    const lastSent = hub.lastSent && view?.transfers.find((t) => t.id === hub.lastSent) ? hub.lastSent : null;

    return (
        <Card clip className="animate-in fade-in duration-300" data-testid="fees-tab">
            <CardHeader
                icon="fa-file-invoice-dollar"
                tone="emerald"
                title="Pagos de cuotas"
                caption="Solo cuotas de inscripción · el transporte se paga aparte"
                actions={view ? (
                    <Button icon="fa-plus" variant="success" block onClick={() => void hub.openRegister(hub.selected)} disabled={!view.can_record} className="sm:w-auto" data-action="register">
                        Registrar pago
                    </Button>
                ) : undefined}
            />
            {!view && loading ? (
                <Spinner label="Cargando pagos…" />
            ) : !view ? (
                <div className="p-6 space-y-4">
                    <Notice tone="rose" icon="fa-triangle-exclamation">{error || "No se pudieron cargar los pagos."}</Notice>
                    <Button variant="outline" icon="fa-rotate-right" onClick={() => void load()}>Reintentar</Button>
                </div>
            ) : (
                <div>
                    <div className="px-4 sm:px-6 pt-5 space-y-3">
                        {!view.can_record && (
                            <Notice tone="rose" icon="fa-ban">La administración no ha habilitado formas de pago para esta localidad: no se pueden registrar pagos por ahora.</Notice>
                        )}
                        {returnedOwn > 0 && (
                            <Notice tone="amber" icon="fa-rotate-left" align="center" data-testid="returned-notice">
                                <span className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="font-bold">{returnedOwn === 1 ? "1 pago devuelto por la administración: corrígelo y reenvíalo." : `${returnedOwn} pagos devueltos por la administración: corrígelos y reenvíalos.`}</span>
                                    <Button size="sm" variant="outline" onClick={() => { hub.setPersonFilter(null); hub.setSegment("transfers"); }}>Ver</Button>
                                </span>
                            </Notice>
                        )}
                        {lastSent && (
                            <Notice tone="emerald" icon="fa-circle-check" align="center" role="status">
                                <span className="flex flex-wrap items-center justify-between gap-2">
                                    <span>Pago #{lastSent} enviado: queda por validar por la administración.</span>
                                    <span className="flex gap-1">
                                        <Button size="sm" variant="outline" onClick={() => hub.openTransfer(lastSent)}>Ver</Button>
                                        <Button size="sm" variant="ghost" onClick={() => hub.setLastSent(null)} aria-label="Cerrar aviso">Cerrar</Button>
                                    </span>
                                </span>
                            </Notice>
                        )}
                        <SegmentedControl
                            label="Sección de pagos"
                            value={hub.segment}
                            onChange={(s) => hub.setSegment(s)}
                            options={[
                                { value: "summary", label: "Resumen" },
                                { value: "transfers", label: <>Pagos <span className="tabular-nums">({view.transfers.length})</span></> },
                            ]}
                            testId="fees-segment"
                        />
                    </div>
                    {hub.segment === "summary" ? (
                        <>
                            <div className="px-4 sm:px-6 py-5">
                                <FeeSummary summary={summary} onPending={() => hub.setSegment("transfers")} onReturned={() => hub.setSegment("transfers")} />
                            </div>
                            <div className="border-t border-gray-100">
                                <FeeBalances
                                    balances={balances}
                                    nameOf={nameOf}
                                    groups={groups}
                                    selected={hub.selected}
                                    onSelect={hub.setSelected}
                                    onRegister={(ids) => void hub.openRegister(ids)}
                                    onOpenPerson={onOpenPerson}
                                    canRecord={view.can_record}
                                />
                            </div>
                        </>
                    ) : (
                        <FeeTransfers
                            transfers={view.transfers}
                            nameOf={nameOf}
                            onOpen={hub.openTransfer}
                            personId={hub.personFilter}
                            onClearPerson={() => hub.setPersonFilter(null)}
                            onRegister={() => void hub.openRegister(hub.personFilter ? [hub.personFilter] : [])}
                            canRecord={view.can_record}
                        />
                    )}
                </div>
            )}
        </Card>
    );
}

/** The payment sheets and their confirms (rendered once by the page, above whatever is open). */
export function FeeSheets({ hub, nameOf, groups }: { hub: FeeHub; nameOf: (id: number) => string; groups: FamilyGroup[] }) {
    const { view, sheet, draft } = hub;
    const balances = useMemo(() => balancesOf(view), [view]);
    const ctx = useMemo(() => contextOf(view, balances), [view, balances]);
    const transfer = sheet?.kind === "transfer" && view ? view.transfers.find((t) => t.id === sheet.id) ?? null : null;
    const editId = draft?.kind === "edit" ? draft.editId : draft?.kind === "duplicate" ? draft.copyFrom : null;
    // The stored receipt is fetched at the generation the draft started from (the edited payment's, or the
    // voided one's that «Duplicar» copies).
    const editGen = draft?.kind === "edit" ? draft.expected?.alloc_gen ?? null : editId != null ? view?.transfers.find((t) => t.id === editId)?.alloc_gen ?? null : null;
    return (
        <>
            {sheet?.kind === "transfer" && transfer && (
                <TransferSheet
                    transfer={transfer}
                    nameOf={nameOf}
                    busy={hub.busy}
                    notice={hub.notice}
                    onClose={hub.closeSheet}
                    onEdit={hub.openEdit}
                    onDuplicate={hub.openDuplicate}
                    onDelete={(t) => hub.setConfirmDelete(t)}
                    loadProof={(id, gen) => hub.proofs.get(id, gen)}
                />
            )}
            {sheet?.kind === "register" && draft && view && (
                <RegisterPaymentSheet
                    draft={draft}
                    setDraft={hub.setDraft}
                    ctx={ctx}
                    nameOf={nameOf}
                    groups={groups}
                    busy={hub.busy}
                    notice={hub.registerNotice}
                    error={hub.sheetErrors.message}
                    personErrors={hub.sheetErrors.people}
                    onSubmit={() => void hub.submit()}
                    onClose={hub.closeSheet}
                    onRestart={hub.restartCorrection}
                    loadStoredProof={editId != null ? () => hub.proofs.get(editId, editGen) : undefined}
                />
            )}
            {hub.dupRef && (
                <Modal size="sm" title="Referencia repetida" onClose={() => hub.setDupRef(null)} testId="duplicate-reference"
                    footer={(
                        <>
                            <Button variant="ghost" onClick={() => hub.setDupRef(null)}>Revisar</Button>
                            <Button onClick={() => { hub.setDupRef(null); void hub.submit({ allowDuplicateReference: true }); }}>Registrar de todas formas</Button>
                        </>
                    )}>
                    <p className="text-sm text-gray-700 leading-relaxed">
                        Esa referencia ya se usó en otro pago{hub.dupRef.otherId ? ` (el pago #${hub.dupRef.otherId})` : ""}. ¿Registrar de todas formas?
                    </p>
                </Modal>
            )}
            {hub.confirmDelete && (
                <Modal size="sm" title="Eliminar el pago" onClose={() => hub.setConfirmDelete(null)} testId="confirm-delete"
                    footer={(
                        <>
                            <Button variant="ghost" onClick={() => hub.setConfirmDelete(null)}>Cancelar</Button>
                            <Button variant="danger" icon="fa-trash-can" disabled={hub.busy} onClick={() => hub.confirmDelete && void hub.remove(hub.confirmDelete)}>Eliminar</Button>
                        </>
                    )}>
                    <p className="text-sm text-gray-700 leading-relaxed">
                        Se eliminará el pago #{hub.confirmDelete.id} de {money(Math.round(hub.confirmDelete.amount * 100))}. Las personas vuelven a deber esa parte.
                    </p>
                </Modal>
            )}
        </>
    );
}

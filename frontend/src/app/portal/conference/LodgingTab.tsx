"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useToast } from "@/contexts/ToastContext";
import {
    attendeeName,
    canEditLodging,
    deadlineMessage,
    deadlineState,
    emptyPredicate,
    emptyRuleForm,
    fmtTimestamp,
    lodgingSummary,
    normalizeLodgingStatus,
    opNeedsNoValue,
    portalErrorMessage,
    PRED_OPS,
    roomLabel,
    RULE_TYPE_OPTIONS,
    ruleFieldOptions,
    ruleFormToBody,
    ruleSummary,
    ruleToForm,
    ruleTypeLabel,
    statusLabel,
    unassignedHint,
    unassignedLabel,
    type AssignmentRunResult,
    type LodgingData,
    type LodgingRule,
    type LodgingViolation,
    type RuleForm,
    type RulePredicate,
    type RuleType,
} from "./lodging";
import { readOnlyReason } from "./lodgingView";
import LodgingExplorer from "./LodgingExplorer";
import {
    Badge,
    Button,
    Card,
    CardHeader,
    captionCls,
    checkboxCls,
    cx,
    EmptyState,
    Field,
    headingCls,
    headingShapeCls,
    HeroCard,
    IconButton,
    inputIndigoCls,
    labelCls,
    Modal,
    Notice,
    SectionDivider,
    Spinner,
} from "./ui";

const API = '/api/v1/plugin/conference-manager';

type HeaderMap = Record<string, string>;

export type HospedajesProps = {
    /** The page's `portalAuthHeaders` (CSRF + the x-portal-token fallback); the cookie is the primary path. */
    authHeaders: (extra?: HeaderMap) => HeaderMap;
    /** Re-reads `/portal/me` after an action that changes the location's `unlodged` count (sequenced after the reload). */
    onLocationRefresh: () => void;
    /**
     * Scopes the explorer's remembered position (sessionStorage), e.g. `${conference_id}:${location_id}`.
     * Optional: without it the position is still tied to the payload's rooms (a room is allotted to ONE
     * location), so another location's coordinator logging in in the same browser tab never inherits it.
     */
    storageScope?: string;
};

/** `returnFocus`: the control that asked; a cancel gives it the focus back (ui.tsx's Modal does not). */
type Confirm = { title: string; text: string; okLabel: string; danger?: boolean; onOk: () => void; returnFocus?: HTMLElement | null };

/** A stored or new rule under edition; `id` null = create. */
type RuleEditor = { id: number | null; form: RuleForm };

const violationText = (v: unknown): { text: string; hard: boolean } => {
    if (v && typeof v === 'object') {
        const o = v as Partial<LodgingViolation>;
        const rule = o.rule == null ? '' : String(o.rule);
        const detail = o.detail == null ? '' : String(o.detail);
        return { text: [rule, detail].filter(Boolean).join(': ') || JSON.stringify(v), hard: !!o.hard };
    }
    return { text: String(v ?? ''), hard: false };
};

/** Font Awesome icon of a rule type, as the admin's AssignmentPage rule rows. */
const ruleTypeIcon = (type: unknown): string => {
    switch (type) {
        case 'keep_together': return 'fa-people-group';
        case 'separate_by': return 'fa-arrows-left-right';
        case 'split_by': return 'fa-scissors';
        case 'require_companion': return 'fa-user-shield';
        default: return 'fa-list-check';
    }
};

/**
 * The coordinator's Hospedajes tab (this file is LodgingTab.tsx, not lodging.tsx, because `./lodging`
 * resolves to the helpers module lodging.ts under both tsc and Next). Mounted by page.tsx only while the tab is selected, so its ONE
 * `GET /portal/lodging` fires after `/portal/me` has resolved (the dashboard exists) and every action
 * is strictly sequenced: POST → reload → `/portal/me`, never more than one authenticated request in
 * flight from here (the login throttle caps in-flight verifications per location at 3).
 */
export default function Hospedajes({ authHeaders, onLocationRefresh, storageScope }: HospedajesProps) {
    const { addToast } = useToast();
    const [data, setData] = useState<LodgingData | null>(null);
    const [loading, setLoading] = useState(true);
    /** Why the last `GET /portal/lodging` failed; rendered as an error card (never as a fake empty state). */
    const [loadError, setLoadError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [runResult, setRunResult] = useState<AssignmentRunResult | null>(null);
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [editor, setEditor] = useState<RuleEditor | null>(null);
    /** The control that opened the confirm (see `openConfirm`); a cancel focuses it again. */
    const confirmReturn = useRef<HTMLElement | null>(null);
    // STABLE callbacks: ui.tsx's Modal re-runs its focus effect whenever `onClose` changes identity,
    // so an inline arrow would move the focus to the dialog panel on every re-render of this tab — after
    // every keystroke in the rule editor (each one re-renders the tab through `setEditor`).
    const openConfirm = useCallback((c: Confirm) => {
        const active = typeof document === 'undefined' ? null : document.activeElement;
        confirmReturn.current = c.returnFocus ?? (active instanceof HTMLElement && active !== document.body ? active : null);
        setConfirm(c);
    }, []);
    // The dialog drops the focus to <body> when it unmounts: a cancel (Cancelar, ×, Esc) hands it back
    // to the control that opened it. On «OK» the action's own owner decides (the explorer does).
    const closeConfirm = useCallback(() => {
        setConfirm(null);
        const el = confirmReturn.current;
        confirmReturn.current = null;
        if (el && el.isConnected) el.focus();
    }, []);
    const closeEditor = useCallback(() => setEditor(null), []);
    const mounted = useRef(true);
    // `authHeaders` is a closure over the page's token; keep the latest without re-running the load effect.
    // Updated in a layout effect, not during render: it runs before every passive effect, so the load
    // effect below always reads the current headers.
    const headersRef = useRef(authHeaders);
    useLayoutEffect(() => { headersRef.current = authHeaders; }, [authHeaders]);

    // Whether a payload has ever been received — a failed refetch keeps the last good payload on
    // screen (with a toast); a failed FIRST load shows the error card instead of the empty state.
    const hasData = useRef(false);

    const load = useCallback(async (attempt = 0): Promise<void> => {
        let failure: string | null = null;
        try {
            const res = await fetch(`${API}/portal/lodging`, { credentials: 'include', headers: headersRef.current() });
            if (!mounted.current) return;
            if (res.ok) {
                const d: LodgingData = await res.json();
                if (!mounted.current) return;
                setData(d && typeof d === 'object' ? d : {});
                hasData.current = true;
                setLoadError(null);
                // The rule editor has nothing to save into once the arrangement is frozen.
                if (!canEditLodging(d && typeof d === 'object' ? d.status : null)) setEditor(null);
            } else if (res.status === 401 && attempt === 0) {
                // The login throttle caps in-flight verifications per location (3): right after a
                // registration the page may still hold two of them, so wait a moment and try once more
                // before treating the 401 as an expired session.
                await new Promise((r) => setTimeout(r, 500));
                if (mounted.current) await load(1);
                return;
            } else {
                const err: unknown = await res.json().catch(() => ({}));
                failure = portalErrorMessage(res.status, err, 'No se pudo cargar el hospedaje.');
            }
        } catch {
            failure = 'Error de conexión';
        } finally {
            if (mounted.current) {
                if (failure) {
                    setLoadError(failure);
                    if (hasData.current) addToast(failure, 'error');
                }
                setLoading(false);
            }
        }
    }, [addToast]);

    useEffect(() => {
        mounted.current = true;
        load();
        return () => { mounted.current = false; };
    }, [load]);

    /**
     * POST an action, then reload (sequenced), then let the page refresh its seat/unlodged counts.
     * Resolves true when the server accepted the action (the reload has then already landed), false
     * when it was refused, failed, or another action was still in flight.
     */
    const act = async (path: string, body: unknown, opts: { method?: string; onOk?: (d: Record<string, unknown>) => void; okMessage?: string } = {}): Promise<boolean> => {
        if (busy) return false;
        setBusy(true);
        let accepted = false;
        try {
            const init: RequestInit = {
                method: opts.method || 'POST',
                credentials: 'include',
                headers: headersRef.current(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            };
            if (body !== undefined) init.body = JSON.stringify(body);
            const res = await fetch(`${API}${path}`, init);
            const d = await res.json().catch(() => ({})) as Record<string, unknown>;
            if (!mounted.current) return false;
            if (res.ok) {
                accepted = true;
                if (opts.okMessage) addToast(opts.okMessage, 'success');
                if (opts.onOk) opts.onOk(d);
                await load();
                onLocationRefresh();
            } else {
                addToast(portalErrorMessage(res.status, d, 'No se pudo completar la acción.'), 'error');
                // A 409 means the status moved under us (submitted/validated elsewhere) — re-read it.
                if (res.status === 409) await load();
            }
        } catch {
            if (mounted.current) addToast('Error de conexión', 'error');
        } finally {
            if (mounted.current) setBusy(false);
        }
        return accepted;
    };

    if (data === null) {
        // No payload yet: loading, or the first load failed. Never fall through to an empty `{}` — that
        // would render a healthy "Borrador" with "no rooms allotted" for a 401/429/500/offline.
        if (loading || !loadError) {
            return <Card><Spinner label="Cargando hospedaje…" /></Card>;
        }
        return (
            <Card className="border-rose-200 p-8 sm:p-10 text-center" data-testid="lodging-error">
                <div className="w-14 h-14 bg-rose-50 rounded-2xl flex items-center justify-center text-rose-400 text-2xl shadow-sm mx-auto mb-4">
                    <i className="fa-solid fa-triangle-exclamation"></i>
                </div>
                <p className="text-gray-800 font-bold">No se pudo cargar el hospedaje.</p>
                <p className="text-sm text-gray-500 mt-1">{loadError}</p>
                <Button onClick={() => { setLoading(true); load(); }} icon="fa-rotate-right" className="mt-6">Reintentar</Button>
            </Card>
        );
    }
    const d: LodgingData = data;
    const status = normalizeLodgingStatus(d.status);
    const editable = canEditLodging(status) && d.can_edit !== false;
    const rooms = Array.isArray(d.rooms) ? d.rooms : [];
    const unassigned = Array.isArray(d.unassigned) ? d.unassigned : [];
    const elsewhere = Array.isArray(d.placed_elsewhere) ? d.placed_elsewhere : [];
    const violations = Array.isArray(d.violations) ? d.violations : [];
    const adminRules = Array.isArray(d.rules?.conference) ? d.rules.conference : [];
    const myRules = Array.isArray(d.rules?.location) ? d.rules.location : [];
    const fields = Array.isArray(d.fields) ? d.fields : [];
    const summary = lodgingSummary(d);
    const hasRooms = rooms.length > 0;
    /** Why nothing can be changed right now (null while editable) — the explorer shows it instead of silently disabled controls. */
    const lockReason = readOnlyReason(d);

    /** The ONE write path of every placement (explorer drag & drop, room picker, free-bed picker, «Quitar»). */
    const assign = (inscriptionId: number, roomId: number | null): Promise<boolean> =>
        act('/portal/lodging/assign', { inscription_id: inscriptionId, room_id: roomId }, {
            okMessage: roomId == null ? 'Participante sin habitación.' : 'Participante asignado.',
        });

    const runAuto = () => act('/portal/lodging/run', {}, {
        onOk: (r) => setRunResult({
            assignedCount: Number(r.assignedCount) || 0,
            remaining: Number(r.remaining) || 0,
            violations: Array.isArray(r.violations) ? r.violations : [],
        }),
    });

    const askReset = () => openConfirm({
        title: 'Quitar todas las asignaciones',
        text: 'Se vaciarán todas las habitaciones de tu localidad. ¿Continuar?',
        okLabel: 'Sí, vaciar',
        danger: true,
        onOk: () => act('/portal/lodging/reset', {}, { okMessage: 'Se quitaron todas las asignaciones.', onOk: () => setRunResult(null) }),
    });

    const askSubmit = () => openConfirm({
        title: 'Enviar a validación',
        text: summary.unplaced > 0
            ? `Hay ${unassignedLabel(summary.unplaced)}. El administrador revisará la acomodación tal como está y no podrás modificarla hasta que la devuelva o retires el envío. ¿Enviar?`
            : 'El administrador revisará la acomodación y no podrás modificarla hasta que la devuelva o retires el envío. ¿Enviar?',
        okLabel: 'Enviar',
        onOk: () => { setEditor(null); act('/portal/lodging/submit', {}, { okMessage: 'Hospedaje enviado a validación.' }); },
    });

    const withdraw = () => act('/portal/lodging/withdraw', {}, { okMessage: 'Envío retirado; puedes seguir acomodando.' });

    const saveRule = () => {
        if (!editor) return;
        const r = ruleFormToBody(editor.form, editor.id);
        if ('error' in r) { addToast(r.error, 'error'); return; }
        act('/portal/lodging/rules', r.body, { okMessage: editor.id == null ? 'Regla creada.' : 'Regla guardada.', onOk: () => setEditor(null) });
    };

    const askDeleteRule = (rule: LodgingRule) => openConfirm({
        title: 'Eliminar regla',
        text: `Se eliminará la regla «${rule.name}». ¿Continuar?`,
        okLabel: 'Eliminar',
        danger: true,
        onOk: () => act(`/portal/lodging/rules/${rule.id}`, undefined, { method: 'DELETE', okMessage: 'Regla eliminada.' }),
    });

    const heroTone = status === 'validated' ? 'emerald' : status === 'submitted' ? 'amber' : 'blue';
    // The admin's LODGING_STATUS_META: draft is a gray pill with a pen-ruler, submitted amber, validated emerald.
    const statusTone = status === 'validated' ? 'emerald' : status === 'submitted' ? 'amber' : 'gray';
    const statusIcon = status === 'validated' ? 'fa-circle-check' : status === 'submitted' ? 'fa-paper-plane' : 'fa-pen-ruler';
    const runViolations = runResult ? (runResult.violations || []) : [];

    return (
        <div className="space-y-6 sm:space-y-8" data-testid="portal-lodging">
            {/* Status banner */}
            <HeroCard tone={heroTone} contentClassName="space-y-5" data-testid="lodging-status">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-3">
                            <h2 className={cx("text-2xl sm:text-3xl", headingCls)}>Hospedaje</h2>
                            <Badge tone={statusTone} icon={statusIcon}>{statusLabel(status)}</Badge>
                        </div>
                        {status === 'submitted' && d.submitted_at && <div className={cx(captionCls, "mt-2")}>Enviado el {fmtTimestamp(d.submitted_at)}</div>}
                        {status === 'validated' && d.reviewed_at && <div className={cx(captionCls, "mt-2")}>Validado el {fmtTimestamp(d.reviewed_at)}</div>}
                    </div>
                    {status === 'submitted' && deadlineState(d) !== 'passed' && (
                        <Button variant="outline" icon="fa-rotate-left" onClick={withdraw} disabled={busy} className="shrink-0">Retirar envío</Button>
                    )}
                    {status === 'validated' && <span className="text-xs text-emerald-800 font-bold sm:max-w-xs sm:text-right">Solo lectura. Para cambiar la acomodación, pide al administrador reabrir el hospedaje.</span>}
                </div>
                {deadlineMessage(d) && (
                    <Notice tone={deadlineState(d) === 'passed' ? 'rose' : deadlineState(d) === 'extended' ? 'emerald' : 'blue'} icon={deadlineState(d) === 'passed' ? 'fa-lock' : deadlineState(d) === 'extended' ? 'fa-unlock' : 'fa-calendar-check'} data-testid="lodging-deadline">
                        <span>{deadlineMessage(d)}</span>
                    </Notice>
                )}
                {status === 'draft' && d.note && (
                    <Notice tone="amber" icon="fa-comment-dots" data-testid="lodging-note">
                        <span className="font-black">Observaciones del administrador:</span> {String(d.note)}
                    </Notice>
                )}
                {status !== 'draft' && summary.unplaced > 0 && (
                    <Notice tone="amber" icon="fa-user-clock">
                        <span className="font-black">{unassignedLabel(summary.unplaced)}.</span> {unassignedHint(status)}
                    </Notice>
                )}
            </HeroCard>

            {!hasRooms ? (
                <div data-testid="lodging-empty">
                    <EmptyState icon="fa-bed" title="El administrador aún no te ha asignado habitaciones." />
                </div>
            ) : (
                <>
                    {/* Actions (the numbers live in the explorer: the summary strip of its «Hoteles» level) */}
                    {editable && (
                        <Card className="p-5 sm:p-6 space-y-4" data-testid="lodging-actions">
                            <div className="flex flex-wrap gap-3">
                                <Button icon="fa-wand-magic-sparkles" onClick={runAuto} disabled={busy || unassigned.length === 0} title={unassigned.length === 0 ? 'No hay participantes sin habitación.' : undefined}>
                                    Asignación automática
                                </Button>
                                <Button variant="dangerGhost" icon="fa-trash-can" onClick={askReset} disabled={busy || summary.placed === 0}>
                                    Quitar todas las asignaciones
                                </Button>
                                <Button variant="success" icon="fa-paper-plane" onClick={askSubmit} disabled={busy} className="sm:ml-auto">
                                    Enviar a validación
                                </Button>
                            </div>
                            {/* Native HTML5 drag never fires from touch (Android Chrome scrolls instead), so the DnD copy
                                is for fine pointers only; coarse pointers get the pickers' instructions. */}
                            <p className="hidden pointer-fine:flex items-start gap-2 text-xs text-gray-500 leading-relaxed" data-testid="lodging-dnd-hint">
                                <i className="fa-solid fa-hand-pointer text-blue-500 mt-0.5" aria-hidden="true"></i>
                                <span>Entra en un hotel y en una habitación para ver a sus ocupantes. Arrastra a un participante desde «Sin habitación» a una habitación, o entre habitaciones; suéltalo en «Sin habitación» para liberar la cama.</span>
                            </p>
                            <p className="hidden pointer-coarse:flex items-start gap-2 text-xs text-gray-500 leading-relaxed" data-testid="lodging-touch-hint">
                                <i className="fa-solid fa-hand-pointer text-blue-500 mt-0.5" aria-hidden="true"></i>
                                <span>Toca un hotel y luego una habitación para ver a sus ocupantes. En cada cama libre, «Asignar participante»; en cada ocupante, «Mover a otra habitación» o «Quitar de la habitación»; en «Sin habitación», «Elegir habitación».</span>
                            </p>
                            {runResult && (
                                /* The admin's run report card: amber when a rule was broken, emerald otherwise. */
                                <div className={cx("rounded-3xl border p-6 shadow-xl", runViolations.length > 0 ? 'bg-amber-50/40 border-amber-200' : 'bg-emerald-50/40 border-emerald-200')} data-testid="lodging-run-result">
                                    <div className="flex items-center gap-3 mb-3">
                                        <i className={cx("fa-solid text-lg", runViolations.length > 0 ? 'fa-triangle-exclamation text-amber-500' : 'fa-circle-check text-emerald-500')}></i>
                                        <h3 className="text-sm font-black text-gray-900 uppercase tracking-widest">Resultado de la asignación</h3>
                                    </div>
                                    <p className="text-xs text-gray-600"><b className="text-gray-900">{runResult.assignedCount ?? 0}</b> asignados · <b className="text-gray-900">{runResult.remaining ?? 0}</b> sin asignar</p>
                                    {runViolations.length > 0 && (
                                        <ul className="mt-3 space-y-1.5">
                                            {runViolations.map((v, i) => {
                                                const t = violationText(v);
                                                return (
                                                    <li key={i} className="flex items-start gap-2 text-xs text-gray-700">
                                                        <span className={cx("mt-0.5 px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest whitespace-nowrap", t.hard ? 'bg-rose-100 text-rose-600' : 'bg-gray-200 text-gray-500')}>{t.hard ? 'Obligatoria' : 'Preferente'}</span>
                                                        <span className="min-w-0">{t.text}</span>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </div>
                            )}
                        </Card>
                    )}
                </>
            )}

            {/* Violations of the current arrangement — always visible when there are any. */}
            {violations.length > 0 && (
                <Card data-testid="lodging-violations">
                    <CardHeader icon="fa-triangle-exclamation" tone="rose" title="Reglas incumplidas" caption={`${summary.hardViolations} obligatorias · ${summary.softViolations} preferentes`} />
                    <ul className="p-5 sm:p-6 space-y-2">
                        {violations.map((v, i) => {
                            const t = violationText(v);
                            return (
                                <li key={i}>
                                    <Notice tone={t.hard ? 'rose' : 'amber'} align="center">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge tone={t.hard ? 'rose' : 'amber'}>{t.hard ? 'Obligatoria' : 'Preferente'}</Badge>
                                            <span className="font-medium">{t.text}</span>
                                        </div>
                                    </Notice>
                                </li>
                            );
                        })}
                    </ul>
                </Card>
            )}

            {hasRooms && (
                /* Hoteles › Hotel › Habitación — replaces the old one-page board (rooms grid + «Sin habitación» card). */
                <LodgingExplorer
                    rooms={rooms}
                    unassigned={unassigned}
                    fields={fields}
                    summary={summary}
                    editable={editable}
                    readOnlyReason={lockReason}
                    busy={busy}
                    onAssign={assign}
                    onConfirm={openConfirm}
                    notify={addToast}
                    storageScope={storageScope}
                />
            )}

            {/* Placed by the admin in pool rooms — read-only */}
            {elsewhere.length > 0 && (
                <Card data-testid="lodging-elsewhere">
                    <CardHeader icon="fa-building-user" tone="indigo" title="Alojados por el administrador" caption={`${elsewhere.length} participantes`} />
                    <p className="px-5 sm:px-8 pt-4 text-xs text-gray-500 leading-relaxed">Participantes de tu localidad ubicados en habitaciones fuera de tu cupo; solo el administrador puede moverlos.</p>
                    <ul className="divide-y divide-gray-50 mt-2">
                        {elsewhere.map((p) => (
                            <li key={p.id} className="px-5 sm:px-8 py-3.5 flex items-center justify-between gap-3 text-sm hover:bg-blue-50/30 transition-colors">
                                <span className="font-black text-gray-900 truncate">{attendeeName(p)}</span>
                                <span className={cx(captionCls, "shrink-0")}>{roomLabel(p)}</span>
                            </li>
                        ))}
                    </ul>
                </Card>
            )}

            {/* Rules */}
            <Card data-testid="lodging-rules">
                <CardHeader
                    icon="fa-list-check"
                    tone="indigo"
                    title="Reglas de asignación"
                    caption={`${adminRules.length + myRules.length} reglas · orden por prioridad`}
                    actions={hasRooms && editable && !editor ? (
                        <Button variant="outlineIndigo" icon="fa-plus" onClick={() => setEditor({ id: null, form: emptyRuleForm() })} disabled={busy}>Nueva regla</Button>
                    ) : undefined}
                />
                <div className="p-5 sm:p-8 space-y-8">
                    <p className="text-xs text-gray-500 leading-relaxed -mt-2">La asignación automática aplica las reglas del administrador y las tuyas, por prioridad.</p>
                    <div className="space-y-4">
                        <SectionDivider>Reglas del administrador</SectionDivider>
                        {adminRules.length === 0 ? (
                            <p className="text-xs text-gray-500 italic text-center py-2">El administrador no ha definido reglas.</p>
                        ) : (
                            <ul className="divide-y divide-gray-50 -mx-5 sm:-mx-8">
                                {adminRules.map((r) => (
                                    <li key={r.id}>
                                        <RuleRow rule={r} fields={fields} readOnly />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="space-y-4">
                        <SectionDivider>Mis reglas</SectionDivider>
                        {myRules.length === 0 ? (
                            <p className="text-xs text-gray-500 italic text-center py-2">Aún no tienes reglas propias.</p>
                        ) : (
                            <ul className="divide-y divide-gray-50 -mx-5 sm:-mx-8">
                                {myRules.map((r) => (
                                    <li key={r.id}>
                                        <RuleRow
                                            rule={r}
                                            fields={fields}
                                            actions={editable ? (
                                                <>
                                                    <IconButton variant="soft" icon="fa-pen" tone="blue" onClick={() => setEditor({ id: r.id, form: ruleToForm(r) })} disabled={busy} title="Editar" aria-label={`Editar regla ${r.name}`} />
                                                    <IconButton variant="soft" icon="fa-trash-can" tone="rose" onClick={() => askDeleteRule(r)} disabled={busy} title="Eliminar" aria-label={`Eliminar regla ${r.name}`} />
                                                </>
                                            ) : undefined}
                                        />
                                    </li>
                                ))}
                            </ul>
                        )}
                        {editor && editable && (
                            <RuleEditorForm
                                editor={editor}
                                fields={fields}
                                busy={busy}
                                onChange={(form) => setEditor({ ...editor, form })}
                                onCancel={closeEditor}
                                onSave={saveRule}
                            />
                        )}
                    </div>
                </div>
            </Card>

            {confirm && (
                <Modal
                    size="sm"
                    title={confirm.title}
                    onClose={closeConfirm}
                    footer={(
                        <>
                            <Button variant="ghost" onClick={closeConfirm}>Cancelar</Button>
                            <Button variant={confirm.danger ? 'danger' : 'primary'} onClick={() => { const ok = confirm.onOk; confirmReturn.current = null; setConfirm(null); ok(); }}>{confirm.okLabel}</Button>
                        </>
                    )}
                >
                    <p className="text-sm text-gray-700 leading-relaxed">{confirm.text}</p>
                </Modal>
            )}
        </div>
    );
}

// Module-level (never define a component inside a component — it steals input focus).
/**
 * One rule as the admin's AssignmentPage row (flat, inside a `divide-y` list): 14x14 indigo tile, black
 * italic name, type + hard/soft pills, priority chip, one-line summary, soft white action buttons. On
 * phones the actions wrap under the text so the name keeps its width.
 */
function RuleRow({ rule, fields, readOnly, actions }: { rule: LodgingRule; fields: { name: string; label: string }[]; readOnly?: boolean; actions?: React.ReactNode }) {
    const enabled = rule.enabled == null ? true : !!Number(rule.enabled);
    const hard = !!Number(rule.hard);
    return (
        <div className={cx("group p-5 sm:p-6 flex flex-wrap sm:flex-nowrap items-center gap-3 sm:gap-5 transition-all", readOnly ? 'bg-gray-50/60' : 'hover:bg-indigo-50/30', !enabled && 'opacity-60')}>
            <div className={cx("w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex items-center justify-center text-lg sm:text-xl shrink-0 transition-all", enabled ? (readOnly ? 'bg-white text-indigo-500 border border-indigo-100 shadow-sm' : 'bg-indigo-600 text-white shadow-lg shadow-indigo-100') : 'bg-white text-gray-300 border border-gray-100 shadow-none')}>
                <i className={cx("fa-solid", ruleTypeIcon(rule.type), !enabled && 'opacity-30')}></i>
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                    <h4 className={cx("text-lg", headingShapeCls, "truncate", enabled ? 'text-gray-900' : 'text-gray-400')}>{rule.name}</h4>
                    <Badge tone="indigo" size="xs">{ruleTypeLabel(rule.type)}</Badge>
                    <Badge tone={hard ? 'rose' : 'gray'} size="xs">{hard ? 'Obligatoria' : 'Preferente'}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-lg text-[9px] font-bold text-gray-500 uppercase tracking-tight whitespace-nowrap">
                        <i className="fa-solid fa-bolt text-amber-500"></i>
                        Prioridad: {rule.priority == null ? '' : String(rule.priority)}
                    </div>
                    <div className="text-xs text-gray-500 leading-relaxed min-w-0">{ruleSummary(rule, fields)}</div>
                </div>
            </div>
            {actions ? <div className="flex items-center gap-2 shrink-0 basis-full justify-end sm:basis-auto">{actions}</div> : null}
        </div>
    );
}

function PredicateRow({ label, value, fields, onChange }: { label: string; value: RulePredicate; fields: { name: string; label: string }[]; onChange: (p: RulePredicate) => void }) {
    return (
        <fieldset className="space-y-1.5 min-w-0">
            <legend className={labelCls}>{label}</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select className={inputIndigoCls} aria-label="Campo" value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })}>
                    <option value="">Campo…</option>
                    {fields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                </select>
                <select className={inputIndigoCls} aria-label="Operador" value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value, value: opNeedsNoValue(e.target.value) ? '' : value.value })}>
                    {PRED_OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
                <input className={inputIndigoCls} aria-label="Valor" placeholder="Valor" maxLength={200} disabled={opNeedsNoValue(value.op)} value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} />
            </div>
        </fieldset>
    );
}

function RuleEditorForm({ editor, fields, busy, onChange, onCancel, onSave }: {
    editor: RuleEditor;
    fields: { name: string; label: string }[];
    busy: boolean;
    onChange: (form: RuleForm) => void;
    onCancel: () => void;
    onSave: () => void;
}) {
    const form = editor.form;
    const options = ruleFieldOptions(fields);
    const set = (patch: Partial<RuleForm>) => onChange({ ...form, ...patch });
    const typeMeta = RULE_TYPE_OPTIONS.find((o) => o.v === form.type);
    const formId = 'lodging-rule-form';
    return (
        <Modal
            size="lg"
            title={editor.id == null ? 'Nueva regla' : 'Editar regla'}
            subtitle="Criterio de asignación de habitaciones"
            onClose={onCancel}
            footer={(
                <>
                    <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
                    <Button type="submit" form={formId} variant="indigo" disabled={busy} icon="fa-check">{editor.id == null ? 'Crear regla' : 'Guardar regla'}</Button>
                </>
            )}
        >
            <form id={formId} className="space-y-6" onSubmit={(e) => { e.preventDefault(); onSave(); }} data-testid="lodging-rule-editor">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="Nombre">
                        {(id) => <input id={id} className={inputIndigoCls} maxLength={100} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="p. ej. Familias juntas" required />}
                    </Field>
                    <Field label="Tipo" help={typeMeta ? typeMeta.desc : undefined}>
                        {(id) => (
                            <select id={id} className={inputIndigoCls} value={form.type} onChange={(e) => {
                                const type = e.target.value as RuleType;
                                set({ type, subject: type === 'require_companion' ? form.subject : emptyPredicate(), needs: type === 'require_companion' ? form.needs : emptyPredicate() });
                            }}>
                                {RULE_TYPE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                            </select>
                        )}
                    </Field>
                </div>
                {form.type !== 'require_companion' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Field label="Campo">
                            {(id) => (
                                <select id={id} className={inputIndigoCls} value={form.config} onChange={(e) => set({ config: e.target.value })} required>
                                    <option value="">Elige un campo…</option>
                                    {options.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                                </select>
                            )}
                        </Field>
                        {form.type === 'keep_together' && (
                            <Field label="Tamaño mínimo del grupo">
                                {(id) => <input id={id} type="number" min={1} step={1} className={inputIndigoCls} value={form.min_size} onChange={(e) => set({ min_size: e.target.value })} placeholder="1" />}
                            </Field>
                        )}
                    </div>
                ) : (
                    <div className="space-y-4">
                        <PredicateRow label="Si en la habitación hay alguien que cumple…" value={form.subject} fields={options} onChange={(subject) => set({ subject })} />
                        <PredicateRow label="…debe haber acompañantes que cumplan" value={form.needs} fields={options} onChange={(needs) => set({ needs })} />
                        <Field label="Acompañantes mínimos" className="sm:w-48">
                            {(id) => <input id={id} type="number" min={1} step={1} className={inputIndigoCls} value={form.min} onChange={(e) => set({ min: e.target.value })} placeholder="1" />}
                        </Field>
                    </div>
                )}
                <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-4">
                    <Field label="Prioridad" className="sm:w-32">
                        {(id) => <input id={id} type="number" step={1} className={inputIndigoCls} value={form.priority} onChange={(e) => set({ priority: e.target.value })} />}
                    </Field>
                    <label className="flex items-center gap-2 text-sm font-medium text-gray-700 sm:pb-3 cursor-pointer">
                        <input type="checkbox" className={checkboxCls} checked={form.hard} onChange={(e) => set({ hard: e.target.checked })} /> Obligatoria (nunca se incumple)
                    </label>
                    <label className="flex items-center gap-2 text-sm font-medium text-gray-700 sm:pb-3 cursor-pointer">
                        <input type="checkbox" className={checkboxCls} checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Activa
                    </label>
                </div>
            </form>
        </Modal>
    );
}

"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/contexts/ToastContext";
import { StatCard } from "@/components/ui/StatCard";
import {
    attendeeName,
    canEditLodging,
    deadlineMessage,
    deadlineState,
    dragDecision,
    emptyPredicate,
    emptyRuleForm,
    fmtTimestamp,
    freeBeds,
    lodgingSummary,
    normalizeLodgingStatus,
    opNeedsNoValue,
    parseDragId,
    portalErrorMessage,
    PRED_OPS,
    roomLabel,
    roomsWithSpace,
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
    type DragRefusal,
    type LodgingData,
    type LodgingRoom,
    type LodgingRule,
    type LodgingViolation,
    type RuleForm,
    type RulePredicate,
    type RuleType,
} from "./lodging";
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
    inputDenseCls,
    inputIndigoCls,
    labelCls,
    Modal,
    Notice,
    SectionDivider,
    Spinner,
} from "./ui";

const API = '/api/v1/plugin/conference-manager';

type HeaderMap = Record<string, string>;

/** What a drop target shows while a chip hovers it: `dragDecision`'s verdict flattened to one word. */
type DropVerdict = 'ok' | DragRefusal;

export type HospedajesProps = {
    /** The page's `portalAuthHeaders` (CSRF + the x-portal-token fallback); the cookie is the primary path. */
    authHeaders: (extra?: HeaderMap) => HeaderMap;
    /** Re-reads `/portal/me` after an action that changes the location's `unlodged` count (sequenced after the reload). */
    onLocationRefresh: () => void;
};

type Confirm = { title: string; text: string; okLabel: string; danger?: boolean; onOk: () => void };

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
export default function Hospedajes({ authHeaders, onLocationRefresh }: HospedajesProps) {
    const { addToast } = useToast();
    const [data, setData] = useState<LodgingData | null>(null);
    const [loading, setLoading] = useState(true);
    /** Why the last `GET /portal/lodging` failed; rendered as an error card (never as a fake empty state). */
    const [loadError, setLoadError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [runResult, setRunResult] = useState<AssignmentRunResult | null>(null);
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [editor, setEditor] = useState<RuleEditor | null>(null);
    /** Unassigned attendee id → the room picked in its select (as a string, '' = none). */
    const [pick, setPick] = useState<Record<number, string>>({});
    /** The attendee chip under drag (native HTML5 DnD) and where it started: null = the "Sin habitación" list. */
    const [dragging, setDragging] = useState<{ id: number; fromRoomId: number | null } | null>(null);
    /**
     * The drop target under the pointer (`room:<id>` or `unassigned`) and the client-side verdict for the
     * chip over it: 'ok' (it can take it), 'same' (the chip already lives there — a silent no-op, never
     * painted as a refusal), 'full' / 'unknown' (refused).
     */
    const [dropHover, setDropHover] = useState<{ key: string; reason: DropVerdict } | null>(null);
    /**
     * dragenter/dragleave depth per drop target. `dragleave` fires for every child crossed and WebKit
     * reports `relatedTarget === null` on it, so the standard counter (not `relatedTarget`) tells apart
     * "moved onto a child" from "really left the target".
     */
    const dragDepth = useRef(new Map<string, number>());
    const mounted = useRef(true);
    // `authHeaders` is a closure over the page's token; keep the latest without re-running the load effect.
    const headersRef = useRef(authHeaders);
    headersRef.current = authHeaders;

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

    /** POST an action, then reload (sequenced), then let the page refresh its seat/unlodged counts. */
    const act = async (path: string, body: unknown, opts: { method?: string; onOk?: (d: Record<string, unknown>) => void; okMessage?: string } = {}) => {
        if (busy) return;
        setBusy(true);
        try {
            const init: RequestInit = {
                method: opts.method || 'POST',
                credentials: 'include',
                headers: headersRef.current(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            };
            if (body !== undefined) init.body = JSON.stringify(body);
            const res = await fetch(`${API}${path}`, init);
            const d = await res.json().catch(() => ({})) as Record<string, unknown>;
            if (!mounted.current) return;
            if (res.ok) {
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
    const spaceRooms = roomsWithSpace(rooms);

    // Rooms grouped by hotel (first-appearance order), one card header per hotel as the admin's LodgingPage.
    const hotels: Array<{ name: string; rooms: LodgingRoom[] }> = [];
    for (const room of rooms) {
        const name = room.hotel_name || 'Hotel';
        const group = hotels.find((h) => h.name === name);
        if (group) group.rooms.push(room); else hotels.push({ name, rooms: [room] });
    }

    const assign = (inscriptionId: number, roomId: number | null) =>
        act('/portal/lodging/assign', { inscription_id: inscriptionId, room_id: roomId }, {
            okMessage: roomId == null ? 'Participante sin habitación.' : 'Participante asignado.',
            // Forget the room picked for this attendee — the select is gone once they are placed.
            onOk: () => setPick((prev) => { const next = { ...prev }; delete next[inscriptionId]; return next; }),
        });

    // ── Drag & drop (additive: the ✕ buttons and the select + "Asignar" path stay as the touch/keyboard way) ──
    // A drop ends in exactly the same single `assign()` call as those controls: optimistic behaviour,
    // the sequenced reload and the error toasts are identical. Only the pointer-side decisions
    // (`dragDecision`) run client-side; the server re-validates every move.
    const canDrag = editable && !busy;
    const dropKey = (toRoomId: number | null) => (toRoomId == null ? 'unassigned' : `room:${toRoomId}`);
    const decide = (attendeeId: number, fromRoomId: number | null, toRoomId: number | null) =>
        dragDecision({ attendeeId, fromRoomId, toRoomId, rooms, unassigned });

    const chipDragProps = (attendeeId: number, fromRoomId: number | null) => ({
        draggable: canDrag,
        onDragStart: (e: React.DragEvent<HTMLElement>) => {
            if (!canDrag) { e.preventDefault(); return; }
            e.dataTransfer.setData('text/plain', String(attendeeId));
            e.dataTransfer.effectAllowed = 'move';
            setDragging({ id: attendeeId, fromRoomId });
        },
        onDragEnd: () => { dragDepth.current.clear(); setDragging(null); setDropHover(null); },
    });

    const dropTargetProps = (toRoomId: number | null) => ({
        onDragEnter: (e: React.DragEvent<HTMLElement>) => {
            // Foreign drags (text or a file from outside the tab) are never counted: no dragend would reset them.
            if (!dragging || !canDrag) return;
            e.preventDefault();
            const key = dropKey(toRoomId);
            dragDepth.current.set(key, (dragDepth.current.get(key) ?? 0) + 1);
        },
        onDragOver: (e: React.DragEvent<HTMLElement>) => {
            // Not our chip: let the browser refuse the drop.
            if (!dragging || !canDrag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const key = dropKey(toRoomId);
            const verdict = decide(dragging.id, dragging.fromRoomId, toRoomId);
            const reason: DropVerdict = verdict.ok ? 'ok' : verdict.reason;
            // Switching tiles replaces the key at once; the counter below only decides when to CLEAR it.
            setDropHover((h) => (h && h.key === key && h.reason === reason ? h : { key, reason }));
        },
        onDragLeave: () => {
            // dragleave fires for every child crossed (and WebKit gives no relatedTarget): the pointer has
            // really left the target only once its dragenter/dragleave depth is back to zero.
            const key = dropKey(toRoomId);
            const depth = (dragDepth.current.get(key) ?? 0) - 1;
            if (depth > 0) { dragDepth.current.set(key, depth); return; }
            dragDepth.current.delete(key);
            setDropHover((h) => (h && h.key === key ? null : h));
        },
        onDrop: (e: React.DragEvent<HTMLElement>) => {
            e.preventDefault();
            const from = dragging;
            dragDepth.current.clear();
            setDragging(null);
            setDropHover(null);
            if (!from || !canDrag) return;
            // The state that drove the hover ring is the source of truth; the dataTransfer only cross-checks
            // that the browser delivered OUR chip (not a stale one from another tab or window).
            const id = parseDragId(e.dataTransfer.getData('text/plain'));
            if (id == null || id !== Number(from.id)) return;
            const verdict = decide(from.id, from.fromRoomId, toRoomId);
            if (!verdict.ok) {
                if (verdict.reason === 'full') addToast('La habitación está llena.', 'error');
                else if (verdict.reason === 'unknown') addToast('No se pudo identificar al participante; vuelve a intentarlo.', 'error');
                return; // `same`: dropped where it already was — nothing to do.
            }
            assign(from.id, toRoomId);
        },
    });

    /** The verdict of the target a chip hovers (null while nothing hovers it). */
    const hoverOn = (toRoomId: number | null): DropVerdict | null =>
        dropHover && dropHover.key === dropKey(toRoomId) ? dropHover.reason : null;

    /**
     * The ring a room tile wears while a chip hovers it: blue when it can take it, rose when it refuses
     * ('full' / 'unknown'), and a neutral grey over the room the chip already lives in ('same' is a
     * silent no-op, never a refusal — the very tile a drag starts from would otherwise flash red).
     */
    const dropRing = (toRoomId: number | null): string => {
        const v = hoverOn(toRoomId);
        if (v === null) return '';
        if (v === 'ok') return 'ring-4 ring-blue-400/60';
        if (v === 'same') return 'ring-4 ring-gray-200';
        return 'ring-4 ring-rose-400/60';
    };

    /** The same three moods for the unassigned Card's dashed outline (its idle colour is grey). */
    const unassignedOutline = (): string => {
        const v = hoverOn(null);
        if (v === 'ok') return 'outline-blue-500';
        if (v === null || v === 'same') return 'outline-gray-200';
        return 'outline-rose-400';
    };

    const runAuto = () => act('/portal/lodging/run', {}, {
        onOk: (r) => setRunResult({
            assignedCount: Number(r.assignedCount) || 0,
            remaining: Number(r.remaining) || 0,
            violations: Array.isArray(r.violations) ? r.violations : [],
        }),
    });

    const askReset = () => setConfirm({
        title: 'Quitar todas las asignaciones',
        text: 'Se vaciarán todas las habitaciones de tu localidad. ¿Continuar?',
        okLabel: 'Sí, vaciar',
        danger: true,
        onOk: () => act('/portal/lodging/reset', {}, { okMessage: 'Se quitaron todas las asignaciones.', onOk: () => setRunResult(null) }),
    });

    const askSubmit = () => setConfirm({
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

    const askDeleteRule = (rule: LodgingRule) => setConfirm({
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
                    {/* Summary */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-6" data-testid="lodging-summary">
                        <StatCard icon="fa-door-open" value={summary.rooms} label="Habitaciones" color="blue" />
                        <StatCard icon="fa-bed" value={summary.beds} label={`Camas (${summary.free} libres)`} color="indigo" />
                        <StatCard icon="fa-user-check" value={summary.placed} label="Alojados" color="green" />
                        <StatCard icon="fa-user-clock" value={summary.unplaced} label="Sin habitación" color={summary.unplaced > 0 ? 'red' : 'gray'} />
                    </div>

                    {/* Actions */}
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
                                is for fine pointers only; coarse pointers get the select + «Asignar» / ✕ instructions. */}
                            <p className="hidden pointer-fine:flex items-start gap-2 text-xs text-gray-500 leading-relaxed" data-testid="lodging-dnd-hint">
                                <i className="fa-solid fa-hand-pointer text-blue-500 mt-0.5" aria-hidden="true"></i>
                                <span>Arrastra un participante a una habitación, o entre habitaciones; suéltalo en «Sin habitación» para liberar la cama.</span>
                            </p>
                            <p className="hidden pointer-coarse:flex items-start gap-2 text-xs text-gray-500 leading-relaxed" data-testid="lodging-touch-hint">
                                <i className="fa-solid fa-hand-pointer text-blue-500 mt-0.5" aria-hidden="true"></i>
                                <span>Usa «Elige habitación…» y «Asignar» para colocar a un participante; ✕ en su nombre para liberar la cama.</span>
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
                <>
                    {/* Rooms grid, one card per hotel */}
                    <div className="space-y-6 sm:space-y-8" data-testid="lodging-rooms">
                        {hotels.map((hotel) => (
                            /* The admin LodgingPage hotel card: rounded-[40px], gradient corner, 20×20 gradient tile, info chips. */
                            <div key={hotel.name} className="group bg-white rounded-[40px] border-2 border-gray-50 overflow-hidden shadow-sm hover:border-blue-500 hover:shadow-2xl transition-all duration-500 relative">
                                <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-br from-blue-50 to-transparent rounded-bl-[100px] opacity-50 pointer-events-none"></div>
                                <div className="relative p-6 sm:p-8 border-b border-gray-50 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                                    <div className="flex items-center gap-4 sm:gap-6 min-w-0">
                                        <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl shadow-inner flex items-center justify-center text-blue-600 text-2xl sm:text-3xl shrink-0 group-hover:scale-110 transition-transform duration-500">
                                            <i className="fa-solid fa-hotel"></i>
                                        </div>
                                        <div className="min-w-0">
                                            <h2 className={cx("text-2xl sm:text-3xl leading-none mb-2 truncate", headingCls)}>{hotel.name}</h2>
                                            <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                                                <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-100">
                                                    <i className="fa-solid fa-door-open text-[10px] text-gray-400"></i>
                                                    <span className="text-xs font-bold text-gray-600 uppercase tracking-widest">{hotel.rooms.length} habitaciones</span>
                                                </div>
                                                <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 rounded-lg border border-blue-100 text-blue-600">
                                                    <i className="fa-solid fa-bed text-[10px]"></i>
                                                    <span className="text-xs font-black uppercase tracking-widest">{hotel.rooms.reduce((n, r) => n + freeBeds(r), 0)} camas libres</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div className="p-5 sm:p-8 bg-gray-50/30 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {hotel.rooms.map((room) => {
                                        const occ = Array.isArray(room.occupants) ? room.occupants : [];
                                        const full = freeBeds(room) === 0;
                                        const cap = Number(room.capacity) || 0;
                                        const taken = Number(room.occupied) || occ.length;
                                        const percent = cap > 0 ? Math.min(100, (taken / cap) * 100) : 0;
                                        return (
                                            <div
                                                key={room.id}
                                                className={cx("group/room p-5 rounded-3xl border-2 transition-all duration-300 relative overflow-hidden flex flex-col gap-4", full ? 'bg-white border-rose-100 shadow-sm' : 'bg-white border-white shadow-sm hover:border-blue-400 hover:shadow-xl hover:-translate-y-1', dropRing(room.id))}
                                                data-testid={`lodging-drop-room-${room.id}`}
                                                {...(editable ? dropTargetProps(room.id) : {})}
                                            >
                                                <div className="flex justify-between items-start gap-2">
                                                    <div className="min-w-0">
                                                        <span className={cx("text-xl", headingCls)}>Hab. {String(room.room_number ?? '')}</span>
                                                        {!!room.is_family && (
                                                            <div className="mt-1 max-w-full truncate px-1.5 py-0.5 rounded-md bg-indigo-50 text-indigo-600 text-[8px] font-black uppercase tracking-widest">
                                                                <i className="fa-solid fa-people-roof mr-1"></i>Familiar{room.family_name ? ` · ${room.family_name}` : ''}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <span className="text-xs font-bold text-gray-900 shrink-0">{taken}<span className="text-gray-300">/</span>{cap}</span>
                                                </div>
                                                <div className="space-y-2">
                                                    <div className="flex justify-between items-end">
                                                        <span className={cx("text-[10px] font-black uppercase tracking-widest", full ? 'text-rose-500' : 'text-gray-400')}>{full ? 'Completa' : 'Libre'}</span>
                                                        <span className={captionCls}>{freeBeds(room)} libres</span>
                                                    </div>
                                                    <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                                                        <div className={cx("h-full rounded-full transition-all duration-500", full ? 'bg-rose-500' : 'bg-blue-500')} style={{ width: `${percent}%` }}></div>
                                                    </div>
                                                </div>
                                                {occ.length === 0 ? (
                                                    <div className={cx(captionCls, "italic")}>Vacía</div>
                                                ) : (
                                                    <ul className="flex flex-wrap gap-2">
                                                        {occ.map((a) => (
                                                            <li
                                                                key={a.id}
                                                                className={cx("inline-flex items-center gap-2 max-w-full pr-1.5 py-1 rounded-full bg-gray-50 border border-gray-100 text-xs font-bold text-gray-800", editable ? 'pl-2' : 'pl-3', canDrag && 'pointer-fine:cursor-grab pointer-fine:select-none', dragging?.id === a.id && 'opacity-60 cursor-grabbing')}
                                                                data-testid={`lodging-chip-${a.id}`}
                                                                {...chipDragProps(a.id, room.id)}
                                                            >
                                                                {editable && <i className="fa-solid fa-grip-vertical text-[9px] text-gray-300 shrink-0 pointer-coarse:hidden" aria-hidden="true"></i>}
                                                                <span className="truncate">{attendeeName(a)}{a.family_group ? <span className="text-[10px] text-gray-400 font-medium ml-1">· {String(a.family_group)}</span> : null}</span>
                                                                {editable && (
                                                                    <button type="button" onClick={() => assign(a.id, null)} disabled={busy} title="Quitar de la habitación" className="w-6 h-6 rounded-full flex items-center justify-center bg-white text-gray-400 hover:bg-rose-600 hover:text-white transition-all shadow-sm shrink-0 disabled:opacity-50 disabled:cursor-not-allowed" aria-label={`Quitar a ${attendeeName(a)} de la habitación`}>
                                                                        <i className="fa-solid fa-xmark text-[9px]"></i>
                                                                    </button>
                                                                )}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                                {full && <div className="absolute inset-0 bg-rose-50/10 pointer-events-none"></div>}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Unassigned — also the drop target that frees a bed (dashed outline while editable) */}
                    <Card
                        className={cx("transition-all duration-300", editable && 'outline-2 outline-dashed -outline-offset-2', editable && unassignedOutline())}
                        data-testid="lodging-drop-unassigned"
                        {...(editable ? dropTargetProps(null) : {})}
                    >
                        <CardHeader icon="fa-user-clock" tone="amber" title="Sin habitación" caption={`${unassigned.length} participantes`} />
                        {unassigned.length === 0 ? (
                            <div className="p-8 text-center">
                                <p className="text-sm font-bold text-gray-500">Todos los participantes tienen habitación.</p>
                            </div>
                        ) : (
                            <ul className="divide-y divide-gray-50" data-testid="lodging-unassigned">
                                {unassigned.map((a) => (
                                    <li key={a.id} className="px-5 sm:px-8 py-4 flex flex-col sm:flex-row sm:items-center gap-3 hover:bg-blue-50/30 transition-colors">
                                        {/* The draggable chip is the name block, not the row: the select must keep its own pointer. */}
                                        <div
                                            className={cx("flex-1 min-w-0 flex items-center gap-3 rounded-xl", canDrag && 'pointer-fine:cursor-grab pointer-fine:select-none', dragging?.id === a.id && 'opacity-60 cursor-grabbing')}
                                            data-testid={`lodging-chip-${a.id}`}
                                            {...chipDragProps(a.id, null)}
                                        >
                                            {editable && <i className="fa-solid fa-grip-vertical text-xs text-gray-300 shrink-0 pointer-coarse:hidden" aria-hidden="true"></i>}
                                            <div className="min-w-0">
                                                <div className="font-black text-gray-900 truncate">{attendeeName(a)}</div>
                                                <div className={cx(captionCls, "mt-0.5")}>{[a.gender, a.family_group].filter((v) => v != null && String(v).trim() !== '').map(String).join(' · ')}</div>
                                            </div>
                                        </div>
                                        {editable && (() => {
                                            // A pick survives refetches; once its room filled up it is no longer an option
                                            // (the select would show the first one) — treat it as "nothing chosen".
                                            const chosen = spaceRooms.some((r) => String(r.id) === pick[a.id]) ? pick[a.id] : '';
                                            return (
                                            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:shrink-0">
                                                <select
                                                    className={cx(inputDenseCls, "sm:w-64")}
                                                    value={chosen}
                                                    onChange={(e) => setPick({ ...pick, [a.id]: e.target.value })}
                                                    aria-label={`Habitación para ${attendeeName(a)}`}
                                                >
                                                    <option value="">Elige habitación…</option>
                                                    {spaceRooms.map((r) => <option key={r.id} value={String(r.id)}>{roomLabel(r)} ({freeBeds(r)} libres)</option>)}
                                                </select>
                                                <Button
                                                    size="xs"
                                                    icon="fa-bed"
                                                    disabled={busy || !chosen}
                                                    onClick={() => { const id = Number(chosen); if (id > 0) assign(a.id, id); }}
                                                >
                                                    Asignar
                                                </Button>
                                            </div>
                                            );
                                        })()}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {editable && unassigned.length > 0 && spaceRooms.length === 0 && (
                            <div className="px-5 sm:px-8 pb-5">
                                <Notice tone="rose" icon="fa-bed" className="text-xs">No quedan camas libres en tus habitaciones; pide al administrador más habitaciones.</Notice>
                            </div>
                        )}
                    </Card>
                </>
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
                                onCancel={() => setEditor(null)}
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
                    onClose={() => setConfirm(null)}
                    footer={(
                        <>
                            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancelar</Button>
                            <Button variant={confirm.danger ? 'danger' : 'primary'} onClick={() => { const ok = confirm.onOk; setConfirm(null); ok(); }}>{confirm.okLabel}</Button>
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

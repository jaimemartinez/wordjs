"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/contexts/ToastContext";
import {
    attendeeName,
    canEditLodging,
    deadlineMessage,
    deadlineState,
    emptyPredicate,
    emptyRuleForm,
    fmtTimestamp,
    freeBeds,
    lodgingSummary,
    normalizeLodgingStatus,
    opNeedsNoValue,
    portalErrorMessage,
    PRED_OPS,
    roomLabel,
    roomsWithSpace,
    RULE_TYPE_OPTIONS,
    ruleFieldOptions,
    ruleFormToBody,
    ruleSummary,
    ruleToForm,
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

const API = '/api/v1/plugin/conference-manager';

type HeaderMap = Record<string, string>;

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
            return <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center text-gray-500">Cargando hospedaje…</div>;
        }
        return (
            <div className="bg-white rounded-xl border border-rose-200 shadow-sm p-8 text-center" data-testid="lodging-error">
                <i className="fa-solid fa-triangle-exclamation text-rose-400 text-2xl mb-3"></i>
                <p className="text-gray-800 font-medium">No se pudo cargar el hospedaje.</p>
                <p className="text-sm text-gray-500 mt-1">{loadError}</p>
                <button type="button" onClick={() => { setLoading(true); load(); }} className="mt-4 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition">
                    <i className="fa-solid fa-rotate-right mr-1"></i> Reintentar
                </button>
            </div>
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

    const assign = (inscriptionId: number, roomId: number | null) =>
        act('/portal/lodging/assign', { inscription_id: inscriptionId, room_id: roomId }, {
            okMessage: roomId == null ? 'Participante sin habitación.' : 'Participante asignado.',
            // Forget the room picked for this attendee — the select is gone once they are placed.
            onOk: () => setPick((prev) => { const next = { ...prev }; delete next[inscriptionId]; return next; }),
        });

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

    const btn = 'px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed';

    return (
        <div className="space-y-6" data-testid="portal-lodging">
            {/* Status banner */}
            <div className={`rounded-xl border p-4 flex flex-col gap-3 ${status === 'validated' ? 'bg-emerald-50 border-emerald-200' : status === 'submitted' ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'}`} data-testid="lodging-status">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold ${status === 'validated' ? 'bg-emerald-100 text-emerald-800' : status === 'submitted' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-700'}`}>
                            <i className={`fa-solid ${status === 'validated' ? 'fa-circle-check' : status === 'submitted' ? 'fa-paper-plane' : 'fa-pen'} text-[10px]`}></i>
                            {statusLabel(status)}
                        </span>
                        {status === 'submitted' && d.submitted_at && <span className="text-xs text-gray-500">Enviado el {fmtTimestamp(d.submitted_at)}</span>}
                        {status === 'validated' && d.reviewed_at && <span className="text-xs text-gray-500">Validado el {fmtTimestamp(d.reviewed_at)}</span>}
                    </div>
                    {status === 'submitted' && deadlineState(d) !== 'passed' && (
                        <button type="button" onClick={withdraw} disabled={busy} className={`${btn} border border-blue-300 text-blue-700 hover:bg-blue-100`}>
                            <i className="fa-solid fa-rotate-left"></i> Retirar envío
                        </button>
                    )}
                    {status === 'validated' && <span className="text-xs text-emerald-800 font-medium">Solo lectura. Para cambiar la acomodación, pide al administrador reabrir el hospedaje.</span>}
                </div>
                {deadlineMessage(d) && (
                    <div className={`rounded-lg border text-sm px-4 py-3 flex items-start gap-2 ${deadlineState(d) === 'passed' ? 'bg-rose-50 border-rose-200 text-rose-900' : 'bg-blue-50 border-blue-200 text-blue-900'}`} data-testid="lodging-deadline">
                        <i className={`fa-solid ${deadlineState(d) === 'passed' ? 'fa-lock' : 'fa-calendar-check'} mt-0.5`}></i>
                        <span>{deadlineMessage(d)}</span>
                    </div>
                )}
                {status === 'draft' && d.note && (
                    <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm px-4 py-3" data-testid="lodging-note">
                        <span className="font-semibold">Observaciones del administrador:</span> {String(d.note)}
                    </div>
                )}
                {status !== 'draft' && summary.unplaced > 0 && (
                    <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm px-4 py-3">
                        <span className="font-semibold">{unassignedLabel(summary.unplaced)}.</span> {unassignedHint(status)}
                    </div>
                )}
            </div>

            {!hasRooms ? (
                <div className="bg-white rounded-xl border border-dashed border-gray-300 p-10 text-center" data-testid="lodging-empty">
                    <i className="fa-solid fa-bed text-gray-300 text-3xl mb-3"></i>
                    <p className="text-gray-600 font-medium">El administrador aún no te ha asignado habitaciones.</p>
                </div>
            ) : (
                <>
                    {/* Summary */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="lodging-summary">
                        <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                            <div className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-1">Habitaciones</div>
                            <div className="text-2xl font-black text-gray-800">{summary.rooms}</div>
                        </div>
                        <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                            <div className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-1">Camas</div>
                            <div className="text-2xl font-black text-gray-800">{summary.beds} <span className="text-xs text-gray-400 font-medium">({summary.free} libres)</span></div>
                        </div>
                        <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                            <div className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-1">Alojados</div>
                            <div className="text-2xl font-black text-emerald-600">{summary.placed}</div>
                        </div>
                        <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                            <div className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-1">Sin habitación</div>
                            <div className={`text-2xl font-black ${summary.unplaced > 0 ? 'text-rose-500' : 'text-gray-800'}`}>{summary.unplaced}</div>
                        </div>
                    </div>

                    {/* Actions */}
                    {editable && (
                        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3" data-testid="lodging-actions">
                            <div className="flex flex-wrap gap-2">
                                <button type="button" onClick={runAuto} disabled={busy || unassigned.length === 0} title={unassigned.length === 0 ? 'No hay participantes sin habitación.' : undefined} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}>
                                    <i className="fa-solid fa-wand-magic-sparkles"></i> Asignación automática
                                </button>
                                <button type="button" onClick={askReset} disabled={busy || summary.placed === 0} className={`${btn} border border-gray-300 text-gray-700 hover:bg-gray-100`}>
                                    <i className="fa-solid fa-broom"></i> Quitar todas las asignaciones
                                </button>
                                <button type="button" onClick={askSubmit} disabled={busy} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700 sm:ml-auto`}>
                                    <i className="fa-solid fa-paper-plane"></i> Enviar a validación
                                </button>
                            </div>
                            {runResult && (
                                <div className="rounded-lg bg-blue-50 border border-blue-100 text-sm text-gray-700 px-4 py-3" data-testid="lodging-run-result">
                                    <div><b className="text-gray-900">{runResult.assignedCount ?? 0}</b> asignados · <b className="text-gray-900">{runResult.remaining ?? 0}</b> sin asignar</div>
                                    {(runResult.violations || []).length > 0 && (
                                        <ul className="mt-2 space-y-1">
                                            {(runResult.violations || []).map((v, i) => { const t = violationText(v); return <li key={i} className={`text-xs ${t.hard ? 'text-rose-700' : 'text-amber-700'}`}><i className="fa-solid fa-triangle-exclamation mr-1"></i>{t.text}</li>; })}
                                        </ul>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}

            {/* Violations of the current arrangement — always visible when there are any. */}
            {violations.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4" data-testid="lodging-violations">
                    <h3 className="font-bold text-gray-800 mb-2 text-sm">Reglas incumplidas <span className="text-xs text-gray-400 font-medium">({summary.hardViolations} obligatorias · {summary.softViolations} preferentes)</span></h3>
                    <ul className="space-y-1">
                        {violations.map((v, i) => {
                            const t = violationText(v);
                            return (
                                <li key={i} className={`text-sm px-3 py-1.5 rounded-lg ${t.hard ? 'bg-rose-50 text-rose-800' : 'bg-amber-50 text-amber-800'}`}>
                                    <span className={`text-[10px] font-bold uppercase tracking-wider mr-2 ${t.hard ? 'text-rose-500' : 'text-amber-600'}`}>{t.hard ? 'Obligatoria' : 'Preferente'}</span>{t.text}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            {hasRooms && (
                <>
                    {/* Rooms grid */}
                    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                        <div className="p-4 border-b border-gray-200 bg-gray-50/50"><h2 className="font-bold text-gray-800">Habitaciones</h2></div>
                        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="lodging-rooms">
                            {rooms.map((room) => {
                                const occ = Array.isArray(room.occupants) ? room.occupants : [];
                                const full = freeBeds(room) === 0;
                                return (
                                    <div key={room.id} className={`rounded-xl border p-4 ${full ? 'border-gray-300 bg-gray-50' : 'border-gray-200 bg-white'}`}>
                                        <div className="flex items-start justify-between gap-2 mb-2">
                                            <div>
                                                <div className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider">{room.hotel_name || 'Hotel'}</div>
                                                <div className="font-bold text-gray-900">Hab. {String(room.room_number ?? '')}</div>
                                                {!!room.is_family && <div className="text-[11px] text-purple-700 bg-purple-50 rounded px-1.5 py-0.5 inline-block mt-1">Familiar{room.family_name ? ` · ${room.family_name}` : ''}</div>}
                                            </div>
                                            <span className={`text-xs font-bold px-2 py-1 rounded-md ${full ? 'bg-gray-200 text-gray-700' : 'bg-emerald-50 text-emerald-700'}`}>{Number(room.occupied) || occ.length}/{Number(room.capacity) || 0}</span>
                                        </div>
                                        {occ.length === 0 ? (
                                            <div className="text-xs text-gray-400 italic">Vacía</div>
                                        ) : (
                                            <ul className="space-y-1">
                                                {occ.map((a) => (
                                                    <li key={a.id} className="flex items-center justify-between gap-2 text-sm text-gray-800 bg-gray-50 rounded-lg px-2.5 py-1.5">
                                                        <span className="truncate">{attendeeName(a)}{a.family_group ? <span className="text-[11px] text-gray-400 ml-1">· {String(a.family_group)}</span> : null}</span>
                                                        {editable && (
                                                            <button type="button" onClick={() => assign(a.id, null)} disabled={busy} title="Quitar de la habitación" className="text-gray-400 hover:text-rose-600 disabled:opacity-50 px-1" aria-label={`Quitar a ${attendeeName(a)} de la habitación`}>✕</button>
                                                        )}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Unassigned */}
                    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                        <div className="p-4 border-b border-gray-200 bg-gray-50/50 flex items-center justify-between">
                            <h2 className="font-bold text-gray-800">Sin habitación <span className="text-xs text-gray-400 font-medium">({unassigned.length})</span></h2>
                        </div>
                        {unassigned.length === 0 ? (
                            <div className="p-6 text-center text-sm text-gray-500">Todos los participantes tienen habitación.</div>
                        ) : (
                            <ul className="divide-y divide-gray-100" data-testid="lodging-unassigned">
                                {unassigned.map((a) => (
                                    <li key={a.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                                        <div className="flex-1 min-w-[10rem]">
                                            <div className="font-medium text-gray-900">{attendeeName(a)}</div>
                                            <div className="text-[11px] text-gray-400">{[a.gender, a.family_group].filter((v) => v != null && String(v).trim() !== '').map(String).join(' · ')}</div>
                                        </div>
                                        {editable && (() => {
                                            // A pick survives refetches; once its room filled up it is no longer an option
                                            // (the select would show the first one) — treat it as "nothing chosen".
                                            const chosen = spaceRooms.some((r) => String(r.id) === pick[a.id]) ? pick[a.id] : '';
                                            return (
                                            <div className="flex items-center gap-2">
                                                <select
                                                    className="border rounded-lg p-2 text-sm bg-white"
                                                    value={chosen}
                                                    onChange={(e) => setPick({ ...pick, [a.id]: e.target.value })}
                                                    aria-label={`Habitación para ${attendeeName(a)}`}
                                                >
                                                    <option value="">Elige habitación…</option>
                                                    {spaceRooms.map((r) => <option key={r.id} value={String(r.id)}>{roomLabel(r)} ({freeBeds(r)} libres)</option>)}
                                                </select>
                                                <button
                                                    type="button"
                                                    disabled={busy || !chosen}
                                                    onClick={() => { const id = Number(chosen); if (id > 0) assign(a.id, id); }}
                                                    className={`${btn} bg-blue-600 text-white hover:bg-blue-700 py-2`}
                                                >
                                                    Asignar
                                                </button>
                                            </div>
                                            );
                                        })()}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {editable && unassigned.length > 0 && spaceRooms.length === 0 && (
                            <div className="px-4 pb-4 text-xs text-rose-600">No quedan camas libres en tus habitaciones; pide al administrador más habitaciones.</div>
                        )}
                    </div>
                </>
            )}

            {/* Placed by the admin in pool rooms — read-only */}
            {elsewhere.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" data-testid="lodging-elsewhere">
                    <div className="p-4 border-b border-gray-200 bg-gray-50/50">
                        <h2 className="font-bold text-gray-800">Alojados por el administrador <span className="text-xs text-gray-400 font-medium">({elsewhere.length})</span></h2>
                        <p className="text-xs text-gray-500 mt-0.5">Participantes de tu localidad ubicados en habitaciones fuera de tu cupo; solo el administrador puede moverlos.</p>
                    </div>
                    <ul className="divide-y divide-gray-100">
                        {elsewhere.map((p) => (
                            <li key={p.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
                                <span className="font-medium text-gray-900">{attendeeName(p)}</span>
                                <span className="text-gray-500">{roomLabel(p)}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Rules */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" data-testid="lodging-rules">
                <div className="p-4 border-b border-gray-200 bg-gray-50/50">
                    <h2 className="font-bold text-gray-800">Reglas de asignación</h2>
                    <p className="text-xs text-gray-500 mt-0.5">La asignación automática aplica las reglas del administrador y las tuyas, por prioridad.</p>
                </div>
                <div className="p-4 space-y-5">
                    <div>
                        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Reglas del administrador</h3>
                        {adminRules.length === 0 ? (
                            <div className="text-sm text-gray-400 italic">El administrador no ha definido reglas.</div>
                        ) : (
                            <ul className="space-y-1.5">
                                {adminRules.map((r) => (
                                    <li key={r.id} className="rounded-lg bg-gray-50 px-3 py-2 text-sm">
                                        <div className="font-medium text-gray-800">{r.name}</div>
                                        <div className="text-xs text-gray-500">{ruleSummary(r, fields)}</div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Mis reglas</h3>
                            {hasRooms && editable && !editor && (
                                <button type="button" onClick={() => setEditor({ id: null, form: emptyRuleForm() })} disabled={busy} className={`${btn} border border-blue-300 text-blue-700 hover:bg-blue-50 py-1.5`}>
                                    <i className="fa-solid fa-plus"></i> Nueva regla
                                </button>
                            )}
                        </div>
                        {myRules.length === 0 && !(editor && editable) ? (
                            <div className="text-sm text-gray-400 italic">Aún no tienes reglas propias.</div>
                        ) : (
                            <ul className="space-y-1.5">
                                {myRules.map((r) => (
                                    <li key={r.id} className={`rounded-lg px-3 py-2 text-sm flex items-start justify-between gap-3 ${Number(r.enabled) === 0 ? 'bg-gray-50 opacity-70' : 'bg-blue-50/60'}`}>
                                        <div className="min-w-0">
                                            <div className="font-medium text-gray-800 truncate">{r.name}</div>
                                            <div className="text-xs text-gray-500">{ruleSummary(r, fields)}</div>
                                        </div>
                                        {editable && (
                                            <div className="flex items-center gap-1 shrink-0">
                                                <button type="button" onClick={() => setEditor({ id: r.id, form: ruleToForm(r) })} disabled={busy} className="text-gray-500 hover:text-blue-600 p-1.5 disabled:opacity-50" title="Editar" aria-label={`Editar regla ${r.name}`}><i className="fa-solid fa-pen"></i></button>
                                                <button type="button" onClick={() => askDeleteRule(r)} disabled={busy} className="text-gray-500 hover:text-rose-600 p-1.5 disabled:opacity-50" title="Eliminar" aria-label={`Eliminar regla ${r.name}`}><i className="fa-solid fa-trash-can"></i></button>
                                            </div>
                                        )}
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
            </div>

            {confirm && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200" role="dialog" aria-modal="true">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="px-6 py-5 border-b border-gray-100"><h3 className="font-bold text-lg text-gray-900">{confirm.title}</h3></div>
                        <div className="px-6 py-5 text-sm text-gray-700">{confirm.text}</div>
                        <div className="px-6 py-4 flex justify-end gap-3 bg-gray-50/50">
                            <button type="button" onClick={() => setConfirm(null)} className="px-5 py-2 text-gray-600 font-medium hover:bg-gray-100 rounded-lg transition">Cancelar</button>
                            <button type="button" onClick={() => { const ok = confirm.onOk; setConfirm(null); ok(); }} className={`px-5 py-2 text-white font-bold rounded-lg transition ${confirm.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700'}`}>{confirm.okLabel}</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Module-level (never define a component inside a component — it steals input focus).
function PredicateRow({ label, value, fields, onChange }: { label: string; value: RulePredicate; fields: { name: string; label: string }[]; onChange: (p: RulePredicate) => void }) {
    return (
        <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select className="border rounded-lg p-2 text-sm bg-white" value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })}>
                    <option value="">Campo…</option>
                    {fields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                </select>
                <select className="border rounded-lg p-2 text-sm bg-white" value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value, value: opNeedsNoValue(e.target.value) ? '' : value.value })}>
                    {PRED_OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
                <input className="border rounded-lg p-2 text-sm disabled:bg-gray-100" placeholder="Valor" maxLength={200} disabled={opNeedsNoValue(value.op)} value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} />
            </div>
        </div>
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
    return (
        <form className="mt-3 rounded-xl border border-blue-200 bg-blue-50/40 p-4 space-y-3" onSubmit={(e) => { e.preventDefault(); onSave(); }} data-testid="lodging-rule-editor">
            <div className="font-bold text-gray-800 text-sm">{editor.id == null ? 'Nueva regla' : 'Editar regla'}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Nombre</label>
                    <input className="w-full border rounded-lg p-2 text-sm" maxLength={100} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="p. ej. Familias juntas" required />
                </div>
                <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Tipo</label>
                    <select className="w-full border rounded-lg p-2 text-sm bg-white" value={form.type} onChange={(e) => {
                        const type = e.target.value as RuleType;
                        set({ type, subject: type === 'require_companion' ? form.subject : emptyPredicate(), needs: type === 'require_companion' ? form.needs : emptyPredicate() });
                    }}>
                        {RULE_TYPE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                    </select>
                    {typeMeta && <p className="text-[11px] text-gray-500 mt-1">{typeMeta.desc}</p>}
                </div>
            </div>
            {form.type !== 'require_companion' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Campo</label>
                        <select className="w-full border rounded-lg p-2 text-sm bg-white" value={form.config} onChange={(e) => set({ config: e.target.value })} required>
                            <option value="">Elige un campo…</option>
                            {options.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                        </select>
                    </div>
                    {form.type === 'keep_together' && (
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Tamaño mínimo del grupo</label>
                            <input type="number" min={1} step={1} className="w-full border rounded-lg p-2 text-sm" value={form.min_size} onChange={(e) => set({ min_size: e.target.value })} placeholder="1" />
                        </div>
                    )}
                </div>
            ) : (
                <div className="space-y-3">
                    <PredicateRow label="Si en la habitación hay alguien que cumple…" value={form.subject} fields={options} onChange={(subject) => set({ subject })} />
                    <PredicateRow label="…debe haber acompañantes que cumplan" value={form.needs} fields={options} onChange={(needs) => set({ needs })} />
                    <div className="sm:w-48">
                        <label className="block text-xs font-medium text-gray-600 mb-1">Acompañantes mínimos</label>
                        <input type="number" min={1} step={1} className="w-full border rounded-lg p-2 text-sm" value={form.min} onChange={(e) => set({ min: e.target.value })} placeholder="1" />
                    </div>
                </div>
            )}
            <div className="flex flex-wrap items-center gap-4">
                <div className="w-32">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Prioridad</label>
                    <input type="number" step={1} className="w-full border rounded-lg p-2 text-sm" value={form.priority} onChange={(e) => set({ priority: e.target.value })} />
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700 mt-4">
                    <input type="checkbox" className="w-4 h-4 rounded border-gray-300" checked={form.hard} onChange={(e) => set({ hard: e.target.checked })} /> Obligatoria (nunca se incumple)
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700 mt-4">
                    <input type="checkbox" className="w-4 h-4 rounded border-gray-300" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Activa
                </label>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-blue-100">
                <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition">Cancelar</button>
                <button type="submit" disabled={busy} className="px-4 py-2 text-sm bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition disabled:opacity-50">{editor.id == null ? 'Crear regla' : 'Guardar regla'}</button>
            </div>
        </form>
    );
}

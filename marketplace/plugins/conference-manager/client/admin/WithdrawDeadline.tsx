// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Los encargados pueden retirar inscripciones hasta» (conference-manager 2.36.6), in Localidades under the lodging
 * dates: the date and hour until which a coordinator may withdraw one of their location's registrations from the
 * portal (never one with a payment recorded). Empty = they cannot. The admin's calendar (DateField, the host's
 * DateTimePicker); the hour is this browser's zone, stored with it like the lodging dates (lodging_tz).
 */
import React, { useEffect, useState } from "react";
import { DateField } from "../lib/DateField";
import { conferenceApi } from "../lib/conference";

type Tx = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** «2026-10-30T18:00» → «30/10/2026 18:00». */
const shown = (v: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v || ''); return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : v; };

export function WithdrawDeadlineSetting({ conferenceId, value, canEdit, tx, addToast, onSaved }: {
    conferenceId: number; value: string | null | undefined; canEdit: boolean; tx: Tx;
    addToast: (text: string, tone: string) => void; onSaved: () => void;
}) {
    const stored = String(value || '').slice(0, 16);
    const [input, setInput] = useState(stored);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => { setInput(stored); }, [stored]);
    const zone = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } };
    const save = async (next: string) => {
        setSaving(true); setError('');
        try {
            await conferenceApi.updateConference(conferenceId, { withdraw_until: next || null, ...(zone() ? { lodging_tz: zone() } : {}) } as any);
            addToast(tx('withdraw.saved', 'Plazo para retirar inscripciones guardado'), 'success');
            onSaved();
        } catch (e: any) { setError(e?.message || 'Error'); }
        finally { setSaving(false); }
    };
    const open = !!stored && new Date(stored).getTime() > Date.now();
    const line = !stored
        ? tx('withdraw.state.none', 'Sin fecha: los encargados no pueden retirar inscripciones (solo el administrador).')
        : open
            ? tx('withdraw.state.open', 'Abierto: los encargados pueden retirar inscripciones hasta el {date}.', { date: shown(stored) })
            : tx('withdraw.state.passed', 'Venció el {date}: solo el administrador puede retirar inscripciones.', { date: shown(stored) });
    return (
        <div className={`flex flex-col gap-4 xl:flex-row xl:items-center justify-between p-6 sm:p-8 rounded-[32px] border-2 shadow-sm ${open ? 'bg-blue-50/40 border-blue-100' : 'bg-gray-50/50 border-white'}`} data-testid="withdraw-deadline">
            <div className="flex items-start gap-4 flex-1">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-lg shadow-inner shrink-0 bg-blue-100 text-blue-600"><i className="fa-solid fa-user-minus" aria-hidden="true"></i></div>
                <div>
                    <h3 className="text-xl font-black text-gray-900 italic tracking-tighter">{tx('withdraw.title', 'Los encargados pueden retirar inscripciones hasta')}</h3>
                    <p className={`text-xs font-bold mt-1 ${open ? 'text-blue-700' : 'text-gray-500'}`} data-testid="withdraw-state">{line}</p>
                    <p className="text-[11px] text-gray-400 mt-1 leading-relaxed max-w-xl">
                        {tx('withdraw.help', 'Hasta esa fecha y hora cada encargado puede retirar, desde el portal, inscripciones de su localidad que no tengan pagos registrados. Una inscripción retirada sale de las listas, los cupos, el alojamiento y las comidas; queda registrado quién, cuándo y por qué, y aquí puedes restaurarla (filtro «Solo retiradas» en Inscripciones).')}
                    </p>
                    {error && <p className="text-xs font-bold text-rose-700 mt-1" role="alert">{error}</p>}
                </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[13rem]">
                    <label htmlFor="withdraw-until" className="block text-[9px] font-bold text-gray-500 uppercase tracking-widest ml-1">{tx('withdraw.label', 'Fecha y hora límite')}</label>
                    <DateField id="withdraw-until" withTime value={input} onChange={(v) => setInput(v)} disabled={!canEdit || saving} />
                </div>
                {canEdit && (
                    <>
                        <button type="button" onClick={() => save(input)} disabled={saving || input === stored}
                            className="px-5 py-3 rounded-2xl bg-blue-600 text-white hover:bg-blue-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-blue-500/30 disabled:opacity-50" data-action="withdraw-save">
                            {saving ? <i className="fa-solid fa-spinner animate-spin" aria-hidden="true"></i> : tx('withdraw.save', 'Guardar')}
                        </button>
                        {stored && (
                            <button type="button" onClick={() => { setInput(''); save(''); }} disabled={saving}
                                className="px-4 py-3 rounded-2xl bg-white border-2 border-gray-100 text-gray-700 hover:border-rose-300 font-black text-[10px] uppercase tracking-widest" data-action="withdraw-clear">
                                {tx('withdraw.clear', 'Quitar')}
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

export default WithdrawDeadlineSetting;

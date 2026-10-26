// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Cierre de inscripciones» (conference-manager 2.36.20), in «Campos»: the date and hour from which the
 * coordinators' portal registers nobody — the administration still can. Empty = no date (registrations stay open
 * while the form is published, until the day after the conference ends, as before). The admin's calendar
 * (DateField, the host's DateTimePicker); the hour is this browser's zone, stored with it like the other dates.
 */
import React, { useEffect, useState } from "react";
import { DateField } from "../lib/DateField";
import { conferenceApi } from "../lib/conference";

type Tx = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** «2026-10-30T18:00» → «30/10/2026 18:00». */
export const shownDateTime = (v: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v || ''); return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : v; };

export function RegistrationClosesSetting({ conferenceId, value, canEdit, tx, addToast, onSaved }: {
    conferenceId: number; value: string | null | undefined; canEdit: boolean; tx: Tx;
    addToast: (text: string, tone: string) => void; onSaved: (v: string | null) => void;
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
            await conferenceApi.updateConference(conferenceId, { registration_closes: next || null, ...(zone() ? { lodging_tz: zone() } : {}) } as any);
            addToast(next ? tx('regclose.saved', 'Cierre de inscripciones guardado') : tx('regclose.cleared', 'Se quitó la fecha de cierre de inscripciones'), 'success');
            onSaved(next || null);
        } catch (e: any) { setError(e?.message || 'Error'); }
        finally { setSaving(false); }
    };
    const open = !stored || new Date(stored).getTime() > Date.now();
    const line = !stored
        ? tx('regclose.state.none', 'Sin fecha: los encargados pueden inscribir mientras el formulario esté publicado.')
        : open
            ? tx('regclose.state.open', 'Abiertas hasta el {date}. Después, solo la administración puede inscribir.', { date: shownDateTime(stored) })
            : tx('regclose.state.closed', 'Cerradas desde el {date}: los encargados ya no pueden inscribir; la administración sí.', { date: shownDateTime(stored) });
    return (
        <div className={`flex flex-col gap-4 xl:flex-row xl:items-center justify-between p-6 sm:p-8 rounded-[32px] border-2 shadow-sm ${stored && !open ? 'bg-rose-50/40 border-rose-100' : 'bg-gray-50/50 border-white'}`} data-testid="registration-closes">
            <div className="flex items-start gap-4 flex-1">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-lg shadow-inner shrink-0 ${stored && !open ? 'bg-rose-100 text-rose-600' : 'bg-blue-100 text-blue-600'}`}><i className="fa-solid fa-calendar-xmark" aria-hidden="true"></i></div>
                <div>
                    <h3 className="text-xl font-black text-gray-900 italic tracking-tighter">{tx('regclose.title', 'Cierre de inscripciones')}</h3>
                    <p className={`text-xs font-bold mt-1 ${stored && !open ? 'text-rose-700' : stored ? 'text-blue-700' : 'text-gray-500'}`} data-testid="registration-closes-state">{line}</p>
                    <p className="text-[11px] text-gray-400 mt-1 leading-relaxed max-w-xl">
                        {tx('regclose.help', 'Desde esa fecha y hora los encargados ya no pueden registrar personas en el portal (verán que las inscripciones cerraron). La administración puede seguir inscribiendo. Sin fecha, las inscripciones cierran al día siguiente del fin de la conferencia o al despublicar el formulario.')}
                    </p>
                    {error && <p className="text-xs font-bold text-rose-700 mt-1" role="alert">{error}</p>}
                </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[13rem]">
                    <label htmlFor="registration-closes" className="block text-[9px] font-bold text-gray-500 uppercase tracking-widest ml-1">{tx('regclose.label', 'Fecha y hora de cierre')}</label>
                    <DateField id="registration-closes" withTime value={input} onChange={(v) => setInput(v)} disabled={!canEdit || saving} />
                </div>
                {canEdit && (
                    <>
                        <button type="button" onClick={() => save(input)} disabled={saving || input === stored}
                            className="px-5 py-3 rounded-2xl bg-blue-600 text-white hover:bg-blue-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-blue-500/30 disabled:opacity-50" data-action="regclose-save">
                            {saving ? <i className="fa-solid fa-spinner animate-spin" aria-hidden="true"></i> : tx('save', 'Guardar')}
                        </button>
                        {stored && (
                            <button type="button" onClick={() => { setInput(''); save(''); }} disabled={saving}
                                className="px-4 py-3 rounded-2xl bg-white border-2 border-gray-100 text-gray-700 hover:border-rose-300 font-black text-[10px] uppercase tracking-widest" data-action="regclose-clear">
                                {tx('regclose.clear', 'Quitar fecha')}
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/**
 * A locality's own «Cierre de inscripciones» (2.36.20), on its card in Localidades: the date in force — its own, or
 * the general one of «Campos» — with «Cambiar» to give it its own date and «Usar la general» to drop it.
 */
export function LocationRegistrationCloses({ loc, general, canEdit, tx, addToast, onSaved }: {
    loc: any; general: string | null | undefined; canEdit: boolean; tx: Tx;
    addToast: (text: string, tone: string) => void; onSaved: (v: string | null) => void;
}) {
    const own = String(loc.registration_closes || '').slice(0, 16);
    const gen = String(general || '').slice(0, 16);
    const inForce = own || gen;
    const [editing, setEditing] = useState(false);
    const [input, setInput] = useState(own || gen);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const save = async (next: string) => {
        setSaving(true); setError('');
        try {
            await conferenceApi.updateLocation(loc.id, { registration_closes: next || null } as any);
            addToast(next ? tx('regclose.loc.saved', 'Cierre propio de la localidad guardado') : tx('regclose.loc.general', 'La localidad usa el cierre general'), 'success');
            setEditing(false);
            onSaved(next || null);
        } catch (e: any) { setError(e?.message || 'Error'); }
        finally { setSaving(false); }
    };
    const closed = !!inForce && new Date(inForce).getTime() <= Date.now();
    const line = !inForce
        ? tx('regclose.loc.none', 'Sin fecha de cierre')
        : own
            ? tx('regclose.loc.own', 'Propia: {date}', { date: shownDateTime(own) })
            : tx('regclose.loc.from.general', 'General: {date}', { date: shownDateTime(gen) });
    return (
        <div className={`p-3 bg-white rounded-xl border shadow-sm space-y-2 ${closed ? 'border-rose-100' : 'border-gray-50'}`} data-location-regclose={loc.id}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-sm ${closed ? 'bg-rose-50 text-rose-500' : 'bg-blue-50 text-blue-400'}`}><i className="fa-solid fa-calendar-xmark" aria-hidden="true"></i></div>
                <div className="min-w-[8rem] flex-1">
                    <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{tx('regclose.title', 'Cierre de inscripciones')}</div>
                    <div className={`text-xs font-black ${closed ? 'text-rose-700' : 'text-gray-700'}`} data-location-regclose-state={own ? 'own' : inForce ? 'general' : 'none'}>
                        {line}{closed ? ` · ${tx('regclose.loc.closed', 'cerradas')}` : ''}
                    </div>
                </div>
                {canEdit && !editing && (
                    <button type="button" className="shrink-0 ml-auto min-h-[36px] px-3 rounded-lg text-xs font-bold text-blue-600 hover:bg-blue-50" onClick={() => { setInput(own || gen); setEditing(true); }} data-location-regclose-edit="">
                        {tx('regclose.loc.change', 'Cambiar')}
                    </button>
                )}
            </div>
            {editing && (
                <div className="space-y-2">
                    <DateField id={`regclose-${loc.id}`} withTime value={input} onChange={(v) => setInput(v)} disabled={saving} />
                    <div className="flex flex-wrap justify-end gap-2">
                        {own && <button type="button" disabled={saving} className="min-h-[36px] px-3 rounded-lg text-xs font-bold text-gray-600 hover:bg-gray-100" onClick={() => save('')} data-location-regclose-general="">{tx('regclose.loc.use.general', 'Usar la general')}</button>}
                        <button type="button" disabled={saving} className="min-h-[36px] px-3 rounded-lg text-xs font-bold text-gray-500 hover:bg-gray-100" onClick={() => { setEditing(false); setError(''); }}>{tx('cancel', 'Cancelar')}</button>
                        <button type="button" disabled={saving || !input || input === own} className="min-h-[36px] px-4 rounded-lg text-xs font-bold bg-blue-600 text-white disabled:opacity-50" onClick={() => save(input)} data-location-regclose-save="">{tx('save', 'Guardar')}</button>
                    </div>
                    <p className="text-[10px] text-gray-400">{tx('regclose.loc.hint', 'Solo para esta localidad. Sin fecha propia, vale el cierre general de la sección «Campos».')}</p>
                </div>
            )}
            {error && <p className="text-xs font-semibold text-rose-600" role="alert">{error}</p>}
        </div>
    );
}

export default RegistrationClosesSetting;

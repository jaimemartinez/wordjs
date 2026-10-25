// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Editar encargado» (2.36.12): every piece of a locality's coordinator data — name, phone (country + number, the
 * same E.164 selector as every phone field) and «Correo del encargado» — in one sheet (a bottom sheet on a phone,
 * centred from 640 px). Only what changed is sent; errors are said under each field (the server's too), never in a
 * native dialog. Below, «Cambios del encargado»: who changed what and when (which fields, never the values).
 * A new e-mail after a welcome was sent says that the welcome went to the old one — the card then offers to send it.
 */
import React, { useMemo, useState } from "react";
import { conferenceApi } from "../lib/conference";
import { LAYER } from "../lib/overlay";
import { PhoneInput } from "../lib/PhoneInput";
import { coordinatorPatch, draftOf, welcomeState } from "../lib/coordinator";
import { Overlay } from "./Overlay";

const FIELD_OF = { responsible_name: 'name', responsible_phone: 'phone', responsible_email: 'email' };
const inputCls = 'w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-base sm:text-sm aria-[invalid=true]:border-rose-400';
const labelCls = 'block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1';

export function fieldLabel(tx, f: string) {
    return f === 'name' ? tx('loc.coord.name', 'Nombre') : f === 'phone' ? tx('loc.coord.phone', 'Teléfono') : f === 'email' ? tx('loc.coord.email', 'Correo') : f;
}

export function CoordinatorSheet({ loc, defaultCountry, lang, tx, onClose, onSaved, addToast }: any) {
    const [draft, setDraft] = useState(() => draftOf(loc));
    const [errors, setErrors] = useState<any>({});
    const [busy, setBusy] = useState(false);
    const { changed } = useMemo(() => coordinatorPatch(loc, draft, defaultCountry, tx), [loc, draft, defaultCountry, tx]);
    const set = (k: string, v: string) => { setDraft((d) => ({ ...d, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined, form: undefined })); };
    const emailChangedAfterWelcome = changed.includes('email') && !!loc.welcome_sent_s && !!draft.email.trim();
    const fmt = (s: number) => { try { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(s * 1000)); } catch { return new Date(s * 1000).toISOString(); } };

    const save = async () => {
        const check = coordinatorPatch(loc, draft, defaultCountry, tx);
        if (Object.keys(check.errors).length) { setErrors(check.errors); return; }
        if (!check.changed.length) { onClose(); return; }
        setBusy(true); setErrors({});
        try {
            const r: any = await conferenceApi.updateLocation(loc.id, check.patch as any);
            const next = { ...loc };
            for (const k of Object.keys(check.patch)) next[k] = (r && k in r ? r[k] : check.patch[k]) || null;
            // The «encargado editado» entry the server stored (who, when, which fields) heads the change log.
            if (r?.coordinator_entry) next.coordinator_log = [r.coordinator_entry, ...(loc.coordinator_log || [])].slice(0, 10);
            addToast && addToast(welcomeState(next) === 'stale'
                ? tx('loc.coord.saved.stale', 'Encargado actualizado. La bienvenida se envió al correo anterior: envíala al nuevo desde la tarjeta.')
                : tx('loc.coord.saved', 'Encargado actualizado.'), 'success');
            onSaved && onSaved(next);
            onClose();
        } catch (e: any) {
            const f = FIELD_OF[e?.data?.field || e?.field] || null;
            setErrors(f ? { [f]: e?.message || 'Error' } : { form: e?.message || 'Error' });
        } finally { setBusy(false); }
    };

    const id = (k: string) => `cm-coord-${loc.id}-${k}`;
    const err = (k: string) => errors[k] ? <p id={`${id(k)}-error`} role="alert" className="text-xs font-semibold text-rose-600 ml-1" data-coord-error={k}>{errors[k]}</p> : null;
    const log = Array.isArray(loc.coordinator_log) ? loc.coordinator_log : [];
    return (
        <Overlay layer={LAYER.modal} onBackdrop={busy ? undefined : onClose} onEscape={busy ? undefined : onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby={id('title')} data-coordinator-sheet={loc.id}
                className="bg-white rounded-[32px] shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden flex flex-col max-h-[92dvh]">
                <div className="bg-gray-50/50 px-5 sm:px-7 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h2 id={id('title')} className="font-black text-xl text-gray-900 italic tracking-tighter">{tx('loc.coord.title', 'Editar encargado')}</h2>
                        <p className="text-xs font-bold text-gray-500 truncate">{loc.name}</p>
                    </div>
                    <button type="button" onClick={onClose} disabled={busy} aria-label={tx('close', 'Cerrar')} className="shrink-0 w-11 h-11 flex items-center justify-center rounded-2xl text-gray-500 hover:bg-gray-100">
                        <i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i>
                    </button>
                </div>
                <form className="px-5 sm:px-7 py-5 overflow-y-auto space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
                    <div className="space-y-1.5">
                        <label htmlFor={id('name')} className={labelCls}>{tx('loc.coord.name', 'Nombre')}</label>
                        <input id={id('name')} type="text" autoComplete="off" value={draft.name} maxLength={160} onChange={(e) => set('name', e.target.value)}
                            className={inputCls} aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? `${id('name')}-error` : undefined} data-coord-field="name" />
                        {err('name')}
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor={id('phone')} className={labelCls}>{tx('loc.coord.phone', 'Teléfono')}</label>
                        <PhoneInput id={id('phone')} value={draft.phone} onChange={(v) => set('phone', v)} defaultCountry={defaultCountry} lang={lang}
                            label={tx('loc.coord.phone', 'Teléfono')} dataField="responsible_phone" invalid={!!errors.phone}
                            describedBy={errors.phone ? `${id('phone')}-error` : undefined} selectClassName={inputCls} inputClassName={inputCls} />
                        {err('phone')}
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor={id('email')} className={labelCls}>{tx('loc.mail', 'Correo del encargado')}</label>
                        <input id={id('email')} type="email" inputMode="email" autoComplete="off" value={draft.email} onChange={(e) => set('email', e.target.value)}
                            className={inputCls} placeholder="encargado@ejemplo.org" aria-invalid={errors.email ? true : undefined}
                            aria-describedby={errors.email ? `${id('email')}-error` : emailChangedAfterWelcome ? `${id('email')}-note` : undefined} data-coord-field="email" />
                        {err('email')}
                        {!errors.email && emailChangedAfterWelcome && (
                            <p id={`${id('email')}-note`} className="text-[11px] font-bold text-amber-700 ml-1" data-coord-note="welcome">
                                <i className="fa-solid fa-circle-info mr-1" aria-hidden="true"></i>
                                {tx('loc.coord.email.welcome', 'La bienvenida se envió al correo anterior. Después de guardar, envíala al nuevo desde la tarjeta.')}
                            </p>
                        )}
                    </div>
                    {errors.form && <p role="alert" className="text-sm font-bold text-rose-600" data-coord-error="form">{errors.form}</p>}
                    {log.length > 0 && (
                        <div className="pt-2 border-t border-gray-100" data-coord-log="">
                            <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-2">{tx('loc.coord.log', 'Cambios del encargado')}</h3>
                            <ul className="space-y-1.5">
                                {log.map((e, i) => (
                                    <li key={i} className="text-xs text-gray-600" data-coord-log-entry="">
                                        <span className="font-bold">{tx('loc.coord.log.entry', 'Encargado editado')}</span>
                                        {' · '}{(e.fields || []).map((f) => fieldLabel(tx, f)).join(', ')}
                                        <span className="block text-[11px] text-gray-400">{fmt(Number(e.at_s))}{e.actor ? ` · ${e.actor}` : ''}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <div className="flex flex-wrap justify-end gap-2 pt-1">
                        <button type="button" onClick={onClose} disabled={busy} className="min-h-[44px] px-4 rounded-2xl text-xs font-bold text-gray-500 hover:bg-gray-100">{tx('cancel', 'Cancelar')}</button>
                        <button type="submit" disabled={busy || !changed.length} className="min-h-[44px] px-5 rounded-2xl text-xs font-black uppercase tracking-widest bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50" data-coord-save="">
                            {busy ? tx('saving', 'Guardando…') : tx('save', 'Guardar')}
                        </button>
                    </div>
                </form>
            </div>
        </Overlay>
    );
}

export default CoordinatorSheet;

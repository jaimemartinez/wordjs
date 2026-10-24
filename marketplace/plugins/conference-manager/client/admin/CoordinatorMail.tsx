// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Correo del encargado» on a locality's card (2.36.11): the coordinator's e-mail, editable in place, and the
 * welcome e-mail — «Enviar bienvenida», then «Reenviar» — with when it was last sent and by whom. The e-mail never
 * carries the locality's access code (the coordinator asks the administration for it). Errors are said under the
 * field, never in a native dialog; «Locales › gestionar» edits and sends, «ver» only reads.
 */
import React, { useState } from "react";
import { conferenceApi } from "../lib/conference";

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

export function CoordinatorMail({ loc, canManage, tx, onChanged, addToast }: any) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(loc.responsible_email || '');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState('');
    const sentAt = loc.welcome_sent_s ? new Date(Number(loc.welcome_sent_s) * 1000) : null;
    const fmt = (d: Date) => { try { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d); } catch { return d.toISOString(); } };
    const save = async () => {
        const v = value.trim();
        if (v && !EMAIL_RE.test(v)) { setError(tx('loc.mail.invalid', 'Escribe un correo válido.')); return; }
        setBusy('save'); setError(null);
        try {
            await conferenceApi.updateLocation(loc.id, { responsible_email: v } as any);
            setEditing(false);
            onChanged && onChanged({ ...loc, responsible_email: v || null });
        } catch (e: any) { setError(e?.message || 'Error'); }
        finally { setBusy(''); }
    };
    const send = async () => {
        setBusy('send'); setError(null);
        try {
            const r = await conferenceApi.sendLocationWelcome(loc.id);
            addToast && addToast(tx('loc.welcome.sent', 'Bienvenida enviada a {email}.').replace('{email}', r.email_masked || ''), 'success');
            onChanged && onChanged({ ...loc, welcome_sent_s: Math.floor(Date.parse(r.welcome_sent_at) / 1000) });
        } catch (e: any) { setError(e?.message || 'Error'); }
        finally { setBusy(''); }
    };
    const inputId = `cm-loc-mail-${loc.id}`;
    return (
        <div className="p-3 bg-white rounded-xl border border-gray-50 shadow-sm space-y-2" data-coordinator-mail={loc.id}>
            <div className="flex items-center gap-4">
                <div className="w-8 h-8 shrink-0 rounded-lg bg-emerald-50 text-emerald-500 flex items-center justify-center text-sm">
                    <i className="fa-solid fa-envelope" aria-hidden="true"></i>
                </div>
                <div className="min-w-0 flex-1">
                    <label htmlFor={inputId} className="block text-[9px] font-bold text-gray-400 uppercase tracking-widest">{tx('loc.mail', 'Correo del encargado')}</label>
                    {editing ? (
                        <input id={inputId} type="email" inputMode="email" autoComplete="off" value={value} onChange={(e) => { setValue(e.target.value); setError(null); }}
                            className="mt-1 w-full border-2 border-gray-100 rounded-lg px-3 py-2 text-base sm:text-sm outline-none focus:border-blue-500" placeholder="encargado@ejemplo.org"
                            aria-invalid={error ? true : undefined} aria-describedby={error ? `${inputId}-error` : undefined} data-coordinator-mail-input="" />
                    ) : (
                        <div className="text-xs font-black text-gray-700 break-all">{loc.responsible_email || tx('loc.mail.none', 'Sin correo')}</div>
                    )}
                </div>
                {canManage && !editing && (
                    <button type="button" className="shrink-0 min-h-[36px] px-3 rounded-lg text-xs font-bold text-blue-600 hover:bg-blue-50" onClick={() => { setValue(loc.responsible_email || ''); setEditing(true); }} data-coordinator-mail-edit="">
                        {loc.responsible_email ? tx('edit', 'Editar') : tx('loc.mail.add', 'Agregar')}
                    </button>
                )}
            </div>
            {editing && (
                <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" className="min-h-[36px] px-3 rounded-lg text-xs font-bold text-gray-500 hover:bg-gray-100" onClick={() => { setEditing(false); setError(null); }}>{tx('cancel', 'Cancelar')}</button>
                    <button type="button" disabled={!!busy} className="min-h-[36px] px-4 rounded-lg text-xs font-bold bg-blue-600 text-white disabled:opacity-50" onClick={save} data-coordinator-mail-save="">{busy === 'save' ? tx('saving', 'Guardando…') : tx('save', 'Guardar')}</button>
                </div>
            )}
            {!editing && loc.responsible_email && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] text-gray-500" data-welcome-status={sentAt ? 'sent' : 'never'}>
                        {sentAt ? tx('loc.welcome.at', 'Bienvenida enviada el {when}').replace('{when}', fmt(sentAt)) : tx('loc.welcome.never', 'Aún no se envió la bienvenida.')}
                    </p>
                    {canManage && (
                        <button type="button" disabled={!!busy} className="min-h-[36px] px-3 rounded-lg text-xs font-bold border-2 border-emerald-200 text-emerald-800 hover:border-emerald-400 disabled:opacity-50 inline-flex items-center gap-1.5" onClick={send} data-welcome-send="">
                            <i className={`fa-solid ${busy === 'send' ? 'fa-spinner animate-spin' : 'fa-paper-plane'}`} aria-hidden="true"></i>
                            {sentAt ? tx('loc.welcome.resend', 'Reenviar bienvenida') : tx('loc.welcome.send', 'Enviar bienvenida')}
                        </button>
                    )}
                </div>
            )}
            {!editing && loc.responsible_email && <p className="text-[10px] text-gray-400">{tx('loc.welcome.nocode', 'La bienvenida no lleva el código de acceso: el encargado se lo pide a la administración.')}</p>}
            {error && <p id={`${inputId}-error`} role="alert" className="text-xs font-semibold text-rose-600">{error}</p>}
        </div>
    );
}

export default CoordinatorMail;

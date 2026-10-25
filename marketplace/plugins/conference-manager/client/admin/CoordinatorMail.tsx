// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Correo del encargado» on a locality's card (2.36.11): the coordinator's e-mail and the welcome e-mail —
 * «Enviar bienvenida», then «Reenviar» — with when it was last sent. The e-mail never carries the locality's access
 * code (the coordinator asks the administration for it). Errors are said under the field, never in a native
 * dialog; «Locales › gestionar» edits and sends, «ver» only reads.
 *
 * 2.36.12: the e-mail is edited with the rest of the coordinator's data in «Editar encargado» (`onEdit` opens it).
 * A welcome sent to an address the coordinator no longer has says «No enviado al nuevo correo» and offers
 * «Enviar bienvenida» again.
 */
import React, { useState } from "react";
import { conferenceApi } from "../lib/conference";
import { welcomeState } from "../lib/coordinator";

export function CoordinatorMail({ loc, canManage, tx, onChanged, onEdit, addToast }: any) {
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState('');
    const sentAt = loc.welcome_sent_s ? new Date(Number(loc.welcome_sent_s) * 1000) : null;
    const state = welcomeState(loc);
    const fmt = (d: Date) => { try { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d); } catch { return d.toISOString(); } };
    const send = async () => {
        setBusy('send'); setError(null);
        try {
            const r = await conferenceApi.sendLocationWelcome(loc.id);
            addToast && addToast(tx('loc.welcome.sent', 'Bienvenida enviada a {email}.').replace('{email}', r.email_masked || ''), 'success');
            onChanged && onChanged({ ...loc, welcome_sent_s: Math.floor(Date.parse(r.welcome_sent_at) / 1000), welcome_sent_to: r.welcome_sent_to || loc.responsible_email });
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
                    <div className="block text-[9px] font-bold text-gray-400 uppercase tracking-widest" id={inputId}>{tx('loc.mail', 'Correo del encargado')}</div>
                    <div className="text-xs font-black text-gray-700 break-all">{loc.responsible_email || tx('loc.mail.none', 'Sin correo')}</div>
                </div>
                {canManage && onEdit && !loc.responsible_email && (
                    <button type="button" className="shrink-0 min-h-[36px] px-3 rounded-lg text-xs font-bold text-blue-600 hover:bg-blue-50" onClick={onEdit} data-coordinator-mail-edit="">
                        {tx('loc.mail.add', 'Agregar')}
                    </button>
                )}
            </div>
            {loc.responsible_email && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className={`text-[11px] ${state === 'stale' ? 'font-bold text-amber-700' : 'text-gray-500'}`} data-welcome-status={state}>
                        {state === 'stale' ? tx('loc.welcome.stale', 'No enviado al nuevo correo') + (sentAt ? ` · ${tx('loc.welcome.stale.at', 'la última se envió al anterior el {when}').replace('{when}', fmt(sentAt))}` : '')
                            : sentAt ? tx('loc.welcome.at', 'Bienvenida enviada el {when}').replace('{when}', fmt(sentAt)) : tx('loc.welcome.never', 'Aún no se envió la bienvenida.')}
                    </p>
                    {canManage && (
                        <button type="button" disabled={!!busy} className="min-h-[36px] px-3 rounded-lg text-xs font-bold border-2 border-emerald-200 text-emerald-800 hover:border-emerald-400 disabled:opacity-50 inline-flex items-center gap-1.5" onClick={send} data-welcome-send="">
                            <i className={`fa-solid ${busy === 'send' ? 'fa-spinner animate-spin' : 'fa-paper-plane'}`} aria-hidden="true"></i>
                            {state === 'sent' ? tx('loc.welcome.resend', 'Reenviar bienvenida') : tx('loc.welcome.send', 'Enviar bienvenida')}
                        </button>
                    )}
                </div>
            )}
            {loc.responsible_email && <p className="text-[10px] text-gray-400">{tx('loc.welcome.nocode', 'La bienvenida no lleva el código de acceso: el encargado se lo pide a la administración.')}</p>}
            {error && <p id={`${inputId}-error`} role="alert" className="text-xs font-semibold text-rose-600">{error}</p>}
        </div>
    );
}

export default CoordinatorMail;

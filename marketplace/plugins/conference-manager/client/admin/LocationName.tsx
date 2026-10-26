// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * A locality's name on its card in «Localidades», editable in place (conference-manager 2.36.21): the pencil opens a
 * field with «Guardar» / «Cancelar» (Enter saves, Escape cancels). The server refuses an empty name or one another
 * locality of the conference already has, and carries the new name to that locality's inscriptions.
 */
import React, { useState } from "react";
import { conferenceApi } from "../lib/conference";

type Tx = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

export function LocationName({ loc, canEdit, tx, addToast, onSaved }: {
    loc: any; canEdit: boolean; tx: Tx;
    addToast: (text: string, tone: string) => void; onSaved: (name: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [input, setInput] = useState(String(loc.name || ''));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const close = () => { setEditing(false); setError(''); setInput(String(loc.name || '')); };
    const save = async () => {
        const next = input.trim().replace(/\s+/g, ' ');
        if (!next) { setError(tx('loc.rename.empty', 'Escribe el nombre de la localidad.')); return; }
        if (next === loc.name) { close(); return; }
        setSaving(true); setError('');
        try {
            await conferenceApi.updateLocation(loc.id, { name: next } as any);
            addToast(tx('loc.rename.saved', 'Nombre de la localidad actualizado'), 'success');
            setEditing(false);
            onSaved(next);
        } catch (e: any) { setError(e?.message || 'Error'); }
        finally { setSaving(false); }
    };
    if (!editing) return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            <h3 className="text-2xl font-black text-gray-900 italic tracking-tighter leading-tight break-words max-w-full">{loc.name}</h3>
            {canEdit && (
                <button type="button" onClick={() => { setInput(String(loc.name || '')); setEditing(true); }}
                    title={tx('loc.rename.edit', 'Editar nombre')} aria-label={tx('loc.rename.edit', 'Editar nombre')}
                    className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white transition-all shadow-sm" data-location-rename={loc.id}>
                    <i className="fa-solid fa-pen text-xs" aria-hidden="true"></i>
                </button>
            )}
        </div>
    );
    return (
        <div className="space-y-2 min-w-0" data-location-rename-form={loc.id}>
            <label htmlFor={`loc-name-${loc.id}`} className="block text-[9px] font-bold text-gray-400 uppercase tracking-widest">{tx('loc.rename.label', 'Nombre de la localidad')}</label>
            <input id={`loc-name-${loc.id}`} type="text" value={input} maxLength={120} autoFocus disabled={saving}
                onChange={(e) => { setInput(e.target.value); if (error) setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); }}
                aria-invalid={!!error}
                className="w-full min-w-0 border-2 border-blue-200 rounded-xl px-3 py-2 text-base font-black text-gray-900 outline-none focus:border-blue-500" />
            <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={save} disabled={saving || !input.trim()} data-location-rename-save=""
                    className="shrink-0 text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                    {saving ? <i className="fa-solid fa-spinner animate-spin" aria-hidden="true"></i> : tx('save', 'Guardar')}
                </button>
                <button type="button" onClick={close} disabled={saving}
                    className="shrink-0 text-[10px] font-black uppercase tracking-widest px-2 py-1.5 rounded-lg text-gray-400 hover:bg-gray-100">{tx('cancel', 'Cancelar')}</button>
            </div>
            {error && <p className="text-xs font-semibold text-rose-600" role="alert">{error}</p>}
        </div>
    );
}

export default LocationName;

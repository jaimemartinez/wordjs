// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Imprimir stickers» (2.36.3) — one dialog for the printable stickers, where whoever prints chooses what: everyone,
 * one locality, or the people they tick (a search and a box per person; «one person» is one tick). The count is
 * shown before printing, and the button says it. Printing is one PDF with one label per page at the label's
 * size (POST /badges/ticket, sheet 'sticker', then the core portal's file route). Opened from «Personas»; it starts
 * on what the list shows: the search's people ticked, else the chosen locality, else everyone.
 */
import React, { useMemo, useState } from "react";
import { LAYER } from "../lib/overlay";
import { badgesApi, openBadgeFileFrom } from "../lib/badges";
import { Select } from "../lib/Select";
import { Overlay } from "./Overlay";

export type StickerScope = 'all' | 'loc' | 'pick';
export type StickerPerson = { id: number; name: string; place: string; loc: string; code?: string };

const fold = (s: any) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const btn = 'min-h-[44px] px-4 rounded-2xl font-black text-[11px] uppercase tracking-widest inline-flex items-center justify-center gap-2 disabled:opacity-50';
const ghost = `${btn} bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400`;
const primary = `${btn} bg-gray-900 text-white hover:bg-blue-600`;
const input = 'w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/40 focus:bg-white focus:border-blue-500 outline-none text-sm text-gray-900 font-medium';
const label = 'block text-[10px] font-black uppercase tracking-widest text-gray-500 mb-1.5';
const seg = (on: boolean) => `flex-1 min-h-[40px] px-2 rounded-xl text-[11px] font-black uppercase tracking-widest border-2 ${on ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-100 text-gray-500 hover:border-gray-300'}`;

/** Who a scope prints, in the list's order: everyone, a locality's people, or the ticked ones. */
export function stickerIdsOf(people: StickerPerson[], scope: StickerScope, loc: string, picked: Set<number>): number[] {
    if (scope === 'loc') return loc ? people.filter((p) => p.loc === loc).map((p) => p.id) : [];
    if (scope === 'pick') return people.filter((p) => picked.has(p.id)).map((p) => p.id);
    return people.map((p) => p.id);
}

/** The request for a scope: the server's own scopes where they fit (everyone, a locality), else the ids. */
export function stickerRequestOf(scope: StickerScope, loc: string, ids: number[]) {
    if (scope === 'all') return { all: true };
    if (scope === 'loc') return { location_id: Number(loc) };
    return ids.length === 1 ? { inscription_id: ids[0] } : { inscription_ids: ids };
}

export function StickerPrint({ conferenceId, people, locations, tx, addToast, size, max = 1000, initial, onClose }: {
    conferenceId: number; people: StickerPerson[]; locations: any[]; tx: (k: string, f: string) => string; addToast: (m: string, t?: string) => void;
    size?: { w: number; h: number } | null; max?: number;
    initial?: { scope?: StickerScope; loc?: string; picked?: number[] }; onClose: () => void;
}) {
    const [scope, setScope] = useState<StickerScope>(initial?.scope || 'all');
    const [loc, setLoc] = useState<string>(initial?.loc || '');
    const [picked, setPicked] = useState<Set<number>>(() => new Set(initial?.picked || []));
    const [q, setQ] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');

    const ids = useMemo(() => stickerIdsOf(people, scope, loc, picked), [people, scope, loc, picked]);
    const found = useMemo(() => {
        const needle = fold(q.trim());
        return needle ? people.filter((p) => fold(`${p.name} ${p.place} ${p.code || ''}`).includes(needle)) : people;
    }, [people, q]);
    const countOf = (id: string) => people.filter((p) => p.loc === id).length;
    const n = ids.length;
    const t = (k: string, f: string, v: Record<string, any> = {}) => Object.entries(v).reduce((s, [a, b]) => s.split(`{${a}}`).join(String(b)), tx(k, f));
    const toggle = (id: number, on: boolean) => setPicked((cur) => { const s = new Set(cur); if (on) s.add(id); else s.delete(id); return s; });
    const allFound = found.length > 0 && found.every((p) => picked.has(p.id));

    const print = () => {
        if (busy) return;
        if (!n) { setErr(scope === 'loc' ? tx('badges.print.noloc', 'Escoge una localidad.') : tx('badges.print.empty', 'Escoge al menos una persona.')); return; }
        if (n > max) { setErr(t('badges.print.max', 'Máximo {n} stickers por PDF: escoge una localidad o menos personas.', { n: max })); return; }
        setBusy(true); setErr('');
        // The new tab is opened inside the tap (openBadgeFileFrom), before the ticket is asked for.
        openBadgeFileFrom(async () => (await badgesApi.ticket(conferenceId, stickerRequestOf(scope, loc, ids), 'sticker')).d)
            .then(() => { addToast(t('badges.print.done', '{n} stickers listos para imprimir.', { n }), 'success'); onClose(); })
            .catch((e: any) => { setErr(e?.message || 'Error'); setBusy(false); });
    };

    return (
        <Overlay layer={LAYER.modal} onBackdrop={onClose} onEscape={onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby="sticker-print-title" data-sticker-print=""
                className="bg-white rounded-[32px] shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden flex flex-col max-h-[92dvh]">
                <div className="bg-gray-50/50 px-5 sm:px-7 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
                    <h2 id="sticker-print-title" className="font-black text-xl text-gray-900 italic tracking-tighter">
                        <i className="fa-solid fa-note-sticky mr-2 text-gray-400" aria-hidden="true"></i>{tx('badges.print.title', 'Imprimir stickers')}
                    </h2>
                    <button type="button" onClick={onClose} aria-label={tx('close', 'Cerrar')} className="inline-flex w-10 h-10 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                        <i className="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </div>
                <div className="px-5 sm:px-7 py-5 space-y-4 overflow-y-auto">
                    <div>
                        <span className={label} id="sticker-scope-label">{tx('badges.print.scope', 'Qué imprimir')}</span>
                        <div className="flex gap-2" role="radiogroup" aria-labelledby="sticker-scope-label">
                            {(['all', 'loc', 'pick'] as StickerScope[]).map((k) => (
                                <button key={k} type="button" role="radio" aria-checked={scope === k} className={seg(scope === k)} data-sticker-scope={k}
                                    onClick={() => { setScope(k); setErr(''); }}>
                                    {k === 'all' ? t('badges.print.all', 'Todos ({n})', { n: people.length }) : k === 'loc' ? tx('badges.print.loc', 'Una localidad') : tx('badges.print.pick', 'Escoger personas')}
                                </button>
                            ))}
                        </div>
                    </div>

                    {scope === 'loc' && (
                        <div>
                            <label className={label} htmlFor="sticker-loc">{tx('badges.print.loc.label', 'Localidad')}</label>
                            <Select id="sticker-loc" className={input} value={loc} onChange={(e) => { setLoc(e.target.value); setErr(''); }}>
                                <option value="">{tx('badges.print.loc.choose', 'Escoge una localidad…')}</option>
                                {locations.map((l) => <option key={l.id} value={String(l.id)}>{`${l.name} (${countOf(String(l.id))})`}</option>)}
                            </Select>
                        </div>
                    )}

                    {scope === 'pick' && (
                        <div className="space-y-2" data-sticker-pick="">
                            <label className="sr-only" htmlFor="sticker-q">{tx('badges.print.search', 'Buscar por nombre, localidad o código')}</label>
                            <input id="sticker-q" type="search" className={input} value={q} placeholder={tx('badges.print.search', 'Buscar por nombre, localidad o código')}
                                onChange={(e) => setQ(e.target.value)} autoComplete="off" />
                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold">
                                <span className="text-gray-600" data-sticker-picked={picked.size}>{t('badges.print.selected', '{n} escogidas', { n: picked.size })}</span>
                                <span className="flex gap-3">
                                    <button type="button" className="text-blue-700 underline disabled:opacity-50 disabled:no-underline" disabled={!found.length || allFound}
                                        onClick={() => setPicked((cur) => { const s = new Set(cur); for (const p of found) s.add(p.id); return s; })} data-sticker-pick-shown="">
                                        {t('badges.print.selectShown', 'Marcar los que se ven ({n})', { n: found.length })}
                                    </button>
                                    <button type="button" className="text-gray-600 underline disabled:opacity-50 disabled:no-underline" disabled={!picked.size} onClick={() => setPicked(new Set())} data-sticker-pick-clear="">
                                        {tx('badges.print.clear', 'Quitar todas')}
                                    </button>
                                </span>
                            </div>
                            <ul className="border-2 border-gray-100 rounded-2xl divide-y divide-gray-100 max-h-[40dvh] overflow-y-auto" aria-label={tx('badges.print.pick', 'Escoger personas')}>
                                {found.length === 0 && <li className="px-4 py-3 text-sm text-gray-500">{tx('badges.print.nomatch', 'Nadie coincide con la búsqueda.')}</li>}
                                {found.map((p) => (
                                    <li key={p.id}>
                                        <label className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-gray-50" data-sticker-person={p.id}>
                                            <input type="checkbox" className="w-5 h-5 shrink-0 accent-blue-600" checked={picked.has(p.id)} onChange={(e) => { toggle(p.id, e.target.checked); setErr(''); }} />
                                            <span className="min-w-0">
                                                <span className="block text-sm font-bold text-gray-900 truncate">{p.name}</span>
                                                {p.place && <span className="block text-[11px] text-gray-500 truncate">{p.place}</span>}
                                            </span>
                                        </label>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <p className="text-[11px] text-gray-600 bg-gray-50 border border-gray-100 rounded-2xl px-4 py-3">{tx('badges.print.settings', 'En la ventana de impresión escoge la impresora de stickers y el tamaño de la etiqueta, «Márgenes: ninguno» y «Escala: 100 %» (o «Tamaño real»).')}</p>
                    {err && <p className="text-xs font-bold text-rose-700" role="alert" data-sticker-error="">{err}</p>}
                </div>
                <div className="px-5 sm:px-7 py-4 border-t border-gray-100 bg-gray-50/50 space-y-3">
                    <p className="text-xs font-bold text-gray-700" data-sticker-count={n}>
                        {size ? t('badges.print.count', 'Se imprimirán {n} stickers, uno por página de {w} × {h} mm.', { n, w: size.w, h: size.h }) : t('badges.print.count.nosize', 'Se imprimirán {n} stickers, uno por página.', { n })}
                    </p>
                    <div className="flex flex-wrap justify-end gap-2">
                        <button type="button" className={ghost} onClick={onClose}>{tx('cancel', 'Cancelar')}</button>
                        <button type="button" className={primary} disabled={busy || !n} onClick={print} data-sticker-go="">
                            <i className={`fa-solid ${busy ? 'fa-spinner animate-spin' : 'fa-print'}`} aria-hidden="true"></i>
                            {n === 1 ? tx('badges.print.go.one', 'Imprimir 1 sticker') : t('badges.print.go', 'Imprimir {n} stickers', { n })}
                        </button>
                    </div>
                </div>
            </div>
        </Overlay>
    );
}

export default StickerPrint;

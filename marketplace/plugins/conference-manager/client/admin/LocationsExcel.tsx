// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Localidades › Descargar Excel» (2.36.23): one row per locality with the columns the admin picks and orders
 * — the locality's data and cupos, roster counts, «Inscritos por edad» in ranges they edit, and a breakdown by
 * any selection field of the form — for all localities or the ones ticked, with an optional «Total» row and a
 * preview of the first rows. The choice (columns, ranges, «Sin edad», total) is remembered per conference on
 * this device. The sheet itself is built by lib/locationsReport (pure).
 *
 * The roster (counts, ages, breakdowns) is read only with Inscripciones › ver, the payment counts also need
 * Pagos › ver; without them only the locality's own columns are offered.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { conferenceApi } from "../lib/conference";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { exportFilename } from "../lib/exports";
import {
    AGES_KEY, AGE_MAX, BY_PREFIX, DEFAULT_AGE_RANGES, DEFAULT_REPORT_KEYS, LOCATION_KEYS, PAYMENT_KEYS, REPORT_LABELS, ROSTER_KEYS,
    ageFieldOf, ageRangeLabel, ageRangesError, breakdownFields, buildLocationsSheet, normalizeAgeRanges,
} from "../lib/locationsReport";
import { Overlay } from "./Overlay";
import { usePerms, canReadRoster } from "./perms";
import { useTx } from "./MealScanner";

const PREVIEW_ROWS = 5;

/** The labels of the sheet's columns in the UI language (the keys of REPORT_LABELS under `locx.col.`). */
export function reportLabels(tx: (k: string, f: string) => string) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(REPORT_LABELS)) out[k] = tx(`locx.col.${k}`, v);
    return out;
}

export function LocationsExcelModal({ conferenceId, slug, locations, onClose }: { conferenceId: number; slug?: string; locations: any[]; onClose: () => void }) {
    const { t } = useI18n();
    const tx = useTx();
    const { addToast } = useToast();
    const perms = usePerms();
    const canRoster = canReadRoster(perms);
    const canPay = canRoster && perms.can('payments');
    const storeKey = `cm:locexcel:${conferenceId}`;
    const [fields, setFields] = useState<any[]>([]);
    const [people, setPeople] = useState<any[]>([]);
    const [loading, setLoading] = useState(canRoster);
    const [keys, setKeys] = useState<string[]>([...DEFAULT_REPORT_KEYS]);
    const [ranges, setRanges] = useState<{ from: string; to: string }[]>(DEFAULT_AGE_RANGES.map(r => ({ from: String(r.from), to: String(r.to) })));
    const [ageUnknown, setAgeUnknown] = useState(true);
    const [totals, setTotals] = useState(true);
    // null = every locality; otherwise the ticked ones.
    const [picked, setPicked] = useState<number[] | null>(null);
    const [tried, setTried] = useState(false);

    useEffect(() => {
        let saved: any = null;
        try { saved = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch { saved = null; }
        if (saved && Array.isArray(saved.keys) && saved.keys.length) setKeys(saved.keys.map(String));
        if (saved && Array.isArray(saved.ranges) && saved.ranges.length) setRanges(saved.ranges.map((r: any) => ({ from: String(r.from ?? ''), to: String(r.to ?? '') })));
        if (saved && typeof saved.ageUnknown === 'boolean') setAgeUnknown(saved.ageUnknown);
        if (saved && typeof saved.totals === 'boolean') setTotals(saved.totals);
        if (!canRoster) return;
        let alive = true;
        Promise.all([conferenceApi.getFields(conferenceId), conferenceApi.getInscriptions(conferenceId)])
            .then(([f, p]) => { if (alive) { setFields(f || []); setPeople(p || []); } })
            .catch((e: any) => addToast(e?.message || 'Error', 'error'))
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [conferenceId]);

    const L = useMemo(() => reportLabels(tx), [tx]);
    const ageField = ageFieldOf(fields);
    const groupField = fields.find(f => Number(f.is_group) === 1);
    const byFields = useMemo(() => breakdownFields(fields), [fields]);
    // Every item the admin can add, in groups; an item whose data this account cannot read is not offered.
    const groups = useMemo(() => {
        const g: { title: string; items: { key: string; label: string; hint?: string }[] }[] = [
            { title: tx('locx.group.location', 'De la localidad'), items: LOCATION_KEYS.map(k => ({ key: k, label: L[k] })) },
        ];
        if (canRoster) {
            g.push({ title: tx('locx.group.roster', 'De sus inscritos'), items: [
                ...ROSTER_KEYS.filter(k => k !== 'families' || groupField).map(k => ({ key: k, label: L[k] })),
                ...(canPay ? PAYMENT_KEYS.map(k => ({ key: k, label: `${tx('locx.col.payment', 'Pago')}: ${L[k]}` })) : []),
                ...(ageField ? [{ key: AGES_KEY, label: L.ages, hint: tx('locx.ages.hint', 'Una columna por rango de edad.') }] : []),
                ...byFields.map(f => ({ key: BY_PREFIX + f.name, label: tx('locx.by', 'Por {field}').replace('{field}', String(f.label || f.name)), hint: tx('locx.by.hint', 'Una columna por respuesta.') })),
            ] });
        }
        return g;
    }, [L, tx, canRoster, canPay, ageField, groupField, byFields]);
    const offered = useMemo(() => new Map(groups.flatMap(g => g.items).map(i => [i.key, i.label])), [groups]);
    const chosen = loading ? keys : keys.filter(k => offered.has(k));

    const toggle = (k: string) => setKeys(s => s.includes(k) ? s.filter(x => x !== k) : [...s, k]);
    const move = (k: string, d: number) => setKeys(s => {
        const list = s.filter(x => offered.has(x));
        const i = list.indexOf(k), j = i + d;
        if (i < 0 || j < 0 || j >= list.length) return s;
        [list[i], list[j]] = [list[j], list[i]];
        return list;
    });

    const agesOn = chosen.includes(AGES_KEY);
    const rangeError = agesOn ? ageRangesError(ranges) : null;
    const rangeMsg = rangeError && ({
        empty: tx('locx.ages.err.empty', 'Agrega al menos un rango de edad.'),
        invalid: tx('locx.ages.err.invalid', 'Rango {n}: escribe edades enteras de 0 a {max}.').replace('{max}', String(AGE_MAX)),
        order: tx('locx.ages.err.order', 'Rango {n}: «desde» no puede ser mayor que «hasta».'),
        overlap: tx('locx.ages.err.overlap', 'Rango {n}: se cruza con otro rango.'),
    }[rangeError.code] || '').replace('{n}', String(rangeError.index + 1));

    const ids = picked == null ? null : picked;
    const sheet = useMemo(() => {
        if (!chosen.length || rangeError) return null;
        return buildLocationsSheet({
            locations, people, fields, keys: chosen, ageRanges: agesOn ? normalizeAgeRanges(ranges) : DEFAULT_AGE_RANGES,
            ageUnknown, totals, locationIds: ids, labels: L,
        });
    }, [locations, people, fields, chosen.join('|'), ranges, ageUnknown, totals, ids && ids.join(','), L, rangeError && rangeError.code]);

    const nLocs = ids == null ? locations.length : ids.length;
    const generate = () => {
        setTried(true);
        if (!chosen.length) { addToast(tx('locx.none', 'Elige al menos una columna.'), 'warning'); return; }
        if (rangeError) { addToast(rangeMsg, 'warning'); return; }
        if (!nLocs || !sheet) { addToast(tx('locx.no.locations', 'Elige al menos una localidad.'), 'warning'); return; }
        try { localStorage.setItem(storeKey, JSON.stringify({ keys: chosen, ranges, ageUnknown, totals })); } catch { /* private mode */ }
        try {
            downloadXlsx(buildXlsx([sheet]), exportFilename('localidades', slug));
            addToast(t('excel.done') || 'Excel generado', 'success');
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };

    const setRange = (i: number, k: 'from' | 'to', v: string) => setRanges(rs => rs.map((r, j) => j === i ? { ...r, [k]: v.replace(/[^0-9]/g, '').slice(0, 3) } : r));
    const addRange = () => setRanges(rs => {
        const last = rs.length ? Number(rs[rs.length - 1].to) : -1;
        const from = Number.isFinite(last) ? Math.min(AGE_MAX, last + 1) : 0;
        return [...rs, { from: String(from), to: String(AGE_MAX) }];
    });
    const togglePick = (id: number) => setPicked(p => {
        const cur = p == null ? locations.map(l => Number(l.id)) : p;
        const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
        return next.length === locations.length ? null : next;
    });

    const box = 'rounded-2xl border border-gray-100';
    const head = 'text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1 mb-2';
    const num = 'w-20 min-h-[40px] border-2 border-gray-100 rounded-xl px-3 py-2 bg-white focus:border-blue-500 outline-none text-base text-gray-900 tabular-nums';
    const iconBtn = 'w-9 h-9 rounded-lg bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white disabled:opacity-30';
    return (
        <Overlay layer={2} onEscape={onClose}>
            <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-5xl border border-gray-100 overflow-hidden max-h-[92vh] flex flex-col" role="dialog" aria-modal="true" aria-labelledby="locx-title" data-locations-excel="">
                <div className="bg-gray-50/50 px-6 sm:px-10 py-6 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
                    <div className="min-w-0">
                        <h3 id="locx-title" className="font-black text-2xl text-gray-900 italic tracking-tighter"><i className="fa-solid fa-file-excel text-emerald-600 mr-2"></i>{tx('locx.title', 'Excel de localidades')}</h3>
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">{tx('locx.subtitle', 'Una fila por localidad: elige las columnas, su orden y los rangos de edad')}</p>
                    </div>
                    <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-2xl shrink-0" aria-label={t('close') || 'Cerrar'}>
                        <i className="fa-solid fa-xmark text-xl"></i>
                    </button>
                </div>
                {loading ? (
                    <div className="text-center py-20"><div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div></div>
                ) : (
                    <div className="p-4 sm:p-10 space-y-6 overflow-y-auto">
                        {!canRoster && <p className="text-xs text-gray-500 bg-gray-50 rounded-2xl px-4 py-3" data-locx-no-roster="">{tx('locx.no.roster', 'Los conteos por edad, pago o respuesta del formulario necesitan el permiso Inscripciones › ver.')}</p>}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <div className={head}>{tx('locx.columns.available', 'Columnas disponibles')}</div>
                                <div className={`${box} max-h-96 overflow-y-auto`}>
                                    {groups.map(g => (
                                        <div key={g.title}>
                                            <div className="px-4 pt-3 pb-1 text-[10px] font-black uppercase tracking-widest text-blue-600">{g.title}</div>
                                            {g.items.map(i => (
                                                <label key={i.key} className="flex items-start gap-3 px-4 py-2.5 hover:bg-blue-50/40 cursor-pointer" data-locx-item={i.key}>
                                                    <input type="checkbox" checked={chosen.includes(i.key)} onChange={() => toggle(i.key)} className="accent-blue-600 w-4 h-4 mt-0.5 shrink-0" />
                                                    <span className="min-w-0">
                                                        <span className="block text-sm font-medium text-gray-800 break-words">{i.label}</span>
                                                        {i.hint && <span className="block text-[11px] text-gray-400">{i.hint}</span>}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    ))}
                                    {canRoster && !ageField && <p className="px-4 py-3 text-[11px] text-gray-400 italic" data-locx-no-age="">{tx('locx.ages.nofield', 'Para contar por edad, agrega el campo «Edad» al formulario.')}</p>}
                                </div>
                            </div>
                            <div>
                                <div className={head}>{tx('locx.columns.selected', 'Columnas del Excel (en orden)')}</div>
                                <div className={`${box} divide-y divide-gray-50 max-h-96 overflow-y-auto`} data-locx-selected="">
                                    {chosen.length === 0 && <div className="px-4 py-6 text-center text-xs text-gray-400 italic">{tx('locx.none', 'Elige al menos una columna.')}</div>}
                                    {chosen.map((k, i) => (
                                        <div key={k} className="flex items-center gap-2 px-4 py-2">
                                            <span className="w-6 text-[10px] font-black text-gray-300 shrink-0">{i + 1}</span>
                                            <span className="flex-1 min-w-0 truncate text-sm font-bold text-gray-800">{offered.get(k) || k}</span>
                                            <button type="button" onClick={() => move(k, -1)} disabled={i === 0} aria-label={t('excel.move.up') || 'Subir'} className={iconBtn}><i className="fa-solid fa-arrow-up text-[10px]"></i></button>
                                            <button type="button" onClick={() => move(k, 1)} disabled={i === chosen.length - 1} aria-label={t('excel.move.down') || 'Bajar'} className={iconBtn}><i className="fa-solid fa-arrow-down text-[10px]"></i></button>
                                            <button type="button" onClick={() => toggle(k)} aria-label={t('excel.remove') || 'Quitar'} className="w-9 h-9 rounded-lg bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white"><i className="fa-solid fa-xmark text-[10px]"></i></button>
                                        </div>
                                    ))}
                                </div>
                                <label className="mt-4 flex items-center gap-3 px-4 py-3 rounded-2xl border-2 border-gray-100 cursor-pointer">
                                    <input type="checkbox" checked={totals} onChange={e => setTotals(e.target.checked)} className="accent-blue-600 w-4 h-4" data-locx-totals="" />
                                    <span className="text-sm font-bold text-gray-800">{tx('locx.totals', 'Agregar una fila «Total» al final')}</span>
                                </label>
                            </div>
                        </div>

                        {agesOn && (
                            <div data-locx-ranges="">
                                <div className={head}>{tx('locx.ages.title', 'Rangos de edad')}</div>
                                <div className={`${box} p-4 space-y-3`}>
                                    {ranges.map((r, i) => (
                                        <div key={i} className="flex flex-wrap items-center gap-2" data-locx-range={i}>
                                            <span className="w-6 text-[10px] font-black text-gray-300">{i + 1}</span>
                                            <label className="flex items-center gap-2 text-xs font-bold text-gray-500">{tx('locx.ages.from', 'Desde')}
                                                <input inputMode="numeric" value={r.from} onChange={e => setRange(i, 'from', e.target.value)} className={num} aria-invalid={tried && rangeError?.index === i ? true : undefined} data-locx-from={i} />
                                            </label>
                                            <label className="flex items-center gap-2 text-xs font-bold text-gray-500">{tx('locx.ages.to', 'Hasta')}
                                                <input inputMode="numeric" value={r.to} onChange={e => setRange(i, 'to', e.target.value)} className={num} aria-invalid={tried && rangeError?.index === i ? true : undefined} data-locx-to={i} />
                                            </label>
                                            <span className="text-xs text-gray-400">{tx('locx.ages.years', 'años')}</span>
                                            {!ageRangesError([r]) && <span className="text-[11px] font-bold text-blue-600 bg-blue-50 rounded-lg px-2 py-1">{L.age} {ageRangeLabel({ from: Number(r.from), to: Number(r.to) })}</span>}
                                            <button type="button" onClick={() => setRanges(rs => rs.filter((_, j) => j !== i))} aria-label={tx('locx.ages.remove', 'Quitar rango')} className="ml-auto w-9 h-9 rounded-lg bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white"><i className="fa-solid fa-trash text-[10px]"></i></button>
                                        </div>
                                    ))}
                                    {rangeMsg && <p className="text-xs font-bold text-rose-600" role="alert" data-locx-range-error="">{rangeMsg}</p>}
                                    <div className="flex flex-wrap items-center gap-2 pt-1">
                                        <button type="button" onClick={addRange} className="min-h-[40px] px-4 rounded-xl border-2 border-gray-100 text-xs font-bold text-blue-700 hover:border-blue-400" data-locx-add-range=""><i className="fa-solid fa-plus mr-1.5"></i>{tx('locx.ages.add', 'Agregar rango')}</button>
                                        <button type="button" onClick={() => setRanges(DEFAULT_AGE_RANGES.map(x => ({ from: String(x.from), to: String(x.to) })))} className="min-h-[40px] px-4 rounded-xl border-2 border-gray-100 text-xs font-bold text-gray-600 hover:border-gray-300">{tx('locx.ages.reset', 'Restaurar rangos')}</button>
                                        <label className="flex items-center gap-2 px-3 min-h-[40px] cursor-pointer">
                                            <input type="checkbox" checked={ageUnknown} onChange={e => setAgeUnknown(e.target.checked)} className="accent-blue-600 w-4 h-4" />
                                            <span className="text-xs font-bold text-gray-700">{tx('locx.ages.unknown', 'Columna «Sin edad» (quien no respondió la edad)')}</span>
                                        </label>
                                    </div>
                                    <p className="text-[11px] text-gray-400">{tx('locx.ages.help', 'Edades en años cumplidos; {max}+ significa «o más». Las edades que no caen en ningún rango no se cuentan en esas columnas.').replace('{max}', String(AGE_MAX))}</p>
                                </div>
                            </div>
                        )}

                        <div>
                            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                                <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{tx('locx.locations', 'Localidades')} <span className="text-gray-500 tabular-nums">({nLocs}/{locations.length})</span></div>
                                <div className="flex flex-wrap gap-2">
                                    <button type="button" onClick={() => setPicked(null)} className="min-h-[36px] px-3 rounded-xl border-2 border-gray-100 text-[11px] font-bold text-gray-600 hover:border-blue-300">{tx('locx.locations.all', 'Todas')}</button>
                                    <button type="button" onClick={() => setPicked([])} className="min-h-[36px] px-3 rounded-xl border-2 border-gray-100 text-[11px] font-bold text-gray-600 hover:border-blue-300">{tx('locx.locations.none', 'Ninguna')}</button>
                                </div>
                            </div>
                            <div className={`${box} p-3 flex flex-wrap gap-2 max-h-48 overflow-y-auto`} data-locx-locations="">
                                {locations.map(l => {
                                    const on = ids == null || ids.includes(Number(l.id));
                                    return (
                                        <label key={l.id} className={`flex items-center gap-2 min-h-[36px] px-3 rounded-xl border-2 cursor-pointer text-xs font-bold ${on ? 'border-blue-200 bg-blue-50 text-blue-800' : 'border-gray-100 text-gray-500'}`}>
                                            <input type="checkbox" checked={on} onChange={() => togglePick(Number(l.id))} className="accent-blue-600 w-4 h-4" />
                                            <span className="break-words">{l.name}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>

                        {sheet && sheet.rows.length > 0 && (
                            <div data-locx-preview="">
                                <div className={head}>{tx('locx.preview', 'Vista previa')}{sheet.rows.length > PREVIEW_ROWS + (totals ? 1 : 0) ? ` · ${tx('locx.preview.first', 'primeras {n} filas').replace('{n}', String(PREVIEW_ROWS))}` : ''}</div>
                                <div className={`${box} overflow-x-auto`}>
                                    <table className="min-w-full text-xs">
                                        <thead className="bg-gray-50">
                                            <tr>{sheet.columns.map((c, i) => <th key={i} className="px-3 py-2 text-left font-black text-gray-600 whitespace-nowrap">{c.header}</th>)}</tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-50">
                                            {sheet.rows.map((r, i) => ({ r, i })).filter(x => x.i < PREVIEW_ROWS || (sheet.boldRows || []).includes(x.i)).map(({ r, i }) => (
                                                <tr key={i} className={(sheet.boldRows || []).includes(i) ? 'font-black bg-gray-50/60' : ''}>{r.map((v, j) => <td key={j} className="px-3 py-2 text-gray-800 whitespace-nowrap tabular-nums">{v == null ? '' : String(v)}</td>)}</tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>
                )}
                <div className="px-6 sm:px-10 py-5 border-t border-gray-50 bg-gray-50/30 flex flex-wrap items-center justify-between gap-3 shrink-0">
                    <span className="text-xs font-bold text-gray-500" data-locx-summary="">{tx('locx.summary', '{n} localidades · {c} columnas').replace('{n}', String(nLocs)).replace('{c}', String(sheet ? sheet.columns.length : 0))}</span>
                    <div className="flex flex-wrap gap-3">
                        <button type="button" onClick={onClose} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{t('cancel') || 'Cancelar'}</button>
                        <button type="button" onClick={generate} disabled={loading} className="px-8 py-3 bg-emerald-600 text-white rounded-2xl hover:bg-emerald-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-emerald-500/30 disabled:opacity-50" data-locx-generate="">
                            <i className="fa-solid fa-file-excel mr-1.5"></i>{tx('locx.generate', 'Descargar Excel')}
                        </button>
                    </div>
                </div>
            </div>
        </Overlay>
    );
}

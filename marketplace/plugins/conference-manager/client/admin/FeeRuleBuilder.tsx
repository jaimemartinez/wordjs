// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Nueva regla de precio» — the condition (2.36.4). The value input follows the field picked:
 *   - «Personas»: the roster, searched by name, document or locality (and filtered by locality), one or more ticked;
 *   - the locality, a list field or a short text (church, role, gender…): the values this conference's people really
 *     have, with how many have each, ticked (and another value can be added);
 *   - a number: a range (from / to, either end open) or a bound (≥, ≤ …);
 *   - a date: a range, before or after, with the admin's calendar;
 *   - a Yes / No switch: Sí or No.
 * Under it, live: «Esta regla aplica a N de M personas», and the first few names. Everything in place — no
 * native dialog; the styled Select.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { conferenceApi } from "../lib/conference";
import { Select } from "../lib/Select";
import { DateField } from "../lib/DateField";
import { FEE_LOCATION, FEE_PERSON, draftForField, draftReady, fromDraft, isListOp, needsValue, opsFor, searchPeople, toggleIn } from "../lib/feeRules";

const lbl = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5";
const input = "w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium text-sm";
const chip = "inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-800 border border-blue-100 pl-2.5 pr-1 py-0.5 text-[11px] font-bold";

/** The values a list condition picks from: ticked with their counts, searchable, another one can be added. */
function ValuePicker({ tx, values, list, onChange, loading }: { tx: any; values: { value: string; count: number }[]; list: string[]; onChange: (l: string[]) => void; loading: boolean }) {
    const [q, setQ] = useState("");
    const [other, setOther] = useState("");
    const known = new Set(values.map((v) => v.value));
    const extra = list.filter((v) => !known.has(v)).map((v) => ({ value: v, count: 0 }));
    const all = [...values, ...extra];
    const shown = q.trim() ? all.filter((v) => v.value.toLowerCase().includes(q.trim().toLowerCase())) : all;
    const add = () => { if (other.trim()) { onChange(toggleIn(list, other, true)); setOther(""); } };
    return (
        <div className="space-y-2" data-fee-values="">
            {all.length > 8 && <input type="search" className={input} placeholder={tx('fee.values.search', 'Buscar un valor')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tx('fee.values.search', 'Buscar un valor')} />}
            <ul className="border-2 border-gray-100 rounded-xl divide-y divide-gray-50 max-h-56 overflow-y-auto">
                {loading && <li className="px-3 py-2.5 text-sm text-gray-400">{tx('fee.loading', 'Cargando…')}</li>}
                {!loading && shown.length === 0 && <li className="px-3 py-2.5 text-sm text-gray-400">{tx('fee.values.none', 'Nadie tiene todavía un valor en este campo. Escribe uno abajo.')}</li>}
                {shown.map((v) => (
                    <li key={v.value}>
                        <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50" data-fee-value={v.value}>
                            <input type="checkbox" className="w-4 h-4 shrink-0 accent-blue-600" checked={list.includes(v.value)} onChange={(e) => onChange(toggleIn(list, v.value, e.target.checked))} />
                            <span className="flex-1 min-w-0 truncate text-sm font-medium text-gray-800">{v.value}</span>
                            <span className="text-[11px] font-bold text-gray-400 tabular-nums">{v.count ? tx('fee.values.count', '{n} personas', { n: v.count }) : tx('fee.values.new', 'nadie aún')}</span>
                        </label>
                    </li>
                ))}
            </ul>
            <div className="flex gap-2">
                <input className={input} value={other} onChange={(e) => setOther(e.target.value)} placeholder={tx('fee.values.other', 'Otro valor')} aria-label={tx('fee.values.other', 'Otro valor')}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
                <button type="button" className="px-4 rounded-xl border-2 border-gray-100 text-xs font-black uppercase tracking-widest text-gray-600 hover:border-blue-400 disabled:opacity-40" disabled={!other.trim()} onClick={add}>{tx('fee.values.add', 'Agregar')}</button>
            </div>
        </div>
    );
}

/** The roster, to tick one or more people: search (name, document, locality) and a locality filter. */
function PeoplePicker({ tx, people, list, onChange, loading }: { tx: any; people: any[]; list: string[]; onChange: (l: string[]) => void; loading: boolean }) {
    const [q, setQ] = useState("");
    const [loc, setLoc] = useState("");
    const locs = useMemo(() => [...new Set(people.map((p) => p.location).filter(Boolean))].sort(), [people]);
    const found = searchPeople(people, q, loc).slice(0, 200);
    const byId = new Map(people.map((p) => [String(p.id), p]));
    return (
        <div className="space-y-2" data-fee-people="">
            {list.length > 0 && (
                <div className="flex flex-wrap gap-1.5" aria-label={tx('fee.people.chosen', 'Escogidas')}>
                    {list.map((id) => (
                        <span key={id} className={chip}>
                            {byId.get(id)?.name || `#${id}`}
                            <button type="button" className="inline-flex w-5 h-5 shrink-0 items-center justify-center rounded-full hover:bg-blue-100" aria-label={tx('fee.people.remove', 'Quitar')} onClick={() => onChange(toggleIn(list, id, false))}><i className="fa-solid fa-xmark text-[10px]" aria-hidden="true"></i></button>
                        </span>
                    ))}
                </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_11rem] gap-2">
                <input type="search" className={input} placeholder={tx('fee.people.search', 'Buscar por nombre, documento o localidad')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tx('fee.people.search', 'Buscar por nombre, documento o localidad')} />
                <Select className={input} value={loc} onChange={(e) => setLoc(e.target.value)} aria-label={tx('fee.people.location', 'Localidad')}>
                    <option value="">{tx('fee.people.all', 'Todas las localidades')}</option>
                    {locs.map((l) => <option key={l} value={l}>{l}</option>)}
                </Select>
            </div>
            <ul className="border-2 border-gray-100 rounded-xl divide-y divide-gray-50 max-h-56 overflow-y-auto">
                {loading && <li className="px-3 py-2.5 text-sm text-gray-400">{tx('fee.loading', 'Cargando…')}</li>}
                {!loading && found.length === 0 && <li className="px-3 py-2.5 text-sm text-gray-400">{tx('fee.people.none', 'Nadie coincide con la búsqueda.')}</li>}
                {found.map((p) => (
                    <li key={p.id}>
                        <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50" data-fee-person={p.id}>
                            <input type="checkbox" className="w-4 h-4 shrink-0 accent-blue-600" checked={list.includes(String(p.id))} onChange={(e) => onChange(toggleIn(list, String(p.id), e.target.checked))} />
                            <span className="min-w-0">
                                <span className="block text-sm font-bold text-gray-900 truncate">{p.name}</span>
                                <span className="block text-[11px] text-gray-500 truncate">{[p.location, p.document].filter(Boolean).join(' · ')}</span>
                            </span>
                        </label>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function FeeRuleBuilder({ conferenceId, fields, draft, onChange, tx, error }: {
    conferenceId: number; fields: any[]; draft: any; onChange: (d: any) => void; tx: (k: string, f: string, v?: any) => string; error?: string | null;
}) {
    const [choices, setChoices] = useState<{ field: string; values: any[]; people: any[]; loading: boolean }>({ field: '', values: [], people: [], loading: false });
    const [preview, setPreview] = useState<any>(null);
    // The fields a rule can use: the form's (health answers never price), plus the locality and «Personas».
    const usable = (fields || []).filter((f) => f.type !== 'health' && f.name !== 'health_conditions' && f.name !== FEE_LOCATION);
    const opLabel = (op: string) => tx(`fee.op.${op}`, op);

    // The choices of a list or people condition, loaded once per field.
    useEffect(() => {
        const f = draft.field;
        if (!f || !(draft.kind === 'enum' || draft.kind === 'person')) return;
        if (choices.field === f) return;
        let alive = true;
        setChoices({ field: f, values: [], people: [], loading: true });
        conferenceApi.feeRuleValues(conferenceId, f)
            .then((r) => { if (alive) setChoices({ field: f, values: r.values || [], people: r.people || [], loading: false }); })
            .catch(() => { if (alive) setChoices({ field: f, values: [], people: [], loading: false }); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft.field, draft.kind, conferenceId]);

    // «Esta regla aplica a N personas», a moment after the last change.
    const seq = useRef(0);
    useEffect(() => {
        if (!draftReady(draft)) { setPreview(null); return; }
        const n = ++seq.current;
        const t = setTimeout(() => {
            conferenceApi.previewFeeRule({ conference_id: conferenceId, ...fromDraft(draft) })
                .then((r) => { if (n === seq.current) setPreview(r); })
                .catch(() => { if (n === seq.current) setPreview(null); });
        }, 350);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(fromDraft(draft)), conferenceId]);

    const set = (patch: any) => onChange({ ...draft, ...patch });
    const ops = opsFor(draft.kind, draft.op);
    const dateOrNumber = (val: string, onVal: (v: string) => void, aria: string) => (draft.kind === 'date'
        ? <DateField value={val} onChange={onVal} ariaLabel={aria} clearable className={input} />
        : <input type="number" step="any" inputMode="decimal" className={input} value={val} onChange={(e) => onVal(e.target.value)} aria-label={aria} />);

    return (
        <div className="space-y-3" data-fee-builder={draft.kind}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label className={lbl} htmlFor="fee-field">{tx('fee.field', 'Aplica a')}</label>
                    <Select id="fee-field" className={input} value={draft.field} onChange={(e) => onChange(draftForField(e.target.value, fields))}>
                        <option value="">{tx('fee.field.always', 'Todos (sin condición)')}</option>
                        <option value={FEE_PERSON}>{tx('fee.field.person', 'Personas que escojo')}</option>
                        <option value={FEE_LOCATION}>{tx('fee.field.location', 'Localidad')}</option>
                        {usable.map((f) => <option key={f.id || f.name} value={f.name}>{f.label || f.name}</option>)}
                    </Select>
                </div>
                {draft.kind !== 'always' && draft.kind !== 'switch' && (
                    <div>
                        <label className={lbl} htmlFor="fee-op">{tx('fee.op', 'Condición')}</label>
                        <Select id="fee-op" className={input} value={draft.op} onChange={(e) => set({ op: e.target.value })}>
                            {ops.map((o) => <option key={o} value={o}>{opLabel(o)}</option>)}
                        </Select>
                    </div>
                )}
            </div>

            {draft.kind === 'switch' && (
                <div>
                    <span className={lbl}>{tx('fee.switch', 'Respuesta')}</span>
                    <div className="flex gap-2" role="radiogroup" aria-label={tx('fee.switch', 'Respuesta')}>
                        {['Sí', 'No'].map((v) => (
                            <button key={v} type="button" role="radio" aria-checked={draft.value === v} data-fee-switch={v} onClick={() => set({ op: 'eq', value: v })}
                                className={`flex-1 py-2.5 rounded-xl text-sm font-bold border-2 transition ${draft.value === v ? 'border-blue-500 bg-blue-50/50 text-blue-700' : 'border-gray-100 text-gray-500'}`}>{v === 'Sí' ? tx('fee.yes', 'Sí') : tx('fee.no', 'No')}</button>
                        ))}
                    </div>
                </div>
            )}
            {draft.kind === 'person' && isListOp(draft.op) && <PeoplePicker tx={tx} people={choices.people} list={draft.list} onChange={(list) => set({ list })} loading={choices.loading} />}
            {draft.kind === 'enum' && isListOp(draft.op) && <ValuePicker tx={tx} values={choices.values} list={draft.list} onChange={(list) => set({ list })} loading={choices.loading} />}
            {(draft.kind === 'number' || draft.kind === 'date') && draft.op === 'between' && (
                <div className="grid grid-cols-2 gap-3">
                    <div><span className={lbl}>{tx('fee.from', 'Desde')}</span>{dateOrNumber(draft.range[0], (v) => set({ range: [v, draft.range[1]] }), tx('fee.from', 'Desde'))}</div>
                    <div><span className={lbl}>{tx('fee.to', 'Hasta')}</span>{dateOrNumber(draft.range[1], (v) => set({ range: [draft.range[0], v] }), tx('fee.to', 'Hasta'))}</div>
                    <p className="col-span-2 text-[11px] text-gray-400 -mt-1">{tx('fee.range.hint', 'Incluye los dos extremos. Deja uno vacío para un rango abierto.')}</p>
                </div>
            )}
            {(draft.kind === 'number' || draft.kind === 'date') && draft.op !== 'between' && needsValue(draft.op) && (
                <div><span className={lbl}>{tx('fee.value', 'Valor')}</span>{dateOrNumber(draft.value, (v) => set({ value: v }), tx('fee.value', 'Valor'))}</div>
            )}
            {(draft.kind === 'text' || (draft.kind === 'enum' && !isListOp(draft.op))) && needsValue(draft.op) && (
                <div><label className={lbl} htmlFor="fee-text">{tx('fee.value', 'Valor')}</label><input id="fee-text" className={input} value={draft.value} onChange={(e) => set({ value: e.target.value })} /></div>
            )}
            {error && <p className="text-xs font-bold text-rose-600" role="alert" data-fee-error="">{error}</p>}

            <div className={`rounded-xl px-4 py-3 text-xs border ${preview ? 'bg-emerald-50 border-emerald-100 text-emerald-900' : 'bg-gray-50 border-gray-100 text-gray-500'}`} aria-live="polite" data-fee-preview={preview ? preview.count : ''}>
                {!preview ? tx('fee.preview.wait', 'Completa la condición para ver a quién aplica.') : (
                    <>
                        <span className="font-black">{tx('fee.preview', 'Esta regla aplica a {n} de {total} personas.', { n: preview.count, total: preview.total })}</span>
                        {preview.sample.length > 0 && <span className="block mt-1 text-emerald-800">{preview.sample.join(', ')}{preview.count > preview.sample.length ? ` ${tx('fee.cond.more', 'y {n} más', { n: preview.count - preview.sample.length })}` : ''}</span>}
                    </>
                )}
            </div>
        </div>
    );
}

export default FeeRuleBuilder;

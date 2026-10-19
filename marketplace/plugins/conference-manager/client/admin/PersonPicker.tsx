// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «+ Añadir» of the «Registrar pago» sheet (2.18.0): choose the people a payment covers. Inline in the sheet
 * (no extra layer): a search that ignores accents, a location filter, «Solo con saldo» (on by default) and
 * one chip per family group that adds the group's payable members at once. Cancelled people are never
 * offered (they owe nothing and cannot be paid, D-P19). The admin may mix locations (D-P3).
 */
import React, { useMemo, useState } from "react";
import { MAX_PARTS } from "../lib/feeSplit";
import { OWED_PENDING, owedWords } from "../lib/feePayments";
import { foldText, matchesQuery } from "../lib/roster";
import { factsOf, money } from "./FeeBits";
import { useTx } from "./MealScanner";

/** One person as the payment sheets need them (cents). */
export type PersonOption = {
    id: number; name: string; locationId: number | null; locationName: string; family: string;
    cancelled: boolean; dueC: number; validatedC: number; pendingC: number; toCoverC: number;
};

/** The family-group chips of a list: «Pérez (3)», counting only the payable members not already chosen. */
export function familyGroups(options: PersonOption[], chosen: number[]): { key: string; ids: number[] }[] {
    const by = new Map<string, number[]>();
    for (const o of options) {
        if (!o.family || o.cancelled || o.toCoverC <= 0 || chosen.includes(o.id)) continue;
        const k = o.family.trim();
        if (!k) continue;
        if (!by.has(k)) by.set(k, []);
        by.get(k)!.push(o.id);
    }
    return [...by.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids })).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * `lockLocationId`: only that location's people are offered (correcting a payment a location's portal
 * recorded: D-P3, the server refuses anyone else).
 */
export function PersonPicker({ options, chosen, onAdd, onDone, locations, lockLocationId = null }: {
    options: PersonOption[]; chosen: number[]; onAdd: (ids: number[]) => void; onDone: () => void; locations: { id: number; name: string }[]; lockLocationId?: number | null;
}) {
    const tx = useTx();
    const [q, setQ] = useState('');
    const [picked, setLoc] = useState('');
    const loc = lockLocationId != null ? String(lockLocationId) : picked;
    const [onlyOwing, setOnlyOwing] = useState(true);
    const hay = useMemo(() => new Map(options.map((o) => [o.id, foldText(`${o.name} ${o.family} ${o.locationName}`)])), [options]);
    const list = useMemo(() => options.filter((o) => !o.cancelled
        && !chosen.includes(o.id)
        && (!onlyOwing || o.toCoverC > 0)
        && (!loc || (loc === 'none' ? o.locationId == null : String(o.locationId) === loc))
        && matchesQuery(hay.get(o.id) || '', q)), [options, chosen, onlyOwing, loc, q, hay]);
    const groups = useMemo(() => familyGroups(list, chosen), [list, chosen]);
    const room = MAX_PARTS - chosen.length;
    const shown = list.slice(0, 50);
    return (
        <div className="rounded-2xl border-2 border-blue-100 bg-blue-50/30 p-3 sm:p-4 space-y-3" data-person-picker="">
            {/* A placeholder short enough for a 16 px field on a 320 px phone («Buscar persona»: the long one was
                cut mid-word on every phone); its name for a screen reader starts with those words (label in name) and says what it searches, and the location
                select wraps under the search when both do not fit. */}
            <div className="flex flex-wrap gap-2" data-picker-filters="">
                <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx('fees.picker.search', 'Buscar persona')}
                    aria-label={tx('fees.picker.search.hint', 'Buscar persona por nombre, grupo o localidad')} data-picker-search=""
                    className="min-w-0 flex-[2_1_20rem] min-h-[44px] border-2 border-gray-100 rounded-xl px-3 bg-white focus:border-blue-500 outline-none text-base text-gray-900" />
                <select value={loc} onChange={(e) => setLoc(e.target.value)} aria-label={tx('location', 'Localidad')} disabled={lockLocationId != null}
                    className="min-w-0 flex-[1_1_12rem] min-h-[44px] border-2 border-gray-100 rounded-xl px-3 bg-white focus:border-blue-500 outline-none text-base text-gray-900 disabled:opacity-70">
                    <option value="">{tx('all.locations', 'Todas las localidades')}</option>
                    {locations.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                    <option value="none">{tx('no.location', 'Sin localidad')}</option>
                </select>
            </div>
            <label className="inline-flex items-center gap-3 min-h-[44px] cursor-pointer">
                <input type="checkbox" checked={onlyOwing} onChange={(e) => setOnlyOwing(e.target.checked)} className="w-5 h-5 accent-blue-600" />
                <span className="text-sm font-bold text-gray-800">{tx('fees.picker.owing', 'Solo con saldo')}</span>
            </label>
            {lockLocationId != null && <p className="text-xs font-bold text-gray-600" data-picker-locked=""><i className="fa-solid fa-lock mr-1.5" aria-hidden="true"></i>{tx('fees.picker.locked', 'Pago registrado por una localidad: solo sus personas.')}</p>}
            {groups.length > 0 && (
                <div className="flex flex-wrap gap-2" data-family-chips="">
                    {groups.slice(0, 12).map((g) => (
                        <button key={g.key} type="button" disabled={room <= 0} onClick={() => onAdd(g.ids.slice(0, room))}
                            className="min-h-[44px] px-3 rounded-full bg-white border border-blue-200 text-xs font-black text-blue-800 hover:border-blue-500 disabled:opacity-40">
                            <i className="fa-solid fa-people-roof mr-1" aria-hidden="true"></i>{g.key} ({g.ids.length})
                        </button>
                    ))}
                </div>
            )}
            {/* Capped by the room the sheet has (40dvh: ~156 px on a phone held sideways, whose sheet body between the
                pinned header and footer is ~184 px; 18rem elsewhere) and NOT overscroll-contained: at its end a drag goes
                on scrolling the sheet. A fixed 288 px list was taller than the whole visible body (2.18.0 review UX6-7,
                the portal's PUX-4 twin). `max-h-72` stays for a browser without dvh (the style is dropped there). */}
            <ul className="max-h-72 overflow-y-auto divide-y divide-gray-100 rounded-xl border border-gray-100 bg-white" style={{ maxHeight: 'min(18rem, 40dvh)' }} data-picker-list="">
                {shown.length === 0 && <li className="px-4 py-6 text-center text-sm font-bold text-gray-500">{tx('fees.picker.none', 'Nadie coincide.')}</li>}
                {shown.map((o) => (
                    <li key={o.id}>
                        <button type="button" disabled={room <= 0} onClick={() => onAdd([o.id])} data-pick={o.id}
                            className="w-full min-h-[48px] px-4 py-2 text-left flex items-center gap-3 hover:bg-blue-50 disabled:opacity-40">
                            <i className="fa-solid fa-plus text-blue-600" aria-hidden="true"></i>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-black text-gray-900 break-words">{o.name}</span>
                                <span className="flex flex-wrap gap-x-1 text-[11px] font-bold text-gray-500" data-pick-facts="">{factsOf([o.locationName || tx('no.location', 'Sin localidad'), o.family || null], null, { long: true })}</span>
                            </span>
                            {/* The register sheet's words (owedWords): «debe $X», or «falta $X» over «$Y por validar». */}
                            {(() => {
                                const w = owedWords(o.toCoverC, o.pendingC);
                                if (!w) return <span className="text-xs font-black text-gray-700 whitespace-nowrap">{tx('fees.picker.covered', 'al día')}</span>;
                                return (
                                    <span className="shrink-0 text-right" data-picker-owed={w.kind}>
                                        <span className="block text-xs font-black text-gray-700 whitespace-nowrap">{tx(w.key, w.fallback, { amount: money(w.cents) })}</span>
                                        {w.pendingC > 0 && <span className="block text-[11px] font-bold text-amber-800 whitespace-nowrap">{tx(OWED_PENDING.key, OWED_PENDING.fallback, { amount: money(w.pendingC) })}</span>}
                                    </span>
                                );
                            })()}
                        </button>
                    </li>
                ))}
            </ul>
            {list.length > shown.length && <p className="text-[11px] font-bold text-gray-500">{tx('fees.picker.more', 'Hay {n} más: afina la búsqueda.', { n: list.length - shown.length })}</p>}
            {room <= 0 && <p role="alert" className="text-xs font-bold text-rose-700">{tx('fees.error.too_many', 'Máximo 200 personas por pago.')}</p>}
            <div className="flex justify-end">
                <button type="button" onClick={onDone} className="min-h-[44px] px-4 rounded-xl bg-white border-2 border-gray-100 text-xs font-black uppercase tracking-widest text-gray-700 hover:border-blue-400">{tx('fees.picker.done', 'Listo')}</button>
            </div>
        </div>
    );
}

export default PersonPicker;

// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The «Inscripciones» toolbar (2.18.0): every filter runs in the browser (lib/roster.ts).
 *
 * - Search: full width, 16 px (iOS zooms into anything smaller), instant, accents and case ignored (D10).
 * - From 768 px (`data-cm-roster-deskbar`): Localidad (multi), Pago, «Por validar (N)» (D9), «Ocultar
 *   canceladas» (D8, off by default), Alojamiento, «Mostrar 10/20/50/100» (D2) and «Columnas» (up to 3 form
 *   fields next to the name, D4; one that does not fit the screen shows under the name).
 * - Below 768 px (`data-cm-roster-phonebar`): one row of three 44 px buttons — «Filtros (n)» (a sheet with
 *   the same filters and «Mostrar»), Excel and «Nueva».
 */
import React, { useEffect, useRef, useState } from "react";
import { PAGE_SIZES } from "../lib/paging";
import { LAYER, dismissOnOutside, pushEscape } from "../lib/overlay";
import { scrollBoxOf } from "../lib/paging";
import { ROSTER_MAX_COLUMNS, activeFilterCount } from "../lib/roster";
import { Overlay } from "./Overlay";
import { useTx } from "./MealScanner";
import { Select } from "../lib/Select";

const selectCls = 'min-h-[44px] border-2 border-gray-100 rounded-xl px-3 bg-white focus:border-blue-500 outline-none text-sm font-bold text-gray-800';
const chip = (on: boolean) => `min-h-[44px] px-4 rounded-xl border-2 text-xs font-black uppercase tracking-widest inline-flex items-center gap-2 ${on ? 'border-blue-600 bg-blue-50 text-blue-800' : 'border-gray-100 bg-white text-gray-700 hover:border-gray-300'}`;

/** The popover's narrowest width (px: min-w-[16rem]). */
export const POPOVER_MIN_PX = 256;
/**
 * Which edge of its button a popover hangs from: `prefer` when the popover fits that way inside the box it is
 * shown in (with 8 px to spare), else the other side, else the side with more room. «Columnas» was always
 * right-aligned: when the filter bar wrapped and the chip started a line (an iPad in portrait, a phone held
 * sideways, a 1093 px window beside the sidebar), its 256 px list stuck out ~100 px to the LEFT of the panel —
 * its checkboxes cut off.
 */
export function popoverSide(btn: { left: number; right: number }, box: { left: number; right: number }, width = POPOVER_MIN_PX, prefer: 'left' | 'right' = 'left'): 'left' | 'right' {
    const fitsRight = btn.right - width >= box.left + 8;   // right-0: it extends to the left of the button's right edge
    const fitsLeft = btn.left + width <= box.right - 8;    // left-0: it extends to the right of the button's left edge
    if (prefer === 'right' ? fitsRight : fitsLeft) return prefer;
    if (prefer === 'right' ? fitsLeft : fitsRight) return prefer === 'right' ? 'left' : 'right';
    return btn.left - box.left < box.right - btn.right ? 'left' : 'right';
}

/**
 * A checkbox list in a small popover (location multi-select, «Columnas»). It closes with Escape (the focus
 * goes back to its button), a click on the page (the click-catcher) and a press anywhere else outside it —
 * the admin sidebar too, which sits above the click-catcher (dismissOnOutside). It hangs from the edge of its
 * button that keeps it inside the panel (popoverSide), measured when it opens.
 */
export function Popover({ label, icon, badge, children, align = 'left', testId, initialOpen = false }: any) {
    const [open, setOpen] = useState(!!initialOpen);
    const [side, setSide] = useState<'left' | 'right'>(align === 'right' ? 'right' : 'left');
    const rootRef = useRef<HTMLDivElement | null>(null);
    const btnRef = useRef<HTMLButtonElement | null>(null);
    const measureSide = (): 'left' | 'right' => {
        const b = btnRef.current;
        if (!b || typeof b.getBoundingClientRect !== 'function' || typeof window === 'undefined') return align === 'right' ? 'right' : 'left';
        const sc: any = scrollBoxOf(rootRef.current as any);
        const box = sc && typeof sc.getBoundingClientRect === 'function' ? sc.getBoundingClientRect() : { left: 0, right: window.innerWidth };
        return popoverSide(b.getBoundingClientRect(), box, POPOVER_MIN_PX, align === 'right' ? 'right' : 'left');
    };
    useEffect(() => {
        if (!open) return undefined;
        const offEscape = pushEscape(() => { setOpen(false); try { btnRef.current?.focus(); } catch { /* gone */ } return true; });
        const offOutside = dismissOnOutside(typeof document !== 'undefined' ? document : null, rootRef.current, () => setOpen(false));
        return () => { offEscape(); offOutside(); };
    }, [open]);
    return (
        <div ref={rootRef} className="relative" data-popover={testId}>
            <button ref={btnRef} type="button" onClick={() => { if (!open) setSide(measureSide()); setOpen(!open); }} aria-expanded={open ? 'true' : 'false'} className={chip(open || !!badge)}>
                <i className={`fa-solid ${icon}`} aria-hidden="true"></i>{label}{badge ? <span className="px-1.5 rounded-full bg-blue-600 text-white text-[10px]">{badge}</span> : null}
                <i className={`fa-solid fa-chevron-${open ? 'up' : 'down'} text-[9px]`} aria-hidden="true"></i>
            </button>
            {open && (
                <>
                    <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} aria-hidden="true"></div>
                    <div className={`absolute z-[70] mt-2 ${side === 'right' ? 'right-0' : 'left-0'} min-w-[16rem] max-w-[min(22rem,calc(100vw-2rem))] bg-white border border-gray-100 rounded-2xl shadow-2xl p-2`} data-popover-side={side}>
                        {typeof children === 'function' ? children(() => setOpen(false)) : children}
                    </div>
                </>
            )}
        </div>
    );
}

function CheckRow({ checked, onChange, children, disabled }: any) {
    return (
        <label className={`flex items-center gap-3 min-h-[44px] px-3 rounded-xl ${disabled ? 'opacity-40' : 'hover:bg-blue-50 cursor-pointer'}`}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="w-5 h-5 accent-blue-600 shrink-0" />
            <span className="text-sm font-bold text-gray-800 break-words">{children}</span>
        </label>
    );
}

/** The filter controls themselves (shared by the desktop bar and the phone sheet). */
function FilterFields({ filters, setFilters, locationOptions, pendingTotal, size, onSize, stacked }: any) {
    const tx = useTx();
    const toggleLoc = (key: string, on: boolean) => setFilters({ ...filters, locationIds: on ? [...filters.locationIds, key] : filters.locationIds.filter((k) => k !== key) });
    const locList = (
        <div className="max-h-72 overflow-y-auto" data-location-options="">
            {locationOptions.map((o) => <CheckRow key={o.key} checked={filters.locationIds.includes(o.key)} onChange={(on) => toggleLoc(o.key, on)}>{o.name}</CheckRow>)}
            {filters.locationIds.length > 0 && <button type="button" onClick={() => setFilters({ ...filters, locationIds: [] })} className="w-full min-h-[44px] text-xs font-black uppercase tracking-widest text-gray-600 hover:text-gray-900">{tx('deselect.all', 'Deseleccionar todo')}</button>}
        </div>
    );
    const payment = (
        <Select aria-label={tx('roster.filter.payment', 'Pago')} value={filters.payment} onChange={(e) => setFilters({ ...filters, payment: e.target.value })} className={selectCls}>
            <option value="">{tx('roster.filter.payment.all', 'Pago: todos')}</option>
            <option value="unpaid">{tx('fees.pill.unpaid', 'Sin pagar')}</option>
            <option value="partial">{tx('fees.pill.partial', 'Abono')}</option>
            <option value="paid">{tx('fees.pill.paid', 'Pagado')}</option>
        </Select>
    );
    const room = (
        <Select aria-label={tx('roster.filter.room', 'Alojamiento')} value={filters.room} onChange={(e) => setFilters({ ...filters, room: e.target.value })} className={selectCls}>
            <option value="">{tx('roster.filter.room.all', 'Alojamiento: todos')}</option>
            <option value="with">{tx('roster.filter.room.with', 'Con habitación')}</option>
            <option value="without">{tx('roster.room.none', 'Sin habitación')}</option>
        </Select>
    );
    const sizeSel = (
        <Select aria-label={tx('roster.page.size', 'Mostrar')} value={String(size)} onChange={(e) => onSize(Number(e.target.value))} className={selectCls} data-page-size="">
            {PAGE_SIZES.map((n) => <option key={n} value={String(n)}>{tx('roster.page.size.n', 'Mostrar {n}', { n })}</option>)}
        </Select>
    );
    const pending = (
        <button type="button" onClick={() => setFilters({ ...filters, pending: !filters.pending })} aria-pressed={filters.pending ? 'true' : 'false'} className={chip(filters.pending)} data-filter-pending="">
            <i className="fa-solid fa-clock" aria-hidden="true"></i>{tx('roster.filter.pending', 'Por validar ({n})', { n: pendingTotal })}
        </button>
    );
    const cancelled = (
        <button type="button" onClick={() => setFilters({ ...filters, hideCancelled: !filters.hideCancelled })} aria-pressed={filters.hideCancelled ? 'true' : 'false'} className={chip(filters.hideCancelled)} data-filter-cancelled="">
            <i className="fa-solid fa-eye-slash" aria-hidden="true"></i>{tx('roster.filter.hide.cancelled', 'Ocultar canceladas')}
        </button>
    );
    // 2.36.6: the registrations coordinators withdrew (to review or restore them).
    const withdrawn = (
        <button type="button" onClick={() => setFilters({ ...filters, withdrawn: !filters.withdrawn })} aria-pressed={filters.withdrawn ? 'true' : 'false'} className={chip(!!filters.withdrawn)} data-filter-withdrawn="">
            <i className="fa-solid fa-user-minus" aria-hidden="true"></i>{tx('roster.filter.withdrawn', 'Solo retiradas')}
        </button>
    );
    if (stacked) {
        return (
            <div className="space-y-4">
                <div><p className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-1">{tx('location', 'Localidad')}</p>{locList}</div>
                <div className="grid grid-cols-1 gap-2">{payment}{room}</div>
                <div className="flex flex-wrap gap-2">{pending}{cancelled}{withdrawn}</div>
                <div><p className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-1">{tx('roster.page.size', 'Mostrar')}</p>{sizeSel}</div>
            </div>
        );
    }
    return (
        <>
            <Popover label={filters.locationIds.length === 0 ? tx('all.locations', 'Todas las localidades') : tx('roster.filter.locations.n', '{n} localidades', { n: filters.locationIds.length })}
                icon="fa-location-dot" badge={filters.locationIds.length || null} testId="locations">{locList}</Popover>
            {payment}
            {pending}
            {cancelled}
            {withdrawn}
            {room}
            {sizeSel}
        </>
    );
}

export function RosterFilters({ filters, setFilters, locationOptions, pendingTotal, size, onSize, fields, columns, setColumns, canExcel, canManage, onExcel, onNew }: any) {
    const tx = useTx();
    const [sheet, setSheet] = useState(false);
    const n = activeFilterCount(filters);
    const toggleCol = (name: string, on: boolean) => setColumns(on ? [...columns, name].slice(0, ROSTER_MAX_COLUMNS) : columns.filter((c) => c !== name));
    return (
        <div className="space-y-3 mb-6" data-roster-toolbar="">
            {/* Wraps by the space it has: on a tablet the row was too narrow for the search plus both buttons. */}
            <div className="flex flex-wrap gap-3">
                <div className="relative min-w-0" style={{ flex: '1 1 16rem' }}>
                    <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm" aria-hidden="true"></i>
                    <input type="search" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })}
                        placeholder={tx('search.participants', 'Buscar participantes...')} aria-label={tx('search.participants', 'Buscar participantes...')}
                        className="w-full min-h-[48px] pl-11 pr-4 bg-gray-50/60 border-2 border-transparent focus:border-blue-500 focus:bg-white rounded-2xl outline-none text-base font-medium text-gray-900 placeholder:text-gray-400" data-roster-search="" />
                </div>
                <div className="flex flex-wrap gap-2" data-cm-roster-deskactions="">
                    {canExcel && <button type="button" onClick={onExcel} className="min-h-[48px] px-5 rounded-2xl bg-white border-2 border-gray-100 text-emerald-700 hover:border-emerald-500 font-black text-[10px] uppercase tracking-widest whitespace-nowrap"><i className="fa-solid fa-file-excel mr-1.5" aria-hidden="true"></i>{tx('excel.custom', 'Excel personalizado')}</button>}
                    {canManage && <button type="button" onClick={onNew} className="min-h-[48px] px-6 rounded-2xl bg-blue-600 text-white hover:bg-blue-700 font-black italic tracking-tighter whitespace-nowrap shadow-xl shadow-blue-500/30"><i className="fa-solid fa-plus mr-2" aria-hidden="true"></i>{tx('new.inscription', 'Nueva Inscripción')}</button>}
                </div>
            </div>
            {/* Phone: three equal buttons */}
            <div data-cm-roster-phonebar="" className="grid grid-cols-3 gap-2">
                <button type="button" onClick={() => setSheet(true)} className={`${chip(n > 0)} justify-center`} data-open-filters="">
                    <i className="fa-solid fa-sliders" aria-hidden="true"></i>{n ? tx('roster.filters.n', 'Filtros ({n})', { n }) : tx('roster.filters', 'Filtros')}
                </button>
                {canExcel ? <button type="button" onClick={onExcel} className={`${chip(false)} justify-center text-emerald-700`}><i className="fa-solid fa-file-excel" aria-hidden="true"></i>Excel</button> : <span></span>}
                {canManage ? <button type="button" onClick={onNew} className="min-h-[44px] rounded-xl bg-blue-600 text-white font-black text-xs uppercase tracking-widest inline-flex items-center justify-center gap-2"><i className="fa-solid fa-plus" aria-hidden="true"></i>{tx('roster.new.short', 'Nueva')}</button> : <span></span>}
            </div>
            {/* Desktop: the filters inline */}
            <div data-cm-roster-deskbar="" className="flex-wrap items-center gap-2">
                <FilterFields filters={filters} setFilters={setFilters} locationOptions={locationOptions} pendingTotal={pendingTotal} size={size} onSize={onSize} />
                {fields.length > 0 && (
                    <Popover label={tx('roster.columns', 'Columnas')} icon="fa-table-columns" align="right" testId="columns">
                        <p className="px-3 py-2 text-[11px] font-bold text-gray-500">{tx('roster.columns.hint', 'Hasta {n} datos junto al nombre; los que no quepan en la pantalla se ven bajo el nombre. La ficha (⋮) los tiene todos.', { n: ROSTER_MAX_COLUMNS })}</p>
                        <div className="max-h-72 overflow-y-auto">
                            {fields.map((f) => (
                                <CheckRow key={f.name} checked={columns.includes(f.name)} disabled={!columns.includes(f.name) && columns.length >= ROSTER_MAX_COLUMNS}
                                    onChange={(on) => toggleCol(f.name, on)}>{f.label || f.name}</CheckRow>
                            ))}
                        </div>
                    </Popover>
                )}
                {n > 0 && <button type="button" onClick={() => setFilters({ ...filters, locationIds: [], payment: '', pending: false, hideCancelled: false, room: '' })} className="min-h-[44px] px-3 text-[10px] font-black uppercase tracking-widest text-gray-500 hover:text-gray-800"><i className="fa-solid fa-xmark mr-1" aria-hidden="true"></i>{tx('accounting.clear.filters', 'Quitar filtros')}</button>}
            </div>
            {sheet && (
                <Overlay layer={LAYER.sheet} onBackdrop={() => setSheet(false)} onEscape={() => setSheet(false)}>
                    <div role="dialog" aria-modal="true" aria-labelledby="cm-roster-filters-title" className="bg-white rounded-[32px] shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden">
                        <div className="bg-gray-50/50 px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
                            <h3 id="cm-roster-filters-title" className="font-black text-xl text-gray-900 italic tracking-tighter">{tx('roster.filters', 'Filtros')}</h3>
                            <button type="button" onClick={() => setSheet(false)} aria-label={tx('close', 'Cerrar')} className="w-11 h-11 shrink-0 flex items-center justify-center rounded-2xl text-gray-500 hover:bg-gray-100"><i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i></button>
                        </div>
                        <div className="px-5 py-5">
                            <FilterFields stacked filters={filters} setFilters={setFilters} locationOptions={locationOptions} pendingTotal={pendingTotal} size={size} onSize={onSize} />
                        </div>
                        <div className="px-5 py-4 border-t border-gray-100 flex justify-between gap-2" data-cm-sheet-foot="">
                            <button type="button" onClick={() => setFilters({ ...filters, locationIds: [], payment: '', pending: false, hideCancelled: false, room: '' })} className="min-h-[44px] px-4 text-xs font-black uppercase tracking-widest text-gray-600">{tx('accounting.clear.filters', 'Quitar filtros')}</button>
                            <button type="button" onClick={() => setSheet(false)} className="min-h-[44px] px-6 rounded-2xl bg-blue-600 text-white font-black text-xs uppercase tracking-widest">{tx('roster.filters.apply', 'Ver resultados')}</button>
                        </div>
                    </div>
                </Overlay>
            )}
        </div>
    );
}

export default RosterFilters;

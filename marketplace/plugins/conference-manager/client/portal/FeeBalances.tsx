"use client";

/**
 * «Saldos por persona» — where the coordinator picks the people one receipt pays for (owner decision
 * D-P17: the multi-select lives here, not in «Participantes»). Each row says what the person still owes,
 * what is awaiting validation and what was returned; a family-group chip («Pérez (3)») picks that group's
 * people who still owe something; the header box ticks THIS page (tri-state) and «Seleccionar los N» goes
 * up to 200 (the server's limit for one payment). A cancelled person or one who owes nothing cannot be
 * ticked. While people are selected a bar stays at the bottom of the screen (above the home indicator):
 * «n seleccionadas · $X por cobrar · Registrar pago (n)».
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { BALANCE_FILTERS, BALANCE_FILTER_LABEL, matchesBalanceFilter, money, type BalanceC, type BalanceFilter } from "./feePayments";
import {
    PAGE_SIZES, SELECTION_MAX, clampPage, familyChips, pageAfterResize, pageCount, pageSelectionState, pageSlice, pageWindow, rangeOf, readPageSize, scrollToListTop,
    selectAllCapped, selectPage, toggleId, writePageSize, type FamilyGroup,
} from "./participants";
import { normalizeSearch } from "./lodgingView";
import { Badge, Button, CheckboxLabel, EmptyState, MoreButton, Pager, cx, touchTextCls } from "./ui";

export type FeeBalancesProps = {
    balances: ReadonlyMap<number, BalanceC>;
    nameOf: (id: number) => string;
    groups: FamilyGroup[];
    selected: number[];
    onSelect: (ids: number[]) => void;
    onRegister: (ids: number[]) => void;
    onOpenPerson: (id: number) => void;
    canRecord: boolean;
    initialFilter?: BalanceFilter;
    /** The search to start with (a remembered state, a server render). */
    initialQuery?: string;
};

/**
 * One line of what a person's money looks like right now. Each «·» is glued (U+00A0) to the fact after it: a narrow
 * line breaks before it, never leaving it alone at the end of a line (2.18.0 review UX6-3/UX6-4, a twin surface).
 */
export function balanceText(b: BalanceC): string {
    if (b.cancelled) return b.validated > 0 ? `Cancelada ·\u00a0${money(b.validated)} pagados` : "Cancelada";
    const parts: string[] = [];
    if (b.pending > 0) parts.push(`${money(b.pending)} por validar`);
    if (b.toCover > 0) parts.push(b.pending > 0 ? `falta ${money(b.toCover)}` : `debe ${money(b.toCover)}`);
    else if (b.pending === 0) parts.push(b.due > 0 ? "Al día" : "Sin cuota");
    if (b.credit > 0) parts.push(`+${money(b.credit)} a favor`);
    return parts.join(" ·\u00a0");
}

/** What a screen reader says for a person's row: their name AND their money («Ana Pérez: debe $250,00, Devuelto»). */
export const balanceRowLabel = (name: string, b: BalanceC): string =>
    [`${name}: ${balanceText(b)}`, b.returned > 0 ? "Devuelto" : ""].filter(Boolean).join(", ");

export default function FeeBalances({ balances, nameOf, groups, selected, onSelect, onRegister, onOpenPerson, canRecord, initialFilter = "owing", initialQuery = "" }: FeeBalancesProps) {
    const [filter, setFilter] = useState<BalanceFilter>(initialFilter);
    const [q, setQ] = useState(initialQuery);
    const [page, setPage] = useState(1);
    const [size, setSize] = useState<number>(() => readPageSize());
    const [allGroups, setAllGroups] = useState(false);
    const ids = useMemo(() => [...balances.keys()].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "es") || a - b), [balances, nameOf]);
    const words = normalizeSearch(q).split(/\s+/).filter(Boolean);
    const found = (id: number) => !words.length || words.every((w) => normalizeSearch(nameOf(id)).includes(w));
    // Each chip counts the people it would show WITH the search, as «Participantes» does («Todos (1)» while one
    // person matches): «Con saldo (26)» beside three rows found was a promise the list did not keep.
    const counts = useMemo(() => {
        const hit = ids.filter((id) => !words.length || words.every((w) => normalizeSearch(nameOf(id)).includes(w)));
        return Object.fromEntries(BALANCE_FILTERS.map((f) => [f, hit.filter((id) => matchesBalanceFilter(balances.get(id)!, f)).length])) as Record<BalanceFilter, number>;
    }, [ids, balances, q, nameOf]);
    const shown = ids.filter((id) => matchesBalanceFilter(balances.get(id)!, filter) && found(id));
    const current = clampPage(page, shown.length, size);
    const rows = pageSlice(shown, current, size);
    const range = rangeOf(current, size, shown.length);
    const count = pageCount(shown.length, size);
    const payable = (id: number) => !!balances.get(id)?.payable;
    const pageIds = rows.filter(payable);
    const allIds = shown.filter(payable);
    const pageState = pageSelectionState(pageIds, selected);
    const selectedCover = selected.reduce((s, id) => s + (balances.get(id)?.toCover ?? 0), 0);
    // Groups of 2+ payable people, filtered by the search, at most 8 unless «Ver más grupos» (familyChips).
    const chips = familyChips(groups, payable, nameOf, words, { all: allGroups });
    const groupChips = chips.shown;
    const resize = (n: number) => { setPage(pageAfterResize(current, size, n)); setSize(n); writePageSize(n); };
    // A page change brings the list's top into view (a phone would land at the bottom of the new page).
    const topRef = useRef<HTMLElement>(null);
    const jump = useRef(false);
    useEffect(() => {
        if (!jump.current) return;
        jump.current = false;
        scrollToListTop(topRef.current);
    }, [current]);
    const goPage = (p: number) => { jump.current = true; setPage(clampPage(p, shown.length, size)); };
    const toggleGroup = (g: { ids: number[] }) => {
        const all = g.ids.every((id) => selected.includes(id));
        onSelect(all ? selected.filter((id) => !g.ids.includes(id)) : selectAllCapped([...selected, ...g.ids]).ids);
    };

    return (
        <section ref={topRef} className="space-y-0 scroll-mt-24" aria-labelledby="saldos-title" data-testid="fee-balances">
            <div className="px-4 sm:px-6 pt-5 pb-3 space-y-3 border-b border-gray-50">
                <h3 id="saldos-title" className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Saldos por persona</h3>
                <input
                    type="search"
                    className={cx("w-full min-h-11 border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium text-gray-900 placeholder:text-gray-400", touchTextCls)}
                    placeholder="Buscar persona"
                    aria-label="Buscar persona en los saldos"
                    value={q}
                    onChange={(e) => { setQ(e.target.value); setPage(1); }}
                />
                <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar saldos">
                    {BALANCE_FILTERS.map((f) => (
                        <button key={f} type="button" aria-pressed={filter === f} onClick={() => { setFilter(f); setPage(1); }}
                            className={cx("min-h-11 px-3 rounded-xl text-xs font-bold border transition-colors", filter === f ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-gray-200 text-gray-600 hover:border-blue-300")}
                            data-balance-filter={f}>
                            {BALANCE_FILTER_LABEL[f]} <span className="tabular-nums opacity-80">({counts[f]})</span>
                        </button>
                    ))}
                </div>
                {groupChips.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Seleccionar un grupo familiar">
                        <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">Grupos:</span>
                        {groupChips.map((g) => {
                            const on = g.ids.every((id) => selected.includes(id));
                            return (
                                <button key={g.name} type="button" aria-pressed={on} onClick={() => toggleGroup(g)}
                                    className={cx("min-h-11 px-3 rounded-xl text-xs font-bold border transition-colors", on ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-indigo-200 text-indigo-700 hover:bg-indigo-50")}
                                    data-group-chip={g.name}>
                                    {g.name} ({g.ids.length})
                                </button>
                            );
                        })}
                        {chips.hidden > 0 && (
                            <button type="button" onClick={() => setAllGroups(true)} className="min-h-11 px-3 rounded-xl text-xs font-black text-indigo-700 underline" data-more-groups="">
                                Ver más grupos ({chips.hidden})
                            </button>
                        )}
                    </div>
                )}
                {pageState === "all" && allIds.length > pageIds.length && selected.length < Math.min(allIds.length, SELECTION_MAX) && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-blue-900 bg-blue-50 border border-blue-100 rounded-xl px-3 py-1">
                        <span>Seleccionaste las {pageIds.length} personas con saldo de esta página.</span>
                        <button type="button" className="min-h-11 font-black underline" onClick={() => onSelect(selectAllCapped(allIds).ids)} data-select-all="">
                            Seleccionar las {Math.min(allIds.length, SELECTION_MAX)}{allIds.length > SELECTION_MAX ? ` (máximo ${SELECTION_MAX} por pago)` : ""}
                        </button>
                    </div>
                )}
            </div>

            {ids.length === 0 ? (
                <div className="p-6"><EmptyState icon="fa-users" padding="sm" title="Aún no hay participantes" /></div>
            ) : shown.length === 0 ? (
                <div className="p-6">
                    <EmptyState icon={filter === "owing" && !words.length ? "fa-circle-check" : "fa-magnifying-glass"} padding="sm" title={filter === "owing" && !words.length ? "Todos al día" : "Nadie coincide con el filtro."} />
                </div>
            ) : (
                <>
                    <ul className="divide-y divide-gray-50" data-testid="balance-list">
                        <li className="flex items-center gap-1 px-2 py-1 bg-gray-50/50">
                            <CheckboxLabel label="Seleccionar a todos los de esta página" checked={pageState === "all"} indeterminate={pageState === "some"} disabled={!pageIds.length || !canRecord} onChange={(on) => onSelect(selectPage(selected, pageIds, on))} />
                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">Esta página</span>
                        </li>
                        {rows.map((id) => {
                            const b = balances.get(id)!;
                            const name = nameOf(id);
                            const isSel = selected.includes(id);
                            return (
                                <li key={id} className={cx("flex items-center gap-1 pl-2 pr-1", isSel && "bg-blue-50/50")} data-balance-row={id}>
                                    <CheckboxLabel label={`Seleccionar a ${name}`} checked={isSel} disabled={!b.payable || !canRecord} onChange={() => onSelect(isSel ? toggleId(selected, id) : selectAllCapped(toggleId(selected, id)).ids)} />
                                    <button type="button" onClick={() => onOpenPerson(id)} className="flex-1 min-w-0 text-left py-3 pl-1 min-h-14 rounded-xl focus-visible:ring-2 focus-visible:ring-blue-400 outline-none" aria-label={balanceRowLabel(name, b)}>
                                        <span className={cx("block font-bold text-gray-900 break-words", b.cancelled && "line-through decoration-gray-400 text-gray-500")}>{name}</span>
                                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
                                            {b.cancelled && <Badge tone="gray" size="xs">Cancelada</Badge>}
                                            {b.returned > 0 && <Badge tone="orange" size="xs" icon="fa-rotate-left">Devuelto</Badge>}
                                            <span className="tabular-nums">{balanceText(b)}</span>
                                        </span>
                                    </button>
                                    <MoreButton name={name} id={id} onClick={() => onOpenPerson(id)} />
                                </li>
                            );
                        })}
                    </ul>
                    <Pager page={current} count={count} from={range.from} to={range.to} total={range.total} windowPages={pageWindow(current, count)} size={size} sizes={PAGE_SIZES} onPage={goPage} onSize={resize} label="Páginas de saldos" itemsLabel="personas" />
                </>
            )}

            {selected.length > 0 && (
                <div className="sticky bottom-0 z-20 bg-white/95 backdrop-blur border-t border-gray-100 px-4 sm:px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-wrap items-center gap-2 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.15)]" data-testid="selection-bar">
                    <span className="text-xs font-black text-gray-700 mr-auto">
                        {selected.length} {selected.length === 1 ? "seleccionada" : "seleccionadas"} · <span className="tabular-nums">{money(selectedCover)}</span> por cobrar
                        {selected.length >= SELECTION_MAX && <span className="block font-bold text-amber-800" data-selection-cap="">Máximo {SELECTION_MAX} personas por pago</span>}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => onSelect([])}>Limpiar</Button>
                    <Button variant="success" size="sm" block className="sm:w-auto" icon="fa-file-invoice-dollar" disabled={!canRecord} onClick={() => onRegister(selected)} data-action="register-selected">
                        Registrar pago ({selected.length})
                    </Button>
                </div>
            )}
        </section>
    );
}

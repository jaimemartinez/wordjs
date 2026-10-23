// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Participantes» — the coordinator's roster, paged in the browser (tables-design D1/D2: 20 per page,
 * «Mostrar 10/20/50/100» remembered per device), searchable without accents, filterable by payment state.
 * (Named ParticipantList, not Participants: a case-insensitive file system cannot hold Participants.tsx
 * next to the pure rules in participants.ts.)
 *
 * Compact rows (D4): on a phone each row is the name, the payment state with what is paid of the fee, the
 * money still under review, and the «⋮»; tapping anywhere on the row or the «⋮» opens the participant's
 * full sheet (D5). From 768 px a table adds up to two form columns — only when the card has room for them
 * (participantTableMinRem; a size container); on a narrower card they fold under the name («Correo: …»), and
 * their headers wrap between words, never over the next one. A cancelled inscription is struck through and
 * labelled «Cancelada» (D-P19) — it owes nothing and cannot be paid.
 *
 * Paying several people at once lives in «Pagos de cuotas › Saldos» (D-P17). Only against a plugin OLDER
 * than «Pagos de cuotas» (no `features.fee_payments`) does this list keep its checkboxes and the
 * «Registrar pago (n)» bar (`legacy`), which open the old bulk-payment dialog.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PortalField } from "./form";
import { fmtMoney } from "./form";
import {
    DEFAULT_ROSTER_FILTER, PAGE_SIZES, PAY_FILTERS, PAY_FILTER_LABEL, PAY_STATE_LABEL, SELECTION_MAX, clampPage, extraColumns, fieldRaw, filterPeople,
    isCancelled, pageAfterResize, pageCount, pageSelectionState, pageSlice, pageWindow, payFilterCounts, payStateOf, personName, rangeOf, readPageSize,
    rowHaystack, selectAllCapped, selectPage, toggleId, writePageSize, type PayFilter, type PayState, type PortalPerson, type RosterFilter,
} from "./participants";
import { fieldDisplayValue } from "./lodgingView";
import { ConsentChip } from "./ConsentBits";
import { Badge, Button, CheckboxLabel, EmptyState, MoreButton, Pager, cx, thCls, thWrapCls, touchTextCls, type BadgeTone } from "./ui";

export const PAY_STATE_TONE: Record<PayState, BadgeTone> = { cancelled: "gray", paid: "emerald", partial: "amber", unpaid: "rose" };

/** The row's money chips: what awaits validation and what was returned (D-P6), when there is any. */
export function MoneyChips({ person }: { person: PortalPerson }) {
    const pending = Number(person.pending_amount) || 0;
    const returned = Number(person.returned_amount) || 0;
    if (pending <= 0 && returned <= 0) return null;
    return (
        <span className="inline-flex flex-wrap gap-1.5">
            {pending > 0 && <Badge tone="amber" size="xs" icon="fa-clock" data-chip="pending">${fmtMoney(pending)} por validar</Badge>}
            {returned > 0 && <Badge tone="orange" size="xs" icon="fa-rotate-left" data-chip="returned">Devuelto</Badge>}
        </span>
    );
}

/** «Pagado» pill + «$paid / $due» (or «Cancelada» + «Sin cuota»). */
export function PayCell({ person, compact }: { person: PortalPerson; compact?: boolean }) {
    const st = payStateOf(person);
    return (
        <span className={cx("inline-flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0", !compact && "justify-center")}>
            <Badge tone={PAY_STATE_TONE[st]} size="xs" data-pay-state={st}>{PAY_STATE_LABEL[st]}</Badge>
            {/* Each amount whole; the line may break only at « / » (a peso fee «$250.000,00 / $250.000,00»). */}
            <span className="text-[11px] font-bold text-gray-500 tabular-nums">
                {st === "cancelled" ? "Sin cuota" : <><span className="text-gray-900 whitespace-nowrap">${fmtMoney(person.amount_paid)}</span> / <span className="whitespace-nowrap">${fmtMoney(person.total_due)}</span></>}
            </span>
        </span>
    );
}

/**
 * What a screen reader says for a person's row — the name AND what the row shows: «Ana Pérez: Abono, $200,00
 * de $250,00, $50,00 por validar» (or «…: Cancelada, Sin cuota»). It was «Ver ficha de Ana Pérez» for every
 * row: nobody could tell who had paid without opening each sheet.
 */
export function participantRowLabel(name: string, p: PortalPerson): string {
    const st = payStateOf(p);
    const parts: string[] = [PAY_STATE_LABEL[st]];
    if (st === "cancelled") parts.push("Sin cuota");
    else parts.push(`$${fmtMoney(p.amount_paid)} de $${fmtMoney(p.total_due)}`);
    const pending = Number(p.pending_amount) || 0;
    const returned = Number(p.returned_amount) || 0;
    if (st !== "cancelled" && pending > 0) parts.push(`$${fmtMoney(pending)} por validar`);
    if (st !== "cancelled" && returned > 0) parts.push("Devuelto");
    return `${name}: ${parts.join(", ")}`;
}

/**
 * A form value that may wrap at an e-mail's or address's natural points (after «@» and «/», before «.» and
 * «_») instead of being cut with «…»: «maria.fernanda@example.com» breaks as «maria.fernanda@» / «example.com».
 */
export function softBreakParts(text: string, minLen = 12): string[] {
    const out: string[] = [""];
    for (const w of String(text ?? "").split(/(\s+)/)) {
        if (w.length <= minLen || /\s/.test(w)) { out[out.length - 1] += w; continue; }
        let seg = "";
        for (const ch of w) {
            if ((ch === "." || ch === "_") && seg) { out[out.length - 1] += seg; out.push(""); seg = ""; }
            seg += ch;
            if (ch === "@" || ch === "/") { out[out.length - 1] += seg; out.push(""); seg = ""; }
        }
        out[out.length - 1] += seg;
    }
    return out.filter((x, i) => x !== "" || i === 0);
}
export function SoftWrap({ text }: { text: string }) {
    return <>{softBreakParts(text).map((part, i) => <React.Fragment key={i}>{i > 0 ? <wbr /> : null}{part}</React.Fragment>)}</>;
}

/**
 * The desktop table's columns (rem, padding included): the name never below PL_NAME_MIN_REM, each form column
 * PL_FORM_COL_REM — room for its header to wrap between words and for a value such as «Bucaramanga». At an iPad
 * in portrait (768–834 px) two form columns used to get ~45 px each: «CORREO ELECTRÓNICO» ran over «TELÉFONO»
 * and values broke mid-word. Below participantTableMinRem the form columns fold under the name.
 */
export const PL_NAME_MIN_REM = 12;
export const PL_FORM_COL_REM = 9;
export const PL_PAY_REM = 11;
export const PL_MORE_REM = 4;
export const PL_CHECK_REM = 3.5;
export const participantTableMinRem = (formCols: number, legacy = false): number =>
    PL_NAME_MIN_REM + formCols * PL_FORM_COL_REM + PL_PAY_REM + PL_MORE_REM + (legacy ? PL_CHECK_REM : 0);
/** The size-container rules of the table card (named `cm-pl`): the form columns, or their folds under the name. */
export function participantTableCss(formCols: number, legacy = false): string {
    const below = (participantTableMinRem(formCols, legacy) - 0.01).toFixed(2);
    return `[data-pl-card] [data-pl-fold] { display: none; }
@container cm-pl (max-width: ${below}rem) { [data-pl-card] [data-pl-col] { display: none; } [data-pl-card] [data-pl-fold] { display: block; } }`;
}

export type LegacySelection = {
    selected: number[];
    setSelected: (ids: number[]) => void;
    onPay: (ids: number[]) => void;
    /** False when the location has no enabled form of payment. */
    canPay: boolean;
};

export type ParticipantListProps = {
    people: PortalPerson[];
    fields: PortalField[];
    /** Open the participant's sheet (row tap, name, «⋮»). */
    onOpen: (id: number) => void;
    /** The id whose sheet is open (the «⋮» says aria-expanded). */
    openId?: number | null;
    /** Only against a plugin older than «Pagos de cuotas»: the old multi-select + bulk payment. */
    legacy?: LegacySelection | null;
    /** Start the page on this filter (tests / remembered state). */
    initialFilter?: Partial<RosterFilter>;
    initialPage?: number;
};

export default function ParticipantList({ people, fields, onOpen, openId = null, legacy = null, initialFilter, initialPage = 1 }: ParticipantListProps) {
    const [filter, setFilter] = useState<RosterFilter>({ ...DEFAULT_ROSTER_FILTER, ...initialFilter });
    const [page, setPage] = useState(initialPage);
    const [size, setSize] = useState<number>(() => readPageSize());
    const topRef = useRef<HTMLDivElement>(null);
    const jump = useRef(false);

    // Fold every row once per data change, not on every keystroke.
    const haystacks = useMemo(() => new Map(people.map((p) => [Number(p.id), rowHaystack(p, fields)])), [people, fields]);
    const shown = useMemo(() => filterPeople(people, fields, filter, haystacks), [people, fields, filter, haystacks]);
    const counts = useMemo(() => payFilterCounts(people, fields, { ...filter, pay: "all" }, haystacks), [people, fields, filter, haystacks]);
    const cancelledCount = useMemo(() => people.filter(isCancelled).length, [people]);
    const cols = useMemo(() => extraColumns(fields, 2), [fields]);
    const current = clampPage(page, shown.length, size);
    const rows = pageSlice(shown, current, size);
    const range = rangeOf(current, size, shown.length);
    const count = pageCount(shown.length, size);

    // A page change brings the list's top into view (otherwise a phone lands at the bottom of the new page).
    useEffect(() => {
        if (!jump.current) return;
        jump.current = false;
        const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        topRef.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    }, [current]);

    const setF = (patch: Partial<RosterFilter>) => { setFilter((f) => ({ ...f, ...patch })); setPage(1); };
    const goPage = (p: number) => { jump.current = true; setPage(clampPage(p, shown.length, size)); };
    const resize = (n: number) => { setPage(pageAfterResize(current, size, n)); setSize(n); writePageSize(n); };

    // Legacy multi-select: only payable rows (not cancelled) can be ticked.
    const selectable = (p: PortalPerson) => !isCancelled(p);
    const pageIds = rows.filter(selectable).map((p) => Number(p.id));
    const allIds = shown.filter(selectable).map((p) => Number(p.id));
    const sel = legacy?.selected ?? [];
    const pageState = pageSelectionState(pageIds, sel);
    const filtered = filter.q.trim() !== "" || filter.pay !== "all" || filter.hideCancelled;

    return (
        <div ref={topRef} className="scroll-mt-24" data-testid="portal-participants">
            <div className="px-4 sm:px-8 pt-5 pb-4 space-y-3 border-b border-gray-50">
                <div className="relative">
                    <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                    <input
                        type="search"
                        className={cx("w-full min-h-11 border-2 border-gray-100 rounded-xl pl-10 pr-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium text-gray-900 placeholder:text-gray-400", touchTextCls)}
                        placeholder="Buscar participante"
                        aria-label="Buscar participante por nombre o cualquier dato"
                        value={filter.q}
                        maxLength={100}
                        onChange={(e) => setF({ q: e.target.value })}
                        data-testid="participants-search"
                    />
                </div>
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por estado de pago">
                    {PAY_FILTERS.map((k) => (
                        <button
                            key={k}
                            type="button"
                            aria-pressed={filter.pay === k}
                            onClick={() => setF({ pay: k as PayFilter })}
                            className={cx("min-h-11 px-3 rounded-xl text-xs font-bold border transition-colors", filter.pay === k ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-gray-200 text-gray-600 hover:border-blue-300")}
                            data-pay-filter={k}
                        >
                            {PAY_FILTER_LABEL[k]} <span className="tabular-nums opacity-80">({counts[k]})</span>
                        </button>
                    ))}
                    {cancelledCount > 0 && (
                        <label className="min-h-11 inline-flex items-center gap-2 px-2 text-xs font-bold text-gray-600 cursor-pointer">
                            <input type="checkbox" className="w-5 h-5 accent-blue-600" checked={filter.hideCancelled} onChange={(e) => setF({ hideCancelled: e.target.checked })} />
                            Ocultar canceladas ({cancelledCount})
                        </label>
                    )}
                </div>
                {legacy && pageState === "all" && allIds.length > pageIds.length && sel.length < Math.min(allIds.length, SELECTION_MAX) && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-blue-900 bg-blue-50 border border-blue-100 rounded-xl px-3 py-2">
                        <span>Seleccionaste las {pageIds.length} personas de esta página.</span>
                        <button type="button" className="min-h-11 font-black underline" onClick={() => legacy.setSelected(selectAllCapped(allIds).ids)}>
                            Seleccionar las {Math.min(allIds.length, SELECTION_MAX)}{allIds.length > SELECTION_MAX ? ` (máximo ${SELECTION_MAX} por pago)` : ""}
                        </button>
                    </div>
                )}
            </div>

            {people.length === 0 ? (
                <div className="p-6"><EmptyState icon="fa-users" padding="sm" title="No hay participantes registrados en esta localidad." /></div>
            ) : shown.length === 0 ? (
                <div className="p-6">
                    <EmptyState icon="fa-magnifying-glass" padding="sm" title="Nadie coincide con la búsqueda." action={filtered ? <Button variant="outline" size="sm" icon="fa-filter-circle-xmark" onClick={() => setF({ ...DEFAULT_ROSTER_FILTER })}>Quitar filtros</Button> : undefined} />
                </div>
            ) : (
                <>
                    {/* Phone: compact rows. */}
                    <ul className="md:hidden divide-y divide-gray-50" data-testid="participants-list">
                        {legacy && (
                            <li className="flex items-center gap-1 px-2 py-1 bg-gray-50/50">
                                <CheckboxLabel label="Seleccionar a todos los de esta página" checked={pageState === "all"} indeterminate={pageState === "some"} disabled={!pageIds.length} onChange={(on) => legacy.setSelected(selectPage(sel, pageIds, on))} />
                                <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">Esta página</span>
                            </li>
                        )}
                        {rows.map((p) => {
                            const id = Number(p.id);
                            const name = personName(p, fields);
                            const cancelled = isCancelled(p);
                            return (
                                <li key={id} className={cx("flex items-center gap-1 pl-2 pr-1", legacy && sel.includes(id) && "bg-blue-50/50")} data-person={id}>
                                    {legacy && (
                                        <CheckboxLabel label={`Seleccionar a ${name}`} checked={sel.includes(id)} disabled={cancelled} onChange={() => legacy.setSelected(toggleId(sel, id))} />
                                    )}
                                    <button type="button" onClick={() => onOpen(id)} className="flex-1 min-w-0 text-left py-3 pl-2 min-h-16 rounded-xl focus-visible:ring-2 focus-visible:ring-blue-400 outline-none" aria-label={participantRowLabel(name, p)} aria-haspopup="dialog">
                                        <span className={cx("block font-bold text-gray-900 break-words", cancelled && "line-through decoration-gray-400 text-gray-500")}>{name}</span>
                                        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                                            <PayCell person={p} compact />
                                            <MoneyChips person={p} />
                                            <ConsentChip consent={p.consent} />
                                        </span>
                                    </button>
                                    <MoreButton name={name} id={id} expanded={openId === id} onClick={() => onOpen(id)} />
                                </li>
                            );
                        })}
                    </ul>

                    {/* From 768 px: a table with up to two form columns (folded under the name on a narrow card). */}
                    <div className="hidden md:block" style={{ containerType: "inline-size", containerName: "cm-pl" }} data-pl-card="">
                        {cols.length > 0 && <style>{participantTableCss(cols.length, !!legacy)}</style>}
                        <table className="w-full text-sm text-left border-collapse table-fixed" data-testid="participants-table">
                            <thead>
                                <tr className="bg-gray-50/50">
                                    {legacy && (
                                        <th scope="col" className="px-2" style={{ width: `${PL_CHECK_REM}rem` }}>
                                            <CheckboxLabel label="Seleccionar a todos los de esta página" checked={pageState === "all"} indeterminate={pageState === "some"} disabled={!pageIds.length} onChange={(on) => legacy.setSelected(selectPage(sel, pageIds, on))} />
                                        </th>
                                    )}
                                    <th scope="col" className={thCls}>Participante</th>
                                    {cols.map((f) => <th key={f.name} scope="col" className={thWrapCls} style={{ width: `${PL_FORM_COL_REM}rem` }} data-pl-col="">{f.label}</th>)}
                                    <th scope="col" className={thCls} style={{ width: `${PL_PAY_REM}rem` }}>Pago</th>
                                    <th scope="col" style={{ width: `${PL_MORE_REM}rem` }}><span className="sr-only">Más información</span></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {rows.map((p) => {
                                    const id = Number(p.id);
                                    const name = personName(p, fields);
                                    const cancelled = isCancelled(p);
                                    return (
                                        <tr key={id} className={cx("hover:bg-blue-50/30 transition-colors", legacy && sel.includes(id) && "bg-blue-50/50")} data-person={id}>
                                            {legacy && (
                                                <td className="px-2 py-2">
                                                    <CheckboxLabel label={`Seleccionar a ${name}`} checked={sel.includes(id)} disabled={cancelled} onChange={() => legacy.setSelected(toggleId(sel, id))} />
                                                </td>
                                            )}
                                            <td className="px-6 py-3">
                                                <button type="button" onClick={() => onOpen(id)} className={cx("text-left font-bold text-gray-900 hover:text-blue-700 break-words min-h-11", cancelled && "line-through decoration-gray-400 text-gray-500")}>{name}</button>
                                                {cols.map((f) => {
                                                    const v = fieldDisplayValue(fieldRaw(p, f.name), f.type);
                                                    return v ? <span key={f.name} className="text-xs text-gray-600 break-words" data-pl-fold="" data-field-fold={f.name}><span className="font-bold text-gray-500">{f.label}:</span> <SoftWrap text={v} /></span> : null;
                                                })}
                                            </td>
                                            {cols.map((f) => {
                                                const v = fieldDisplayValue(fieldRaw(p, f.name), f.type);
                                                return <td key={f.name} className="px-3 py-3 text-xs text-gray-600 break-words" data-field-cell={f.name} data-pl-col="">{v ? <SoftWrap text={v} /> : <span className="text-gray-300">—</span>}</td>;
                                            })}
                                            <td className="px-4 py-3">
                                                <div className="flex flex-col gap-1 items-start">
                                                    <PayCell person={p} compact />
                                                    <MoneyChips person={p} />
                                                    <ConsentChip consent={p.consent} />
                                                </div>
                                            </td>
                                            <td className="pr-3 py-2 text-right"><MoreButton name={name} id={id} expanded={openId === id} onClick={() => onOpen(id)} /></td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    <Pager page={current} count={count} from={range.from} to={range.to} total={range.total} windowPages={pageWindow(current, count)} size={size} sizes={PAGE_SIZES} onPage={goPage} onSize={resize} label="Páginas de participantes" itemsLabel="participantes" />
                </>
            )}

            {legacy && sel.length > 0 && (
                <div className="sticky bottom-0 z-20 bg-white/95 backdrop-blur border-t border-gray-100 px-4 sm:px-8 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-wrap items-center gap-2" data-testid="legacy-selection-bar">
                    <span className="text-xs font-black text-gray-700 mr-auto">{sel.length} {sel.length === 1 ? "seleccionada" : "seleccionadas"}</span>
                    <Button variant="ghost" size="sm" onClick={() => legacy.setSelected([])}>Limpiar</Button>
                    <Button variant="success" size="sm" block className="sm:w-auto" icon="fa-file-invoice-dollar" disabled={!legacy.canPay} title={legacy.canPay ? undefined : "No hay formas de pago habilitadas para esta localidad."} onClick={() => legacy.onPay(sel)}>
                        Registrar pago ({sel.length})
                    </Button>
                </div>
            )}
        </div>
    );
}

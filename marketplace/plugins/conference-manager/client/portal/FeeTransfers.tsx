// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Pagos» of «Pagos de cuotas»: every payment of the coordinator's people. The ones the administration
 * RETURNED for correction come first, under «Requiere tu atención», with the administration's note; then
 * everything else, newest first. A row reads «$750,00 · Transferencia · 07/10/2026», the people
 * («Ana P., Luis P. +1») and the status; a payment the administration recorded for this location (D-P22)
 * reads «Registrado por la administración · tu parte $X» and is read-only. A tap opens the payment.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FEE_STATUSES, STATUS_META, dayLabel, money, orderTransfers, peopleLabel, recorderLabel, type FeeStatus, type PortalTransfer } from "./feePayments";
import { toCents } from "./feeSplit";
import { PAGE_SIZES, clampPage, pageAfterResize, pageCount, pageSlice, pageWindow, rangeOf, readPageSize, scrollToListTop, writePageSize } from "./participants";
import { Badge, Button, EmptyState, Pager, cx } from "./ui";

export type FeeTransfersProps = {
    transfers: PortalTransfer[];
    nameOf: (id: number) => string;
    onOpen: (id: number) => void;
    /** «Ver sus pagos»: only the payments of this person. */
    personId?: number | null;
    onClearPerson?: () => void;
    onRegister?: () => void;
    canRecord: boolean;
};

type StatusFilter = "all" | FeeStatus;

/**
 * What a screen reader says for a payment row — everything the row shows, not just «Ver el pago #12»:
 * «Pago #12: $750,00, Transferencia, 07/10/2026, Devuelto, Ana P., Luis P.» (+ the administration's note, or
 * «Registrado por la administración, tu parte $X»).
 */
export function transferRowLabel(t: PortalTransfer, nameOf: (id: number) => string): string {
    const parts = [`Pago #${t.id}: ${money(toCents(t.amount))}`, t.method || "", t.paid_on ? dayLabel(t.paid_on) : "", STATUS_META[t.status].label,
        peopleLabel(t.allocations.map((a) => a.inscription_id), nameOf)];
    if (t.foreign) parts.push(`${recorderLabel(t)}, tu parte ${money(toCents(t.amount))}`);
    else if ((t.status === "returned" || t.status === "rejected") && t.review_note) parts.push(`Nota de la administración: ${t.review_note}`);
    return parts.filter(Boolean).join(", ");
}

/**
 * The facts of a row — «$250.000,00», «Efectivo», «08/10/2026» — each WHOLE and carrying its own leading «· »: a
 * narrow phone line breaks between two facts, never after a «·» left alone at its end (2.18.0 review PUX-10).
 */
export function factsLine(t: Pick<PortalTransfer, "amount" | "method" | "paid_on">): string[] {
    return [money(toCents(t.amount)), t.method || "—", t.paid_on ? dayLabel(t.paid_on) : ""].filter(Boolean);
}

function TransferRow({ t, nameOf, onOpen }: { t: PortalTransfer; nameOf: (id: number) => string; onOpen: (id: number) => void }) {
    const meta = STATUS_META[t.status];
    const ids = t.allocations.map((a) => a.inscription_id);
    return (
        <li>
            <button type="button" onClick={() => onOpen(t.id)} className="w-full text-left px-4 sm:px-6 py-3 min-h-16 hover:bg-blue-50/30 focus-visible:ring-2 focus-visible:ring-blue-400 outline-none" data-transfer-row={t.id} aria-label={transferRowLabel(t, nameOf)}>
                <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-baseline gap-x-1 min-w-0" data-transfer-facts="">
                        {factsLine(t).map((f, i) => (
                            <span key={i} className={cx("whitespace-nowrap", i === 0 ? "font-black text-gray-900 tabular-nums" : "font-bold text-gray-500")}>{i > 0 ? "· " : ""}{f}</span>
                        ))}
                    </span>
                    <Badge tone={meta.tone} size="xs" icon={meta.icon} data-status={t.status}>{meta.label}</Badge>
                </span>
                <span className="mt-1 block text-sm text-gray-700 break-words">{peopleLabel(ids, nameOf)}</span>
                {t.foreign ? (
                    <span className="mt-0.5 block text-xs font-bold text-blue-800" data-foreign="">{recorderLabel(t)} · tu parte {money(toCents(t.amount))}</span>
                ) : (t.status === "returned" || t.status === "rejected") && t.review_note ? (
                    <span className={cx("mt-0.5 block text-xs font-bold line-clamp-2 break-words", t.status === "returned" ? "text-orange-800" : "text-rose-700")} data-review-note="">Nota de la administración: {t.review_note}</span>
                ) : null}
            </button>
        </li>
    );
}

export default function FeeTransfers({ transfers, nameOf, onOpen, personId = null, onClearPerson, onRegister, canRecord }: FeeTransfersProps) {
    const [status, setStatus] = useState<StatusFilter>("all");
    const [page, setPage] = useState(1);
    const [size, setSize] = useState<number>(() => readPageSize());
    const scoped = useMemo(() => (personId ? transfers.filter((t) => t.allocations.some((a) => a.inscription_id === personId)) : transfers), [transfers, personId]);
    const counts = useMemo(() => {
        const c: Record<StatusFilter, number> = { all: scoped.length, pending: 0, validated: 0, returned: 0, rejected: 0 };
        for (const t of scoped) c[t.status]++;
        return c;
    }, [scoped]);
    const filtered = status === "all" ? scoped : scoped.filter((t) => t.status === status);
    const { attention, rest } = orderTransfers(filtered);
    const current = clampPage(page, rest.length, size);
    const rows = pageSlice(rest, current, size);
    const range = rangeOf(current, size, rest.length);
    const count = pageCount(rest.length, size);
    const resize = (n: number) => { setPage(pageAfterResize(current, size, n)); setSize(n); writePageSize(n); };
    const filters: StatusFilter[] = ["all", ...FEE_STATUSES];
    // A page change brings the list's top into view (a phone would land at the bottom of the new page).
    const topRef = useRef<HTMLElement>(null);
    const jump = useRef(false);
    useEffect(() => {
        if (!jump.current) return;
        jump.current = false;
        scrollToListTop(topRef.current);
    }, [current]);
    const goPage = (p: number) => { jump.current = true; setPage(clampPage(p, rest.length, size)); };

    return (
        <section ref={topRef} className="scroll-mt-24" data-testid="fee-transfers">
            <div className="px-4 sm:px-6 pt-5 pb-3 space-y-3 border-b border-gray-50">
                {personId != null && (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-indigo-50 border border-indigo-100 px-3 py-1">
                        <span className="text-xs font-bold text-indigo-900">Pagos de {nameOf(personId)}</span>
                        {onClearPerson && <button type="button" onClick={onClearPerson} className="min-h-11 px-2 text-xs font-black text-indigo-700 underline" data-action="clear-person">Ver todos</button>}
                    </div>
                )}
                <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar pagos por estado">
                    {filters.map((f) => (
                        <button key={f} type="button" aria-pressed={status === f} onClick={() => { setStatus(f); setPage(1); }}
                            className={cx("min-h-11 px-3 rounded-xl text-xs font-bold border transition-colors", status === f ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-gray-200 text-gray-600 hover:border-blue-300")}
                            data-status-filter={f}>
                            {f === "all" ? "Todos" : STATUS_META[f].label} <span className="tabular-nums opacity-80">({counts[f]})</span>
                        </button>
                    ))}
                </div>
            </div>

            {scoped.length === 0 ? (
                <div className="p-6">
                    <EmptyState icon="fa-receipt" padding="sm" title={personId != null ? "Esta persona aún no tiene pagos." : "Aún no has registrado pagos."}
                        action={onRegister && canRecord ? <Button icon="fa-plus" onClick={onRegister}>Registrar pago</Button> : undefined} />
                </div>
            ) : filtered.length === 0 ? (
                <div className="p-6"><EmptyState icon="fa-filter" padding="sm" title="Ningún pago con ese estado." /></div>
            ) : (
                <>
                    {attention.length > 0 && (
                        <div className="bg-orange-50/50 border-b border-orange-100" data-testid="attention">
                            <h4 className="px-4 sm:px-6 pt-4 text-[10px] font-black uppercase tracking-widest text-orange-800"><i className="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden="true"></i>Requiere tu atención ({attention.length})</h4>
                            <ul className="divide-y divide-orange-100">{attention.map((t) => <TransferRow key={t.id} t={t} nameOf={nameOf} onOpen={onOpen} />)}</ul>
                        </div>
                    )}
                    {rest.length > 0 && <ul className="divide-y divide-gray-50" data-testid="transfer-list">{rows.map((t) => <TransferRow key={t.id} t={t} nameOf={nameOf} onOpen={onOpen} />)}</ul>}
                    <Pager page={current} count={count} from={range.from} to={range.to} total={range.total} windowPages={pageWindow(current, count)} size={size} sizes={PAGE_SIZES} onPage={goPage} onSize={resize} label="Páginas de pagos" itemsLabel="pagos" />
                </>
            )}
        </section>
    );
}

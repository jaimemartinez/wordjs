"use client";

/**
 * «Resumen» of «Pagos de cuotas»: the location's fees at a glance, computed per person in cents
 * (feePayments.ts summarize): Cuotas, Validado, Por validar, Por cobrar — plus Devuelto and A favor when
 * there is any — and one stacked bar whose three segments add up to the fees exactly.
 *
 * It replaces the three StatCards that sat above the tabs: their «Saldo Pendiente» counted cancelled
 * inscriptions and let one person's overpayment subtract from what the others owe.
 */
import React from "react";
import { barPercents, money, type FeeSummaryC } from "./feePayments";
import { KpiTile } from "./ui";

/**
 * «29 inscritos · 1 cancelada»: each count joined to its noun by a NO-BREAK space — on an iPhone SE the tile read
 * «29 inscritos · 1» / «cancelada» (2.18.0 skeptic round 4) — and the «·» to the count after it: the line breaks
 * before the «·», never leaving «29 inscritos ·» / «1 cancelada» (2.18.0 review UX6-4).
 */
export const peopleHint = (people: number, cancelled: number): string =>
    `${people}\u00a0${people === 1 ? "inscrito" : "inscritos"}${cancelled ? ` ·\u00a0${cancelled}\u00a0${cancelled === 1 ? "cancelada" : "canceladas"}` : ""}`;

export default function FeeSummary({ summary, onPending, onReturned }: { summary: FeeSummaryC; onPending?: () => void; onReturned?: () => void }) {
    const pct = barPercents(summary.bar);
    return (
        <section className="space-y-4" aria-label="Resumen de cuotas" data-testid="fee-summary">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiTile label="Cuotas" value={money(summary.due)} tone="gray" icon="fa-receipt" hint={peopleHint(summary.people, summary.cancelled)} testId="kpi-due" />
                <KpiTile label="Validado" value={money(summary.validated)} tone="emerald" icon="fa-circle-check" testId="kpi-validated" />
                <KpiTile label="Por validar" value={money(summary.pending)} tone="amber" icon="fa-clock" onClick={summary.pending > 0 ? onPending : undefined} testId="kpi-pending" />
                <KpiTile label="Por cobrar" value={money(summary.toCover)} tone="rose" icon="fa-hourglass-half" testId="kpi-to-cover" />
                {summary.returned > 0 && <KpiTile label="Devuelto" value={money(summary.returned)} tone="orange" icon="fa-rotate-left" onClick={onReturned} hint="Corrígelo y reenvíalo" testId="kpi-returned" />}
                {summary.credit > 0 && <KpiTile label="A favor" value={money(summary.credit)} tone="blue" icon="fa-hand-holding-dollar" hint="Pagado de más o de canceladas" testId="kpi-credit" />}
            </div>
            {summary.due > 0 && (
                <div>
                    <div className="flex h-3 w-full overflow-hidden rounded-full bg-gray-100" role="img" aria-label={`Validado ${pct.validated}%, por validar ${pct.pending}%, por cobrar ${pct.toCover}%`} data-testid="fee-bar">
                        <span className="h-full bg-emerald-500" style={{ width: `${pct.validated}%` }} data-bar="validated"></span>
                        <span className="h-full bg-amber-400" style={{ width: `${pct.pending}%` }} data-bar="pending"></span>
                        <span className="h-full bg-rose-200" style={{ width: `${pct.toCover}%` }} data-bar="to-cover"></span>
                    </div>
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold text-gray-600">
                        <li><span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 mr-1.5" aria-hidden="true"></span>Validado</li>
                        <li><span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400 mr-1.5" aria-hidden="true"></span>Por validar</li>
                        <li><span className="inline-block w-2.5 h-2.5 rounded-full bg-rose-200 mr-1.5" aria-hidden="true"></span>Por cobrar</li>
                    </ul>
                </div>
            )}
        </section>
    );
}

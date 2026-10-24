// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Retirar inscripción» in the coordinators' portal (conference-manager 2.36.6): a coordinator takes one of their
 * location's people out until the deadline the administration set («Los encargados pueden retirar inscripciones
 * hasta», GET /portal/me → `withdraw`). Never someone with a payment recorded: the administrator withdraws them. The
 * person leaves the list, the counts, the rooms, the meals and the badges; the record stays (who, when, why) and the
 * administrator may restore it. The server decides (POST /portal/inscriptions/:id/withdraw); this asks first, in the
 * app, naming the person, with an optional reason.
 */
import React, { useState } from "react";
import { Button, Notice } from "./ui";

export type WithdrawWindow = { until: string | null; open: boolean } | null | undefined;

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
/** «2026-10-30T18:00» → «30 de octubre, 18:00» (the conference's own clock, as the administrator typed it). */
export function withdrawUntilLabel(v: string | null | undefined): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v || ""));
    return m ? `${Number(m[3])} de ${MONTHS[Number(m[2]) - 1]}, ${m[4]}:${m[5]}` : String(v || "");
}

/** Some money is recorded for the person (validated, under review or returned): the administrator withdraws them. */
export const hasRecordedMoney = (b: { validated?: number; pending?: number; returned?: number }, amountPaid: unknown): boolean =>
    (Number(amountPaid) || 0) > 0 || (b.validated || 0) > 0 || (b.pending || 0) > 0 || (b.returned || 0) > 0;

export function PortalWithdrawSection({ inscriptionId, name, window: win, hasMoney, onWithdraw }: {
    inscriptionId: number; name: string; window: WithdrawWindow; hasMoney: boolean; onWithdraw: (id: number, reason: string) => Promise<void>;
}) {
    const [asking, setAsking] = useState(false);
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    if (!win || !win.open) return null;
    const go = async () => {
        if (busy) return;
        setBusy(true); setError("");
        try { await onWithdraw(inscriptionId, reason.trim()); }
        catch (e) { setError((e as Error)?.message || "No se pudo retirar la inscripción."); setBusy(false); }
    };
    return (
        <section className="space-y-3" aria-labelledby={`withdraw-${inscriptionId}`} data-sheet-section="retirar">
            <h4 id={`withdraw-${inscriptionId}`} className="text-[11px] font-black uppercase tracking-widest text-gray-500">Retirar inscripción</h4>
            {hasMoney ? (
                <p className="text-xs text-gray-600" data-withdraw-blocked="">
                    <i className="fa-solid fa-lock mr-1.5 text-gray-400" aria-hidden="true"></i>Tiene pagos registrados: pídele al administrador que la retire.
                </p>
            ) : !asking ? (
                <>
                    <p className="text-xs text-gray-500">Puedes retirar inscripciones hasta el {withdrawUntilLabel(win.until)}. La persona sale de la lista, de los cupos, del alojamiento y de las comidas; el administrador puede restaurarla.</p>
                    <Button variant="outline" icon="fa-user-minus" onClick={() => setAsking(true)} data-action="withdraw">Retirar inscripción</Button>
                </>
            ) : (
                <div className="rounded-2xl border-2 border-rose-100 bg-rose-50/60 p-3 space-y-2" role="group" aria-label="Confirmar retiro" data-withdraw-confirm="">
                    <p className="text-sm font-bold text-rose-900">¿Retirar la inscripción de <span style={{ overflowWrap: "anywhere" }}>{name}</span>?</p>
                    <label htmlFor={`withdraw-reason-${inscriptionId}`} className="block text-[10px] font-black uppercase tracking-widest text-gray-500">Motivo (opcional)</label>
                    <textarea id={`withdraw-reason-${inscriptionId}`} rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)}
                        className="w-full rounded-xl border-2 border-gray-100 p-2 text-base sm:text-sm text-gray-800" placeholder="Por ejemplo: ya no puede asistir" />
                    {error && <p className="text-xs font-bold text-rose-700" role="alert">{error}</p>}
                    <div className="flex flex-wrap gap-2">
                        <Button variant="danger" size="sm" icon={busy ? "fa-spinner animate-spin" : "fa-user-minus"} onClick={go} disabled={busy} data-action="withdraw-confirm">Sí, retirar</Button>
                        <Button variant="ghost" size="sm" onClick={() => { setAsking(false); setError(""); }} disabled={busy}>Cancelar</Button>
                    </div>
                </div>
            )}
        </section>
    );
}

/** «Puedes retirar inscripciones hasta …», near the list, while the deadline is open. */
export function WithdrawDeadlineNote({ window: win }: { window: WithdrawWindow }) {
    if (!win || !win.open) return null;
    return (
        <Notice tone="blue" icon="fa-user-minus" className="mx-4 sm:mx-6 mt-3" data-withdraw-note="">
            <span>Puedes retirar inscripciones hasta el {withdrawUntilLabel(win.until)} (en la ficha de cada persona, si no tiene pagos registrados).</span>
        </Notice>
    );
}

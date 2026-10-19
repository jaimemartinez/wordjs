"use client";

/**
 * One payment, as the coordinator sees it (payments-design 1.2 «Pagos»): its status, amount, form of
 * payment, date, reference, who recorded it, the administration's note when it was returned or rejected,
 * the split per person, and the receipt — fetched only when asked for («Ver comprobante»).
 *
 * Actions follow the server's state machine for the portal: its OWN payments can be corrected and resent
 * («Devuelto»), edited («Por validar») or deleted (both); a rejected one can be registered again with
 * «Duplicar» (the server copies its receipt). A validated payment is final. A payment the administration
 * recorded for this location's people (D-P22) is read-only: only this location's parts, no receipt, no
 * reference. One receipt counts in ONE payment: a rejected payment already registered again (and counting)
 * says so and offers no second «Duplicar»; the new one says which payment it registers again.
 */
import React, { useState } from "react";
import { STATUS_META, dayLabel, money, recorderLabel, stampDayLabel, type PortalTransfer } from "./feePayments";
import { toCents } from "./feeSplit";
import { Badge, Button, InfoRow, Modal, Notice, SheetNotice, sectionLabelCls } from "./ui";
import type { HubNotice } from "./feePayments";

export type TransferSheetProps = {
    transfer: PortalTransfer;
    nameOf: (id: number) => string;
    busy: boolean;
    onClose: () => void;
    onEdit: (t: PortalTransfer) => void;
    onDuplicate: (t: PortalTransfer) => void;
    onDelete: (t: PortalTransfer) => void;
    /** The receipt of payment `id` at split generation `allocGen` (createProofCache). */
    loadProof: (id: number, allocGen: number) => Promise<string>;
    /** What the hub has to say while this sheet is open (a delete that failed): shown here, not in a toast over it. */
    notice?: HubNotice | null;
};

/** The actions the coordinator has on a payment (the server enforces the same rules). */
export function transferActions(t: PortalTransfer): { edit: boolean; resend: boolean; remove: boolean; duplicate: boolean } {
    if (t.foreign) return { edit: false, resend: false, remove: false, duplicate: false };
    return {
        edit: t.can_edit && t.status === "pending",
        resend: t.can_edit && t.status === "returned",
        remove: t.can_delete,
        // Never a second copy of one receipt (the server answers 409 source_used).
        duplicate: t.status === "rejected" && !t.reused,
    };
}

export default function TransferSheet({ transfer: t, nameOf, busy, onClose, onEdit, onDuplicate, onDelete, loadProof, notice }: TransferSheetProps) {
    const meta = STATUS_META[t.status];
    const acts = transferActions(t);
    const [proof, setProof] = useState<{ phase: "idle" | "loading" | "shown" | "error"; url?: string }>({ phase: "idle" });
    const [big, setBig] = useState(false);
    const showProof = async () => {
        setProof({ phase: "loading" });
        try { setProof({ phase: "shown", url: await loadProof(t.id, t.alloc_gen) }); } catch { setProof({ phase: "error" }); }
    };
    const allocatedC = t.allocations.reduce((s, a) => s + toCents(a.amount), 0);
    const exact = allocatedC === toCents(t.amount);
    const footer = acts.edit || acts.resend || acts.remove || acts.duplicate ? (
        <>
            {acts.remove && <Button variant="dangerGhost" icon="fa-trash-can" onClick={() => onDelete(t)} disabled={busy} data-action="delete">Eliminar</Button>}
            {acts.duplicate && <Button variant="outline" icon="fa-copy" onClick={() => onDuplicate(t)} disabled={busy} data-action="duplicate">Duplicar</Button>}
            {acts.edit && <Button icon="fa-pen" onClick={() => onEdit(t)} disabled={busy} data-action="edit">Editar</Button>}
            {acts.resend && <Button variant="success" icon="fa-rotate-right" onClick={() => onEdit(t)} disabled={busy} data-action="resend">Corregir y reenviar</Button>}
        </>
    ) : undefined;
    return (
        <Modal title={`Pago #${t.id}`} subtitle={recorderLabel(t)} onClose={onClose} size="lg" testId="transfer-sheet" footer={footer}>
            <SheetNotice notice={notice} />
            <div className="flex flex-wrap items-center gap-2">
                <Badge tone={meta.tone} icon={meta.icon} data-status={t.status}>{meta.label}</Badge>
                <span className="text-2xl font-black tabular-nums text-gray-900">{money(toCents(t.amount))}</span>
                {t.foreign && <span className="text-xs font-bold text-gray-600">tu parte</span>}
            </div>

            {t.status === "returned" && !t.foreign && (
                <Notice tone="amber" icon="fa-rotate-left" data-review-note="">
                    <p className="font-bold">La administración devolvió este pago para que lo corrijas.</p>
                    {t.review_note && <p className="mt-1 whitespace-pre-line break-words">«{t.review_note}»</p>}
                    <p className="mt-1 text-xs">Corrige las personas, los montos o el comprobante y vuelve a enviarlo, o elimínalo.</p>
                </Notice>
            )}
            {t.status === "rejected" && !t.foreign && (
                <Notice tone="rose" icon="fa-circle-xmark" data-review-note="">
                    <p className="font-bold">La administración rechazó este pago.</p>
                    {t.review_note && <p className="mt-1 whitespace-pre-line break-words">Motivo: «{t.review_note}»</p>}
                    <p className="mt-1 text-xs">
                        {t.reused
                            ? (t.reused_by ? `Ya se registró de nuevo en el pago #${t.reused_by}: no se puede duplicar otra vez.` : "La administración ya lo registró de nuevo: no se puede duplicar otra vez.")
                            : "No cuenta en los saldos. Si el dinero sí se pagó, usa «Duplicar» para registrarlo de nuevo."}
                    </p>
                </Notice>
            )}
            {!t.foreign && t.duplicate_of != null && (
                <p className="text-xs font-bold text-gray-600" data-duplicate-of={t.duplicate_of}>
                    <i className="fa-solid fa-copy mr-1.5" aria-hidden="true"></i>Registra de nuevo el pago rechazado #{t.duplicate_of}.
                </p>
            )}
            {t.foreign && (
                <Notice tone="blue" icon="fa-building-columns">
                    {t.recorded_via === "admin" ? "Lo registró la administración para personas de tu localidad." : t.recorded_via === "legacy" ? "Un pago registrado antes de «Pagos de cuotas»." : "Lo registró otra localidad para personas que hoy están en la tuya."}{" "}
                    Ves solo la parte de tus participantes, sin comprobante.
                </Notice>
            )}

            <dl>
                <InfoRow label="Forma de pago">{t.method}</InfoRow>
                <InfoRow label="Fecha del pago">{dayLabel(t.paid_on) || null}</InfoRow>
                {!t.foreign && <InfoRow label="Referencia">{t.reference}</InfoRow>}
                {!t.foreign && t.note && <InfoRow label="Tu nota">{t.note}</InfoRow>}
                {t.reviewed_at && t.status !== "pending" && <InfoRow label="Revisado">{stampDayLabel(t.reviewed_at)}</InfoRow>}
            </dl>

            <section className="space-y-2" data-transfer-split="">
                {/* Flush with the «Forma de pago» labels above (labelCls's ml-1 indented it by 4 px). */}
                <h4 className={sectionLabelCls}>Reparto ({t.allocations.length} {t.allocations.length === 1 ? "persona" : "personas"})</h4>
                <ul className="divide-y divide-gray-50 rounded-2xl border border-gray-100">
                    {t.allocations.map((a) => (
                        <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                            <span className="min-w-0">
                                <span className="block text-sm font-bold text-gray-900 break-words">{nameOf(a.inscription_id)}</span>
                                <span className="flex flex-wrap gap-1.5">
                                    {a.cancelled && <Badge tone="gray" size="xs" icon="fa-ban">Cancelada</Badge>}
                                    {a.moved && <Badge tone="indigo" size="xs" icon="fa-right-left">Persona trasladada</Badge>}
                                </span>
                            </span>
                            <span className="shrink-0 font-black tabular-nums text-gray-900">{money(toCents(a.amount))}</span>
                        </li>
                    ))}
                </ul>
                {!t.foreign && (
                    <p className={exact ? "text-xs font-bold text-emerald-700" : "text-xs font-bold text-amber-800"}>
                        Total {money(toCents(t.amount))} = reparto {money(allocatedC)} {exact ? "✓" : "(no cuadra)"}
                    </p>
                )}
            </section>

            {!t.foreign && (
                <section className="space-y-2" data-transfer-proof="">
                    <h4 className={sectionLabelCls}>Comprobante</h4>
                    {!t.has_proof ? (
                        <p className="text-sm text-gray-600">Sin comprobante{t.method === "Efectivo" ? " (pago en efectivo)" : ""}.</p>
                    ) : proof.phase === "shown" && proof.url ? (
                        <button type="button" onClick={() => setBig((v) => !v)} className="block w-full text-left" aria-label={big ? "Ver el comprobante más pequeño" : "Ver el comprobante más grande"}>
                            {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from the API */}
                            <img src={proof.url} alt={`Comprobante del pago #${t.id}`} className={big ? "w-full h-auto rounded-xl border border-gray-200" : "max-h-48 w-auto rounded-xl border border-gray-200"} />
                        </button>
                    ) : (
                        <Button variant="outline" icon="fa-image" onClick={showProof} disabled={proof.phase === "loading"} data-action="show-proof">
                            {proof.phase === "loading" ? "Cargando…" : proof.phase === "error" ? "Reintentar" : "Ver comprobante"}
                        </Button>
                    )}
                    {proof.phase === "error" && <p className="text-xs font-bold text-rose-700" role="alert">No se pudo cargar el comprobante.</p>}
                </section>
            )}
        </Modal>
    );
}

// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * VERSION SKEW ONLY: the «Registrar Pago Grupal» dialog for a conference-manager OLDER than «Pagos de
 * cuotas» (2.18.0) — one whose /portal/me carries no `features.fee_payments`. Such a plugin has no
 * /portal/fee-payments, only `POST /portal/payments/bulk` (the same amount for each selected person, a
 * required receipt, pending for the administration). The dialog is the one the portal had before, moved
 * out of page.tsx; the receipt is now shrunk on the phone (proofImage.ts) instead of refusing a photo over
 * 1 MB, and the file reader no longer writes into a stale copy of the form.
 *
 * Delete this file one core release after 2.18.0 is the oldest plugin the portal must talk to.
 */
import React, { useState } from "react";
import { browserProofEnv, prepareProof, ProofError } from "./proofImage";
import { Button, Field, Modal, cx, inputBoldCls, inputCls, selectCls } from "./ui";

const API = "/api/v1/plugin/conference-manager";

/** What the coordinator reads when no payment can be recorded (the plugin's fee migration did not complete). */
export const PAYMENTS_UNAVAILABLE = "Los pagos no están disponibles en este momento; inténtalo más tarde.";
/**
 * The message of a refused bulk payment. A 503 `unavailable` is the plugin's degraded mode: nothing for the
 * coordinator to check on a server — never «revisa el registro del servidor» (2.18.0 review R5-L3).
 */
export function bulkErrorText(status: number, data: { error?: unknown; code?: unknown } | null | undefined): string {
    if (status === 503 || (data && data.code === "unavailable")) return PAYMENTS_UNAVAILABLE;
    return (data && typeof data.error === "string" && data.error) || "Error al procesar pagos";
}

export type LegacyBulkPaymentProps = {
    ids: number[];
    methods: string[];
    /** Prefill of «Monto por persona» (one person: what they still owe). */
    defaultAmount?: string;
    authHeaders: (extra?: Record<string, string>) => Record<string, string>;
    notify: (message: string, type?: "success" | "error" | "info" | "warning") => void;
    onDone: () => void;
    onClose: () => void;
};

export default function LegacyBulkPayment({ ids, methods, defaultAmount = "", authHeaders, notify, onDone, onClose }: LegacyBulkPaymentProps) {
    const [form, setForm] = useState({ amount_per_person: defaultAmount, method: methods[0] || "", reference: "", proof: "" });
    const [busy, setBusy] = useState(false);
    const [preparing, setPreparing] = useState(false);

    const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        setPreparing(true);
        try {
            const r = await prepareProof(file, browserProofEnv);
            setForm((f) => ({ ...f, proof: r.dataUrl }));
        } catch (err) {
            notify(err instanceof ProofError ? err.message : "No pudimos leer la imagen.", "error");
        } finally {
            setPreparing(false);
        }
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const amt = Number(String(form.amount_per_person).replace(",", "."));
        if (!Number.isFinite(amt) || amt <= 0) { notify("El monto debe ser mayor que cero.", "error"); return; }
        if (!form.proof) { notify("El comprobante es obligatorio.", "error"); return; }
        setBusy(true);
        try {
            const res = await fetch(`${API}/portal/payments/bulk`, {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ inscription_ids: ids, amount_per_person: amt, method: form.method, reference: form.reference, proof: form.proof }),
                credentials: "include",
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                const applied = data.applied ?? ids.length;
                const skipped = data.skipped ?? 0;
                notify(skipped > 0 ? `Se registraron ${applied} pagos (${skipped} omitidos) — pendientes de validación.` : "Pagos registrados — pendientes de validación por un administrador.", skipped > 0 ? "warning" : "success");
                onDone();
            } else {
                notify(bulkErrorText(res.status, data), "error");
            }
        } catch {
            notify("Error de conexión", "error");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            title="Registrar Pago Grupal"
            subtitle={`Se aplicará a ${ids.length} ${ids.length === 1 ? "persona seleccionada" : "personas seleccionadas"}`}
            onClose={onClose}
            testId="legacy-bulk-payment"
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose}>Cancelar</Button>
                    <Button type="submit" form="bulk-payment-form" disabled={busy || preparing || !form.amount_per_person || !form.proof || !methods.length}>
                        {busy ? "Procesando..." : "Confirmar Pago"}
                    </Button>
                </>
            )}
        >
            <form id="bulk-payment-form" onSubmit={submit} className="space-y-5">
                <Field label="Monto por Persona">
                    {(id) => (
                        <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold">$</span>
                            <input id={id} required type="text" inputMode="decimal" className={cx(inputBoldCls, "pl-10")} value={form.amount_per_person}
                                onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, amount_per_person: v })); }} placeholder="0.00" />
                        </div>
                    )}
                </Field>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="Método">
                        {(id) => (
                            <>
                                <select id={id} className={selectCls} value={form.method} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, method: v })); }}>
                                    {methods.map((m) => <option key={m} value={m}>{m}</option>)}
                                </select>
                                {methods.length === 0 && <p className="text-xs text-rose-600 font-medium ml-1">No hay formas de pago habilitadas para esta localidad; contacta al administrador.</p>}
                            </>
                        )}
                    </Field>
                    <Field label="Referencia (Opcional)">
                        {(id) => <input id={id} className={inputCls} value={form.reference} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, reference: v })); }} placeholder="# Recibo / Trans" />}
                    </Field>
                </div>
                <Field label={<>Comprobante de Pago <span className="text-rose-500">*</span></>}>
                    {(id) => (
                        <>
                            <div className="border-2 border-dashed border-gray-200 rounded-2xl p-4 bg-gray-50/30 transition-colors focus-within:border-blue-500 relative overflow-hidden">
                                <input id={id} type="file" accept="image/*" aria-label="Adjuntar foto del comprobante" onChange={onFile} className="absolute inset-0 opacity-0 cursor-pointer z-10" />
                                {preparing ? (
                                    <p className="text-center text-xs font-bold text-blue-700 py-2" role="status">Preparando foto…</p>
                                ) : form.proof ? (
                                    <div className="flex items-center gap-3">
                                        {/* eslint-disable-next-line @next/next/no-img-element -- a local data: URL */}
                                        <img src={form.proof} alt="Comprobante de pago" className="w-14 h-14 rounded-xl object-cover border border-gray-200 shadow-sm shrink-0" />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-bold text-blue-600 truncate">Imagen cargada correctamente</p>
                                            <p className="text-[10px] text-gray-500 italic">Toca para cambiarla</p>
                                        </div>
                                        <button type="button" onClick={() => setForm((f) => ({ ...f, proof: "" }))} title="Quitar comprobante" aria-label="Quitar comprobante" className="relative z-20 w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-white text-rose-500 hover:bg-rose-600 hover:text-white transition-all shadow-sm border border-rose-100">
                                            <i className="fa-solid fa-trash-can text-xs"></i>
                                        </button>
                                    </div>
                                ) : (
                                    <div className="text-center py-2">
                                        <i className="fa-solid fa-cloud-arrow-up text-gray-300 text-2xl mb-2"></i>
                                        <p className="text-xs text-gray-500 font-bold">Adjuntar foto del comprobante</p>
                                    </div>
                                )}
                            </div>
                            <p className="text-[10px] text-gray-500 italic ml-1">Obligatorio. El pago quedará <b>pendiente de validación</b> por un administrador.</p>
                        </>
                    )}
                </Field>
            </form>
        </Modal>
    );
}

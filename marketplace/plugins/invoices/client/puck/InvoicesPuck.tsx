// @ts-nocheck
"use client";

/**
 * Puck block "Invoices" — a clean, print-friendly public invoice view.
 *
 * Reads ?inv=<token> from the page URL on mount and fetches the plugin's public endpoint
 * (/api/v1/plugin/invoices/public/view). Runs in the editor iframe AND on the public page:
 * without a token it renders the configured emptyMessage (or an editor-only hint; nothing on
 * public). Fetch is res.ok-guarded — an inactive plugin or a bad token degrades to a quiet
 * Spanish placeholder instead of crashing the page.
 *
 * The "Imprimir / Guardar PDF" button calls window.print(); @media print CSS hides everything
 * outside the invoice (visibility trick) — page chrome outside the block can't always be fully
 * suppressed, but the invoice prints clean on its own page in practice.
 */

import React, { useEffect, useState } from "react";

const STYLES = `
.wjinv-root { max-width: 820px; margin: 0 auto; background: #fff; color: #111827; border: 1px solid #e5e7eb; border-radius: 12px; padding: 2.25rem; font-size: 0.95rem; line-height: 1.5; }
.wjinv-top { display: flex; justify-content: space-between; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 2rem; }
.wjinv-biz-name { font-size: 1.35rem; font-weight: 800; margin: 0 0 0.35rem; }
.wjinv-muted { color: #6b7280; font-size: 0.85rem; white-space: pre-line; }
.wjinv-doc { text-align: right; }
.wjinv-doc-title { font-size: 1.6rem; font-weight: 900; letter-spacing: 0.08em; margin: 0; }
.wjinv-doc-number { font-weight: 700; color: #374151; margin: 0.15rem 0 0.6rem; }
.wjinv-dates { font-size: 0.85rem; color: #6b7280; }
.wjinv-badge { display: inline-block; margin-top: 0.5rem; padding: 0.25rem 0.7rem; border-radius: 999px; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
.wjinv-st-draft { background: #f3f4f6; color: #4b5563; }
.wjinv-st-sent { background: #dbeafe; color: #1d4ed8; }
.wjinv-st-paid { background: #dcfce7; color: #15803d; }
.wjinv-st-overdue { background: #fee2e2; color: #b91c1c; }
.wjinv-st-void { background: #e5e7eb; color: #6b7280; text-decoration: line-through; }
.wjinv-client { margin-bottom: 2rem; }
.wjinv-label { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #9ca3af; margin: 0 0 0.35rem; }
.wjinv-client-name { font-weight: 700; }
.wjinv-table { width: 100%; border-collapse: collapse; margin-bottom: 1.25rem; }
.wjinv-table th { text-align: left; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #9ca3af; padding: 0.5rem 0.6rem; border-bottom: 2px solid #e5e7eb; }
.wjinv-table th.wjinv-num, .wjinv-table td.wjinv-num { text-align: right; white-space: nowrap; }
.wjinv-table td { padding: 0.6rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
.wjinv-totals { margin-left: auto; width: 100%; max-width: 300px; }
.wjinv-trow { display: flex; justify-content: space-between; padding: 0.3rem 0.6rem; font-size: 0.9rem; }
.wjinv-trow span:first-child { color: #6b7280; }
.wjinv-trow strong { font-variant-numeric: tabular-nums; }
.wjinv-total { border-top: 2px solid #111827; margin-top: 0.35rem; padding-top: 0.6rem; font-size: 1.05rem; }
.wjinv-total span:first-child { color: #111827; font-weight: 900; }
.wjinv-notes { margin-top: 1.75rem; }
.wjinv-footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 0.85rem; }
.wjinv-actions { max-width: 820px; margin: 1rem auto 0; text-align: right; }
.wjinv-print-btn { background: #111827; color: #fff; border: none; border-radius: 10px; padding: 0.7rem 1.4rem; font-weight: 800; font-size: 0.85rem; cursor: pointer; }
.wjinv-print-btn:hover { background: #374151; }
.wjinv-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); font-size: 0.9rem; }
@media (max-width: 640px) { .wjinv-root { padding: 1.25rem; } .wjinv-doc { text-align: left; } }
@media print {
  body * { visibility: hidden !important; }
  .wjinv-root, .wjinv-root * { visibility: visible !important; }
  .wjinv-root { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; max-width: none !important; border: none !important; border-radius: 0 !important; box-shadow: none !important; padding: 0 !important; }
  .wjinv-print-hide { display: none !important; }
}
`;

const STATUS_LABELS = { draft: "Borrador", sent: "Enviada", paid: "Pagada", overdue: "Vencida", void: "Anulada" };

const money = (cents, symbol) => `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;
const fmtDate = (s) => (s ? String(s).slice(0, 10) : "");

// Module-level (never define a component inside a component).
function InvoiceView({ invoice, business }) {
    const sym = invoice.currency_symbol || "$";
    const items = Array.isArray(invoice.items) ? invoice.items : [];
    const statusCls = `wjinv-badge wjinv-st-${STATUS_LABELS[invoice.status] ? invoice.status : "draft"}`;
    return (
        <>
            <div className="wjinv-root">
                <div className="wjinv-top">
                    <div>
                        {business?.name ? <p className="wjinv-biz-name">{business.name}</p> : null}
                        {business?.address ? <p className="wjinv-muted">{business.address}</p> : null}
                        {business?.taxId ? <p className="wjinv-muted">NIF/Tax ID: {business.taxId}</p> : null}
                        {business?.email ? <p className="wjinv-muted">{business.email}</p> : null}
                    </div>
                    <div className="wjinv-doc">
                        <p className="wjinv-doc-title">FACTURA</p>
                        <p className="wjinv-doc-number">{invoice.number}</p>
                        <div className="wjinv-dates">
                            {invoice.issued_at ? <div>Emitida: {fmtDate(invoice.issued_at)}</div> : null}
                            {invoice.due_at ? <div>Vence: {fmtDate(invoice.due_at)}</div> : null}
                        </div>
                        <span className={statusCls}>{STATUS_LABELS[invoice.status] || invoice.status}</span>
                    </div>
                </div>

                <div className="wjinv-client">
                    <p className="wjinv-label">Facturar a</p>
                    <p className="wjinv-client-name">{invoice.client_name}</p>
                    {invoice.client_address ? <p className="wjinv-muted">{invoice.client_address}</p> : null}
                    {invoice.client_tax_id ? <p className="wjinv-muted">NIF/Tax ID: {invoice.client_tax_id}</p> : null}
                    {invoice.client_email ? <p className="wjinv-muted">{invoice.client_email}</p> : null}
                </div>

                <table className="wjinv-table">
                    <thead>
                        <tr>
                            <th>Descripción</th>
                            <th className="wjinv-num">Cant.</th>
                            <th className="wjinv-num">Precio unit.</th>
                            <th className="wjinv-num">Importe</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((it, i) => (
                            <tr key={i}>
                                <td>{it.description}</td>
                                <td className="wjinv-num">{it.qty}</td>
                                <td className="wjinv-num">{money(it.unit_cents, sym)}</td>
                                <td className="wjinv-num">{money(Math.round((Number(it.qty) || 0) * (Number(it.unit_cents) || 0)), sym)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                <div className="wjinv-totals">
                    <div className="wjinv-trow"><span>Subtotal</span><strong>{money(invoice.subtotal_cents, sym)}</strong></div>
                    {Number(invoice.discount_cents) > 0 ? (
                        <div className="wjinv-trow"><span>Descuento</span><strong>−{money(invoice.discount_cents, sym)}</strong></div>
                    ) : null}
                    <div className="wjinv-trow"><span>Impuestos ({Number(invoice.tax_pct) || 0}%)</span><strong>{money(invoice.tax_cents, sym)}</strong></div>
                    <div className="wjinv-trow wjinv-total"><span>Total</span><strong>{money(invoice.total_cents, sym)}</strong></div>
                </div>

                {invoice.notes ? (
                    <div className="wjinv-notes">
                        <p className="wjinv-label">Notas</p>
                        <p className="wjinv-muted">{invoice.notes}</p>
                    </div>
                ) : null}

                {business?.footerNote ? <div className="wjinv-footer">{business.footerNote}</div> : null}
            </div>
            <div className="wjinv-actions wjinv-print-hide">
                <button type="button" className="wjinv-print-btn" onClick={() => { if (typeof window !== "undefined") window.print(); }}>
                    Imprimir / Guardar PDF
                </button>
            </div>
        </>
    );
}

export const puckComponentDef = {
    category: "Comercio",
    fields: {
        emptyMessage: { type: "text", label: "Mensaje sin factura (opcional)" },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        emptyMessage: "",
        elementId: "",
    },
};

export default function InvoicesPuck({ emptyMessage, elementId }) {
    // phase: 'idle' | 'no-token' | 'loading' | 'ready' | 'notfound'
    const [state, setState] = useState({ phase: "idle", invoice: null, business: null });
    const [inEditor, setInEditor] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined") return undefined;
        let alive = true;
        let editor = false;
        try { editor = window.self !== window.top; } catch { editor = true; }
        setInEditor(editor);

        const params = new URLSearchParams(window.location.search);
        const token = (params.get("inv") || "").trim();
        if (!token) {
            setState({ phase: "no-token", invoice: null, business: null });
            return undefined;
        }
        setState({ phase: "loading", invoice: null, business: null });
        fetch(`/api/v1/plugin/invoices/public/view?token=${encodeURIComponent(token)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive) return;
                if (data && data.invoice) setState({ phase: "ready", invoice: data.invoice, business: data.business || {} });
                else setState({ phase: "notfound", invoice: null, business: null });
            })
            .catch(() => { if (alive) setState({ phase: "notfound", invoice: null, business: null }); });
        return () => { alive = false; };
    }, []);

    let content = null;
    if (state.phase === "ready") {
        content = <InvoiceView invoice={state.invoice} business={state.business} />;
    } else if (state.phase === "loading") {
        content = <div className="wjinv-empty">Cargando factura…</div>;
    } else if (state.phase === "notfound") {
        content = <div className="wjinv-empty">Factura no encontrada o enlace inválido.</div>;
    } else if (state.phase === "no-token") {
        if (emptyMessage) {
            content = <div className="wjinv-empty">{emptyMessage}</div>;
        } else if (inEditor) {
            content = (
                <div className="wjinv-empty">
                    Bloque de factura: se muestra cuando la URL de esta página incluye <code>?inv=&lt;token&gt;</code>.
                    Copia el enlace público desde Admin → Facturas.
                </div>
            );
        }
        // On the public page without a token and without emptyMessage: render nothing.
    }

    return (
        <div id={elementId || undefined}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {content}
        </div>
    );
}

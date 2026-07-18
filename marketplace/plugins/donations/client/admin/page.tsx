// @ts-nocheck
"use client";

/**
 * Admin page for the Donations plugin (/admin/plugin/donations).
 * Tabs: Campañas (cards with thermometer + CRUD modal), Donaciones (table with status changes,
 * totals and CSV export via {csv} + Blob — the isolate can't stream files), Configuración
 * (currency, presets, manual instructions, notify email, write-only Stripe key).
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-donations) — the markup below only uses cf-*
 * classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const STATUS_LABELS = { pending: "Pendiente", paid: "Pagada", cancelled: "Cancelada" };
const STATUS_CLS = {
    pending: "is-pending",
    paid: "is-paid",
    cancelled: "is-cancelled",
};

const fmtMoney = (cents, symbol) =>
    `${symbol || "$"}${(Math.round(cents || 0) / 100).toLocaleString("es", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const fmtDate = (s) => {
    if (!s) return "—";
    const d = new Date(s);
    return isNaN(d.getTime()) ? String(s) : d.toLocaleString();
};

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconHeart = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" />
    </svg>
);
const IconPlus = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M12 5v14M5 12h14" />
    </svg>
);
const IconPen = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
);
const IconDownload = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
        <path d="M12 15V3" />
    </svg>
);
const IconInboxEmpty = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
);

// Module-level modal (never define a component inside a component — it remounts and steals focus).
function CampaignModal({ initial, symbol, onClose, onSaved }) {
    const [title, setTitle] = useState(initial?.title || "");
    const [slug, setSlug] = useState(initial?.slug || "");
    const [description, setDescription] = useState(initial?.description || "");
    const [goalUnits, setGoalUnits] = useState(initial && initial.goal_cents ? String(initial.goal_cents / 100) : "");
    const [imageUrl, setImageUrl] = useState(initial?.image_url || "");
    const [isActive, setIsActive] = useState(initial ? !!initial.is_active : true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const save = async (e) => {
        e.preventDefault();
        setError("");
        const goal = goalUnits === "" ? 0 : Number(String(goalUnits).replace(",", "."));
        if (!Number.isFinite(goal) || goal < 0) { setError("La meta debe ser un número mayor o igual a 0."); return; }
        setSaving(true);
        try {
            const payload = {
                title: title.trim(),
                slug: slug.trim(),
                description: description.trim(),
                goal_cents: Math.round(goal * 100),
                image_url: imageUrl.trim(),
                is_active: isActive,
            };
            const res = initial && initial.id
                ? await apiPut(`/plugin/donations/campaigns/${initial.id}`, payload)
                : await apiPost("/plugin/donations/campaigns", payload);
            onSaved(res.campaign);
        } catch (err) {
            setError(err?.message || "No se pudo guardar la campaña.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="cf-overlay" onClick={onClose}>
            <div
                className="cf-letter"
                role="dialog"
                aria-modal="true"
                aria-label={initial && initial.id ? "Editar campaña" : "Nueva campaña"}
                onClick={(e) => e.stopPropagation()}
            >
                <form onSubmit={save} className="cf-letter-body">
                    <h2 className="cf-editor-title">
                        {initial && initial.id ? <IconPen /> : <IconPlus />}
                        {initial && initial.id ? "Editar campaña" : "Nueva campaña"}
                    </h2>
                    <div className="cf-grid">
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="dn-camp-title">Título</label>
                            <input id="dn-camp-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} className="cf-input" required maxLength={300} />
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="dn-camp-slug">Slug (vacío = se genera del título)</label>
                            <input id="dn-camp-slug" type="text" value={slug} onChange={(e) => setSlug(e.target.value)} className="cf-input" placeholder="mi-campana" maxLength={200} />
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="dn-camp-desc">Descripción</label>
                            <textarea id="dn-camp-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="cf-input" style={{ minHeight: "90px" }} maxLength={5000} />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="dn-camp-goal">Meta ({symbol || "$"}) — 0 = sin meta</label>
                            <input id="dn-camp-goal" type="number" min="0" step="0.01" value={goalUnits} onChange={(e) => setGoalUnits(e.target.value)} className="cf-input" placeholder="0" />
                        </div>
                        <div style={{ display: "flex", alignItems: "flex-end" }}>
                            <label className="cf-check">
                                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                                Activa
                            </label>
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="dn-camp-image">URL de imagen (opcional)</label>
                            <input id="dn-camp-image" type="text" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="cf-input" placeholder="/uploads/2026/07/imagen.jpg" maxLength={1000} />
                        </div>
                    </div>
                    {error && <div role="alert" className="cf-flash is-error" style={{ margin: "1.05rem 0 0" }}>{error}</div>}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.4rem" }}>
                        <button type="button" onClick={onClose} className="cf-btn-ghost">Cancelar</button>
                        <button type="submit" disabled={saving} className="cf-btn">{saving ? "Guardando…" : "Guardar"}</button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// Campaign card with a mini thermometer (module-level).
function CampaignCard({ c, symbol, onEdit, onDelete }) {
    const goal = c.goal_cents || 0;
    const pct = goal > 0 ? Math.min(100, Math.round(((c.raised_cents || 0) * 100) / goal)) : null;
    return (
        <div className="cf-camp-card">
            {c.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.image_url} alt={c.title} className="cf-camp-media" decoding="async" />
            ) : (
                <div className="cf-camp-media is-placeholder" aria-hidden="true"><IconHeart /></div>
            )}
            <div className="cf-camp-body">
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.5rem" }}>
                    <div style={{ minWidth: 0 }}>
                        <h3 className="cf-form-name">{c.title}</h3>
                        <p className="cf-camp-slug">/{c.slug}</p>
                    </div>
                    <span className={`cf-pill ${c.is_active ? "is-on" : "is-off"}`}>
                        {c.is_active ? "Activa" : "Inactiva"}
                    </span>
                </div>
                <div>
                    {pct !== null ? (
                        <>
                            <div className="cf-thermo">
                                <div className="cf-thermo-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <div className="cf-thermo-meta">
                                <span><strong>{fmtMoney(c.raised_cents, symbol)}</strong> de {fmtMoney(goal, symbol)}</span>
                                <span className="cf-thermo-pct">{pct}%</span>
                            </div>
                        </>
                    ) : (
                        <p className="cf-thermo-meta"><span><strong>{fmtMoney(c.raised_cents, symbol)}</strong> recaudados (sin meta)</span></p>
                    )}
                </div>
                <p className="cf-meta" style={{ marginTop: 0 }}>
                    {c.paid_count || 0} pagadas · {c.donation_count || 0} en total
                </p>
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "auto" }}>
                    <button type="button" onClick={onEdit} className="cf-btn-ghost"><IconPen /> Editar</button>
                    <button type="button" onClick={onDelete} className="cf-btn-danger">Eliminar</button>
                </div>
            </div>
        </div>
    );
}

export default function DonationsAdminPage() {
    const [tab, setTab] = useState("campaigns");
    const [message, setMessage] = useState("");

    // Shared config (currency symbol is used across tabs)
    const [cfg, setCfg] = useState(null);

    // Campañas
    const [campaigns, setCampaigns] = useState([]);
    const [modal, setModal] = useState(null); // null | {} (new) | campaign (edit)

    // Donaciones
    const [donations, setDonations] = useState([]);
    const [totals, setTotals] = useState({ count: 0, paid_cents: 0, pending_cents: 0 });
    const [filterCampaign, setFilterCampaign] = useState("");
    const [filterStatus, setFilterStatus] = useState("");
    const [busy, setBusy] = useState(false);

    // Configuración
    const [cfgForm, setCfgForm] = useState(null);
    const [stripeKey, setStripeKey] = useState(""); // write-only: never echoed back
    const [clearKey, setClearKey] = useState(false);
    const [savingCfg, setSavingCfg] = useState(false);

    const symbol = (cfg && cfg.currencySymbol) || "$";

    const loadConfig = async () => {
        try {
            const c = await api("/plugin/donations/config");
            setCfg(c);
            setCfgForm({
                currencySymbol: c.currencySymbol || "$",
                currencyCode: c.currencyCode || "usd",
                presets: c.presets || "10,25,50,100",
                manualInstructions: c.manualInstructions || "",
                notifyEmail: c.notifyEmail || "",
                hasStripeKey: !!c.hasStripeKey,
            });
        } catch {
            setCfg(null);
        }
    };

    const loadCampaigns = async () => {
        try {
            const d = await api("/plugin/donations/campaigns");
            setCampaigns(d.campaigns || []);
        } catch (err) {
            setMessage(`Error al cargar campañas: ${err?.message || err}`);
        }
    };

    const donationQs = () => {
        const p = new URLSearchParams();
        if (filterCampaign) p.set("campaign_id", filterCampaign);
        if (filterStatus) p.set("status", filterStatus);
        const s = p.toString();
        return s ? `?${s}` : "";
    };

    const loadDonations = async () => {
        try {
            const d = await api(`/plugin/donations/donations${donationQs()}`);
            setDonations(d.donations || []);
            setTotals(d.totals || { count: 0, paid_cents: 0, pending_cents: 0 });
        } catch (err) {
            setMessage(`Error al cargar donaciones: ${err?.message || err}`);
        }
    };

    useEffect(() => { loadConfig(); loadCampaigns(); }, []);
    useEffect(() => { if (tab === "donations") loadDonations(); }, [tab, filterCampaign, filterStatus]);

    const deleteCampaign = async (c) => {
        if (!window.confirm(`¿Eliminar la campaña "${c.title}" y TODAS sus donaciones? Esta acción no se puede deshacer.`)) return;
        try {
            await apiDelete(`/plugin/donations/campaigns/${c.id}`);
            setMessage(`Campaña "${c.title}" eliminada.`);
            loadCampaigns();
        } catch (err) {
            setMessage(`Error: ${err?.message || err}`);
        }
    };

    const changeStatus = async (d, status) => {
        setBusy(true);
        try {
            await apiPost(`/plugin/donations/donations/${d.id}/payment`, { payment_status: status });
            await loadDonations();
            loadCampaigns(); // raised_cents changed
        } catch (err) {
            setMessage(`Error: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const deleteDonation = async (d) => {
        if (!window.confirm(`¿Eliminar la donación de ${d.donor_name || "(sin nombre)"} por ${fmtMoney(d.amount_cents, symbol)}?`)) return;
        setBusy(true);
        try {
            await apiDelete(`/plugin/donations/donations/${d.id}`);
            await loadDonations();
            loadCampaigns();
        } catch (err) {
            setMessage(`Error: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    // The isolate can't stream files — the server returns { csv, filename } and we build a Blob.
    const exportCsv = async () => {
        setBusy(true);
        try {
            const data = await api(`/plugin/donations/donations/export${donationQs()}`);
            const blob = new Blob(["﻿" + (data.csv || "")], { type: "text/csv;charset=utf-8" }); // BOM so Excel opens UTF-8 correctly
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = data.filename || "donaciones.csv";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            setMessage(`Error al exportar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const saveConfig = async (e) => {
        e.preventDefault();
        if (!cfgForm) return;
        setSavingCfg(true);
        setMessage("");
        try {
            const body = {
                currencySymbol: cfgForm.currencySymbol,
                currencyCode: cfgForm.currencyCode,
                presets: cfgForm.presets,
                manualInstructions: cfgForm.manualInstructions,
                notifyEmail: cfgForm.notifyEmail,
            };
            // Key semantics: absent = keep, '' = clear, value = replace.
            if (clearKey) body.stripeKey = "";
            else if (stripeKey.trim()) body.stripeKey = stripeKey.trim();
            const c = await apiPost("/plugin/donations/config", body);
            setCfg(c);
            setCfgForm({ ...cfgForm, hasStripeKey: !!c.hasStripeKey });
            setStripeKey("");
            setClearKey(false);
            setMessage("Configuración guardada.");
        } catch (err) {
            setMessage(`Error al guardar: ${err?.message || err}`);
        } finally {
            setSavingCfg(false);
        }
    };

    const tabBtn = (id, label) => (
        <button
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => { setTab(id); setMessage(""); }}
            className={`cf-tab ${tab === id ? "is-active" : ""}`}
        >
            {label}
        </button>
    );

    return (
        <div className="cf-shell">
            {/* header: stamp + title + rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconHeart /></div>
                <div>
                    <h1 className="cf-title">Donaciones</h1>
                    <p className="cf-subtitle">
                        Campañas con termómetro de meta · pago manual + Stripe opcional · exportación CSV
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                {tabBtn("campaigns", "Campañas")}
                {tabBtn("donations", "Donaciones")}
                {tabBtn("config", "Configuración")}
            </div>

            {message && (
                <div role={/Error/i.test(message) ? "alert" : "status"} className={`cf-flash ${/Error/i.test(message) ? "is-error" : "is-ok"}`}>
                    {message}
                </div>
            )}

            {/* ── Campañas ─────────────────────────────────────────────────────────────────────── */}
            {tab === "campaigns" && (
                <div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                        <button type="button" onClick={() => setModal({})} className="cf-btn"><IconPlus /> Nueva campaña</button>
                    </div>
                    {campaigns.length === 0 ? (
                        <div className="cf-empty">
                            <IconHeart />
                            <span>Sin campañas todavía — crea la primera para empezar a recibir donaciones.</span>
                        </div>
                    ) : (
                        <div className="cf-camp-grid">
                            {campaigns.map((c) => (
                                <CampaignCard key={c.id} c={c} symbol={symbol} onEdit={() => setModal(c)} onDelete={() => deleteCampaign(c)} />
                            ))}
                        </div>
                    )}
                    <p className="cf-usage" style={{ marginTop: "1.4rem" }}>
                        En el editor visual, agrega el bloque <strong>Donations</strong> — muestra la campaña con su
                        termómetro, montos sugeridos y formulario de donación (con su slug o la primera activa).
                    </p>
                </div>
            )}

            {/* ── Donaciones ───────────────────────────────────────────────────────────────────── */}
            {tab === "donations" && (
                <div>
                    <div className="cf-card-item">
                        <div className="cf-toolbar" style={{ marginBottom: 0 }}>
                            <div className="cf-toolbar-left">
                                <div>
                                    <label className="cf-label" htmlFor="dn-filter-campaign">Campaña</label>
                                    <select id="dn-filter-campaign" value={filterCampaign} onChange={(e) => setFilterCampaign(e.target.value)} className="cf-select">
                                        <option value="">Todas</option>
                                        {campaigns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="dn-filter-status">Estado</label>
                                    <select id="dn-filter-status" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="cf-select">
                                        <option value="">Todos</option>
                                        <option value="pending">Pendiente</option>
                                        <option value="paid">Pagada</option>
                                        <option value="cancelled">Cancelada</option>
                                    </select>
                                </div>
                            </div>
                            <button type="button" onClick={exportCsv} disabled={busy} className="cf-btn">
                                <IconDownload /> Exportar CSV
                            </button>
                        </div>
                    </div>

                    <div className="cf-stats">
                        <div className="cf-stat">
                            <p className="cf-label" style={{ marginBottom: "0.4rem" }}>Recaudado (pagadas)</p>
                            <p className="cf-stat-value is-ok">{fmtMoney(totals.paid_cents, symbol)}</p>
                        </div>
                        <div className="cf-stat">
                            <p className="cf-label" style={{ marginBottom: "0.4rem" }}>Pendiente</p>
                            <p className="cf-stat-value is-warn">{fmtMoney(totals.pending_cents, symbol)}</p>
                        </div>
                        <div className="cf-stat">
                            <p className="cf-label" style={{ marginBottom: "0.4rem" }}>Donaciones</p>
                            <p className="cf-stat-value">{totals.count || 0}</p>
                        </div>
                    </div>

                    <div className="cf-card-item">
                        {donations.length === 0 ? (
                            <div className="cf-empty">
                                <IconInboxEmpty />
                                <span>No hay donaciones con estos filtros.</span>
                            </div>
                        ) : (
                            <div className="cf-table-wrap">
                                <table className="cf-table">
                                    <thead>
                                        <tr>
                                            <th>Fecha</th>
                                            <th>Donante</th>
                                            <th>Campaña</th>
                                            <th>Monto</th>
                                            <th>Método</th>
                                            <th>Estado</th>
                                            <th style={{ width: "2.5rem" }}></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {donations.map((d) => (
                                            <tr key={d.id}>
                                                <td className="cf-cell-date">{fmtDate(d.created_at)}</td>
                                                <td>
                                                    <div className="cf-donor-name">
                                                        {d.donor_name || "(sin nombre)"}
                                                        {d.is_anonymous ? <span className="cf-chip" style={{ marginLeft: "0.5rem" }}>Anónimo</span> : null}
                                                    </div>
                                                    <div className="cf-cell-sub">{d.donor_email || "—"}</div>
                                                    {d.message ? <div className="cf-quote" title={d.message}>“{d.message}”</div> : null}
                                                </td>
                                                <td>{d.campaign_title || d.campaign_id}</td>
                                                <td className="cf-cell-amount">{fmtMoney(d.amount_cents, symbol)}</td>
                                                <td>{d.payment_method === "stripe" ? "Tarjeta" : "Manual"}</td>
                                                <td>
                                                    <select
                                                        aria-label="Cambiar estado de la donación"
                                                        value={d.payment_status}
                                                        disabled={busy}
                                                        onChange={(e) => changeStatus(d, e.target.value)}
                                                        className={`cf-status-select ${STATUS_CLS[d.payment_status] || "is-cancelled"}`}
                                                    >
                                                        <option value="pending">{STATUS_LABELS.pending}</option>
                                                        <option value="paid">{STATUS_LABELS.paid}</option>
                                                        <option value="cancelled">{STATUS_LABELS.cancelled}</option>
                                                    </select>
                                                </td>
                                                <td style={{ textAlign: "right" }}>
                                                    <button type="button" onClick={() => deleteDonation(d)} disabled={busy} className="cf-btn-danger">Eliminar</button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ── Configuración ────────────────────────────────────────────────────────────────── */}
            {tab === "config" && cfgForm && (
                <form onSubmit={saveConfig} className="cf-editor" style={{ maxWidth: "42rem" }}>
                    <div className="cf-editor-body">
                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="dn-cfg-symbol">Símbolo de moneda</label>
                                <input id="dn-cfg-symbol" type="text" value={cfgForm.currencySymbol} onChange={(e) => setCfgForm({ ...cfgForm, currencySymbol: e.target.value })} className="cf-input" maxLength={8} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="dn-cfg-code">Código de moneda (ISO, 3 letras)</label>
                                <input id="dn-cfg-code" type="text" value={cfgForm.currencyCode} onChange={(e) => setCfgForm({ ...cfgForm, currencyCode: e.target.value })} className="cf-input" placeholder="usd" maxLength={3} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="dn-cfg-presets">Montos sugeridos (separados por comas, en {cfgForm.currencySymbol || "$"})</label>
                                <input id="dn-cfg-presets" type="text" value={cfgForm.presets} onChange={(e) => setCfgForm({ ...cfgForm, presets: e.target.value })} className="cf-input" placeholder="10,25,50,100" />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="dn-cfg-manual">Instrucciones de pago manual (siempre disponibles)</label>
                                <textarea id="dn-cfg-manual" value={cfgForm.manualInstructions} onChange={(e) => setCfgForm({ ...cfgForm, manualInstructions: e.target.value })} className="cf-input" style={{ minHeight: "110px" }} placeholder={"Transferencia a la cuenta 000-000000-00 del Banco X.\nEnvía tu comprobante a donaciones@misitio.com indicando tu referencia."} maxLength={5000} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="dn-cfg-notify">Email de notificaciones (nuevas donaciones)</label>
                                <input id="dn-cfg-notify" type="email" value={cfgForm.notifyEmail} onChange={(e) => setCfgForm({ ...cfgForm, notifyEmail: e.target.value })} className="cf-input" placeholder="admin@misitio.com" maxLength={254} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="dn-cfg-stripe">Stripe secret key (opcional — habilita pago con tarjeta)</label>
                                <input
                                    id="dn-cfg-stripe"
                                    type="password"
                                    value={stripeKey}
                                    onChange={(e) => { setStripeKey(e.target.value); setClearKey(false); }}
                                    placeholder={cfgForm.hasStripeKey ? "(configurada — escribe para reemplazar)" : "sk_live_… (sin key: solo pago manual)"}
                                    className="cf-input"
                                    autoComplete="new-password"
                                />
                                <p className="cf-help">
                                    La key nunca se muestra de vuelta. Sin key, el bloque solo ofrece pago manual con las
                                    instrucciones de arriba. La verificación del pago se hace en el servidor al volver de Stripe.
                                </p>
                                {cfgForm.hasStripeKey && (
                                    <label className="cf-check">
                                        <input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setStripeKey(""); }} />
                                        Quitar la key (deshabilitar pago con tarjeta)
                                    </label>
                                )}
                            </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                            <button type="submit" disabled={savingCfg} className="cf-btn">{savingCfg ? "Guardando…" : "Guardar configuración"}</button>
                        </div>
                    </div>
                </form>
            )}

            {modal !== null && (
                <CampaignModal
                    initial={modal && modal.id ? modal : null}
                    symbol={symbol}
                    onClose={() => setModal(null)}
                    onSaved={() => { setModal(null); setMessage("Campaña guardada."); loadCampaigns(); }}
                />
            )}
        </div>
    );
}

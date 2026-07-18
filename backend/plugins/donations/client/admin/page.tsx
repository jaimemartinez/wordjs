// @ts-nocheck
"use client";

/**
 * Admin page for the Donations plugin (/admin/plugin/donations).
 * Tabs: Campañas (cards with thermometer + CRUD modal), Donaciones (table with status changes,
 * totals and CSV export via {csv} + Blob — the isolate can't stream files), Configuración
 * (currency, presets, manual instructions, notify email, write-only Stripe key).
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-rose-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-black text-[11px] uppercase tracking-widest transition-all disabled:opacity-50";
const cardCls = "bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40";

const STATUS_LABELS = { pending: "Pendiente", paid: "Pagada", cancelled: "Cancelada" };
const STATUS_CLS = {
    pending: "bg-amber-50 text-amber-700",
    paid: "bg-green-50 text-green-700",
    cancelled: "bg-gray-100 text-gray-500",
};

const fmtMoney = (cents, symbol) =>
    `${symbol || "$"}${(Math.round(cents || 0) / 100).toLocaleString("es", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const fmtDate = (s) => {
    if (!s) return "—";
    const d = new Date(s);
    return isNaN(d.getTime()) ? String(s) : d.toLocaleString();
};

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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <form onClick={(e) => e.stopPropagation()} onSubmit={save} className={`${cardCls} w-full max-w-lg p-6 sm:p-8 space-y-4 max-h-[90vh] overflow-y-auto`}>
                <h2 className="text-xl font-black text-gray-900 italic tracking-tighter">
                    {initial && initial.id ? "Editar campaña" : "Nueva campaña"}
                </h2>
                <div>
                    <label className={labelCls}>Título</label>
                    <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} required maxLength={300} />
                </div>
                <div>
                    <label className={labelCls}>Slug (vacío = se genera del título)</label>
                    <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} className={inputCls} placeholder="mi-campana" maxLength={200} />
                </div>
                <div>
                    <label className={labelCls}>Descripción</label>
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputCls} min-h-[90px]`} maxLength={5000} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Meta ({symbol || "$"}) — 0 = sin meta</label>
                        <input type="number" min="0" step="0.01" value={goalUnits} onChange={(e) => setGoalUnits(e.target.value)} className={inputCls} placeholder="0" />
                    </div>
                    <div className="flex items-end pb-3">
                        <label className="flex items-center gap-2 text-sm font-bold text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                            Activa
                        </label>
                    </div>
                </div>
                <div>
                    <label className={labelCls}>URL de imagen (opcional)</label>
                    <input type="text" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className={inputCls} placeholder="/uploads/2026/07/imagen.jpg" maxLength={1000} />
                </div>
                {error && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{error}</div>}
                <div className="flex justify-end gap-3 pt-1">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={saving} className={btnCls}>{saving ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </div>
    );
}

// Campaign card with a mini thermometer (module-level).
function CampaignCard({ c, symbol, onEdit, onDelete }) {
    const goal = c.goal_cents || 0;
    const pct = goal > 0 ? Math.min(100, Math.round(((c.raised_cents || 0) * 100) / goal)) : null;
    return (
        <div className={`${cardCls} overflow-hidden flex flex-col`}>
            {c.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.image_url} alt={c.title} className="w-full aspect-[16/7] object-cover" decoding="async" />
            ) : (
                <div className="w-full aspect-[16/7] bg-gradient-to-br from-rose-100 to-rose-200 flex items-center justify-center text-rose-400 text-3xl">♥</div>
            )}
            <div className="p-5 flex-1 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                    <div>
                        <h3 className="font-black text-gray-900 leading-tight">{c.title}</h3>
                        <p className="text-[11px] text-gray-400 font-bold">/{c.slug}</p>
                    </div>
                    <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-lg ${c.is_active ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                        {c.is_active ? "Activa" : "Inactiva"}
                    </span>
                </div>
                <div>
                    {pct !== null ? (
                        <>
                            <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                                <div className="h-full bg-rose-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                            </div>
                            <div className="flex justify-between items-baseline mt-1.5 text-xs text-gray-500">
                                <span><strong className="text-gray-800">{fmtMoney(c.raised_cents, symbol)}</strong> de {fmtMoney(goal, symbol)}</span>
                                <span className="font-black text-rose-600">{pct}%</span>
                            </div>
                        </>
                    ) : (
                        <p className="text-xs text-gray-500"><strong className="text-gray-800">{fmtMoney(c.raised_cents, symbol)}</strong> recaudados (sin meta)</p>
                    )}
                </div>
                <p className="text-[11px] text-gray-400 font-bold uppercase tracking-widest">
                    {c.paid_count || 0} pagadas · {c.donation_count || 0} en total
                </p>
                <div className="flex gap-2 mt-auto">
                    <button type="button" onClick={onEdit} className={btnGhostCls}>Editar</button>
                    <button type="button" onClick={onDelete} className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-black text-[11px] uppercase tracking-widest transition-all">Eliminar</button>
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
            onClick={() => { setTab(id); setMessage(""); }}
            className={`px-5 py-2.5 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${tab === id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
        >
            {label}
        </button>
    );

    return (
        <div className="max-w-6xl mx-auto p-4 sm:p-8">
            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Donaciones</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Campañas con termómetro de meta · pago manual + Stripe opcional · exportación CSV
                </p>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {tabBtn("campaigns", "Campañas")}
                {tabBtn("donations", "Donaciones")}
                {tabBtn("config", "Configuración")}
            </div>

            {message && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-6 ${/Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                    {message}
                </div>
            )}

            {/* ── Campañas ─────────────────────────────────────────────────────────────────────── */}
            {tab === "campaigns" && (
                <div>
                    <div className="flex justify-end mb-4">
                        <button type="button" onClick={() => setModal({})} className={btnCls}>+ Nueva campaña</button>
                    </div>
                    {campaigns.length === 0 ? (
                        <div className={`${cardCls} p-10 text-center text-sm text-gray-400`}>
                            Sin campañas todavía — crea la primera para empezar a recibir donaciones.
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                            {campaigns.map((c) => (
                                <CampaignCard key={c.id} c={c} symbol={symbol} onEdit={() => setModal(c)} onDelete={() => deleteCampaign(c)} />
                            ))}
                        </div>
                    )}
                    <p className="text-[11px] text-gray-400 mt-6 leading-relaxed">
                        En el editor visual, agrega el bloque <strong>Donations</strong> — muestra la campaña con su
                        termómetro, montos sugeridos y formulario de donación (con su slug o la primera activa).
                    </p>
                </div>
            )}

            {/* ── Donaciones ───────────────────────────────────────────────────────────────────── */}
            {tab === "donations" && (
                <div className="space-y-5">
                    <div className={`${cardCls} p-5 flex flex-wrap items-end gap-4`}>
                        <div className="min-w-[180px]">
                            <label className={labelCls}>Campaña</label>
                            <select value={filterCampaign} onChange={(e) => setFilterCampaign(e.target.value)} className={inputCls}>
                                <option value="">Todas</option>
                                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                            </select>
                        </div>
                        <div className="min-w-[160px]">
                            <label className={labelCls}>Estado</label>
                            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className={inputCls}>
                                <option value="">Todos</option>
                                <option value="pending">Pendiente</option>
                                <option value="paid">Pagada</option>
                                <option value="cancelled">Cancelada</option>
                            </select>
                        </div>
                        <div className="flex-1" />
                        <button type="button" onClick={exportCsv} disabled={busy} className={btnGhostCls}>Exportar CSV</button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className={`${cardCls} p-5`}>
                            <p className={labelCls}>Recaudado (pagadas)</p>
                            <p className="text-2xl font-black text-green-600">{fmtMoney(totals.paid_cents, symbol)}</p>
                        </div>
                        <div className={`${cardCls} p-5`}>
                            <p className={labelCls}>Pendiente</p>
                            <p className="text-2xl font-black text-amber-500">{fmtMoney(totals.pending_cents, symbol)}</p>
                        </div>
                        <div className={`${cardCls} p-5`}>
                            <p className={labelCls}>Donaciones</p>
                            <p className="text-2xl font-black text-gray-900">{totals.count || 0}</p>
                        </div>
                    </div>

                    <div className={`${cardCls} overflow-x-auto`}>
                        {donations.length === 0 ? (
                            <p className="p-10 text-center text-sm text-gray-400">No hay donaciones con estos filtros.</p>
                        ) : (
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="px-4 py-3">Fecha</th>
                                        <th className="px-4 py-3">Donante</th>
                                        <th className="px-4 py-3">Campaña</th>
                                        <th className="px-4 py-3">Monto</th>
                                        <th className="px-4 py-3">Método</th>
                                        <th className="px-4 py-3">Estado</th>
                                        <th className="px-4 py-3"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {donations.map((d) => (
                                        <tr key={d.id} className="border-b border-gray-50 hover:bg-gray-50/60">
                                            <td className="px-4 py-3 whitespace-nowrap text-gray-500">{fmtDate(d.created_at)}</td>
                                            <td className="px-4 py-3">
                                                <div className="font-bold text-gray-800">
                                                    {d.donor_name || "(sin nombre)"}
                                                    {d.is_anonymous ? <span className="ml-2 text-[10px] font-black uppercase tracking-widest bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">Anónimo</span> : null}
                                                </div>
                                                <div className="text-[11px] text-gray-400">{d.donor_email || "—"}</div>
                                                {d.message ? <div className="text-[11px] text-gray-400 italic max-w-[260px] truncate" title={d.message}>“{d.message}”</div> : null}
                                            </td>
                                            <td className="px-4 py-3 text-gray-600">{d.campaign_title || d.campaign_id}</td>
                                            <td className="px-4 py-3 font-black text-gray-900 whitespace-nowrap">{fmtMoney(d.amount_cents, symbol)}</td>
                                            <td className="px-4 py-3 text-gray-500">{d.payment_method === "stripe" ? "Tarjeta" : "Manual"}</td>
                                            <td className="px-4 py-3">
                                                <select
                                                    value={d.payment_status}
                                                    disabled={busy}
                                                    onChange={(e) => changeStatus(d, e.target.value)}
                                                    className={`px-2 py-1.5 rounded-lg text-xs font-bold border-0 outline-none cursor-pointer ${STATUS_CLS[d.payment_status] || "bg-gray-100 text-gray-500"}`}
                                                >
                                                    <option value="pending">{STATUS_LABELS.pending}</option>
                                                    <option value="paid">{STATUS_LABELS.paid}</option>
                                                    <option value="cancelled">{STATUS_LABELS.cancelled}</option>
                                                </select>
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <button type="button" onClick={() => deleteDonation(d)} disabled={busy} className="text-red-400 hover:text-red-600 font-black text-xs uppercase tracking-widest">Eliminar</button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            )}

            {/* ── Configuración ────────────────────────────────────────────────────────────────── */}
            {tab === "config" && cfgForm && (
                <form onSubmit={saveConfig} className={`${cardCls} p-6 sm:p-8 space-y-5 max-w-2xl`}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className={labelCls}>Símbolo de moneda</label>
                            <input type="text" value={cfgForm.currencySymbol} onChange={(e) => setCfgForm({ ...cfgForm, currencySymbol: e.target.value })} className={inputCls} maxLength={8} />
                        </div>
                        <div>
                            <label className={labelCls}>Código de moneda (ISO, 3 letras)</label>
                            <input type="text" value={cfgForm.currencyCode} onChange={(e) => setCfgForm({ ...cfgForm, currencyCode: e.target.value })} className={inputCls} placeholder="usd" maxLength={3} />
                        </div>
                    </div>
                    <div>
                        <label className={labelCls}>Montos sugeridos (separados por comas, en {cfgForm.currencySymbol || "$"})</label>
                        <input type="text" value={cfgForm.presets} onChange={(e) => setCfgForm({ ...cfgForm, presets: e.target.value })} className={inputCls} placeholder="10,25,50,100" />
                    </div>
                    <div>
                        <label className={labelCls}>Instrucciones de pago manual (siempre disponibles)</label>
                        <textarea value={cfgForm.manualInstructions} onChange={(e) => setCfgForm({ ...cfgForm, manualInstructions: e.target.value })} className={`${inputCls} min-h-[110px]`} placeholder={"Transferencia a la cuenta 000-000000-00 del Banco X.\nEnvía tu comprobante a donaciones@misitio.com indicando tu referencia."} maxLength={5000} />
                    </div>
                    <div>
                        <label className={labelCls}>Email de notificaciones (nuevas donaciones)</label>
                        <input type="email" value={cfgForm.notifyEmail} onChange={(e) => setCfgForm({ ...cfgForm, notifyEmail: e.target.value })} className={inputCls} placeholder="admin@misitio.com" maxLength={254} />
                    </div>
                    <div>
                        <label className={labelCls}>Stripe secret key (opcional — habilita pago con tarjeta)</label>
                        <input
                            type="password"
                            value={stripeKey}
                            onChange={(e) => { setStripeKey(e.target.value); setClearKey(false); }}
                            placeholder={cfgForm.hasStripeKey ? "(configurada — escribe para reemplazar)" : "sk_live_… (sin key: solo pago manual)"}
                            className={inputCls}
                            autoComplete="new-password"
                        />
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                            La key nunca se muestra de vuelta. Sin key, el bloque solo ofrece pago manual con las
                            instrucciones de arriba. La verificación del pago se hace en el servidor al volver de Stripe.
                        </p>
                        {cfgForm.hasStripeKey && (
                            <label className="flex items-center gap-2 mt-2 text-[11px] text-gray-500 cursor-pointer select-none">
                                <input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setStripeKey(""); }} />
                                Quitar la key (deshabilitar pago con tarjeta)
                            </label>
                        )}
                    </div>
                    <div className="flex justify-end">
                        <button type="submit" disabled={savingCfg} className={btnCls}>{savingCfg ? "Guardando…" : "Guardar configuración"}</button>
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

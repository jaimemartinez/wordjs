// @ts-nocheck
"use client";

/**
 * Admin page for the Newsletter plugin (/admin/plugin/newsletter).
 * Subscriber dashboard (stats, filter chips, search, delete, CSV export) + campaign management
 * (draft composer modal, test send, send-to-confirmed with confirm guard). API calls go through
 * the host's api helpers (session cookie). The CSV arrives as a JSON field ({csv, filename})
 * because the sandbox cannot stream raw text bodies — the Blob download is built here.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnDark = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnLight = "px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-2xl font-black text-[11px] uppercase tracking-widest transition-all disabled:opacity-50";

const STATUS_META = {
    pending: { label: "Pendiente", cls: "bg-amber-50 text-amber-600" },
    confirmed: { label: "Confirmado", cls: "bg-green-50 text-green-700" },
    unsubscribed: { label: "Cancelado", cls: "bg-gray-100 text-gray-500" },
};

const FILTER_CHIPS = [
    { value: "", label: "Todos" },
    { value: "confirmed", label: "Confirmados" },
    { value: "pending", label: "Pendientes" },
    { value: "unsubscribed", label: "Cancelados" },
];

// Module-level (never define a component inside a component — remounting steals input focus).
function StatCard({ label, value, accent }) {
    return (
        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-5">
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</p>
            <p className={`text-3xl font-black tracking-tighter mt-1 ${accent || "text-gray-900"}`}>{value}</p>
        </div>
    );
}

function CampaignModal({ campaign, onClose, onSaved }) {
    const [subject, setSubject] = useState(campaign?.subject || "");
    const [bodyHtml, setBodyHtml] = useState(campaign?.body_html || "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const payload = { subject, body_html: bodyHtml };
            if (campaign?.id) payload.id = campaign.id;
            const saved = await apiPost("/plugin/newsletter/campaigns", payload);
            onSaved(saved);
        } catch (err) {
            setError(err?.message || "No se pudo guardar la campaña.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 backdrop-blur-sm p-4" onClick={onClose}>
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 sm:p-8" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-black text-gray-900 tracking-tighter">
                        {campaign?.id ? "Editar campaña" : "Nueva campaña"}
                    </h2>
                    <button type="button" onClick={onClose} className="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 font-black transition-all" aria-label="Cerrar">✕</button>
                </div>
                <form onSubmit={save} className="space-y-5">
                    <div>
                        <label className={labelCls}>Asunto</label>
                        <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Novedades de este mes" className={inputCls} required maxLength={300} />
                    </div>
                    <div>
                        <label className={labelCls}>Contenido (HTML)</label>
                        <textarea
                            value={bodyHtml}
                            onChange={(e) => setBodyHtml(e.target.value)}
                            placeholder={"<h1>Hola</h1>\n<p>Escribe aquí el contenido del boletín…</p>"}
                            className={`${inputCls} font-mono text-sm min-h-[260px]`}
                            required
                        />
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                            Se permite HTML básico: &lt;h1&gt;–&lt;h3&gt;, &lt;p&gt;, &lt;a&gt;, &lt;strong&gt;, &lt;em&gt;, &lt;ul&gt;/&lt;li&gt;, &lt;img&gt;…
                            El enlace para cancelar la suscripción se añade automáticamente al final de cada correo.
                        </p>
                    </div>
                    {error && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{error}</div>}
                    <div className="flex items-center justify-end gap-3">
                        <button type="button" onClick={onClose} className={btnLight}>Cancelar</button>
                        <button type="submit" disabled={busy} className={btnDark}>{busy ? "Guardando…" : "Guardar borrador"}</button>
                    </div>
                </form>
            </div>
        </div>
    );
}

export default function NewsletterAdminPage() {
    const [tab, setTab] = useState("subs"); // 'subs' | 'camps'
    const [subs, setSubs] = useState([]);
    const [stats, setStats] = useState({ total: 0, confirmed: 0, pending: 0, unsubscribed: 0 });
    const [statusFilter, setStatusFilter] = useState("");
    const [search, setSearch] = useState("");
    const [campaigns, setCampaigns] = useState([]);
    const [editing, setEditing] = useState(null); // null | {} (new) | campaign (edit)
    const [notice, setNotice] = useState(null);   // { kind: 'ok' | 'warn' | 'err', text }
    const [sendingId, setSendingId] = useState(null);

    const loadSubs = async () => {
        try {
            const params = new URLSearchParams();
            if (statusFilter) params.set("status", statusFilter);
            if (search.trim()) params.set("search", search.trim());
            const qs = params.toString();
            const data = await api(`/plugin/newsletter/subscribers${qs ? `?${qs}` : ""}`);
            setSubs(data.subscribers || []);
            setStats(data.stats || { total: 0, confirmed: 0, pending: 0, unsubscribed: 0 });
        } catch {
            setSubs([]);
        }
    };

    const loadCampaigns = async () => {
        try {
            const list = await api("/plugin/newsletter/campaigns");
            setCampaigns(Array.isArray(list) ? list : []);
        } catch {
            setCampaigns([]);
        }
    };

    // Debounced reload when the filter/search change.
    useEffect(() => {
        const t = setTimeout(loadSubs, 250);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [statusFilter, search]);

    useEffect(() => {
        loadCampaigns();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const deleteSubscriber = async (id) => {
        if (!window.confirm("¿Eliminar este suscriptor definitivamente?")) return;
        try {
            await apiDelete(`/plugin/newsletter/subscribers/${id}`);
            loadSubs();
        } catch (err) {
            setNotice({ kind: "err", text: err?.message || "No se pudo eliminar el suscriptor." });
        }
    };

    const exportCsv = async () => {
        try {
            const data = await api("/plugin/newsletter/subscribers/export");
            const blob = new Blob([data.csv], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = data.filename || "suscriptores.csv";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            setNotice({ kind: "err", text: err?.message || "No se pudo exportar el CSV." });
        }
    };

    const deleteCampaign = async (camp) => {
        if (!window.confirm(`¿Eliminar la campaña "${camp.subject}"?`)) return;
        try {
            await apiDelete(`/plugin/newsletter/campaigns/${camp.id}`);
            loadCampaigns();
        } catch (err) {
            setNotice({ kind: "err", text: err?.message || "No se pudo eliminar la campaña." });
        }
    };

    const sendTest = async (camp) => {
        const to = window.prompt("Correo para enviar la prueba:");
        if (!to || !to.trim()) return;
        try {
            await apiPost(`/plugin/newsletter/campaigns/${camp.id}/test`, { to: to.trim() });
            setNotice({ kind: "ok", text: `Prueba enviada a ${to.trim()}.` });
        } catch (err) {
            setNotice({ kind: "warn", text: err?.message || "No se pudo enviar la prueba." });
        }
    };

    const sendCampaign = async (camp) => {
        const n = stats.confirmed || 0;
        if (n === 0) {
            setNotice({ kind: "warn", text: "No hay suscriptores confirmados a los que enviar." });
            return;
        }
        if (!window.confirm(`¿Enviar "${camp.subject}" a ${n} suscriptores confirmados? Esta acción no se puede deshacer.`)) return;
        setSendingId(camp.id);
        setNotice(null);
        try {
            const r = await apiPost(`/plugin/newsletter/campaigns/${camp.id}/send`, {});
            setNotice({
                kind: "ok",
                text: `Campaña enviada: ${r.sent} correos enviados${r.failed ? `, ${r.failed} fallidos` : ""}.`,
            });
            loadCampaigns();
        } catch (err) {
            // The 502 mail-unavailable error surfaces here (apiPost throws with the server message).
            setNotice({ kind: "warn", text: err?.message || "No se pudo enviar la campaña." });
            loadCampaigns();
        } finally {
            setSendingId(null);
        }
    };

    const fmtDate = (v) => {
        if (!v) return "—";
        const d = new Date(String(v).includes("T") ? v : `${v}Z`.replace(" ", "T"));
        return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
    };

    const tabCls = (active) =>
        `px-5 py-2.5 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${active ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`;

    return (
        <div className="max-w-5xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Newsletter</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Suscriptores + campañas de correo con enlace de baja automático
                </p>
            </div>

            {notice && (
                <div
                    className={`text-sm px-4 py-3 rounded-xl mb-6 ${
                        notice.kind === "ok"
                            ? "bg-green-50 text-green-700"
                            : notice.kind === "warn"
                            ? "bg-amber-50 text-amber-700"
                            : "bg-red-50 text-red-600"
                    }`}
                >
                    {notice.text}
                    <button type="button" className="float-right font-black opacity-60 hover:opacity-100" onClick={() => setNotice(null)} aria-label="Cerrar aviso">✕</button>
                </div>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                <StatCard label="Total" value={stats.total} />
                <StatCard label="Confirmados" value={stats.confirmed} accent="text-green-600" />
                <StatCard label="Pendientes" value={stats.pending} accent="text-amber-500" />
                <StatCard label="Cancelados" value={stats.unsubscribed} accent="text-gray-400" />
            </div>

            <div className="flex gap-2 mb-6">
                <button type="button" className={tabCls(tab === "subs")} onClick={() => setTab("subs")}>Suscriptores</button>
                <button type="button" className={tabCls(tab === "camps")} onClick={() => setTab("camps")}>Campañas</button>
            </div>

            {tab === "subs" && (
                <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8">
                    <div className="flex flex-wrap items-center gap-3 mb-6">
                        <div className="flex flex-wrap gap-2">
                            {FILTER_CHIPS.map((c) => (
                                <button
                                    key={c.value}
                                    type="button"
                                    onClick={() => setStatusFilter(c.value)}
                                    className={`px-3.5 py-2 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all ${
                                        statusFilter === c.value ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                                    }`}
                                >
                                    {c.label}
                                </button>
                            ))}
                        </div>
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Buscar por correo o nombre…"
                            className="flex-1 min-w-[200px] px-4 py-2.5 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none text-sm font-medium"
                        />
                        <button type="button" onClick={exportCsv} className={btnLight}>Exportar CSV</button>
                    </div>

                    {subs.length === 0 ? (
                        <p className="text-sm text-gray-400 py-8 text-center">
                            No hay suscriptores{statusFilter || search ? " con ese filtro" : " todavía — agrega el bloque Newsletter a una página"}.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left">
                                        <th className={`${labelCls} pb-3`}>Correo</th>
                                        <th className={`${labelCls} pb-3`}>Nombre</th>
                                        <th className={`${labelCls} pb-3`}>Estado</th>
                                        <th className={`${labelCls} pb-3`}>Fecha</th>
                                        <th className="pb-3"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {subs.map((s) => {
                                        const meta = STATUS_META[s.status] || STATUS_META.pending;
                                        return (
                                            <tr key={s.id} className="border-t border-gray-50">
                                                <td className="py-3 pr-4 font-medium text-gray-800 break-all">{s.email}</td>
                                                <td className="py-3 pr-4 text-gray-500">{s.name || "—"}</td>
                                                <td className="py-3 pr-4">
                                                    <span className={`inline-block px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest ${meta.cls}`}>
                                                        {meta.label}
                                                    </span>
                                                </td>
                                                <td className="py-3 pr-4 text-gray-400 whitespace-nowrap">{fmtDate(s.created_at)}</td>
                                                <td className="py-3 text-right">
                                                    <button
                                                        type="button"
                                                        onClick={() => deleteSubscriber(s.id)}
                                                        className="px-3 py-1.5 rounded-xl bg-gray-50 hover:bg-red-50 text-gray-400 hover:text-red-600 text-[10px] font-black uppercase tracking-widest transition-all"
                                                    >
                                                        Eliminar
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {tab === "camps" && (
                <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
                        <h2 className="font-bold text-gray-800">Campañas</h2>
                        <button type="button" onClick={() => setEditing({})} className={btnDark}>Nueva campaña</button>
                    </div>

                    {campaigns.length === 0 ? (
                        <p className="text-sm text-gray-400 py-8 text-center">
                            No hay campañas todavía — crea la primera con "Nueva campaña".
                        </p>
                    ) : (
                        <div className="space-y-3">
                            {campaigns.map((c) => (
                                <div key={c.id} className="border border-gray-100 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center gap-3">
                                    <div className="flex-1 min-w-[200px]">
                                        <p className="font-bold text-gray-800 break-words">{c.subject}</p>
                                        <p className="text-[11px] text-gray-400 mt-1 uppercase tracking-widest font-bold">
                                            {c.status === "sent"
                                                ? `Enviada · ${c.sent_count} enviados${c.fail_count ? ` · ${c.fail_count} fallidos` : ""} · ${fmtDate(c.sent_at)}`
                                                : `Borrador · creada ${fmtDate(c.created_at)}`}
                                        </p>
                                    </div>
                                    <span
                                        className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest ${
                                            c.status === "sent" ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-600"
                                        }`}
                                    >
                                        {c.status === "sent" ? "Enviada" : "Borrador"}
                                    </span>
                                    <div className="flex flex-wrap gap-2">
                                        {c.status === "draft" && (
                                            <button type="button" onClick={() => setEditing(c)} className={btnLight}>Editar</button>
                                        )}
                                        <button type="button" onClick={() => sendTest(c)} className={btnLight}>Enviar prueba</button>
                                        {c.status === "draft" && (
                                            <button
                                                type="button"
                                                onClick={() => sendCampaign(c)}
                                                disabled={sendingId === c.id}
                                                className={btnDark}
                                            >
                                                {sendingId === c.id ? "Enviando…" : `Enviar a ${stats.confirmed} confirmados`}
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => deleteCampaign(c)}
                                            className="px-4 py-2.5 rounded-2xl bg-gray-50 hover:bg-red-50 text-gray-400 hover:text-red-600 text-[11px] font-black uppercase tracking-widest transition-all"
                                        >
                                            Eliminar
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <p className="text-[11px] text-gray-400 mt-6 leading-relaxed">
                        Los envíos van únicamente a los suscriptores <strong>confirmados</strong>. Cada correo incluye
                        automáticamente un enlace para cancelar la suscripción. Usa "Enviar prueba" para revisar el
                        resultado antes del envío definitivo.
                    </p>
                </div>
            )}

            {editing !== null && (
                <CampaignModal
                    campaign={editing.id ? editing : null}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        setNotice({ kind: "ok", text: "Campaña guardada." });
                        loadCampaigns();
                    }}
                />
            )}
        </div>
    );
}

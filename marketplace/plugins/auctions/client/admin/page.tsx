// @ts-nocheck
"use client";

/**
 * Admin page for the Auctions plugin (/admin/plugin/auctions).
 * Tabs: Subastas (cards + CRUD modal), Pujas (full bid table with emails, delete),
 * Reporte (winners + contact for fulfillment). All money handled as integer cents server-side;
 * this page converts to/from display units. Dates: the server stores UTC 'YYYY-MM-DD HH:MM:SS'
 * and returns epoch-ms fields; datetime-local inputs are converted local <-> UTC here.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnDark = "px-5 py-3 bg-gray-900 hover:bg-amber-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnLight = "px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-bold text-xs transition-all disabled:opacity-50";

const STATUS_META = {
    active: { label: "Activa", cls: "bg-green-100 text-green-700" },
    ended: { label: "Finalizada", cls: "bg-gray-200 text-gray-600" },
    cancelled: { label: "Cancelada", cls: "bg-red-100 text-red-600" },
    draft: { label: "Borrador", cls: "bg-amber-100 text-amber-700" },
};

const EMPTY_FORM = {
    title: "",
    description: "",
    image_url: "",
    start_price: "",
    min_increment: "1",
    starts_at: "",
    ends_at: "",
    anti_snipe_min: "2",
    is_published: true,
    status: "active",
};

// ---- helpers (module level) ----------------------------------------------------------------------

function fmtMoney(cents, symbol) {
    const n = (Number(cents) || 0) / 100;
    const hasDec = Math.round(n * 100) % 100 !== 0;
    return (symbol || "$") + n.toLocaleString("es", { minimumFractionDigits: hasDec ? 2 : 0, maximumFractionDigits: 2 });
}

// Units string ("12.50" / "12,50") -> integer cents, or null when invalid.
function toCents(v) {
    const n = parseFloat(String(v ?? "").replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
}

// epoch ms -> value for <input type="datetime-local"> (local time).
function msToLocalInput(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// datetime-local value (local time) -> UTC 'YYYY-MM-DD HH:MM:SS' for the server.
function localInputToUtc(v) {
    if (!v) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace("T", " ");
}

function fmtRemaining(endsAtMs, nowMs) {
    if (!endsAtMs) return "—";
    const left = endsAtMs - nowMs;
    if (left <= 0) return "Finalizada";
    const s = Math.floor(left / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return (d ? d + "d " : "") + String(h).padStart(2, "0") + "h " + String(m).padStart(2, "0") + "m " + String(ss).padStart(2, "0") + "s";
}

export default function AuctionsAdminPage() {
    const [tab, setTab] = useState("auctions");
    const [auctions, setAuctions] = useState([]);
    const [symbol, setSymbol] = useState("$");
    const [symbolDraft, setSymbolDraft] = useState("$");
    const [msg, setMsg] = useState("");
    const [busy, setBusy] = useState(false);
    const [nowMs, setNowMs] = useState(() => Date.now());

    // modal: null | { mode: 'create' } | { mode: 'edit', id }
    const [modal, setModal] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [formErr, setFormErr] = useState("");

    // bids tab
    const [bidsAuction, setBidsAuction] = useState("");
    const [bids, setBids] = useState([]);

    // report tab
    const [report, setReport] = useState([]);

    const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));

    const loadAuctions = async () => {
        try {
            const r = await api("/plugin/auctions/auctions");
            setAuctions(r.auctions || []);
            setSymbol(r.currencySymbol || "$");
            setSymbolDraft(r.currencySymbol || "$");
        } catch (e) {
            setMsg(`Error al cargar subastas: ${e?.message || e}`);
        }
    };

    const loadBids = async (auctionId) => {
        if (!auctionId) { setBids([]); return; }
        try {
            const r = await api(`/plugin/auctions/bids?auction_id=${encodeURIComponent(auctionId)}`);
            setBids(r.bids || []);
        } catch (e) {
            setMsg(`Error al cargar pujas: ${e?.message || e}`);
        }
    };

    const loadReport = async () => {
        try {
            const r = await api("/plugin/auctions/report");
            setReport(r.report || []);
            setSymbol(r.currencySymbol || "$");
        } catch (e) {
            setMsg(`Error al cargar el reporte: ${e?.message || e}`);
        }
    };

    useEffect(() => { loadAuctions(); }, []);
    useEffect(() => {
        const t = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
    useEffect(() => {
        if (tab === "bids") loadBids(bidsAuction);
        if (tab === "report") loadReport();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, bidsAuction]);

    const openCreate = () => { setForm(EMPTY_FORM); setFormErr(""); setModal({ mode: "create" }); };
    const openEdit = (a) => {
        setForm({
            title: a.title || "",
            description: a.description || "",
            image_url: a.image_url || "",
            start_price: String((Number(a.start_price_cents) || 0) / 100),
            min_increment: String((Number(a.min_increment_cents) || 0) / 100),
            starts_at: msToLocalInput(a.startsAtMs),
            ends_at: msToLocalInput(a.endsAtMs),
            anti_snipe_min: String(a.anti_snipe_min ?? 2),
            is_published: !!a.is_published,
            status: a.status === "draft" ? "draft" : "active",
        });
        setFormErr("");
        setModal({ mode: "edit", id: a.id, currentStatus: a.status });
    };

    const saveModal = async (e) => {
        e.preventDefault();
        setFormErr("");
        const startCents = toCents(form.start_price);
        const incCents = toCents(form.min_increment);
        if (startCents === null) return setFormErr("Precio inicial inválido.");
        if (incCents === null || incCents <= 0) return setFormErr("El incremento mínimo debe ser mayor que 0.");
        if (!form.ends_at) return setFormErr("La fecha de fin es obligatoria.");
        const body = {
            title: form.title,
            description: form.description,
            image_url: form.image_url,
            start_price_cents: startCents,
            min_increment_cents: incCents,
            starts_at: form.starts_at ? localInputToUtc(form.starts_at) : "",
            ends_at: localInputToUtc(form.ends_at),
            anti_snipe_min: parseInt(form.anti_snipe_min, 10) || 0,
            is_published: form.is_published ? 1 : 0,
        };
        // Only send status for draft/active auctions (end/cancel have their own buttons); editing an
        // ended/cancelled auction must not silently reopen it.
        if (modal.mode === "create" || modal.currentStatus === "draft" || modal.currentStatus === "active") {
            body.status = form.status;
        }
        setBusy(true);
        try {
            if (modal.mode === "create") await apiPost("/plugin/auctions/auctions", body);
            else await apiPut(`/plugin/auctions/auctions/${modal.id}`, body);
            setModal(null);
            setMsg(modal.mode === "create" ? "Subasta creada." : "Subasta actualizada.");
            loadAuctions();
        } catch (err) {
            setFormErr(err?.message || String(err));
        } finally {
            setBusy(false);
        }
    };

    const endNow = async (a) => {
        if (!window.confirm(`¿Finalizar ahora la subasta "${a.title}"? El líder actual será el ganador.`)) return;
        try { await apiPost(`/plugin/auctions/auctions/${a.id}/end-now`, {}); setMsg("Subasta finalizada."); loadAuctions(); }
        catch (e) { setMsg(`Error: ${e?.message || e}`); }
    };
    const cancelAuction = async (a) => {
        if (!window.confirm(`¿Cancelar la subasta "${a.title}"? No habrá ganador.`)) return;
        try { await apiPost(`/plugin/auctions/auctions/${a.id}/cancel`, {}); setMsg("Subasta cancelada."); loadAuctions(); }
        catch (e) { setMsg(`Error: ${e?.message || e}`); }
    };
    const deleteAuction = async (a) => {
        if (!window.confirm(`¿Eliminar la subasta "${a.title}" y TODAS sus pujas? Esta acción no se puede deshacer.`)) return;
        try { await apiDelete(`/plugin/auctions/auctions/${a.id}`); setMsg("Subasta eliminada."); loadAuctions(); }
        catch (e) { setMsg(`Error: ${e?.message || e}`); }
    };
    const deleteBid = async (b) => {
        if (!window.confirm(`¿Eliminar la puja de ${b.bidder_name} por ${fmtMoney(b.amount_cents, symbol)}? El precio actual se recalcula automáticamente.`)) return;
        try { await apiDelete(`/plugin/auctions/bids/${b.id}`); setMsg("Puja eliminada."); loadBids(bidsAuction); loadAuctions(); }
        catch (e) { setMsg(`Error: ${e?.message || e}`); }
    };
    const saveSymbol = async () => {
        try {
            const r = await apiPost("/plugin/auctions/settings", { currencySymbol: symbolDraft });
            setSymbol(r.currencySymbol || "$");
            setMsg("Símbolo de moneda guardado.");
        } catch (e) { setMsg(`Error: ${e?.message || e}`); }
    };

    const tabBtn = (id, label) => (
        <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-4 py-2 rounded-xl font-black text-xs uppercase tracking-widest transition-all ${tab === id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
        >
            {label}
        </button>
    );

    return (
        <div className="max-w-5xl mx-auto p-4 sm:p-8">
            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Subastas</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Pujas públicas · incremento mínimo · extensión anti-sniping · ganadores
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 mb-6">
                {tabBtn("auctions", "Subastas")}
                {tabBtn("bids", "Pujas")}
                {tabBtn("report", "Reporte")}
                <div className="flex-1" />
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">Moneda</span>
                    <input
                        type="text"
                        value={symbolDraft}
                        onChange={(e) => setSymbolDraft(e.target.value)}
                        className="w-16 px-2 py-1.5 bg-gray-50 border-2 border-gray-100 rounded-xl text-center font-bold outline-none focus:border-blue-400"
                        maxLength={8}
                    />
                    <button type="button" onClick={saveSymbol} className={btnLight}>Guardar</button>
                </div>
            </div>

            {msg && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-6 ${/Error|falló/i.test(msg) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                    {msg}
                </div>
            )}

            {/* ============================ TAB: SUBASTAS ============================ */}
            {tab === "auctions" && (
                <div>
                    <div className="flex justify-end mb-4">
                        <button type="button" onClick={openCreate} className={btnDark}>Nueva subasta</button>
                    </div>
                    {auctions.length === 0 ? (
                        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-10 text-center text-sm text-gray-400">
                            Sin subastas todavía — crea la primera con "Nueva subasta".
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {auctions.map((a) => {
                                const meta = STATUS_META[a.status] || STATUS_META.draft;
                                return (
                                    <div key={a.id} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-5">
                                        <div className="flex gap-4">
                                            {a.image_url ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={a.image_url} alt={a.title} className="w-20 h-20 object-cover rounded-2xl border border-gray-100 shrink-0" />
                                            ) : (
                                                <div className="w-20 h-20 rounded-2xl bg-gray-50 border border-dashed border-gray-200 shrink-0 flex items-center justify-center text-gray-300 text-xs">Sin foto</div>
                                            )}
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-start justify-between gap-2">
                                                    <h3 className="font-bold text-gray-800 truncate">{a.title}</h3>
                                                    <span className={`shrink-0 text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-lg ${meta.cls}`}>{meta.label}</span>
                                                </div>
                                                <p className="text-2xl font-black text-gray-900 mt-1">{fmtMoney(a.currentPriceCents, symbol)}</p>
                                                <p className="text-[11px] text-gray-400 font-bold uppercase tracking-widest mt-1">
                                                    {a.bidCount} puja{a.bidCount === 1 ? "" : "s"}
                                                    {a.status === "active" ? ` · ${fmtRemaining(a.endsAtMs, nowMs)}` : ""}
                                                    {!a.is_published ? " · no publicada" : ""}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap gap-2 mt-4">
                                            <button type="button" onClick={() => openEdit(a)} className={btnLight}>Editar</button>
                                            <button type="button" onClick={() => { setBidsAuction(String(a.id)); setTab("bids"); }} className={btnLight}>Pujas</button>
                                            {a.status === "active" && (
                                                <button type="button" onClick={() => endNow(a)} className="px-4 py-2 bg-amber-100 hover:bg-amber-200 text-amber-700 rounded-xl font-bold text-xs transition-all">Finalizar ahora</button>
                                            )}
                                            {(a.status === "active" || a.status === "draft") && (
                                                <button type="button" onClick={() => cancelAuction(a)} className="px-4 py-2 bg-orange-50 hover:bg-orange-100 text-orange-600 rounded-xl font-bold text-xs transition-all">Cancelar</button>
                                            )}
                                            <button type="button" onClick={() => deleteAuction(a)} className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-bold text-xs transition-all">Eliminar</button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <p className="text-[11px] text-gray-400 mt-6 leading-relaxed">
                        En el editor visual, agrega el bloque <strong>Auctions</strong> — muestra la cuadrícula de subastas
                        activas (o una sola, indicando su slug) con cuenta regresiva y formulario de puja.
                    </p>
                </div>
            )}

            {/* ============================ TAB: PUJAS ============================ */}
            {tab === "bids" && (
                <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6">
                    <div className="mb-4">
                        <label className={labelCls}>Subasta</label>
                        <select value={bidsAuction} onChange={(e) => setBidsAuction(e.target.value)} className={inputCls}>
                            <option value="">— Selecciona una subasta —</option>
                            {auctions.map((a) => (
                                <option key={a.id} value={String(a.id)}>{a.title} ({STATUS_META[a.status]?.label || a.status})</option>
                            ))}
                        </select>
                    </div>
                    {!bidsAuction ? (
                        <p className="text-sm text-gray-400">Selecciona una subasta para ver sus pujas (incluye correos — solo visible aquí).</p>
                    ) : bids.length === 0 ? (
                        <p className="text-sm text-gray-400">Esta subasta no tiene pujas todavía.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="py-2 pr-3">#</th>
                                        <th className="py-2 pr-3">Nombre</th>
                                        <th className="py-2 pr-3">Correo</th>
                                        <th className="py-2 pr-3">Monto</th>
                                        <th className="py-2 pr-3">Fecha</th>
                                        <th className="py-2"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {bids.map((b, i) => (
                                        <tr key={b.id} className={`border-b border-gray-50 ${i === 0 ? "bg-green-50/50" : ""}`}>
                                            <td className="py-2 pr-3 text-gray-400">{i === 0 ? "🏆" : i + 1}</td>
                                            <td className="py-2 pr-3 font-bold text-gray-700">{b.bidder_name}</td>
                                            <td className="py-2 pr-3 text-gray-500">{b.bidder_email}</td>
                                            <td className="py-2 pr-3 font-black text-gray-900">{fmtMoney(b.amount_cents, symbol)}</td>
                                            <td className="py-2 pr-3 text-gray-400">{b.createdAtMs ? new Date(b.createdAtMs).toLocaleString() : b.created_at}</td>
                                            <td className="py-2 text-right">
                                                <button type="button" onClick={() => deleteBid(b)} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg font-bold text-xs transition-all">Eliminar</button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ============================ TAB: REPORTE ============================ */}
            {tab === "report" && (
                <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6">
                    <h2 className="font-bold text-gray-800 mb-4">Ganadores y contacto para la entrega</h2>
                    {report.length === 0 ? (
                        <p className="text-sm text-gray-400">Sin subastas todavía.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="py-2 pr-3">Subasta</th>
                                        <th className="py-2 pr-3">Estado</th>
                                        <th className="py-2 pr-3">Pujas</th>
                                        <th className="py-2 pr-3">Precio final / actual</th>
                                        <th className="py-2 pr-3">Ganador · contacto</th>
                                        <th className="py-2">Cierre</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.map((r) => (
                                        <tr key={r.id} className="border-b border-gray-50 align-top">
                                            <td className="py-2 pr-3 font-bold text-gray-700">{r.title}</td>
                                            <td className="py-2 pr-3">
                                                <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-lg ${(STATUS_META[r.status] || STATUS_META.draft).cls}`}>
                                                    {(STATUS_META[r.status] || STATUS_META.draft).label}
                                                </span>
                                            </td>
                                            <td className="py-2 pr-3 text-gray-600">{r.bidCount}</td>
                                            <td className="py-2 pr-3 font-black text-gray-900">{fmtMoney(r.finalPriceCents, symbol)}</td>
                                            <td className="py-2 pr-3">
                                                {r.status === "ended" ? (
                                                    r.winnerName ? (
                                                        <div>
                                                            <p className="font-bold text-green-700">{r.winnerName}</p>
                                                            <p className="text-gray-500">{r.winnerEmail}</p>
                                                        </div>
                                                    ) : (
                                                        <span className="text-gray-400">Sin pujas — desierta</span>
                                                    )
                                                ) : r.leaderName ? (
                                                    <div>
                                                        <p className="text-gray-600">Líder: {r.leaderName}</p>
                                                        <p className="text-gray-400">{r.leaderEmail}</p>
                                                    </div>
                                                ) : (
                                                    <span className="text-gray-400">—</span>
                                                )}
                                            </td>
                                            <td className="py-2 text-gray-400">{r.endsAtMs ? new Date(r.endsAtMs).toLocaleString() : r.ends_at}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ============================ MODAL CRUD ============================ */}
            {modal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setModal(null)}>
                    <form
                        onSubmit={saveModal}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-white rounded-3xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6 sm:p-8 space-y-4"
                    >
                        <h2 className="text-xl font-black text-gray-900 italic tracking-tighter">
                            {modal.mode === "create" ? "Nueva subasta" : "Editar subasta"}
                        </h2>
                        <div>
                            <label className={labelCls}>Título *</label>
                            <input type="text" value={form.title} onChange={(e) => setF("title", e.target.value)} className={inputCls} required maxLength={200} />
                        </div>
                        <div>
                            <label className={labelCls}>Descripción</label>
                            <textarea value={form.description} onChange={(e) => setF("description", e.target.value)} className={inputCls} rows={3} />
                        </div>
                        <div>
                            <label className={labelCls}>URL de la imagen</label>
                            <input type="text" value={form.image_url} onChange={(e) => setF("image_url", e.target.value)} className={inputCls} placeholder="https://… o /uploads/…" />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>Precio inicial ({symbol}) *</label>
                                <input type="number" step="0.01" min="0" value={form.start_price} onChange={(e) => setF("start_price", e.target.value)} className={inputCls} required />
                            </div>
                            <div>
                                <label className={labelCls}>Incremento mínimo ({symbol}) *</label>
                                <input type="number" step="0.01" min="0.01" value={form.min_increment} onChange={(e) => setF("min_increment", e.target.value)} className={inputCls} required />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>Inicio (opcional)</label>
                                <input type="datetime-local" value={form.starts_at} onChange={(e) => setF("starts_at", e.target.value)} className={inputCls} />
                            </div>
                            <div>
                                <label className={labelCls}>Fin *</label>
                                <input type="datetime-local" value={form.ends_at} onChange={(e) => setF("ends_at", e.target.value)} className={inputCls} required />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>Anti-sniping (minutos)</label>
                                <input type="number" min="0" max="120" value={form.anti_snipe_min} onChange={(e) => setF("anti_snipe_min", e.target.value)} className={inputCls} />
                                <p className="text-[11px] text-gray-400 mt-1">Una puja en los últimos N minutos extiende el cierre N minutos.</p>
                            </div>
                            <div>
                                <label className={labelCls}>Estado</label>
                                <select value={form.status} onChange={(e) => setF("status", e.target.value)} className={inputCls}>
                                    <option value="active">Activa</option>
                                    <option value="draft">Borrador</option>
                                </select>
                                <label className="flex items-center gap-2 mt-2 text-xs text-gray-500 cursor-pointer select-none">
                                    <input type="checkbox" checked={form.is_published} onChange={(e) => setF("is_published", e.target.checked)} />
                                    Publicada (visible en el sitio)
                                </label>
                            </div>
                        </div>
                        {formErr && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{formErr}</div>}
                        <div className="flex justify-end gap-3 pt-2">
                            <button type="button" onClick={() => setModal(null)} disabled={busy} className={btnLight}>Cancelar</button>
                            <button type="submit" disabled={busy} className={btnDark}>{busy ? "Guardando…" : "Guardar"}</button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}

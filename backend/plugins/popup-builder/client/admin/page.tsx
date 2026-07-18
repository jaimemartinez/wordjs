// @ts-nocheck
"use client";

/**
 * Admin page for the Popup Builder plugin (/admin/plugin/popups).
 * List of popups with stats (views/clicks/CTR), single-active toggle, and an editor modal with
 * triggers, frequency capping, optional date window, a "re-show to everybody" version bump and
 * an inline preview of the popup card.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const BASE = "/plugin/popup-builder";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnPrimary = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhost = "px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50";

const TRIGGER_OPTIONS = [
    { value: "delay", label: "Retardo (segundos)" },
    { value: "scroll", label: "Porcentaje de scroll" },
    { value: "exit", label: "Intención de salida" },
];

const FREQ_OPTIONS = [
    { value: "always", label: "Siempre" },
    { value: "session", label: "Una vez por sesión" },
    { value: "visitor", label: "Una vez por visitante" },
    { value: "daily", label: "Una vez al día" },
];

const FREQ_LABELS = { always: "Siempre", session: "1× por sesión", visitor: "1× por visitante", daily: "1× al día" };

// Short human summary of the trigger for the list cards.
function triggerSummary(p) {
    if (p.trigger_type === "scroll") return `Scroll ${p.trigger_value}%`;
    if (p.trigger_type === "exit") return "Intención de salida";
    return `Retardo ${p.trigger_value} s`;
}

function fmtDate(s) {
    if (!s) return "";
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

// Miniature live preview of the popup card, driven by the editor form values.
function PopupPreview({ form }) {
    return (
        <div className="rounded-2xl bg-gray-900/90 p-6 flex items-center justify-center">
            <div className="relative bg-white rounded-2xl shadow-2xl max-w-[280px] w-full p-5 text-center">
                <span className="absolute top-2 right-2 w-6 h-6 rounded-full bg-gray-100 text-gray-500 text-sm flex items-center justify-center">×</span>
                {form.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={form.image_url} alt="" decoding="async" className="w-full rounded-xl mb-3 object-cover max-h-32" />
                ) : null}
                <h3 className="font-black text-gray-900 text-base leading-snug mb-1">{form.title || "Título del popup"}</h3>
                {form.body ? <p className="text-xs text-gray-500 whitespace-pre-line mb-3">{form.body}</p> : <p className="text-xs text-gray-300 mb-3">Texto del popup…</p>}
                {form.button_label ? (
                    <span className="inline-block px-4 py-2 bg-gray-900 text-white rounded-xl text-xs font-bold">{form.button_label}</span>
                ) : null}
            </div>
        </div>
    );
}

// Editor modal — create (popup=null) or edit (popup=object). Mounted fresh per session (keyed by parent).
function EditorModal({ popup, onClose, onSaved }) {
    const isEdit = !!(popup && popup.id);
    const [form, setForm] = useState({
        title: popup?.title || "",
        body: popup?.body || "",
        image_url: popup?.image_url || "",
        button_label: popup?.button_label || "",
        button_url: popup?.button_url || "",
        trigger_type: popup?.trigger_type || "delay",
        trigger_value: popup?.trigger_value ?? 3,
        frequency: popup?.frequency || "session",
        starts_at: popup?.starts_at || "",
        ends_at: popup?.ends_at || "",
        activate: !!popup?.enabled,
        bump: false,
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const payload = {
                title: form.title,
                body: form.body,
                image_url: form.image_url,
                button_label: form.button_label,
                button_url: form.button_url,
                trigger_type: form.trigger_type,
                trigger_value: form.trigger_type === "exit" ? 0 : parseInt(form.trigger_value, 10),
                frequency: form.frequency,
                starts_at: form.starts_at,
                ends_at: form.ends_at,
                enabled: form.activate,
            };
            if (isEdit) {
                payload.id = popup.id;
                payload.bump_version = form.bump;
            }
            await apiPost(`${BASE}/save`, payload);
            onSaved();
        } catch (err) {
            setError(err?.message || "No se pudo guardar el popup.");
        } finally {
            setBusy(false);
        }
    };

    const valueLabel = form.trigger_type === "scroll" ? "% de scroll" : "Segundos";

    return (
        <div className="fixed inset-0 z-50 bg-gray-900/50 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4 sm:p-8">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl p-6 sm:p-8 my-4">
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-black text-gray-900 italic tracking-tighter">
                        {isEdit ? "Editar popup" : "Nuevo popup"}
                    </h2>
                    <button type="button" onClick={onClose} className="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 font-bold transition-all">×</button>
                </div>

                <form onSubmit={save} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="space-y-4">
                        <div>
                            <label className={labelCls}>Título *</label>
                            <input type="text" value={form.title} onChange={(e) => set("title", e.target.value)} className={inputCls} placeholder="¡Oferta de verano!" required />
                        </div>
                        <div>
                            <label className={labelCls}>Texto</label>
                            <textarea value={form.body} onChange={(e) => set("body", e.target.value)} className={`${inputCls} min-h-[90px]`} placeholder="Describe la promoción o el anuncio…" />
                        </div>
                        <div>
                            <label className={labelCls}>URL de la imagen (opcional)</label>
                            <input type="text" value={form.image_url} onChange={(e) => set("image_url", e.target.value)} className={inputCls} placeholder="/uploads/promo.jpg o https://…" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={labelCls}>Texto del botón</label>
                                <input type="text" value={form.button_label} onChange={(e) => set("button_label", e.target.value)} className={inputCls} placeholder="Ver oferta" />
                            </div>
                            <div>
                                <label className={labelCls}>URL del botón</label>
                                <input type="text" value={form.button_url} onChange={(e) => set("button_url", e.target.value)} className={inputCls} placeholder="/tienda o https://…" />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={labelCls}>Disparador</label>
                                <select value={form.trigger_type} onChange={(e) => set("trigger_type", e.target.value)} className={inputCls}>
                                    {TRIGGER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                            </div>
                            {form.trigger_type !== "exit" && (
                                <div>
                                    <label className={labelCls}>{valueLabel}</label>
                                    <input type="number" min={0} max={form.trigger_type === "scroll" ? 100 : undefined} value={form.trigger_value} onChange={(e) => set("trigger_value", e.target.value)} className={inputCls} />
                                </div>
                            )}
                        </div>
                        <div>
                            <label className={labelCls}>Frecuencia</label>
                            <select value={form.frequency} onChange={(e) => set("frequency", e.target.value)} className={inputCls}>
                                {FREQ_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={labelCls}>Mostrar desde (opcional)</label>
                                <input type="datetime-local" value={form.starts_at} onChange={(e) => set("starts_at", e.target.value)} className={inputCls} />
                            </div>
                            <div>
                                <label className={labelCls}>Mostrar hasta (opcional)</label>
                                <input type="datetime-local" value={form.ends_at} onChange={(e) => set("ends_at", e.target.value)} className={inputCls} />
                            </div>
                        </div>
                        <label className="flex items-center gap-2 text-xs font-bold text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={form.activate} onChange={(e) => set("activate", e.target.checked)} />
                            Activar este popup al guardar (desactiva los demás)
                        </label>
                        {isEdit && (
                            <label className="flex items-center gap-2 text-xs font-bold text-gray-600 cursor-pointer select-none">
                                <input type="checkbox" checked={form.bump} onChange={(e) => set("bump", e.target.checked)} />
                                Volver a mostrar a todos (reinicia la frecuencia de los visitantes)
                            </label>
                        )}
                    </div>

                    <div className="space-y-4">
                        <div>
                            <span className={labelCls}>Vista previa</span>
                            <PopupPreview form={form} />
                        </div>
                        {error && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{error}</div>}
                        <div className="flex items-center justify-end gap-3">
                            <button type="button" onClick={onClose} className={btnGhost}>Cancelar</button>
                            <button type="submit" disabled={busy} className={btnPrimary}>{busy ? "Guardando…" : "Guardar"}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}

// A single popup row card in the list.
function PopupCard({ popup, busy, onToggle, onEdit, onDelete }) {
    return (
        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-black text-gray-900 truncate">{popup.title}</h3>
                        {popup.enabled ? (
                            <span className="px-2.5 py-1 rounded-full bg-green-100 text-green-700 text-[10px] font-black uppercase tracking-widest">Activo</span>
                        ) : (
                            <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-400 text-[10px] font-black uppercase tracking-widest">Inactivo</span>
                        )}
                    </div>
                    <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mt-1">
                        {triggerSummary(popup)} · {FREQ_LABELS[popup.frequency] || popup.frequency} · v{popup.version}
                    </p>
                    {(popup.starts_at || popup.ends_at) && (
                        <p className="text-[11px] text-gray-400 mt-1">
                            {popup.starts_at ? `Desde ${fmtDate(popup.starts_at)}` : ""}
                            {popup.starts_at && popup.ends_at ? " · " : ""}
                            {popup.ends_at ? `Hasta ${fmtDate(popup.ends_at)}` : ""}
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-4 text-center">
                    <div>
                        <p className="text-lg font-black text-gray-900">{popup.views}</p>
                        <p className="text-[9px] font-black uppercase tracking-widest text-gray-400">Vistas</p>
                    </div>
                    <div>
                        <p className="text-lg font-black text-gray-900">{popup.clicks}</p>
                        <p className="text-[9px] font-black uppercase tracking-widest text-gray-400">Clics</p>
                    </div>
                    <div>
                        <p className="text-lg font-black text-blue-600">{popup.ctr}%</p>
                        <p className="text-[9px] font-black uppercase tracking-widest text-gray-400">CTR</p>
                    </div>
                </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 mt-4">
                <button type="button" disabled={busy} onClick={() => onToggle(popup)} className={popup.enabled ? btnGhost : "px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50"}>
                    {popup.enabled ? "Desactivar" : "Activar"}
                </button>
                <button type="button" disabled={busy} onClick={() => onEdit(popup)} className={btnGhost}>Editar</button>
                <button type="button" disabled={busy} onClick={() => onDelete(popup)} className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50">
                    Eliminar
                </button>
            </div>
        </div>
    );
}

export default function PopupBuilderAdminPage() {
    const [popups, setPopups] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    // undefined = modal closed; null = creating; object = editing that popup
    const [editing, setEditing] = useState(undefined);

    const load = async () => {
        try {
            const data = await api(`${BASE}/list`);
            setPopups(data.popups || []);
        } catch (err) {
            setMessage(`Error al cargar los popups: ${err?.message || err}`);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, []);

    const toggle = async (popup) => {
        setBusy(true);
        setMessage("");
        try {
            await apiPost(`${BASE}/${popup.id}/${popup.enabled ? "disable" : "enable"}`, {});
            await load();
        } catch (err) {
            setMessage(`Error: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const remove = async (popup) => {
        if (!window.confirm(`¿Eliminar el popup "${popup.title}"? Esta acción no se puede deshacer.`)) return;
        setBusy(true);
        setMessage("");
        try {
            await apiDelete(`${BASE}/${popup.id}`);
            await load();
        } catch (err) {
            setMessage(`Error al eliminar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const onSaved = async () => {
        setEditing(undefined);
        setMessage("Popup guardado correctamente.");
        await load();
    };

    return (
        <div className="max-w-4xl mx-auto p-4 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Popups</h1>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                        Anuncios y promociones en todo el sitio · uno activo a la vez
                    </p>
                </div>
                <button type="button" onClick={() => setEditing(null)} className={btnPrimary}>Nuevo popup</button>
            </div>

            {message && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-6 ${/Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                    {message}
                </div>
            )}

            {loading ? (
                <p className="text-sm text-gray-400">Cargando…</p>
            ) : popups.length === 0 ? (
                <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-10 text-center">
                    <p className="text-sm text-gray-400 mb-4">Todavía no hay popups. Crea el primero para mostrar un anuncio en el sitio público.</p>
                    <button type="button" onClick={() => setEditing(null)} className={btnPrimary}>Crear popup</button>
                </div>
            ) : (
                <div className="space-y-4">
                    {popups.map((p) => (
                        <PopupCard key={p.id} popup={p} busy={busy} onToggle={toggle} onEdit={(pp) => setEditing(pp)} onDelete={remove} />
                    ))}
                </div>
            )}

            <p className="text-[11px] text-gray-400 mt-8 leading-relaxed">
                El popup activo se muestra automáticamente en todas las páginas públicas mientras el plugin esté activo.
                Marcar «Volver a mostrar a todos» al editar reinicia la frecuencia de todos los visitantes.
            </p>

            {editing !== undefined && (
                <EditorModal
                    key={editing ? editing.id : "new"}
                    popup={editing}
                    onClose={() => setEditing(undefined)}
                    onSaved={onSaved}
                />
            )}
        </div>
    );
}

// @ts-nocheck
"use client";

/**
 * Admin page for the Testimonials plugin (/admin/plugin/testimonials).
 * Moderation tabs (Pendientes with badge / Aprobados), card list with approve/edit/delete,
 * a create/edit modal, and the "allow public submissions" settings toggle.
 * API calls go through the host's api helpers (session cookie).
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnLightCls = "px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50";

// ── module-level components (never define a component inside a component) ──────────────────────

function StarsRow({ rating }) {
    const r = Math.max(1, Math.min(5, Number(rating) || 5));
    return (
        <span className="inline-flex gap-0.5 text-sm" aria-label={`${r} de 5 estrellas`}>
            {[1, 2, 3, 4, 5].map((i) => (
                <span key={i} className={i <= r ? "text-amber-500" : "text-gray-200"} aria-hidden="true">★</span>
            ))}
        </span>
    );
}

function RatingPicker({ value, onChange }) {
    return (
        <span className="inline-flex gap-1" role="radiogroup" aria-label="Calificación">
            {[1, 2, 3, 4, 5].map((i) => (
                <button
                    key={i}
                    type="button"
                    className={`text-2xl leading-none transition-colors ${i <= value ? "text-amber-500" : "text-gray-200 hover:text-amber-300"}`}
                    aria-label={`${i} de 5 estrellas`}
                    aria-pressed={i === value}
                    onClick={() => onChange(i)}
                >★</button>
            ))}
        </span>
    );
}

function AuthorAvatar({ item }) {
    const initial = (item.author_name || "?").trim().charAt(0).toUpperCase() || "?";
    if (item.author_photo) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={item.author_photo} alt={item.author_name} className="w-11 h-11 rounded-full object-cover border border-gray-100 flex-shrink-0" />;
    }
    return (
        <span className="w-11 h-11 rounded-full bg-gray-900 text-white flex items-center justify-center font-black flex-shrink-0" aria-hidden="true">
            {initial}
        </span>
    );
}

function TestimonialCard({ item, busy, onApprove, onEdit, onDelete }) {
    return (
        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-5 sm:p-6 flex flex-col gap-3">
            <div className="flex items-center gap-3">
                <AuthorAvatar item={item} />
                <div className="min-w-0">
                    <p className="font-bold text-gray-900 truncate">{item.author_name}</p>
                    {item.author_role && <p className="text-[11px] text-gray-400 truncate">{item.author_role}</p>}
                </div>
                <div className="ml-auto flex flex-col items-end gap-1">
                    <StarsRow rating={item.rating} />
                    <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${item.source === "public" ? "bg-blue-50 text-blue-500" : "bg-gray-100 text-gray-400"}`}>
                        {item.source === "public" ? "Público" : "Admin"}
                    </span>
                </div>
            </div>
            <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{item.content}</p>
            <div className="flex flex-wrap items-center gap-2 mt-auto pt-2">
                <span className="text-[10px] text-gray-300 font-bold mr-auto">
                    {item.created_at ? new Date(item.created_at).toLocaleDateString() : ""}
                </span>
                {item.status === "pending" && (
                    <button type="button" disabled={busy} onClick={() => onApprove(item)} className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50">
                        Aprobar
                    </button>
                )}
                <button type="button" disabled={busy} onClick={() => onEdit(item)} className={btnLightCls}>Editar</button>
                <button type="button" disabled={busy} onClick={() => onDelete(item)} className="px-4 py-2 bg-red-50 hover:bg-red-600 text-red-600 hover:text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50">
                    Eliminar
                </button>
            </div>
        </div>
    );
}

/**
 * Create/edit modal. Owns its own form state, initialized from `initial`; the parent remounts it
 * (via key) each time it opens, so stale state never leaks between edits.
 */
function TestimonialModal({ initial, onClose, onSaved }) {
    const [name, setName] = useState(initial?.author_name || "");
    const [role, setRole] = useState(initial?.author_role || "");
    const [photo, setPhoto] = useState(initial?.author_photo || "");
    const [content, setContent] = useState(initial?.content || "");
    const [rating, setRating] = useState(() => {
        const r = Number(initial?.rating);
        return Number.isInteger(r) && r >= 1 && r <= 5 ? r : 5;
    });
    const [status, setStatus] = useState(initial?.status === "pending" ? "pending" : "approved");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const save = async (e) => {
        e.preventDefault();
        setBusy(true); setError("");
        try {
            const body = {
                author_name: name.trim(),
                author_role: role.trim(),
                author_photo: photo.trim(),
                content: content.trim(),
                rating,
                status,
            };
            if (initial?.id) body.id = initial.id;
            await apiPost("/plugin/testimonials/save", body);
            onSaved();
        } catch (err) {
            setError(err?.message || "No se pudo guardar el testimonio.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 p-4" onClick={onClose}>
            <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 sm:p-8 space-y-4">
                <h2 className="text-xl font-black text-gray-900 italic tracking-tighter">
                    {initial?.id ? "Editar testimonio" : "Nuevo testimonio"}
                </h2>
                <div>
                    <label className={labelCls}>Nombre *</label>
                    <input type="text" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className={inputCls} required />
                </div>
                <div>
                    <label className={labelCls}>Cargo / Empresa</label>
                    <input type="text" value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} className={inputCls} />
                </div>
                <div>
                    <label className={labelCls}>URL de la foto (http/https, opcional)</label>
                    <input type="url" value={photo} maxLength={500} onChange={(e) => setPhoto(e.target.value)} placeholder="https://…" className={inputCls} />
                </div>
                <div>
                    <label className={labelCls}>Testimonio *</label>
                    <textarea value={content} maxLength={2000} onChange={(e) => setContent(e.target.value)} rows={4} className={inputCls} required />
                </div>
                <div className="flex flex-wrap items-end gap-6">
                    <div>
                        <label className={labelCls}>Calificación</label>
                        <RatingPicker value={rating} onChange={setRating} />
                    </div>
                    <div className="flex-1 min-w-[140px]">
                        <label className={labelCls}>Estado</label>
                        <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                            <option value="approved">Aprobado</option>
                            <option value="pending">Pendiente</option>
                        </select>
                    </div>
                </div>
                {error && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{error}</div>}
                <div className="flex items-center justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnLightCls}>Cancelar</button>
                    <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </div>
    );
}

export default function TestimonialsAdminPage() {
    const [items, setItems] = useState([]);
    const [counts, setCounts] = useState({ pending: 0, approved: 0 });
    const [tab, setTab] = useState("pending");
    const [allowPublicSubmit, setAllowPublicSubmit] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [modal, setModal] = useState(null); // null = closed, {} = new, {...item} = edit

    const load = async () => {
        try {
            const data = await api("/plugin/testimonials/list?status=all");
            setItems(data.items || []);
            setCounts(data.counts || { pending: 0, approved: 0 });
        } catch (err) {
            setMessage(`Error al cargar: ${err?.message || err}`);
        }
    };
    const loadSettings = async () => {
        try {
            const s = await api("/plugin/testimonials/settings");
            setAllowPublicSubmit(!!s.allowPublicSubmit);
        } catch {
            // Non-fatal: the toggle just stays off until a reload succeeds.
        }
    };

    useEffect(() => { load(); loadSettings(); }, []);

    const approve = async (item) => {
        setBusy(true); setMessage("");
        try {
            await apiPost(`/plugin/testimonials/${item.id}/approve`, {});
            setMessage(`Testimonio de ${item.author_name} aprobado.`);
            await load();
        } catch (err) {
            setMessage(`Error al aprobar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const remove = async (item) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Eliminar el testimonio de ${item.author_name}? Esta acción no se puede deshacer.`)) return;
        setBusy(true); setMessage("");
        try {
            await apiDelete(`/plugin/testimonials/${item.id}`);
            setMessage("Testimonio eliminado.");
            await load();
        } catch (err) {
            setMessage(`Error al eliminar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const toggleSubmit = async () => {
        const next = !allowPublicSubmit;
        setAllowPublicSubmit(next); // optimistic
        try {
            await apiPost("/plugin/testimonials/settings", { allowPublicSubmit: next });
        } catch (err) {
            setAllowPublicSubmit(!next); // revert
            setMessage(`Error al guardar la configuración: ${err?.message || err}`);
        }
    };

    const visible = items.filter((i) => (tab === "pending" ? i.status === "pending" : i.status === "approved"));

    return (
        <div className="max-w-4xl mx-auto p-4 sm:p-8">
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Testimonios</h1>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                        Moderación + bloque "Testimonials" en el editor visual
                    </p>
                </div>
                <button type="button" onClick={() => setModal({})} className={btnCls}>Nuevo testimonio</button>
            </div>

            {/* Settings toggle */}
            <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-5 sm:p-6 mb-6 flex flex-wrap items-center justify-between gap-3">
                <div>
                    <p className="font-bold text-gray-800 text-sm">Permitir envíos públicos desde el bloque</p>
                    <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
                        Si está activo, el bloque puede mostrar un formulario público; los envíos entran como
                        <strong> pendientes</strong> y solo se publican cuando los apruebas aquí.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={toggleSubmit}
                    role="switch"
                    aria-checked={allowPublicSubmit}
                    className={`relative w-14 h-8 rounded-full transition-colors flex-shrink-0 ${allowPublicSubmit ? "bg-green-500" : "bg-gray-200"}`}
                >
                    <span className={`absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-all ${allowPublicSubmit ? "left-7" : "left-1"}`} />
                </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6">
                <button
                    type="button"
                    onClick={() => setTab("pending")}
                    className={`px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 ${tab === "pending" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                >
                    Pendientes
                    {counts.pending > 0 && (
                        <span className="bg-red-500 text-white text-[10px] font-black rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center">
                            {counts.pending}
                        </span>
                    )}
                </button>
                <button
                    type="button"
                    onClick={() => setTab("approved")}
                    className={`px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${tab === "approved" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                >
                    Aprobados ({counts.approved})
                </button>
            </div>

            {message && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-6 ${/Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                    {message}
                </div>
            )}

            {/* Cards */}
            {visible.length === 0 ? (
                <div className="bg-white rounded-3xl border border-dashed border-gray-200 p-10 text-center text-sm text-gray-400">
                    {tab === "pending"
                        ? "No hay testimonios pendientes de moderación."
                        : "No hay testimonios aprobados todavía — crea uno con “Nuevo testimonio”."}
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {visible.map((item) => (
                        <TestimonialCard
                            key={item.id}
                            item={item}
                            busy={busy}
                            onApprove={approve}
                            onEdit={(it) => setModal(it)}
                            onDelete={remove}
                        />
                    ))}
                </div>
            )}

            <p className="text-[11px] text-gray-400 mt-8 leading-relaxed">
                En el editor visual, agrega el bloque <strong>Testimonials</strong> (categoría Testimonios) —
                muestra los testimonios aprobados en carrusel o cuadrícula y, si lo permites arriba, un
                formulario de envío público. (El bloque estático "Testimonial" del núcleo es distinto: uno
                solo, escrito a mano en el editor.)
            </p>

            {modal !== null && (
                <TestimonialModal
                    key={modal.id || "new"}
                    initial={modal.id ? modal : null}
                    onClose={() => setModal(null)}
                    onSaved={() => { setModal(null); setMessage("Testimonio guardado."); load(); }}
                />
            )}
        </div>
    );
}

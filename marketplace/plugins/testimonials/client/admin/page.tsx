// @ts-nocheck
"use client";

/**
 * Admin page for the Testimonials plugin (/admin/plugin/testimonials).
 * Moderation tabs (Pendientes with badge / Aprobados), card list with approve/edit/delete,
 * a create/edit modal, and the "allow public submissions" settings toggle.
 * API calls go through the host's api helpers (session cookie).
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-testimonials) — the markup below only uses cf-*
 * classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

/* Tiny inline icon set (viewBox 24, stroke currentColor) so the identity needs no icon-font. */
const IconQuote = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
const IconCheck = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M20 6 9 17l-5-5" />
    </svg>
);
const IconStar = (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
);

// ── module-level components (never define a component inside a component) ──────────────────────

function StarsRow({ rating }) {
    const r = Math.max(1, Math.min(5, Number(rating) || 5));
    return (
        <span className="cf-stars" aria-label={`${r} de 5 estrellas`}>
            {[1, 2, 3, 4, 5].map((i) => (
                <IconStar key={i} className={i <= r ? "" : "is-off"} />
            ))}
        </span>
    );
}

function RatingPicker({ value, onChange }) {
    return (
        <span className="cf-star-row" role="radiogroup" aria-label="Calificación">
            {[1, 2, 3, 4, 5].map((i) => (
                <button
                    key={i}
                    type="button"
                    className={`cf-star-btn ${i <= value ? "is-on" : ""}`}
                    aria-label={`${i} de 5 estrellas`}
                    aria-pressed={i === value}
                    onClick={() => onChange(i)}
                ><IconStar /></button>
            ))}
        </span>
    );
}

function AuthorAvatar({ item }) {
    const initial = (item.author_name || "?").trim().charAt(0).toUpperCase() || "?";
    if (item.author_photo) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={item.author_photo} alt={item.author_name} className="cf-avatar" />;
    }
    return (
        <span className="cf-avatar cf-avatar-fallback" aria-hidden="true">
            {initial}
        </span>
    );
}

function TestimonialCard({ item, busy, onApprove, onEdit, onDelete }) {
    return (
        <div className="cf-card-item cf-tcard">
            <div className="cf-tcard-head">
                <AuthorAvatar item={item} />
                <div style={{ minWidth: 0 }}>
                    <p className="cf-t-name">{item.author_name}</p>
                    {item.author_role && <p className="cf-t-role">{item.author_role}</p>}
                </div>
                <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.35rem" }}>
                    <StarsRow rating={item.rating} />
                    <span className={`cf-pill ${item.source === "public" ? "is-public" : ""}`}>
                        {item.source === "public" ? "Público" : "Admin"}
                    </span>
                </div>
            </div>
            <p className="cf-t-quote">{item.content}</p>
            <div className="cf-tcard-foot">
                <span className="cf-t-date">
                    {item.created_at ? new Date(item.created_at).toLocaleDateString() : ""}
                </span>
                {item.status === "pending" && (
                    <button type="button" disabled={busy} onClick={() => onApprove(item)} className="cf-btn">
                        <IconCheck /> Aprobar
                    </button>
                )}
                <button type="button" disabled={busy} onClick={() => onEdit(item)} className="cf-btn-ghost"><IconPen /> Editar</button>
                <button type="button" disabled={busy} onClick={() => onDelete(item)} className="cf-btn-danger">
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
        <div className="cf-overlay" onClick={onClose}>
            <form
                onSubmit={save}
                onClick={(e) => e.stopPropagation()}
                className="cf-letter"
                role="dialog"
                aria-modal="true"
                aria-label={initial?.id ? "Editar testimonio" : "Nuevo testimonio"}
            >
                <div className="cf-letter-body">
                    <h2 className="cf-editor-title">
                        {initial?.id ? <IconPen /> : <IconPlus />}
                        {initial?.id ? "Editar testimonio" : "Nuevo testimonio"}
                    </h2>
                    <div style={{ display: "grid", gap: "1.05rem" }}>
                        <div>
                            <label className="cf-label" htmlFor="tm-name">Nombre *</label>
                            <input id="tm-name" type="text" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="cf-input" required />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="tm-role">Cargo / Empresa</label>
                            <input id="tm-role" type="text" value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} className="cf-input" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="tm-photo">URL de la foto (http/https, opcional)</label>
                            <input id="tm-photo" type="url" value={photo} maxLength={500} onChange={(e) => setPhoto(e.target.value)} placeholder="https://…" className="cf-input" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="tm-content">Testimonio *</label>
                            <textarea id="tm-content" value={content} maxLength={2000} onChange={(e) => setContent(e.target.value)} rows={4} className="cf-input" required />
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "1.5rem" }}>
                            <div>
                                <span className="cf-label">Calificación</span>
                                <RatingPicker value={rating} onChange={setRating} />
                            </div>
                            <div style={{ flex: 1, minWidth: "140px" }}>
                                <label className="cf-label" htmlFor="tm-status">Estado</label>
                                <select id="tm-status" value={status} onChange={(e) => setStatus(e.target.value)} className="cf-select">
                                    <option value="approved">Aprobado</option>
                                    <option value="pending">Pendiente</option>
                                </select>
                            </div>
                        </div>
                        {error && <div role="alert" className="cf-flash is-error" style={{ marginBottom: 0 }}>{error}</div>}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem", paddingTop: "0.35rem" }}>
                            <button type="button" onClick={onClose} className="cf-btn-ghost">Cancelar</button>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? "Guardando…" : "Guardar"}</button>
                        </div>
                    </div>
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
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconQuote /></div>
                <div>
                    <h1 className="cf-title">Testimonios</h1>
                    <p className="cf-subtitle">Moderación + bloque "Testimonials" en el editor visual</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                <button type="button" onClick={() => setModal({})} className="cf-btn"><IconPlus /> Nuevo testimonio</button>
            </div>

            {/* Settings toggle */}
            <div className="cf-card-item" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "1rem", marginBottom: "1.5rem" }}>
                <div style={{ minWidth: 0, flex: "1 1 18rem" }}>
                    <p className="cf-setting-title">Permitir envíos públicos desde el bloque</p>
                    <p className="cf-setting-desc">
                        Si está activo, el bloque puede mostrar un formulario público; los envíos entran como
                        <strong> pendientes</strong> y solo se publican cuando los apruebas aquí.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={toggleSubmit}
                    role="switch"
                    aria-checked={allowPublicSubmit}
                    aria-label="Permitir envíos públicos desde el bloque"
                    className={`cf-switch ${allowPublicSubmit ? "is-on" : ""}`}
                >
                    <span className="cf-switch-knob" />
                </button>
            </div>

            {/* Tabs */}
            <div className="cf-tabs" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "pending"}
                    onClick={() => setTab("pending")}
                    className={`cf-tab ${tab === "pending" ? "is-active" : ""}`}
                >
                    Pendientes
                    {counts.pending > 0 && (
                        <span className="cf-badge">
                            {counts.pending}
                        </span>
                    )}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "approved"}
                    onClick={() => setTab("approved")}
                    className={`cf-tab ${tab === "approved" ? "is-active" : ""}`}
                >
                    Aprobados ({counts.approved})
                </button>
            </div>

            {message && (
                <div role={/Error/i.test(message) ? "alert" : "status"} className={`cf-flash ${/Error/i.test(message) ? "is-error" : "is-ok"}`}>
                    {message}
                </div>
            )}

            {/* Cards */}
            {visible.length === 0 ? (
                <div className="cf-empty">
                    <IconQuote />
                    <span>
                        {tab === "pending"
                            ? "No hay testimonios pendientes de moderación."
                            : "No hay testimonios aprobados todavía — crea uno con “Nuevo testimonio”."}
                    </span>
                </div>
            ) : (
                <div className="cf-cardgrid">
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

            <p className="cf-footnote">
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

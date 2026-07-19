// @ts-nocheck
"use client";

/**
 * Admin page for the FAQ plugin (/admin/plugin/faq).
 * Lists the questions grouped by category with publish toggles, up/down reordering,
 * edit/delete, and a create/edit modal. API calls go through the host's api helpers
 * (session cookie). All user-facing text in Spanish.
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected
 * by the host admin shell and scoped to .plugin-admin-faq) — the markup below only uses
 * cf-* classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const EMPTY_FORM = { id: null, question: "", answer: "", category: "" };

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconHelp = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <path d="M12 17h.01" />
    </svg>
);
const IconPlus = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M12 5v14M5 12h14" />
    </svg>
);
const IconChevronUp = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="m18 15-6-6-6 6" />
    </svg>
);
const IconChevronDown = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="m6 9 6 6 6-6" />
    </svg>
);
const IconPen = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
);
const IconX = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M18 6 6 18M6 6l12 12" />
    </svg>
);
const IconBlock = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="3" y="4" width="18" height="6" rx="1.5" />
        <rect x="3" y="14" width="18" height="6" rx="1.5" />
    </svg>
);

export default function FaqAdminPage() {
    const [faqs, setFaqs] = useState(null); // null = loading
    const [categories, setCategories] = useState([]);
    const [message, setMessage] = useState("");
    const [modalOpen, setModalOpen] = useState(false);
    const [modalError, setModalError] = useState("");
    const [form, setForm] = useState(EMPTY_FORM);
    const [busy, setBusy] = useState(false);

    const loadCategories = async () => {
        try {
            const r = await api("/plugin/faq/categories");
            setCategories((r && r.categories) || []);
        } catch {
            setCategories([]);
        }
    };
    const loadAll = async () => {
        try {
            const r = await api("/plugin/faq/list");
            setFaqs((r && r.faqs) || []);
        } catch (err) {
            setFaqs([]);
            setMessage(`Error al cargar la lista: ${err?.message || err}`);
        }
        loadCategories();
    };

    useEffect(() => { loadAll(); }, []);

    // Group by category preserving the server order (category ASC, sort_order ASC).
    const groups = useMemo(() => {
        const map = new Map();
        for (const f of faqs || []) {
            const key = f.category || "";
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(f);
        }
        return Array.from(map.entries()).map(([category, items]) => ({ category, items }));
    }, [faqs]);

    const openNew = () => { setForm(EMPTY_FORM); setModalError(""); setModalOpen(true); };
    const openEdit = (f) => {
        setForm({ id: f.id, question: f.question || "", answer: f.answer || "", category: f.category || "" });
        setModalError("");
        setModalOpen(true);
    };

    const save = async (e) => {
        e.preventDefault();
        if (!form.question.trim() || !form.answer.trim()) {
            setModalError("La pregunta y la respuesta son obligatorias.");
            return;
        }
        setBusy(true); setModalError("");
        try {
            const body = { question: form.question.trim(), answer: form.answer.trim(), category: form.category.trim() };
            if (form.id) body.id = form.id;
            await apiPost("/plugin/faq/save", body);
            setModalOpen(false);
            setMessage(form.id ? "Pregunta actualizada." : "Pregunta creada.");
            loadAll();
        } catch (err) {
            setModalError(`Error al guardar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const toggle = async (f) => {
        try {
            const r = await apiPost(`/plugin/faq/${f.id}/toggle`, {});
            setFaqs((prev) => (prev || []).map((x) => (x.id === f.id ? { ...x, is_published: r.is_published } : x)));
        } catch (err) {
            setMessage(`Error al cambiar la visibilidad: ${err?.message || err}`);
        }
    };

    const remove = async (f) => {
        if (typeof window !== "undefined" && !window.confirm("¿Eliminar esta pregunta de forma permanente?")) return;
        try {
            await apiDelete(`/plugin/faq/${f.id}`);
            setFaqs((prev) => (prev || []).filter((x) => x.id !== f.id));
            setMessage("Pregunta eliminada.");
            loadCategories();
        } catch (err) {
            setMessage(`Error al eliminar: ${err?.message || err}`);
        }
    };

    // Move within its category group, then persist the FULL flattened order — the backend
    // assigns sort_order by array index and lists order by (category, sort_order).
    const move = async (f, dir) => {
        const gi = groups.findIndex((g) => g.items.some((x) => x.id === f.id));
        if (gi < 0) return;
        const items = [...groups[gi].items];
        const idx = items.findIndex((x) => x.id === f.id);
        const target = idx + dir;
        if (target < 0 || target >= items.length) return;
        const tmp = items[idx]; items[idx] = items[target]; items[target] = tmp;
        const flat = groups.flatMap((g, i) => (i === gi ? items : g.items));
        setFaqs(flat);
        try {
            await apiPost("/plugin/faq/reorder", { ids: flat.map((x) => x.id) });
        } catch (err) {
            setMessage(`Error al reordenar: ${err?.message || err}`);
            loadAll();
        }
    };

    const total = (faqs || []).length;

    return (
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconHelp /></div>
                <div>
                    <h1 className="cf-title">FAQ</h1>
                    <p className="cf-subtitle">Preguntas frecuentes por categoría → bloque acordeón con SEO</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                <button type="button" onClick={openNew} className="cf-btn"><IconPlus /> Nueva pregunta</button>
            </div>

            {message && (
                <div role={/Error/i.test(message) ? "alert" : "status"} className={`cf-flash ${/Error/i.test(message) ? "is-error" : "is-ok"}`}>
                    {message}
                </div>
            )}

            {/* questions grouped by category */}
            <div className="cf-card-item">
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", marginBottom: "1.1rem" }}>
                    <h2 className="cf-card-title"><IconBlock /> Preguntas</h2>
                    <span className="cf-count">
                        {total} pregunta{total === 1 ? "" : "s"} · {groups.filter((g) => g.category).length} categoría{groups.filter((g) => g.category).length === 1 ? "" : "s"}
                    </span>
                </div>

                {faqs === null ? (
                    <p className="cf-help">Cargando…</p>
                ) : total === 0 ? (
                    <div className="cf-empty">
                        <IconHelp />
                        <span>No hay preguntas todavía — crea la primera con "Nueva pregunta".</span>
                    </div>
                ) : (
                    <div>
                        {groups.map((g) => (
                            <div key={g.category || "__none__"} className="cf-group">
                                <h3 className="cf-group-title">{g.category || "Sin categoría"}</h3>
                                <ul className="cf-faq-list">
                                    {g.items.map((f, i) => (
                                        <li key={f.id} className={`cf-faq-row ${Number(f.is_published) === 1 ? "" : "is-hidden"}`}>
                                            <div className="cf-move">
                                                <button type="button" onClick={() => move(f, -1)} disabled={i === 0} className="cf-iconbtn" title="Subir" aria-label="Subir"><IconChevronUp /></button>
                                                <button type="button" onClick={() => move(f, 1)} disabled={i === g.items.length - 1} className="cf-iconbtn" title="Bajar" aria-label="Bajar"><IconChevronDown /></button>
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <p className="cf-faq-q">{f.question}</p>
                                                <p className="cf-faq-a">{f.answer}</p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => toggle(f)}
                                                className={`cf-pill ${Number(f.is_published) === 1 ? "is-on" : "is-off"}`}
                                                title={Number(f.is_published) === 1 ? "Clic para ocultar" : "Clic para publicar"}
                                            >
                                                {Number(f.is_published) === 1 ? "Publicada" : "Oculta"}
                                            </button>
                                            <button type="button" onClick={() => openEdit(f)} className="cf-iconbtn" title="Editar" aria-label="Editar"><IconPen /></button>
                                            <button type="button" onClick={() => remove(f)} className="cf-iconbtn is-danger" title="Eliminar" aria-label="Eliminar"><IconX /></button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* how to render on the public site */}
            <div className="cf-card-item">
                <h2 className="cf-card-title"><IconHelp /> Cómo mostrarlas en tu sitio</h2>
                <p className="cf-prose">
                    En el editor visual, agrega el bloque <strong>Faq</strong>: renderiza estas preguntas como un
                    acordeón filtrable por categoría e incluye datos estructurados <strong>FAQPage (JSON-LD)</strong>,
                    lo que permite que Google muestre tus preguntas como resultados enriquecidos en el buscador —
                    a diferencia del bloque estático "Accordion" del núcleo, que no aporta ese marcado SEO.
                </p>
            </div>

            {/* create/edit modal: glass sheet */}
            {modalOpen && (
                <div className="cf-overlay" onClick={() => !busy && setModalOpen(false)}>
                    <form
                        onSubmit={save}
                        onClick={(e) => e.stopPropagation()}
                        className="cf-letter"
                        role="dialog"
                        aria-modal="true"
                        aria-label={form.id ? "Editar pregunta" : "Nueva pregunta"}
                    >
                        <div className="cf-letter-body">
                            <h2 className="cf-editor-title">
                                <IconPen />
                                {form.id ? "Editar pregunta" : "Nueva pregunta"}
                            </h2>
                            <div style={{ display: "grid", gap: "1.05rem" }}>
                                <div>
                                    <label className="cf-label" htmlFor="fq-question">Pregunta</label>
                                    <input
                                        id="fq-question"
                                        type="text"
                                        value={form.question}
                                        onChange={(e) => setForm({ ...form, question: e.target.value })}
                                        placeholder="¿Cómo puedo…?"
                                        className="cf-input"
                                        maxLength={500}
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="fq-answer">Respuesta</label>
                                    <textarea
                                        id="fq-answer"
                                        value={form.answer}
                                        onChange={(e) => setForm({ ...form, answer: e.target.value })}
                                        placeholder="Escribe la respuesta (texto plano; los saltos de línea se respetan)"
                                        className="cf-input"
                                        maxLength={10000}
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="fq-category">Categoría (opcional)</label>
                                    <input
                                        id="fq-category"
                                        type="text"
                                        value={form.category}
                                        onChange={(e) => setForm({ ...form, category: e.target.value })}
                                        placeholder="General, Envíos, Pagos…"
                                        className="cf-input"
                                        maxLength={120}
                                        list="wjfq-categorias"
                                    />
                                    <datalist id="wjfq-categorias">
                                        {categories.map((c) => <option key={c} value={c} />)}
                                    </datalist>
                                </div>
                                {modalError && <div role="alert" className="cf-flash is-error" style={{ marginBottom: 0 }}>{modalError}</div>}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.4rem" }}>
                                <button type="button" onClick={() => setModalOpen(false)} disabled={busy} className="cf-btn-ghost">
                                    Cancelar
                                </button>
                                <button type="submit" disabled={busy} className="cf-btn">
                                    {busy ? "Guardando…" : "Guardar"}
                                </button>
                            </div>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}

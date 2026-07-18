// @ts-nocheck
"use client";

/**
 * Admin page for the FAQ plugin (/admin/plugin/faq).
 * Lists the questions grouped by category with publish toggles, up/down reordering,
 * edit/delete, and a create/edit modal. API calls go through the host's api helpers
 * (session cookie). All user-facing text in Spanish.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const iconBtnCls = "w-8 h-8 flex items-center justify-center rounded-xl text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-all disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400";

const EMPTY_FORM = { id: null, question: "", answer: "", category: "" };

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
        <div className="max-w-4xl mx-auto p-4 sm:p-8">
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">FAQ</h1>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                        Preguntas frecuentes por categoría → bloque acordeón con SEO
                    </p>
                </div>
                <button type="button" onClick={openNew} className={btnCls}>+ Nueva pregunta</button>
            </div>

            {message && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-6 ${/Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                    {message}
                </div>
            )}

            <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 mb-8">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                    <h2 className="font-bold text-gray-800">Preguntas</h2>
                    <span className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
                        {total} pregunta{total === 1 ? "" : "s"} · {groups.filter((g) => g.category).length} categoría{groups.filter((g) => g.category).length === 1 ? "" : "s"}
                    </span>
                </div>

                {faqs === null ? (
                    <p className="text-sm text-gray-400">Cargando…</p>
                ) : total === 0 ? (
                    <p className="text-sm text-gray-400">No hay preguntas todavía — crea la primera con "Nueva pregunta".</p>
                ) : (
                    <div className="space-y-6">
                        {groups.map((g) => (
                            <div key={g.category || "__none__"}>
                                <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                                    {g.category || "Sin categoría"}
                                </h3>
                                <ul className="divide-y divide-gray-50 border border-gray-100 rounded-2xl overflow-hidden">
                                    {g.items.map((f, i) => (
                                        <li key={f.id} className="flex items-center gap-2 px-3 sm:px-4 py-3 bg-white">
                                            <div className="flex flex-col">
                                                <button type="button" onClick={() => move(f, -1)} disabled={i === 0} className={iconBtnCls} title="Subir" aria-label="Subir">▲</button>
                                                <button type="button" onClick={() => move(f, 1)} disabled={i === g.items.length - 1} className={iconBtnCls} title="Bajar" aria-label="Bajar">▼</button>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className={`font-semibold text-sm truncate ${Number(f.is_published) === 1 ? "text-gray-900" : "text-gray-400"}`}>{f.question}</p>
                                                <p className="text-[11px] text-gray-400 truncate">{f.answer}</p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => toggle(f)}
                                                className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${Number(f.is_published) === 1 ? "bg-green-50 text-green-700 hover:bg-green-100" : "bg-gray-100 text-gray-400 hover:bg-gray-200"}`}
                                                title={Number(f.is_published) === 1 ? "Clic para ocultar" : "Clic para publicar"}
                                            >
                                                {Number(f.is_published) === 1 ? "Publicada" : "Oculta"}
                                            </button>
                                            <button type="button" onClick={() => openEdit(f)} className={iconBtnCls} title="Editar" aria-label="Editar">✎</button>
                                            <button type="button" onClick={() => remove(f)} className={`${iconBtnCls} hover:text-red-600 hover:bg-red-50`} title="Eliminar" aria-label="Eliminar">✕</button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8">
                <h2 className="font-bold text-gray-800 mb-2">Cómo mostrarlas en tu sitio</h2>
                <p className="text-[13px] text-gray-500 leading-relaxed">
                    En el editor visual, agrega el bloque <strong>Faq</strong>: renderiza estas preguntas como un
                    acordeón filtrable por categoría e incluye datos estructurados <strong>FAQPage (JSON-LD)</strong>,
                    lo que permite que Google muestre tus preguntas como resultados enriquecidos en el buscador —
                    a diferencia del bloque estático "Accordion" del núcleo, que no aporta ese marcado SEO.
                </p>
            </div>

            {modalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50" onClick={() => !busy && setModalOpen(false)}>
                    <form
                        onSubmit={save}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-6 sm:p-8 space-y-5 max-h-[90vh] overflow-y-auto"
                    >
                        <h2 className="text-xl font-black text-gray-900 italic tracking-tighter">
                            {form.id ? "Editar pregunta" : "Nueva pregunta"}
                        </h2>
                        <div>
                            <label className={labelCls}>Pregunta</label>
                            <input
                                type="text"
                                value={form.question}
                                onChange={(e) => setForm({ ...form, question: e.target.value })}
                                placeholder="¿Cómo puedo…?"
                                className={inputCls}
                                maxLength={500}
                                required
                            />
                        </div>
                        <div>
                            <label className={labelCls}>Respuesta</label>
                            <textarea
                                value={form.answer}
                                onChange={(e) => setForm({ ...form, answer: e.target.value })}
                                placeholder="Escribe la respuesta (texto plano; los saltos de línea se respetan)"
                                className={`${inputCls} min-h-[140px] resize-y`}
                                maxLength={10000}
                                required
                            />
                        </div>
                        <div>
                            <label className={labelCls}>Categoría (opcional)</label>
                            <input
                                type="text"
                                value={form.category}
                                onChange={(e) => setForm({ ...form, category: e.target.value })}
                                placeholder="General, Envíos, Pagos…"
                                className={inputCls}
                                maxLength={120}
                                list="wjfq-categorias"
                            />
                            <datalist id="wjfq-categorias">
                                {categories.map((c) => <option key={c} value={c} />)}
                            </datalist>
                        </div>
                        {modalError && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{modalError}</div>}
                        <div className="flex items-center justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setModalOpen(false)}
                                disabled={busy}
                                className="px-5 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50"
                            >
                                Cancelar
                            </button>
                            <button type="submit" disabled={busy} className={btnCls}>
                                {busy ? "Guardando…" : "Guardar"}
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}

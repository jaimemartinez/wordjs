// @ts-nocheck
"use client";

/**
 * Admin page for the Polls plugin (/admin/plugin/polls).
 * Lists every poll (status pill, total votes, inline mini result bars) with open/close, edit and
 * delete actions, plus a create/edit modal (question, dynamic option rows, results-visibility).
 * API calls go through the host's api helpers (session cookie).
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-5 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";

const SHOW_RESULTS_LABELS = { after: "Tras votar", always: "Siempre", never: "Nunca" };
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12;

// Module-level (never define a component inside a component — remounting steals input focus).
function MiniBars({ poll }) {
    const total = Number(poll.total) || 0;
    return (
        <div className="space-y-1.5 mt-3">
            {(poll.options || []).map((o) => {
                const count = Number((poll.results || {})[o.id]) || 0;
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                return (
                    <div key={o.id} className="flex items-center gap-2">
                        <span className="text-[11px] text-gray-500 w-32 sm:w-44 truncate" title={o.label}>{o.label}</span>
                        <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: pct + "%" }} />
                        </div>
                        <span className="text-[11px] text-gray-400 tabular-nums w-16 text-right">{pct}% ({count})</span>
                    </div>
                );
            })}
        </div>
    );
}

function PollModal({ initial, onClose, onSaved }) {
    const [question, setQuestion] = useState(initial ? initial.question : "");
    const [options, setOptions] = useState(() => {
        if (initial && Array.isArray(initial.options) && initial.options.length >= MIN_OPTIONS) {
            return initial.options.map((o) => ({ id: o.id, label: o.label }));
        }
        return [{ label: "" }, { label: "" }];
    });
    const [showResults, setShowResults] = useState(initial ? initial.show_results : "after");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const setOptionLabel = (index, label) => {
        setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, label } : o)));
    };
    const addOption = () => {
        setOptions((prev) => (prev.length >= MAX_OPTIONS ? prev : [...prev, { label: "" }]));
    };
    const removeOption = (index) => {
        setOptions((prev) => (prev.length <= MIN_OPTIONS ? prev : prev.filter((_, i) => i !== index)));
    };

    const save = async (e) => {
        e.preventDefault();
        setError("");
        const q = question.trim();
        if (!q) { setError("La pregunta es obligatoria."); return; }
        const cleaned = options.map((o) => ({ id: o.id, label: String(o.label || "").trim() }));
        if (cleaned.some((o) => !o.label)) { setError("Todas las opciones deben tener texto."); return; }
        if (cleaned.length < MIN_OPTIONS) { setError(`Se necesitan al menos ${MIN_OPTIONS} opciones.`); return; }
        setBusy(true);
        try {
            const body = { question: q, options: cleaned, show_results: showResults };
            if (initial && initial.id) body.id = initial.id;
            await apiPost("/plugin/polls/save", body);
            onSaved();
        } catch (err) {
            setError(err?.message || "No se pudo guardar la encuesta.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <form onSubmit={save} className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 sm:p-8 space-y-5">
                <h2 className="text-xl font-black text-gray-900 italic tracking-tighter">
                    {initial && initial.id ? "Editar encuesta" : "Nueva encuesta"}
                </h2>

                <div>
                    <label className={labelCls}>Pregunta</label>
                    <input type="text" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="¿Cuál es tu opción favorita?" className={inputCls} required />
                </div>

                <div>
                    <label className={labelCls}>Opciones ({options.length}/{MAX_OPTIONS})</label>
                    <div className="space-y-2">
                        {options.map((o, i) => (
                            <div key={o.id != null ? "opt-" + o.id : "new-" + i} className="flex items-center gap-2">
                                <input
                                    type="text"
                                    value={o.label}
                                    onChange={(e) => setOptionLabel(i, e.target.value)}
                                    placeholder={"Opción " + (i + 1)}
                                    className={inputCls}
                                />
                                <button
                                    type="button"
                                    onClick={() => removeOption(i)}
                                    disabled={options.length <= MIN_OPTIONS}
                                    className="shrink-0 w-10 h-10 rounded-xl bg-gray-100 hover:bg-red-100 hover:text-red-600 text-gray-400 font-black transition-all disabled:opacity-30 disabled:hover:bg-gray-100 disabled:hover:text-gray-400"
                                    title="Quitar opción"
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                    {options.length < MAX_OPTIONS && (
                        <button type="button" onClick={addOption} className="mt-2 text-xs font-black uppercase tracking-widest text-blue-600 hover:text-blue-800 transition-colors">
                            + Agregar opción
                        </button>
                    )}
                    {initial && initial.id ? (
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                            Al editar se conservan los votos de las opciones existentes; quitar una opción no borra sus votos.
                        </p>
                    ) : null}
                </div>

                <div>
                    <label className={labelCls}>Mostrar resultados</label>
                    <select value={showResults} onChange={(e) => setShowResults(e.target.value)} className={inputCls}>
                        <option value="after">{SHOW_RESULTS_LABELS.after}</option>
                        <option value="always">{SHOW_RESULTS_LABELS.always}</option>
                        <option value="never">{SHOW_RESULTS_LABELS.never}</option>
                    </select>
                </div>

                {error && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{error}</div>}

                <div className="flex items-center justify-end gap-3 pt-1">
                    <button type="button" onClick={onClose} disabled={busy} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </div>
    );
}

export default function PollsAdminPage() {
    const [polls, setPolls] = useState(null); // null = loading
    const [modal, setModal] = useState(null); // null = closed, {} = new, {poll} = edit
    const [message, setMessage] = useState("");
    const [busyId, setBusyId] = useState(null);

    const load = async () => {
        try {
            setPolls(await api("/plugin/polls/list"));
        } catch (err) {
            setPolls([]);
            setMessage(`Error al cargar: ${err?.message || err}`);
        }
    };
    useEffect(() => { load(); }, []);

    const toggle = async (poll) => {
        setBusyId(poll.id); setMessage("");
        try {
            await apiPost(`/plugin/polls/${poll.id}/toggle`, {});
            await load();
        } catch (err) {
            setMessage(`Error: ${err?.message || err}`);
        } finally {
            setBusyId(null);
        }
    };

    const remove = async (poll) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Eliminar la encuesta "${poll.question}" y todos sus votos? Esta acción no se puede deshacer.`)) return;
        setBusyId(poll.id); setMessage("");
        try {
            await apiDelete(`/plugin/polls/${poll.id}`);
            await load();
        } catch (err) {
            setMessage(`Error: ${err?.message || err}`);
        } finally {
            setBusyId(null);
        }
    };

    return (
        <div className="max-w-3xl mx-auto p-4 sm:p-8">
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Encuestas</h1>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                        Crea encuestas y publícalas con el bloque Polls del editor visual
                    </p>
                </div>
                <button type="button" onClick={() => setModal({})} className={btnCls}>+ Nueva encuesta</button>
            </div>

            {message && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600 mb-6">{message}</div>}

            {polls === null ? (
                <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-8 text-sm text-gray-400">Cargando…</div>
            ) : polls.length === 0 ? (
                <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-8 text-center">
                    <p className="text-sm text-gray-400">Todavía no hay encuestas. Crea la primera con "Nueva encuesta".</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {polls.map((p) => (
                        <div key={p.id} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-7">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <h2 className="font-bold text-gray-800 break-words">{p.question}</h2>
                                        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest ${Number(p.is_open) ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                                            {Number(p.is_open) ? "Abierta" : "Cerrada"}
                                        </span>
                                    </div>
                                    <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mt-1">
                                        {p.total} {p.total === 1 ? "voto" : "votos"} · Resultados: {SHOW_RESULTS_LABELS[p.show_results] || SHOW_RESULTS_LABELS.after}
                                    </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <button type="button" onClick={() => toggle(p)} disabled={busyId === p.id} className="px-3.5 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50">
                                        {Number(p.is_open) ? "Cerrar" : "Abrir"}
                                    </button>
                                    <button type="button" onClick={() => setModal(p)} disabled={busyId === p.id} className="px-3.5 py-2 bg-gray-100 hover:bg-blue-100 hover:text-blue-700 text-gray-700 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50">
                                        Editar
                                    </button>
                                    <button type="button" onClick={() => remove(p)} disabled={busyId === p.id} className="px-3.5 py-2 bg-gray-100 hover:bg-red-100 hover:text-red-600 text-gray-700 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50">
                                        Eliminar
                                    </button>
                                </div>
                            </div>
                            <MiniBars poll={p} />
                            <p className="text-[11px] text-gray-400 mt-4">
                                Usa el bloque <strong>Polls</strong> con el ID <strong>{p.id}</strong>.
                            </p>
                        </div>
                    ))}
                </div>
            )}

            {modal !== null && (
                <PollModal
                    key={modal.id != null ? "edit-" + modal.id : "new"}
                    initial={modal.id != null ? modal : null}
                    onClose={() => setModal(null)}
                    onSaved={() => { setModal(null); load(); }}
                />
            )}
        </div>
    );
}

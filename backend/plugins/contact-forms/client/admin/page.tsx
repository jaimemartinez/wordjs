// @ts-nocheck
"use client";

/**
 * Admin page for the Contact Forms plugin (/admin/plugin/contact-forms).
 * Two panes (tabs): the form builder (create/edit/delete forms with a custom-field list) and the
 * submissions inbox (per-form filter, mark-read on open, delete, CSV export). The CSV export comes
 * back as JSON ({csv, filename}) because the isolate cannot stream raw text bodies — the Blob
 * download is built here on the client.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50";
const btnDangerCls = "px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50";

const FIELD_TYPE_OPTIONS = [
    { value: "text", label: "Texto" },
    { value: "email", label: "Correo" },
    { value: "tel", label: "Teléfono" },
    { value: "number", label: "Número" },
    { value: "textarea", label: "Área de texto" },
    { value: "select", label: "Lista desplegable" },
];

const LIMIT = 50;

// Field names are generated ONCE when a field is added and stay stable across label edits, so
// existing submissions keep matching their columns.
const newFieldName = () => "f_" + Math.random().toString(36).slice(2, 8);

const emptyDraft = () => ({ id: null, name: "", notify_email: "", success_message: "", fields: [] });

// SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS" — normalize before Date parsing.
const fmtDate = (v) => {
    if (!v) return "";
    const s = String(v);
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? s : d.toLocaleString();
};

export default function ContactFormsAdminPage() {
    const [forms, setForms] = useState([]);
    const [tab, setTab] = useState("forms"); // forms | inbox
    const [editing, setEditing] = useState(null); // null | draft object
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    const [filterFormId, setFilterFormId] = useState("");
    const [submissions, setSubmissions] = useState([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [selected, setSelected] = useState(null); // submission open in the modal

    const formsById = useMemo(() => {
        const m = {};
        for (const f of forms) m[f.id] = f;
        return m;
    }, [forms]);
    const totalUnread = useMemo(
        () => forms.reduce((acc, f) => acc + (Number(f.unread_count) || 0), 0),
        [forms]
    );

    const loadForms = async () => {
        try {
            const data = await api("/plugin/contact-forms/forms");
            setForms(data.forms || []);
        } catch (err) {
            setMessage(`Error al cargar los formularios: ${err?.message || err}`);
        }
    };

    const loadSubmissions = async (formId, off) => {
        try {
            const p = new URLSearchParams();
            if (formId) p.set("form_id", String(formId));
            p.set("limit", String(LIMIT));
            p.set("offset", String(off));
            const data = await api(`/plugin/contact-forms/submissions?${p.toString()}`);
            setSubmissions(data.submissions || []);
            setTotal(data.total || 0);
        } catch (err) {
            setMessage(`Error al cargar los mensajes: ${err?.message || err}`);
        }
    };

    useEffect(() => { loadForms(); }, []);
    useEffect(() => {
        if (tab === "inbox") loadSubmissions(filterFormId, offset);
    }, [tab, filterFormId, offset]);

    // ---- form editor helpers ----------------------------------------------------------------------
    const patchField = (idx, patch) => setEditing((prev) => ({
        ...prev,
        fields: prev.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    }));
    const addField = () => setEditing((prev) => ({
        ...prev,
        fields: [...prev.fields, { name: newFieldName(), label: "", type: "text", options: "", required: 0, width: 100 }],
    }));
    const removeField = (idx) => setEditing((prev) => ({
        ...prev,
        fields: prev.fields.filter((_, i) => i !== idx),
    }));
    const moveField = (idx, dir) => setEditing((prev) => {
        const j = idx + dir;
        if (j < 0 || j >= prev.fields.length) return prev;
        const fields = [...prev.fields];
        const tmp = fields[idx];
        fields[idx] = fields[j];
        fields[j] = tmp;
        return { ...prev, fields };
    });

    const saveForm = async (e) => {
        e.preventDefault();
        if (!editing) return;
        if (!editing.name.trim()) {
            setMessage("El nombre del formulario es obligatorio.");
            return;
        }
        if (editing.fields.some((f) => !String(f.label || "").trim())) {
            setMessage("Todos los campos necesitan una etiqueta.");
            return;
        }
        setBusy(true);
        setMessage("");
        try {
            const body = {
                name: editing.name,
                notify_email: editing.notify_email,
                success_message: editing.success_message,
                fields: editing.fields,
            };
            if (editing.id) body.id = editing.id;
            const data = await apiPost("/plugin/contact-forms/forms", body);
            setEditing(null);
            setMessage(`Formulario guardado (ID ${data.form.id}).`);
            loadForms();
        } catch (err) {
            setMessage(`Error al guardar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const deleteForm = async (f) => {
        if (!window.confirm(`¿Eliminar el formulario "${f.name}" y todos sus mensajes? Esta acción no se puede deshacer.`)) return;
        setBusy(true);
        setMessage("");
        try {
            await apiDelete(`/plugin/contact-forms/forms/${f.id}`);
            if (String(filterFormId) === String(f.id)) setFilterFormId("");
            if (editing && editing.id === f.id) setEditing(null);
            setMessage(`Formulario "${f.name}" eliminado.`);
            loadForms();
        } catch (err) {
            setMessage(`Error al eliminar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    // ---- inbox helpers ------------------------------------------------------------------------------
    const openSubmission = async (s) => {
        setSelected(s);
        if (!s.is_read) {
            try {
                await apiPost(`/plugin/contact-forms/submissions/${s.id}/read`, {});
                setSubmissions((prev) => prev.map((x) => (x.id === s.id ? { ...x, is_read: 1 } : x)));
                setSelected((prev) => (prev && prev.id === s.id ? { ...prev, is_read: 1 } : prev));
                loadForms(); // refresh unread badges
            } catch {
                // Non-fatal: the modal still opens; the badge just stays.
            }
        }
    };

    const deleteSubmission = async (id) => {
        if (!window.confirm("¿Eliminar este mensaje? Esta acción no se puede deshacer.")) return;
        setBusy(true);
        try {
            await apiDelete(`/plugin/contact-forms/submissions/${id}`);
            if (selected && selected.id === id) setSelected(null);
            loadSubmissions(filterFormId, offset);
            loadForms();
        } catch (err) {
            setMessage(`Error al eliminar el mensaje: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const exportCsv = async () => {
        if (!filterFormId) {
            setMessage("Selecciona un formulario para exportar sus mensajes.");
            return;
        }
        setBusy(true);
        setMessage("");
        try {
            const data = await api(`/plugin/contact-forms/submissions/export?form_id=${filterFormId}`);
            const blob = new Blob([data.csv || ""], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = data.filename || "envios.csv";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            setMessage(`Exportados ${data.count} mensajes.`);
        } catch (err) {
            setMessage(`Error al exportar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    // First non-empty values, in the form's field order, for the table preview cell.
    const previewOf = (s) => {
        const form = formsById[s.form_id];
        const data = s.data || {};
        let vals = [];
        if (form && Array.isArray(form.fields)) {
            vals = form.fields.map((f) => data[f.name]).filter((v) => v != null && String(v).trim() !== "");
        }
        if (vals.length === 0) {
            vals = Object.values(data).filter((v) => v != null && String(v).trim() !== "");
        }
        return vals.slice(0, 3).map((v) => String(v).slice(0, 60)).join(" · ");
    };

    // label→value rows for the modal: the form's fields in order, then any leftover raw keys.
    const detailRows = (s) => {
        const form = formsById[s.form_id];
        const data = s.data || {};
        const rows = [];
        const seen = new Set();
        if (form && Array.isArray(form.fields)) {
            for (const f of form.fields) {
                seen.add(f.name);
                rows.push({ key: f.name, label: f.label, value: data[f.name] });
            }
        }
        for (const k of Object.keys(data)) {
            if (!seen.has(k)) rows.push({ key: k, label: k, value: data[k] });
        }
        return rows;
    };

    const pageCount = Math.max(1, Math.ceil(total / LIMIT));
    const page = Math.floor(offset / LIMIT) + 1;

    return (
        <div className="max-w-5xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Formularios de contacto</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Crea formularios, insértalos con el bloque "ContactForms" y recibe los mensajes aquí
                </p>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6">
                <button
                    type="button"
                    onClick={() => setTab("forms")}
                    className={`px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${tab === "forms" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                >
                    Formularios
                </button>
                <button
                    type="button"
                    onClick={() => { setTab("inbox"); setOffset(0); }}
                    className={`px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 ${tab === "inbox" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                >
                    Bandeja de entrada
                    {totalUnread > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[10px] font-black">
                            {totalUnread}
                        </span>
                    )}
                </button>
            </div>

            {message && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-6 ${/Error|obligatorio|inválido|Selecciona/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                    {message}
                </div>
            )}

            {/* ============================== FORMS TAB ============================== */}
            {tab === "forms" && (
                <div className="space-y-6">
                    {!editing && (
                        <div className="flex justify-end">
                            <button type="button" className={btnCls} onClick={() => { setMessage(""); setEditing(emptyDraft()); }}>
                                + Nuevo formulario
                            </button>
                        </div>
                    )}

                    {/* Editor */}
                    {editing && (
                        <form onSubmit={saveForm} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 space-y-5">
                            <h2 className="font-bold text-gray-800">
                                {editing.id ? `Editar formulario #${editing.id}` : "Nuevo formulario"}
                            </h2>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="md:col-span-2">
                                    <label className={labelCls}>Nombre del formulario</label>
                                    <input type="text" value={editing.name} onChange={(e) => setEditing((p) => ({ ...p, name: e.target.value }))} placeholder="Contacto general" className={inputCls} required />
                                </div>
                                <div>
                                    <label className={labelCls}>Correo de notificación (opcional)</label>
                                    <input type="email" value={editing.notify_email} onChange={(e) => setEditing((p) => ({ ...p, notify_email: e.target.value }))} placeholder="dueño@midominio.com" className={inputCls} />
                                    <p className="text-[11px] text-gray-400 mt-1">Si lo configuras, cada mensaje nuevo se envía a este correo (requiere proveedor de correo activo).</p>
                                </div>
                                <div>
                                    <label className={labelCls}>Mensaje de éxito (opcional)</label>
                                    <input type="text" value={editing.success_message} onChange={(e) => setEditing((p) => ({ ...p, success_message: e.target.value }))} placeholder="¡Mensaje enviado!" className={inputCls} />
                                </div>
                            </div>

                            {/* Field builder */}
                            <div>
                                <div className="flex items-center justify-between mb-3">
                                    <label className={labelCls + " mb-0"}>Campos del formulario</label>
                                    <button type="button" className={btnGhostCls} onClick={addField}>+ Agregar campo</button>
                                </div>
                                {editing.fields.length === 0 ? (
                                    <p className="text-sm text-gray-400 border border-dashed border-gray-200 rounded-2xl px-4 py-6 text-center">
                                        Sin campos todavía — agrega al menos uno (por ejemplo: Nombre, Correo, Mensaje).
                                    </p>
                                ) : (
                                    <div className="space-y-3">
                                        {editing.fields.map((f, idx) => (
                                            <div key={f.name} className="border border-gray-100 rounded-2xl p-4 bg-gray-50/40">
                                                <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                                                    <div className="md:col-span-4">
                                                        <label className={labelCls}>Etiqueta</label>
                                                        <input type="text" value={f.label} onChange={(e) => patchField(idx, { label: e.target.value })} placeholder="Nombre completo" className={inputCls} />
                                                    </div>
                                                    <div className="md:col-span-3">
                                                        <label className={labelCls}>Tipo</label>
                                                        <select value={f.type} onChange={(e) => patchField(idx, { type: e.target.value })} className={inputCls}>
                                                            {FIELD_TYPE_OPTIONS.map((o) => (
                                                                <option key={o.value} value={o.value}>{o.label}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                    <div className="md:col-span-2">
                                                        <label className={labelCls}>Ancho</label>
                                                        <select value={String(f.width)} onChange={(e) => patchField(idx, { width: Number(e.target.value) })} className={inputCls}>
                                                            <option value="100">100%</option>
                                                            <option value="50">50%</option>
                                                        </select>
                                                    </div>
                                                    <div className="md:col-span-3 flex items-center justify-between gap-2 pb-2">
                                                        <label className="flex items-center gap-2 text-xs font-bold text-gray-600 cursor-pointer select-none">
                                                            <input type="checkbox" checked={!!f.required} onChange={(e) => patchField(idx, { required: e.target.checked ? 1 : 0 })} />
                                                            Obligatorio
                                                        </label>
                                                        <div className="flex gap-1">
                                                            <button type="button" title="Subir" disabled={idx === 0} onClick={() => moveField(idx, -1)} className="w-8 h-8 rounded-lg bg-white border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-30 font-bold">↑</button>
                                                            <button type="button" title="Bajar" disabled={idx === editing.fields.length - 1} onClick={() => moveField(idx, 1)} className="w-8 h-8 rounded-lg bg-white border border-gray-200 text-gray-500 hover:bg-gray-100 disabled:opacity-30 font-bold">↓</button>
                                                            <button type="button" title="Eliminar campo" onClick={() => removeField(idx)} className="w-8 h-8 rounded-lg bg-red-50 border border-red-100 text-red-500 hover:bg-red-100 font-bold">×</button>
                                                        </div>
                                                    </div>
                                                    {f.type === "select" && (
                                                        <div className="md:col-span-12">
                                                            <label className={labelCls}>Opciones (separadas por coma)</label>
                                                            <input type="text" value={f.options} onChange={(e) => patchField(idx, { options: e.target.value })} placeholder="Opción 1, Opción 2, Opción 3" className={inputCls} />
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="flex flex-wrap items-center gap-3 justify-end">
                                <button type="button" className={btnGhostCls} onClick={() => setEditing(null)} disabled={busy}>Cancelar</button>
                                <button type="submit" className={btnCls} disabled={busy}>{busy ? "Guardando…" : "Guardar formulario"}</button>
                            </div>
                        </form>
                    )}

                    {/* Forms list */}
                    {forms.length === 0 && !editing ? (
                        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-10 text-center">
                            <p className="text-sm text-gray-400">
                                Sin formularios todavía — crea el primero con "Nuevo formulario".
                            </p>
                        </div>
                    ) : (
                        forms.map((f) => (
                            <div key={f.id} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <h3 className="font-bold text-gray-900 truncate">{f.name}</h3>
                                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">ID {f.id}</span>
                                            {Number(f.unread_count) > 0 && (
                                                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[10px] font-black">
                                                    {f.unread_count} sin leer
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-gray-400 mt-1">
                                            {(f.fields || []).length} campos · {f.submission_count || 0} mensajes
                                            {f.notify_email ? ` · notifica a ${f.notify_email}` : ""}
                                        </p>
                                        <p className="text-[11px] text-gray-400 mt-2 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 inline-block">
                                            Usa el bloque <strong>"ContactForms"</strong> en el editor visual con el ID <strong>{f.id}</strong>
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <button type="button" className={btnGhostCls} onClick={() => { setMessage(""); setEditing({ id: f.id, name: f.name || "", notify_email: f.notify_email || "", success_message: f.success_message || "", fields: (f.fields || []).map((x) => ({ ...x })) }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                                            Editar
                                        </button>
                                        <button type="button" className={btnGhostCls} onClick={() => { setFilterFormId(String(f.id)); setOffset(0); setTab("inbox"); }}>
                                            Mensajes
                                        </button>
                                        <button type="button" className={btnDangerCls} onClick={() => deleteForm(f)} disabled={busy}>
                                            Eliminar
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            )}

            {/* ============================== INBOX TAB ============================== */}
            {tab === "inbox" && (
                <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                        <div className="flex items-center gap-3">
                            <label className={labelCls + " mb-0"}>Formulario</label>
                            <select
                                value={filterFormId}
                                onChange={(e) => { setFilterFormId(e.target.value); setOffset(0); }}
                                className="px-4 py-2.5 bg-gray-50/60 border-2 border-gray-100 rounded-2xl outline-none font-medium text-sm"
                            >
                                <option value="">Todos los formularios</option>
                                {forms.map((f) => (
                                    <option key={f.id} value={String(f.id)}>
                                        {f.name}{Number(f.unread_count) > 0 ? ` (${f.unread_count} sin leer)` : ""}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <button type="button" className={btnCls} onClick={exportCsv} disabled={busy || !filterFormId} title={filterFormId ? "Descargar CSV" : "Selecciona un formulario primero"}>
                            Exportar CSV
                        </button>
                    </div>

                    {submissions.length === 0 ? (
                        <p className="text-sm text-gray-400 border border-dashed border-gray-200 rounded-2xl px-4 py-8 text-center">
                            Sin mensajes todavía.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="py-3 pr-3 w-4"></th>
                                        <th className="py-3 pr-4 whitespace-nowrap">Fecha</th>
                                        {!filterFormId && <th className="py-3 pr-4">Formulario</th>}
                                        <th className="py-3 pr-4">Vista previa</th>
                                        <th className="py-3 pr-4">Página</th>
                                        <th className="py-3 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {submissions.map((s) => (
                                        <tr
                                            key={s.id}
                                            onClick={() => openSubmission(s)}
                                            className={`border-b border-gray-50 cursor-pointer hover:bg-blue-50/40 transition ${s.is_read ? "text-gray-500" : "font-semibold text-gray-900"}`}
                                        >
                                            <td className="py-3 pr-3">
                                                {!s.is_read && <span className="inline-block w-2 h-2 rounded-full bg-blue-500" title="Sin leer"></span>}
                                            </td>
                                            <td className="py-3 pr-4 whitespace-nowrap">{fmtDate(s.created_at)}</td>
                                            {!filterFormId && (
                                                <td className="py-3 pr-4 whitespace-nowrap">{formsById[s.form_id]?.name || `#${s.form_id}`}</td>
                                            )}
                                            <td className="py-3 pr-4 max-w-[320px] truncate">{previewOf(s) || <span className="text-gray-300">(vacío)</span>}</td>
                                            <td className="py-3 pr-4 max-w-[180px] truncate text-gray-400">{s.page_url || ""}</td>
                                            <td className="py-3 text-right">
                                                <button
                                                    type="button"
                                                    title="Eliminar mensaje"
                                                    onClick={(e) => { e.stopPropagation(); deleteSubmission(s.id); }}
                                                    className="w-8 h-8 rounded-lg bg-red-50 border border-red-100 text-red-500 hover:bg-red-100 font-bold"
                                                >
                                                    ×
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {total > LIMIT && (
                        <div className="flex items-center justify-between mt-5">
                            <button type="button" className={btnGhostCls} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
                                ← Anterior
                            </button>
                            <span className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
                                Página {page} de {pageCount} · {total} mensajes
                            </span>
                            <button type="button" className={btnGhostCls} disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>
                                Siguiente →
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* ============================== SUBMISSION MODAL ============================== */}
            {selected && (
                <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
                    <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6 sm:p-8" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-start justify-between gap-3 mb-4">
                            <div>
                                <h3 className="font-black text-gray-900">Mensaje #{selected.id}</h3>
                                <p className="text-xs text-gray-400 mt-0.5">
                                    {formsById[selected.form_id]?.name || `Formulario #${selected.form_id}`} · {fmtDate(selected.created_at)}
                                </p>
                            </div>
                            <button type="button" onClick={() => setSelected(null)} className="w-9 h-9 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-500 font-bold shrink-0">✕</button>
                        </div>

                        <dl className="space-y-3">
                            {detailRows(selected).map((row) => (
                                <div key={row.key} className="border border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/40">
                                    <dt className="text-[10px] font-black uppercase tracking-widest text-gray-400">{row.label}</dt>
                                    <dd className="text-sm text-gray-800 mt-1 whitespace-pre-wrap break-words">
                                        {row.value == null || String(row.value).trim() === "" ? <span className="text-gray-300">(vacío)</span> : String(row.value)}
                                    </dd>
                                </div>
                            ))}
                        </dl>

                        {selected.page_url && (
                            <p className="text-[11px] text-gray-400 mt-4 break-all">
                                Enviado desde: {selected.page_url}
                            </p>
                        )}

                        <div className="flex justify-end gap-2 mt-6">
                            <button type="button" className={btnDangerCls} onClick={() => deleteSubmission(selected.id)} disabled={busy}>
                                Eliminar mensaje
                            </button>
                            <button type="button" className={btnGhostCls} onClick={() => setSelected(null)}>Cerrar</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// @ts-nocheck
"use client";

/**
 * Admin page for the Contact Forms plugin (/admin/plugin/contact-forms).
 * Two panes (tabs): the form builder (create/edit/delete forms with a custom-field list) and the
 * submissions inbox (per-form filter, mark-read on open, delete, CSV export). The CSV export comes
 * back as JSON ({csv, filename}) because the isolate cannot stream raw text bodies — the Blob
 * download is built here on the client.
 *
 * Visual identity ("correspondencia postal") lives in the plugin's OWN stylesheet
 * (client/admin/admin.css, injected by the host admin shell and scoped to
 * .plugin-admin-contact-forms) — the markup below only uses cf-* classes.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

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

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconEnvelope = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m22 7-10 6L2 7" />
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
const IconDownload = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
        <path d="M12 15V3" />
    </svg>
);
const IconInboxEmpty = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
);

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
    const isErrorMsg = /Error|obligatorio|inválido|Selecciona|necesitan/i.test(message);

    return (
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconEnvelope /></div>
                <div>
                    <h1 className="cf-title">Formularios de contacto</h1>
                    <p className="cf-subtitle">Crea formularios · insértalos con el bloque «ContactForms» · recibe el correo aquí</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "forms"}
                    onClick={() => setTab("forms")}
                    className={`cf-tab ${tab === "forms" ? "is-active" : ""}`}
                >
                    Formularios
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "inbox"}
                    onClick={() => { setTab("inbox"); setOffset(0); }}
                    className={`cf-tab ${tab === "inbox" ? "is-active" : ""}`}
                >
                    Bandeja de entrada
                    {totalUnread > 0 && <span className="cf-badge">{totalUnread}</span>}
                </button>
            </div>

            {message && (
                <div role={isErrorMsg ? "alert" : "status"} className={`cf-flash ${isErrorMsg ? "is-error" : "is-ok"}`}>
                    {message}
                </div>
            )}

            {/* ============================== FORMS TAB ============================== */}
            {tab === "forms" && (
                <div>
                    {!editing && (
                        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                            <button type="button" className="cf-btn" onClick={() => { setMessage(""); setEditing(emptyDraft()); }}>
                                <IconPlus /> Nuevo formulario
                            </button>
                        </div>
                    )}

                    {/* editor: the letter being written */}
                    {editing && (
                        <form onSubmit={saveForm} className="cf-editor">
                            <div className="cf-editor-body">
                                <h2 className="cf-editor-title">
                                    <IconPen />
                                    {editing.id ? `Editar formulario #${editing.id}` : "Nuevo formulario"}
                                </h2>
                                <div className="cf-grid">
                                    <div className="cf-span-2">
                                        <label className="cf-label" htmlFor="cf-name">Nombre del formulario</label>
                                        <input id="cf-name" type="text" value={editing.name} onChange={(e) => setEditing((p) => ({ ...p, name: e.target.value }))} placeholder="Contacto general" className="cf-input" required />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="cf-notify">Correo de notificación (opcional)</label>
                                        <input id="cf-notify" type="email" value={editing.notify_email} onChange={(e) => setEditing((p) => ({ ...p, notify_email: e.target.value }))} placeholder="dueño@midominio.com" className="cf-input" />
                                        <p className="cf-help">Si lo configuras, cada mensaje nuevo se envía a este correo (requiere proveedor de correo activo).</p>
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="cf-success">Mensaje de éxito (opcional)</label>
                                        <input id="cf-success" type="text" value={editing.success_message} onChange={(e) => setEditing((p) => ({ ...p, success_message: e.target.value }))} placeholder="¡Mensaje enviado!" className="cf-input" />
                                    </div>
                                </div>

                                {/* field builder: numbered postal stubs */}
                                <div style={{ marginTop: "1.5rem" }}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.9rem" }}>
                                        <span className="cf-label" style={{ marginBottom: 0 }}>Campos del formulario</span>
                                        <button type="button" className="cf-btn-ghost" onClick={addField}><IconPlus /> Agregar campo</button>
                                    </div>
                                    {editing.fields.length === 0 ? (
                                        <div className="cf-empty">
                                            <IconEnvelope />
                                            <span>Sin campos todavía — agrega al menos uno (por ejemplo: Nombre, Correo, Mensaje).</span>
                                        </div>
                                    ) : (
                                        <div>
                                            {editing.fields.map((f, idx) => (
                                                <div key={f.name} className="cf-field-row">
                                                    <span className="cf-field-num">Campo {String(idx + 1).padStart(2, "0")}</span>
                                                    <div className="cf-field-grid">
                                                        <div>
                                                            <label className="cf-label" htmlFor={`cf-fl-${f.name}`}>Etiqueta</label>
                                                            <input id={`cf-fl-${f.name}`} type="text" value={f.label} onChange={(e) => patchField(idx, { label: e.target.value })} placeholder="Nombre completo" className="cf-input" />
                                                        </div>
                                                        <div>
                                                            <label className="cf-label" htmlFor={`cf-ft-${f.name}`}>Tipo</label>
                                                            <select id={`cf-ft-${f.name}`} value={f.type} onChange={(e) => patchField(idx, { type: e.target.value })} className="cf-select">
                                                                {FIELD_TYPE_OPTIONS.map((o) => (
                                                                    <option key={o.value} value={o.value}>{o.label}</option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                        <div>
                                                            <label className="cf-label" htmlFor={`cf-fw-${f.name}`}>Ancho</label>
                                                            <select id={`cf-fw-${f.name}`} value={String(f.width)} onChange={(e) => patchField(idx, { width: Number(e.target.value) })} className="cf-select">
                                                                <option value="100">100%</option>
                                                                <option value="50">50%</option>
                                                            </select>
                                                        </div>
                                                        <div className="cf-field-actions">
                                                            <label className="cf-check">
                                                                <input type="checkbox" checked={!!f.required} onChange={(e) => patchField(idx, { required: e.target.checked ? 1 : 0 })} />
                                                                Obligatorio
                                                            </label>
                                                            <div style={{ display: "flex", gap: "0.35rem" }}>
                                                                <button type="button" title="Subir" aria-label="Subir campo" disabled={idx === 0} onClick={() => moveField(idx, -1)} className="cf-iconbtn">↑</button>
                                                                <button type="button" title="Bajar" aria-label="Bajar campo" disabled={idx === editing.fields.length - 1} onClick={() => moveField(idx, 1)} className="cf-iconbtn">↓</button>
                                                                <button type="button" title="Eliminar campo" aria-label="Eliminar campo" onClick={() => removeField(idx)} className="cf-iconbtn is-danger">×</button>
                                                            </div>
                                                        </div>
                                                        {f.type === "select" && (
                                                            <div className="cf-span-full">
                                                                <label className="cf-label" htmlFor={`cf-fo-${f.name}`}>Opciones (separadas por coma)</label>
                                                                <input id={`cf-fo-${f.name}`} type="text" value={f.options} onChange={(e) => patchField(idx, { options: e.target.value })} placeholder="Opción 1, Opción 2, Opción 3" className="cf-input" />
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                                    <button type="button" className="cf-btn-ghost" onClick={() => setEditing(null)} disabled={busy}>Cancelar</button>
                                    <button type="submit" className="cf-btn" disabled={busy}>{busy ? "Guardando…" : "Guardar formulario"}</button>
                                </div>
                            </div>
                        </form>
                    )}

                    {/* forms list */}
                    {forms.length === 0 && !editing ? (
                        <div className="cf-empty">
                            <IconEnvelope />
                            <span>Sin formularios todavía — crea el primero con «Nuevo formulario».</span>
                        </div>
                    ) : (
                        forms.map((f) => (
                            <div key={f.id} className="cf-card-item">
                                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                                            <h3 className="cf-form-name">{f.name}</h3>
                                            <span className="cf-chip">ID {f.id}</span>
                                            {Number(f.unread_count) > 0 && (
                                                <span className="cf-chip is-unread">{f.unread_count} sin leer</span>
                                            )}
                                        </div>
                                        <p className="cf-meta">
                                            {(f.fields || []).length} campos · {f.submission_count || 0} mensajes
                                            {f.notify_email ? ` · notifica a ${f.notify_email}` : ""}
                                        </p>
                                        <p className="cf-usage">
                                            Usa el bloque <strong>«ContactForms»</strong> en el editor visual con el ID <strong>{f.id}</strong>
                                        </p>
                                    </div>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                                        <button type="button" className="cf-btn-ghost" onClick={() => { setMessage(""); setEditing({ id: f.id, name: f.name || "", notify_email: f.notify_email || "", success_message: f.success_message || "", fields: (f.fields || []).map((x) => ({ ...x })) }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                                            <IconPen /> Editar
                                        </button>
                                        <button type="button" className="cf-btn-ghost" onClick={() => { setFilterFormId(String(f.id)); setOffset(0); setTab("inbox"); }}>
                                            <IconEnvelope /> Mensajes
                                        </button>
                                        <button type="button" className="cf-btn-danger" onClick={() => deleteForm(f)} disabled={busy}>
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
                <div className="cf-card-item">
                    <div className="cf-toolbar">
                        <div className="cf-toolbar-left">
                            <label className="cf-label" style={{ marginBottom: 0 }} htmlFor="cf-filter">Formulario</label>
                            <select
                                id="cf-filter"
                                value={filterFormId}
                                onChange={(e) => { setFilterFormId(e.target.value); setOffset(0); }}
                                className="cf-select"
                            >
                                <option value="">Todos los formularios</option>
                                {forms.map((f) => (
                                    <option key={f.id} value={String(f.id)}>
                                        {f.name}{Number(f.unread_count) > 0 ? ` (${f.unread_count} sin leer)` : ""}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <button type="button" className="cf-btn" onClick={exportCsv} disabled={busy || !filterFormId} title={filterFormId ? "Descargar CSV" : "Selecciona un formulario primero"}>
                            <IconDownload /> Exportar CSV
                        </button>
                    </div>

                    {submissions.length === 0 ? (
                        <div className="cf-empty">
                            <IconInboxEmpty />
                            <span>Sin mensajes todavía.</span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table">
                                <thead>
                                    <tr>
                                        <th style={{ width: "1rem" }}></th>
                                        <th>Fecha</th>
                                        {!filterFormId && <th>Formulario</th>}
                                        <th>Vista previa</th>
                                        <th>Página</th>
                                        <th style={{ width: "2.5rem" }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {submissions.map((s) => (
                                        <tr
                                            key={s.id}
                                            onClick={() => openSubmission(s)}
                                            className={s.is_read ? "" : "is-unread"}
                                        >
                                            <td>
                                                {!s.is_read && <span className="cf-dot" title="Sin leer"></span>}
                                            </td>
                                            <td className="cf-cell-date">{fmtDate(s.created_at)}</td>
                                            {!filterFormId && (
                                                <td style={{ whiteSpace: "nowrap" }}>{formsById[s.form_id]?.name || `#${s.form_id}`}</td>
                                            )}
                                            <td className="cf-cell-preview">{previewOf(s) || <span className="cf-void">(vacío)</span>}</td>
                                            <td className="cf-cell-url">{s.page_url || ""}</td>
                                            <td style={{ textAlign: "right" }}>
                                                <button
                                                    type="button"
                                                    title="Eliminar mensaje"
                                                    aria-label="Eliminar mensaje"
                                                    onClick={(e) => { e.stopPropagation(); deleteSubmission(s.id); }}
                                                    className="cf-iconbtn is-danger"
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
                        <div className="cf-pager">
                            <button type="button" className="cf-btn-ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
                                ← Anterior
                            </button>
                            <span className="cf-pager-info">
                                Página {page} de {pageCount} · {total} mensajes
                            </span>
                            <button type="button" className="cf-btn-ghost" disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>
                                Siguiente →
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* ============================== SUBMISSION MODAL: the opened letter ============================== */}
            {selected && (
                <div className="cf-overlay" onClick={() => setSelected(null)}>
                    <div className="cf-letter" role="dialog" aria-modal="true" aria-label={`Mensaje #${selected.id}`} onClick={(e) => e.stopPropagation()}>
                        <div className="cf-letter-body">
                            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" }}>
                                <div>
                                    <h3 className="cf-editor-title" style={{ marginBottom: 0 }}><IconEnvelope /> Mensaje #{selected.id}</h3>
                                    <p className="cf-postmark">
                                        {formsById[selected.form_id]?.name || `Formulario #${selected.form_id}`} · {fmtDate(selected.created_at)}
                                    </p>
                                </div>
                                <button type="button" onClick={() => setSelected(null)} aria-label="Cerrar" className="cf-iconbtn">✕</button>
                            </div>

                            <dl className="cf-letter-rows">
                                {detailRows(selected).map((row) => (
                                    <div key={row.key} className="cf-letter-row">
                                        <dt>{row.label}</dt>
                                        <dd>
                                            {row.value == null || String(row.value).trim() === "" ? <span className="cf-void">(vacío)</span> : String(row.value)}
                                        </dd>
                                    </div>
                                ))}
                            </dl>

                            {selected.page_url && (
                                <p className="cf-letter-from">Enviado desde: {selected.page_url}</p>
                            )}

                            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1.4rem" }}>
                                <button type="button" className="cf-btn-danger" onClick={() => deleteSubmission(selected.id)} disabled={busy}>
                                    Eliminar mensaje
                                </button>
                                <button type="button" className="cf-btn-ghost" onClick={() => setSelected(null)}>Cerrar</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

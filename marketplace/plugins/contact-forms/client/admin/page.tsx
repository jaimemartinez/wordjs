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
import { useT } from "./i18n";
import { useModal } from "@/contexts/ModalContext";

// Labels are resolved through `t` at render time (hooks only run inside components).
const FIELD_TYPE_OPTIONS = (t) => [
    { value: "text", label: t("types.text") },
    { value: "email", label: t("types.email") },
    { value: "tel", label: t("types.tel") },
    { value: "number", label: t("types.number") },
    { value: "textarea", label: t("types.textarea") },
    { value: "select", label: t("types.select") },
];

const LIMIT = 50;

// Field names are generated ONCE when a field is added and stay stable across label edits, so
// existing submissions keep matching their columns.
const newFieldName = () => "f_" + Math.random().toString(36).slice(2, 8);

const emptyDraft = () => ({ id: null, name: "", notify_email: "", success_message: "", fields: [] });

// SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS" — normalize before Date parsing.
const fmtDate = (v, locale) => {
    if (!v) return "";
    const s = String(v);
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? s : d.toLocaleString(locale);
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
    const { confirm } = useModal();
    const { t, locale } = useT();
    const [forms, setForms] = useState([]);
    const [tab, setTab] = useState("forms"); // forms | inbox
    const [editing, setEditing] = useState(null); // null | draft object
    const [busy, setBusy] = useState(false);
    // Save failure shown next to the button: the page-top flash is out of sight at the end of a long form (X4-14).
    const [saveError, setSaveError] = useState("");
    const [message, setMessageText] = useState("");
    // Whether the flash is an error is tracked explicitly: the text is translated, so it cannot be sniffed.
    const [messageIsError, setMessageIsError] = useState(false);
    const setMessage = (text, isError = false) => { setMessageText(text); setMessageIsError(isError); };

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
            setMessage(t("msg.loadFormsError", { error: err?.message || err }), true);
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
            setMessage(t("msg.loadSubmissionsError", { error: err?.message || err }), true);
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
            setMessage(t("msg.nameRequired"), true);
            return;
        }
        if (editing.fields.some((f) => !String(f.label || "").trim())) {
            setMessage(t("msg.labelsRequired"), true);
            return;
        }
        setBusy(true);
        setMessage("");
        setSaveError("");
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
            setMessage(t("msg.formSaved", { id: data.form.id }));
            loadForms();
        } catch (err) {
            const raw = String(err?.message || err || "").trim();
            // A dropped connection surfaces as a bare TypeError ("Failed to fetch") or nothing at all.
            const offline = !raw || /failed to fetch|networkerror|load failed|network/i.test(raw);
            setSaveError(offline
                ? t("msg.saveOffline")
                : t("msg.saveError", { error: raw }));
        } finally {
            setBusy(false);
        }
    };

    const deleteForm = async (f) => {
        if (!(await confirm(t("msg.confirmDeleteForm", { name: f.name }), undefined, true))) return;
        setBusy(true);
        setMessage("");
        try {
            await apiDelete(`/plugin/contact-forms/forms/${f.id}`);
            if (String(filterFormId) === String(f.id)) setFilterFormId("");
            if (editing && editing.id === f.id) setEditing(null);
            setMessage(t("msg.formDeleted", { name: f.name }));
            loadForms();
        } catch (err) {
            setMessage(t("msg.deleteError", { error: err?.message || err }), true);
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
        if (!(await confirm(t("msg.confirmDeleteSubmission"), undefined, true))) return;
        setBusy(true);
        try {
            await apiDelete(`/plugin/contact-forms/submissions/${id}`);
            if (selected && selected.id === id) setSelected(null);
            loadSubmissions(filterFormId, offset);
            loadForms();
        } catch (err) {
            setMessage(t("msg.deleteSubmissionError", { error: err?.message || err }), true);
        } finally {
            setBusy(false);
        }
    };

    const exportCsv = async () => {
        if (!filterFormId) {
            setMessage(t("msg.selectFormToExport"), true);
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
            a.download = data.filename || t("export.defaultFilename");
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            setMessage(t("msg.exported", { count: data.count }));
        } catch (err) {
            setMessage(t("msg.exportError", { error: err?.message || err }), true);
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
    const isErrorMsg = messageIsError;

    return (
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconEnvelope /></div>
                <div>
                    <h1 className="cf-title">{t("header.title")}</h1>
                    <p className="cf-subtitle">{t("header.subtitle")}</p>
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
                    {t("tabs.forms")}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "inbox"}
                    onClick={() => { setTab("inbox"); setOffset(0); }}
                    className={`cf-tab ${tab === "inbox" ? "is-active" : ""}`}
                >
                    {t("tabs.inbox")}
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
                            <button type="button" className="cf-btn" onClick={() => { setMessage(""); setSaveError(""); setEditing(emptyDraft()); }}>
                                <IconPlus /> {t("forms.new")}
                            </button>
                        </div>
                    )}

                    {/* editor: the letter being written */}
                    {editing && (
                        <form onSubmit={saveForm} className="cf-editor">
                            <div className="cf-editor-body">
                                <h2 className="cf-editor-title">
                                    <IconPen />
                                    {editing.id ? t("editor.editTitle", { id: editing.id }) : t("editor.newTitle")}
                                </h2>
                                <div className="cf-grid">
                                    <div className="cf-span-2">
                                        <label className="cf-label" htmlFor="cf-name">{t("editor.name")}</label>
                                        <input id="cf-name" type="text" value={editing.name} onChange={(e) => setEditing((p) => ({ ...p, name: e.target.value }))} placeholder={t("editor.namePlaceholder")} className="cf-input" required />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="cf-notify">{t("editor.notify")}</label>
                                        <input id="cf-notify" type="email" value={editing.notify_email} onChange={(e) => setEditing((p) => ({ ...p, notify_email: e.target.value }))} placeholder={t("editor.notifyPlaceholder")} className="cf-input" />
                                        <p className="cf-help">{t("editor.notifyHelp")}</p>
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="cf-success">{t("editor.success")}</label>
                                        <input id="cf-success" type="text" value={editing.success_message} onChange={(e) => setEditing((p) => ({ ...p, success_message: e.target.value }))} placeholder={t("editor.successPlaceholder")} className="cf-input" />
                                    </div>
                                </div>

                                {/* field builder: numbered postal stubs */}
                                <div style={{ marginTop: "1.5rem" }}>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.9rem" }}>
                                        <span className="cf-label" style={{ marginBottom: 0 }}>{t("editor.fields")}</span>
                                        <button type="button" className="cf-btn-ghost" onClick={addField}><IconPlus /> {t("editor.addField")}</button>
                                    </div>
                                    {editing.fields.length === 0 ? (
                                        <div className="cf-empty">
                                            <IconEnvelope />
                                            <span>{t("editor.noFields")}</span>
                                        </div>
                                    ) : (
                                        <div>
                                            {editing.fields.map((f, idx) => (
                                                <div key={f.name} className="cf-field-row">
                                                    <span className="cf-field-num">{t("editor.fieldNum", { num: String(idx + 1).padStart(2, "0") })}</span>
                                                    <div className="cf-field-grid">
                                                        <div>
                                                            <label className="cf-label" htmlFor={`cf-fl-${f.name}`}>{t("editor.label")}</label>
                                                            <input id={`cf-fl-${f.name}`} type="text" value={f.label} onChange={(e) => patchField(idx, { label: e.target.value })} placeholder={t("editor.labelPlaceholder")} className="cf-input" />
                                                        </div>
                                                        <div>
                                                            <label className="cf-label" htmlFor={`cf-ft-${f.name}`}>{t("editor.type")}</label>
                                                            <select id={`cf-ft-${f.name}`} value={f.type} onChange={(e) => patchField(idx, { type: e.target.value })} className="cf-select">
                                                                {FIELD_TYPE_OPTIONS(t).map((o) => (
                                                                    <option key={o.value} value={o.value}>{o.label}</option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                        <div>
                                                            <label className="cf-label" htmlFor={`cf-fw-${f.name}`}>{t("editor.width")}</label>
                                                            <select id={`cf-fw-${f.name}`} value={String(f.width)} onChange={(e) => patchField(idx, { width: Number(e.target.value) })} className="cf-select">
                                                                <option value="100">100%</option>
                                                                <option value="50">50%</option>
                                                            </select>
                                                        </div>
                                                        <div className="cf-field-actions">
                                                            <label className="cf-check">
                                                                <input type="checkbox" checked={!!f.required} onChange={(e) => patchField(idx, { required: e.target.checked ? 1 : 0 })} />
                                                                {t("editor.required")}
                                                            </label>
                                                            <div style={{ display: "flex", gap: "0.35rem" }}>
                                                                <button type="button" title={t("editor.moveUp")} aria-label={t("editor.moveUpAria")} disabled={idx === 0} onClick={() => moveField(idx, -1)} className="cf-iconbtn">↑</button>
                                                                <button type="button" title={t("editor.moveDown")} aria-label={t("editor.moveDownAria")} disabled={idx === editing.fields.length - 1} onClick={() => moveField(idx, 1)} className="cf-iconbtn">↓</button>
                                                                <button type="button" title={t("editor.removeField")} aria-label={t("editor.removeField")} onClick={() => removeField(idx)} className="cf-iconbtn is-danger">×</button>
                                                            </div>
                                                        </div>
                                                        {f.type === "select" && (
                                                            <div className="cf-span-full">
                                                                <label className="cf-label" htmlFor={`cf-fo-${f.name}`}>{t("editor.options")}</label>
                                                                <input id={`cf-fo-${f.name}`} type="text" value={f.options} onChange={(e) => patchField(idx, { options: e.target.value })} placeholder={t("editor.optionsPlaceholder")} className="cf-input" />
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {saveError && (
                                    <div role="alert" className="cf-flash is-error" data-testid="cf-save-error" style={{ marginTop: "1.25rem", marginBottom: 0 }}>{saveError}</div>
                                )}
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                                    <button type="button" className="cf-btn-ghost" onClick={() => { setSaveError(""); setEditing(null); }} disabled={busy}>{t("editor.cancel")}</button>
                                    <button type="submit" className="cf-btn" disabled={busy}>{busy ? t("editor.saving") : t("editor.save")}</button>
                                </div>
                            </div>
                        </form>
                    )}

                    {/* forms list */}
                    {forms.length === 0 && !editing ? (
                        <div className="cf-empty">
                            <IconEnvelope />
                            <span>{t("forms.empty")}</span>
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
                                                <span className="cf-chip is-unread">{t("forms.unread", { count: f.unread_count })}</span>
                                            )}
                                        </div>
                                        <p className="cf-meta">
                                            {t("forms.meta", { fields: (f.fields || []).length, submissions: f.submission_count || 0 })}
                                            {f.notify_email ? t("forms.notifies", { email: f.notify_email }) : ""}
                                        </p>
                                        <p className="cf-usage">
                                            {t("forms.usageBefore")}<strong>«ContactForms»</strong>{t("forms.usageMiddle")}<strong>{f.id}</strong>
                                        </p>
                                    </div>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                                        <button type="button" className="cf-btn-ghost" onClick={() => { setMessage(""); setSaveError(""); setEditing({ id: f.id, name: f.name || "", notify_email: f.notify_email || "", success_message: f.success_message || "", fields: (f.fields || []).map((x) => ({ ...x })) }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                                            <IconPen /> {t("forms.edit")}
                                        </button>
                                        <button type="button" className="cf-btn-ghost" onClick={() => { setFilterFormId(String(f.id)); setOffset(0); setTab("inbox"); }}>
                                            <IconEnvelope /> {t("forms.messages")}
                                        </button>
                                        <button type="button" className="cf-btn-danger" onClick={() => deleteForm(f)} disabled={busy}>
                                            {t("forms.delete")}
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
                            <label className="cf-label" style={{ marginBottom: 0 }} htmlFor="cf-filter">{t("inbox.form")}</label>
                            <select
                                id="cf-filter"
                                value={filterFormId}
                                onChange={(e) => { setFilterFormId(e.target.value); setOffset(0); }}
                                className="cf-select"
                            >
                                <option value="">{t("inbox.allForms")}</option>
                                {forms.map((f) => (
                                    <option key={f.id} value={String(f.id)}>
                                        {f.name}{Number(f.unread_count) > 0 ? t("inbox.unreadSuffix", { count: f.unread_count }) : ""}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <button type="button" className="cf-btn" onClick={exportCsv} disabled={busy || !filterFormId} title={filterFormId ? t("inbox.downloadCsv") : t("inbox.selectFirst")}>
                            <IconDownload /> {t("inbox.exportCsv")}
                        </button>
                    </div>

                    {submissions.length === 0 ? (
                        <div className="cf-empty">
                            <IconInboxEmpty />
                            <span>{t("inbox.empty")}</span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table">
                                <thead>
                                    <tr>
                                        <th style={{ width: "1rem" }}></th>
                                        <th>{t("inbox.colDate")}</th>
                                        {!filterFormId && <th>{t("inbox.colForm")}</th>}
                                        <th>{t("inbox.colPreview")}</th>
                                        <th>{t("inbox.colPage")}</th>
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
                                                {!s.is_read && <span className="cf-dot" title={t("inbox.unread")}></span>}
                                            </td>
                                            <td className="cf-cell-date">{fmtDate(s.created_at, locale)}</td>
                                            {!filterFormId && (
                                                <td style={{ whiteSpace: "nowrap" }}>{formsById[s.form_id]?.name || `#${s.form_id}`}</td>
                                            )}
                                            <td className="cf-cell-preview">{previewOf(s) || <span className="cf-void">{t("inbox.emptyValue")}</span>}</td>
                                            <td className="cf-cell-url">{s.page_url || ""}</td>
                                            <td style={{ textAlign: "right" }}>
                                                <button
                                                    type="button"
                                                    title={t("inbox.deleteMessage")}
                                                    aria-label={t("inbox.deleteMessage")}
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
                                {t("inbox.prev")}
                            </button>
                            <span className="cf-pager-info">
                                {t("inbox.pageInfo", { page, pages: pageCount, total })}
                            </span>
                            <button type="button" className="cf-btn-ghost" disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>
                                {t("inbox.next")}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* ============================== SUBMISSION MODAL: the opened letter ============================== */}
            {selected && (
                <div className="cf-overlay" onClick={() => setSelected(null)}>
                    <div className="cf-letter" role="dialog" aria-modal="true" aria-label={t("modal.title", { id: selected.id })} onClick={(e) => e.stopPropagation()}>
                        <div className="cf-letter-body">
                            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" }}>
                                <div>
                                    <h3 className="cf-editor-title" style={{ marginBottom: 0 }}><IconEnvelope /> {t("modal.title", { id: selected.id })}</h3>
                                    <p className="cf-postmark">
                                        {formsById[selected.form_id]?.name || t("modal.formFallback", { id: selected.form_id })} · {fmtDate(selected.created_at, locale)}
                                    </p>
                                </div>
                                <button type="button" onClick={() => setSelected(null)} aria-label={t("modal.close")} className="cf-iconbtn">✕</button>
                            </div>

                            <dl className="cf-letter-rows">
                                {detailRows(selected).map((row) => (
                                    <div key={row.key} className="cf-letter-row">
                                        <dt>{row.label}</dt>
                                        <dd>
                                            {row.value == null || String(row.value).trim() === "" ? <span className="cf-void">{t("inbox.emptyValue")}</span> : String(row.value)}
                                        </dd>
                                    </div>
                                ))}
                            </dl>

                            {selected.page_url && (
                                <p className="cf-letter-from">{t("modal.sentFrom", { url: selected.page_url })}</p>
                            )}

                            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1.4rem" }}>
                                <button type="button" className="cf-btn-danger" onClick={() => deleteSubmission(selected.id)} disabled={busy}>
                                    {t("modal.delete")}
                                </button>
                                <button type="button" className="cf-btn-ghost" onClick={() => setSelected(null)}>{t("modal.close")}</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

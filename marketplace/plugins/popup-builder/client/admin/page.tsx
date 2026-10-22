// @ts-nocheck
"use client";

/**
 * Admin page for the Popup Builder plugin (/admin/plugin/popups).
 * List of popups with stats (views/clicks/CTR), single-active toggle, and an editor modal with
 * triggers, frequency capping, optional date window, a "re-show to everybody" version bump and
 * an inline preview of the popup card.
 *
 * Visual identity (shared premium admin system) lives in the plugin's OWN stylesheet
 * (client/admin/admin.css, injected by the host admin shell and scoped to
 * .plugin-admin-popups) — the markup below only uses cf-* classes.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";
import { useT } from "./i18n";

const BASE = "/plugin/popup-builder";

const TRIGGER_OPTIONS = [
    { value: "delay", labelKey: "trigger.delay" },
    { value: "scroll", labelKey: "trigger.scroll" },
    { value: "exit", labelKey: "trigger.exit" },
];

const FREQ_OPTIONS = [
    { value: "always", labelKey: "freq.always" },
    { value: "session", labelKey: "freq.session" },
    { value: "visitor", labelKey: "freq.visitor" },
    { value: "daily", labelKey: "freq.daily" },
];

const FREQ_LABELS = { always: "freqShort.always", session: "freqShort.session", visitor: "freqShort.visitor", daily: "freqShort.daily" };

// Short human summary of the trigger for the list cards.
function triggerSummary(p, t) {
    if (p.trigger_type === "scroll") return t("trigger.sumScroll", { n: p.trigger_value });
    if (p.trigger_type === "exit") return t("trigger.sumExit");
    return t("trigger.sumDelay", { n: p.trigger_value });
}

function fmtDate(s, locale) {
    if (!s) return "";
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toLocaleString(locale || [], { dateStyle: "medium", timeStyle: "short" });
}

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconMegaphone = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="m3 11 18-5v12L3 14v-3z" />
        <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
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
const IconPower = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M12 2v10" />
        <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
    </svg>
);

// Miniature live preview of the popup card, driven by the editor form values.
function PopupPreview({ form }) {
    const { t } = useT();
    return (
        <div className="cf-preview-stage">
            <div className="cf-preview-card">
                <span className="cf-preview-close" aria-hidden="true">×</span>
                {form.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={form.image_url} alt="" decoding="async" className="cf-preview-img" />
                ) : null}
                <h3 className="cf-preview-title">{form.title || t("preview.title")}</h3>
                {form.body ? <p className="cf-preview-body">{form.body}</p> : <p className="cf-preview-body is-placeholder">{t("preview.body")}</p>}
                {form.button_label ? (
                    <span className="cf-preview-cta">{form.button_label}</span>
                ) : null}
            </div>
        </div>
    );
}

// Editor modal — create (popup=null) or edit (popup=object). Mounted fresh per session (keyed by parent).
function EditorModal({ popup, onClose, onSaved }) {
    const { t } = useT();
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
            setError(err?.message || t("editor.saveError"));
        } finally {
            setBusy(false);
        }
    };

    const valueLabel = form.trigger_type === "scroll" ? t("editor.valueScroll") : t("editor.valueSeconds");

    return (
        <div className="cf-overlay">
            <div className="cf-letter is-wide" role="dialog" aria-modal="true" aria-label={isEdit ? t("editor.edit") : t("editor.new")}>
                <div className="cf-letter-body">
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", marginBottom: "1.35rem" }}>
                        <h2 className="cf-editor-title" style={{ marginBottom: 0 }}>
                            {isEdit ? <IconPen /> : <IconPlus />}
                            {isEdit ? t("editor.edit") : t("editor.new")}
                        </h2>
                        <button type="button" onClick={onClose} aria-label={t("common.close")} className="cf-iconbtn">✕</button>
                    </div>

                    <form onSubmit={save} className="cf-modal-grid">
                        <div className="cf-stack">
                            <div>
                                <label className="cf-label" htmlFor="pb-title">{t("editor.title")}</label>
                                <input id="pb-title" type="text" value={form.title} onChange={(e) => set("title", e.target.value)} className="cf-input" placeholder={t("editor.titlePlaceholder")} required />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="pb-body">{t("editor.body")}</label>
                                <textarea id="pb-body" value={form.body} onChange={(e) => set("body", e.target.value)} className="cf-input" placeholder={t("editor.bodyPlaceholder")} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="pb-image">{t("editor.image")}</label>
                                <input id="pb-image" type="text" value={form.image_url} onChange={(e) => set("image_url", e.target.value)} className="cf-input" placeholder={t("editor.imagePlaceholder")} />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.8rem" }}>
                                <div>
                                    <label className="cf-label" htmlFor="pb-btn-label">{t("editor.buttonLabel")}</label>
                                    <input id="pb-btn-label" type="text" value={form.button_label} onChange={(e) => set("button_label", e.target.value)} className="cf-input" placeholder={t("editor.buttonLabelPlaceholder")} />
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="pb-btn-url">{t("editor.buttonUrl")}</label>
                                    <input id="pb-btn-url" type="text" value={form.button_url} onChange={(e) => set("button_url", e.target.value)} className="cf-input" placeholder={t("editor.buttonUrlPlaceholder")} />
                                </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.8rem" }}>
                                <div>
                                    <label className="cf-label" htmlFor="pb-trigger">{t("editor.trigger")}</label>
                                    <select id="pb-trigger" value={form.trigger_type} onChange={(e) => set("trigger_type", e.target.value)} className="cf-select">
                                        {TRIGGER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                                    </select>
                                </div>
                                {form.trigger_type !== "exit" && (
                                    <div>
                                        <label className="cf-label" htmlFor="pb-trigger-value">{valueLabel}</label>
                                        <input id="pb-trigger-value" type="number" min={0} max={form.trigger_type === "scroll" ? 100 : undefined} value={form.trigger_value} onChange={(e) => set("trigger_value", e.target.value)} className="cf-input" />
                                    </div>
                                )}
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="pb-frequency">{t("editor.frequency")}</label>
                                <select id="pb-frequency" value={form.frequency} onChange={(e) => set("frequency", e.target.value)} className="cf-select">
                                    {FREQ_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.labelKey)}</option>)}
                                </select>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.8rem" }}>
                                <div>
                                    <label className="cf-label" htmlFor="pb-starts">{t("editor.startsAt")}</label>
                                    <input id="pb-starts" type="datetime-local" value={form.starts_at} onChange={(e) => set("starts_at", e.target.value)} className="cf-input" />
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="pb-ends">{t("editor.endsAt")}</label>
                                    <input id="pb-ends" type="datetime-local" value={form.ends_at} onChange={(e) => set("ends_at", e.target.value)} className="cf-input" />
                                </div>
                            </div>
                            <label className="cf-check">
                                <input type="checkbox" checked={form.activate} onChange={(e) => set("activate", e.target.checked)} />
                                {t("editor.activate")}
                            </label>
                            {isEdit && (
                                <label className="cf-check">
                                    <input type="checkbox" checked={form.bump} onChange={(e) => set("bump", e.target.checked)} />
                                    {t("editor.bump")}
                                </label>
                            )}
                        </div>

                        <div className="cf-stack">
                            <div>
                                <span className="cf-label">{t("editor.preview")}</span>
                                <PopupPreview form={form} />
                            </div>
                            {error && <div role="alert" className="cf-flash is-error" style={{ marginBottom: 0 }}>{error}</div>}
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem" }}>
                                <button type="button" onClick={onClose} className="cf-btn-ghost">{t("common.cancel")}</button>
                                <button type="submit" disabled={busy} className="cf-btn">{busy ? t("common.saving") : t("common.save")}</button>
                            </div>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}

// A single popup row card in the list.
function PopupCard({ popup, busy, onToggle, onEdit, onDelete }) {
    const { t, locale } = useT();
    return (
        <div className="cf-card-item">
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
                <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                        <h3 className="cf-form-name">{popup.title}</h3>
                        {popup.enabled ? (
                            <span className="cf-pill is-on">{t("card.active")}</span>
                        ) : (
                            <span className="cf-pill is-off">{t("card.inactive")}</span>
                        )}
                    </div>
                    <p className="cf-meta">
                        {triggerSummary(popup, t)} · {FREQ_LABELS[popup.frequency] ? t(FREQ_LABELS[popup.frequency]) : popup.frequency} · v{popup.version}
                    </p>
                    {(popup.starts_at || popup.ends_at) && (
                        <p className="cf-meta">
                            {popup.starts_at ? t("card.from", { date: fmtDate(popup.starts_at, locale) }) : ""}
                            {popup.starts_at && popup.ends_at ? " · " : ""}
                            {popup.ends_at ? t("card.until", { date: fmtDate(popup.ends_at, locale) }) : ""}
                        </p>
                    )}
                </div>
                <div className="cf-stats">
                    <div className="cf-stat">
                        <p className="cf-stat-value">{popup.views}</p>
                        <p className="cf-stat-label">{t("card.views")}</p>
                    </div>
                    <div className="cf-stat">
                        <p className="cf-stat-value">{popup.clicks}</p>
                        <p className="cf-stat-label">{t("card.clicks")}</p>
                    </div>
                    <div className="cf-stat">
                        <p className="cf-stat-value is-accent">{popup.ctr}%</p>
                        <p className="cf-stat-label">{t("card.ctr")}</p>
                    </div>
                </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
                <button type="button" disabled={busy} onClick={() => onToggle(popup)} className={popup.enabled ? "cf-btn-ghost" : "cf-btn-ok"}>
                    <IconPower /> {popup.enabled ? t("card.deactivate") : t("card.activate")}
                </button>
                <button type="button" disabled={busy} onClick={() => onEdit(popup)} className="cf-btn-ghost">
                    <IconPen /> {t("common.edit")}
                </button>
                <button type="button" disabled={busy} onClick={() => onDelete(popup)} className="cf-btn-danger">
                    {t("common.delete")}
                </button>
            </div>
        </div>
    );
}

export default function PopupBuilderAdminPage() {
    const { t } = useT();
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
            setMessage(t("app.loadError", { msg: err?.message || err }));
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
            setMessage(t("app.error", { msg: err?.message || err }));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (popup) => {
        if (!window.confirm(t("app.confirmDelete", { title: popup.title }))) return;
        setBusy(true);
        setMessage("");
        try {
            await apiDelete(`${BASE}/${popup.id}`);
            await load();
        } catch (err) {
            setMessage(t("app.deleteError", { msg: err?.message || err }));
        } finally {
            setBusy(false);
        }
    };

    const onSaved = async () => {
        setEditing(undefined);
        setMessage(t("app.saved"));
        await load();
    };

    return (
        <div className="cf-shell">
            {/* header: stamp + title + primary action */}
            <div className="cf-header" style={{ flexWrap: "wrap" }}>
                <div className="cf-stamp" aria-hidden="true"><IconMegaphone /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">
                        {t("app.subtitle")}
                    </p>
                </div>
                <button type="button" onClick={() => setEditing(null)} className="cf-btn" style={{ marginLeft: "auto" }}>
                    <IconPlus /> {t("app.new")}
                </button>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {message && (
                <div role={/Error/i.test(message) || /^Erro\b/i.test(message) ? "alert" : "status"} className={`cf-flash ${/Error/i.test(message) || /^Erro\b/i.test(message) ? "is-error" : "is-ok"}`}>
                    {message}
                </div>
            )}

            {loading ? (
                <p className="cf-meta">{t("app.loading")}</p>
            ) : popups.length === 0 ? (
                <div className="cf-empty">
                    <IconMegaphone />
                    <span>{t("app.empty")}</span>
                    <button type="button" onClick={() => setEditing(null)} className="cf-btn"><IconPlus /> {t("app.create")}</button>
                </div>
            ) : (
                <div>
                    {popups.map((p) => (
                        <PopupCard key={p.id} popup={p} busy={busy} onToggle={toggle} onEdit={(pp) => setEditing(pp)} onDelete={remove} />
                    ))}
                </div>
            )}

            <p className="cf-footnote">
                {t("app.footnote")}
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

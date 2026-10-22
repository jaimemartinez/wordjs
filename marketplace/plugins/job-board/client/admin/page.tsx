// @ts-nocheck
"use client";

/**
 * Admin page for the Job Board plugin (/admin/plugin/jobs).
 * Tabs: Vacantes (CRUD + publish toggle), Postulaciones (inbox with statuses, cover-letter modal,
 * CSV export) and Configuración. Salary inputs are decimals in the UI and INTEGER CENTS on the
 * wire/database. API calls go through the host's api helpers (session cookie).
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-jobs) — the markup below only uses cf-* classes
 * plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";
import { useT } from "./i18n";

const BASE = "/plugin/job-board";

// Option values in display order; their labels are translated at render time (type.*, period.*, status.*).
const JOB_TYPES = ["full-time", "part-time", "contract", "internship", "temporary"];
const PERIODS = ["hour", "month", "year"];
const STATUSES = ["new", "reviewed", "shortlisted", "rejected"];
const typeLabel = (t, type) => (JOB_TYPES.includes(type) ? t(`type.${type}`) : type);
// Maps each application status to its cf-status-select tint modifier (see admin.css).
const STATUS_COLORS = {
    new: "is-new",
    reviewed: "is-reviewed",
    shortlisted: "is-shortlisted",
    rejected: "is-rejected",
};

const centsToInput = (cents) => {
    const n = (Number(cents) || 0) / 100;
    return n > 0 ? String(n) : "";
};
const inputToCents = (v) => {
    const n = parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};
const fmtDate = (iso, locale) => {
    if (!iso) return "";
    const s = String(iso);
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? s : d.toLocaleString(locale);
};

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconBriefcase = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="2" y="7" width="20" height="14" rx="2" />
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
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
const IconFileText = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
    </svg>
);
// ---- Vacante create/edit modal (module level — never define a component inside a component) ----
function JobModal({ initial, onClose, onSaved }) {
    const { t } = useT();
    const [form, setForm] = useState(() => ({
        title: initial?.title || "",
        company: initial?.company || "",
        location: initial?.location || "",
        type: initial?.type || "full-time",
        is_remote: !!initial?.is_remote,
        salaryMin: centsToInput(initial?.salary_min_cents),
        salaryMax: centsToInput(initial?.salary_max_cents),
        salary_period: initial?.salary_period || "month",
        description: initial?.description || "",
        requirements: initial?.requirements || "",
        apply_email: initial?.apply_email || "",
        is_published: initial ? !!initial.is_published : true,
        expires_at: initial?.expires_at || "",
    }));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const set = (k) => (e) => {
        const val = e.target.type === "checkbox" ? e.target.checked : e.target.value;
        setForm((f) => ({ ...f, [k]: val }));
    };

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const body = {
                title: form.title,
                company: form.company,
                location: form.location,
                type: form.type,
                is_remote: form.is_remote ? 1 : 0,
                salary_min_cents: inputToCents(form.salaryMin),
                salary_max_cents: inputToCents(form.salaryMax),
                salary_period: form.salary_period,
                description: form.description,
                requirements: form.requirements,
                apply_email: form.apply_email,
                is_published: form.is_published ? 1 : 0,
                expires_at: form.expires_at,
            };
            if (initial?.id) await apiPut(`${BASE}/jobs/${initial.id}`, body);
            else await apiPost(`${BASE}/jobs`, body);
            onSaved();
        } catch (err) {
            setError(err?.message || String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="cf-overlay" onClick={onClose}>
            <form
                onSubmit={save}
                onClick={(e) => e.stopPropagation()}
                className="cf-letter is-wide"
                role="dialog"
                aria-modal="true"
                aria-label={initial?.id ? t("job.edit") : t("job.new")}
            >
                <div className="cf-letter-body">
                    <h2 className="cf-editor-title">
                        <IconPen />
                        {initial?.id ? t("job.edit") : t("job.new")}
                    </h2>
                    <div style={{ display: "grid", gap: "1.05rem" }}>
                        <div>
                            <label className="cf-label" htmlFor="jb-title">{t("job.title")}</label>
                            <input id="jb-title" type="text" value={form.title} onChange={set("title")} className="cf-input" required maxLength={200} />
                        </div>
                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="jb-company">{t("job.company")}</label>
                                <input id="jb-company" type="text" value={form.company} onChange={set("company")} className="cf-input" maxLength={200} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="jb-location">{t("job.location")}</label>
                                <input id="jb-location" type="text" value={form.location} onChange={set("location")} className="cf-input" maxLength={200} />
                            </div>
                        </div>
                        <div className="cf-grid" style={{ alignItems: "end" }}>
                            <div>
                                <label className="cf-label" htmlFor="jb-type">{t("job.type")}</label>
                                <select id="jb-type" value={form.type} onChange={set("type")} className="cf-select">
                                    {JOB_TYPES.map((v) => <option key={v} value={v}>{t(`type.${v}`)}</option>)}
                                </select>
                            </div>
                            <label className="cf-check">
                                <input type="checkbox" checked={form.is_remote} onChange={set("is_remote")} />
                                {t("job.remote")}
                            </label>
                        </div>
                        <div className="cf-grid-3">
                            <div>
                                <label className="cf-label" htmlFor="jb-salary-min">{t("job.salaryMin")}</label>
                                <input id="jb-salary-min" type="number" min="0" step="0.01" value={form.salaryMin} onChange={set("salaryMin")} className="cf-input" placeholder={t("job.salaryPlaceholder")} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="jb-salary-max">{t("job.salaryMax")}</label>
                                <input id="jb-salary-max" type="number" min="0" step="0.01" value={form.salaryMax} onChange={set("salaryMax")} className="cf-input" placeholder={t("job.salaryPlaceholder")} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="jb-period">{t("job.period")}</label>
                                <select id="jb-period" value={form.salary_period} onChange={set("salary_period")} className="cf-select">
                                    {PERIODS.map((v) => <option key={v} value={v}>{t(`period.${v}`)}</option>)}
                                </select>
                            </div>
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="jb-description">{t("job.description")}</label>
                            <textarea id="jb-description" value={form.description} onChange={set("description")} className="cf-textarea" style={{ minHeight: "120px" }} required />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="jb-requirements">{t("job.requirements")}</label>
                            <textarea id="jb-requirements" value={form.requirements} onChange={set("requirements")} className="cf-textarea" style={{ minHeight: "80px" }} />
                        </div>
                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="jb-apply-email">{t("job.applyEmail")}</label>
                                <input id="jb-apply-email" type="email" value={form.apply_email} onChange={set("apply_email")} className="cf-input" placeholder={t("job.applyEmailPlaceholder")} maxLength={254} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="jb-expires">{t("job.expires")}</label>
                                <input id="jb-expires" type="date" value={form.expires_at} onChange={set("expires_at")} className="cf-input" />
                                <p className="cf-help">{t("job.expiresHelp")}</p>
                            </div>
                        </div>
                        <label className="cf-check">
                            <input type="checkbox" checked={form.is_published} onChange={set("is_published")} />
                            {t("job.published")}
                        </label>
                        {error && <div role="alert" className="cf-flash is-error" style={{ marginBottom: 0 }}>{error}</div>}
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "0.35rem" }}>
                            <button type="button" onClick={onClose} className="cf-btn-ghost">{t("common.cancel")}</button>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? t("common.saving") : t("common.save")}</button>
                        </div>
                    </div>
                </div>
            </form>
        </div>
    );
}

// ---- Cover letter modal ------------------------------------------------------------------------
function CoverLetterModal({ application, onClose }) {
    const { t } = useT();
    return (
        <div className="cf-overlay" onClick={onClose}>
            <div
                onClick={(e) => e.stopPropagation()}
                className="cf-letter"
                role="dialog"
                aria-modal="true"
                aria-label={t("letter.title")}
            >
                <div className="cf-letter-body">
                    <h2 className="cf-editor-title" style={{ marginBottom: 0 }}><IconFileText /> {t("letter.title")}</h2>
                    <p className="cf-postmark">
                        {application.name} · {application.email}
                    </p>
                    <p className="cf-prose">
                        {application.cover_letter || t("letter.none")}
                    </p>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.4rem" }}>
                        <button type="button" onClick={onClose} className="cf-btn-ghost">{t("common.close")}</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ---- Vacantes tab --------------------------------------------------------------------------------
function JobsTab({ jobs, onReload, onMessage }) {
    const { t } = useT();
    const [modalJob, setModalJob] = useState(undefined); // undefined = closed, null = new, object = edit

    const togglePublish = async (job) => {
        try {
            await apiPost(`${BASE}/jobs/${job.id}/publish`, { is_published: job.is_published ? 0 : 1 });
            onReload();
        } catch (err) {
            onMessage(t("common.error", { msg: err?.message || err }));
        }
    };

    const remove = async (job) => {
        if (!window.confirm(t("jobs.confirmDelete", { title: job.title }))) return;
        try {
            await apiDelete(`${BASE}/jobs/${job.id}`);
            onReload();
            onMessage(t("jobs.deleted"));
        } catch (err) {
            onMessage(t("common.error", { msg: err?.message || err }));
        }
    };

    const isExpired = (job) => !!(job.expires_at && job.expires_at < new Date().toISOString().slice(0, 10));

    return (
        <div className="cf-card-item">
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "1.15rem" }}>
                <h2 className="cf-form-name">{t("jobs.heading", { count: jobs.length })}</h2>
                <button type="button" onClick={() => setModalJob(null)} className="cf-btn"><IconPlus /> {t("jobs.new")}</button>
            </div>
            {jobs.length === 0 ? (
                <div className="cf-empty">
                    <IconBriefcase />
                    <span>{t("jobs.empty")}</span>
                </div>
            ) : (
                <div className="cf-table-wrap">
                    <table className="cf-table is-static">
                        <thead>
                            <tr>
                                <th>{t("jobs.colTitle")}</th>
                                <th>{t("jobs.colType")}</th>
                                <th>{t("jobs.colLocation")}</th>
                                <th style={{ textAlign: "right" }}>{t("jobs.colViews")}</th>
                                <th style={{ textAlign: "right" }}>{t("jobs.colApplications")}</th>
                                <th>{t("jobs.colPublished")}</th>
                                <th>{t("jobs.colExpires")}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {jobs.map((job) => (
                                <tr key={job.id}>
                                    <td>
                                        <span className="cf-cand-name">{job.title}</span>
                                        {job.company ? <span style={{ color: "var(--cf-faint)" }}> · {job.company}</span> : null}
                                    </td>
                                    <td style={{ whiteSpace: "nowrap" }}>
                                        <span className="cf-pill is-accent">
                                            {typeLabel(t, job.type)}
                                        </span>
                                        {job.is_remote ? (
                                            <span className="cf-pill is-ok">{t("jobs.remote")}</span>
                                        ) : null}
                                    </td>
                                    <td>{job.location || "—"}</td>
                                    <td className="cf-cell-num">{job.views || 0}</td>
                                    <td className="cf-cell-num" style={{ whiteSpace: "nowrap" }}>
                                        <span style={{ fontWeight: 650, color: "var(--cf-ink)" }}>{job.app_count || 0}</span>
                                        {job.new_count > 0 && (
                                            <span className="cf-chip is-unread" style={{ marginLeft: "0.4rem" }}>
                                                {t("jobs.newCount", { count: job.new_count })}
                                            </span>
                                        )}
                                    </td>
                                    <td>
                                        <button
                                            type="button"
                                            onClick={() => togglePublish(job)}
                                            className={`cf-switch ${job.is_published ? "is-on" : ""}`}
                                            aria-pressed={!!job.is_published}
                                            aria-label={job.is_published ? t("jobs.publishedToggle") : t("jobs.hiddenToggle")}
                                            title={job.is_published ? t("jobs.publishedToggle") : t("jobs.hiddenToggle")}
                                        ></button>
                                    </td>
                                    <td className="cf-cell-date">
                                        {job.expires_at ? (
                                            <span className={isExpired(job) ? "cf-expired" : ""}>{job.expires_at}{isExpired(job) ? t("jobs.expiredSuffix") : ""}</span>
                                        ) : t("jobs.never")}
                                    </td>
                                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                                        <button type="button" onClick={() => setModalJob(job)} className="cf-linkbtn">{t("common.edit")}</button>
                                        <button type="button" onClick={() => remove(job)} className="cf-linkbtn is-danger">{t("common.delete")}</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {modalJob !== undefined && (
                <JobModal
                    initial={modalJob}
                    onClose={() => setModalJob(undefined)}
                    onSaved={() => { setModalJob(undefined); onReload(); onMessage(t("jobs.saved")); }}
                />
            )}
        </div>
    );
}

// ---- Postulaciones tab -----------------------------------------------------------------------------
function ApplicationsTab({ jobs, onMessage, onCountsChange }) {
    const { t, locale } = useT();
    const [applications, setApplications] = useState([]);
    const [counts, setCounts] = useState({ new: 0, total: 0 });
    const [jobFilter, setJobFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [letterApp, setLetterApp] = useState(null);
    const [loading, setLoading] = useState(true);

    const load = async () => {
        setLoading(true);
        try {
            const p = new URLSearchParams();
            if (jobFilter) p.set("job_id", jobFilter);
            if (statusFilter) p.set("status", statusFilter);
            const data = await api(`${BASE}/applications?${p.toString()}`);
            setApplications(data.applications || []);
            setCounts(data.counts || { new: 0, total: 0 });
            if (onCountsChange) onCountsChange(data.counts || {});
        } catch (err) {
            onMessage(t("common.error", { msg: err?.message || err }));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, [jobFilter, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

    const setStatus = async (app, status) => {
        try {
            await apiPost(`${BASE}/applications/${app.id}/status`, { status });
            load();
        } catch (err) {
            onMessage(t("common.error", { msg: err?.message || err }));
        }
    };

    const remove = async (app) => {
        if (!window.confirm(t("apps.confirmDelete", { name: app.name }))) return;
        try {
            await apiDelete(`${BASE}/applications/${app.id}`);
            load();
            onMessage(t("apps.deleted"));
        } catch (err) {
            onMessage(t("common.error", { msg: err?.message || err }));
        }
    };

    const exportCsv = async () => {
        try {
            const p = new URLSearchParams();
            if (jobFilter) p.set("job_id", jobFilter);
            if (statusFilter) p.set("status", statusFilter);
            // The isolate JSON-encodes string bodies, so the server returns { csv } and the
            // client builds the downloadable file itself.
            const data = await api(`${BASE}/applications/export?${p.toString()}`);
            const blob = new Blob([data.csv || ""], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = data.filename || t("apps.csvName");
            a.click();
            URL.revokeObjectURL(url);
            onMessage(t("apps.exported", { count: data.count || 0 }));
        } catch (err) {
            onMessage(t("apps.exportError", { msg: err?.message || err }));
        }
    };

    return (
        <div className="cf-card-item">
            <div className="cf-toolbar">
                <h2 className="cf-form-name" style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    {t("apps.heading")}
                    {counts.new > 0 && (
                        <span className="cf-chip is-unread">
                            {t("apps.newCount", { count: counts.new })}
                        </span>
                    )}
                </h2>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.6rem" }}>
                    <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} className="cf-select" aria-label={t("apps.filterJob")}>
                        <option value="">{t("apps.allJobs")}</option>
                        {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
                    </select>
                    <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="cf-select" aria-label={t("apps.filterStatus")}>
                        <option value="">{t("apps.allStatuses")}</option>
                        {STATUSES.map((v) => <option key={v} value={v}>{t(`status.${v}`)}</option>)}
                    </select>
                    <button type="button" onClick={exportCsv} className="cf-btn-ghost"><IconDownload /> {t("apps.exportCsv")}</button>
                </div>
            </div>
            {loading ? (
                <p className="cf-meta">{t("common.loading")}</p>
            ) : applications.length === 0 ? (
                <div className="cf-empty">
                    <IconInboxEmpty />
                    <span>{t("apps.empty")}</span>
                </div>
            ) : (
                <div className="cf-table-wrap">
                    <table className="cf-table is-static">
                        <thead>
                            <tr>
                                <th>{t("apps.colCandidate")}</th>
                                <th>{t("apps.colJob")}</th>
                                <th>{t("apps.colCv")}</th>
                                <th>{t("apps.colLetter")}</th>
                                <th>{t("apps.colStatus")}</th>
                                <th>{t("apps.colDate")}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {applications.map((app) => (
                                <tr key={app.id} className={app.status === "new" ? "is-new" : ""}>
                                    <td>
                                        <div className="cf-cand-name">{app.name}</div>
                                        <div className="cf-cand-sub">
                                            <a href={`mailto:${app.email}`} className="cf-tlink">{app.email}</a>
                                            {app.phone ? ` · ${app.phone}` : ""}
                                        </div>
                                    </td>
                                    <td>{app.job_title || `#${app.job_id}`}</td>
                                    <td>
                                        {app.cv_url ? (
                                            <a href={app.cv_url} target="_blank" rel="noopener noreferrer" className="cf-tlink">{t("apps.viewCv")}</a>
                                        ) : <span className="cf-void">—</span>}
                                    </td>
                                    <td>
                                        {app.cover_letter ? (
                                            <button type="button" onClick={() => setLetterApp(app)} className="cf-linkbtn">{t("apps.read")}</button>
                                        ) : <span className="cf-void">—</span>}
                                    </td>
                                    <td>
                                        <select
                                            value={app.status}
                                            onChange={(e) => setStatus(app, e.target.value)}
                                            aria-label={t("apps.statusOf", { name: app.name })}
                                            className={`cf-status-select ${STATUS_COLORS[app.status] || ""}`}
                                        >
                                            {STATUSES.map((v) => <option key={v} value={v}>{t(`status.${v}`)}</option>)}
                                        </select>
                                    </td>
                                    <td className="cf-cell-date">{fmtDate(app.created_at, locale)}</td>
                                    <td style={{ textAlign: "right" }}>
                                        <button type="button" onClick={() => remove(app)} className="cf-linkbtn is-danger">{t("common.delete")}</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {letterApp && <CoverLetterModal application={letterApp} onClose={() => setLetterApp(null)} />}
        </div>
    );
}

// ---- Configuración tab -----------------------------------------------------------------------------
function ConfigTab({ onMessage }) {
    const { t } = useT();
    const [config, setConfig] = useState({ currencySymbol: "$", notifyEmail: "", showSalary: true });
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api(`${BASE}/config`)
            .then((d) => { if (d && d.config) setConfig(d.config); })
            .catch(() => {});
    }, []);

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
            const d = await apiPost(`${BASE}/config`, config);
            if (d && d.config) setConfig(d.config);
            onMessage(t("config.saved"));
        } catch (err) {
            onMessage(t("common.error", { msg: err?.message || err }));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form onSubmit={save} className="cf-editor" style={{ maxWidth: "36rem" }}>
            <div className="cf-editor-body">
                <div style={{ display: "grid", gap: "1.2rem" }}>
                    <div>
                        <label className="cf-label" htmlFor="jb-currency">{t("config.currency")}</label>
                        <input id="jb-currency" type="text" value={config.currencySymbol} onChange={(e) => setConfig((c) => ({ ...c, currencySymbol: e.target.value }))} className="cf-input" maxLength={5} />
                        <p className="cf-help">{t("config.currencyHelp")}</p>
                    </div>
                    <div>
                        <label className="cf-label" htmlFor="jb-notify">{t("config.notifyEmail")}</label>
                        <input id="jb-notify" type="email" value={config.notifyEmail} onChange={(e) => setConfig((c) => ({ ...c, notifyEmail: e.target.value }))} className="cf-input" placeholder={t("config.notifyPlaceholder")} maxLength={254} />
                        <p className="cf-help">
                            {t("config.notifyHelp")}
                        </p>
                    </div>
                    <label className="cf-check">
                        <input type="checkbox" checked={!!config.showSalary} onChange={(e) => setConfig((c) => ({ ...c, showSalary: e.target.checked }))} />
                        {t("config.showSalary")}
                    </label>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <button type="submit" disabled={busy} className="cf-btn">{busy ? t("common.saving") : t("common.save")}</button>
                    </div>
                </div>
            </div>
        </form>
    );
}

// ---- Page ------------------------------------------------------------------------------------------
export default function JobBoardAdminPage() {
    const { t } = useT();
    const [tab, setTab] = useState("jobs");
    const [jobs, setJobs] = useState([]);
    const [newCount, setNewCount] = useState(0);
    const [message, setMessage] = useState("");

    const loadJobs = async () => {
        try {
            const data = await api(`${BASE}/jobs`);
            const list = data.jobs || [];
            setJobs(list);
            setNewCount(list.reduce((sum, j) => sum + (j.new_count || 0), 0));
        } catch {
            setJobs([]);
        }
    };

    useEffect(() => { loadJobs(); }, []);

    const flash = (msg) => {
        setMessage(msg);
        if (msg) setTimeout(() => setMessage(""), 5000);
    };

    const tabBtn = (id, label, badge) => (
        <button
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`cf-tab ${tab === id ? "is-active" : ""}`}
        >
            {label}
            {badge > 0 && (
                <span className="cf-badge">{badge}</span>
            )}
        </button>
    );

    return (
        <div className="cf-shell">
            {/* header: stamp + title + rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconBriefcase /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">
                        {t("app.subtitle")}
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                {tabBtn("jobs", t("tab.jobs"), 0)}
                {tabBtn("applications", t("tab.applications"), newCount)}
                {tabBtn("config", t("tab.config"), 0)}
            </div>

            {/* Client-built errors start with "Error" (es/en) or "Erro" (pt). */}
            {message && (
                <div role={/^Erro/i.test(message) ? "alert" : "status"} className={`cf-flash ${/^Erro/i.test(message) ? "is-error" : "is-ok"}`}>
                    {message}
                </div>
            )}

            {tab === "jobs" && <JobsTab jobs={jobs} onReload={loadJobs} onMessage={flash} />}
            {tab === "applications" && (
                <ApplicationsTab
                    jobs={jobs}
                    onMessage={flash}
                    onCountsChange={(c) => setNewCount(c.new || 0)}
                />
            )}
            {tab === "config" && <ConfigTab onMessage={flash} />}
        </div>
    );
}

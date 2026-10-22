// @ts-nocheck
"use client";

/**
 * Admin page for the Newsletter plugin (/admin/plugin/newsletter).
 * Subscriber dashboard (stats, filter chips, search, delete, CSV export) + campaign management
 * (draft composer modal, test send, send-to-confirmed with confirm guard). API calls go through
 * the host's api helpers (session cookie). The CSV arrives as a JSON field ({csv, filename})
 * because the sandbox cannot stream raw text bodies — the Blob download is built here.
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-newsletter) — the markup below only uses cf-*
 * classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";
import { useT } from "./i18n";

const STATUS_META = {
    pending: { labelKey: "status.pending", cls: "is-pending" },
    confirmed: { labelKey: "status.confirmed", cls: "is-confirmed" },
    unsubscribed: { labelKey: "status.unsubscribed", cls: "is-unsub" },
};

const FILTER_CHIPS = [
    { value: "", labelKey: "filter.all" },
    { value: "confirmed", labelKey: "filter.confirmed" },
    { value: "pending", labelKey: "filter.pending" },
    { value: "unsubscribed", labelKey: "filter.unsubscribed" },
];

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconSend = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="m22 2-11 11" />
        <path d="M22 2 15 22l-4-9-9-4Z" />
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
const IconUsers = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
);
const IconEnvelope = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m22 7-10 6L2 7" />
    </svg>
);

// Module-level (never define a component inside a component — remounting steals input focus).
function StatCard({ label, value, accent }) {
    return (
        <div className="cf-stat">
            <p className="cf-stat-label">{label}</p>
            <p className={`cf-stat-value ${accent || ""}`}>{value}</p>
        </div>
    );
}

function CampaignModal({ campaign, onClose, onSaved }) {
    const { t } = useT();
    const [subject, setSubject] = useState(campaign?.subject || "");
    const [bodyHtml, setBodyHtml] = useState(campaign?.body_html || "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const payload = { subject, body_html: bodyHtml };
            if (campaign?.id) payload.id = campaign.id;
            const saved = await apiPost("/plugin/newsletter/campaigns", payload);
            onSaved(saved);
        } catch (err) {
            setError(err?.message || t("modal.saveError"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="cf-overlay" onClick={onClose}>
            <div
                className="cf-letter"
                role="dialog"
                aria-modal="true"
                aria-label={campaign?.id ? t("modal.edit") : t("modal.new")}
                style={{ maxWidth: "42rem" }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="cf-letter-body">
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", marginBottom: "1.35rem" }}>
                        <h2 className="cf-editor-title" style={{ marginBottom: 0 }}>
                            <IconPen />
                            {campaign?.id ? t("modal.edit") : t("modal.new")}
                        </h2>
                        <button type="button" onClick={onClose} aria-label={t("common.close")} className="cf-iconbtn">✕</button>
                    </div>
                    <form onSubmit={save} style={{ display: "grid", gap: "1.15rem" }}>
                        <div>
                            <label className="cf-label" htmlFor="nl-subject">{t("modal.subject")}</label>
                            <input id="nl-subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("modal.subjectPlaceholder")} className="cf-input" required maxLength={300} />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="nl-body">{t("modal.body")}</label>
                            <textarea
                                id="nl-body"
                                value={bodyHtml}
                                onChange={(e) => setBodyHtml(e.target.value)}
                                placeholder={t("modal.bodyPlaceholder")}
                                className="cf-textarea"
                                required
                            />
                            <p className="cf-help">
                                {t("modal.help")}
                            </p>
                        </div>
                        {error && <div role="alert" className="cf-flash is-error" style={{ marginBottom: 0 }}>{error}</div>}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem" }}>
                            <button type="button" onClick={onClose} className="cf-btn-ghost">{t("common.cancel")}</button>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? t("modal.saving") : t("modal.saveDraft")}</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}

export default function NewsletterAdminPage() {
    const { t, locale } = useT();
    const [tab, setTab] = useState("subs"); // 'subs' | 'camps'
    const [subs, setSubs] = useState([]);
    const [stats, setStats] = useState({ total: 0, confirmed: 0, pending: 0, unsubscribed: 0 });
    const [statusFilter, setStatusFilter] = useState("");
    const [search, setSearch] = useState("");
    const [campaigns, setCampaigns] = useState([]);
    const [editing, setEditing] = useState(null); // null | {} (new) | campaign (edit)
    const [notice, setNotice] = useState(null);   // { kind: 'ok' | 'warn' | 'err', text }
    const [sendingId, setSendingId] = useState(null);
    const [mailError, setMailError] = useState(null); // last double opt-in mail failure (server-reported)

    const loadSubs = async () => {
        try {
            const params = new URLSearchParams();
            if (statusFilter) params.set("status", statusFilter);
            if (search.trim()) params.set("search", search.trim());
            const qs = params.toString();
            const data = await api(`/plugin/newsletter/subscribers${qs ? `?${qs}` : ""}`);
            setSubs(data.subscribers || []);
            setStats(data.stats || { total: 0, confirmed: 0, pending: 0, unsubscribed: 0 });
            setMailError(data.confirmMailError || null);
        } catch {
            setSubs([]);
        }
    };

    const loadCampaigns = async () => {
        try {
            const list = await api("/plugin/newsletter/campaigns");
            setCampaigns(Array.isArray(list) ? list : []);
        } catch {
            setCampaigns([]);
        }
    };

    // Debounced reload when the filter/search change.
    useEffect(() => {
        const timer = setTimeout(loadSubs, 250);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [statusFilter, search]);

    useEffect(() => {
        loadCampaigns();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const deleteSubscriber = async (id) => {
        if (!window.confirm(t("subs.confirmDelete"))) return;
        try {
            await apiDelete(`/plugin/newsletter/subscribers/${id}`);
            loadSubs();
        } catch (err) {
            setNotice({ kind: "err", text: err?.message || t("subs.deleteError") });
        }
    };

    const exportCsv = async () => {
        try {
            const data = await api("/plugin/newsletter/subscribers/export");
            const blob = new Blob([data.csv], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = data.filename || t("subs.csvName");
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            setNotice({ kind: "err", text: err?.message || t("subs.exportError") });
        }
    };

    const deleteCampaign = async (camp) => {
        if (!window.confirm(t("camps.confirmDelete", { subject: camp.subject }))) return;
        try {
            await apiDelete(`/plugin/newsletter/campaigns/${camp.id}`);
            loadCampaigns();
        } catch (err) {
            setNotice({ kind: "err", text: err?.message || t("camps.deleteError") });
        }
    };

    const sendTest = async (camp) => {
        const to = window.prompt(t("camps.testPrompt"));
        if (!to || !to.trim()) return;
        try {
            await apiPost(`/plugin/newsletter/campaigns/${camp.id}/test`, { to: to.trim() });
            setNotice({ kind: "ok", text: t("camps.testSent", { to: to.trim() }) });
        } catch (err) {
            setNotice({ kind: "warn", text: err?.message || t("camps.testError") });
        }
    };

    const sendCampaign = async (camp) => {
        const n = stats.confirmed || 0;
        if (n === 0) {
            setNotice({ kind: "warn", text: t("camps.noConfirmed") });
            return;
        }
        if (!window.confirm(t("camps.confirmSend", { subject: camp.subject, n }))) return;
        setSendingId(camp.id);
        setNotice(null);
        try {
            const r = await apiPost(`/plugin/newsletter/campaigns/${camp.id}/send`, {});
            setNotice({
                kind: "ok",
                text: t("camps.sent", { sent: r.sent, failed: r.failed ? t("camps.sentFailed", { n: r.failed }) : "" }),
            });
            loadCampaigns();
        } catch (err) {
            // The 502 mail-unavailable error surfaces here (apiPost throws with the server message).
            setNotice({ kind: "warn", text: err?.message || t("camps.sendError") });
            loadCampaigns();
        } finally {
            setSendingId(null);
        }
    };

    const fmtDate = (v) => {
        if (!v) return "—";
        const d = new Date(String(v).includes("T") ? v : `${v}Z`.replace(" ", "T"));
        return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(locale);
    };

    return (
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconSend /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">{t("app.subtitle")}</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {notice && (
                <div
                    role={notice.kind === "err" ? "alert" : "status"}
                    className={`cf-flash ${notice.kind === "ok" ? "is-ok" : notice.kind === "warn" ? "is-warn" : "is-error"}`}
                >
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" }}>
                        <span>{notice.text}</span>
                        <button type="button" className="cf-flash-x" onClick={() => setNotice(null)} aria-label={t("app.closeNotice")}>✕</button>
                    </div>
                </div>
            )}

            {mailError && (
                <div role="alert" className="cf-flash is-warn">
                    {t("app.mailError", { msg: mailError.message })}
                </div>
            )}

            {/* stat tiles */}
            <div className="cf-stats">
                <StatCard label={t("stats.total")} value={stats.total} />
                <StatCard label={t("filter.confirmed")} value={stats.confirmed} accent="is-ok" />
                <StatCard label={t("filter.pending")} value={stats.pending} accent="is-warn" />
                <StatCard label={t("filter.unsubscribed")} value={stats.unsubscribed} accent="is-muted" />
            </div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "subs"}
                    className={`cf-tab ${tab === "subs" ? "is-active" : ""}`}
                    onClick={() => setTab("subs")}
                >
                    {t("tab.subs")}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "camps"}
                    className={`cf-tab ${tab === "camps" ? "is-active" : ""}`}
                    onClick={() => setTab("camps")}
                >
                    {t("tab.camps")}
                </button>
            </div>

            {/* ============================== SUBSCRIBERS TAB ============================== */}
            {tab === "subs" && (
                <div className="cf-card-item">
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem", marginBottom: "1.15rem" }}>
                        <div className="cf-chips">
                            {FILTER_CHIPS.map((c) => (
                                <button
                                    key={c.value}
                                    type="button"
                                    aria-pressed={statusFilter === c.value}
                                    onClick={() => setStatusFilter(c.value)}
                                    className={`cf-chip-filter ${statusFilter === c.value ? "is-active" : ""}`}
                                >
                                    {t(c.labelKey)}
                                </button>
                            ))}
                        </div>
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={t("subs.searchPlaceholder")}
                            aria-label={t("subs.searchLabel")}
                            className="cf-input"
                            style={{ flex: 1, minWidth: "200px", width: "auto" }}
                        />
                        <button type="button" onClick={exportCsv} className="cf-btn-ghost">
                            <IconDownload /> {t("subs.exportCsv")}
                        </button>
                    </div>

                    {subs.length === 0 ? (
                        <div className="cf-empty">
                            <IconUsers />
                            <span>
                                {statusFilter || search ? t("subs.emptyFiltered") : t("subs.emptyNone")}
                            </span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table">
                                <thead>
                                    <tr>
                                        <th>{t("subs.colEmail")}</th>
                                        <th>{t("subs.colName")}</th>
                                        <th>{t("subs.colStatus")}</th>
                                        <th>{t("subs.colDate")}</th>
                                        <th style={{ width: "2.5rem" }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {subs.map((s) => {
                                        const meta = STATUS_META[s.status] || STATUS_META.pending;
                                        return (
                                            <tr key={s.id}>
                                                <td className="cf-cell-email">{s.email}</td>
                                                <td>{s.name || "—"}</td>
                                                <td>
                                                    <span className={`cf-pill ${meta.cls}`}>{t(meta.labelKey)}</span>
                                                </td>
                                                <td className="cf-cell-date">{fmtDate(s.created_at)}</td>
                                                <td style={{ textAlign: "right" }}>
                                                    <button
                                                        type="button"
                                                        onClick={() => deleteSubscriber(s.id)}
                                                        className="cf-btn-danger"
                                                    >
                                                        {t("common.delete")}
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ============================== CAMPAIGNS TAB ============================== */}
            {tab === "camps" && (
                <div className="cf-card-item">
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "1.15rem" }}>
                        <h2 className="cf-form-name">{t("camps.title")}</h2>
                        <button type="button" onClick={() => setEditing({})} className="cf-btn">
                            <IconPlus /> {t("camps.new")}
                        </button>
                    </div>

                    {campaigns.length === 0 ? (
                        <div className="cf-empty">
                            <IconEnvelope />
                            <span>{t("camps.empty")}</span>
                        </div>
                    ) : (
                        <div>
                            {campaigns.map((c) => (
                                <div key={c.id} className="cf-camp-row">
                                    <div style={{ flex: 1, minWidth: "200px" }}>
                                        <p className="cf-camp-subject">{c.subject}</p>
                                        <p className="cf-camp-meta">
                                            {c.status === "sent"
                                                ? t("camps.metaSent", { sent: c.sent_count, failed: c.fail_count ? t("camps.metaFailed", { n: c.fail_count }) : "", date: fmtDate(c.sent_at) })
                                                : t("camps.metaDraft", { date: fmtDate(c.created_at) })}
                                        </p>
                                    </div>
                                    <span className={`cf-pill ${c.status === "sent" ? "is-sent" : "is-draft"}`}>
                                        {c.status === "sent" ? t("camps.statusSent") : t("camps.statusDraft")}
                                    </span>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                                        {c.status === "draft" && (
                                            <button type="button" onClick={() => setEditing(c)} className="cf-btn-ghost">
                                                <IconPen /> {t("common.edit")}
                                            </button>
                                        )}
                                        <button type="button" onClick={() => sendTest(c)} className="cf-btn-ghost">
                                            <IconSend /> {t("camps.sendTest")}
                                        </button>
                                        {c.status === "draft" && (
                                            <button
                                                type="button"
                                                onClick={() => sendCampaign(c)}
                                                disabled={sendingId === c.id}
                                                className="cf-btn"
                                            >
                                                <IconSend /> {sendingId === c.id ? t("camps.sending") : t("camps.sendTo", { n: stats.confirmed })}
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => deleteCampaign(c)}
                                            className="cf-btn-danger"
                                        >
                                            {t("common.delete")}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <p className="cf-footnote">
                        {t("camps.footnote1")}<strong>{t("camps.footnoteStrong")}</strong>{t("camps.footnote2")}
                    </p>
                </div>
            )}

            {editing !== null && (
                <CampaignModal
                    campaign={editing.id ? editing : null}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        setNotice({ kind: "ok", text: t("camps.saved") });
                        loadCampaigns();
                    }}
                />
            )}
        </div>
    );
}

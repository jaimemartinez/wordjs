// @ts-nocheck
"use client";

/**
 * Admin page for the Polls plugin (/admin/plugin/polls).
 * Lists every poll (status pill, total votes, inline mini result bars) with open/close, edit and
 * delete actions, plus a create/edit modal (question, dynamic option rows, results-visibility).
 * API calls go through the host's api helpers (session cookie).
 *
 * Visual identity (premium/modern) lives in the plugin's OWN stylesheet (client/admin/admin.css,
 * injected by the host admin shell and scoped to .plugin-admin-polls) — the markup below only
 * uses cf-* classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";
import { useT } from "./i18n";

// Labels are looked up through `t` at render time so they follow the admin's language;
// an unknown mode falls back to the "after" label, as before.
const SHOW_RESULTS_MODES = ["after", "always", "never"];
const showResultsLabel = (t, mode) => t(`showResults.${SHOW_RESULTS_MODES.includes(mode) ? mode : "after"}`);
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12;

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconChart = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M3 3v18h18" />
        <path d="M7 16v-5" />
        <path d="M12 16V8" />
        <path d="M17 16v-3" />
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
const IconLock = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
);
const IconUnlock = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
);

// Module-level (never define a component inside a component — remounting steals input focus).
function MiniBars({ poll }) {
    const total = Number(poll.total) || 0;
    return (
        <div className="cf-minibars">
            {(poll.options || []).map((o) => {
                const count = Number((poll.results || {})[o.id]) || 0;
                const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                return (
                    <div key={o.id} className="cf-minibar-row">
                        <span className="cf-minibar-label" title={o.label}>{o.label}</span>
                        <div className="cf-minibar-track">
                            <div className="cf-minibar-fill" style={{ width: pct + "%" }} />
                        </div>
                        <span className="cf-minibar-value">{pct}% ({count})</span>
                    </div>
                );
            })}
        </div>
    );
}

function PollModal({ initial, onClose, onSaved }) {
    const { t } = useT();
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
        if (!q) { setError(t("form.errQuestion")); return; }
        const cleaned = options.map((o) => ({ id: o.id, label: String(o.label || "").trim() }));
        if (cleaned.some((o) => !o.label)) { setError(t("form.errOptionText")); return; }
        if (cleaned.length < MIN_OPTIONS) { setError(t("form.errMinOptions", { min: MIN_OPTIONS })); return; }
        setBusy(true);
        try {
            const body = { question: q, options: cleaned, show_results: showResults };
            if (initial && initial.id) body.id = initial.id;
            await apiPost("/plugin/polls/save", body);
            onSaved();
        } catch (err) {
            setError(err?.message || t("form.saveError"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="cf-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <form
                onSubmit={save}
                className="cf-letter"
                role="dialog"
                aria-modal="true"
                aria-label={initial && initial.id ? t("form.editTitle") : t("form.newTitle")}
            >
                <div className="cf-letter-body">
                    <h2 className="cf-editor-title">
                        <IconPen />
                        {initial && initial.id ? t("form.editTitle") : t("form.newTitle")}
                    </h2>

                    <div>
                        <label className="cf-label" htmlFor="cf-poll-question">{t("form.question")}</label>
                        <input id="cf-poll-question" type="text" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t("form.questionPh")} className="cf-input" required />
                    </div>

                    <div style={{ marginTop: "1.15rem" }}>
                        <span className="cf-label">{t("form.options", { count: options.length, max: MAX_OPTIONS })}</span>
                        <div>
                            {options.map((o, i) => (
                                <div key={o.id != null ? "opt-" + o.id : "new-" + i} className="cf-option-row">
                                    <input
                                        type="text"
                                        value={o.label}
                                        onChange={(e) => setOptionLabel(i, e.target.value)}
                                        placeholder={t("form.option", { n: i + 1 })}
                                        aria-label={t("form.option", { n: i + 1 })}
                                        className="cf-input"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => removeOption(i)}
                                        disabled={options.length <= MIN_OPTIONS}
                                        className="cf-iconbtn is-danger"
                                        title={t("form.removeOption")}
                                        aria-label={t("form.removeOption")}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                        {options.length < MAX_OPTIONS && (
                            <button type="button" onClick={addOption} className="cf-btn-ghost" style={{ marginTop: "0.7rem" }}>
                                <IconPlus /> {t("form.addOption")}
                            </button>
                        )}
                        {initial && initial.id ? (
                            <p className="cf-help">
                                {t("form.editHelp")}
                            </p>
                        ) : null}
                    </div>

                    <div style={{ marginTop: "1.15rem" }}>
                        <label className="cf-label" htmlFor="cf-poll-show-results">{t("form.showResults")}</label>
                        <select id="cf-poll-show-results" value={showResults} onChange={(e) => setShowResults(e.target.value)} className="cf-select">
                            <option value="after">{showResultsLabel(t, "after")}</option>
                            <option value="always">{showResultsLabel(t, "always")}</option>
                            <option value="never">{showResultsLabel(t, "never")}</option>
                        </select>
                    </div>

                    {error && <div role="alert" className="cf-flash is-error" style={{ margin: "1.15rem 0 0" }}>{error}</div>}

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.4rem" }}>
                        <button type="button" onClick={onClose} disabled={busy} className="cf-btn-ghost">{t("common.cancel")}</button>
                        <button type="submit" disabled={busy} className="cf-btn">{busy ? t("common.saving") : t("common.save")}</button>
                    </div>
                </div>
            </form>
        </div>
    );
}

export default function PollsAdminPage() {
    const { t } = useT();
    const [polls, setPolls] = useState(null); // null = loading
    const [modal, setModal] = useState(null); // null = closed, {} = new, {poll} = edit
    const [message, setMessage] = useState("");
    const [busyId, setBusyId] = useState(null);

    const load = async () => {
        try {
            setPolls(await api("/plugin/polls/list"));
        } catch (err) {
            setPolls([]);
            setMessage(t("msg.loadError", { msg: err?.message || err }));
        }
    };
    useEffect(() => { load(); }, []);

    const toggle = async (poll) => {
        setBusyId(poll.id); setMessage("");
        try {
            await apiPost(`/plugin/polls/${poll.id}/toggle`, {});
            await load();
        } catch (err) {
            setMessage(t("msg.error", { msg: err?.message || err }));
        } finally {
            setBusyId(null);
        }
    };

    const remove = async (poll) => {
        if (typeof window !== "undefined" && !window.confirm(t("msg.deleteConfirm", { question: poll.question }))) return;
        setBusyId(poll.id); setMessage("");
        try {
            await apiDelete(`/plugin/polls/${poll.id}`);
            await load();
        } catch (err) {
            setMessage(t("msg.error", { msg: err?.message || err }));
        } finally {
            setBusyId(null);
        }
    };

    return (
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconChart /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">
                        {t("app.subtitle")}
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                <button type="button" onClick={() => setModal({})} className="cf-btn"><IconPlus /> {t("app.newPoll")}</button>
            </div>

            {message && <div role="alert" className="cf-flash is-error">{message}</div>}

            {polls === null ? (
                <div className="cf-empty">
                    <span>{t("list.loading")}</span>
                </div>
            ) : polls.length === 0 ? (
                <div className="cf-empty">
                    <IconChart />
                    <span>{t("list.empty")}</span>
                </div>
            ) : (
                <div>
                    {polls.map((p) => (
                        <div key={p.id} className="cf-card-item">
                            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
                                        <h2 className="cf-form-name" style={{ wordBreak: "break-word" }}>{p.question}</h2>
                                        <span className={`cf-pill ${Number(p.is_open) ? "is-open" : "is-closed"}`}>
                                            {Number(p.is_open) ? t("status.open") : t("status.closed")}
                                        </span>
                                    </div>
                                    <p className="cf-meta">
                                        {t(p.total === 1 ? "meta.votes.one" : "meta.votes.other", { n: p.total })} · {t("meta.results", { mode: showResultsLabel(t, p.show_results) })}
                                    </p>
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
                                    <button type="button" onClick={() => toggle(p)} disabled={busyId === p.id} className="cf-btn-ghost">
                                        {Number(p.is_open) ? <IconLock /> : <IconUnlock />}
                                        {Number(p.is_open) ? t("action.close") : t("action.open")}
                                    </button>
                                    <button type="button" onClick={() => setModal(p)} disabled={busyId === p.id} className="cf-btn-ghost">
                                        <IconPen /> {t("common.edit")}
                                    </button>
                                    <button type="button" onClick={() => remove(p)} disabled={busyId === p.id} className="cf-btn-danger">
                                        {t("common.delete")}
                                    </button>
                                </div>
                            </div>
                            <MiniBars poll={p} />
                            <p className="cf-usage">
                                {t("usage.p1")} <strong>Polls</strong> {t("usage.p2")} <strong>{p.id}</strong>{t("usage.p3")}
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

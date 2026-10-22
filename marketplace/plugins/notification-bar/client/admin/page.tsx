// @ts-nocheck
"use client";

/**
 * Admin page for the Notification Bar plugin (/admin/plugin/announcement).
 * One form over the single 'notification_bar_config' option: message + CTA, colors,
 * position, dismissal, schedule window, and a "reprompt" checkbox that bumps the config
 * version so visitors who dismissed the bar see it again. Includes a live inline preview.
 *
 * Visual identity (premium/modern) lives in the plugin's OWN stylesheet
 * (client/admin/admin.css, injected by the host admin shell and scoped to
 * .plugin-admin-announcement) — the markup below only uses cf-* classes plus
 * sparse inline styles for one-off layout.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";
import { useT } from "./i18n";

const DEFAULT_CONFIG = {
    enabled: false,
    message: "",
    linkLabel: "",
    linkUrl: "",
    bgColor: "#111827",
    textColor: "#ffffff",
    position: "top",
    dismissible: true,
    starts_at: "",
    ends_at: "",
    version: 1,
};

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconMegaphone = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="m3 11 18-5v12L3 14v-3z" />
        <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
);
const IconX = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M18 6 6 18M6 6l12 12" />
    </svg>
);

export default function NotificationBarAdminPage() {
    const { t } = useT();
    const [cfg, setCfg] = useState(DEFAULT_CONFIG);
    const [reprompt, setReprompt] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [message, setMessage] = useState("");
    // Error styling is decided by this flag, not by matching the (translated) message text.
    const [messageIsError, setMessageIsError] = useState(false);

    const set = (patch) => setCfg((c) => ({ ...c, ...patch }));

    useEffect(() => {
        (async () => {
            try {
                const c = await api("/plugin/notification-bar/config");
                setCfg({ ...DEFAULT_CONFIG, ...c });
            } catch {
                setMessageIsError(true);
                setMessage(t("msg.loadError"));
            } finally {
                setLoaded(true);
            }
        })();
    }, []);

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        setMessageIsError(false);
        try {
            const saved = await apiPost("/plugin/notification-bar/config", { ...cfg, reprompt });
            setCfg({ ...DEFAULT_CONFIG, ...saved });
            const bumped = reprompt;
            setReprompt(false);
            setMessageIsError(false);
            setMessage(bumped
                ? t("msg.savedReprompt", { version: saved.version })
                : t("msg.saved"));
        } catch (err) {
            setMessageIsError(true);
            setMessage(t("msg.saveError", { msg: err?.message || err }));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconMegaphone /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">
                        {t("app.subtitle")}
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* Live preview reflecting the current (unsaved) form values */}
            <div className="cf-preview-head">
                <span className="cf-label" style={{ marginBottom: 0 }}>{t("preview.label", { where: cfg.position === "bottom" ? t("preview.bottom") : t("preview.top") })}</span>
                <span className={`cf-status-pill ${cfg.enabled ? "is-on" : "is-off"}`}>
                    {cfg.enabled ? t("status.on") : t("status.off")}
                </span>
            </div>
            <div className="cf-preview-shell">
                <div
                    className="cf-preview-bar"
                    style={{ backgroundColor: cfg.bgColor, color: cfg.textColor }}
                >
                    <span>
                        {cfg.message || t("preview.empty")}
                        {cfg.linkUrl && cfg.linkLabel ? (
                            <span className="cf-preview-link">{cfg.linkLabel}</span>
                        ) : null}
                    </span>
                    {cfg.dismissible ? (
                        <span className="cf-preview-close" aria-hidden="true"><IconX /></span>
                    ) : null}
                </div>
            </div>

            {/* the editor: one featured surface with an accent crown */}
            <form onSubmit={save} className="cf-editor">
                <div className="cf-editor-body" style={{ display: "grid", gap: "1.2rem" }}>
                    <label className="cf-check">
                        <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                        {t("form.enabled")}
                    </label>

                    <div>
                        <label className="cf-label" htmlFor="nb-message">{t("form.message")}</label>
                        <textarea
                            id="nb-message"
                            value={cfg.message}
                            onChange={(e) => set({ message: e.target.value })}
                            maxLength={300}
                            rows={2}
                            placeholder={t("form.messagePlaceholder")}
                            className="cf-input"
                        />
                        <p className="cf-counter">{(cfg.message || "").length}/300</p>
                    </div>

                    <div className="cf-grid">
                        <div>
                            <label className="cf-label" htmlFor="nb-link-label">{t("form.linkLabel")}</label>
                            <input id="nb-link-label" type="text" value={cfg.linkLabel} onChange={(e) => set({ linkLabel: e.target.value })} maxLength={60} placeholder={t("form.linkLabelPlaceholder")} className="cf-input" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="nb-link-url">{t("form.linkUrl")}</label>
                            <input id="nb-link-url" type="text" value={cfg.linkUrl} onChange={(e) => set({ linkUrl: e.target.value })} placeholder={t("form.linkUrlPlaceholder")} className="cf-input" />
                        </div>
                    </div>

                    <div className="cf-grid-3">
                        <div>
                            <label className="cf-label" htmlFor="nb-bg">{t("form.bgColor")}</label>
                            <div className="cf-color-row">
                                <input id="nb-bg" type="color" value={cfg.bgColor} onChange={(e) => set({ bgColor: e.target.value })} className="cf-color-input" />
                                <span className="cf-color-code">{cfg.bgColor}</span>
                            </div>
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="nb-text">{t("form.textColor")}</label>
                            <div className="cf-color-row">
                                <input id="nb-text" type="color" value={cfg.textColor} onChange={(e) => set({ textColor: e.target.value })} className="cf-color-input" />
                                <span className="cf-color-code">{cfg.textColor}</span>
                            </div>
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="nb-position">{t("form.position")}</label>
                            <select id="nb-position" value={cfg.position} onChange={(e) => set({ position: e.target.value })} className="cf-select">
                                <option value="top">{t("form.posTop")}</option>
                                <option value="bottom">{t("form.posBottom")}</option>
                            </select>
                        </div>
                    </div>

                    <label className="cf-check">
                        <input type="checkbox" checked={cfg.dismissible} onChange={(e) => set({ dismissible: e.target.checked })} />
                        {t("form.dismissible")}
                    </label>

                    <div className="cf-grid">
                        <div>
                            <label className="cf-label" htmlFor="nb-starts">{t("form.startsAt")}</label>
                            <input id="nb-starts" type="datetime-local" value={cfg.starts_at} onChange={(e) => set({ starts_at: e.target.value })} className="cf-input" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="nb-ends">{t("form.endsAt")}</label>
                            <input id="nb-ends" type="datetime-local" value={cfg.ends_at} onChange={(e) => set({ ends_at: e.target.value })} className="cf-input" />
                        </div>
                    </div>
                    {(cfg.starts_at || cfg.ends_at) ? (
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "-0.6rem" }}>
                            <button type="button" onClick={() => set({ starts_at: "", ends_at: "" })} className="cf-link-clear">
                                <IconX /> {t("form.clearSchedule")}
                            </button>
                        </div>
                    ) : null}

                    <div className="cf-nested-panel">
                        <label className="cf-check">
                            <input type="checkbox" checked={reprompt} onChange={(e) => setReprompt(e.target.checked)} />
                            <span>
                                <span className="cf-nested-title">{t("form.reprompt")}</span>
                                <span className="cf-help">
                                    {t("form.repromptHelp", { version: cfg.version })}
                                </span>
                            </span>
                        </label>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem" }}>
                        <button type="submit" className="cf-btn" disabled={busy || !loaded}>{busy ? t("common.saving") : t("common.save")}</button>
                    </div>

                    {message && (
                        <div
                            role={messageIsError ? "alert" : "status"}
                            className={`cf-flash ${messageIsError ? "is-error" : "is-ok"}`}
                            style={{ marginBottom: 0 }}
                        >
                            {message}
                        </div>
                    )}
                </div>
            </form>

            <p className="cf-footnote">
                {t("footnote")}
            </p>
        </div>
    );
}

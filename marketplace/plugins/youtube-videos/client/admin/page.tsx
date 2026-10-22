// @ts-nocheck
"use client";

/**
 * Admin page for the YouTube Videos plugin (/admin/plugin/youtube).
 * Configure the channel (+ optional Data API key for full history), force a refresh, and preview
 * what the carousel will serve. API calls go through the host's api helpers (session cookie).
 *
 * Visual identity (premium/modern) lives in the plugin's OWN stylesheet (client/admin/admin.css,
 * injected by the host admin shell and scoped to .plugin-admin-youtube) — markup uses cf-* classes.
 */
import React, { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";
import { useT } from "./i18n";

const YoutubeIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.517 3.545 12 3.545 12 3.545s-7.517 0-9.388.508a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11c1.871.508 9.388.508 9.388.508s7.517 0 9.388-.508a3.003 3.003 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
  </svg>
);

const SyncIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
  </svg>
);

const SaveIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
    <polyline points="17 21 17 13 7 13 7 21"/>
    <polyline points="7 3 7 8 15 8"/>
  </svg>
);

const ExclamationIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const InfoIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="16" x2="12" y2="12"/>
    <line x1="12" y1="8" x2="12.01" y2="8"/>
  </svg>
);

const CalendarIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/>
    <line x1="8" y1="2" x2="8" y2="6"/>
    <line x1="3" y1="10" x2="21" y2="10"/>
  </svg>
);

export default function YoutubeVideosAdminPage() {
    const { t, locale } = useT();
    const [status, setStatus] = useState(null);
    const [channel, setChannel] = useState("");
    const [apiKey, setApiKey] = useState("");      // write-only: never echoed back by the server
    const [clearKey, setClearKey] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [preview, setPreview] = useState([]);
    const [cacheTtl, setCacheTtl] = useState(30);

    const handleImageError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
        const img = e.currentTarget;
        if (img.src.includes("maxresdefault.jpg")) {
            img.src = img.src.replace("maxresdefault.jpg", "sddefault.jpg");
        } else if (img.src.includes("sddefault.jpg")) {
            img.src = img.src.replace("sddefault.jpg", "hqdefault.jpg");
        } else {
            img.onerror = null;
        }
    };

    const loadStatus = async () => {
        try {
            const s = await api("/plugin/youtube-videos/status");
            setStatus(s);
            setChannel(s.channel || "");
            setCacheTtl(s.cacheTtl || 30);
        } catch {
            setStatus(null);
        }
    };
    const loadPreview = async () => {
        try {
            const res = await fetch("/api/v1/plugin/youtube-videos/?limit=8");
            const data = res.ok ? await res.json() : null;
            setPreview((data && data.videos) || []);
        } catch {
            setPreview([]);
        }
    };

    useEffect(() => { loadStatus(); loadPreview(); }, []);

    const save = async (e) => {
        e.preventDefault();
        setBusy(true); setMessage("");
        try {
            const body = { channel, cacheTtl };
            if (clearKey) body.apiKey = "";
            else if (apiKey.trim()) body.apiKey = apiKey.trim();
            const s = await apiPost("/plugin/youtube-videos/settings", body);
            setStatus(s); setApiKey(""); setClearKey(false);
            setMessage(s.error ? t("msg.savedButFailed", { error: s.error }) : t("msg.saved", { count: s.videoCount, mode: s.mode === "api" ? t("msg.modeApi") : t("msg.modeRss") }));
            loadPreview();
        } catch (err) {
            setMessage(t("msg.saveError", { msg: err?.message || err }));
        } finally {
            setBusy(false);
        }
    };

    const refresh = async () => {
        setBusy(true); setMessage("");
        try {
            const s = await apiPost("/plugin/youtube-videos/refresh", {});
            setStatus(s);
            setMessage(s.error ? t("msg.loadFailed", { error: s.error }) : t("msg.refreshed", { count: s.videoCount }));
            loadPreview();
        } catch (err) {
            setMessage(t("msg.error", { msg: err?.message || err }));
        } finally {
            setBusy(false);
        }
    };

    // Matches the failure messages in es ("falló", "Error"), en ("failed", "Error") and pt ("falhou", "Erro").
    const isErrorMsg = /falló|failed|falhou|Erro/i.test(message);

    return (
        <div className="cf-shell">
            {/* header */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><YoutubeIcon /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">{t("app.subtitle")}</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            <div className="cf-layout">
                {/* configuration form */}
                <form onSubmit={save} className="cf-editor">
                    <div className="cf-editor-body">
                        <h2 className="cf-editor-title"><SyncIcon /> {t("form.title")}</h2>

                        <div className="cf-grid">
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="yt-channel">{t("form.channel")}</label>
                                <input id="yt-channel" type="text" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder={t("form.channelPh")} className="cf-input" required />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="yt-ttl">{t("form.ttl")}</label>
                                <input id="yt-ttl" type="number" min="1" value={cacheTtl} onChange={(e) => setCacheTtl(Math.max(1, parseInt(e.target.value, 10) || 1))} placeholder="30" className="cf-input" required />
                                <p className="cf-help">
                                    {t("form.ttlHelp")}
                                </p>
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="yt-key">{t("form.apiKey")}</label>
                                <input id="yt-key" type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setClearKey(false); }} placeholder={status?.hasApiKey ? t("form.apiKeyPhSet") : t("form.apiKeyPhUnset")} className="cf-input" autoComplete="new-password" />

                                <div className="cf-note">
                                    <InfoIcon />
                                    <span>
                                        {t("form.apiKeyNote")}
                                    </span>
                                </div>

                                {status?.hasApiKey && (
                                    <label className="cf-check" style={{ marginTop: "0.5rem" }}>
                                        <input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setApiKey(""); }} />
                                        <span>{t("form.clearKey")}</span>
                                    </label>
                                )}
                            </div>
                        </div>

                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                            <button type="button" onClick={refresh} disabled={busy} className="cf-btn-ghost">
                                <SyncIcon className={busy ? "cf-spin" : ""} />
                                {t("form.refresh")}
                            </button>
                            <button type="submit" disabled={busy} className="cf-btn">
                                <SaveIcon />
                                {busy ? t("common.saving") : t("common.save")}
                            </button>
                        </div>

                        {message && (
                            <div role={isErrorMsg ? "alert" : "status"} className={`cf-flash ${isErrorMsg ? "is-error" : "is-ok"}`} style={{ marginTop: "1.25rem", marginBottom: 0, display: "flex", alignItems: "center", gap: "0.6rem" }}>
                                {isErrorMsg && <ExclamationIcon style={{ width: "1rem", height: "1rem", flexShrink: 0 }} />}
                                <span>{message}</span>
                            </div>
                        )}
                    </div>
                </form>

                {/* status card */}
                <div className="cf-card-item">
                    <h3 className="cf-panel-title">{t("status.title")}</h3>
                    {status ? (
                        <dl className="cf-stat-list">
                            <div className="cf-stat-row">
                                <dt className="cf-stat-key">{t("status.videos")}</dt>
                                <dd className="cf-stat-val">{status.videoCount}</dd>
                            </div>
                            <div className="cf-stat-row">
                                <dt className="cf-stat-key">{t("status.mode")}</dt>
                                <dd>
                                    <span className={`cf-pill ${status.mode === "api" ? "is-accent" : ""}`}>
                                        {status.mode === "api" ? t("status.modeApi") : t("status.modeRss")}
                                    </span>
                                </dd>
                            </div>
                            <div className="cf-stat-row">
                                <dt className="cf-stat-key">{t("status.lastUpdate")}</dt>
                                <dd className="cf-stat-val">
                                    <CalendarIcon style={{ width: "0.85rem", height: "0.85rem" }} />
                                    {status.fetchedAt ? new Date(status.fetchedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : t("status.never")}
                                </dd>
                            </div>
                        </dl>
                    ) : (
                        <div className="cf-note">
                            <ExclamationIcon />
                            <span>{t("status.loading")}</span>
                        </div>
                    )}
                    {status?.error && (
                        <div className="cf-note is-warn">
                            <ExclamationIcon />
                            <span>{t("status.lastError", { error: status.error })}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* video preview section */}
            <div className="cf-card-item" style={{ marginTop: "1rem" }}>
                <h3 className="cf-editor-title" style={{ marginBottom: "1.35rem" }}>
                    <YoutubeIcon style={{ width: "1.05rem", height: "1.05rem" }} />
                    <span>{t("preview.title")}</span>
                    {preview.length > 0 && <span className="cf-pill is-ok">{t("preview.cached")}</span>}
                </h3>
                {preview.length === 0 ? (
                    <div className="cf-empty">
                        <YoutubeIcon />
                        <span>{t("preview.empty")}</span>
                    </div>
                ) : (
                    <div className="cf-video-grid">
                        {preview.map((v) => (
                            <a key={v.id} href={v.url} target="_blank" rel="noopener noreferrer" className="cf-video">
                                <div className="cf-video-thumb">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={v.thumb} alt={v.title} onError={handleImageError} />
                                </div>
                                <p className="cf-video-title">{v.title}</p>
                            </a>
                        ))}
                    </div>
                )}

                <div className="cf-note" style={{ marginTop: "1.5rem" }}>
                    <InfoIcon />
                    <span>
                        {t("preview.note.before")} <strong>YoutubeVideos</strong> {t("preview.note.after")}
                    </span>
                </div>
            </div>
        </div>
    );
}

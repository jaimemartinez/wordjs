// @ts-nocheck
"use client";

/**
 * Admin page for the YouTube Videos plugin (/admin/plugin/youtube).
 *
 * Three tabs:
 *  - Library: the whole cached list, searchable (include / exclude words), sortable and paged with
 *    "Load more" — the same public endpoint and filters the Verso block uses, so what you see here is
 *    what a block with those options shows.
 *  - Settings: channel, video source (Data API key, keyless full list on/off) and cache interval.
 *  - Use on a page: how to place the block and what its options do.
 * A status strip on top shows the count, the source, the last update and — while the channel is
 * read in the background — the progress, polled until it finishes.
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the host
 * admin shell and scoped to .plugin-admin-youtube) — markup uses cf-* classes.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, apiPost } from "@/lib/api";
import { useT } from "./i18n";

const Svg = ({ children, ...props }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>
);
const YoutubeIcon = (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
        <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.11C19.517 3.545 12 3.545 12 3.545s-7.517 0-9.388.508a3.003 3.003 0 0 0-2.11 2.11C0 8.033 0 12 0 12s0 3.967.502 5.837a3.003 3.003 0 0 0 2.11 2.11c1.871.508 9.388.508 9.388.508s7.517 0 9.388-.508a3.003 3.003 0 0 0 2.11-2.11C24 15.967 24 12 24 12s0-3.967-.502-5.837zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
    </svg>
);
const SyncIcon = (p) => <Svg {...p}><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></Svg>;
const SaveIcon = (p) => <Svg {...p}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></Svg>;
const AlertIcon = (p) => <Svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></Svg>;
const InfoIcon = (p) => <Svg {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></Svg>;
const SearchIcon = (p) => <Svg {...p}><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></Svg>;
const LinkIcon = (p) => <Svg {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></Svg>;
const GridIcon = (p) => <Svg {...p}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></Svg>;
const GearIcon = (p) => <Svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></Svg>;
const BlockIcon = (p) => <Svg {...p}><path d="M12 2l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/></Svg>;

const ENDPOINT = "/api/v1/plugin/youtube-videos/";

function thumbFallback(e) {
    const img = e.currentTarget;
    if (img.src.includes("maxresdefault.jpg")) img.src = img.src.replace("maxresdefault.jpg", "sddefault.jpg");
    else if (img.src.includes("sddefault.jpg")) img.src = img.src.replace("sddefault.jpg", "hqdefault.jpg");
    else img.onerror = null;
}

/** Debounce a value (search inputs). */
function useDebounced(value, ms) {
    const [v, setV] = useState(value);
    useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
    return v;
}

// ---- status strip ---------------------------------------------------------------------------------
function StatusStrip({ status, t, locale, busy, onRefresh, onResync }) {
    const sourceLabel = !status ? "—" : status.mode === "api" ? t("source.api") : status.mode === "rss" ? t("source.rss") : t("source.full");
    return (
        <div className="cf-card-item ytv-strip">
            <dl className="ytv-strip-stats">
                <div><dt>{t("stat.videos")}</dt><dd className="ytv-strip-big">{status ? status.videoCount.toLocaleString(locale) : "—"}</dd></div>
                <div><dt>{t("stat.source")}</dt><dd><span className={`cf-pill ${status?.mode === "rss" ? "is-warn" : "is-accent"}`}>{sourceLabel}</span></dd></div>
                <div><dt>{t("stat.updated")}</dt><dd>{status?.fetchedAt ? new Date(status.fetchedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : t("stat.never")}</dd></div>
            </dl>
            <div className="ytv-strip-actions">
                <button type="button" onClick={onResync} disabled={busy || status?.refreshing} className="cf-btn-ghost" title={t("action.resyncHelp")}>
                    {t("action.resync")}
                </button>
                <button type="button" onClick={onRefresh} disabled={busy || status?.refreshing} className="cf-btn">
                    <SyncIcon className={busy || status?.refreshing ? "cf-spin" : ""} />
                    {t("action.refresh")}
                </button>
            </div>
            {status?.refreshing && (
                <div className="ytv-strip-note" role="status">
                    <span className="ytv-progress" aria-hidden="true"><span /></span>
                    {t("stat.syncing", { count: (status.progress || status.videoCount || 0).toLocaleString(locale) })}
                </div>
            )}
            {!status?.refreshing && status?.partial && (
                <div className="cf-note is-warn ytv-strip-note"><AlertIcon /><span>{t("stat.partial")}</span></div>
            )}
            {status?.error && (
                <div className="cf-note is-warn ytv-strip-note"><AlertIcon /><span>{t("msg.lastError", { error: status.error })}</span></div>
            )}
        </div>
    );
}

// ---- library --------------------------------------------------------------------------------------
function Library({ t, locale, version, onGoSettings }) {
    const [q, setQ] = useState("");
    const [exclude, setExclude] = useState("");
    const [order, setOrder] = useState("newest");
    const [perPage, setPerPage] = useState(24);
    const [items, setItems] = useState([]);
    const [total, setTotal] = useState(0);
    const [nextOffset, setNextOffset] = useState(null);
    const [loading, setLoading] = useState(true);
    const [copied, setCopied] = useState("");
    const dq = useDebounced(q, 250);
    const dx = useDebounced(exclude, 250);
    const req = useRef(0);

    const load = useCallback(async (offset) => {
        const id = ++req.current;
        setLoading(true);
        const p = new URLSearchParams({ limit: String(perPage), offset: String(offset), order });
        if (dq.trim()) p.set("q", dq.trim());
        if (dx.trim()) p.set("exclude", dx.trim());
        try {
            const res = await fetch(`${ENDPOINT}?${p}`);
            const data = res.ok ? await res.json() : null;
            if (id !== req.current) return;
            const videos = (data && data.videos) || [];
            setItems((prev) => (offset === 0 ? videos : [...prev, ...videos]));
            setTotal((data && data.total) || 0);
            setNextOffset(data && data.nextOffset != null ? data.nextOffset : null);
        } catch {
            if (id === req.current && offset === 0) { setItems([]); setTotal(0); setNextOffset(null); }
        } finally {
            if (id === req.current) setLoading(false);
        }
    }, [dq, dx, order, perPage]);

    useEffect(() => { load(0); }, [load, version]);

    const filtering = !!(dq.trim() || dx.trim());
    const copy = async (v) => {
        try { await navigator.clipboard.writeText(v.url); setCopied(v.id); setTimeout(() => setCopied(""), 1500); } catch { /* clipboard blocked */ }
    };

    return (
        <div className="cf-card-item">
            <div className="ytv-toolbar">
                <label className="ytv-search">
                    <SearchIcon />
                    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("lib.search")} aria-label={t("lib.search")} className="cf-input" />
                </label>
                <input type="search" value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder={t("lib.exclude")} aria-label={t("lib.exclude")} className="cf-input ytv-exclude" />
                <select value={order} onChange={(e) => setOrder(e.target.value)} className="cf-select" aria-label={t("lib.order")}>
                    <option value="newest">{t("order.newest")}</option>
                    <option value="oldest">{t("order.oldest")}</option>
                    <option value="title">{t("order.title")}</option>
                </select>
                <select value={perPage} onChange={(e) => setPerPage(parseInt(e.target.value, 10))} className="cf-select" aria-label={t("lib.perPage")}>
                    {[12, 24, 48, 96].map((n) => <option key={n} value={n}>{n} / {t("lib.perPage").toLowerCase()}</option>)}
                </select>
            </div>

            <div className="ytv-count" aria-live="polite">
                {total > 0 && <span>{t("lib.showing", { shown: items.length.toLocaleString(locale), total: total.toLocaleString(locale) })}</span>}
                {filtering && total > 0 && <span className="cf-pill is-accent">{t("lib.filtered", { total: total.toLocaleString(locale) })}</span>}
                {filtering && <button type="button" className="ytv-linkbtn" onClick={() => { setQ(""); setExclude(""); }}>{t("lib.clear")}</button>}
            </div>

            {items.length === 0 && !loading ? (
                <div className="cf-empty">
                    <YoutubeIcon />
                    <span>{filtering ? t("lib.noMatch") : t("lib.empty")}</span>
                    {!filtering && <button type="button" className="cf-btn-ghost" onClick={onGoSettings}><GearIcon /> {t("tab.settings")}</button>}
                </div>
            ) : (
                <div className="cf-video-grid">
                    {items.map((v) => (
                        <div key={v.id} className="cf-video ytv-card">
                            <a href={v.url} target="_blank" rel="noopener noreferrer" className="cf-video-thumb" title={t("lib.open")}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={v.thumb} alt="" loading="lazy" decoding="async" onError={thumbFallback} />
                            </a>
                            <a href={v.url} target="_blank" rel="noopener noreferrer" className="cf-video-title">{v.title}</a>
                            <div className="ytv-card-meta">
                                <span>{v.publishedAt ? new Date(v.publishedAt).toLocaleDateString(locale, { dateStyle: "medium" }) : (v.publishedText || "")}</span>
                                <button type="button" className="ytv-iconbtn" onClick={() => copy(v)} aria-label={t("lib.copy")} title={copied === v.id ? t("lib.copied") : t("lib.copy")}>
                                    {copied === v.id ? "✓" : <LinkIcon />}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {(nextOffset != null || (loading && items.length > 0)) && (
                <div className="ytv-more">
                    <button type="button" className="cf-btn-ghost" disabled={loading} onClick={() => load(nextOffset)}>
                        {loading ? t("lib.loading") : t("lib.loadMore")}
                    </button>
                </div>
            )}
            {loading && items.length === 0 && <div className="cf-empty"><SyncIcon className="cf-spin" /><span>{t("lib.loading")}</span></div>}
        </div>
    );
}

// ---- settings -------------------------------------------------------------------------------------
function Settings({ t, status, onSaved }) {
    const [channel, setChannel] = useState(status?.channel || "");
    const [apiKey, setApiKey] = useState("");      // write-only: never echoed back by the server
    const [clearKey, setClearKey] = useState(false);
    const [keyless, setKeyless] = useState(status ? status.keylessFull !== false : true);
    const [cacheTtl, setCacheTtl] = useState(status?.cacheTtl || 30);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);

    useEffect(() => {
        if (!status) return;
        setChannel(status.channel || "");
        setKeyless(status.keylessFull !== false);
        setCacheTtl(status.cacheTtl || 30);
    }, [status?.channel, status?.keylessFull, status?.cacheTtl]);

    const save = async (e) => {
        e.preventDefault();
        setBusy(true); setMessage(null);
        try {
            const body = { channel, cacheTtl, keylessFull: keyless };
            if (clearKey) body.apiKey = "";
            else if (apiKey.trim()) body.apiKey = apiKey.trim();
            const s = await apiPost("/plugin/youtube-videos/settings", body);
            setApiKey(""); setClearKey(false);
            if (s.error && !s.videoCount) setMessage({ error: true, text: t("msg.failed", { error: s.error }) });
            else setMessage({ error: false, text: s.refreshing ? t("msg.savedSyncing") : t("msg.saved", { count: s.videoCount }) });
            onSaved(s);
        } catch (err) {
            setMessage({ error: true, text: t("msg.failed", { error: err?.message || err }) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <form onSubmit={save} className="cf-editor">
            <div className="cf-editor-body">
                <section className="ytv-section">
                    <h2 className="cf-editor-title"><YoutubeIcon /> {t("set.channel.title")}</h2>
                    <label className="cf-label" htmlFor="yt-channel">{t("set.channel")}</label>
                    <input id="yt-channel" type="text" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder={t("set.channelPh")} className="cf-input" required />
                    <p className="cf-help">{t("set.channelHelp")}</p>
                </section>

                <section className="ytv-section">
                    <h2 className="cf-editor-title"><SyncIcon /> {t("set.source.title")}</h2>
                    <label className="ytv-switch">
                        <input type="checkbox" role="switch" checked={keyless} onChange={(e) => setKeyless(e.target.checked)} />
                        <span className="ytv-switch-track" aria-hidden="true"><span /></span>
                        <span className="ytv-switch-label">{t("set.keyless")}</span>
                    </label>
                    <p className="cf-help">{t("set.keylessHelp")}</p>

                    <label className="cf-label" htmlFor="yt-key" style={{ marginTop: "1rem" }}>{t("set.apiKey")}</label>
                    <input id="yt-key" type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setClearKey(false); }} placeholder={status?.hasApiKey ? t("set.apiKeyPhSet") : t("set.apiKeyPhUnset")} className="cf-input" autoComplete="new-password" />
                    <p className="cf-help">{t("set.apiKeyHelp")}</p>
                    {status?.hasApiKey && (
                        <label className="cf-check">
                            <input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setApiKey(""); }} />
                            <span>{t("set.clearKey")}</span>
                        </label>
                    )}
                    <div className="cf-note" style={{ marginTop: "0.9rem" }}><InfoIcon /><span>{t("set.order")}</span></div>
                </section>

                <section className="ytv-section">
                    <h2 className="cf-editor-title"><GearIcon /> {t("set.cache.title")}</h2>
                    <label className="cf-label" htmlFor="yt-ttl">{t("set.ttl")}</label>
                    <input id="yt-ttl" type="number" min="1" value={cacheTtl} onChange={(e) => setCacheTtl(Math.max(1, parseInt(e.target.value, 10) || 1))} className="cf-input ytv-narrow" required />
                    <p className="cf-help">{t("set.ttlHelp")}</p>
                </section>

                <div className="ytv-form-actions">
                    {message && (
                        <div role={message.error ? "alert" : "status"} className={`cf-flash ${message.error ? "is-error" : "is-ok"}`}>
                            {message.error && <AlertIcon style={{ width: "1rem", height: "1rem", flexShrink: 0 }} />}
                            <span>{message.text}</span>
                        </div>
                    )}
                    <button type="submit" disabled={busy} className="cf-btn">
                        <SaveIcon />
                        {busy ? t("common.saving") : t("common.save")}
                    </button>
                </div>
            </div>
        </form>
    );
}

function BlockHelp({ t }) {
    return (
        <div className="cf-card-item">
            <h2 className="cf-editor-title"><BlockIcon /> {t("block.title")}</h2>
            <ol className="ytv-steps">
                <li>{t("block.step1")}</li>
                <li>{t("block.step2")}</li>
                <li>{t("block.step3")}</li>
            </ol>
            <h3 className="cf-panel-title" style={{ marginTop: "1.25rem" }}>{t("block.options")}</h3>
            <ul className="ytv-optlist">
                <li>{t("block.opt.layout")}</li>
                <li>{t("block.opt.filters")}</li>
                <li>{t("block.opt.order")}</li>
                <li>{t("block.opt.paging")}</li>
                <li>{t("block.opt.display")}</li>
            </ul>
        </div>
    );
}

export default function YoutubeVideosAdminPage() {
    const { t, locale } = useT();
    const [tab, setTab] = useState("library");
    const [status, setStatus] = useState(null);
    const [busy, setBusy] = useState(false);
    const [version, setVersion] = useState(0); // bumps reload the library

    const loadStatus = useCallback(async () => {
        try { const s = await api("/plugin/youtube-videos/status"); setStatus(s); return s; } catch { setStatus(null); return null; }
    }, []);

    useEffect(() => {
        loadStatus().then((s) => { if (s && !s.channel) setTab("settings"); });
    }, [loadStatus]);

    // While the channel is read in the background, follow it.
    useEffect(() => {
        if (!status?.refreshing) return;
        const timer = setTimeout(async () => {
            const s = await loadStatus();
            if (s && !s.refreshing) setVersion((v) => v + 1);
        }, 2000);
        return () => clearTimeout(timer);
    }, [status, loadStatus]);

    const refresh = async (full) => {
        setBusy(true);
        try {
            const s = await apiPost("/plugin/youtube-videos/refresh", full ? { full: true } : {});
            setStatus(s);
            setVersion((v) => v + 1);
        } catch {
            await loadStatus();
        } finally {
            setBusy(false);
        }
    };

    const tabs = [
        ["library", t("tab.library"), GridIcon],
        ["settings", t("tab.settings"), GearIcon],
        ["block", t("tab.block"), BlockIcon],
    ];

    return (
        <div className="cf-shell">
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><YoutubeIcon /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">{t("app.subtitle")}</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {status === null ? (
                <div className="cf-note"><InfoIcon /><span>{t("msg.loadingStatus")}</span></div>
            ) : (
                <StatusStrip status={status} t={t} locale={locale} busy={busy} onRefresh={() => refresh(false)} onResync={() => refresh(true)} />
            )}

            <div className="cf-tabs" role="tablist" style={{ marginTop: "1.25rem" }}>
                {tabs.map(([id, label, Icon]) => (
                    <button key={id} type="button" role="tab" aria-selected={tab === id} className={`cf-tab ${tab === id ? "is-active" : ""}`} onClick={() => setTab(id)}>
                        <Icon style={{ width: "1rem", height: "1rem" }} /> {label}
                    </button>
                ))}
            </div>

            {tab === "library" && <Library t={t} locale={locale} version={version} onGoSettings={() => setTab("settings")} />}
            {tab === "settings" && <Settings t={t} status={status} onSaved={(s) => { setStatus(s); setVersion((v) => v + 1); }} />}
            {tab === "block" && <BlockHelp t={t} />}
        </div>
    );
}

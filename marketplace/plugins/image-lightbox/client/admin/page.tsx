// @ts-nocheck
"use client";

/**
 * Admin page for the Image Lightbox plugin (/admin/plugin/lightbox).
 * Toggle the lightbox, toggle captions, adjust the content scope selector, and try a
 * two-thumbnail demo that reproduces the public overlay. Visual identity lives in the
 * plugin's OWN stylesheet (client/admin/admin.css, injected by the host admin shell and
 * scoped to .plugin-admin-lightbox) — the markup below only uses cf-* classes.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost } from "@/lib/api";
import { useT } from "./i18n";

const MAX_SCOPE_LEN = 100;
const DEFAULT_SCOPE = ".wjs-content";

// Self-contained demo images (SVG data URIs — no network, no uploads needed).
function demoSvg(from, to, label) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='500'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/></linearGradient></defs><rect width='800' height='500' fill='url(#g)'/><circle cx='650' cy='105' r='58' fill='rgba(255,255,255,0.35)'/><path d='M0 380 L180 250 L340 360 L520 220 L800 400 L800 500 L0 500 Z' fill='rgba(0,0,0,0.18)'/><text x='40' y='450' font-family='sans-serif' font-size='40' font-weight='bold' fill='white'>${label}</text></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
}

// Demo image specs; the labels are translated at render time (see DEMO_IMAGES in the page).
const DEMO_SPECS = [
    { from: "#6366f1", to: "#0ea5e9", labelKey: "demo.coast" },
    { from: "#f59e0b", to: "#ef4444", labelKey: "demo.mountains" },
];

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconImage = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
    </svg>
);
const IconZoomIn = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
        <path d="M11 8v6M8 11h6" />
    </svg>
);
const IconChevronLeft = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="m15 18-6-6 6-6" />
    </svg>
);
const IconChevronRight = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="m9 18 6-6-6-6" />
    </svg>
);
const IconX = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M18 6 6 18M6 6l12 12" />
    </svg>
);

// Module-level toggle row (never define a component inside a component).
function ToggleRow({ label, help, checked, onChange }) {
    return (
        <label className="cf-switch-row">
            <span style={{ minWidth: 0 }}>
                <span className="cf-switch-label">{label}</span>
                {help && <span className="cf-switch-help">{help}</span>}
            </span>
            <span className={`cf-switch ${checked ? "is-on" : ""}`}>
                <input type="checkbox" className="cf-visually-hidden" checked={checked} onChange={(e) => onChange(e.target.checked)} />
                <span className="cf-switch-knob" aria-hidden="true" />
            </span>
        </label>
    );
}

export default function ImageLightboxAdminPage() {
    const { t, lang } = useT();
    const DEMO_IMAGES = useMemo(() => DEMO_SPECS.map((d) => {
        const label = t(d.labelKey);
        return { src: demoSvg(d.from, d.to, label), alt: t("demo.alt", { label }) };
    }), [lang]); // eslint-disable-line react-hooks/exhaustive-deps
    const [enabled, setEnabled] = useState(true);
    const [captions, setCaptions] = useState(true);
    const [scope, setScope] = useState(DEFAULT_SCOPE);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [demoIndex, setDemoIndex] = useState(null); // null = demo overlay closed

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const cfg = await api("/plugin/image-lightbox/config");
                if (!alive || !cfg) return;
                setEnabled(cfg.enabled !== false);
                setCaptions(cfg.captions !== false);
                setScope(typeof cfg.scope === "string" && cfg.scope ? cfg.scope : DEFAULT_SCOPE);
            } catch {
                // Plugin inactive or request failed — keep the defaults visible.
            } finally {
                if (alive) setLoaded(true);
            }
        })();
        return () => { alive = false; };
    }, []);

    // Demo overlay: keyboard navigation + body scroll lock (mirrors the public behavior).
    useEffect(() => {
        if (demoIndex === null) return;
        const onKey = (e) => {
            if (e.key === "Escape") setDemoIndex(null);
            else if (e.key === "ArrowRight") setDemoIndex((i) => ((i ?? 0) + 1) % DEMO_IMAGES.length);
            else if (e.key === "ArrowLeft") setDemoIndex((i) => ((i ?? 0) - 1 + DEMO_IMAGES.length) % DEMO_IMAGES.length);
        };
        window.addEventListener("keydown", onKey);
        const saved = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            window.removeEventListener("keydown", onKey);
            document.body.style.overflow = saved;
        };
    }, [demoIndex]);

    const save = async (e) => {
        e.preventDefault();
        const s = scope.trim();
        if (!s) { setMessage(t("error.scopeEmpty")); return; }
        if (s.length > MAX_SCOPE_LEN) { setMessage(t("error.scopeTooLong", { max: MAX_SCOPE_LEN })); return; }
        if (s.includes("<")) { setMessage(t("error.scopeLt")); return; }
        setBusy(true); setMessage("");
        try {
            const cfg = await apiPost("/plugin/image-lightbox/config", { enabled, captions, scope: s });
            setEnabled(cfg.enabled !== false);
            setCaptions(cfg.captions !== false);
            setScope(cfg.scope || DEFAULT_SCOPE);
            setMessage(t("saved"));
        } catch (err) {
            setMessage(t("error.save", { msg: err?.message || err }));
        } finally {
            setBusy(false);
        }
    };

    const demo = demoIndex === null ? null : DEMO_IMAGES[demoIndex];
    // Client-built errors start with "Error" (es/en) or "Erro" (pt).
    const isErrorMsg = /^Erro/i.test(message);

    return (
        <div className="cf-shell">
            {/* header: stamp + title + status pill */}
            <div className="cf-header" style={{ flexWrap: "wrap" }}>
                <div className="cf-stamp" aria-hidden="true"><IconImage /></div>
                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">{t("app.subtitle")}</p>
                </div>
                <span className={`cf-pill ${enabled ? "is-on" : "is-off"}`}>
                    {enabled ? t("status.on") : t("status.off")}
                </span>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* settings: featured surface with the accent crown */}
            <form onSubmit={save} className="cf-editor">
                <div className="cf-editor-body">
                    <div style={{ display: "grid", gap: "1.4rem" }}>
                        <ToggleRow
                            label={t("enabled.label")}
                            help={t("enabled.help")}
                            checked={enabled}
                            onChange={setEnabled}
                        />
                        <ToggleRow
                            label={t("captions.label")}
                            help={t("captions.help")}
                            checked={captions}
                            onChange={setCaptions}
                        />
                        <div>
                            <label className="cf-label" htmlFor="lb-scope">{t("scope.label")}</label>
                            <input
                                id="lb-scope"
                                type="text"
                                value={scope}
                                onChange={(e) => setScope(e.target.value)}
                                placeholder={DEFAULT_SCOPE}
                                maxLength={MAX_SCOPE_LEN}
                                className="cf-input"
                                disabled={!loaded}
                            />
                            <p className="cf-help">
                                {t("scope.help1")}<code className="cf-code">.wjs-content</code>{t("scope.help2")}<code className="cf-code">main</code>{t("scope.help3")}
                            </p>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                            <button type="submit" disabled={busy || !loaded} className="cf-btn">{busy ? t("common.saving") : t("common.save")}</button>
                        </div>
                        {message && (
                            <div role={isErrorMsg ? "alert" : "status"} className={`cf-flash ${isErrorMsg ? "is-error" : "is-ok"}`} style={{ marginBottom: 0 }}>{message}</div>
                        )}
                    </div>
                </div>
            </form>

            {/* demo: two thumbnails that open the same overlay the public site uses */}
            <div className="cf-card-item">
                <h2 className="cf-editor-title" style={{ marginBottom: "0.35rem" }}><IconZoomIn /> {t("demo.title")}</h2>
                <p className="cf-help" style={{ marginTop: 0, marginBottom: "1.1rem" }}>
                    {t("demo.help")}
                </p>
                <div className="cf-demo-grid">
                    {DEMO_IMAGES.map((img, i) => (
                        <button key={i} type="button" onClick={() => setDemoIndex(i)} className="cf-thumb">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={img.src} alt={img.alt} decoding="async" />
                            <span className="cf-thumb-caption">{img.alt}</span>
                        </button>
                    ))}
                </div>
            </div>

            {demo && (
                <div
                    className="cf-lightbox"
                    role="dialog"
                    aria-modal="true"
                    aria-label={t("viewer.label")}
                    onClick={() => setDemoIndex(null)}
                >
                    <figure className="cf-lightbox-figure" onClick={(e) => e.stopPropagation()}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={demo.src} alt="" decoding="async" />
                        {captions && <figcaption className="cf-lightbox-caption">{demo.alt}</figcaption>}
                    </figure>
                    <button
                        type="button"
                        aria-label={t("viewer.prev")}
                        onClick={(e) => { e.stopPropagation(); setDemoIndex((i) => ((i ?? 0) - 1 + DEMO_IMAGES.length) % DEMO_IMAGES.length); }}
                        className="cf-lightbox-nav is-prev"
                    ><IconChevronLeft /></button>
                    <button
                        type="button"
                        aria-label={t("viewer.next")}
                        onClick={(e) => { e.stopPropagation(); setDemoIndex((i) => ((i ?? 0) + 1) % DEMO_IMAGES.length); }}
                        className="cf-lightbox-nav is-next"
                    ><IconChevronRight /></button>
                    <button
                        type="button"
                        aria-label={t("viewer.close")}
                        onClick={() => setDemoIndex(null)}
                        className="cf-lightbox-nav cf-lightbox-close"
                    ><IconX /></button>
                    <div className="cf-lightbox-count">{(demoIndex ?? 0) + 1} / {DEMO_IMAGES.length}</div>
                </div>
            )}
        </div>
    );
}

// @ts-nocheck
"use client";

/**
 * Admin page for the Analytics Tag plugin (/admin/plugin/tracking).
 * Pick a provider (GA4 / Plausible / Matomo), fill the fields that provider needs, decide
 * whether the tag waits for the visitor's cookie consent, and save. A status card summarizes
 * what is currently being injected on the public site (server-saved state, not local edits).
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-tracking) — the markup below only uses cf-* classes.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";

const PROVIDER_LABELS = { ga4: "Google Analytics 4", plausible: "Plausible", matomo: "Matomo" };

// Enabled toggle aside, a provider only injects when its own fields are complete.
function isProviderConfigured(cfg) {
    if (!cfg) return false;
    if (cfg.provider === "ga4") return !!cfg.ga4Id;
    if (cfg.provider === "plausible") return !!cfg.plausibleDomain;
    if (cfg.provider === "matomo") return !!(cfg.matomoUrl && cfg.matomoSiteId);
    return false;
}

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconChart = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M3 3v16a2 2 0 0 0 2 2h16" />
        <path d="M7 15v2" />
        <path d="M11 9v8" />
        <path d="M15 12v5" />
        <path d="M19 6v11" />
    </svg>
);
const IconPulse = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
);

// Module-level (never define a component inside a component — focus loss on re-render).
function ToggleRow({ label, hint, checked, onChange }) {
    return (
        <label className="cf-toggle">
            <input
                type="checkbox"
                checked={!!checked}
                onChange={(e) => onChange(e.target.checked)}
            />
            <span>
                <span className="cf-toggle-label">{label}</span>
                {hint && <span className="cf-toggle-hint">{hint}</span>}
            </span>
        </label>
    );
}

export default function AnalyticsTagAdminPage() {
    const [config, setConfig] = useState(null);   // the form being edited
    const [saved, setSaved] = useState(null);     // last server-confirmed state (drives the status card)
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [loadError, setLoadError] = useState("");

    const load = async () => {
        try {
            const cfg = await api("/plugin/analytics-tag/config");
            setConfig(cfg);
            setSaved(cfg);
            setLoadError("");
        } catch (err) {
            setLoadError(`No se pudo cargar la configuración: ${err?.message || err}`);
        }
    };
    useEffect(() => { load(); }, []);

    const update = (patch) => setConfig((c) => ({ ...c, ...patch }));

    const save = async (e) => {
        e.preventDefault();
        if (!config || busy) return;
        setBusy(true); setMessage("");
        try {
            const next = await apiPost("/plugin/analytics-tag/config", config);
            setConfig(next);
            setSaved(next);
            setMessage("Configuración guardada.");
        } catch (err) {
            setMessage(`Error al guardar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    if (!config) {
        return (
            <div className="cf-shell">
                <div className="cf-header">
                    <div className="cf-stamp" aria-hidden="true"><IconChart /></div>
                    <div>
                        <h1 className="cf-title">Analytics</h1>
                    </div>
                </div>
                <div className="cf-airmail-rule" aria-hidden="true"></div>
                {loadError
                    ? <div role="alert" className="cf-flash is-error">{loadError}</div>
                    : <p className="cf-status-sub">Cargando configuración…</p>}
            </div>
        );
    }

    const savedConfigured = isProviderConfigured(saved);
    const injecting = !!(saved && saved.enabled && savedConfigured);

    return (
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconChart /></div>
                <div>
                    <h1 className="cf-title">Analytics</h1>
                    <p className="cf-subtitle">
                        Etiqueta de analítica en todo el sitio — GA4, Plausible o Matomo
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* settings editor: featured surface with the accent crown */}
            <form onSubmit={save} className="cf-editor">
                <div className="cf-editor-body" style={{ display: "grid", gap: "1.4rem" }}>
                    <ToggleRow
                        label="Activar la analítica"
                        hint="Inyecta el script del proveedor elegido en todas las páginas públicas del sitio."
                        checked={config.enabled}
                        onChange={(v) => update({ enabled: v })}
                    />

                    <div>
                        <label className="cf-label" htmlFor="at-provider">Proveedor</label>
                        <select
                            id="at-provider"
                            value={config.provider}
                            onChange={(e) => update({ provider: e.target.value })}
                            className="cf-select"
                        >
                            <option value="ga4">Google Analytics 4</option>
                            <option value="plausible">Plausible</option>
                            <option value="matomo">Matomo</option>
                        </select>
                    </div>

                    {config.provider === "ga4" && (
                        <div>
                            <label className="cf-label" htmlFor="at-ga4">ID de medición (GA4)</label>
                            <input
                                id="at-ga4"
                                type="text"
                                value={config.ga4Id || ""}
                                onChange={(e) => update({ ga4Id: e.target.value })}
                                placeholder="G-XXXXXXXXXX"
                                className="cf-input"
                            />
                            <p className="cf-help">
                                Lo encuentras en Google Analytics → Administrar → Flujos de datos. Formato G-XXXXXXXXXX.
                            </p>
                        </div>
                    )}

                    {config.provider === "plausible" && (
                        <div>
                            <label className="cf-label" htmlFor="at-plausible">Dominio (Plausible)</label>
                            <input
                                id="at-plausible"
                                type="text"
                                value={config.plausibleDomain || ""}
                                onChange={(e) => update({ plausibleDomain: e.target.value })}
                                placeholder="midominio.com"
                                className="cf-input"
                            />
                            <p className="cf-help">
                                El dominio tal como está dado de alta en Plausible — solo el nombre de host, sin https:// ni rutas.
                            </p>
                        </div>
                    )}

                    {config.provider === "matomo" && (
                        <div style={{ display: "grid", gap: "1.05rem" }}>
                            <div>
                                <label className="cf-label" htmlFor="at-matomo-url">URL de la instancia Matomo</label>
                                <input
                                    id="at-matomo-url"
                                    type="text"
                                    value={config.matomoUrl || ""}
                                    onChange={(e) => update({ matomoUrl: e.target.value })}
                                    placeholder="https://analitica.midominio.com"
                                    className="cf-input"
                                />
                                <p className="cf-help">
                                    Debe ser una URL https://. El cargador le añade /matomo.js y /matomo.php automáticamente.
                                </p>
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="at-matomo-siteid">ID de sitio (Matomo)</label>
                                <input
                                    id="at-matomo-siteid"
                                    type="text"
                                    value={config.matomoSiteId || ""}
                                    onChange={(e) => update({ matomoSiteId: e.target.value })}
                                    placeholder="1"
                                    className="cf-input"
                                />
                                <p className="cf-help">
                                    Solo dígitos — el idSite que Matomo asigna a este sitio web.
                                </p>
                            </div>
                        </div>
                    )}

                    <ToggleRow
                        label="Respetar el consentimiento de cookies"
                        hint="Espera a que el visitante acepte las cookies si el plugin cookie-consent está activo. Si el visitante las rechaza, no se carga nada; si no hay gestor de consentimiento instalado, el script se carga igualmente."
                        checked={config.respectConsent}
                        onChange={(v) => update({ respectConsent: v })}
                    />

                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem", justifyContent: "flex-end" }}>
                        <button type="submit" disabled={busy} className="cf-btn">{busy ? "Guardando…" : "Guardar"}</button>
                    </div>

                    {message && (
                        <div
                            role={/Error/i.test(message) ? "alert" : "status"}
                            className={`cf-flash ${/Error/i.test(message) ? "is-error" : "is-ok"}`}
                            style={{ marginBottom: 0 }}
                        >
                            {message}
                        </div>
                    )}
                </div>
            </form>

            {/* status card: what the public site is actually injecting (server-saved state) */}
            <div className="cf-card-item" style={{ marginTop: "1.5rem" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "1rem" }}>
                    <h2 className="cf-status-title"><IconPulse /> Estado</h2>
                    <span className={`cf-pill ${injecting ? "is-on" : "is-off"}`}>
                        <span className="cf-pill-dot" aria-hidden="true"></span>
                        {injecting ? "Inyectando" : "Sin inyectar"}
                    </span>
                </div>

                {!saved?.enabled ? (
                    <p className="cf-status-sub">
                        La analítica está desactivada — no se inyecta ningún script en el sitio público.
                    </p>
                ) : !savedConfigured ? (
                    <div className="cf-flash is-warn" style={{ marginBottom: 0 }}>
                        Activada pero incompleta: faltan datos de {PROVIDER_LABELS[saved.provider] || saved.provider}. Completa los campos y guarda.
                    </div>
                ) : (
                    <div className="cf-status-lines">
                        <p>
                            <strong>{PROVIDER_LABELS[saved.provider]}</strong> se inyecta en todas las páginas públicas.
                        </p>
                        {saved.provider === "ga4" && (
                            <p className="cf-status-detail">gtag.js con el ID <code className="cf-code">{saved.ga4Id}</code></p>
                        )}
                        {saved.provider === "plausible" && (
                            <p className="cf-status-detail">plausible.io/js/script.js para el dominio <code className="cf-code">{saved.plausibleDomain}</code></p>
                        )}
                        {saved.provider === "matomo" && (
                            <p className="cf-status-detail">
                                <code className="cf-code">{saved.matomoUrl}/matomo.js</code> con idSite <code className="cf-code">{saved.matomoSiteId}</code>
                            </p>
                        )}
                        <p className="cf-status-detail">
                            {saved.respectConsent
                                ? "Espera la aceptación de cookies del visitante (integración con cookie-consent; sin gestor de consentimiento se carga directamente)."
                                : "Se inyecta inmediatamente, sin esperar consentimiento."}
                        </p>
                    </div>
                )}

                <p className="cf-footnote">
                    El script cargador se sirve solo en las páginas públicas mientras el plugin está activo. Recuerda
                    conceder el permiso de <strong>assets</strong> al plugin en la pantalla de Plugins para que el
                    cargador pueda publicarse.
                </p>
            </div>
        </div>
    );
}

// @ts-nocheck
"use client";

/**
 * Admin page for the Analytics Tag plugin (/admin/plugin/tracking).
 * Pick a provider (GA4 / Plausible / Matomo), fill the fields that provider needs, decide
 * whether the tag waits for the visitor's cookie consent, and save. A status card summarizes
 * what is currently being injected on the public site (server-saved state, not local edits).
 */

import React, { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-red-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";

const PROVIDER_LABELS = { ga4: "Google Analytics 4", plausible: "Plausible", matomo: "Matomo" };

// Enabled toggle aside, a provider only injects when its own fields are complete.
function isProviderConfigured(cfg) {
    if (!cfg) return false;
    if (cfg.provider === "ga4") return !!cfg.ga4Id;
    if (cfg.provider === "plausible") return !!cfg.plausibleDomain;
    if (cfg.provider === "matomo") return !!(cfg.matomoUrl && cfg.matomoSiteId);
    return false;
}

// Module-level (never define a component inside a component — focus loss on re-render).
function ToggleRow({ label, hint, checked, onChange }) {
    return (
        <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
                type="checkbox"
                checked={!!checked}
                onChange={(e) => onChange(e.target.checked)}
                className="mt-1 h-4 w-4 accent-gray-900"
            />
            <span>
                <span className="block text-sm font-bold text-gray-800">{label}</span>
                {hint && <span className="block text-[11px] text-gray-400 leading-relaxed mt-0.5">{hint}</span>}
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
            <div className="max-w-3xl mx-auto p-4 sm:p-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter mb-4">Analytics</h1>
                {loadError
                    ? <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{loadError}</div>
                    : <p className="text-sm text-gray-400">Cargando configuración…</p>}
            </div>
        );
    }

    const savedConfigured = isProviderConfigured(saved);
    const injecting = !!(saved && saved.enabled && savedConfigured);

    return (
        <div className="max-w-3xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Analytics</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Etiqueta de analítica en todo el sitio — GA4, Plausible o Matomo
                </p>
            </div>

            <form onSubmit={save} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 mb-8 space-y-6">
                <ToggleRow
                    label="Activar la analítica"
                    hint="Inyecta el script del proveedor elegido en todas las páginas públicas del sitio."
                    checked={config.enabled}
                    onChange={(v) => update({ enabled: v })}
                />

                <div>
                    <label className={labelCls}>Proveedor</label>
                    <select
                        value={config.provider}
                        onChange={(e) => update({ provider: e.target.value })}
                        className={inputCls}
                    >
                        <option value="ga4">Google Analytics 4</option>
                        <option value="plausible">Plausible</option>
                        <option value="matomo">Matomo</option>
                    </select>
                </div>

                {config.provider === "ga4" && (
                    <div>
                        <label className={labelCls}>ID de medición (GA4)</label>
                        <input
                            type="text"
                            value={config.ga4Id || ""}
                            onChange={(e) => update({ ga4Id: e.target.value })}
                            placeholder="G-XXXXXXXXXX"
                            className={inputCls}
                        />
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                            Lo encuentras en Google Analytics → Administrar → Flujos de datos. Formato G-XXXXXXXXXX.
                        </p>
                    </div>
                )}

                {config.provider === "plausible" && (
                    <div>
                        <label className={labelCls}>Dominio (Plausible)</label>
                        <input
                            type="text"
                            value={config.plausibleDomain || ""}
                            onChange={(e) => update({ plausibleDomain: e.target.value })}
                            placeholder="midominio.com"
                            className={inputCls}
                        />
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                            El dominio tal como está dado de alta en Plausible — solo el nombre de host, sin https:// ni rutas.
                        </p>
                    </div>
                )}

                {config.provider === "matomo" && (
                    <div className="space-y-5">
                        <div>
                            <label className={labelCls}>URL de la instancia Matomo</label>
                            <input
                                type="text"
                                value={config.matomoUrl || ""}
                                onChange={(e) => update({ matomoUrl: e.target.value })}
                                placeholder="https://analitica.midominio.com"
                                className={inputCls}
                            />
                            <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                                Debe ser una URL https://. El cargador le añade /matomo.js y /matomo.php automáticamente.
                            </p>
                        </div>
                        <div>
                            <label className={labelCls}>ID de sitio (Matomo)</label>
                            <input
                                type="text"
                                value={config.matomoSiteId || ""}
                                onChange={(e) => update({ matomoSiteId: e.target.value })}
                                placeholder="1"
                                className={inputCls}
                            />
                            <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
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

                <div className="flex flex-wrap items-center gap-3 justify-end">
                    <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>

                {message && (
                    <div className={`text-sm px-4 py-3 rounded-xl ${/Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                        {message}
                    </div>
                )}
            </form>

            <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                    <h2 className="font-bold text-gray-800">Estado</h2>
                    <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full ${injecting ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                        {injecting ? "Inyectando" : "Sin inyectar"}
                    </span>
                </div>

                {!saved?.enabled ? (
                    <p className="text-sm text-gray-400">
                        La analítica está desactivada — no se inyecta ningún script en el sitio público.
                    </p>
                ) : !savedConfigured ? (
                    <div className="text-sm px-4 py-3 rounded-xl bg-amber-50 text-amber-700">
                        Activada pero incompleta: faltan datos de {PROVIDER_LABELS[saved.provider] || saved.provider}. Completa los campos y guarda.
                    </div>
                ) : (
                    <div className="space-y-2 text-sm text-gray-600">
                        <p>
                            <span className="font-bold text-gray-800">{PROVIDER_LABELS[saved.provider]}</span> se inyecta en todas las páginas públicas.
                        </p>
                        {saved.provider === "ga4" && (
                            <p className="text-[12px] text-gray-500">gtag.js con el ID <code className="bg-gray-50 px-1.5 py-0.5 rounded">{saved.ga4Id}</code></p>
                        )}
                        {saved.provider === "plausible" && (
                            <p className="text-[12px] text-gray-500">plausible.io/js/script.js para el dominio <code className="bg-gray-50 px-1.5 py-0.5 rounded">{saved.plausibleDomain}</code></p>
                        )}
                        {saved.provider === "matomo" && (
                            <p className="text-[12px] text-gray-500">
                                <code className="bg-gray-50 px-1.5 py-0.5 rounded">{saved.matomoUrl}/matomo.js</code> con idSite <code className="bg-gray-50 px-1.5 py-0.5 rounded">{saved.matomoSiteId}</code>
                            </p>
                        )}
                        <p className="text-[12px] text-gray-500">
                            {saved.respectConsent
                                ? "Espera la aceptación de cookies del visitante (integración con cookie-consent; sin gestor de consentimiento se carga directamente)."
                                : "Se inyecta inmediatamente, sin esperar consentimiento."}
                        </p>
                    </div>
                )}

                <p className="text-[11px] text-gray-400 mt-6 leading-relaxed">
                    El script cargador se sirve solo en las páginas públicas mientras el plugin está activo. Recuerda
                    conceder el permiso de <strong>assets</strong> al plugin en la pantalla de Plugins para que el
                    cargador pueda publicarse.
                </p>
            </div>
        </div>
    );
}

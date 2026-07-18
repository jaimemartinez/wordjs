// @ts-nocheck
"use client";

/**
 * Admin page for the Cookie Consent plugin (/admin/plugin/cookie-consent).
 * Left: banner configuration with a live inline preview (the real public banner uses
 * public/banner.css — the preview mirrors it with plugin-scoped cf-* styles). Right: anonymous
 * compliance stats.
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-cookie-consent) — the markup below only uses
 * cf-* classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";

const DEFAULT_FORM = {
    enabled: false,
    message: "Usamos cookies para mejorar tu experiencia. Puedes aceptarlas o rechazarlas.",
    acceptLabel: "Aceptar",
    rejectLabel: "Rechazar",
    policyUrl: "",
    position: "bottom",
    theme: "dark",
    version: 1,
};

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconCookie = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
        <path d="M8.5 8.5v.01" />
        <path d="M16 15.5v.01" />
        <path d="M12 12v.01" />
        <path d="M11 17v.01" />
        <path d="M7 14v.01" />
    </svg>
);
const IconEye = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);
const IconChart = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M3 3v18h18" />
        <path d="M8 17v-4" />
        <path d="M13 17V8" />
        <path d="M18 17v-7" />
    </svg>
);

/** Inline mock of the public banner reflecting the current form state (module level — never nest). */
function BannerPreview({ form }) {
    const dark = form.theme !== "light";
    const corner = form.position === "corner";
    const boxCls = [
        "cf-preview-banner",
        corner ? "is-corner" : "is-bar",
        dark ? "is-dark" : "is-light",
    ].join(" ");
    return (
        <div className="cf-preview-canvas">
            {/* Fake page content behind the banner */}
            <div className="cf-preview-page" aria-hidden="true">
                <div className="cf-skel" style={{ width: "33%", height: "1rem" }} />
                <div className="cf-skel" style={{ width: "100%" }} />
                <div className="cf-skel" style={{ width: "83%" }} />
                <div className="cf-skel" style={{ width: "66%" }} />
                <div className="cf-skel" style={{ width: "100%", height: "6rem", borderRadius: "0.75rem" }} />
            </div>
            <div className={boxCls}>
                <p className="cf-preview-msg">{form.message || " "}</p>
                {form.policyUrl ? (
                    <span className="cf-preview-link">Política de cookies</span>
                ) : null}
                <div className="cf-preview-actions">
                    <span className="cf-preview-pill is-secondary">{form.rejectLabel || "Rechazar"}</span>
                    <span className="cf-preview-pill is-primary">{form.acceptLabel || "Aceptar"}</span>
                </div>
            </div>
        </div>
    );
}

/** One stat tile (module level — never nest components). */
function StatTile({ label, value, accent }) {
    return (
        <div className="cf-stat-tile">
            <p className={`cf-stat-value ${accent || ""}`}>{value}</p>
            <p className="cf-stat-label">{label}</p>
        </div>
    );
}

export default function CookieConsentAdminPage() {
    const [form, setForm] = useState(DEFAULT_FORM);
    const [reprompt, setReprompt] = useState(false);
    const [stats, setStats] = useState(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    const loadConfig = async () => {
        try {
            const cfg = await api("/plugin/cookie-consent/config");
            setForm({ ...DEFAULT_FORM, ...cfg });
        } catch {
            // Keep defaults — the form is still editable and Save will surface any real error.
        }
    };
    const loadStats = async () => {
        try {
            setStats(await api("/plugin/cookie-consent/stats"));
        } catch {
            setStats(null);
        }
    };

    useEffect(() => { loadConfig(); loadStats(); }, []);

    const setField = (key, value) => setForm((f) => ({ ...f, [key]: value }));

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        try {
            const wasReprompt = reprompt;
            const saved = await apiPost("/plugin/cookie-consent/config", { ...form, reprompt });
            setForm({ ...DEFAULT_FORM, ...saved });
            setReprompt(false);
            setMessage(
                wasReprompt
                    ? `Guardado — el banner volverá a mostrarse a todos los visitantes (versión ${saved.version}).`
                    : "Configuración guardada."
            );
        } catch (err) {
            setMessage(`Error al guardar: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    const total = stats?.total || 0;
    const accepted = stats?.accepted || 0;
    const rejected = stats?.rejected || 0;
    const acceptPct = total > 0 ? Math.round((accepted / total) * 100) : null;
    const last30 = stats?.last30 || [];
    const maxDay = Math.max(1, ...last30.map((d) => (d.accepted || 0) + (d.rejected || 0)));

    return (
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconCookie /></div>
                <div>
                    <h1 className="cf-title">Cookie Consent</h1>
                    <p className="cf-subtitle">
                        Banner de cookies (RGPD) en todo el sitio público + estadísticas anónimas
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* --- Configuration ------------------------------------------------------------------ */}
            <form onSubmit={save} className="cf-editor">
                <div className="cf-editor-body">
                    <div style={{ display: "grid", gap: "1.15rem" }}>
                        <label className="cf-check is-strong" htmlFor="cc-enabled">
                            <input
                                id="cc-enabled"
                                type="checkbox"
                                className="cf-switch"
                                checked={!!form.enabled}
                                onChange={(e) => setField("enabled", e.target.checked)}
                            />
                            <span>Mostrar el banner en el sitio público</span>
                        </label>

                        <div>
                            <label className="cf-label" htmlFor="cc-message">Mensaje (máx. 500 caracteres)</label>
                            <textarea
                                id="cc-message"
                                value={form.message}
                                onChange={(e) => setField("message", e.target.value)}
                                maxLength={500}
                                rows={3}
                                className="cf-input"
                                required
                            />
                        </div>

                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="cc-accept">Botón aceptar (máx. 40)</label>
                                <input id="cc-accept" type="text" value={form.acceptLabel} onChange={(e) => setField("acceptLabel", e.target.value)} maxLength={40} className="cf-input" />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="cc-reject">Botón rechazar (máx. 40)</label>
                                <input id="cc-reject" type="text" value={form.rejectLabel} onChange={(e) => setField("rejectLabel", e.target.value)} maxLength={40} className="cf-input" />
                            </div>
                        </div>

                        <div>
                            <label className="cf-label" htmlFor="cc-policy">URL de la política de cookies (opcional)</label>
                            <input
                                id="cc-policy"
                                type="url"
                                value={form.policyUrl}
                                onChange={(e) => setField("policyUrl", e.target.value)}
                                maxLength={300}
                                placeholder="https://misitio.com/politica-de-cookies"
                                className="cf-input"
                            />
                        </div>

                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="cc-position">Posición</label>
                                <select id="cc-position" value={form.position} onChange={(e) => setField("position", e.target.value)} className="cf-select">
                                    <option value="bottom">Barra inferior (todo el ancho)</option>
                                    <option value="corner">Tarjeta en la esquina</option>
                                </select>
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="cc-theme">Tema</label>
                                <select id="cc-theme" value={form.theme} onChange={(e) => setField("theme", e.target.value)} className="cf-select">
                                    <option value="dark">Oscuro</option>
                                    <option value="light">Claro</option>
                                </select>
                            </div>
                        </div>

                        <label className="cf-callout" htmlFor="cc-reprompt">
                            <input
                                id="cc-reprompt"
                                type="checkbox"
                                checked={reprompt}
                                onChange={(e) => setReprompt(e.target.checked)}
                            />
                            <span>
                                <span className="cf-callout-title">Volver a preguntar a todos</span>
                                <span className="cf-callout-text">
                                    Al guardar se invalida el consentimiento guardado de cada visitante y el banner se muestra de
                                    nuevo (versión actual: {form.version}).
                                </span>
                            </span>
                        </label>

                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                            <p className="cf-help" style={{ margin: 0 }}>
                                El banner aparece en el sitio público cuando el plugin está activo y habilitado.
                            </p>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? "Guardando…" : "Guardar"}</button>
                        </div>

                        {message && (
                            <div
                                role={/Error/i.test(message) ? "alert" : "status"}
                                className={`cf-flash ${/Error/i.test(message) ? "is-error" : "is-ok"}`}
                                style={{ margin: 0 }}
                            >
                                {message}
                            </div>
                        )}
                    </div>
                </div>
            </form>

            {/* --- Live preview ------------------------------------------------------------------- */}
            <div className="cf-card-item" style={{ marginTop: "1.5rem" }}>
                <h2 className="cf-editor-title" style={{ marginBottom: "1rem" }}><IconEye /> Vista previa</h2>
                <BannerPreview form={form} />
                <p className="cf-help" style={{ marginTop: "0.9rem" }}>
                    Vista aproximada — en el sitio público el banner usa su propia hoja de estilos y se adapta al ancho
                    real de la página.
                </p>
            </div>

            {/* --- Stats ---------------------------------------------------------------------------- */}
            <div className="cf-card-item" style={{ marginTop: "1.5rem" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", marginBottom: "1.1rem" }}>
                    <h2 className="cf-editor-title" style={{ marginBottom: 0 }}><IconChart /> Estadísticas de consentimiento</h2>
                    <span className="cf-micro">Registro anónimo — sin datos personales</span>
                </div>

                {stats === null ? (
                    <p className="cf-help" style={{ margin: 0 }}>Sin datos todavía — las elecciones de los visitantes aparecerán aquí.</p>
                ) : (
                    <>
                        <div className="cf-stat-grid">
                            <StatTile label="Total" value={total} />
                            <StatTile label="Aceptados" value={accepted} accent="is-ok" />
                            <StatTile label="Rechazados" value={rejected} accent="is-danger" />
                            <StatTile label="% aceptación" value={acceptPct === null ? "—" : `${acceptPct}%`} accent="is-accent" />
                        </div>

                        {last30.length === 0 ? (
                            <p className="cf-help" style={{ margin: 0 }}>Aún no hay elecciones registradas.</p>
                        ) : (
                            <div>
                                <p className="cf-label">Últimos 30 días con actividad</p>
                                {last30.map((d) => {
                                    const dayTotal = (d.accepted || 0) + (d.rejected || 0);
                                    const accW = Math.round(((d.accepted || 0) / maxDay) * 100);
                                    const rejW = Math.round(((d.rejected || 0) / maxDay) * 100);
                                    return (
                                        <div key={d.day} className="cf-bar-row">
                                            <span className="cf-bar-day">{d.day}</span>
                                            <div className="cf-bar-track">
                                                <div className="cf-bar-fill is-acc" style={{ width: `${accW}%` }} />
                                                <div className="cf-bar-fill is-rej" style={{ width: `${rejW}%` }} />
                                            </div>
                                            <span className="cf-bar-nums">
                                                <span className="is-acc">{d.accepted || 0}</span>
                                                {" · "}
                                                <span className="is-rej">{d.rejected || 0}</span>
                                                {" / "}{dayTotal}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

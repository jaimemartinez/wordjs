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
    const [cfg, setCfg] = useState(DEFAULT_CONFIG);
    const [reprompt, setReprompt] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [message, setMessage] = useState("");

    const set = (patch) => setCfg((c) => ({ ...c, ...patch }));

    useEffect(() => {
        (async () => {
            try {
                const c = await api("/plugin/notification-bar/config");
                setCfg({ ...DEFAULT_CONFIG, ...c });
            } catch {
                setMessage("Error: no se pudo cargar la configuración. ¿Está activo el plugin?");
            } finally {
                setLoaded(true);
            }
        })();
    }, []);

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        try {
            const saved = await apiPost("/plugin/notification-bar/config", { ...cfg, reprompt });
            setCfg({ ...DEFAULT_CONFIG, ...saved });
            const bumped = reprompt;
            setReprompt(false);
            setMessage(bumped
                ? `Guardado — la barra se volverá a mostrar a todos (versión ${saved.version}).`
                : "Guardado — la configuración de la barra se actualizó.");
        } catch (err) {
            setMessage(`Error al guardar: ${err?.message || err}`);
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
                    <h1 className="cf-title">Barra de Anuncios</h1>
                    <p className="cf-subtitle">
                        Aviso fijo en todo el sitio — mensaje, enlace, colores y programación
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* Live preview reflecting the current (unsaved) form values */}
            <div className="cf-preview-head">
                <span className="cf-label" style={{ marginBottom: 0 }}>Vista previa ({cfg.position === "bottom" ? "abajo del sitio" : "arriba del sitio"})</span>
                <span className={`cf-status-pill ${cfg.enabled ? "is-on" : "is-off"}`}>
                    {cfg.enabled ? "Activa" : "Desactivada"}
                </span>
            </div>
            <div className="cf-preview-shell">
                <div
                    className="cf-preview-bar"
                    style={{ backgroundColor: cfg.bgColor, color: cfg.textColor }}
                >
                    <span>
                        {cfg.message || "(escribe un mensaje abajo)"}
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
                        Mostrar la barra en el sitio
                    </label>

                    <div>
                        <label className="cf-label" htmlFor="nb-message">Mensaje</label>
                        <textarea
                            id="nb-message"
                            value={cfg.message}
                            onChange={(e) => set({ message: e.target.value })}
                            maxLength={300}
                            rows={2}
                            placeholder="Ej.: Envío gratis en pedidos superiores a 50 € hasta el domingo"
                            className="cf-input"
                        />
                        <p className="cf-counter">{(cfg.message || "").length}/300</p>
                    </div>

                    <div className="cf-grid">
                        <div>
                            <label className="cf-label" htmlFor="nb-link-label">Etiqueta del enlace (opcional)</label>
                            <input id="nb-link-label" type="text" value={cfg.linkLabel} onChange={(e) => set({ linkLabel: e.target.value })} maxLength={60} placeholder="Ver ofertas" className="cf-input" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="nb-link-url">URL del enlace (opcional)</label>
                            <input id="nb-link-url" type="text" value={cfg.linkUrl} onChange={(e) => set({ linkUrl: e.target.value })} placeholder="https://… o /pagina" className="cf-input" />
                        </div>
                    </div>

                    <div className="cf-grid-3">
                        <div>
                            <label className="cf-label" htmlFor="nb-bg">Color de fondo</label>
                            <div className="cf-color-row">
                                <input id="nb-bg" type="color" value={cfg.bgColor} onChange={(e) => set({ bgColor: e.target.value })} className="cf-color-input" />
                                <span className="cf-color-code">{cfg.bgColor}</span>
                            </div>
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="nb-text">Color del texto</label>
                            <div className="cf-color-row">
                                <input id="nb-text" type="color" value={cfg.textColor} onChange={(e) => set({ textColor: e.target.value })} className="cf-color-input" />
                                <span className="cf-color-code">{cfg.textColor}</span>
                            </div>
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="nb-position">Posición</label>
                            <select id="nb-position" value={cfg.position} onChange={(e) => set({ position: e.target.value })} className="cf-select">
                                <option value="top">Superior (arriba)</option>
                                <option value="bottom">Inferior (abajo)</option>
                            </select>
                        </div>
                    </div>

                    <label className="cf-check">
                        <input type="checkbox" checked={cfg.dismissible} onChange={(e) => set({ dismissible: e.target.checked })} />
                        Permitir cerrar la barra (botón ×)
                    </label>

                    <div className="cf-grid">
                        <div>
                            <label className="cf-label" htmlFor="nb-starts">Mostrar desde (opcional)</label>
                            <input id="nb-starts" type="datetime-local" value={cfg.starts_at} onChange={(e) => set({ starts_at: e.target.value })} className="cf-input" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="nb-ends">Mostrar hasta (opcional)</label>
                            <input id="nb-ends" type="datetime-local" value={cfg.ends_at} onChange={(e) => set({ ends_at: e.target.value })} className="cf-input" />
                        </div>
                    </div>
                    {(cfg.starts_at || cfg.ends_at) ? (
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "-0.6rem" }}>
                            <button type="button" onClick={() => set({ starts_at: "", ends_at: "" })} className="cf-link-clear">
                                <IconX /> Quitar programación
                            </button>
                        </div>
                    ) : null}

                    <div className="cf-nested-panel">
                        <label className="cf-check">
                            <input type="checkbox" checked={reprompt} onChange={(e) => setReprompt(e.target.checked)} />
                            <span>
                                <span className="cf-nested-title">Volver a mostrar a quienes la cerraron</span>
                                <span className="cf-help">
                                    Al guardar se incrementa la versión del aviso (actual: v{cfg.version}), así la barra reaparece para
                                    los visitantes que ya la habían cerrado. Úsalo cuando cambies el mensaje.
                                </span>
                            </span>
                        </label>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem" }}>
                        <button type="submit" className="cf-btn" disabled={busy || !loaded}>{busy ? "Guardando…" : "Guardar"}</button>
                    </div>

                    {message && (
                        <div
                            role={/^Error/i.test(message) ? "alert" : "status"}
                            className={`cf-flash ${/^Error/i.test(message) ? "is-error" : "is-ok"}`}
                            style={{ marginBottom: 0 }}
                        >
                            {message}
                        </div>
                    )}
                </div>
            </form>

            <p className="cf-footnote">
                La barra se muestra en todas las páginas públicas mientras el plugin esté activo y "Mostrar la barra" esté
                marcado. Si defines un rango de fechas, solo aparece dentro de ese rango. El cierre se recuerda en el
                navegador del visitante hasta que incrementes la versión.
            </p>
        </div>
    );
}

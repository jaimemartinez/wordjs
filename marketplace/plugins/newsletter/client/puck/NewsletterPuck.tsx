// @ts-nocheck
"use client";

/**
 * Puck block "Newsletter" — visitor subscribe form.
 *
 * Registered via manifest.frontend.puckComponents; the generated puckPluginRegistry composes
 * { ...puckComponentDef, render: default export }, so puckComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page. On mount it also handles the tokenized
 * ?nl=confirm / ?nl=unsubscribe deep links that the plugin's emails point back to (then strips
 * those params via history.replaceState). Every fetch is guarded — when the plugin is inactive
 * (endpoints 404) the block degrades to a quiet Spanish message instead of crashing the page.
 */

import React, { useEffect, useState } from "react";

const API_BASE = "/api/v1/plugin/newsletter";

const STYLES = `
.wjnl-box { max-width: 560px; margin: 0 auto; padding: 2rem 1.5rem; background: var(--wjs-bg-surface, #f9fafb); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); font-family: var(--wjs-font-family-base, inherit); }
.wjnl-title { margin: 0 0 .5rem; font-size: 1.35rem; font-weight: 700; color: var(--wjs-color-text, #111827); }
.wjnl-desc { margin: 0 0 1.1rem; font-size: .95rem; line-height: 1.5; color: var(--wjs-color-text-muted, #6b7280); }
.wjnl-form { display: flex; flex-wrap: wrap; gap: .6rem; }
.wjnl-input { flex: 1 1 200px; min-width: 0; padding: .7rem .9rem; font-size: .95rem; color: #111827; background: #fff; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: .6rem; outline: none; }
.wjnl-input:focus { border-color: var(--wjs-color-primary, #2563eb); }
.wjnl-btn { padding: .7rem 1.3rem; font-size: .95rem; font-weight: 700; color: #fff; background: var(--wjs-color-primary, #111827); border: none; border-radius: .6rem; cursor: pointer; white-space: nowrap; }
.wjnl-btn:hover { opacity: .9; }
.wjnl-btn:disabled { opacity: .55; cursor: default; }
.wjnl-msg { margin-top: .8rem; padding: .6rem .8rem; font-size: .9rem; border-radius: .5rem; }
.wjnl-ok { background: #ecfdf5; color: #047857; }
.wjnl-err { background: #fef2f2; color: #b91c1c; }
.wjnl-banner { margin-bottom: 1rem; padding: .7rem .9rem; font-size: .95rem; font-weight: 600; border-radius: .6rem; background: #ecfdf5; color: #047857; }
.wjnl-banner-err { background: #fef2f2; color: #b91c1c; }
@media (max-width: 480px) { .wjnl-form { flex-direction: column; } .wjnl-btn { width: 100%; } }
`;

export const puckComponentDef = {
    category: "Marketing",
    fields: {
        title: { type: "text", label: "Título" },
        description: { type: "text", label: "Descripción" },
        buttonLabel: { type: "text", label: "Texto del botón" },
        placeholder: { type: "text", label: "Placeholder del correo" },
        showName: {
            type: "radio",
            label: "Pedir nombre",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        title: "Suscríbete a nuestro boletín",
        description: "",
        buttonLabel: "Suscribirme",
        placeholder: "tu@correo.com",
        showName: false,
        elementId: "",
    },
};

export default function NewsletterPuck({ title, description, buttonLabel, placeholder, showName, elementId }) {
    const [email, setEmail] = useState("");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);       // { kind: 'ok' | 'err', text }
    const [banner, setBanner] = useState(null); // { kind: 'ok' | 'err', text } — confirm/unsub deep links

    // Handle ?nl=confirm|unsubscribe&nl_token=… deep links (targets of the plugin's emails),
    // then strip only those two params from the address bar.
    useEffect(() => {
        let alive = true;
        try {
            const params = new URLSearchParams(window.location.search);
            const nl = params.get("nl");
            const token = params.get("nl_token");
            if (!nl || !token) return;
            const path = nl === "confirm" ? "/public/confirm" : nl === "unsubscribe" ? "/public/unsubscribe" : null;
            if (!path) return;
            fetch(API_BASE + path + "?token=" + encodeURIComponent(token))
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => {
                    if (!alive) return;
                    if (data && data.success) {
                        setBanner({
                            kind: "ok",
                            text: nl === "confirm" ? "¡Suscripción confirmada! 🎉" : "Has cancelado tu suscripción.",
                        });
                    } else {
                        setBanner({ kind: "err", text: "El enlace no es válido o ya caducó." });
                    }
                })
                .catch(() => {
                    if (alive) setBanner({ kind: "err", text: "El enlace no es válido o ya caducó." });
                });
            params.delete("nl");
            params.delete("nl_token");
            const qs = params.toString();
            window.history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : "") + window.location.hash);
        } catch {
            // Never let deep-link handling break the page render.
        }
        return () => { alive = false; };
    }, []);

    const submit = async (e) => {
        e.preventDefault();
        const cleanEmail = email.trim();
        if (!cleanEmail) {
            setMsg({ kind: "err", text: "Escribe tu correo." });
            return;
        }
        setBusy(true);
        setMsg(null);
        try {
            const res = await fetch(API_BASE + "/public/subscribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: cleanEmail,
                    name: showName ? name.trim() : "",
                    page_url: window.location.origin + window.location.pathname,
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.success) {
                setMsg({
                    kind: "err",
                    text: (data && data.error) || "El servicio de suscripción no está disponible en este momento.",
                });
            } else if (data.already) {
                setMsg({ kind: "ok", text: "Ya estabas suscrito." });
            } else if (data.needsConfirm) {
                setMsg({ kind: "ok", text: "Revisa tu correo para confirmar la suscripción." });
                setEmail("");
                setName("");
            } else {
                setMsg({ kind: "ok", text: "¡Suscripción confirmada!" });
                setEmail("");
                setName("");
            }
        } catch {
            setMsg({ kind: "err", text: "No se pudo conectar con el servidor. Inténtalo más tarde." });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div id={elementId || undefined} className="wjnl-box">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {banner && (
                <div className={"wjnl-banner" + (banner.kind === "err" ? " wjnl-banner-err" : "")}>{banner.text}</div>
            )}
            <h3 className="wjnl-title">{title}</h3>
            {description ? <p className="wjnl-desc">{description}</p> : null}
            <form className="wjnl-form" onSubmit={submit}>
                {showName ? (
                    <input
                        className="wjnl-input"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Tu nombre"
                        autoComplete="name"
                    />
                ) : null}
                <input
                    className="wjnl-input"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={placeholder || "tu@correo.com"}
                    autoComplete="email"
                />
                <button className="wjnl-btn" type="submit" disabled={busy}>
                    {busy ? "Enviando…" : (buttonLabel || "Suscribirme")}
                </button>
            </form>
            {msg && <div className={"wjnl-msg " + (msg.kind === "err" ? "wjnl-err" : "wjnl-ok")}>{msg.text}</div>}
        </div>
    );
}

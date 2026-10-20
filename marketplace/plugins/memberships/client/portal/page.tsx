// @ts-nocheck
"use client";

/**
 * /portal/memberships — the newsletter preference page a member reaches from the link in every newsletter
 * (?u=<account id>&t=<token>). Opening the link unsubscribes at once (one click); the page then offers to
 * subscribe again. With &c=<token> it is instead the CONFIRMATION link mailed to a new subscriber: it
 * confirms that address for newsletters. The token is checked server-side (an HMAC of the account id), so the page needs no
 * session. Opened without a token it explains where to manage newsletters instead.
 */

import React, { useEffect, useState } from "react";

const API = "/api/v1/plugin/memberships/public/newsletter";

const STYLES = `
.wjnl-wrap { min-height: 100vh; display: grid; place-items: center; padding: 1.5rem; background: #f6f7f9; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; }
.wjnl-card { width: 100%; max-width: 440px; background: #fff; border: 1px solid #e5e7eb; border-radius: 20px; padding: 2rem 1.75rem; text-align: center; box-shadow: 0 10px 30px -12px rgba(15, 23, 42, .18); }
.wjnl-icon { width: 48px; height: 48px; margin: 0 auto .9rem; border-radius: 999px; display: grid; place-items: center; background: #eef2ff; color: #4f46e5; font-size: 22px; }
.wjnl-title { margin: 0 0 .5rem; font-size: 1.35rem; font-weight: 800; }
.wjnl-msg { margin: 0 0 1.25rem; color: #6b7280; line-height: 1.55; }
.wjnl-btn { display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 12px; padding: .75rem 1.1rem; font-weight: 800; font-size: .95rem; cursor: pointer; background: #4f46e5; color: #fff; text-decoration: none; }
.wjnl-btn:disabled { opacity: .55; cursor: not-allowed; }
.wjnl-link { display: block; margin-top: 1rem; color: #4f46e5; font-size: .9rem; }
.wjnl-error { color: #b91c1c; }
`;

/** core's double-submit CSRF token: a visitor who also has a session must echo it on a POST. */
function csrfToken() {
    for (const part of document.cookie.split(";")) {
        const raw = part.trim();
        if (raw.startsWith("wjs_csrf=")) { try { return decodeURIComponent(raw.slice(9)); } catch { return raw.slice(9); } }
    }
    return "";
}

async function call(method, body) {
    const params = new URLSearchParams(window.location.search);
    const u = params.get("u") || "";
    const t = params.get("t") || "";
    const res = method === "GET"
        ? await fetch(`${API}?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`, { cache: "no-store" })
        : await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() }, body: JSON.stringify({ u, t, ...body }) });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, body: json };
}

export default function MembershipsPortal() {
    const [state, setState] = useState({ phase: "loading", subscribed: null, error: "" });
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (!params.get("u") || !params.get("t")) { setState({ phase: "nolink", subscribed: null, error: "" }); return; }
        // The confirmation link confirms; any other link unsubscribes (one click).
        const c = params.get("c");
        call("POST", c ? { confirm: true, c } : { subscribed: false }).then((r) => {
            if (r.ok) setState({ phase: r.body.confirmed ? "confirmed" : "done", subscribed: !!r.body.subscribed, error: "" });
            else setState({ phase: "error", subscribed: null, error: r.body.error || "Este enlace no es válido." });
        }).catch(() => setState({ phase: "error", subscribed: null, error: "No se pudo contactar con el sitio." }));
    }, []);

    const toggle = async (subscribed) => {
        setBusy(true);
        const r = await call("POST", { subscribed });
        setBusy(false);
        if (r.ok) setState({ phase: "done", subscribed: !!r.body.subscribed, error: "" });
        else setState({ ...state, error: r.body.error || "No se pudo guardar." });
    };

    return (
        <div className="wjnl-wrap">
            <style>{STYLES}</style>
            <main className="wjnl-card">
                <div className="wjnl-icon" aria-hidden="true">✉</div>
                {state.phase === "loading" && <p className="wjnl-msg">Actualizando tus preferencias…</p>}
                {state.phase === "nolink" && (
                    <>
                        <h1 className="wjnl-title">Preferencias de correo</h1>
                        <p className="wjnl-msg">Usa el enlace que aparece al final de cualquier newsletter, o cambia tus preferencias desde tu cuenta en el sitio.</p>
                        <a className="wjnl-btn" href="/">Ir al sitio</a>
                    </>
                )}
                {state.phase === "error" && (
                    <>
                        <h1 className="wjnl-title">No pudimos usar este enlace</h1>
                        <p className="wjnl-msg wjnl-error">{state.error}</p>
                        <a className="wjnl-btn" href="/">Ir al sitio</a>
                    </>
                )}
                {state.phase === "confirmed" && (
                    <>
                        <h1 className="wjnl-title">Correo confirmado</h1>
                        <p className="wjnl-msg">Recibirás las newsletters de este sitio en esta dirección. Puedes darte de baja desde cualquiera de ellas.</p>
                        <a className="wjnl-btn" href="/">Ir al sitio</a>
                    </>
                )}
                {state.phase === "done" && (
                    state.subscribed ? (
                        <>
                            <h1 className="wjnl-title">Vuelves a estar suscrito</h1>
                            <p className="wjnl-msg">Recibirás las próximas newsletters de este sitio.</p>
                            <button type="button" className="wjnl-btn" disabled={busy} onClick={() => toggle(false)}>Darme de baja</button>
                        </>
                    ) : (
                        <>
                            <h1 className="wjnl-title">Te has dado de baja</h1>
                            <p className="wjnl-msg">No recibirás más newsletters. Tu cuenta y tu membresía siguen igual.</p>
                            <button type="button" className="wjnl-btn" disabled={busy} onClick={() => toggle(true)}>Volver a suscribirme</button>
                        </>
                    )
                )}
                {state.error && state.phase === "done" ? <p className="wjnl-error">{state.error}</p> : null}
                <a className="wjnl-link" href="/">Volver al sitio</a>
            </main>
        </div>
    );
}

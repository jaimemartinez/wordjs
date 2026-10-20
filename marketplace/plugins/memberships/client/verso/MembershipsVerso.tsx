// @ts-nocheck
"use client";

/**
 * Verso blocks of the Memberships plugin.
 *
 *  · MembershipsPaywall — the ACCESS BREAK. Its defaultProps carry `contentAccessBreak: true`, which is
 *    how core (backend core/content-access) knows where a members-only post's free teaser ends: the
 *    API cuts the post right after this block for anyone without access, and annotates the block with
 *    `accessState` ('locked' | 'granted') and `accessLevel` (what the post requires). Locked, it draws
 *    the call-to-action (sign up, sign in, the tiers that open the post, the provider's checkout); granted, it
 *    draws nothing. In the editor it is a visible marker.
 *  · MembershipsAccount — the member's own account box: plan, renewal, change tier, cancel / resume, or
 *    the tiers to subscribe to.
 *
 * Both handle the return from the payment provider the same way (see returnLeg): the block confirms the
 * payment with the server (which re-reads it from the provider) and reloads the page without the
 * parameters, so the members-only body loads with the new access.
 *
 * Data comes from the plugin's own endpoints, guarded with res.ok: an inactive plugin 404s and the
 * blocks degrade to nothing (paywall) or a quiet note (account).
 */

import React, { useEffect, useState } from "react";

const API = "/api/v1/plugin/memberships";

const STYLES = `
.wjms-wall { position: relative; margin: 2.5rem auto; max-width: 760px; font-family: var(--wjs-font-family-base, inherit); color: var(--wjs-color-text, #111827); }
.wjms-wall::before { content: ""; position: absolute; left: 0; right: 0; top: -7rem; height: 7rem; background: linear-gradient(to bottom, transparent, var(--wjs-bg, #fff)); pointer-events: none; }
.wjms-card { background: var(--wjs-bg-surface, #fff); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: 20px; padding: 2rem 1.75rem; text-align: center; box-shadow: 0 10px 30px -12px rgba(15, 23, 42, .18); }
.wjms-lock { width: 44px; height: 44px; margin: 0 auto .75rem; border-radius: 999px; display: grid; place-items: center; background: color-mix(in srgb, var(--wjs-color-primary, #2563eb) 12%, transparent); color: var(--wjs-color-primary, #2563eb); }
.wjms-title { margin: 0 0 .4rem; font-size: 1.45rem; font-weight: 800; line-height: 1.25; color: var(--wjs-color-heading, #111827); }
.wjms-msg { margin: 0 auto 1.25rem; max-width: 520px; color: var(--wjs-color-text-muted, #6b7280); line-height: 1.55; }
.wjms-tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: .9rem; margin: 1.25rem 0 1rem; text-align: left; }
.wjms-tier { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: 16px; padding: 1.1rem 1.1rem 1rem; display: flex; flex-direction: column; gap: .5rem; background: var(--wjs-bg, #fff); }
.wjms-tier-name { font-weight: 800; font-size: 1.05rem; }
.wjms-price { font-size: 1.6rem; font-weight: 800; color: var(--wjs-color-heading, #111827); }
.wjms-price small { font-size: .85rem; font-weight: 600; color: var(--wjs-color-text-muted, #6b7280); }
.wjms-desc { font-size: .9rem; color: var(--wjs-color-text-muted, #6b7280); margin: 0; }
.wjms-benefits { list-style: none; padding: 0; margin: .25rem 0 .5rem; font-size: .9rem; display: grid; gap: .3rem; }
.wjms-benefits li::before { content: "✓"; color: var(--wjs-color-primary, #2563eb); font-weight: 800; margin-right: .45rem; }
.wjms-btn { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; border: none; border-radius: 12px; padding: .75rem 1.1rem; font-weight: 800; font-size: .95rem; cursor: pointer; text-decoration: none; background: var(--wjs-color-primary, #2563eb); color: #fff; transition: opacity .15s; margin-top: auto; }
.wjms-btn:hover { opacity: .9; }
.wjms-btn:disabled { opacity: .55; cursor: not-allowed; }
.wjms-btn-ghost { background: transparent; color: var(--wjs-color-primary, #2563eb); border: 1px solid var(--wjs-border-subtle, #d1d5db); }
.wjms-actions { display: flex; flex-wrap: wrap; gap: .6rem; justify-content: center; }
.wjms-note { font-size: .85rem; color: var(--wjs-color-text-muted, #6b7280); margin-top: .9rem; }
.wjms-error { color: #dc2626; font-size: .9rem; margin-top: .75rem; }
.wjms-ok { background: #ecfdf5; border: 1px solid #a7f3d0; color: #047857; border-radius: 12px; padding: .75rem 1rem; font-weight: 700; margin-bottom: 1rem; }
.wjms-marker { margin: 1.5rem 0; padding: .9rem 1rem; border: 2px dashed var(--wjs-color-primary, #2563eb); border-radius: 12px; color: var(--wjs-color-primary, #2563eb); font-weight: 700; font-size: .9rem; display: flex; gap: .6rem; align-items: center; background: color-mix(in srgb, var(--wjs-color-primary, #2563eb) 6%, transparent); }
.wjms-marker span { font-weight: 500; color: var(--wjs-color-text-muted, #6b7280); }
.wjms-account { max-width: 640px; margin: 0 auto; }
.wjms-row { display: flex; justify-content: space-between; gap: 1rem; padding: .55rem 0; border-bottom: 1px dashed var(--wjs-border-subtle, #e5e7eb); font-size: .95rem; text-align: left; }
.wjms-row:last-child { border-bottom: none; }
.wjms-badge { display: inline-block; padding: .15rem .6rem; border-radius: 999px; font-size: .78rem; font-weight: 800; background: #ecfdf5; color: #047857; }
.wjms-badge.is-off { background: #fef2f2; color: #b91c1c; }
.wjms-select { padding: .6rem .75rem; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: 10px; font: inherit; background: var(--wjs-bg, #fff); color: inherit; }
@media (max-width: 480px) { .wjms-card { padding: 1.5rem 1.1rem; } .wjms-title { font-size: 1.2rem; } }
`;

const LockIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
);

/** The double-submit CSRF token core issues with every session (wjs_csrf, readable on purpose). */
function csrfToken() {
    if (typeof document === "undefined") return "";
    for (const part of document.cookie.split(";")) {
        const raw = part.trim();
        if (raw.startsWith("wjs_csrf=")) {
            try { return decodeURIComponent(raw.slice(9)); } catch { return raw.slice(9); }
        }
    }
    return "";
}

async function getJson(path) {
    const res = await fetch(API + path, { credentials: "same-origin", cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
}

async function postJson(path, data) {
    const res = await fetch(API + path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
        body: JSON.stringify(data || {}),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
}

const fmtPrice = (cents, symbol) => `${symbol || "$"}${(Math.round(cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const perLabel = (interval) => (interval === "year" ? "/año" : "/mes");
const fmtDay = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
};

function here() {
    if (typeof window === "undefined") return "/";
    return window.location.pathname + window.location.search;
}

/** `?redirect=` back to this page, for core's sign-in / sign-up pages. */
const authHref = (path) => `${path}?redirect=${encodeURIComponent(here())}`;

/** Which tiers open a post that requires `level`. */
function tiersFor(level, tiers) {
    if (!Array.isArray(tiers)) return [];
    if (typeof level === "string" && level.startsWith("tier:")) {
        const wanted = tiers.find((t) => t.slug === level.slice(5));
        // The plugin ranks tiers by their price PER MONTH (a yearly price covers twelve months).
        const monthly = (t) => (Number(t.price_cents) || 0) / (t.interval === "year" ? 12 : 1);
        return wanted ? tiers.filter((t) => monthly(t) >= monthly(wanted)) : tiers;
    }
    return tiers;
}

/**
 * The provider's return leg, if this page load is one: Stripe appends `ms_session`, Mercado Pago
 * `preapproval_id` (with our `ms_provider=mercadopago`), Wompi `id` (with `ms_provider=wompi`).
 */
function returnLeg(params) {
    const enc = encodeURIComponent;
    const sid = params.get("ms_session");
    if (sid) return { query: `session_id=${enc(sid)}`, strip: ["ms_session"] };
    const provider = params.get("ms_provider");
    if (provider === "mercadopago" && params.get("preapproval_id")) {
        return { query: `provider=mercadopago&preapproval_id=${enc(params.get("preapproval_id"))}`, strip: ["ms_provider", "preapproval_id"] };
    }
    if (provider === "wompi" && params.get("id")) {
        return { query: `provider=wompi&id=${enc(params.get("id"))}`, strip: ["ms_provider", "id", "env"] };
    }
    return null;
}

/**
 * Load the public tier list and (when signed in) the account; handle the payment return leg once.
 * `me` is null when signed out (401).
 */
function useMembership(active) {
    const [state, setState] = useState({ loading: true, tiers: [], cfg: null, me: null, unavailable: false });
    const [banner, setBanner] = useState("");
    const reload = async () => {
        const [t, m] = await Promise.all([getJson("/public/tiers"), getJson("/me")]);
        if (!t.ok) { setState({ loading: false, tiers: [], cfg: null, me: null, unavailable: true }); return; }
        setState({ loading: false, tiers: t.body.tiers || [], cfg: t.body, me: m.ok ? m.body : null, unavailable: false });
    };
    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        (async () => {
            const params = new URLSearchParams(window.location.search);
            const ret = returnLeg(params);
            if (ret) {
                setBanner("Confirmando tu pago…");
                const r = await getJson(`/me/confirm?${ret.query}`);
                for (const k of ret.strip) params.delete(k);
                const qs = params.toString();
                const clean = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
                if (r.ok && r.body && r.body.active) {
                    // Reload WITHOUT the parameters: the post's members-only body now loads for this account.
                    window.location.replace(clean);
                    return;
                }
                window.history.replaceState(null, "", clean);
                setBanner(r.ok ? "Tu pago aún se está procesando — recarga en unos segundos." : ((r.body && r.body.error) || "No se pudo confirmar el pago."));
            } else if (params.get("ms_cancel") || params.get("ms_provider")) {
                // Back from the provider without a payment to confirm (abandoned or cancelled there).
                for (const k of ["ms_cancel", "ms_provider", "preapproval_id", "id", "env"]) params.delete(k);
                const qs = params.toString();
                window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
                setBanner("Pago cancelado — no se te ha cobrado nada.");
            }
            if (!cancelled) await reload();
        })();
        return () => { cancelled = true; };
    }, [active]);
    return { ...state, banner, setBanner, reload };
}

function TierCard({ tier, symbol, action }) {
    return (
        <div className="wjms-tier">
            <div className="wjms-tier-name">{tier.name}</div>
            <div className="wjms-price">{fmtPrice(tier.price_cents, symbol)} <small>{perLabel(tier.interval)}</small></div>
            {tier.description ? <p className="wjms-desc">{tier.description}</p> : null}
            {tier.benefits && tier.benefits.length ? (
                <ul className="wjms-benefits">{tier.benefits.map((b, i) => <li key={i}>{b}</li>)}</ul>
            ) : null}
            {action}
        </div>
    );
}

function useCheckout() {
    const [busy, setBusy] = useState(0);
    const [error, setError] = useState("");
    const start = async (tierId) => {
        setError("");
        setBusy(tierId);
        const r = await postJson("/checkout", { tier_id: tierId, page_url: window.location.href });
        if (r.ok && r.body && r.body.checkoutUrl) { window.location.assign(r.body.checkoutUrl); return; }
        setBusy(0);
        setError((r.body && r.body.error) || "No se pudo iniciar el pago.");
    };
    return { busy, error, start };
}

// ================================================================================================
// Paywall
// ================================================================================================

const paywallDef = {
    label: "Muro de pago (miembros)",
    fields: {
        title: { type: "text", label: "Título" },
        message: { type: "textarea", label: "Mensaje" },
        showTiers: {
            type: "radio",
            label: "Mostrar los planes de pago",
            options: [{ label: "Sí", value: true }, { label: "No", value: false }],
        },
    },
    defaultProps: {
        // THE ACCESS BREAK (backend core/content-access): core cuts a members-only post's teaser here.
        contentAccessBreak: true,
        title: "Sigue leyendo como miembro",
        message: "El resto de esta entrada es para miembros. Únete para leerla completa.",
        showTiers: true,
    },
};

function PaywallVerso({ title, message, showTiers, accessState, accessLevel, isEditing, puck }) {
    const editing = !!(isEditing || (puck && puck.isEditing));
    const locked = !editing && accessState === "locked";
    const m = useMembership(locked);
    const checkout = useCheckout();

    if (editing) {
        return (
            <div className="wjms-marker">
                <style>{STYLES}</style>
                <LockIcon />
                <div>
                    Muro de pago — lo que va debajo es solo para miembros.{" "}
                    <span>Elige quién puede leerlo en «Acceso», en la configuración de la entrada.</span>
                </div>
            </div>
        );
    }
    // Granted (or the post is not gated at all): the wall is invisible.
    if (!locked) return null;
    if (m.unavailable) return null;

    const symbol = m.cfg ? m.cfg.currencySymbol : "$";
    const level = accessLevel || "members";
    const offered = tiersFor(level, m.tiers);
    const signedIn = !!m.me;
    const holds = signedIn && Array.isArray(m.me.levels) && m.me.levels.includes(level);
    const freeOpens = level === "members" && m.cfg && m.cfg.freeSignup;

    return (
        <section className="wjms-wall" aria-label="Contenido para miembros">
            <style>{STYLES}</style>
            <div className="wjms-card">
                {m.banner ? <div className="wjms-ok">{m.banner}</div> : null}
                <div className="wjms-lock"><LockIcon /></div>
                <h2 className="wjms-title">{title}</h2>
                {message ? <p className="wjms-msg">{message}</p> : null}

                {m.loading ? <p className="wjms-note">Cargando…</p> : holds ? (
                    <p className="wjms-note">Ya tienes acceso — cargando el resto de la entrada…</p>
                ) : (
                    <>
                        {!signedIn && (
                            <div className="wjms-actions">
                                {freeOpens || (m.cfg && m.cfg.freeSignup) ? (
                                    <a className="wjms-btn" href={authHref("/register")}>{freeOpens ? "Crear cuenta gratis" : "Crear cuenta"}</a>
                                ) : null}
                                <a className="wjms-btn wjms-btn-ghost" href={authHref("/login")}>Ya soy miembro — iniciar sesión</a>
                            </div>
                        )}
                        {showTiers !== false && offered.length > 0 && (level !== "members" || !freeOpens || signedIn) && (
                            <div className="wjms-tiers">
                                {offered.map((t) => (
                                    <TierCard key={t.id} tier={t} symbol={symbol} action={
                                        !signedIn ? (
                                            <a className="wjms-btn" href={authHref("/register")}>Suscribirme</a>
                                        ) : m.cfg && m.cfg.paymentsEnabled ? (
                                            <button type="button" className="wjms-btn" disabled={!!checkout.busy} onClick={() => checkout.start(t.id)}>
                                                {checkout.busy === t.id ? "Abriendo el pago…" : "Suscribirme"}
                                            </button>
                                        ) : (
                                            <span className="wjms-note">El pago en línea aún no está disponible.</span>
                                        )
                                    } />
                                ))}
                            </div>
                        )}
                        {signedIn && level === "members" && !freeOpens && offered.length === 0 && (
                            <p className="wjms-note">Tu cuenta todavía no tiene una membresía activa.</p>
                        )}
                        {!signedIn && level !== "members" && offered.length > 0 && (
                            <p className="wjms-note">Crea tu cuenta (o inicia sesión) y vuelve aquí para elegir un plan.</p>
                        )}
                        {checkout.error ? <p className="wjms-error">{checkout.error}</p> : null}
                    </>
                )}
            </div>
        </section>
    );
}

// ================================================================================================
// Account
// ================================================================================================

const accountDef = {
    label: "Mi membresía",
    fields: {
        title: { type: "text", label: "Título" },
    },
    defaultProps: {
        title: "Mi membresía",
    },
};

/** Newsletter preference of the signed-in member (GET/POST /me/newsletter). */
function NewsletterToggle() {
    const [pref, setPref] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let active = true;
        getJson("/me/newsletter").then((r) => { if (active && r.ok) setPref(r.body); });
        return () => { active = false; };
    }, []);
    if (!pref || pref.enabled === false) return null;
    const toggle = async () => {
        setBusy(true);
        const r = await postJson("/me/newsletter", { subscribed: !pref.subscribed });
        setBusy(false);
        if (r.ok) setPref(r.body);
    };
    const [note, setNote] = useState("");
    const askLink = async () => {
        setBusy(true);
        const r = await postJson("/me/newsletter/confirm", {});
        setBusy(false);
        if (r.ok) { setPref(r.body); setNote(`Te enviamos el enlace de confirmación a ${r.body.email || "tu correo"}.`); }
        else setNote((r.body && r.body.error) || "No se pudo enviar el enlace.");
    };
    return (
        <div className="wjms-row" style={{ alignItems: "center" }}>
            <span>Newsletters por correo</span>
            <label style={{ display: "inline-flex", gap: ".5rem", alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={!!pref.subscribed} disabled={busy} onChange={toggle} />
                {pref.subscribed ? (pref.confirmed ? "Suscrito" : "Pendiente de confirmar") : "No suscrito"}
            </label>
            {pref.subscribed && !pref.confirmed ? (
                <div style={{ flexBasis: "100%", fontSize: ".85rem", marginTop: ".4rem" }}>
                    <span>Confirma tu correo para recibirlas. </span>
                    <button type="button" className="wjms-btn wjms-btn-ghost" disabled={busy} onClick={askLink}>Enviarme el enlace</button>
                    {note ? <div role="status" style={{ marginTop: ".3rem" }}>{note}</div> : null}
                </div>
            ) : null}
        </div>
    );
}

/**
 * Automatic renewal where the provider does not renew on its own (Wompi): the member links a Nequi
 * account (approved in the Nequi app) and the site charges it each period.
 */
function AutoRenew({ member, onChange }) {
    const [phone, setPhone] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const st = member.autoRenew || {};
    const run = async (path, body) => {
        setError("");
        setBusy(true);
        const r = await postJson(path, body);
        setBusy(false);
        if (!r.ok) { setError((r.body && r.body.error) || "No se pudo completar la operación."); return; }
        await onChange();
    };
    if (st.state === "active" || st.state === "paused") {
        return (
            <div className="wjms-row" style={{ alignItems: "center" }}>
                <span>Renovación automática</span>
                <span style={{ display: "inline-flex", gap: ".6rem", alignItems: "center" }}>
                    <span className="wjms-badge">Nequi</span>
                    <button type="button" className="wjms-btn wjms-btn-ghost" style={{ padding: ".35rem .7rem", marginTop: 0 }} disabled={busy} onClick={() => run("/me/auto-renew/stop", {})}>Quitar</button>
                </span>
            </div>
        );
    }
    if (st.state === "pending") {
        return (
            <div className="wjms-row" style={{ alignItems: "center" }}>
                <span>Renovación automática</span>
                <span style={{ display: "inline-flex", gap: ".6rem", alignItems: "center" }}>
                    Aprueba la solicitud en tu app Nequi
                    <button type="button" className="wjms-btn wjms-btn-ghost" style={{ padding: ".35rem .7rem", marginTop: 0 }} disabled={busy} onClick={onChange}>Ya la aprobé</button>
                </span>
            </div>
        );
    }
    return (
        <div style={{ marginTop: "1rem", textAlign: "left" }}>
            <p className="wjms-note" style={{ marginTop: 0 }}>
                {st.state === "declined" ? "Nequi rechazó la autorización. " : ""}
                Renueva automáticamente con Nequi: escribe tu número y aprueba la solicitud en la app.
            </p>
            <div className="wjms-actions" style={{ justifyContent: "flex-start" }}>
                <input className="wjms-select" inputMode="numeric" autoComplete="tel" placeholder="3001234567" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Número de Nequi" />
                <button type="button" className="wjms-btn" style={{ marginTop: 0 }} disabled={busy || phone.replace(/\D/g, "").length !== 10} onClick={() => run("/me/auto-renew/nequi", { phone })}>
                    {busy ? "Enviando…" : "Renovar con Nequi"}
                </button>
            </div>
            {error ? <p className="wjms-error">{error}</p> : null}
        </div>
    );
}

const STATUS_TEXT = { active: "Activa", past_due: "Pago pendiente", canceled: "Cancelada", incomplete: "Incompleta", expired: "Vencida" };

function AccountVerso({ title, isEditing, puck }) {
    const editing = !!(isEditing || (puck && puck.isEditing));
    const m = useMembership(!editing);
    const checkout = useCheckout();
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [target, setTarget] = useState("");

    if (editing) {
        return (
            <div className="wjms-account">
                <style>{STYLES}</style>
                <div className="wjms-card"><h2 className="wjms-title">{title}</h2><p className="wjms-msg">Aquí cada miembro verá su plan, la renovación y las opciones para cambiar de plan o cancelar.</p></div>
            </div>
        );
    }
    if (m.unavailable) return <p className="wjms-note">Las membresías no están disponibles ahora mismo.</p>;

    const symbol = m.cfg ? m.cfg.currencySymbol : "$";
    const member = m.me && m.me.member;
    const act = async (path, body, label) => {
        setError("");
        setBusy(label);
        const r = await postJson(path, body);
        setBusy("");
        if (!r.ok) { setError((r.body && r.body.error) || "No se pudo completar la operación."); return; }
        const effective = r.body && r.body.effective;
        m.setBanner(label === "cancel" ? "Tu suscripción terminará al final del periodo pagado." : label === "resume" ? "Tu suscripción seguirá renovándose."
            : effective === "next-period" ? "El nuevo plan empieza con el próximo periodo." : effective === "next-charge" ? "El nuevo plan empieza con tu próximo cobro (al nuevo precio)."
            : effective === "pending-payment" ? "Cobramos la diferencia: el nuevo plan se activa en cuanto se confirme el pago." : "Plan cambiado.");
        await m.reload();
    };

    return (
        <section className="wjms-account">
            <style>{STYLES}</style>
            <div className="wjms-card">
                {m.banner ? <div className="wjms-ok">{m.banner}</div> : null}
                <h2 className="wjms-title">{title}</h2>
                {m.loading ? <p className="wjms-note">Cargando…</p> : !m.me ? (
                    <>
                        <p className="wjms-msg">Inicia sesión para ver tu membresía.</p>
                        <div className="wjms-actions">
                            <a className="wjms-btn" href={authHref("/login")}>Iniciar sesión</a>
                            <a className="wjms-btn wjms-btn-ghost" href={authHref("/register")}>Crear cuenta</a>
                        </div>
                    </>
                ) : member && member.active ? (
                    <>
                        <div className="wjms-row"><span>Plan</span><strong>{member.tier ? member.tier.name : "—"}</strong></div>
                        <div className="wjms-row"><span>Estado</span><span className="wjms-badge">{STATUS_TEXT[member.status] || member.status}</span></div>
                        {member.source === "comped" ? (
                            <div className="wjms-row"><span>Cortesía</span><span>{member.compedUntil ? `hasta el ${fmtDay(member.compedUntil)}` : "sin fecha de fin"}</span></div>
                        ) : (
                            <div className="wjms-row"><span>{member.cancelAtPeriodEnd ? "Termina el" : member.autoRenew && member.autoRenew.state !== "active" ? "Pagado hasta" : "Se renueva el"}</span><span>{fmtDay(member.currentPeriodEnd)}</span></div>
                        )}
                        {member.pendingTier ? (
                            <div className="wjms-row"><span>{member.source === "stripe" ? "Cuando se pague la diferencia" : "Desde el próximo periodo"}</span><span>{member.pendingTier.name}</span></div>
                        ) : null}
                        {member.autoRenew ? <AutoRenew member={member} onChange={m.reload} /> : null}
                        {member.canRenewNow && member.tier ? (
                            <div className="wjms-actions" style={{ marginTop: "1rem" }}>
                                <button type="button" className="wjms-btn" disabled={!!checkout.busy} onClick={() => checkout.start(member.tier.id)}>
                                    {checkout.busy === member.tier.id ? "Abriendo el pago…" : "Pagar el siguiente periodo"}
                                </button>
                            </div>
                        ) : null}
                        {member.canManageBilling && (
                            <div style={{ marginTop: "1rem", display: "grid", gap: ".75rem" }}>
                                <div className="wjms-actions">
                                    <select className="wjms-select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Cambiar a otro plan">
                                        <option value="">Cambiar a otro plan…</option>
                                        {m.tiers.filter((t) => !member.tier || t.id !== member.tier.id).map((t) => (
                                            <option key={t.id} value={t.id}>{t.name} — {fmtPrice(t.price_cents, symbol)}{perLabel(t.interval)}</option>
                                        ))}
                                    </select>
                                    <button type="button" className="wjms-btn" disabled={!target || !!busy} onClick={() => act("/me/change-tier", { tier_id: Number(target) }, "change")}>
                                        {busy === "change" ? "Cambiando…" : "Cambiar plan"}
                                    </button>
                                </div>
                                <div className="wjms-actions">
                                    {member.cancelAtPeriodEnd ? (
                                        <button type="button" className="wjms-btn wjms-btn-ghost" disabled={!!busy} onClick={() => act("/me/resume", {}, "resume")}>
                                            {busy === "resume" ? "Reanudando…" : "Seguir suscrito"}
                                        </button>
                                    ) : (
                                        <button type="button" className="wjms-btn wjms-btn-ghost" disabled={!!busy} onClick={() => act("/me/cancel", {}, "cancel")}>
                                            {busy === "cancel" ? "Cancelando…" : "Cancelar la suscripción"}
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        <p className="wjms-msg">
                            {member && member.status === "canceled" ? "Tu membresía terminó. " : ""}
                            {m.cfg && m.cfg.freeSignup ? "Tu cuenta ya es miembro gratuito. " : ""}
                            {m.tiers.length ? "Elige un plan para leer todo el contenido de pago." : ""}
                        </p>
                        {m.tiers.length > 0 && (
                            <div className="wjms-tiers">
                                {m.tiers.map((t) => (
                                    <TierCard key={t.id} tier={t} symbol={symbol} action={
                                        m.cfg && m.cfg.paymentsEnabled ? (
                                            <button type="button" className="wjms-btn" disabled={!!checkout.busy} onClick={() => checkout.start(t.id)}>
                                                {checkout.busy === t.id ? "Abriendo el pago…" : "Suscribirme"}
                                            </button>
                                        ) : <span className="wjms-note">El pago en línea aún no está disponible.</span>
                                    } />
                                ))}
                            </div>
                        )}
                    </>
                )}
                {m.me ? <div style={{ marginTop: "1rem" }}><NewsletterToggle /></div> : null}
                {error || checkout.error ? <p className="wjms-error">{error || checkout.error}</p> : null}
            </div>
        </section>
    );
}

export const versoComponents = {
    MembershipsPaywall: { ...paywallDef, render: PaywallVerso },
    MembershipsAccount: { ...accountDef, render: AccountVerso },
};

export const versoComponentDef = paywallDef;
export default PaywallVerso;

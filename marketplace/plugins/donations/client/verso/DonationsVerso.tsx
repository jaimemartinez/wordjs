// @ts-nocheck
"use client";

/**
 * Verso block "Donations" — donation card for a campaign: image, title, description, animated goal
 * thermometer, preset amount chips + custom amount, donor form (name/email/message/anonymous),
 * payment method (manual always, card when the server has a Stripe key) and an optional wall of
 * recent donations.
 *
 * Runs in the editor iframe AND on the public page: all data arrives via client-mount fetches
 * against the plugin's PUBLIC endpoints, guarded with res.ok (an inactive plugin 404s — the block
 * degrades to a quiet Spanish placeholder instead of crashing the page).
 *
 * Stripe return leg: when the page URL carries ?session_id=&donation= (set by the server as the
 * Checkout success_url), the block calls /public/confirm-stripe and shows a thanks banner.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

const STYLES = `
.wjdn-card { max-width: 640px; margin: 0 auto; background: var(--wjs-bg-surface, #fff); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: 18px; overflow: hidden; font-family: var(--wjs-font-family-base, inherit); color: var(--wjs-color-text, #111827); }
.wjdn-img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; }
.wjdn-body { padding: 1.5rem; }
.wjdn-title { margin: 0 0 .5rem; font-size: 1.45rem; font-weight: 800; line-height: 1.2; }
.wjdn-desc { margin: 0 0 1.1rem; font-size: .95rem; line-height: 1.55; color: var(--wjs-color-text-muted, #6b7280); white-space: pre-wrap; }
.wjdn-thermo { height: 14px; background: var(--wjs-border-subtle, #e5e7eb); border-radius: 999px; overflow: hidden; }
.wjdn-thermo-fill { height: 100%; width: 0; background: var(--wjdn-accent, #e11d48); border-radius: 999px; transition: width 1.1s cubic-bezier(.22,.9,.35,1); }
.wjdn-thermo-meta { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; margin-top: .45rem; margin-bottom: 1.1rem; font-size: .85rem; color: var(--wjs-color-text-muted, #6b7280); flex-wrap: wrap; }
.wjdn-thermo-meta strong { color: var(--wjs-color-text, #111827); font-size: 1rem; }
.wjdn-pct { font-weight: 800; color: var(--wjdn-accent, #e11d48); }
.wjdn-chips { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .75rem; }
.wjdn-chip { border: 2px solid var(--wjs-border-subtle, #e5e7eb); background: transparent; color: inherit; border-radius: 999px; padding: .45rem 1rem; font-weight: 700; font-size: .95rem; cursor: pointer; transition: all .15s; }
.wjdn-chip:hover { border-color: var(--wjdn-accent, #e11d48); }
.wjdn-chip-active { background: var(--wjdn-accent, #e11d48); border-color: var(--wjdn-accent, #e11d48); color: #fff; }
.wjdn-field { margin-bottom: .8rem; }
.wjdn-label { display: block; font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--wjs-color-text-muted, #6b7280); margin-bottom: .3rem; }
.wjdn-input, .wjdn-textarea { width: 100%; box-sizing: border-box; padding: .65rem .85rem; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: 10px; font: inherit; background: var(--wjs-bg, #fff); color: inherit; }
.wjdn-input:focus, .wjdn-textarea:focus { outline: 2px solid var(--wjdn-accent, #e11d48); outline-offset: 1px; border-color: transparent; }
.wjdn-textarea { min-height: 76px; resize: vertical; }
.wjdn-check { display: flex; align-items: center; gap: .5rem; font-size: .9rem; margin-bottom: .9rem; cursor: pointer; user-select: none; }
.wjdn-methods { display: flex; flex-direction: column; gap: .5rem; margin-bottom: 1rem; }
.wjdn-method { display: flex; align-items: center; gap: .6rem; border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: 10px; padding: .6rem .85rem; cursor: pointer; font-size: .92rem; }
.wjdn-method-active { border-color: var(--wjdn-accent, #e11d48); box-shadow: 0 0 0 1px var(--wjdn-accent, #e11d48); }
.wjdn-submit { width: 100%; border: none; border-radius: 12px; padding: .9rem 1rem; background: var(--wjdn-accent, #e11d48); color: #fff; font-weight: 800; font-size: 1rem; cursor: pointer; transition: opacity .15s; }
.wjdn-submit:hover { opacity: .9; }
.wjdn-submit:disabled { opacity: .5; cursor: not-allowed; }
.wjdn-error { margin: .6rem 0 0; font-size: .88rem; color: #dc2626; }
.wjdn-banner { background: #ecfdf5; border: 1px solid #a7f3d0; color: #047857; border-radius: 12px; padding: .85rem 1rem; font-weight: 700; margin-bottom: 1rem; }
.wjdn-done { background: var(--wjs-bg-surface, #f9fafb); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: 12px; padding: 1rem 1.1rem; }
.wjdn-done h4 { margin: 0 0 .5rem; font-size: 1.05rem; }
.wjdn-done pre { white-space: pre-wrap; font: inherit; margin: .5rem 0; }
.wjdn-ref { font-size: .8rem; color: var(--wjs-color-text-muted, #6b7280); word-break: break-all; }
.wjdn-recent { margin-top: 1.25rem; border-top: 1px solid var(--wjs-border-subtle, #e5e7eb); padding-top: 1rem; }
.wjdn-recent h4 { margin: 0 0 .6rem; font-size: .8rem; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--wjs-color-text-muted, #6b7280); }
.wjdn-recent-item { display: flex; justify-content: space-between; gap: .75rem; padding: .4rem 0; font-size: .9rem; border-bottom: 1px dashed var(--wjs-border-subtle, #f3f4f6); }
.wjdn-recent-item:last-child { border-bottom: none; }
.wjdn-recent-msg { color: var(--wjs-color-text-muted, #6b7280); font-size: .82rem; margin-top: .1rem; }
.wjdn-recent-amount { font-weight: 800; white-space: nowrap; }
.wjdn-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: 12px; font-size: .9rem; max-width: 640px; margin: 0 auto; }
.wjdn-hp { position: absolute; left: -9999px; top: -9999px; height: 1px; width: 1px; overflow: hidden; }
@media (max-width: 480px) { .wjdn-body { padding: 1.1rem; } .wjdn-title { font-size: 1.2rem; } }
`;

const fmtMoney = (cents, symbol) =>
    `${symbol || "$"}${(Math.round(cents || 0) / 100).toLocaleString("es", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

// Module-level subcomponents ONLY (a component defined inside a component remounts on every render
// and steals input focus).

function Thermometer({ campaign, symbol }) {
    const goal = campaign.goal_cents || 0;
    const raised = campaign.raised_cents || 0;
    const pct = goal > 0 ? Math.min(100, Math.round((raised * 100) / goal)) : 0;
    const [fill, setFill] = useState(0);
    // Start at 0 and move to pct after mount so the CSS width transition animates.
    useEffect(() => {
        const t = setTimeout(() => setFill(pct), 60);
        return () => clearTimeout(t);
    }, [pct]);
    if (goal <= 0) {
        return (
            <div className="wjdn-thermo-meta">
                <span><strong>{fmtMoney(raised, symbol)}</strong> recaudados</span>
            </div>
        );
    }
    return (
        <div>
            <div className="wjdn-thermo" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="wjdn-thermo-fill" style={{ width: `${fill}%` }} />
            </div>
            <div className="wjdn-thermo-meta">
                <span><strong>{fmtMoney(raised, symbol)}</strong> de {fmtMoney(goal, symbol)}</span>
                <span className="wjdn-pct">{pct}%</span>
            </div>
        </div>
    );
}

function RecentList({ items, symbol }) {
    if (!items || items.length === 0) return null;
    return (
        <div className="wjdn-recent">
            <h4>Donaciones recientes</h4>
            {items.map((d, i) => (
                <div key={i} className="wjdn-recent-item">
                    <div>
                        <div>{d.name}</div>
                        {d.message ? <div className="wjdn-recent-msg">“{d.message}”</div> : null}
                    </div>
                    <div className="wjdn-recent-amount">{fmtMoney(d.amount_cents, symbol)}</div>
                </div>
            ))}
        </div>
    );
}

export const versoComponentDef = {
    category: "Donaciones",
    fields: {
        campaignSlug: { type: "text", label: "Slug de la campaña (vacío = primera activa)" },
        showGoal: {
            type: "radio",
            label: "Mostrar termómetro de meta",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        showRecent: {
            type: "radio",
            label: "Mostrar donaciones recientes",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        accentColor: { type: "text", label: "Color de acento (hex)" },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        campaignSlug: "",
        showGoal: true,
        showRecent: true,
        accentColor: "#e11d48",
        elementId: "",
    },
};

export default function DonationsVerso({ campaignSlug, showGoal, showRecent, accentColor, elementId }) {
    const [cfg, setCfg] = useState(null);            // null = loading
    const [campaign, setCampaign] = useState(undefined); // undefined = loading, null = none found
    const [recent, setRecent] = useState([]);
    const [reloadKey, setReloadKey] = useState(0);   // bumped after a confirmed Stripe payment
    const [thanks, setThanks] = useState(false);

    // Form state
    const [presetSel, setPresetSel] = useState(null); // number (units) | 'custom'
    const [customAmount, setCustomAmount] = useState("");
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [message, setMessage] = useState("");
    const [anonymous, setAnonymous] = useState(false);
    const [method, setMethod] = useState("manual");
    const [hp, setHp] = useState("");                // honeypot — humans never see/fill it
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(null);          // { token, manualInstructions }
    const mountRef = useRef(Date.now());

    // Display config (currency, presets, whether card payments are available)
    useEffect(() => {
        let alive = true;
        fetch("/api/v1/plugin/donations/public/donations-config")
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive && d) setCfg(d); })
            .catch(() => {});
        return () => { alive = false; };
    }, []);

    // Campaign (by slug or first active)
    useEffect(() => {
        let alive = true;
        const qs = campaignSlug ? `?slug=${encodeURIComponent(campaignSlug)}` : "";
        fetch(`/api/v1/plugin/donations/public/campaign${qs}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive) setCampaign(d && d.campaign ? d.campaign : null); })
            .catch(() => { if (alive) setCampaign(null); });
        return () => { alive = false; };
    }, [campaignSlug, reloadKey]);

    // Recent paid donations
    useEffect(() => {
        if (!showRecent || !campaign || !campaign.id) { setRecent([]); return; }
        let alive = true;
        fetch(`/api/v1/plugin/donations/public/recent?campaign_id=${campaign.id}&limit=5`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive) setRecent((d && d.donations) || []); })
            .catch(() => { if (alive) setRecent([]); });
        return () => { alive = false; };
    }, [showRecent, campaign && campaign.id, reloadKey]);

    // Stripe return leg: ?session_id=&donation= → confirm server-side → thanks banner.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const sp = new URLSearchParams(window.location.search);
        const sid = sp.get("session_id");
        const tok = sp.get("donation");
        if (!sid || !tok) return;
        let alive = true;
        fetch(`/api/v1/plugin/donations/public/confirm-stripe?session_id=${encodeURIComponent(sid)}&token=${encodeURIComponent(tok)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!alive) return;
                if (d && d.paid) {
                    setThanks(true);
                    setReloadKey((k) => k + 1); // refresh the thermometer + recent wall
                }
                // Clean the URL so a refresh doesn't re-confirm (harmless anyway — it's idempotent).
                try {
                    const u = new URL(window.location.href);
                    u.searchParams.delete("session_id");
                    u.searchParams.delete("donation");
                    window.history.replaceState({}, "", u.toString());
                } catch { /* ignore */ }
            })
            .catch(() => {});
        return () => { alive = false; };
    }, []);

    const presets = (cfg && cfg.presets && cfg.presets.length ? cfg.presets : [10, 25, 50, 100]);
    const symbol = (cfg && cfg.currencySymbol) || "$";
    const stripeEnabled = !!(cfg && cfg.stripeEnabled);

    const amountCents = useMemo(() => {
        if (presetSel === "custom") {
            const n = Number(String(customAmount).replace(",", "."));
            if (!Number.isFinite(n) || n <= 0) return 0;
            return Math.round(n * 100);
        }
        if (typeof presetSel === "number") return Math.round(presetSel * 100);
        return 0;
    }, [presetSel, customAmount]);

    const submit = async (e) => {
        e.preventDefault();
        setError("");
        if (!campaign || !campaign.id) return;
        if (!Number.isInteger(amountCents) || amountCents < 100) {
            setError("Elige o ingresa un monto válido (mínimo 1).");
            return;
        }
        if (!name.trim()) { setError("Ingresa tu nombre."); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Ingresa un correo electrónico válido."); return; }
        setSubmitting(true);
        try {
            let pageUrl = "";
            try {
                const u = new URL(window.location.href);
                u.searchParams.delete("session_id");
                u.searchParams.delete("donation");
                u.hash = "";
                pageUrl = u.toString();
            } catch { pageUrl = window.location.href; }
            const res = await fetch("/api/v1/plugin/donations/public/donate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    campaign_id: campaign.id,
                    amount_cents: amountCents,
                    donor_name: name.trim(),
                    donor_email: email.trim(),
                    message: message.trim(),
                    is_anonymous: anonymous,
                    payment_method: stripeEnabled && method === "stripe" ? "stripe" : "manual",
                    page_url: pageUrl,
                    hp,
                    elapsed: Date.now() - mountRef.current,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError((data && data.error) || "No se pudo procesar la donación — inténtalo de nuevo.");
                return;
            }
            if (data.checkoutUrl) {
                window.location.href = data.checkoutUrl; // off to Stripe Checkout
                return;
            }
            setDone({ token: data.token || "", manualInstructions: data.manualInstructions || "" });
        } catch {
            setError("Error de red — inténtalo de nuevo.");
        } finally {
            setSubmitting(false);
        }
    };

    const accent = (accentColor || "").trim() || "#e11d48";

    if (campaign === undefined) {
        return (
            <div id={elementId || undefined}>
                <style dangerouslySetInnerHTML={{ __html: STYLES }} />
                <div className="wjdn-empty">Cargando campaña…</div>
            </div>
        );
    }
    if (campaign === null) {
        return (
            <div id={elementId || undefined}>
                <style dangerouslySetInnerHTML={{ __html: STYLES }} />
                <div className="wjdn-empty">
                    No hay campañas de donación activas — crea una en Admin → Donaciones
                    {campaignSlug ? ` (o revisa el slug "${campaignSlug}")` : ""}.
                </div>
            </div>
        );
    }

    return (
        <div id={elementId || undefined} style={{ "--wjdn-accent": accent }}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            <div className="wjdn-card">
                {campaign.image_url ? (
                    <img className="wjdn-img" src={campaign.image_url} alt={campaign.title} decoding="async" />
                ) : null}
                <div className="wjdn-body">
                    {thanks && <div className="wjdn-banner">¡Gracias por tu donación! Tu pago fue confirmado.</div>}
                    <h3 className="wjdn-title">{campaign.title}</h3>
                    {campaign.description ? <p className="wjdn-desc">{campaign.description}</p> : null}
                    {showGoal ? <Thermometer campaign={campaign} symbol={symbol} /> : null}

                    {done ? (
                        <div className="wjdn-done">
                            <h4>¡Gracias por tu donación!</h4>
                            <p style={{ margin: "0 0 .25rem" }}>Registramos tu donación de <strong>{fmtMoney(amountCents, symbol)}</strong>.</p>
                            {done.manualInstructions ? (
                                <>
                                    <p style={{ margin: "0.5rem 0 0", fontWeight: 700 }}>Instrucciones de pago:</p>
                                    <pre>{done.manualInstructions}</pre>
                                </>
                            ) : (
                                <p style={{ margin: "0.5rem 0 0" }}>El administrador se pondrá en contacto contigo con las instrucciones de pago.</p>
                            )}
                            {done.token ? <p className="wjdn-ref">Referencia: {done.token}</p> : null}
                        </div>
                    ) : (
                        <form onSubmit={submit}>
                            <div className="wjdn-field">
                                <span className="wjdn-label">Monto</span>
                                <div className="wjdn-chips">
                                    {presets.map((p) => (
                                        <button
                                            key={p}
                                            type="button"
                                            className={`wjdn-chip${presetSel === p ? " wjdn-chip-active" : ""}`}
                                            onClick={() => setPresetSel(p)}
                                        >
                                            {fmtMoney(p * 100, symbol)}
                                        </button>
                                    ))}
                                    <button
                                        type="button"
                                        className={`wjdn-chip${presetSel === "custom" ? " wjdn-chip-active" : ""}`}
                                        onClick={() => setPresetSel("custom")}
                                    >
                                        Otro monto
                                    </button>
                                </div>
                                {presetSel === "custom" && (
                                    <input
                                        className="wjdn-input"
                                        type="number"
                                        min="1"
                                        step="0.01"
                                        placeholder={`Monto en ${symbol}`}
                                        value={customAmount}
                                        onChange={(e) => setCustomAmount(e.target.value)}
                                    />
                                )}
                            </div>

                            <div className="wjdn-field">
                                <label className="wjdn-label" htmlFor="wjdn-name">Nombre</label>
                                <input id="wjdn-name" className="wjdn-input" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
                            </div>
                            <div className="wjdn-field">
                                <label className="wjdn-label" htmlFor="wjdn-email">Correo electrónico</label>
                                <input id="wjdn-email" className="wjdn-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required />
                            </div>
                            <div className="wjdn-field">
                                <label className="wjdn-label" htmlFor="wjdn-msg">Mensaje (opcional)</label>
                                <textarea id="wjdn-msg" className="wjdn-textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} />
                            </div>
                            <label className="wjdn-check">
                                <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
                                Donar anónimamente (tu nombre no se mostrará en público)
                            </label>

                            {/* Honeypot — off-screen; bots fill it, humans never see it. */}
                            <div className="wjdn-hp" aria-hidden="true">
                                <input type="text" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} placeholder="No llenar" />
                            </div>

                            <div className="wjdn-methods">
                                <label className={`wjdn-method${method === "manual" || !stripeEnabled ? " wjdn-method-active" : ""}`}>
                                    <input type="radio" name="wjdn-method" checked={method === "manual" || !stripeEnabled} onChange={() => setMethod("manual")} />
                                    Pago manual (transferencia / instrucciones)
                                </label>
                                {stripeEnabled && (
                                    <label className={`wjdn-method${method === "stripe" ? " wjdn-method-active" : ""}`}>
                                        <input type="radio" name="wjdn-method" checked={method === "stripe"} onChange={() => setMethod("stripe")} />
                                        Tarjeta (pago seguro con Stripe)
                                    </label>
                                )}
                            </div>

                            <button className="wjdn-submit" type="submit" disabled={submitting}>
                                {submitting ? "Procesando…" : `Donar${amountCents >= 100 ? " " + fmtMoney(amountCents, symbol) : ""}`}
                            </button>
                            {error && <p className="wjdn-error">{error}</p>}
                        </form>
                    )}

                    {showRecent ? <RecentList items={recent} symbol={symbol} /> : null}
                </div>
            </div>
        </div>
    );
}

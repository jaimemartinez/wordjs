// @ts-nocheck
"use client";

/**
 * Admin page for the Memberships plugin (/admin/plugin/memberships).
 * Tabs: Planes (paid tiers: CRUD), Miembros (paid and complimentary memberships, grant / revoke),
 * Ajustes (currency, free sign-up policy, write-only Stripe test key and webhook signing secret).
 *
 * Styles: the plugin's own client/admin/admin.css, scoped to .plugin-admin-memberships (cf-* identity
 * shared with the other bundled plugins).
 */

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const STATUS_LABELS = { active: "Activa", past_due: "Pago pendiente", canceled: "Cancelada", incomplete: "Incompleta" };
const SOURCE_LABELS = { stripe: "Stripe", comped: "Cortesía" };

const fmtMoney = (cents, symbol) =>
    `${symbol || "$"}${(Math.round(cents || 0) / 100).toLocaleString("es", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const fmtDay = (s) => {
    if (!s) return "—";
    const d = new Date(s);
    return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString();
};

const IconCard = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="12" r="2.2" /><path d="M14 10h4M14 14h3" />
    </svg>
);
const IconPlus = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M12 5v14M5 12h14" />
    </svg>
);

function TierModal({ initial, symbol, onClose, onSaved }) {
    const [name, setName] = useState(initial ? initial.name : "");
    const [slug, setSlug] = useState(initial ? initial.slug : "");
    const [price, setPrice] = useState(initial ? String(initial.price_cents / 100) : "5");
    const [interval, setBillingInterval] = useState(initial ? initial.interval : "month");
    const [description, setDescription] = useState(initial ? initial.description : "");
    const [benefits, setBenefits] = useState(initial ? (initial.benefits_text || "") : "");
    const [active, setActive] = useState(initial ? !!initial.is_active : true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const save = async (e) => {
        e.preventDefault();
        setError("");
        const cents = Math.round(Number(String(price).replace(",", ".")) * 100);
        if (!Number.isInteger(cents) || cents < 100) { setError("El precio debe ser al menos 1.00."); return; }
        setSaving(true);
        try {
            const payload = { name, slug, price_cents: cents, interval, description, benefits, is_active: active };
            if (initial) await apiPut(`/plugin/memberships/tiers/${initial.id}`, payload);
            else await apiPost("/plugin/memberships/tiers", payload);
            onSaved();
        } catch (err) {
            setError(err && err.message ? err.message : "No se pudo guardar.");
        } finally {
            setSaving(false);
        }
    };

    // Portalled to <body>, in the band above the admin chrome: rendered in place, a `fixed` overlay is
    // trapped in the admin shell's stacking context and opens UNDER its sidebar. The wrapper re-applies the
    // plugin's style scope (and neutralises the scope's page background / height).
    const node = (
        <div className="plugin-admin-memberships" style={{ background: "transparent", minHeight: 0 }}>
        <div className="cf-overlay" style={{ zIndex: 6000 }} onClick={onClose}>
            <div className="cf-letter" role="dialog" aria-modal="true" aria-label={initial ? "Editar plan" : "Nuevo plan"} onClick={(e) => e.stopPropagation()}>
                <form onSubmit={save} className="cf-letter-body">
                    <h2 className="cf-editor-title">{initial ? "Editar plan" : "Nuevo plan de pago"}</h2>
                    <div className="cf-grid">
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ms-tier-name">Nombre</label>
                            <input id="ms-tier-name" className="cf-input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Premium" />
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ms-tier-slug">Identificador {initial ? "(no se puede cambiar)" : "(vacío = se genera del nombre)"}</label>
                            <input id="ms-tier-slug" className="cf-input" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={!!initial} maxLength={48} placeholder="premium" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="ms-tier-price">Precio ({symbol || "$"})</label>
                            <input id="ms-tier-price" className="cf-input" type="number" min="1" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="ms-tier-interval">Periodicidad</label>
                            <select id="ms-tier-interval" className="cf-select" value={interval} onChange={(e) => setBillingInterval(e.target.value)}>
                                <option value="month">Mensual</option>
                                <option value="year">Anual</option>
                            </select>
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ms-tier-desc">Descripción</label>
                            <textarea id="ms-tier-desc" className="cf-input" style={{ minHeight: "70px" }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ms-tier-benefits">Ventajas (una por línea)</label>
                            <textarea id="ms-tier-benefits" className="cf-input" style={{ minHeight: "90px" }} value={benefits} onChange={(e) => setBenefits(e.target.value)} placeholder={"Todas las entradas para miembros\nArchivo completo"} />
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-check">
                                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                                Disponible para suscribirse
                            </label>
                        </div>
                    </div>
                    {error && <div role="alert" className="cf-flash is-error" style={{ margin: "1.05rem 0 0" }}>{error}</div>}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: ".6rem", marginTop: "1.4rem" }}>
                        <button type="button" onClick={onClose} className="cf-btn-ghost">Cancelar</button>
                        <button type="submit" disabled={saving} className="cf-btn">{saving ? "Guardando…" : "Guardar"}</button>
                    </div>
                </form>
            </div>
        </div>
        </div>
    );
    return typeof document !== "undefined" && document.body ? createPortal(node, document.body) : node;
}

export default function MembershipsAdminPage() {
    const [tab, setTab] = useState("tiers");
    const [message, setMessage] = useState("");
    const [tiers, setTiers] = useState([]);
    const [members, setMembers] = useState([]);
    const [cfg, setCfg] = useState(null);
    const [modal, setModal] = useState(null);
    const [busy, setBusy] = useState(false);
    const [comp, setComp] = useState({ user: "", tier_id: "", until: "", note: "" });
    const [stripeKey, setStripeKey] = useState("");
    const [webhookSecret, setWebhookSecret] = useState("");

    const symbol = cfg ? cfg.currencySymbol : "$";

    const loadTiers = async () => {
        try { const d = await api("/plugin/memberships/tiers"); setTiers(d.tiers || []); } catch (e) { setMessage(`Error: ${e.message}`); }
    };
    const loadMembers = async () => {
        try { const d = await api("/plugin/memberships/members"); setMembers(d.members || []); } catch (e) { setMessage(`Error: ${e.message}`); }
    };
    const loadConfig = async () => {
        try { setCfg(await api("/plugin/memberships/config")); } catch (e) { setMessage(`Error: ${e.message}`); }
    };
    useEffect(() => { loadConfig(); loadTiers(); loadMembers(); }, []);

    const deleteTier = async (t) => {
        if (!window.confirm(`¿Borrar el plan «${t.name}»?`)) return;
        try { await apiDelete(`/plugin/memberships/tiers/${t.id}`); setMessage("Plan borrado."); loadTiers(); } catch (e) { setMessage(`Error: ${e.message}`); }
    };

    const grantComp = async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        try {
            await apiPost("/plugin/memberships/members/comp", { ...comp, tier_id: Number(comp.tier_id) });
            setComp({ user: "", tier_id: "", until: "", note: "" });
            setMessage("Membresía de cortesía concedida.");
            loadMembers();
        } catch (err) {
            setMessage(`Error: ${err.message}`);
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (m) => {
        const who = (m.user && (m.user.email || m.user.login)) || `#${m.user_id}`;
        const what = m.source === "stripe" ? "Se cancelará su suscripción en Stripe inmediatamente." : "Perderá el acceso ahora.";
        if (!window.confirm(`¿Revocar la membresía de ${who}? ${what}`)) return;
        setBusy(true);
        try { await apiPost(`/plugin/memberships/members/${m.id}/revoke`, {}); setMessage("Membresía revocada."); loadMembers(); } catch (e) { setMessage(`Error: ${e.message}`); } finally { setBusy(false); }
    };

    const saveConfig = async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        try {
            const payload = { currencyCode: cfg.currencyCode, currencySymbol: cfg.currencySymbol, freeSignup: !!cfg.freeSignup };
            if (stripeKey.trim() || cfg._clearKey) payload.stripeKey = cfg._clearKey ? "" : stripeKey.trim();
            if (webhookSecret.trim() || cfg._clearWebhook) payload.webhookSecret = cfg._clearWebhook ? "" : webhookSecret.trim();
            const next = await apiPost("/plugin/memberships/config", payload);
            setCfg({ ...cfg, ...next, _clearKey: false, _clearWebhook: false });
            setStripeKey("");
            setWebhookSecret("");
            setMessage("Ajustes guardados.");
        } catch (err) {
            setMessage(`Error: ${err.message}`);
        } finally {
            setBusy(false);
        }
    };

    const tabBtn = (id, label) => (
        <button type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setMessage(""); }} className={`cf-tab ${tab === id ? "is-active" : ""}`}>
            {label}
        </button>
    );

    const activeCount = members.filter((m) => m.active).length;
    const paidCount = members.filter((m) => m.active && m.source === "stripe").length;

    return (
        <div className="cf-shell">
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconCard /></div>
                <div>
                    <h1 className="cf-title">Membresías</h1>
                    <p className="cf-subtitle">Contenido para miembros · planes de pago con Stripe · membresías de cortesía</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            <div className="cf-tabs" role="tablist">
                {tabBtn("tiers", "Planes")}
                {tabBtn("members", "Miembros")}
                {tabBtn("config", "Ajustes")}
            </div>

            {message && (
                <div role={/Error/i.test(message) ? "alert" : "status"} className={`cf-flash ${/Error/i.test(message) ? "is-error" : "is-ok"}`}>{message}</div>
            )}

            {tab === "tiers" && (
                <div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                        <button type="button" onClick={() => setModal({})} className="cf-btn"><IconPlus /> Nuevo plan</button>
                    </div>
                    {tiers.length === 0 ? (
                        <div className="cf-empty"><IconCard /><span>Sin planes de pago todavía. El registro gratuito ya funciona; crea un plan para cobrar.</span></div>
                    ) : (
                        <div className="cf-camp-grid">
                            {tiers.map((t) => (
                                <div key={t.id} className="cf-camp-card">
                                    <div className="cf-camp-body">
                                        <div style={{ display: "flex", justifyContent: "space-between", gap: ".75rem", alignItems: "flex-start" }}>
                                            <div>
                                                <h3 className="cf-form-name">{t.name}</h3>
                                                <p className="cf-camp-slug">tier:{t.slug}</p>
                                            </div>
                                            <span className={`cf-pill ${t.is_active ? "is-on" : "is-off"}`}>{t.is_active ? "Activo" : "Inactivo"}</span>
                                        </div>
                                        <p className="cf-stat-value" style={{ margin: ".6rem 0" }}>{fmtMoney(t.price_cents, symbol)} <span className="cf-meta">/{t.interval === "year" ? "año" : "mes"}</span></p>
                                        {t.description ? <p className="cf-meta" style={{ marginTop: 0 }}>{t.description}</p> : null}
                                        <p className="cf-meta">{t.member_count} miembro{t.member_count === 1 ? "" : "s"} activo{t.member_count === 1 ? "" : "s"}</p>
                                        <div style={{ display: "flex", gap: ".5rem", marginTop: ".8rem" }}>
                                            <button type="button" onClick={() => setModal(t)} className="cf-btn-ghost">Editar</button>
                                            <button type="button" onClick={() => deleteTier(t)} className="cf-btn-danger">Borrar</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    <p className="cf-usage" style={{ marginTop: "1.4rem" }}>
                        Para restringir una entrada: en el editor, elige su nivel en <strong>Acceso</strong> (Miembros, Miembros de pago o un plan
                        concreto) y coloca el bloque <strong>Muro de pago (miembros)</strong> donde termina la parte gratuita. Sin muro, todo el
                        cuerpo queda reservado. El bloque <strong>Mi membresía</strong> deja a cada miembro cambiar de plan o cancelar.
                    </p>
                </div>
            )}

            {tab === "members" && (
                <div>
                    <div className="cf-stats">
                        <div className="cf-stat"><p className="cf-label" style={{ marginBottom: "0.4rem" }}>Membresías activas</p><p className="cf-stat-value is-ok">{activeCount}</p></div>
                        <div className="cf-stat"><p className="cf-label" style={{ marginBottom: "0.4rem" }}>De pago (Stripe)</p><p className="cf-stat-value">{paidCount}</p></div>
                        <div className="cf-stat"><p className="cf-label" style={{ marginBottom: "0.4rem" }}>Cortesía</p><p className="cf-stat-value">{activeCount - paidCount}</p></div>
                    </div>

                    <form onSubmit={grantComp} className="cf-card-item" style={{ marginBottom: "1rem" }}>
                        <h2 className="cf-editor-title" style={{ marginTop: 0 }}>Conceder una membresía de cortesía</h2>
                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="ms-comp-user">Correo o usuario de la cuenta</label>
                                <input id="ms-comp-user" className="cf-input" value={comp.user} onChange={(e) => setComp({ ...comp, user: e.target.value })} required placeholder="persona@ejemplo.com" />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="ms-comp-tier">Plan</label>
                                <select id="ms-comp-tier" className="cf-select" value={comp.tier_id} onChange={(e) => setComp({ ...comp, tier_id: e.target.value })} required>
                                    <option value="">Elige un plan…</option>
                                    {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="ms-comp-until">Hasta (opcional)</label>
                                <input id="ms-comp-until" className="cf-input" type="date" value={comp.until} onChange={(e) => setComp({ ...comp, until: e.target.value })} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="ms-comp-note">Nota interna (opcional)</label>
                                <input id="ms-comp-note" className="cf-input" value={comp.note} onChange={(e) => setComp({ ...comp, note: e.target.value })} maxLength={500} />
                            </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}>
                            <button type="submit" disabled={busy || !tiers.length} className="cf-btn">Conceder</button>
                        </div>
                    </form>

                    <div className="cf-card-item">
                        {members.length === 0 ? (
                            <div className="cf-empty"><IconCard /><span>Todavía no hay membresías de pago ni de cortesía.</span></div>
                        ) : (
                            <div className="cf-table-wrap">
                                <table className="cf-table">
                                    <thead>
                                        <tr><th>Cuenta</th><th>Plan</th><th>Origen</th><th>Estado</th><th>Renueva / termina</th><th style={{ width: "2.5rem" }}></th></tr>
                                    </thead>
                                    <tbody>
                                        {members.map((m) => (
                                            <tr key={m.id}>
                                                <td>
                                                    <div className="cf-donor-name">{(m.user && (m.user.name || m.user.login)) || `#${m.user_id}`}</div>
                                                    <div className="cf-cell-sub">{(m.user && m.user.email) || "—"}</div>
                                                    {m.note ? <div className="cf-quote">{m.note}</div> : null}
                                                </td>
                                                <td>{m.tier ? m.tier.name : "—"}</td>
                                                <td><span className="cf-chip">{SOURCE_LABELS[m.source] || m.source}</span></td>
                                                <td><span className={`cf-pill ${m.active ? "is-on" : "is-off"}`}>{STATUS_LABELS[m.status] || m.status}{m.cancel_at_period_end ? " · cancela al final" : ""}</span></td>
                                                <td className="cf-cell-date">{m.source === "comped" ? (m.comped_until ? fmtDay(m.comped_until) : "Sin fin") : fmtDay(m.current_period_end)}</td>
                                                <td style={{ textAlign: "right" }}>
                                                    {m.active ? <button type="button" disabled={busy} onClick={() => revoke(m)} className="cf-btn-danger">Revocar</button> : null}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {tab === "config" && cfg && (
                <form onSubmit={saveConfig} className="cf-editor" style={{ maxWidth: "46rem" }}>
                    <div className="cf-editor-body">
                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="ms-cfg-symbol">Símbolo de moneda</label>
                                <input id="ms-cfg-symbol" className="cf-input" value={cfg.currencySymbol} onChange={(e) => setCfg({ ...cfg, currencySymbol: e.target.value })} maxLength={8} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="ms-cfg-code">Código de moneda (ISO, 3 letras)</label>
                                <input id="ms-cfg-code" className="cf-input" value={cfg.currencyCode} onChange={(e) => setCfg({ ...cfg, currencyCode: e.target.value })} maxLength={3} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-check">
                                    <input type="checkbox" checked={!!cfg.freeSignup} onChange={(e) => setCfg({ ...cfg, freeSignup: e.target.checked })} />
                                    Toda cuenta registrada es miembro gratuito (abre el nivel «Miembros»)
                                </label>
                                <p className="cf-help">El registro de cuentas lo controla Ajustes → General («Cualquiera puede registrarse»).</p>
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="ms-cfg-sk">Clave secreta de Stripe — solo modo de PRUEBA {cfg.hasStripeKey ? `(configurada${cfg.stripeMode ? `, ${cfg.stripeMode}` : ""})` : ""}</label>
                                <input id="ms-cfg-sk" className="cf-input" type="password" autoComplete="new-password" value={stripeKey} onChange={(e) => { setStripeKey(e.target.value); setCfg({ ...cfg, _clearKey: false }); }} placeholder={cfg.hasStripeKey ? "(configurada — escribe para reemplazar)" : "sk_test_…"} />
                                <p className="cf-help">Nunca se muestra de vuelta. Esta versión rechaza las claves de producción (sk_live_).</p>
                                {cfg.hasStripeKey && (
                                    <label className="cf-check"><input type="checkbox" checked={!!cfg._clearKey} onChange={(e) => { setCfg({ ...cfg, _clearKey: e.target.checked }); if (e.target.checked) setStripeKey(""); }} /> Quitar la clave</label>
                                )}
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="ms-cfg-wh">Secreto de firma del webhook {cfg.hasWebhookSecret ? "(configurado)" : ""}</label>
                                <input id="ms-cfg-wh" className="cf-input" type="password" autoComplete="new-password" value={webhookSecret} onChange={(e) => { setWebhookSecret(e.target.value); setCfg({ ...cfg, _clearWebhook: false }); }} placeholder={cfg.hasWebhookSecret ? "(configurado — escribe para reemplazar)" : "whsec_…"} />
                                <p className="cf-help">
                                    En Stripe → Desarrolladores → Webhooks, añade este endpoint con los eventos <code>checkout.session.completed</code>,{" "}
                                    <code>customer.subscription.updated</code>, <code>customer.subscription.deleted</code>, <code>invoice.paid</code> e{" "}
                                    <code>invoice.payment_failed</code>:
                                </p>
                                <p className="cf-help"><code style={{ wordBreak: "break-all" }}>{cfg.webhookUrl}</code></p>
                                {cfg.hasWebhookSecret && (
                                    <label className="cf-check"><input type="checkbox" checked={!!cfg._clearWebhook} onChange={(e) => { setCfg({ ...cfg, _clearWebhook: e.target.checked }); if (e.target.checked) setWebhookSecret(""); }} /> Quitar el secreto</label>
                                )}
                            </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? "Guardando…" : "Guardar ajustes"}</button>
                        </div>
                    </div>
                </form>
            )}

            {modal !== null && (
                <TierModal
                    initial={modal && modal.id ? modal : null}
                    symbol={symbol}
                    onClose={() => setModal(null)}
                    onSaved={() => { setModal(null); setMessage("Plan guardado."); loadTiers(); }}
                />
            )}
        </div>
    );
}

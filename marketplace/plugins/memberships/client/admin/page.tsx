// @ts-nocheck
"use client";

/**
 * Admin page for the Memberships plugin (/admin/plugin/memberships).
 * Tabs: Planes (paid tiers: CRUD), Miembros (paid and complimentary memberships, grant / revoke),
 * Ajustes (currency, free sign-up policy, the payment provider and its write-only sandbox credentials).
 *
 * Styles: the plugin's own client/admin/admin.css, scoped to .plugin-admin-memberships (cf-* identity
 * shared with the other bundled plugins).
 */

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";
import NewsletterTab from "./NewsletterTab";
import { useT } from "./i18n";
import { useModal } from "@/contexts/ModalContext";

// Translation keys (looked up through t); an unknown status / source shows its raw value.
const STATUS_LABELS = { active: "status.active", past_due: "status.past_due", canceled: "status.canceled", incomplete: "status.incomplete", expired: "status.expired" };
const SOURCE_LABELS = { stripe: "source.stripe", mercadopago: "source.mercadopago", wompi: "source.wompi", comped: "source.comped" };

/** Where each provider's webhook is set up, and which events it must send. */
const PROVIDER_HELP = {
    stripe: (t) => <>{t("help.stripe.lead")} <code>checkout.session.completed</code>, <code>customer.subscription.updated</code>, <code>customer.subscription.deleted</code>, <code>invoice.paid</code> {t("help.stripe.and")} <code>invoice.payment_failed</code>:</>,
    mercadopago: (t) => <>{t("help.mp.lead")} <strong>{t("help.mp.events")}</strong> (<code>subscription_preapproval</code> {t("help.mp.and")} <code>subscription_authorized_payment</code>). {t("help.mp.tail")}</>,
    wompi: (t) => <>{t("help.wompi")}</>,
};

const fmtMoney = (cents, symbol, locale) =>
    `${symbol || "$"}${(Math.round(cents || 0) / 100).toLocaleString(locale || "es", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const fmtDay = (s, locale) => {
    if (!s) return "—";
    const d = new Date(s);
    return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString(locale);
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
    const { t } = useT();
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
        if (!Number.isInteger(cents) || cents < 100) { setError(t("tier.priceMin")); return; }
        setSaving(true);
        try {
            const payload = { name, slug, price_cents: cents, interval, description, benefits, is_active: active };
            if (initial) await apiPut(`/plugin/memberships/tiers/${initial.id}`, payload);
            else await apiPost("/plugin/memberships/tiers", payload);
            onSaved();
        } catch (err) {
            setError(err && err.message ? err.message : t("tier.saveFailed"));
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
            <div className="cf-letter" role="dialog" aria-modal="true" aria-label={initial ? t("tier.edit") : t("tier.new")} onClick={(e) => e.stopPropagation()}>
                <form onSubmit={save} className="cf-letter-body">
                    <h2 className="cf-editor-title">{initial ? t("tier.edit") : t("tier.newPaid")}</h2>
                    <div className="cf-grid">
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ms-tier-name">{t("tier.name")}</label>
                            <input id="ms-tier-name" className="cf-input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Premium" />
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ms-tier-slug">{t("tier.slug")} {initial ? t("tier.slugLocked") : t("tier.slugAuto")}</label>
                            <input id="ms-tier-slug" className="cf-input" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={!!initial} maxLength={48} placeholder="premium" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="ms-tier-price">{t("tier.price", { symbol: symbol || "$" })}</label>
                            <input id="ms-tier-price" className="cf-input" type="number" min="1" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="ms-tier-interval">{t("tier.interval")}</label>
                            <select id="ms-tier-interval" className="cf-select" value={interval} onChange={(e) => setBillingInterval(e.target.value)}>
                                <option value="month">{t("tier.monthly")}</option>
                                <option value="year">{t("tier.yearly")}</option>
                            </select>
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ms-tier-desc">{t("tier.description")}</label>
                            <textarea id="ms-tier-desc" className="cf-input" style={{ minHeight: "70px" }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ms-tier-benefits">{t("tier.benefits")}</label>
                            <textarea id="ms-tier-benefits" className="cf-input" style={{ minHeight: "90px" }} value={benefits} onChange={(e) => setBenefits(e.target.value)} placeholder={t("tier.benefitsPlaceholder")} />
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-check">
                                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                                {t("tier.available")}
                            </label>
                        </div>
                    </div>
                    {error && <div role="alert" className="cf-flash is-error" style={{ margin: "1.05rem 0 0" }}>{error}</div>}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: ".6rem", marginTop: "1.4rem" }}>
                        <button type="button" onClick={onClose} className="cf-btn-ghost">{t("common.cancel")}</button>
                        <button type="submit" disabled={saving} className="cf-btn">{saving ? t("common.saving") : t("common.save")}</button>
                    </div>
                </form>
            </div>
        </div>
        </div>
    );
    return typeof document !== "undefined" && document.body ? createPortal(node, document.body) : node;
}

export default function MembershipsAdminPage() {
    const { confirm } = useModal();
    const { t, locale } = useT();
    const [tab, setTab] = useState("tiers");
    const [message, setMessage] = useState("");
    const [tiers, setTiers] = useState([]);
    const [members, setMembers] = useState([]);
    const [cfg, setCfg] = useState(null);
    const [modal, setModal] = useState(null);
    const [busy, setBusy] = useState(false);
    const [comp, setComp] = useState({ user: "", tier_id: "", until: "", note: "" });
    // Typed credential values, { provider: { key: value } }; `clear` marks the ones to remove.
    const [creds, setCreds] = useState({});
    const [clear, setClear] = useState({});

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

    const deleteTier = async (tier) => {
        if (!(await confirm(t("tiers.deleteConfirm", { name: tier.name }), undefined, true))) return;
        try { await apiDelete(`/plugin/memberships/tiers/${tier.id}`); setMessage(t("tiers.deleted")); loadTiers(); } catch (e) { setMessage(`Error: ${e.message}`); }
    };

    const grantComp = async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        try {
            await apiPost("/plugin/memberships/members/comp", { ...comp, tier_id: Number(comp.tier_id) });
            setComp({ user: "", tier_id: "", until: "", note: "" });
            setMessage(t("members.granted"));
            loadMembers();
        } catch (err) {
            setMessage(`Error: ${err.message}`);
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (m) => {
        const who = (m.user && (m.user.email || m.user.login)) || `#${m.user_id}`;
        const what = m.source !== "comped" ? t("members.revokeProvider", { provider: SOURCE_LABELS[m.source] ? t(SOURCE_LABELS[m.source]) : m.source }) : t("members.revokeComped");
        if (!(await confirm(t("members.revokeConfirm", { who, what }), undefined, true))) return;
        setBusy(true);
        try { await apiPost(`/plugin/memberships/members/${m.id}/revoke`, {}); setMessage(t("members.revoked")); loadMembers(); } catch (e) { setMessage(`Error: ${e.message}`); } finally { setBusy(false); }
    };

    const saveConfig = async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage("");
        try {
            const payload = { currencyCode: cfg.currencyCode, currencySymbol: cfg.currencySymbol, freeSignup: !!cfg.freeSignup, newsletterEnabled: cfg.newsletterEnabled !== false, newsletterRate: Number(cfg.newsletterRate) || 60 };
            payload.paymentProvider = cfg.paymentProvider || "";
            // Write-only: absent = keep, "" = clear, value = replace.
            const credentials = {};
            for (const p of cfg.providers || []) {
                // Only the chosen provider's typed fields are sent: the others are hidden, and a value the
                // server refused there (a live key) must not block saving after switching provider (X4-11).
                const chosen = p.id === payload.paymentProvider;
                for (const c of p.credentials) {
                    const typed = chosen ? ((creds[p.id] || {})[c.key] || "").trim() : "";
                    const wipe = !!(clear[p.id] || {})[c.key];
                    if (typed || wipe) (credentials[p.id] = credentials[p.id] || {})[c.key] = wipe ? "" : typed;
                }
            }
            payload.credentials = credentials;
            const next = await apiPost("/plugin/memberships/config", payload);
            setCfg({ ...cfg, ...next });
            setCreds({});
            setClear({});
            setMessage(t("config.saved"));
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
    const paidCount = members.filter((m) => m.active && m.source !== "comped").length;

    return (
        <div className="cf-shell">
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconCard /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">{t("app.subtitle")}</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            <div className="cf-tabs" role="tablist">
                {tabBtn("tiers", t("tab.tiers"))}
                {tabBtn("members", t("tab.members"))}
                {tabBtn("newsletter", t("tab.newsletter"))}
                {tabBtn("config", t("tab.config"))}
            </div>

            {message && (
                <div role={/Error/i.test(message) ? "alert" : "status"} className={`cf-flash ${/Error/i.test(message) ? "is-error" : "is-ok"}`}>{message}</div>
            )}

            {tab === "tiers" && (
                <div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                        <button type="button" onClick={() => setModal({})} className="cf-btn"><IconPlus /> {t("tiers.add")}</button>
                    </div>
                    {tiers.length === 0 ? (
                        <div className="cf-empty"><IconCard /><span>{t("tiers.empty")}</span></div>
                    ) : (
                        <div className="cf-camp-grid">
                            {tiers.map((tier) => (
                                <div key={tier.id} className="cf-camp-card">
                                    <div className="cf-camp-body">
                                        <div style={{ display: "flex", justifyContent: "space-between", gap: ".75rem", alignItems: "flex-start" }}>
                                            <div>
                                                <h3 className="cf-form-name">{tier.name}</h3>
                                                <p className="cf-camp-slug">tier:{tier.slug}</p>
                                            </div>
                                            <span className={`cf-pill ${tier.is_active ? "is-on" : "is-off"}`}>{tier.is_active ? t("tiers.active") : t("tiers.inactive")}</span>
                                        </div>
                                        <p className="cf-stat-value" style={{ margin: ".6rem 0" }}>{fmtMoney(tier.price_cents, symbol, locale)} <span className="cf-meta">/{tier.interval === "year" ? t("tiers.perYear") : t("tiers.perMonth")}</span></p>
                                        {tier.description ? <p className="cf-meta" style={{ marginTop: 0 }}>{tier.description}</p> : null}
                                        <p className="cf-meta">{t(tier.member_count === 1 ? "tiers.memberCount.one" : "tiers.memberCount.other", { n: tier.member_count })}</p>
                                        <div style={{ display: "flex", gap: ".5rem", marginTop: ".8rem" }}>
                                            <button type="button" onClick={() => setModal(tier)} className="cf-btn-ghost">{t("common.edit")}</button>
                                            <button type="button" onClick={() => deleteTier(tier)} className="cf-btn-danger">{t("common.delete")}</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    <p className="cf-usage" style={{ marginTop: "1.4rem" }}>
                        {t("tiers.usage.lead")} <strong>{t("tiers.usage.access")}</strong> {t("tiers.usage.levels")}{" "}
                        <strong>{t("tiers.usage.paywall")}</strong> {t("tiers.usage.middle")}{" "}
                        <strong>{t("tiers.usage.myMembership")}</strong> {t("tiers.usage.tail")}
                    </p>
                </div>
            )}

            {tab === "members" && (
                <div>
                    <div className="cf-stats">
                        <div className="cf-stat"><p className="cf-label" style={{ marginBottom: "0.4rem" }}>{t("members.statActive")}</p><p className="cf-stat-value is-ok">{activeCount}</p></div>
                        <div className="cf-stat"><p className="cf-label" style={{ marginBottom: "0.4rem" }}>{t("members.statPaid")}</p><p className="cf-stat-value">{paidCount}</p></div>
                        <div className="cf-stat"><p className="cf-label" style={{ marginBottom: "0.4rem" }}>{t("members.statComped")}</p><p className="cf-stat-value">{activeCount - paidCount}</p></div>
                    </div>

                    <form onSubmit={grantComp} className="cf-card-item" style={{ marginBottom: "1rem" }}>
                        <h2 className="cf-editor-title" style={{ marginTop: 0 }}>{t("members.grantTitle")}</h2>
                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="ms-comp-user">{t("members.account")}</label>
                                <input id="ms-comp-user" className="cf-input" value={comp.user} onChange={(e) => setComp({ ...comp, user: e.target.value })} required placeholder={t("members.accountPlaceholder")} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="ms-comp-tier">{t("members.tier")}</label>
                                <select id="ms-comp-tier" className="cf-select" value={comp.tier_id} onChange={(e) => setComp({ ...comp, tier_id: e.target.value })} required>
                                    <option value="">{t("members.chooseTier")}</option>
                                    {tiers.map((tier) => <option key={tier.id} value={tier.id}>{tier.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="ms-comp-until">{t("members.until")}</label>
                                <input id="ms-comp-until" className="cf-input" type="date" value={comp.until} onChange={(e) => setComp({ ...comp, until: e.target.value })} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="ms-comp-note">{t("members.note")}</label>
                                <input id="ms-comp-note" className="cf-input" value={comp.note} onChange={(e) => setComp({ ...comp, note: e.target.value })} maxLength={500} />
                            </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}>
                            <button type="submit" disabled={busy || !tiers.length} className="cf-btn">{t("members.grant")}</button>
                        </div>
                    </form>

                    <div className="cf-card-item">
                        {members.length === 0 ? (
                            <div className="cf-empty"><IconCard /><span>{t("members.empty")}</span></div>
                        ) : (
                            <div className="cf-table-wrap">
                                <table className="cf-table">
                                    <thead>
                                        <tr><th>{t("members.col.account")}</th><th>{t("members.col.tier")}</th><th>{t("members.col.source")}</th><th>{t("members.col.status")}</th><th>{t("members.col.renews")}</th><th style={{ width: "2.5rem" }}></th></tr>
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
                                                <td><span className="cf-chip">{SOURCE_LABELS[m.source] ? t(SOURCE_LABELS[m.source]) : m.source}</span></td>
                                                <td><span className={`cf-pill ${m.active ? "is-on" : "is-off"}`}>{STATUS_LABELS[m.status] ? t(STATUS_LABELS[m.status]) : m.status}{m.cancel_at_period_end ? t("members.cancelsAtEnd") : ""}</span></td>
                                                <td className="cf-cell-date">{m.source === "comped" ? (m.comped_until ? fmtDay(m.comped_until, locale) : t("members.noEnd")) : fmtDay(m.current_period_end, locale)}</td>
                                                <td style={{ textAlign: "right" }}>
                                                    {m.active ? <button type="button" disabled={busy} onClick={() => revoke(m)} className="cf-btn-danger">{t("members.revoke")}</button> : null}
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

            {tab === "newsletter" && <NewsletterTab setMessage={setMessage} />}

            {tab === "config" && cfg && (
                <form onSubmit={saveConfig} className="cf-editor" style={{ maxWidth: "46rem" }}>
                    <div className="cf-editor-body">
                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="ms-cfg-symbol">{t("config.currencySymbol")}</label>
                                <input id="ms-cfg-symbol" className="cf-input" value={cfg.currencySymbol} onChange={(e) => setCfg({ ...cfg, currencySymbol: e.target.value })} maxLength={8} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="ms-cfg-code">{t("config.currencyCode")}</label>
                                <input id="ms-cfg-code" className="cf-input" value={cfg.currencyCode} onChange={(e) => setCfg({ ...cfg, currencyCode: e.target.value })} maxLength={3} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-check">
                                    <input type="checkbox" checked={!!cfg.freeSignup} onChange={(e) => setCfg({ ...cfg, freeSignup: e.target.checked })} />
                                    {t("config.freeSignup")}
                                </label>
                                <p className="cf-help">{t("config.freeSignupHelp")}</p>
                                {cfg.registrationOpen === false ? (
                                    <p className="cf-help" role="status" data-testid="ms-registration-closed" style={{ color: "#b45309" }}>
                                        {t("config.registrationClosed.lead")} <a href="/admin/settings">{t("config.registrationClosed.link")}</a> {t("config.registrationClosed.tail")}
                                    </p>
                                ) : null}
                                {!cfg.paymentProvider && tiers.some((tier) => Number(tier.price_cents) > 0) ? (
                                    <p className="cf-help" role="status" data-testid="ms-no-provider" style={{ color: "#b45309" }}>
                                        {t("config.noProvider")}
                                    </p>
                                ) : null}
                            </div>
                            <div>
                                <label className="cf-check">
                                    <input type="checkbox" checked={cfg.newsletterEnabled !== false} onChange={(e) => setCfg({ ...cfg, newsletterEnabled: e.target.checked })} />
                                    {t("config.newsletter")}
                                </label>
                                <p className="cf-help">{t("config.newsletterHelp")}</p>
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="ms-cfg-rate">{t("config.rate")}</label>
                                <input id="ms-cfg-rate" className="cf-input" type="number" min="1" max="600" value={cfg.newsletterRate ?? 60} onChange={(e) => setCfg({ ...cfg, newsletterRate: e.target.value })} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="ms-cfg-provider">{t("config.provider")}</label>
                                <select id="ms-cfg-provider" className="cf-select" value={cfg.paymentProvider || ""} onChange={(e) => setCfg({ ...cfg, paymentProvider: e.target.value })}>
                                    <option value="">{t("config.providerNone")}</option>
                                    {(cfg.providers || []).map((p) => (
                                        <option key={p.id} value={p.id}>{p.label}{p.ready ? t("config.providerReady") : ""}</option>
                                    ))}
                                </select>
                                <p className="cf-help">{t("config.sandboxOnly")}</p>
                            </div>
                            {(cfg.providers || []).filter((p) => p.id === cfg.paymentProvider).map((p) => (
                                <React.Fragment key={p.id}>
                                    {p.credentials.map((c) => {
                                        const id = `ms-cfg-${p.id}-${c.key}`;
                                        const value = (creds[p.id] || {})[c.key] || "";
                                        const wiping = !!(clear[p.id] || {})[c.key];
                                        return (
                                            <div className="cf-span-2" key={c.key}>
                                                <label className="cf-label" htmlFor={id}>{c.label} {c.set ? t("config.credSet") : ""}</label>
                                                <input id={id} className="cf-input" type="password" autoComplete="new-password" value={value}
                                                    onChange={(e) => { setCreds({ ...creds, [p.id]: { ...(creds[p.id] || {}), [c.key]: e.target.value } }); setClear({ ...clear, [p.id]: { ...(clear[p.id] || {}), [c.key]: false } }); }}
                                                    placeholder={c.set ? t("config.credSetPlaceholder") : ""} />
                                                {c.set && (
                                                    <label className="cf-check"><input type="checkbox" checked={wiping} onChange={(e) => { setClear({ ...clear, [p.id]: { ...(clear[p.id] || {}), [c.key]: e.target.checked } }); if (e.target.checked) setCreds({ ...creds, [p.id]: { ...(creds[p.id] || {}), [c.key]: "" } }); }} /> {t("config.credClear")}</label>
                                                )}
                                            </div>
                                        );
                                    })}
                                    <div className="cf-span-2">
                                        <p className="cf-help">{t("config.neverShown")}{p.mode ? t("config.mode", { mode: p.mode }) : ""}{p.currencies ? t("config.currency", { currencies: p.currencies.join(", ").toUpperCase() }) : ""}</p>
                                        <p className="cf-help">{PROVIDER_HELP[p.id] ? PROVIDER_HELP[p.id](t) : null}</p>
                                        <p className="cf-help"><code style={{ wordBreak: "break-all" }}>{p.webhookUrl}</code></p>
                                    </div>
                                </React.Fragment>
                            ))}
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? t("common.saving") : t("config.save")}</button>
                        </div>
                    </div>
                </form>
            )}

            {modal !== null && (
                <TierModal
                    initial={modal && modal.id ? modal : null}
                    symbol={symbol}
                    onClose={() => setModal(null)}
                    onSaved={() => { setModal(null); setMessage(t("tiers.saved")); loadTiers(); }}
                />
            )}
        </div>
    );
}

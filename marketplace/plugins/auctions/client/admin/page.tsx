// @ts-nocheck
"use client";

/**
 * Admin page for the Auctions plugin (/admin/plugin/auctions).
 * Tabs: Subastas (cards + CRUD modal), Pujas (full bid table with emails, delete),
 * Reporte (winners + contact for fulfillment). All money handled as integer cents server-side;
 * this page converts to/from display units. Dates: the server stores UTC 'YYYY-MM-DD HH:MM:SS'
 * and returns epoch-ms fields; datetime-local inputs are converted local <-> UTC here.
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-auctions) — the markup below only uses cf-*
 * classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";
import { useT } from "./i18n";
import { useModal } from "@/contexts/ModalContext";

// Status label keys resolve through t() at render time (see i18n.ts).
const STATUS_META = {
    active: { labelKey: "status.active", cls: "is-active" },
    ended: { labelKey: "status.ended", cls: "is-ended" },
    cancelled: { labelKey: "status.cancelled", cls: "is-cancelled" },
    draft: { labelKey: "status.draft", cls: "is-draft" },
};

const EMPTY_FORM = {
    title: "",
    description: "",
    image_url: "",
    start_price: "",
    min_increment: "1",
    starts_at: "",
    ends_at: "",
    anti_snipe_min: "2",
    is_published: true,
    status: "active",
};

// ---- helpers (module level) ----------------------------------------------------------------------

function fmtMoney(cents, symbol, locale) {
    const n = (Number(cents) || 0) / 100;
    const hasDec = Math.round(n * 100) % 100 !== 0;
    return (symbol || "$") + n.toLocaleString(locale || "es", { minimumFractionDigits: hasDec ? 2 : 0, maximumFractionDigits: 2 });
}

// Units string ("12.50" / "12,50") -> integer cents, or null when invalid.
function toCents(v) {
    const n = parseFloat(String(v ?? "").replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
}

// epoch ms -> value for <input type="datetime-local"> (local time).
function msToLocalInput(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// datetime-local value (local time) -> UTC 'YYYY-MM-DD HH:MM:SS' for the server.
function localInputToUtc(v) {
    if (!v) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace("T", " ");
}

function fmtRemaining(endsAtMs, nowMs, endedLabel) {
    if (!endsAtMs) return "—";
    const left = endsAtMs - nowMs;
    if (left <= 0) return endedLabel;
    const s = Math.floor(left / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return (d ? d + "d " : "") + String(h).padStart(2, "0") + "h " + String(m).padStart(2, "0") + "m " + String(ss).padStart(2, "0") + "s";
}

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconGavel = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="m14 13-7.5 7.5a2.12 2.12 0 0 1-3-3L11 10" />
        <path d="m16 16 6 6" />
        <path d="m8 8 6-6" />
        <path d="m9 7 8 8" />
        <path d="m21 11-8-8" />
    </svg>
);
const IconPlus = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M12 5v14M5 12h14" />
    </svg>
);
const IconPen = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
);
const IconTrophy = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
        <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
        <path d="M4 22h16" />
        <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
        <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
        <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
);
const IconImage = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
);

export default function AuctionsAdminPage() {
    const { confirm } = useModal();
    const { t, locale } = useT();
    const [tab, setTab] = useState("auctions");
    const [auctions, setAuctions] = useState([]);
    const [symbol, setSymbol] = useState("$");
    const [symbolDraft, setSymbolDraft] = useState("$");
    const [bidVerification, setBidVerification] = useState("email");
    const [jumpPercent, setJumpPercent] = useState("100");
    const [msg, setMsg] = useState("");
    const [busy, setBusy] = useState(false);
    const [nowMs, setNowMs] = useState(() => Date.now());

    // modal: null | { mode: 'create' } | { mode: 'edit', id }
    const [modal, setModal] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [formErr, setFormErr] = useState("");

    // bids tab
    const [bidsAuction, setBidsAuction] = useState("");
    const [bids, setBids] = useState([]);

    // report tab
    const [report, setReport] = useState([]);

    const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));

    const loadAuctions = async () => {
        try {
            const r = await api("/plugin/auctions/auctions");
            setAuctions(r.auctions || []);
            setSymbol(r.currencySymbol || "$");
            setSymbolDraft(r.currencySymbol || "$");
        } catch (e) {
            setMsg(t("msg.loadAuctionsError", { msg: e?.message || e }));
        }
    };

    const loadBids = async (auctionId) => {
        if (!auctionId) { setBids([]); return; }
        try {
            const r = await api(`/plugin/auctions/bids?auction_id=${encodeURIComponent(auctionId)}`);
            setBids(r.bids || []);
        } catch (e) {
            setMsg(t("msg.loadBidsError", { msg: e?.message || e }));
        }
    };

    const loadReport = async () => {
        try {
            const r = await api("/plugin/auctions/report");
            setReport(r.report || []);
            setSymbol(r.currencySymbol || "$");
        } catch (e) {
            setMsg(t("msg.loadReportError", { msg: e?.message || e }));
        }
    };

    const loadSettings = async () => {
        try {
            const r = await api("/plugin/auctions/settings");
            if (r.bidVerification) setBidVerification(r.bidVerification);
            if (r.maxBidJumpPercent !== undefined) setJumpPercent(String(r.maxBidJumpPercent));
        } catch { /* keep defaults */ }
    };

    useEffect(() => { loadAuctions(); loadSettings(); }, []);
    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    useEffect(() => {
        if (tab === "bids") loadBids(bidsAuction);
        if (tab === "report") loadReport();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, bidsAuction]);

    const openCreate = () => { setForm(EMPTY_FORM); setFormErr(""); setModal({ mode: "create" }); };
    const openEdit = (a) => {
        setForm({
            title: a.title || "",
            description: a.description || "",
            image_url: a.image_url || "",
            start_price: String((Number(a.start_price_cents) || 0) / 100),
            min_increment: String((Number(a.min_increment_cents) || 0) / 100),
            starts_at: msToLocalInput(a.startsAtMs),
            ends_at: msToLocalInput(a.endsAtMs),
            anti_snipe_min: String(a.anti_snipe_min ?? 2),
            is_published: !!a.is_published,
            status: a.status === "draft" ? "draft" : "active",
        });
        setFormErr("");
        setModal({ mode: "edit", id: a.id, currentStatus: a.status });
    };

    const saveModal = async (e) => {
        e.preventDefault();
        setFormErr("");
        const startCents = toCents(form.start_price);
        const incCents = toCents(form.min_increment);
        if (startCents === null) return setFormErr(t("form.invalidStartPrice"));
        if (incCents === null || incCents <= 0) return setFormErr(t("form.invalidIncrement"));
        if (!form.ends_at) return setFormErr(t("form.endsRequired"));
        const body = {
            title: form.title,
            description: form.description,
            image_url: form.image_url,
            start_price_cents: startCents,
            min_increment_cents: incCents,
            starts_at: form.starts_at ? localInputToUtc(form.starts_at) : "",
            ends_at: localInputToUtc(form.ends_at),
            anti_snipe_min: parseInt(form.anti_snipe_min, 10) || 0,
            is_published: form.is_published ? 1 : 0,
        };
        // Only send status for draft/active auctions (end/cancel have their own buttons); editing an
        // ended/cancelled auction must not silently reopen it.
        if (modal.mode === "create" || modal.currentStatus === "draft" || modal.currentStatus === "active") {
            body.status = form.status;
        }
        setBusy(true);
        try {
            if (modal.mode === "create") await apiPost("/plugin/auctions/auctions", body);
            else await apiPut(`/plugin/auctions/auctions/${modal.id}`, body);
            setModal(null);
            setMsg(modal.mode === "create" ? t("msg.created") : t("msg.updated"));
            loadAuctions();
        } catch (err) {
            setFormErr(err?.message || String(err));
        } finally {
            setBusy(false);
        }
    };

    const endNow = async (a) => {
        if (!(await confirm(t("confirm.endNow", { title: a.title }), undefined, false))) return;
        try { await apiPost(`/plugin/auctions/auctions/${a.id}/end-now`, {}); setMsg(t("msg.ended")); loadAuctions(); }
        catch (e) { setMsg(t("common.error", { msg: e?.message || e })); }
    };
    const cancelAuction = async (a) => {
        if (!(await confirm(t("confirm.cancel", { title: a.title }), undefined, true))) return;
        try { await apiPost(`/plugin/auctions/auctions/${a.id}/cancel`, {}); setMsg(t("msg.cancelled")); loadAuctions(); }
        catch (e) { setMsg(t("common.error", { msg: e?.message || e })); }
    };
    const deleteAuction = async (a) => {
        if (!(await confirm(t("confirm.delete", { title: a.title }), undefined, true))) return;
        try { await apiDelete(`/plugin/auctions/auctions/${a.id}`); setMsg(t("msg.deleted")); loadAuctions(); }
        catch (e) { setMsg(t("common.error", { msg: e?.message || e })); }
    };
    const deleteBid = async (b) => {
        if (!(await confirm(t("confirm.deleteBid", { name: b.bidder_name, amount: fmtMoney(b.amount_cents, symbol, locale) }), undefined, true))) return;
        try { await apiDelete(`/plugin/auctions/bids/${b.id}`); setMsg(t("msg.bidDeleted")); loadBids(bidsAuction); loadAuctions(); }
        catch (e) { setMsg(t("common.error", { msg: e?.message || e })); }
    };
    const saveSymbol = async () => {
        try {
            const r = await apiPost("/plugin/auctions/settings", {
                currencySymbol: symbolDraft,
                bidVerification,
                maxBidJumpPercent: Number(jumpPercent),
            });
            setSymbol(r.currencySymbol || "$");
            if (r.bidVerification) setBidVerification(r.bidVerification);
            if (r.maxBidJumpPercent !== undefined) setJumpPercent(String(r.maxBidJumpPercent));
            setMsg(t("settings.saved"));
        } catch (e) { setMsg(t("common.error", { msg: e?.message || e })); }
    };

    const tabBtn = (id, label) => (
        <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`cf-tab ${tab === id ? "is-active" : ""}`}
        >
            {label}
        </button>
    );

    return (
        <div className="cf-shell">
            {/* header: stamp + title + rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconGavel /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">{t("app.subtitle")}</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs + currency symbol */}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.9rem", marginBottom: "1.5rem" }}>
                <div className="cf-tabs" role="tablist" style={{ marginBottom: 0 }}>
                    {tabBtn("auctions", t("tab.auctions"))}
                    {tabBtn("bids", t("tab.bids"))}
                    {tabBtn("report", t("tab.report"))}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
                    <label className="cf-label" htmlFor="au-symbol" style={{ marginBottom: 0 }}>{t("settings.currency")}</label>
                    <input
                        id="au-symbol"
                        type="text"
                        value={symbolDraft}
                        onChange={(e) => setSymbolDraft(e.target.value)}
                        className="cf-input cf-symbol-input"
                        maxLength={8}
                    />
                    <label className="cf-label" htmlFor="au-verify" style={{ marginBottom: 0 }}>{t("settings.whoBids")}</label>
                    <select id="au-verify" className="cf-input" style={{ width: "auto" }} value={bidVerification} onChange={(e) => setBidVerification(e.target.value)}>
                        <option value="email">{t("settings.verifyEmail")}</option>
                        <option value="login">{t("settings.verifyLogin")}</option>
                        <option value="none">{t("settings.verifyNone")}</option>
                    </select>
                    <label className="cf-label" htmlFor="au-jump" style={{ marginBottom: 0 }} title={t("settings.jumpHelp")}>{t("settings.jump")}</label>
                    <input id="au-jump" type="number" min={0} max={10000} className="cf-input cf-symbol-input" value={jumpPercent} onChange={(e) => setJumpPercent(e.target.value)} />
                    <button type="button" onClick={saveSymbol} className="cf-btn-ghost">{t("common.save")}</button>
                </div>
            </div>

            {msg && (
                <div role={/Error|Erro|falló/i.test(msg) ? "alert" : "status"} className={`cf-flash ${/Error|Erro|falló/i.test(msg) ? "is-error" : "is-ok"}`}>
                    {msg}
                </div>
            )}

            {/* ============================ TAB: SUBASTAS ============================ */}
            {tab === "auctions" && (
                <div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                        <button type="button" onClick={openCreate} className="cf-btn"><IconPlus /> {t("auctions.new")}</button>
                    </div>
                    {auctions.length === 0 ? (
                        <div className="cf-empty">
                            <IconGavel />
                            <span>{t("auctions.empty")}</span>
                        </div>
                    ) : (
                        <div className="cf-auction-grid">
                            {auctions.map((a) => {
                                const meta = STATUS_META[a.status] || STATUS_META.draft;
                                return (
                                    <div key={a.id} className="cf-card-item">
                                        <div style={{ display: "flex", gap: "1rem" }}>
                                            {a.image_url ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={a.image_url} alt={a.title} className="cf-thumb" />
                                            ) : (
                                                <div className="cf-thumb-empty"><IconImage /><span>{t("auctions.noPhoto")}</span></div>
                                            )}
                                            <div style={{ minWidth: 0, flex: 1 }}>
                                                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.5rem" }}>
                                                    <h3 className="cf-auction-title">{a.title}</h3>
                                                    <span className={`cf-status ${meta.cls}`}>{t(meta.labelKey)}</span>
                                                </div>
                                                <p className="cf-price">{fmtMoney(a.currentPriceCents, symbol, locale)}</p>
                                                <p className="cf-meta cf-countdown">
                                                    {t(a.bidCount === 1 ? "auctions.bidOne" : "auctions.bidMany", { n: a.bidCount })}
                                                    {a.status === "active" ? ` · ${fmtRemaining(a.endsAtMs, nowMs, t("status.ended"))}` : ""}
                                                    {!a.is_published ? t("auctions.unpublished") : ""}
                                                </p>
                                            </div>
                                        </div>
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "1rem" }}>
                                            <button type="button" onClick={() => openEdit(a)} className="cf-btn-ghost"><IconPen /> {t("common.edit")}</button>
                                            <button type="button" onClick={() => { setBidsAuction(String(a.id)); setTab("bids"); }} className="cf-btn-ghost">{t("auctions.bids")}</button>
                                            {a.status === "active" && (
                                                <button type="button" onClick={() => endNow(a)} className="cf-btn-ghost">{t("auctions.endNow")}</button>
                                            )}
                                            {(a.status === "active" || a.status === "draft") && (
                                                <button type="button" onClick={() => cancelAuction(a)} className="cf-btn-ghost">{t("common.cancel")}</button>
                                            )}
                                            <button type="button" onClick={() => deleteAuction(a)} className="cf-btn-danger">{t("common.delete")}</button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <p className="cf-help" style={{ marginTop: "1.5rem" }}>
                        {t("auctions.usage1")}<strong>Auctions</strong>{t("auctions.usage2")}
                    </p>
                </div>
            )}

            {/* ============================ TAB: PUJAS ============================ */}
            {tab === "bids" && (
                <div className="cf-card-item">
                    <div style={{ marginBottom: "1.15rem" }}>
                        <label className="cf-label" htmlFor="au-bids-auction">{t("bids.auction")}</label>
                        <select id="au-bids-auction" value={bidsAuction} onChange={(e) => setBidsAuction(e.target.value)} className="cf-select">
                            <option value="">{t("bids.select")}</option>
                            {auctions.map((a) => (
                                <option key={a.id} value={String(a.id)}>{a.title} ({STATUS_META[a.status] ? t(STATUS_META[a.status].labelKey) : a.status})</option>
                            ))}
                        </select>
                    </div>
                    {!bidsAuction ? (
                        <p className="cf-help">{t("bids.selectHelp")}</p>
                    ) : bids.length === 0 ? (
                        <div className="cf-empty">
                            <IconTrophy />
                            <span>{t("bids.empty")}</span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table is-plain">
                                <thead>
                                    <tr>
                                        <th style={{ width: "2rem" }}>#</th>
                                        <th>{t("bids.name")}</th>
                                        <th>{t("bids.email")}</th>
                                        <th>{t("bids.amount")}</th>
                                        <th>{t("bids.date")}</th>
                                        <th style={{ width: "5rem" }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {bids.map((b, i) => (
                                        <tr key={b.id} className={i === 0 ? "is-top" : ""}>
                                            <td>{i === 0 ? <span className="cf-trophy" role="img" aria-label={t("bids.leading")} title={t("bids.leading")}><IconTrophy /></span> : i + 1}</td>
                                            <td className="cf-cell-name">{b.bidder_name}</td>
                                            <td>{b.bidder_email}</td>
                                            <td className="cf-cell-money">{fmtMoney(b.amount_cents, symbol, locale)}</td>
                                            <td className="cf-cell-date">{b.createdAtMs ? new Date(b.createdAtMs).toLocaleString(locale) : b.created_at}</td>
                                            <td style={{ textAlign: "right" }}>
                                                <button type="button" onClick={() => deleteBid(b)} className="cf-btn-danger">{t("common.delete")}</button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ============================ TAB: REPORTE ============================ */}
            {tab === "report" && (
                <div className="cf-card-item">
                    <h2 className="cf-editor-title"><IconTrophy /> {t("report.title")}</h2>
                    {report.length === 0 ? (
                        <div className="cf-empty">
                            <IconGavel />
                            <span>{t("report.empty")}</span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table is-plain">
                                <thead>
                                    <tr>
                                        <th>{t("report.auction")}</th>
                                        <th>{t("report.status")}</th>
                                        <th>{t("report.bids")}</th>
                                        <th>{t("report.price")}</th>
                                        <th>{t("report.winner")}</th>
                                        <th>{t("report.closes")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.map((r) => (
                                        <tr key={r.id} style={{ verticalAlign: "top" }}>
                                            <td className="cf-cell-name">{r.title}</td>
                                            <td>
                                                <span className={`cf-status ${(STATUS_META[r.status] || STATUS_META.draft).cls}`}>
                                                    {t((STATUS_META[r.status] || STATUS_META.draft).labelKey)}
                                                </span>
                                            </td>
                                            <td>{r.bidCount}</td>
                                            <td className="cf-cell-money">{fmtMoney(r.finalPriceCents, symbol, locale)}</td>
                                            <td>
                                                {r.status === "ended" ? (
                                                    r.winnerName ? (
                                                        <div>
                                                            <p className="cf-winner-name">{r.winnerName}</p>
                                                            <p className="cf-winner-mail">{r.winnerEmail}</p>
                                                        </div>
                                                    ) : (
                                                        <span className="cf-void">{t("report.void")}</span>
                                                    )
                                                ) : r.leaderName ? (
                                                    <div>
                                                        <p className="cf-leader-name">{t("report.leader", { name: r.leaderName })}</p>
                                                        <p className="cf-leader-mail">{r.leaderEmail}</p>
                                                    </div>
                                                ) : (
                                                    <span className="cf-void">—</span>
                                                )}
                                            </td>
                                            <td className="cf-cell-date">{r.endsAtMs ? new Date(r.endsAtMs).toLocaleString(locale) : r.ends_at}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ============================ MODAL CRUD ============================ */}
            {modal && (
                <div className="cf-overlay" onClick={() => !busy && setModal(null)}>
                    <form
                        onSubmit={saveModal}
                        onClick={(e) => e.stopPropagation()}
                        className="cf-letter"
                        role="dialog"
                        aria-modal="true"
                        aria-label={modal.mode === "create" ? t("form.new") : t("form.edit")}
                    >
                        <div className="cf-letter-body">
                            <h2 className="cf-editor-title">
                                <IconPen />
                                {modal.mode === "create" ? t("form.new") : t("form.edit")}
                            </h2>
                            <div className="cf-grid">
                                <div className="cf-span-2">
                                    <label className="cf-label" htmlFor="au-title">{t("form.title")}</label>
                                    <input id="au-title" type="text" value={form.title} onChange={(e) => setF("title", e.target.value)} className="cf-input" required maxLength={200} />
                                </div>
                                <div className="cf-span-2">
                                    <label className="cf-label" htmlFor="au-desc">{t("form.description")}</label>
                                    <textarea id="au-desc" value={form.description} onChange={(e) => setF("description", e.target.value)} className="cf-input" rows={3} />
                                </div>
                                <div className="cf-span-2">
                                    <label className="cf-label" htmlFor="au-image">{t("form.imageUrl")}</label>
                                    <input id="au-image" type="text" value={form.image_url} onChange={(e) => setF("image_url", e.target.value)} className="cf-input" placeholder={t("form.imagePlaceholder")} />
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="au-start-price">{t("form.startPrice", { symbol })}</label>
                                    <input id="au-start-price" type="number" step="0.01" min="0" value={form.start_price} onChange={(e) => setF("start_price", e.target.value)} className="cf-input" required />
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="au-min-inc">{t("form.minIncrement", { symbol })}</label>
                                    <input id="au-min-inc" type="number" step="0.01" min="0.01" value={form.min_increment} onChange={(e) => setF("min_increment", e.target.value)} className="cf-input" required />
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="au-starts">{t("form.startsAt")}</label>
                                    <input id="au-starts" type="datetime-local" value={form.starts_at} onChange={(e) => setF("starts_at", e.target.value)} className="cf-input" />
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="au-ends">{t("form.endsAt")}</label>
                                    <input id="au-ends" type="datetime-local" value={form.ends_at} onChange={(e) => setF("ends_at", e.target.value)} className="cf-input" required />
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="au-snipe">{t("form.antiSnipe")}</label>
                                    <input id="au-snipe" type="number" min="0" max="120" value={form.anti_snipe_min} onChange={(e) => setF("anti_snipe_min", e.target.value)} className="cf-input" />
                                    <p className="cf-help">{t("form.antiSnipeHelp")}</p>
                                </div>
                                <div>
                                    <label className="cf-label" htmlFor="au-status">{t("form.status")}</label>
                                    <select id="au-status" value={form.status} onChange={(e) => setF("status", e.target.value)} className="cf-select">
                                        <option value="active">{t("status.active")}</option>
                                        <option value="draft">{t("status.draft")}</option>
                                    </select>
                                    <label className="cf-check" htmlFor="au-published" style={{ marginTop: "0.35rem" }}>
                                        <input id="au-published" type="checkbox" checked={form.is_published} onChange={(e) => setF("is_published", e.target.checked)} />
                                        {t("form.published")}
                                    </label>
                                </div>
                            </div>
                            {formErr && <div role="alert" className="cf-flash is-error" style={{ marginTop: "1.15rem", marginBottom: 0 }}>{formErr}</div>}
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
                                <button type="button" onClick={() => setModal(null)} disabled={busy} className="cf-btn-ghost">{t("common.cancel")}</button>
                                <button type="submit" disabled={busy} className="cf-btn">{busy ? t("common.saving") : t("common.save")}</button>
                            </div>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}

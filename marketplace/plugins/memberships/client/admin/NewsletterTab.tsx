// @ts-nocheck
"use client";

/**
 * Admin → Membresías → Newsletter: the send log (status, delivered / failed counts, failed addresses),
 * approval of sends requested by authors who may not mail the membership on their own, retries, a test
 * send (as a member with or without access would receive it) and sending an already published post.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";
import { useT } from "./i18n";

// Translation keys (looked up through t); an unknown status / audience shows its raw value.
const SEND_STATUS = {
    pending_approval: "nl.status.pending_approval", queued: "nl.status.queued", sending: "nl.status.sending", done: "nl.status.done",
    failed: "nl.status.failed", discarded: "nl.status.discarded",
};
const AUDIENCE_LABELS = { all: "nl.audience.all", free: "nl.audience.free", paid: "nl.audience.paid", test: "nl.audience.test" };

const fmtDay = (s, locale) => {
    if (!s) return "—";
    const d = new Date(String(s).includes("T") ? s : String(s).replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? String(s) : d.toLocaleString(locale);
};

export default function NewsletterTab({ setMessage }) {
    const { t, locale } = useT();
    const [data, setData] = useState({ sends: [], pendingDeliveries: 0 });
    const [posts, setPosts] = useState([]);
    const [failedOf, setFailedOf] = useState(null);
    const [failed, setFailed] = useState([]);
    const [busy, setBusy] = useState(false);
    const [test, setTest] = useState({ post_id: "", email: "", variant: "teaser" });
    const [manual, setManual] = useState({ post_id: "", audience: "all" });

    const load = async () => {
        try { setData(await api("/plugin/memberships/newsletter/sends")); } catch (e) { setMessage(`Error: ${e.message}`); }
    };
    useEffect(() => {
        load();
        api("/posts?status=publish&per_page=50").then((list) => setPosts(Array.isArray(list) ? list : [])).catch(() => setPosts([]));
        const id = setInterval(load, 5000);
        return () => clearInterval(id);
    }, []);

    const act = async (fn, ok) => {
        setBusy(true);
        setMessage("");
        try { await fn(); if (ok) setMessage(ok); await load(); } catch (e) { setMessage(`Error: ${e.message}`); } finally { setBusy(false); }
    };
    const showFailed = async (send) => {
        setFailedOf(send);
        try { const d = await api(`/plugin/memberships/newsletter/sends/${send.id}/deliveries?status=failed`); setFailed(d.deliveries || []); } catch { setFailed([]); }
    };
    const postOptions = posts.map((p) => <option key={p.id} value={p.id}>{p.title}{p.access ? t("nl.restricted") : ""}</option>);

    return (
        <div>
            <div className="cf-stats">
                <div className="cf-stat"><p className="cf-label" style={{ marginBottom: "0.4rem" }}>{t("nl.statSent")}</p><p className="cf-stat-value">{data.sends.filter((x) => !x.is_test && x.status === "done").length}</p></div>
                <div className="cf-stat"><p className="cf-label" style={{ marginBottom: "0.4rem" }}>{t("nl.statQueued")}</p><p className="cf-stat-value is-warn">{data.pendingDeliveries}</p></div>
                <div className="cf-stat"><p className="cf-label" style={{ marginBottom: "0.4rem" }}>{t("nl.statDelivered")}</p><p className="cf-stat-value is-ok">{data.sends.reduce((n, x) => n + (x.delivered || 0), 0)}</p></div>
            </div>

            <div className="cf-grid" style={{ marginBottom: "1rem" }}>
                <form className="cf-card-item" onSubmit={(e) => { e.preventDefault(); act(() => apiPost("/plugin/memberships/newsletter/test", { ...test, post_id: Number(test.post_id) }), t("nl.testQueued")); }}>
                    <h2 className="cf-editor-title" style={{ marginTop: 0 }}>{t("nl.testTitle")}</h2>
                    <label className="cf-label" htmlFor="nl-test-post">{t("nl.post")}</label>
                    <select id="nl-test-post" className="cf-select" value={test.post_id} onChange={(e) => setTest({ ...test, post_id: e.target.value })} required>
                        <option value="">{t("nl.choosePost")}</option>
                        {postOptions}
                    </select>
                    <label className="cf-label" htmlFor="nl-test-email" style={{ marginTop: ".75rem" }}>{t("nl.sendTo")}</label>
                    <input id="nl-test-email" className="cf-input" type="email" value={test.email} onChange={(e) => setTest({ ...test, email: e.target.value })} required placeholder={t("nl.sendToPlaceholder")} />
                    <label className="cf-label" htmlFor="nl-test-variant" style={{ marginTop: ".75rem" }}>{t("nl.variant")}</label>
                    <select id="nl-test-variant" className="cf-select" value={test.variant} onChange={(e) => setTest({ ...test, variant: e.target.value })}>
                        <option value="teaser">{t("nl.variantTeaser")}</option>
                        <option value="full">{t("nl.variantFull")}</option>
                    </select>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}><button type="submit" className="cf-btn" disabled={busy}>{t("nl.sendTest")}</button></div>
                </form>
                <form className="cf-card-item" onSubmit={(e) => { e.preventDefault(); act(() => apiPost("/plugin/memberships/newsletter/send", { ...manual, post_id: Number(manual.post_id) }), t("nl.queued")); }}>
                    <h2 className="cf-editor-title" style={{ marginTop: 0 }}>{t("nl.sendTitle")}</h2>
                    <label className="cf-label" htmlFor="nl-send-post">{t("nl.post")}</label>
                    <select id="nl-send-post" className="cf-select" value={manual.post_id} onChange={(e) => setManual({ ...manual, post_id: e.target.value })} required>
                        <option value="">{t("nl.choosePost")}</option>
                        {postOptions}
                    </select>
                    <label className="cf-label" htmlFor="nl-send-aud" style={{ marginTop: ".75rem" }}>{t("nl.audience")}</label>
                    <select id="nl-send-aud" className="cf-select" value={manual.audience} onChange={(e) => setManual({ ...manual, audience: e.target.value })}>
                        <option value="all">{t("nl.audience.all")}</option>
                        <option value="free">{t("nl.onlyFree")}</option>
                        <option value="paid">{t("nl.onlyPaid")}</option>
                    </select>
                    <p className="cf-help">{t("nl.sendHelp")}</p>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}><button type="submit" className="cf-btn" disabled={busy}>{t("nl.enqueue")}</button></div>
                </form>
            </div>

            <div className="cf-card-item">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", marginBottom: ".75rem" }}>
                    <h2 className="cf-editor-title" style={{ margin: 0 }}>{t("nl.logTitle")}</h2>
                    <button type="button" className="cf-btn-ghost" disabled={busy} onClick={() => act(() => apiPost("/plugin/memberships/newsletter/process", {}), t("nl.processed"))}>{t("nl.processNow")}</button>
                </div>
                {data.sends.length === 0 ? (
                    <div className="cf-empty"><span>{t("nl.empty")}</span></div>
                ) : (
                    <div className="cf-table-wrap">
                        <table className="cf-table">
                            <thead><tr><th>{t("nl.col.post")}</th><th>{t("nl.col.audience")}</th><th>{t("nl.col.status")}</th><th>{t("nl.col.delivered")}</th><th>{t("nl.col.failed")}</th><th>{t("nl.col.created")}</th><th></th></tr></thead>
                            <tbody>
                                {data.sends.map((x) => (
                                    <tr key={x.id}>
                                        <td><div className="cf-donor-name">{x.subject || `#${x.post_id}`}</div>{x.note ? <div className="cf-cell-sub">{x.note}</div> : null}</td>
                                        <td>{AUDIENCE_LABELS[x.audience] ? t(AUDIENCE_LABELS[x.audience]) : x.audience}</td>
                                        <td><span className={`cf-pill ${x.status === "done" ? "is-on" : x.status === "failed" || x.status === "discarded" ? "is-off" : ""}`}>{SEND_STATUS[x.status] ? t(SEND_STATUS[x.status]) : x.status}</span></td>
                                        <td className="cf-cell-amount">{x.delivered}{x.total ? ` / ${x.total}` : ""}</td>
                                        <td>{x.failed ? <button type="button" className="cf-btn-ghost" onClick={() => showFailed(x)}>{x.failed}</button> : 0}</td>
                                        <td className="cf-cell-date">{fmtDay(x.created_at, locale)}</td>
                                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                                            {x.status === "pending_approval" && (
                                                <>
                                                    <button type="button" className="cf-btn" disabled={busy} onClick={() => act(() => apiPost(`/plugin/memberships/newsletter/sends/${x.id}/approve`, {}), t("nl.approved"))}>{t("nl.approve")}</button>{" "}
                                                    <button type="button" className="cf-btn-danger" disabled={busy} onClick={() => act(() => apiPost(`/plugin/memberships/newsletter/sends/${x.id}/discard`, {}), t("nl.discarded"))}>{t("nl.discard")}</button>
                                                </>
                                            )}
                                            {x.failed > 0 && x.status !== "sending" && (
                                                <button type="button" className="cf-btn-ghost" disabled={busy} onClick={() => act(() => apiPost(`/plugin/memberships/newsletter/sends/${x.id}/retry`, {}), t("nl.retried"))}>{t("nl.retry")}</button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {failedOf && (
                    <div style={{ marginTop: "1rem" }}>
                        <h3 className="cf-label">{t("nl.failedOf", { subject: failedOf.subject == null ? "" : failedOf.subject })}</h3>
                        {failed.map((d) => <div key={d.id} className="cf-cell-sub">{d.email} — {d.last_error || t("nl.unknownError")} {t("nl.attempts", { n: d.attempts })}</div>)}
                    </div>
                )}
            </div>
        </div>
    );
}

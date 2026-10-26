// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The people of «Autorizaciones» (2.36.16), the plugin's version of the core DataTable's behaviour (the core table is
 * not exposed to plugin bundles): a table from 1024 px, cards below it — nothing scrolls sideways, and long names,
 * localities and e-mails wrap anywhere instead of widening a row. Each row: a checkbox (when the viewer can act on a
 * selection), the person (opens their sheet), the status chip with where the request stands, what they authorized,
 * the e-mail, and the main actions: «Ver detalle», «Enviar solicitud», «Copiar mensaje / WhatsApp». The rest
 * (paper, withdraw, record) lives in the person's sheet.
 *
 * 2.36.17: which of the two is drawn is decided HERE (the screen's width, `useWide`), not by `hidden lg:table` /
 * `lg:hidden`. A plugin's compiled classes sit one sub-layer below the host's (backend/scripts/plugin-stylesheet.js):
 * on a host built before this version, the plugin-only `lg:table` lost to the host's `hidden`, the host's own
 * `lg:hidden` hid the cards, and a computer showed no list at all.
 */
import React, { useEffect, useState } from "react";

/** From 1024 px (the host's `lg`): the table; below it, the cards. Follows the window as it is resized. */
export const WIDE_QUERY = "(min-width: 1024px)";
export function useWide(): boolean {
    const [wide, setWide] = useState(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY).matches : false));
    useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
        let mq: any = null;
        try { mq = window.matchMedia(WIDE_QUERY); } catch { return undefined; }
        const on = () => setWide(!!mq.matches);
        on();
        try { mq.addEventListener("change", on); } catch { try { mq.addListener(on); } catch { /* old browser */ } }
        return () => { try { mq.removeEventListener("change", on); } catch { try { mq.removeListener(on); } catch { /* ignore */ } } };
    }, []);
    return wide;
}
import { canRequest, detailOf, statusOf } from "../lib/consentStatus";
import { ConsentStatusChip } from "./ConsentStatusChip";

const wrap = { overflowWrap: "anywhere" as const };
const small = "min-h-[40px] px-3 rounded-xl text-xs font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-50";

export function ConsentPeopleList({ rows, states, noEmail, t, nameOf, enabled, canManage, selectable, selected, onToggle, onToggleAll, onOpen, onSend, onCopy, busyId, wide: wideProp }: any) {
    const wideNow = useWide();
    const wide = typeof wideProp === "boolean" ? wideProp : wideNow;
    const allOn = rows.length > 0 && rows.every((p) => selected.has(Number(p.id)));
    const info = (p: any) => {
        const st = states[p.id];
        const status = statusOf(st);
        const ne = noEmail.has(Number(p.id));
        return { st, status, detail: detailOf(st, ne), ne, ask: enabled && canManage && canRequest(status) };
    };
    const choices = (st: any, status: string) => (st && (status === "confirmed_code" || status === "confirmed_paper"))
        ? (
            <span className="inline-flex flex-wrap gap-1.5">
                {(["general", "health", "image"] as const).map((k) => (
                    <span key={k} className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${st[k] ? "border-emerald-200 text-emerald-800 bg-emerald-50" : "border-gray-200 text-gray-400 line-through"}`}>{t(`ux.choice.short.${k}`)}</span>
                ))}
            </span>
        ) : <span className="text-gray-400">—</span>;
    const email = (st: any, ne: boolean) => ne && !(st && st.email_masked)
        ? <span className="inline-block border border-gray-200 bg-gray-50 rounded-full px-2 py-0.5 text-[11px] font-bold text-gray-600" title={t("noemail.hint")} data-consent-noemail="">{t("noemail.badge")}</span>
        : <span className="text-xs text-gray-600" style={wrap}>{st ? st.email_masked : ""}</span>;
    // `table`: the compact set of a table row (the copy action as an icon with its name for a screen reader).
    const actions = (p: any, x: any, table = false) => (
        <>
            <button type="button" onClick={() => onOpen(p)} className={`${small} border-2 border-gray-200 text-gray-800 hover:bg-gray-50`} data-consent-view={p.id}>
                <i className="fa-solid fa-eye" aria-hidden="true"></i>{table ? t("ux.act.view.short") : t("ux.act.view")}
            </button>
            {x.ask && !x.ne && (
                <button type="button" disabled={busyId === p.id} onClick={() => onSend(p)} className={`${small} bg-blue-600 text-white hover:bg-blue-700`} data-consent-send={p.id}>
                    <i className="fa-solid fa-paper-plane" aria-hidden="true"></i>{table ? (x.st && x.st.email_masked ? t("ux.act.resend.short") : t("ux.act.send.short")) : (x.st && x.st.email_masked ? t("ux.act.resend") : t("ux.act.send"))}
                </button>
            )}
            {x.ask && (
                <button type="button" disabled={busyId === p.id} onClick={() => onCopy(p)} className={`${small} ${table ? "w-10 px-0" : ""} border-2 border-emerald-200 text-emerald-800 hover:bg-emerald-50`} data-consent-copy={p.id} aria-label={t("ux.act.copy")} title={t("ux.act.copy")}>
                    <i className="fa-brands fa-whatsapp text-sm" aria-hidden="true"></i>{!table && t("ux.act.copy")}
                </button>
            )}
        </>
    );
    const box = (p: any) => selectable && (
        <input type="checkbox" className="w-5 h-5 accent-blue-600 shrink-0" checked={selected.has(Number(p.id))} onChange={() => onToggle(Number(p.id))}
            aria-label={t("ux.select.row", { title: nameOf(p) })} data-consent-select={p.id} />
    );
    return (
        <div data-consent-list="">
            {/* From 1024 px: a table. */}
            {wide ? (
            <table className="w-full text-sm text-left table-fixed border border-gray-100 rounded-xl overflow-hidden" data-consent-layout="table">
                <caption className="sr-only">{t("ux.tab.people")}</caption>
                <thead className="bg-gray-50 text-[11px] font-black uppercase tracking-widest text-gray-500">
                    <tr>
                        {selectable && (
                            <th className="w-12 px-3 py-3">
                                <input type="checkbox" className="w-5 h-5 accent-blue-600" checked={allOn} onChange={onToggleAll} aria-label={t("ux.select.all")} data-consent-select-all="" />
                            </th>
                        )}
                        <th className="px-3 py-3 w-[22%]">{t("admin.col.person")}</th>
                        <th className="px-3 py-3 w-[23%]">{t("admin.col.state")}</th>
                        <th className="px-3 py-3 w-[14%]">{t("ux.col.choices")}</th>
                        <th className="px-3 py-3 w-[13%]">{t("admin.col.email")}</th>
                        <th className="px-3 py-3 text-right">{t("admin.col.actions")}</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                    {rows.map((p) => {
                        const x = info(p);
                        return (
                            <tr key={p.id} className={selected.has(Number(p.id)) ? "bg-blue-50/40" : "hover:bg-gray-50/60"} data-consent-row={p.id}>
                                {selectable && <td className="px-3 py-3 align-top">{box(p)}</td>}
                                <td className="px-3 py-3 align-top">
                                    <button type="button" onClick={() => onOpen(p)} className="text-left" data-consent-open={p.id}>
                                        <span className="block font-bold text-gray-900 hover:text-blue-700" style={wrap}>{nameOf(p)}</span>
                                        {p.location && <span className="block text-xs text-gray-500" style={wrap}>{p.location}</span>}
                                    </button>
                                </td>
                                <td className="px-3 py-3 align-top">
                                    <ConsentStatusChip status={x.status} t={t} />
                                    {x.detail && <span className="block text-[11px] text-gray-500 mt-1" style={wrap} data-consent-detail={x.detail}>{t(`ux.detail.${x.detail}`)}</span>}
                                </td>
                                <td className="px-3 py-3 align-top">{choices(x.st, x.status)}</td>
                                <td className="px-3 py-3 align-top">{email(x.st, x.ne)}</td>
                                <td className="px-3 py-3 align-top"><div className="flex flex-wrap justify-end gap-1.5">{actions(p, x, true)}</div></td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            ) : (
            /* Below 1024 px: cards. */
            <div className="space-y-3" data-consent-layout="cards">
                {selectable && rows.length > 0 && (
                    <label className="flex items-center gap-3 px-1 text-sm font-semibold text-gray-700">
                        <input type="checkbox" className="w-5 h-5 accent-blue-600" checked={allOn} onChange={onToggleAll} data-consent-select-all-cards="" />{t("ux.select.all")}
                    </label>
                )}
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {rows.map((p) => {
                        const x = info(p);
                        return (
                            <li key={p.id} className={`min-w-0 rounded-2xl border p-4 space-y-3 ${selected.has(Number(p.id)) ? "border-blue-300 bg-blue-50/40" : "border-gray-100 bg-white shadow-sm"}`} data-consent-card={p.id}>
                                <div className="flex items-start gap-3">
                                    {box(p)}
                                    <button type="button" onClick={() => onOpen(p)} className="text-left min-w-0 flex-1">
                                        <span className="block font-bold text-gray-900" style={wrap}>{nameOf(p)}</span>
                                        {p.location && <span className="block text-xs text-gray-500" style={wrap}>{p.location}</span>}
                                    </button>
                                </div>
                                <div>
                                    <ConsentStatusChip status={x.status} t={t} />
                                    {x.detail && <span className="block text-xs text-gray-500 mt-1" style={wrap}>{t(`ux.detail.${x.detail}`)}</span>}
                                </div>
                                {(x.st && x.st.email_masked) || x.ne ? <div className="min-w-0">{email(x.st, x.ne)}</div> : null}
                                {(x.status === "confirmed_code" || x.status === "confirmed_paper") && <div>{choices(x.st, x.status)}</div>}
                                <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100 [&>button]:flex-1">{actions(p, x)}</div>
                            </li>
                        );
                    })}
                </ul>
            </div>
            )}
        </div>
    );
}

export default ConsentPeopleList;

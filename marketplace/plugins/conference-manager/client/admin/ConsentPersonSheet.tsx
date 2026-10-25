// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * One person in «Autorizaciones» (2.36.16): a sheet (a bottom sheet on a phone, centred from 640 px) with their status
 * in plain words, what they authorized (datos, salud, imagen), the actions that fit their status — «Enviar
 * solicitud», «Copiar mensaje / WhatsApp», «Hoja en papel», «Retirar autorización», «Descargar constancia» — and
 * the timeline of what happened (the «Historial» the person sheet shows: verbal by whom, link sent, confirmed by
 * code or on paper, withdrawn). The evidence itself stays where it lives: the signed sheet in «Hoja en papel», the
 * full log in «Descargar constancia» (WordJS administrators).
 */
import React, { useCallback } from "react";
import { Overlay } from "./Overlay";
import { HistoryList } from "../lib/HistoryList";
import { conferenceApi } from "../lib/conference";
import { canRequest, detailOf, statusOf } from "../lib/consentStatus";
import { ConsentStatusChip } from "./ConsentStatusChip";

const btn = "min-h-[44px] px-4 rounded-xl text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50";

export function ConsentPersonSheet({ p, st, name, t, lang, when, enabled, canManage, isAdmin, noEmail, busy, onClose, onSend, onCopy, onPaper, onRevoke, onExport }: any) {
    const status = statusOf(st);
    const detail = detailOf(st, noEmail);
    const loadHistory = useCallback(() => conferenceApi.getInscriptionHistory(p.id), [p.id]);
    const ask = enabled && canManage && canRequest(status);
    const choice = (k: string, on: boolean | null) => (
        <li className="flex items-center justify-between gap-3 py-2" data-consent-choice={k}>
            <span className="text-sm text-gray-700">{t(`ux.choice.${k}`)}</span>
            <span className={`text-xs font-bold inline-flex items-center gap-1.5 ${on == null ? "text-gray-400" : on ? "text-emerald-700" : "text-gray-500"}`}>
                <i className={`fa-solid ${on == null ? "fa-minus" : on ? "fa-check" : "fa-xmark"}`} aria-hidden="true"></i>
                {on == null ? t("ux.choice.unknown") : on ? t("ux.choice.yes") : t("ux.choice.no")}
            </span>
        </li>
    );
    const granted = status === "confirmed_code" || status === "confirmed_paper";
    return (
        <Overlay layer={2} onBackdrop={onClose} onEscape={onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby={`cs-person-${p.id}`} data-consent-person={p.id}
                className="bg-white rounded-[28px] shadow-2xl w-full max-w-xl border border-gray-100 overflow-hidden flex flex-col max-h-[92dvh]">
                <div className="px-5 sm:px-7 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 id={`cs-person-${p.id}`} className="text-xl font-black text-gray-900 leading-tight" style={{ overflowWrap: "anywhere" }}>{name}</h2>
                        <p className="text-xs text-gray-500 mt-0.5" style={{ overflowWrap: "anywhere" }}>{[p.location, st && st.email_masked].filter(Boolean).join(" · ")}</p>
                    </div>
                    <button type="button" onClick={onClose} aria-label={t("copy.close")} className="shrink-0 w-11 h-11 flex items-center justify-center rounded-2xl text-gray-500 hover:bg-gray-100">
                        <i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i>
                    </button>
                </div>
                <div className="px-5 sm:px-7 py-5 overflow-y-auto space-y-5">
                    <section className="space-y-2" data-consent-person-status="">
                        <ConsentStatusChip status={status} t={t} size="lg" />
                        <p className="text-sm text-gray-700">{t(`ux.explain.${status}`)}</p>
                        {detail && <p className="text-xs font-semibold text-gray-500" data-consent-detail={detail}>{t(`ux.detail.${detail}`)}</p>}
                        {st && st.verbal_general && st.verbal_general_by && <p className="text-xs text-gray-500">{t("ux.verbal.by", { who: st.verbal_general_by, when: when(st.verbal_general_at) })}</p>}
                        {granted && st.granted_at && <p className="text-xs text-gray-500">{t("ux.granted.at", { when: when(st.granted_at) })}</p>}
                        {status === "revoked" && st.revoked_at && <p className="text-xs text-gray-500">{t("ux.revoked.at", { when: when(st.revoked_at) })}</p>}
                    </section>
                    {st && (granted || status === "revoked") && (
                        <section>
                            <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{t("ux.choices")}</h3>
                            <ul className="divide-y divide-gray-100">
                                {choice("general", status === "revoked" ? false : !!st.general)}
                                {choice("health", status === "revoked" ? false : !!st.health)}
                                {choice("image", status === "revoked" ? false : !!st.image)}
                            </ul>
                        </section>
                    )}
                    {(ask || (canManage && granted) || st) && (
                        <section className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-consent-person-actions="">
                            {ask && !noEmail && (
                                <button type="button" disabled={busy} onClick={onSend} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`} data-consent-person-send="">
                                    <i className="fa-solid fa-paper-plane" aria-hidden="true"></i>{st && st.email_masked ? t("ux.act.resend") : t("ux.act.send")}
                                </button>
                            )}
                            {ask && (
                                <button type="button" disabled={busy} onClick={onCopy} className={`${btn} border-2 border-emerald-200 text-emerald-800 hover:bg-emerald-50`} data-consent-person-copy="">
                                    <i className="fa-brands fa-whatsapp" aria-hidden="true"></i>{t("ux.act.copy")}
                                </button>
                            )}
                            {ask && (
                                <button type="button" onClick={onPaper} className={`${btn} border-2 border-gray-200 text-gray-800 hover:bg-gray-50`} data-consent-person-paper="">
                                    <i className="fa-solid fa-file-signature" aria-hidden="true"></i>{t("ux.act.paper")}
                                </button>
                            )}
                            {canManage && granted && (
                                <button type="button" onClick={onRevoke} className={`${btn} border-2 border-rose-200 text-rose-700 hover:bg-rose-50`} data-consent-person-revoke="">
                                    <i className="fa-solid fa-ban" aria-hidden="true"></i>{t("ux.act.revoke")}
                                </button>
                            )}
                            {st && isAdmin && (
                                <button type="button" disabled={busy} onClick={onExport} className={`${btn} border-2 border-gray-200 text-gray-700 hover:bg-gray-50`} data-consent-person-export="">
                                    <i className="fa-solid fa-file-arrow-down" aria-hidden="true"></i>{t("ux.act.export")}
                                </button>
                            )}
                        </section>
                    )}
                    {noEmail && ask && <p className="text-xs text-gray-500">{t("noemail.hint")}</p>}
                    <section className="border-t border-gray-100 pt-4" data-consent-person-timeline="">
                        <HistoryList load={loadHistory} lang={lang} />
                    </section>
                </div>
            </div>
        </Overlay>
    );
}

export default ConsentPersonSheet;

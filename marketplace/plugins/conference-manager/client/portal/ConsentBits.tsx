// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Autorización de datos» (2.33.0) in the coordinators' portal: the state chip of a row (pendiente / autorizada
 * with its date / revocada) and the person's sheet section with «Reenviar enlace» and «Copiar mensaje» (2.33.2:
 * a new link in a message to paste into WhatsApp; no e-mail, logged «link_shared»). A roster row carries
 * `consent` only while the conference asks for it (GET /portal/inscriptions).
 *
 * «Consentimiento en papel» (2.34.0): PortalPaperConsent — the locality's printable sheet, the signed pages and the
 * checklist of who signed (lib/PaperConsent), in the portal's own Modal. 2.36.6: opened by a blue button in the
 * Participantes header, no longer folded inside «Herramientas de la localidad».
 */
import React, { useState } from "react";
import { useToast } from "@/contexts/ToastContext";
import { Badge, Button, Modal, Notice, labelCls } from "./ui";
import { consentT } from "../lib/consentI18n";
import { consentMessage, copyLangOf, copyText, rememberCopyLang, whatsappUrl } from "../lib/consentMessage";
import { copyLater } from "../lib/clipboard";
import { useCopy } from "../lib/CopyFallback";
import { CopyLangPicker } from "../lib/CopyLangPicker";
import { PaperConsent } from "../lib/PaperConsent";

export type PortalConsent = {
    state: "pending" | "granted" | "revoked"; granted_at: string | null; revoked_at: string | null;
    email_masked: string; mail_failed: boolean; link_expired: boolean; never_sent?: boolean;
    /** 2.34.0: a verbal health authorization waiting for its written confirmation (late after the conference's days). */
    verbal_health?: boolean; verbal_overdue?: boolean;
    /** 2.36.10: the verbal authorization of the personal data (given when registered), waiting for the written one. */
    verbal_general?: boolean;
    /** 2.35.0: no e-mail on file — the link is shared with «Copiar mensaje», or the person signs on paper. */
    no_email?: boolean;
};

const t = consentT("es");
const dateOf = (iso: string | null) => {
    if (!iso) return "";
    try { return new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); } catch { return iso; }
};
const TONE = { pending: "amber", granted: "emerald", revoked: "rose" } as const;
const ICON = { pending: "fa-hourglass-half", granted: "fa-file-signature", revoked: "fa-ban" } as const;

export function ConsentChip({ consent }: { consent?: PortalConsent | null }) {
    if (!consent) return null;
    const verbal = consent.verbal_overdue ? (
        <Badge tone="rose" size="xs" icon="fa-comment-dots" data-consent-verbal="overdue">{t("verbal.overdue")}</Badge>
    ) : null;
    const verbalGeneral = consent.state === "pending" && consent.verbal_general ? (
        <Badge tone="amber" size="xs" icon="fa-comment-dots" data-consent-verbal-general="">{t("verbal.general.pending")}</Badge>
    ) : null;
    const label = consent.state === "granted" ? t("portal.state.granted") : consent.state === "revoked" ? t("portal.state.revoked") : t("portal.state.pending");
    const title = consent.state === "granted" ? t("portal.state.granted.at", { when: dateOf(consent.granted_at) }) : consent.mail_failed ? t("portal.mail.failed") : undefined;
    return (
        <>
            <Badge tone={TONE[consent.state] || "amber"} size="xs" icon={consent.mail_failed && consent.state === "pending" ? "fa-triangle-exclamation" : ICON[consent.state]} title={title} data-consent-state={consent.state}>
                {label}
            </Badge>
            {verbalGeneral}
            {verbal}
        </>
    );
}

export function PortalConsentSection({ inscriptionId, consent, authHeaders, onChanged }: {
    inscriptionId: number; consent: PortalConsent; authHeaders: (extra?: Record<string, string>) => Record<string, string>; onChanged?: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ tone: "emerald" | "rose" | "amber"; text: string; link?: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const { addToast } = useToast();
    // 2.33.4: the message in the e-mail language (or the last one chosen here), switchable in the dialog.
    const [share, setShare] = useState<{ info: any; lang: string; phone: string; copied: boolean } | null>(null);
    const shareText = share ? consentMessage(share.lang, share.info) : "";
    const copyAgain = async () => {
        if (!share) return;
        const copied = await copyText(shareText);
        if (copied) addToast(t("copy.done"), "success");
        setShare({ ...share, copied });
    };
    const shareMessage = async () => {
        setBusy(true); setMsg(null);
        // 2.36.8: the copy starts IN the tap with the message still on its way (lib/clipboard copyLater) — a phone
        // only lets a page copy during the tap, and the new link takes a round trip.
        const pending = fetch("/api/v1/plugin/conference-manager/portal/consent/share", {
            method: "POST", credentials: "include", headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ inscription_id: inscriptionId }),
        }).then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) }));
        const copying = copyLater(pending.then(({ ok, body }) => {
            if (!ok) throw new Error(body.error || "Error");
            return consentMessage(copyLangOf(body.email_lang), body);
        }));
        try {
            const { ok, body } = await pending;
            if (!ok) { setMsg({ tone: "rose", text: body.error || "Error" }); return; }
            const lang = copyLangOf(body.email_lang);
            const copied = await copying;
            if (copied) addToast(t("copy.done"), "success");
            setShare({ info: body, lang, phone: body.phone_wa || "", copied });
            onChanged && onChanged();
        } catch { setMsg({ tone: "rose", text: "Error de conexión" }); }
        finally { setBusy(false); }
    };
    const resend = async () => {
        setBusy(true); setMsg(null); setCopied(false);
        try {
            const res = await fetch("/api/v1/plugin/conference-manager/portal/consent/resend", {
                method: "POST", credentials: "include", headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ inscription_id: inscriptionId }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok) {
                setMsg(body.sent ? { tone: "emerald", text: t("portal.resent", { email: body.email_masked }) } : { tone: "amber", text: t("portal.resent.failed"), link: body.link });
                onChanged && onChanged();
            } else setMsg({ tone: "rose", text: body.error || "Error" });
        } catch { setMsg({ tone: "rose", text: "Error de conexión" }); }
        finally { setBusy(false); }
    };
    // 2.36.8: the link of a mail that did not go — copied with the shared helper; a phone that does not let it
    // gets the link in a field to copy by hand (it used to fail without a word).
    const { copy: copyNow, copyUi } = useCopy({ onCopied: (m) => addToast(m, "success"), lang: "es" });
    const copy = (link: string) => { setCopied(false); copyNow(link, { done: t("portal.copied") }).then((ok) => setCopied(ok)); };
    const status = consent.state === "granted" ? t("portal.state.granted.at", { when: dateOf(consent.granted_at) })
        : consent.state === "revoked" ? `${t("portal.state.revoked")} · ${dateOf(consent.revoked_at)}`
        : consent.no_email ? "" : consent.never_sent ? t("portal.never.sent") : consent.mail_failed ? t("portal.mail.failed") : consent.link_expired ? t("portal.link.expired") : "";
    return (
        <section className="space-y-3" aria-labelledby={`consent-${inscriptionId}`} data-sheet-section="autorizacion">
            {copyUi}
            <h4 id={`consent-${inscriptionId}`} className={labelCls}>{t("portal.section")}</h4>
            <div className="rounded-2xl border border-gray-100 bg-gray-50/40 p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                    <ConsentChip consent={consent} />
                    {status && <span className="text-sm font-bold text-gray-700" data-consent-status="">{status}</span>}
                </div>
                {consent.email_masked && <p className="text-xs text-gray-500">{consent.email_masked}</p>}
                {consent.no_email && !consent.email_masked && (
                    <p className="text-xs text-gray-600" data-consent-noemail=""><Badge tone="gray" size="xs" icon="fa-envelope-open">{t("noemail.badge")}</Badge> {t("noemail.hint")}</p>
                )}
                {consent.state !== "granted" && !consent.no_email && <p className="text-xs text-gray-600">{t("portal.hint")}</p>}
            </div>
            {consent.state !== "granted" && (
                <div className="flex flex-col sm:flex-row gap-2">
                    {!consent.no_email && (
                        <Button variant="outline" icon="fa-paper-plane" onClick={resend} disabled={busy} data-action="consent-resend">
                            {busy ? "Enviando…" : consent.never_sent ? t("portal.send") : t("portal.resend")}
                        </Button>
                    )}
                    <Button variant="outline" icon="fa-copy" onClick={shareMessage} disabled={busy} data-action="consent-copy">{t("copy.button")}</Button>
                </div>
            )}
            {share && (
                <Modal title={share.copied ? t("copy.done") : t("copy.fallback.title")} onClose={() => setShare(null)} size="md" testId="consent-share"
                    footer={(
                        <div className="flex flex-col sm:flex-row gap-2 w-full sm:justify-end">
                            <Button variant="outline" icon="fa-copy" onClick={copyAgain} data-consent-copy-again="">{t("copy.again")}</Button>
                            <a href={whatsappUrl(shareText, share.phone)} target="_blank" rel="noopener noreferrer" data-consent-whatsapp=""
                                className="inline-flex items-center justify-center gap-2 min-h-11 px-5 rounded-2xl bg-emerald-600 text-white font-black uppercase tracking-widest text-[10px]">
                                <i className="fa-brands fa-whatsapp" aria-hidden="true"></i>{t("copy.whatsapp")}
                            </a>
                            <Button variant="dark" onClick={() => setShare(null)}>{t("copy.close")}</Button>
                        </div>
                    )}>
                    <CopyLangPicker label={t("copy.lang")} value={share.lang} onChange={(l) => { rememberCopyLang(l); setShare({ ...share, lang: l }); }} />
                    {!share.copied && <Notice tone="amber" icon="fa-hand-pointer">{t("copy.fallback.hint")}</Notice>}
                    <textarea readOnly rows={9} value={shareText} aria-label={t("copy.fallback.title")} onFocus={(e) => e.currentTarget.select()}
                        className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 text-sm text-gray-800" data-consent-share-text="" />
                    <p className="text-xs text-gray-500">{t("copy.replaces")}</p>
                </Modal>
            )}
            {msg && (
                <Notice tone={msg.tone} icon={msg.tone === "emerald" ? "fa-circle-check" : "fa-triangle-exclamation"}>
                    <span className="block">{msg.text}</span>
                    {msg.link && (
                        <span className="mt-2 flex flex-wrap items-center gap-2">
                            <code className="text-[11px] break-all bg-white/70 rounded px-2 py-1">{msg.link}</code>
                            <Button size="xs" variant="outline" icon="fa-copy" onClick={() => copy(msg.link)}>{copied ? t("portal.copied") : t("portal.copy")}</Button>
                        </span>
                    )}
                </Notice>
            )}
        </section>
    );
}

function PortalDialog({ title, onClose, children, footer, testId, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; testId?: string; wide?: boolean }) {
    return <Modal title={title} onClose={onClose} size={wide ? "xl" : "lg"} testId={testId} footer={footer}>{children}</Modal>;
}

/**
 * The coordinator's paper consent for their own locality (the portal session's). 2.36.6: opened by the blue
 * «Consentimiento en papel» button next to «Registrar nuevo»; «Cerrar» (onClose) folds it again.
 */
export function PortalPaperConsent({ authHeaders, onChanged, onClose }: { authHeaders: (extra?: Record<string, string>) => Record<string, string>; onChanged?: () => void; onClose: () => void }) {
    const { addToast } = useToast();
    // The host hands in new functions on every render: kept in refs, so the panel does not reload each time.
    const headersRef = React.useRef(authHeaders);
    const changedRef = React.useRef(onChanged);
    headersRef.current = authHeaders; changedRef.current = onChanged;
    const request = React.useCallback(async (method: "get" | "post", params: Record<string, any> = {}) => {
        const qs = method === "get" ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : "";
        const res = await fetch(`/api/v1/plugin/conference-manager/portal/consent/paper${qs ? `?${qs}` : ""}`, {
            method: method.toUpperCase(), credentials: "include",
            headers: headersRef.current(method === "post" ? { "Content-Type": "application/json" } : {}),
            ...(method === "post" ? { body: JSON.stringify(params) } : {}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { const e: any = new Error(data.error || "Error"); e.body = data; throw e; }
        if (params.action === "marks" || params.action === "unmark") changedRef.current && changedRef.current();
        return data;
    }, []);
    return (
        <div className="px-4 sm:px-6 py-4 space-y-2 border-b border-gray-100" data-portal-paper="">
            <PaperConsent t={t} request={request} Dialog={PortalDialog} addToast={addToast} canManage dateLang="es" />
            <Button variant="ghost" icon="fa-chevron-up" onClick={onClose} data-action="paper-close">{t("paper.close")}</Button>
        </div>
    );
}

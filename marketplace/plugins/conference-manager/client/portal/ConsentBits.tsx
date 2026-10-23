// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Autorización de datos» (2.33.0) in the coordinators' portal: the state chip of a row (pendiente / autorizada
 * with its date / revocada) and the person's sheet section with «Reenviar enlace». A roster row carries
 * `consent` only while the conference asks for it (GET /portal/inscriptions).
 */
import React, { useState } from "react";
import { Badge, Button, Notice, labelCls } from "./ui";
import { consentT } from "../lib/consentI18n";

export type PortalConsent = {
    state: "pending" | "granted" | "revoked"; granted_at: string | null; revoked_at: string | null;
    email_masked: string; mail_failed: boolean; link_expired: boolean; never_sent?: boolean;
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
    const label = consent.state === "granted" ? t("portal.state.granted") : consent.state === "revoked" ? t("portal.state.revoked") : t("portal.state.pending");
    const title = consent.state === "granted" ? t("portal.state.granted.at", { when: dateOf(consent.granted_at) }) : consent.mail_failed ? t("portal.mail.failed") : undefined;
    return (
        <Badge tone={TONE[consent.state] || "amber"} size="xs" icon={consent.mail_failed && consent.state === "pending" ? "fa-triangle-exclamation" : ICON[consent.state]} title={title} data-consent-state={consent.state}>
            {label}
        </Badge>
    );
}

export function PortalConsentSection({ inscriptionId, consent, authHeaders, onChanged }: {
    inscriptionId: number; consent: PortalConsent; authHeaders: (extra?: Record<string, string>) => Record<string, string>; onChanged?: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ tone: "emerald" | "rose" | "amber"; text: string; link?: string } | null>(null);
    const [copied, setCopied] = useState(false);
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
    const copy = async (link: string) => {
        try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); }
    };
    const status = consent.state === "granted" ? t("portal.state.granted.at", { when: dateOf(consent.granted_at) })
        : consent.state === "revoked" ? `${t("portal.state.revoked")} · ${dateOf(consent.revoked_at)}`
        : consent.never_sent ? t("portal.never.sent") : consent.mail_failed ? t("portal.mail.failed") : consent.link_expired ? t("portal.link.expired") : "";
    return (
        <section className="space-y-3" aria-labelledby={`consent-${inscriptionId}`} data-sheet-section="autorizacion">
            <h4 id={`consent-${inscriptionId}`} className={labelCls}>{t("portal.section")}</h4>
            <div className="rounded-2xl border border-gray-100 bg-gray-50/40 p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                    <ConsentChip consent={consent} />
                    {status && <span className="text-sm font-bold text-gray-700" data-consent-status="">{status}</span>}
                </div>
                {consent.email_masked && <p className="text-xs text-gray-500">{consent.email_masked}</p>}
                {consent.state !== "granted" && <p className="text-xs text-gray-600">{t("portal.hint")}</p>}
            </div>
            {consent.state !== "granted" && (
                <Button variant="outline" icon="fa-paper-plane" onClick={resend} disabled={busy} data-action="consent-resend">
                    {busy ? "Enviando…" : consent.never_sent ? t("portal.send") : t("portal.resend")}
                </Button>
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

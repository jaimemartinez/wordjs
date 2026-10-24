// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The coordinator portal's badge tools (conference-manager 2.19.0): one person's «Escarapela» section in the
 * participant sheet. Shown only while the conference lets coordinators share badges (`features.badges`); everything
 * stays within the coordinator's location. (2.36.6: the whole location's links and PDFs above the list are gone.)
 *
 * 2.36.6, three actions — what the person needs to get their badge on their phone:
 *   - «WhatsApp», only with a phone on file: wa.me to the number as the consent message builds it (the server's
 *     E.164, `phone_wa`), with the link and how to use it;
 *   - «Copiar enlace», always;
 *   - «Enviar», only with an e-mail on file: after an in-app confirmation naming the (masked) address, the server
 *     e-mails the link and the instructions (POST /portal/badges/email); the result is a toast.
 * The link is fetched when the sheet opens, so «WhatsApp» is a real link (an iPhone blocks a window opened after a
 * request); copying starts inside the tap.
 */
import React, { useEffect, useState } from "react";
import { useToast } from "@/contexts/ToastContext";
import { Button } from "./ui";
import { portalLinkUrl, copyText, portalBadgeEmail, portalBadgeLink, publicBase, type PortalBadgeLink } from "./badges";
import { whatsappUrl } from "../lib/consentMessage";

type Headers = (extra?: Record<string, string>) => Record<string, string>;
const linkBtn = "inline-flex items-center justify-center gap-2 min-h-11 font-black uppercase tracking-widest transition-all active:scale-95 bg-white text-gray-700 border-2 border-gray-100 hover:border-blue-500 hover:text-blue-600 shadow-sm px-4 py-3 text-[10px] rounded-2xl";

/** The WhatsApp message: the link and, in a few lines, how to use it. */
export function badgeMessage(firstName: string, conference: string, url: string): string {
    const name = String(firstName || "").trim();
    return [
        `Hola${name ? ` ${name}` : ""}: esta es tu escarapela${conference ? ` de «${conference}»` : ""}:`,
        url,
        "",
        "Ábrela en tu celular (la primera vez te pide tu documento) y guárdala en la pantalla de inicio. Activa los avisos para saber cuándo llaman a tu grupo a comer y cuándo sale tu bus.",
        "Es personal: no la compartas.",
    ].join("\n");
}

/** One person's badge actions (the participant sheet). */
export function PortalBadgeSection({ inscriptionId, firstName, conferenceName, authHeaders }: { inscriptionId: number; firstName?: string; conferenceName?: string; authHeaders: Headers }) {
    const { addToast } = useToast();
    const [link, setLink] = useState<PortalBadgeLink | null>(null);
    const [base, setBase] = useState("");
    const [confName, setConfName] = useState("");
    const [phoneWa, setPhoneWa] = useState("");
    const [email, setEmail] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState("");
    const [asking, setAsking] = useState(false);
    const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
    useEffect(() => {
        let alive = true;
        setNote(null); setAsking(false); setLoaded(false);
        Promise.all([portalBadgeLink(authHeaders, inscriptionId), publicBase()])
            .then(([r, b]) => { if (alive) { setLink(r.link); setBase(b); setConfName(r.conference); setPhoneWa(r.phoneWa); setEmail(r.emailMasked); setLoaded(true); } })
            .catch((e) => { if (alive) setNote({ text: (e as Error)?.message || "Error", error: true }); });
        return () => { alive = false; };
        // authHeaders is a plain closure over the portal token; the person decides the link.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inscriptionId]);
    const url = link ? portalLinkUrl(link, base) : "";
    const conf = conferenceName || confName;
    const copy = async () => {
        if (busy) return;
        setBusy("copy"); setNote(null);
        try { setNote({ text: (await copyText(url)) ? "Enlace copiado." : url }); } finally { setBusy(""); }
    };
    const send = async () => {
        if (busy) return;
        setBusy("email"); setAsking(false);
        try {
            const r = await portalBadgeEmail(authHeaders, inscriptionId);
            addToast(`Escarapela enviada a ${r.email_masked}.`, "success");
        } catch (e) { addToast((e as Error)?.message || "No se pudo enviar el correo.", "error"); }
        finally { setBusy(""); }
    };
    // Why an action is missing: no phone, no e-mail (said once the person's contact is known).
    const missing = loaded ? [!phoneWa ? "WhatsApp: no tiene teléfono registrado" : null, !email ? "Enviar: no tiene correo registrado" : null].filter(Boolean) : [];
    return (
        <section className="space-y-3" aria-labelledby={`badge-${inscriptionId}`} data-sheet-section="escarapela">
            <h4 id={`badge-${inscriptionId}`} className="text-[11px] font-black uppercase tracking-widest text-gray-500">Escarapela</h4>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {phoneWa && (link ? (
                    <a className={linkBtn} href={whatsappUrl(badgeMessage(firstName || "", conf, url), phoneWa)} target="_blank" rel="noopener noreferrer" data-action="badge-whatsapp" title={`+${phoneWa}`}>
                        <i className="fa-solid fa-comment-dots text-[9px]" aria-hidden="true"></i>WhatsApp
                    </a>
                ) : <span className={`${linkBtn} opacity-50`} aria-disabled="true"><i className="fa-solid fa-spinner animate-spin text-[9px]" aria-hidden="true"></i>WhatsApp</span>)}
                <Button variant="outline" icon={busy === "copy" ? "fa-spinner animate-spin" : "fa-copy"} data-action="badge-copy" disabled={!link} onClick={copy}>Copiar enlace</Button>
                {email && (
                    <Button variant="outline" icon={busy === "email" ? "fa-spinner animate-spin" : "fa-envelope"} data-action="badge-email" disabled={!link || !!busy}
                        aria-expanded={asking} onClick={() => setAsking((v) => !v)}>Enviar</Button>
                )}
            </div>
            {asking && email && (
                <div className="rounded-2xl border-2 border-blue-100 bg-blue-50/60 p-3 space-y-2" role="group" aria-label="Confirmar envío" data-badge-email-confirm="">
                    <p className="text-xs font-bold text-blue-900">¿Enviar la escarapela y cómo usarla a <span className="break-all">{email}</span>?</p>
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" icon="fa-paper-plane" onClick={send} data-action="badge-email-send">Sí, enviar</Button>
                        <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Cancelar</Button>
                    </div>
                </div>
            )}
            {note && <p className={`text-xs font-bold break-all ${note.error ? "text-rose-700" : "text-emerald-700"}`} role={note.error ? "alert" : "status"}>{note.text}</p>}
            {missing.length > 0 && <p className="text-[11px] text-gray-500" data-badge-missing="">{missing.join(" · ")}.</p>}
            <p className="text-[11px] text-gray-500">El enlace es personal: envíalo solo a esta persona.</p>
        </section>
    );
}

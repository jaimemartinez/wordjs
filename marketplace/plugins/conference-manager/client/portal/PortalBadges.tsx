// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The coordinator portal's badge tools (conference-manager 2.19.0): one person's «Escarapela» section in the
 * participant sheet. Shown only while the conference lets coordinators share badges (`features.badges`); everything
 * stays within the coordinator's location. (2.36.6: the whole location's links and PDFs above the list are gone.)
 *
 * The person's link is fetched when the sheet opens, so «Ver» and «WhatsApp» are real links (an iPhone blocks a
 * window opened after a request); copying starts inside the tap; PDFs open in a new tab.
 */
import React, { useEffect, useState } from "react";
import { Button } from "./ui";
import { portalLinkUrl, copyText, openPortalBadgePdf, portalBadgeLink, publicBase, waNumber, whatsappUrl, type PortalBadgeLink } from "./badges";

type Headers = (extra?: Record<string, string>) => Record<string, string>;
const linkBtn = "inline-flex items-center justify-center gap-2 min-h-11 font-black uppercase tracking-widest transition-all active:scale-95 bg-white text-gray-700 border-2 border-gray-100 hover:border-blue-500 hover:text-blue-600 shadow-sm px-4 py-3 text-[10px] rounded-2xl";

/** One person's badge actions (the participant sheet). */
export function PortalBadgeSection({ inscriptionId, phone, conferenceName, authHeaders }: { inscriptionId: number; phone?: string | null; conferenceName?: string; authHeaders: Headers }) {
    const [link, setLink] = useState<PortalBadgeLink | null>(null);
    const [cc, setCc] = useState("57");
    const [base, setBase] = useState("");
    const [confName, setConfName] = useState("");
    const [busy, setBusy] = useState("");
    const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
    useEffect(() => {
        let alive = true;
        setNote(null);
        Promise.all([portalBadgeLink(authHeaders, inscriptionId), publicBase()])
            .then(([r, b]) => { if (alive) { setLink(r.link); setCc(r.countryCode); setBase(b); setConfName(r.conference); } })
            .catch((e) => { if (alive) setNote({ text: (e as Error)?.message || "Error", error: true }); });
        return () => { alive = false; };
        // authHeaders is a plain closure over the portal token; the person decides the link.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inscriptionId]);
    const run = async (what: string, fn: () => Promise<void>) => {
        if (busy) return;
        setBusy(what); setNote(null);
        try { await fn(); } catch (e) { setNote({ text: (e as Error)?.message || "Error", error: true }); } finally { setBusy(""); }
    };
    const url = link ? portalLinkUrl(link, base) : "";
    const conf = conferenceName || confName;
    const message = `Tu escarapela${conf ? ` de ${conf}` : ""}: ${url}`;
    const number = waNumber(phone, cc);
    return (
        <section className="space-y-3" aria-labelledby={`badge-${inscriptionId}`} data-sheet-section="escarapela">
            <h4 id={`badge-${inscriptionId}`} className="text-[11px] font-black uppercase tracking-widest text-gray-500">Escarapela</h4>
            <div className="grid grid-cols-2 gap-2">
                {link ? (
                    <a className={linkBtn} href={url} target="_blank" rel="noopener noreferrer" data-action="badge-open">
                        <i className="fa-solid fa-id-badge text-[9px]" aria-hidden="true"></i>Ver
                    </a>
                ) : <span className={`${linkBtn} opacity-50`} aria-disabled="true"><i className="fa-solid fa-spinner animate-spin text-[9px]" aria-hidden="true"></i>Ver</span>}
                <Button variant="outline" icon={busy === "copy" ? "fa-spinner animate-spin" : "fa-copy"} data-action="badge-copy" disabled={!link}
                    onClick={() => run("copy", async () => { setNote({ text: (await copyText(url)) ? "Enlace copiado." : url }); })}>Copiar enlace</Button>
                {link ? (
                    <a className={linkBtn} href={whatsappUrl(phone, message, cc)} target="_blank" rel="noopener noreferrer" data-action="badge-whatsapp"
                        title={number ? `+${number}` : "No hay un teléfono válido en la inscripción: WhatsApp se abrirá para que escojas el contacto."}>
                        <i className="fa-solid fa-comment-dots text-[9px]" aria-hidden="true"></i>{number ? "WhatsApp" : "WhatsApp (sin número)"}
                    </a>
                ) : <span className={`${linkBtn} opacity-50`} aria-disabled="true"><i className="fa-solid fa-comment-dots text-[9px]" aria-hidden="true"></i>WhatsApp</span>}
                <Button variant="outline" icon={busy === "pdf" ? "fa-spinner animate-spin" : "fa-file-pdf"} data-action="badge-pdf"
                    onClick={() => run("pdf", () => openPortalBadgePdf(authHeaders, { inscription_id: inscriptionId }, "single"))}>PDF</Button>
            </div>
            {note && <p className={`text-xs font-bold break-all ${note.error ? "text-rose-700" : "text-emerald-700"}`} role={note.error ? "alert" : "status"}>{note.text}</p>}
            <p className="text-[11px] text-gray-500">El enlace es personal: envíalo solo a esta persona.</p>
        </section>
    );
}

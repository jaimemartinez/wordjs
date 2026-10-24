// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Historial» (2.36.10): one person's record of who registered them and how, every edit (which fields — never the
 * values), withdrawals and restores, and the data-authorization events — newest last. The admin's person sheet and
 * the coordinators' participant sheet show it; the server already left out what the viewer may not see (health
 * without «Datos de salud», internal notes and an administrator's login on the portal). A registration from before
 * the history existed says «Sin registro».
 */
import React, { useEffect, useState } from "react";

const WORDS: Record<string, Record<string, string>> = {
    es: {
        title: "Historial", loading: "Cargando historial…", error: "No se pudo cargar el historial.", legacy: "Inscripción: sin registro (anterior a este historial)",
        created_admin: "Inscripción creada desde la administración", created_portal: "Inscripción creada desde el portal", created: "Inscripción creada",
        edited: "Editó: {fields}", withdrawn: "Retiró la inscripción", restored: "Restauró la inscripción", reason: "Motivo: {reason}",
        consent_link_sent: "Se envió el enlace de autorización", consent_link_shared: "Se compartió el mensaje de autorización",
        consent_verbal_granted_general: "Autorización verbal de los datos personales", consent_verbal_granted_health: "Autorización verbal de los datos de salud",
        consent_verbal_confirmed_general: "La autorización verbal de los datos quedó confirmada por escrito", consent_verbal_confirmed_health: "La autorización verbal de salud quedó confirmada por escrito",
        consent_granted: "Autorizó por escrito", consent_revoked: "Revocó la autorización", consent_paper_unmarked: "Se deshizo la marca de la hoja en papel",
        consent_health_entered: "Se registraron datos de salud", consent_health_deleted: "Se borraron los datos de salud", consent_health_purged: "Se borraron los datos de salud (después del evento)",
        by_code: "con código", by_paper: "en papel", admin: "Administración", portal: "Portal", nobody: "—",
    },
    en: {
        title: "History", loading: "Loading history…", error: "The history could not be loaded.", legacy: "Registration: no record (before this history)",
        created_admin: "Registered from the administration", created_portal: "Registered from the portal", created: "Registered",
        edited: "Edited: {fields}", withdrawn: "Withdrew the registration", restored: "Restored the registration", reason: "Reason: {reason}",
        consent_link_sent: "The consent link was sent", consent_link_shared: "The consent message was shared",
        consent_verbal_granted_general: "Verbal consent to the personal data", consent_verbal_granted_health: "Verbal consent to the health data",
        consent_verbal_confirmed_general: "The verbal consent to the data was confirmed in writing", consent_verbal_confirmed_health: "The verbal health consent was confirmed in writing",
        consent_granted: "Consented in writing", consent_revoked: "Revoked the consent", consent_paper_unmarked: "The paper sheet tick was undone",
        consent_health_entered: "Health data were entered", consent_health_deleted: "The health data were deleted", consent_health_purged: "The health data were deleted (after the event)",
        by_code: "with a code", by_paper: "on paper", admin: "Administration", portal: "Portal", nobody: "—",
    },
    pt: {
        title: "Histórico", loading: "Carregando histórico…", error: "Não foi possível carregar o histórico.", legacy: "Inscrição: sem registro (anterior a este histórico)",
        created_admin: "Inscrição criada pela administração", created_portal: "Inscrição criada pelo portal", created: "Inscrição criada",
        edited: "Editou: {fields}", withdrawn: "Retirou a inscrição", restored: "Restaurou a inscrição", reason: "Motivo: {reason}",
        consent_link_sent: "O link de autorização foi enviado", consent_link_shared: "A mensagem de autorização foi compartilhada",
        consent_verbal_granted_general: "Autorização verbal dos dados pessoais", consent_verbal_granted_health: "Autorização verbal dos dados de saúde",
        consent_verbal_confirmed_general: "A autorização verbal dos dados foi confirmada por escrito", consent_verbal_confirmed_health: "A autorização verbal de saúde foi confirmada por escrito",
        consent_granted: "Autorizou por escrito", consent_revoked: "Revogou a autorização", consent_paper_unmarked: "A marca da folha em papel foi desfeita",
        consent_health_entered: "Foram registrados dados de saúde", consent_health_deleted: "Os dados de saúde foram apagados", consent_health_purged: "Os dados de saúde foram apagados (depois do evento)",
        by_code: "com código", by_paper: "em papel", admin: "Administração", portal: "Portal", nobody: "—",
    },
};
export const historyWords = (lang?: string) => WORDS[String(lang || "").slice(0, 2)] || WORDS.es;

/** One entry as a line of text (what happened), in the viewer's language. */
export function historyText(e: any, lang?: string): string {
    const w = historyWords(lang);
    if (e.kind === "created") return e.via === "portal" ? w.created_portal : e.via === "admin" ? w.created_admin : w.created;
    if (e.kind === "edited") return w.edited.replace("{fields}", (e.fields || []).join(", "));
    if (e.kind === "consent_verbal_granted" || e.kind === "consent_verbal_confirmed") return w[`${e.kind}_${e.scope === "general" ? "general" : "health"}`];
    if (e.kind === "consent_granted") return `${w.consent_granted}${e.method === "paper" ? ` ${w.by_paper}` : e.method === "otp" ? ` ${w.by_code}` : ""}`;
    return w[e.kind] || e.kind;
}
/** Who did it: «Administración» (the portal never sees an administrator's login), «Portal · Norte», or the login. */
export function historyActor(actor: string | null | undefined, lang?: string): string {
    const w = historyWords(lang);
    if (!actor) return w.nobody;
    if (actor === "admin") return w.admin;
    if (String(actor).startsWith("portal:")) return `${w.portal} · ${String(actor).slice(7)}`;
    return String(actor);
}
const when = (iso: string | null, lang?: string) => {
    if (!iso) return "";
    try { return new Intl.DateTimeFormat(String(lang || "es").slice(0, 2), { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); } catch { return iso; }
};

export function HistoryList({ load, lang, titleClass = "text-[11px] font-black uppercase tracking-widest text-gray-500", className = "" }: {
    load: () => Promise<{ entries: any[]; legacy: boolean }>; lang?: string; titleClass?: string; className?: string;
}) {
    const w = historyWords(lang);
    const [data, setData] = useState<{ entries: any[]; legacy: boolean } | null>(null);
    const [error, setError] = useState(false);
    useEffect(() => {
        let alive = true;
        setData(null); setError(false);
        load().then((d) => { if (alive) setData({ entries: Array.isArray(d && d.entries) ? d.entries : [], legacy: !!(d && d.legacy) }); })
            .catch(() => { if (alive) setError(true); });
        return () => { alive = false; };
    }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
    return (
        <section className={`space-y-2 ${className}`} data-history="">
            <h4 className={titleClass}><i className="fa-solid fa-clock-rotate-left mr-1.5" aria-hidden="true"></i>{w.title}</h4>
            {error ? <p className="text-sm text-rose-700" role="alert">{w.error}</p>
                : !data ? <p className="text-sm text-gray-400" role="status">{w.loading}</p>
                : (
                    <ol className="space-y-2" data-history-list="">
                        {data.legacy && <li className="text-sm text-gray-500 italic" data-history-legacy="">{w.legacy}</li>}
                        {data.entries.map((e, i) => (
                            <li key={i} className="text-sm border-l-2 border-gray-200 pl-3" data-history-kind={e.kind}>
                                <span className="block text-gray-900 font-semibold" style={{ overflowWrap: "anywhere" }}>{historyText(e, lang)}</span>
                                {e.reason && <span className="block text-xs text-gray-600" style={{ overflowWrap: "anywhere" }}>{w.reason.replace("{reason}", e.reason)}</span>}
                                <span className="block text-xs text-gray-500">{when(e.at, lang)} · {historyActor(e.actor, lang)}</span>
                            </li>
                        ))}
                    </ol>
                )}
        </section>
    );
}

export default HistoryList;

"use client";
/**
 * Verso — PRESENCIA COLABORATIVA en el chrome del editor (F8.4).
 *
 * PIEL: la del propio editor, no una nueva. Mismos tokens `--ed-*`, mismo alto de chip que
 * `SaveStateChip`, mismos glifos del subset (`cloud_done`/`cloud_off`/`sync`/`info`/`close`/
 * `person`), mismo `trStr` para los strings ES fuente. No hay un solo color literal salvo el que
 * el SERVIDOR asigna a cada participante (que es dato, no diseño).
 *
 * ACCESIBILIDAD (AA), que aquí no es decoración:
 *  · NADA depende solo del color. El avatar lleva iniciales; el chip de estado lleva glifo Y texto;
 *    la lista de participantes dice en palabras si alguien está editando un bloque.
 *  · El texto sobre el color del avatar se elige por luminancia (`onColor`), no a ojo.
 *  · Un `role="status"` (aria-live polite) anuncia quién entra y sale y en qué estado va el canal.
 *    Va en un nodo `sr-only` estable — cambiar el TEXTO de un live-region lo anuncia; montar y
 *    desmontar el region entero, no.
 *  · Todo es operable con teclado: la pila de avatares es un `<button>` con `aria-expanded` que
 *    abre la lista de participantes; Escape la cierra y devuelve el foco al botón.
 *  · Los avisos con acción (`log-full`, `epoch-reset`, `forbidden`…) se pintan como `role="alert"`
 *    y NO se auto-descartan: exigen que el autor haga algo.
 */
import React from "react";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import type { CollabMember, CollabNotice, CollabSelf, CollabStatus } from "@/lib/verso/collab";
import {
    initialsOf,
    memberLabel,
    noticeSeverity,
    onColor,
    presenceAnnouncement,
    safeColor,
    statusView,
} from "./collabModel";

/** Clases del chip de estado por tono (los tonos los decide collabModel, no la piel). */
const TONE_CLASS: Record<string, string> = {
    live: "text-[var(--ed-primary)] bg-[var(--ed-primary-container)] border-transparent",
    warn: "text-amber-800 bg-amber-50 border-amber-200",
    off: "text-[var(--ed-error,#b3261e)] bg-[var(--ed-error-container,#f9dedc)] border-transparent",
    idle: "text-[var(--ed-on-surface-variant)] bg-[var(--ed-surface-container)] border-[var(--ed-outline-variant)]",
};

function Avatar({ name, color, size = 24 }: { name: string; color: string; size?: number }) {
    const bg = safeColor(color);
    return (
        <span
            aria-hidden="true"
            className="rounded-full flex items-center justify-center font-semibold select-none ring-2 ring-[var(--ed-surface)] shrink-0"
            style={{
                width: size,
                height: size,
                background: bg,
                color: onColor(bg),
                fontSize: Math.round(size * 0.42),
                lineHeight: 1,
            }}
        >
            {initialsOf(name)}
        </span>
    );
}

export interface CollabPresenceProps {
    status: CollabStatus;
    self: CollabSelf | null;
    /** Los DEMÁS participantes (el hook nunca me incluye a mí). */
    members: CollabMember[];
    notice: CollabNotice | null;
    onDismissNotice: () => void;
}

export default function CollabPresence({
    status,
    self,
    members,
    notice,
    onDismissNotice,
}: CollabPresenceProps) {
    const { language } = useI18n();
    const [open, setOpen] = React.useState(false);
    const buttonRef = React.useRef<HTMLButtonElement | null>(null);
    const popoverRef = React.useRef<HTMLDivElement | null>(null);
    const view = statusView(status);
    const tr = React.useCallback((s: string) => trStr(s, language), [language]);

    // Cierre por Escape (con foco de vuelta al disparador) y por click fuera — el patrón del resto
    // de popovers del editor.
    React.useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setOpen(false);
            buttonRef.current?.focus();
        };
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node | null;
            if (t && (popoverRef.current?.contains(t) || buttonRef.current?.contains(t))) return;
            setOpen(false);
        };
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("mousedown", onDown, true);
        return () => {
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("mousedown", onDown, true);
        };
    }, [open]);

    // Apagado del todo: ni un pixel (el editor tiene que verse EXACTAMENTE como antes).
    if (status === "off") return null;

    const shown = members.slice(0, 3);
    const extra = members.length - shown.length;

    return (
        <>
            {/* Live region ESTABLE: siempre montada, solo cambia su texto (montarla y desmontarla
                no anuncia nada en la mayoría de lectores de pantalla). */}
            <div role="status" aria-live="polite" className="sr-only">
                {tr(presenceAnnouncement(status, members))}
            </div>

            <div className="hidden lg:flex items-center gap-1.5" data-wjs-collab-presence="">
                {/* Chip de estado del canal: glifo + TEXTO (jamás solo color). */}
                <span
                    className={`flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[11px] font-medium select-none ${TONE_CLASS[view.tone] ?? TONE_CLASS.idle}`}
                    title={tr(view.detail)}
                >
                    <MSym
                        name={view.icon}
                        size={14}
                        fill={view.tone === "live"}
                        className={status === "connecting" ? "animate-spin" : ""}
                    />
                    <span>{tr(view.text)}</span>
                </span>

                {/* Pila de avatares → lista de participantes. Es un botón: con teclado también. */}
                {members.length > 0 && (
                    <div className="relative">
                        <button
                            ref={buttonRef}
                            type="button"
                            onClick={() => setOpen((v) => !v)}
                            aria-expanded={open}
                            aria-haspopup="true"
                            aria-label={tr(
                                members.length === 1
                                    ? "1 persona más editando esta página"
                                    : `${members.length} personas más editando esta página`,
                            )}
                            title={members.map((m) => m.name).join(", ")}
                            className="flex items-center h-7 pl-1 pr-1.5 rounded-full border border-[var(--ed-outline-variant)] hover:bg-[var(--ed-surface-container)] transition-colors"
                        >
                            <span className="flex items-center -space-x-1.5">
                                {shown.map((m) => (
                                    <Avatar key={m.siteId} name={m.name} color={m.color} />
                                ))}
                            </span>
                            {extra > 0 && (
                                <span className="ml-1 text-[10px] font-semibold text-[var(--ed-on-surface-variant)]">
                                    +{extra}
                                </span>
                            )}
                        </button>

                        {open && (
                            <div
                                ref={popoverRef}
                                className="absolute top-9 right-0 z-[95] w-[248px] rounded-xl border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] shadow-2xl p-1.5"
                            >
                                <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ed-on-surface-variant)]">
                                    {tr("En esta página")}
                                </p>
                                <ul className="flex flex-col">
                                    {self && (
                                        <li className="flex items-center gap-2 px-2 py-1.5 rounded-lg">
                                            <Avatar name={self.name} color={self.color} size={22} />
                                            <span className="text-[12px] text-[var(--ed-on-surface)] truncate">
                                                {self.name} <span className="text-[var(--ed-on-surface-variant)]">({tr("tú")})</span>
                                            </span>
                                        </li>
                                    )}
                                    {members.map((m) => (
                                        <li key={m.siteId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg">
                                            <Avatar name={m.name} color={m.color} size={22} />
                                            <span className="text-[12px] text-[var(--ed-on-surface)] truncate">
                                                {tr(memberLabel(m))}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* AVISO TIPADO — nunca se pierde nada en silencio (spec §6). Los accionables son
                role="alert" y se quedan hasta que el autor los descarta. */}
            {notice && (
                <div
                    role={noticeSeverity(notice) === "action" ? "alert" : "status"}
                    className={`fixed left-1/2 -translate-x-1/2 top-[52px] z-[85] max-w-[min(560px,92vw)] flex items-start gap-2.5 pl-3 pr-2 py-2 rounded-lg shadow-xl border text-[12px] ${
                        noticeSeverity(notice) === "action"
                            ? "bg-amber-50 border-amber-300 text-amber-900"
                            : "bg-[var(--ed-inverse-surface)] border-transparent text-[var(--ed-inverse-on-surface)]"
                    }`}
                >
                    <MSym name="info" size={16} className="mt-0.5 shrink-0" />
                    <span className="leading-snug">{tr(notice.message)}</span>
                    <button
                        type="button"
                        onClick={onDismissNotice}
                        aria-label={tr("Descartar aviso")}
                        className="ml-1 p-1 rounded hover:bg-black/10 transition-colors shrink-0"
                    >
                        <MSym name="close" size={14} />
                    </button>
                </div>
            )}
        </>
    );
}

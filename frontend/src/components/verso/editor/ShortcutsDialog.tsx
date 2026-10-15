"use client";
/**
 * Verso — ayuda de atajos de teclado («?» o la paleta ⌘K). Lista ESTÁTICA que refleja hotkeyMap.ts
 * y el modo mover del DnDDriver: si se añade un atajo allí, se documenta aquí.
 *
 * Diálogo modal real: aria-modal (EditorHotkeys cede su Escape a cualquier aria-modal abierto), el
 * foco entra al abrir y vuelve a quien lo tenía al cerrar, Escape y el scrim cierran.
 */
import React, { useEffect, useRef } from "react";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";

/** Teclas por fila (cada una es un <kbd>) + su descripción ES fuente (trStr). */
const GROUPS: { title: string; rows: { keys: string[]; label: string }[] }[] = [
    {
        title: "General",
        rows: [
            { keys: ["Ctrl", "K"], label: "Buscar bloques y acciones" },
            { keys: ["Ctrl", "S"], label: "Guardar o publicar" },
            { keys: ["Ctrl", "Z"], label: "Deshacer" },
            { keys: ["Ctrl", "Shift", "Z"], label: "Rehacer" },
            { keys: ["?"], label: "Mostrar esta ayuda" },
        ],
    },
    {
        title: "Bloque seleccionado",
        rows: [
            { keys: ["Esc"], label: "Seleccionar el contenedor; otra vez, deseleccionar" },
            { keys: ["Supr"], label: "Eliminar bloque" },
            { keys: ["Ctrl", "D"], label: "Duplicar bloque" },
            { keys: ["Ctrl", "C / V"], label: "Copiar / pegar bloque" },
            { keys: ["Ctrl", "Shift", "↑"], label: "Subir bloque" },
            { keys: ["Ctrl", "Shift", "↓"], label: "Bajar bloque" },
            { keys: ["M"], label: "Mover con las flechas (modo mover)" },
            { keys: ["Doble clic"], label: "Editar el texto del bloque" },
        ],
    },
];

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export default function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { language } = useI18n();
    const panelRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const previous = document.activeElement as HTMLElement | null;
        requestAnimationFrame(() => panelRef.current?.focus());
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            onClose();
        };
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("keydown", onKey, true);
            previous?.focus?.();
        };
    }, [open, onClose]);

    if (!open) return null;
    const mac = isMac();
    const keyLabel = (k: string) => {
        if (k === "Ctrl") return mac ? "⌘" : "Ctrl";
        if (k === "Supr") return mac ? "⌫" : trStr("Supr", language);
        if (k === "Doble clic") return trStr("Doble clic", language);
        return k;
    };

    return (
        <>
            <div className="verso-overlay-scrim" aria-hidden="true" onMouseDown={onClose} />
            <div
                ref={panelRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="verso-shortcuts-title"
                data-verso-shortcuts=""
                className="verso-panel fixed z-[95] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(560px,calc(100vw-2rem))] max-h-[min(640px,calc(100dvh-2rem))] flex flex-col rounded-2xl border border-[var(--ed-outline-variant)] shadow-2xl outline-none overflow-hidden"
            >
                <div className="shrink-0 h-14 px-5 flex items-center justify-between border-b border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)]">
                    <h2 id="verso-shortcuts-title" className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ed-on-surface)]">
                        <MSym name="keyboard_command_key" size={18} className="text-[var(--ed-primary)]" />
                        {trStr("Atajos de teclado", language)}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={trStr("Cerrar", language)}
                        className="verso-icon-button w-9 h-9 rounded-lg flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                    >
                        <MSym name="close" size={18} />
                    </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 py-4 bg-[var(--ed-surface-container-lowest)] space-y-5">
                    {GROUPS.map((g) => (
                        <section key={g.title}>
                            <h3 className="text-[10px] font-bold uppercase tracking-wider text-[var(--ed-on-surface-variant)] mb-2">
                                {trStr(g.title, language)}
                            </h3>
                            <dl className="divide-y divide-[var(--ed-outline-variant)]">
                                {g.rows.map((r) => (
                                    <div key={r.label + r.keys.join("+")} className="flex items-center justify-between gap-4 py-2">
                                        <dt className="text-[13px] text-[var(--ed-on-surface)]">{trStr(r.label, language)}</dt>
                                        <dd className="flex items-center gap-1 shrink-0">
                                            {r.keys.map((k) => (
                                                <kbd
                                                    key={k}
                                                    className="min-w-6 h-6 px-1.5 inline-flex items-center justify-center rounded-md border border-[var(--ed-outline-variant)] border-b-2 bg-[var(--ed-surface-container)] text-[11px] font-medium text-[var(--ed-on-surface-variant)]"
                                                    style={{ fontFamily: "var(--ed-font-family-monospaced)" }}
                                                >
                                                    {keyLabel(k)}
                                                </kbd>
                                            ))}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        </section>
                    ))}
                </div>
            </div>
        </>
    );
}

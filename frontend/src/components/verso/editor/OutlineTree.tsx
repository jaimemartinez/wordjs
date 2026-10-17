"use client";
/**
 * Verso — outline ("Estructura") del panel izquierdo (F3, checklist W16/W17 — vista nueva, sin
 * Puck.Outline): árbol plano-indentado del documento con selección SINCRONIZADA en ambos
 * sentidos — click en fila → handle.select(id); selección hecha en el canvas → fila resaltada
 * (borde izquierdo 2px, la firma visual de las filas de árbol del blueprint §b).
 * El modelo (outlineRows) es puro y está testeado; aquí solo hay pintura y wiring.
 *
 * Plegado: cada fila con hijos tiene su chevron (estado local, por id). Una selección hecha en el
 * canvas DESPLIEGA sus contenedores y desplaza la fila a la vista — la selección nunca queda oculta.
 */
import React from "react";
import MSym from "@/components/editor/MSym";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import type { VersoEditorState } from "@/lib/verso/types";
import { useStoreSlice } from "../render/context";
import { ancestorChain, outlineRows, visibleOutlineRows } from "./outlineModel";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";

const selectDoc = (s: VersoEditorState) => s.doc;
const selectSelectedId = (s: VersoEditorState) => s.selection.nodeId;

export default function OutlineTree({ handle, registry }: { handle: EditorHandle; registry: BlockRegistry }) {
    const { language } = useI18n();
    const doc = useStoreSlice(handle, selectDoc);
    const selectedId = useStoreSlice(handle, selectSelectedId);
    const rows = React.useMemo(() => outlineRows(doc, registry), [doc, registry]);
    const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set());
    const listRef = React.useRef<HTMLUListElement | null>(null);

    // La selección manda: si cae dentro de un contenedor plegado, se despliega su cadena. Ajuste de
    // estado DURANTE el render (patrón de React para estado derivado de props), no en un efecto.
    const [revealedFor, setRevealedFor] = React.useState<string | null>(null);
    if (selectedId !== revealedFor) {
        setRevealedFor(selectedId);
        if (selectedId) {
            const hidden = ancestorChain(doc, registry, selectedId).slice(0, -1).filter((c) => collapsed.has(c.id));
            if (hidden.length) {
                const next = new Set(collapsed);
                for (const c of hidden) next.delete(c.id);
                setCollapsed(next);
            }
        }
    }

    // …y la fila se desplaza a la vista (block:"nearest" no mueve nada si ya se ve).
    React.useEffect(() => {
        if (!selectedId || !listRef.current) return;
        const row = listRef.current.querySelector<HTMLElement>(`[data-wjs-outline-id="${CSS.escape(selectedId)}"]`);
        row?.scrollIntoView({ block: "nearest" });
    }, [selectedId]);

    const toggle = (id: string) =>
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    const visible = visibleOutlineRows(rows, collapsed);

    if (rows.length === 0) {
        return (
            <div className="px-4 py-8 text-center text-[var(--ed-on-surface-variant)]">
                <span className="mx-auto mb-3 flex w-12 h-12 items-center justify-center rounded-xl bg-[var(--ed-surface-container)]">
                    <MSym name="layers" size={24} className="text-[var(--ed-outline)]" />
                </span>
                <p className="text-[12px] leading-5">
                    {trStr("Tu lienzo está listo. Añade el primer bloque para empezar a construir tu visión.", language)}
                </p>
            </div>
        );
    }

    return (
        <ul ref={listRef} role="tree" aria-label={trStr("Estructura", language)} className="flex flex-col gap-1">
            {visible.map((row) => {
                const active = row.id === selectedId;
                const expandable = row.childCount > 0;
                const open = expandable && !collapsed.has(row.id);
                return (
                    <li
                        key={row.id}
                        role="treeitem"
                        aria-selected={active}
                        aria-level={row.depth + 1}
                        aria-expanded={expandable ? open : undefined}
                        className="relative"
                    >
                        {expandable && (
                            <button
                                type="button"
                                onClick={() => toggle(row.id)}
                                title={trStr(open ? "Contraer" : "Expandir", language)}
                                aria-label={`${trStr(open ? "Contraer" : "Expandir", language)} ${trStr(row.label, language)}`}
                                className="absolute top-1/2 -translate-y-1/2 z-10 w-6 h-6 rounded-md flex items-center justify-center text-[var(--ed-outline)] hover:text-[var(--ed-on-surface)] hover:bg-[var(--ed-surface-container-high)]"
                                style={{ left: row.depth * 16 }}
                            >
                                <MSym name={open ? "expand_more" : "chevron_right"} size={16} />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => handle.select(row.id)}
                            title={trStr(row.label, language)}
                            data-wjs-outline-id={row.id}
                            className={`w-full min-h-10 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[13px] border-l-2 transition-colors ${
                                active
                                    ? "border-[var(--ed-primary)] bg-[var(--ed-surface-container-low)] text-[var(--ed-primary)] font-semibold"
                                    : "border-transparent text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
                            }`}
                            style={{ paddingLeft: 26 + row.depth * 16 }}
                        >
                            <MSym name={row.ms} size={16} className="shrink-0" />
                            <span className="truncate flex-1">{trStr(row.label, language)}</span>
                            {expandable && !open && (
                                <span className="shrink-0 text-[10px] font-semibold tabular-nums text-[var(--ed-on-surface-variant)] bg-[var(--ed-surface-container)] rounded px-1.5">
                                    {row.childCount}
                                </span>
                            )}
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}

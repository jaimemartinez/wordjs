"use client";
/**
 * Verso — outline ("Estructura") del panel izquierdo (F3, checklist W16/W17 — vista nueva, sin
 * Puck.Outline): árbol plano-indentado del documento con selección SINCRONIZADA en ambos
 * sentidos — click en fila → handle.select(id); selección hecha en el canvas → fila resaltada
 * (borde izquierdo 2px, la firma visual de las filas de árbol del blueprint §b).
 * El modelo (outlineRows) es puro y está testeado; aquí solo hay pintura y wiring.
 */
import React from "react";
import MSym from "@/components/editor/MSym";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import type { VersoEditorState } from "@/lib/verso/types";
import { useStoreSlice } from "../render/context";
import { outlineRows } from "./outlineModel";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";

const selectDoc = (s: VersoEditorState) => s.doc;
const selectSelectedId = (s: VersoEditorState) => s.selection.nodeId;

export default function OutlineTree({ handle, registry }: { handle: EditorHandle; registry: BlockRegistry }) {
    const { language } = useI18n();
    const doc = useStoreSlice(handle, selectDoc);
    const selectedId = useStoreSlice(handle, selectSelectedId);
    const rows = React.useMemo(() => outlineRows(doc, registry), [doc, registry]);

    if (rows.length === 0) {
        return (
            <p className="px-1 py-2 text-[12px] text-[var(--ed-on-surface-variant)]">
                {trStr("Tu lienzo está listo. Añade el primer bloque para empezar a construir tu visión.", language)}
            </p>
        );
    }

    return (
        <ul role="tree" aria-label={trStr("Estructura", language)} className="flex flex-col gap-0.5">
            {rows.map((row) => {
                const active = row.id === selectedId;
                return (
                    <li key={row.id} role="treeitem" aria-selected={active} aria-level={row.depth + 1}>
                        <button
                            type="button"
                            onClick={() => handle.select(row.id)}
                            title={row.label}
                            data-wjs-outline-id={row.id}
                            className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-left text-[13px] border-l-2 transition-colors ${
                                active
                                    ? "border-[var(--ed-primary)] bg-[var(--ed-surface-container-low)] text-[var(--ed-primary)] font-semibold"
                                    : "border-transparent text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
                            }`}
                            style={{ paddingLeft: 6 + row.depth * 14 }}
                        >
                            <MSym name={row.ms} size={14} className="shrink-0" />
                            <span className="truncate">{trStr(row.label, language)}</span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}

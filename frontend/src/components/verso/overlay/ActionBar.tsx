"use client";
/**
 * Verso — ActionBar flotante del bloque seleccionado (F2).
 *
 * Vive en la capa overlay del documento PADRE (pointer-events:none): SOLO este
 * grupo de controles re-habilita pointer-events (clase pointer-events-auto en
 * el contenedor de la barra, nada más en la capa). Toda acción delega en
 * actionBarCommands.ts (lógica pura, testeada); la barra jamás toca el doc.
 * aria-label en todos los botones.
 */
import React from "react";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import type { BlockRect } from "./GeometryStore";
import {
    actionBarModel,
    duplicateSelected,
    editSelectedInline,
    moveSelected,
    removeSelected,
} from "./actionBarCommands";

const BAR_BTN_CLS =
    "flex h-6 w-6 items-center justify-center rounded text-xs leading-none text-white/90 hover:bg-white/20 disabled:opacity-35 disabled:hover:bg-transparent";

export interface ActionBarProps {
    handle: EditorHandle;
    registry: BlockRegistry;
    nodeId: string;
    rect: BlockRect;
}

export default function ActionBar({ handle, registry, nodeId, rect }: ActionBarProps) {
    const model = actionBarModel(handle.getDoc(), registry, nodeId);
    if (!model) return null;
    // Encima del bloque; si no cabe (borde superior del canvas), dentro del bloque.
    const BAR_H = 28;
    const top = rect.y >= BAR_H + 2 ? rect.y - BAR_H - 2 : rect.y + 2;
    return (
        <div
            data-wjs-actionbar=""
            role="toolbar"
            aria-label={`Acciones del bloque ${model.label}`}
            className="pointer-events-auto absolute flex items-center gap-0.5 rounded bg-[var(--ed-primary,#2563eb)] px-1 py-0.5 shadow-lg"
            style={{ left: Math.max(0, rect.x), top: Math.max(0, top) }}
        >
            <span className="max-w-32 truncate px-1 text-[11px] font-medium text-white">{model.label}</span>
            <button
                type="button"
                className={BAR_BTN_CLS}
                aria-label="Subir bloque"
                disabled={!model.canMoveUp}
                onClick={() => moveSelected(handle, nodeId, -1)}
            >
                ↑
            </button>
            <button
                type="button"
                className={BAR_BTN_CLS}
                aria-label="Bajar bloque"
                disabled={!model.canMoveDown}
                onClick={() => moveSelected(handle, nodeId, 1)}
            >
                ↓
            </button>
            <button
                type="button"
                className={BAR_BTN_CLS}
                aria-label="Duplicar bloque"
                onClick={() => duplicateSelected(handle, nodeId)}
            >
                ⧉
            </button>
            {model.canEditInline && (
                <button
                    type="button"
                    className={BAR_BTN_CLS}
                    aria-label="Editar contenido del bloque"
                    onClick={() => editSelectedInline(handle, registry, nodeId)}
                >
                    ✎
                </button>
            )}
            <button
                type="button"
                className={BAR_BTN_CLS}
                aria-label="Eliminar bloque"
                onClick={() => removeSelected(handle, nodeId)}
            >
                🗑
            </button>
        </div>
    );
}

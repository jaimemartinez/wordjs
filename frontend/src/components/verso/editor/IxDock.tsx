"use client";
/**
 * Verso — DOCK DE MOVIMIENTO: el panel propio, abajo y a lo ancho, de las interacciones y la
 * animación de entrada del bloque seleccionado.
 *
 * POR QUÉ ABAJO: el movimiento se edita mirando el LIENZO, y su pieza central — la línea de tiempo
 * multipista (P9) — es horizontal por naturaleza. En los 320px del inspector derecho vivía
 * comprimida; aquí tiene el ancho del canvas, como el dock de cualquier herramienta de animación.
 * El inspector deja de renderizar `ix` y `anim` (el reparto de `panelTabs` los entrega aquí vía
 * `DOCK_FIELD_KEYS`): UN solo dueño por prop, nunca dos copias del control peleando por el dato.
 *
 * QUÉ NO CAMBIA: los controles son LOS MISMOS (`InteractionsControl` entero y el campo `anim` por
 * `VersoFieldControl`), con sus tests, su accesibilidad y sus escritores puros. Este componente es
 * solo la carcasa: cabecera plegable, reparto en columnas, y el mismo camino de escritura
 * (`handle.transact` con `coalesceKey`) que usa el inspector.
 *
 * SOLO ESCRITORIO/TABLETA (`hidden md:flex`): en móvil el editor trabaja con hojas (sheets) y el
 * borde inferior ya aloja la barra de navegación — el inspector móvil sigue siendo el camino.
 */
import React, { useState } from "react";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry } from "@/lib/verso/registry";
import type { VersoEditorState } from "@/lib/verso/types";
import { useStoreSlice } from "../render/context";
import { useSiteIxPresets } from "../canvas/useSiteIxPresets";
import InteractionsControl from "../fields/InteractionsControl";
import VersoFieldControl from "../fields/VersoFieldControl";
import { dockFieldEntries } from "./panelTabs";

const selectState = (s: VersoEditorState) => s;

export interface IxDockProps {
    handle: EditorHandle;
    registry: BlockRegistry;
}

export default function IxDock({ handle, registry }: IxDockProps) {
    const { language } = useI18n();
    const state = useStoreSlice(handle, selectState);
    const selectedId = state.selection.nodeId;
    const node = selectedId ? state.doc.nodes[selectedId] : undefined;
    const def = node ? registry.get(node.type) : undefined;
    const isDragging = state.dragPreview !== null;
    const ixCtx = useSiteIxPresets();

    // Plegado LOCAL del dock (no por bloque): abierto de nacimiento — es el motivo del panel.
    const [open, setOpen] = useState(true);

    const values: Record<string, unknown> = node ? node.props : {};
    const dockFields = def ? dockFieldEntries(def.fields) : [];

    const onFieldChange = (key: string, value: unknown) => {
        if (!node) return;
        handle.transact((tx) => tx.setProps(node.id, { [key]: value }), {
            coalesceKey: `props:${node.id}:${key}`,
            label: `Editar ${key}`,
        });
    };

    return (
        <section
            // Ancla determinista para los e2e, hermana de data-verso-panel.
            data-verso-dock={node ? "block" : "empty"}
            aria-label={trStr("Movimiento del bloque", language)}
            className="hidden md:flex shrink-0 flex-col border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)]"
        >
            <header className="h-9 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--ed-outline-variant)]">
                <MSym name="animation" size={16} className="text-[var(--ed-on-surface-variant)]" />
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--ed-on-surface)]">
                    {trStr("Movimiento", language)}
                </h3>
                {node && (
                    <span className="min-w-0 truncate text-[10px] text-[var(--ed-outline)]">
                        {def?.label ? trStr(def.label, language) : node.type}
                    </span>
                )}
                <span className="flex-1" />
                <button
                    type="button"
                    onClick={() => setOpen((o) => !o)}
                    aria-expanded={open}
                    title={trStr(open ? "Plegar el panel de movimiento" : "Desplegar el panel de movimiento", language)}
                    className="w-6 h-6 rounded flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] transition-colors"
                >
                    <MSym name={open ? "expand_more" : "expand_less"} size={16} />
                </button>
            </header>

            {open && (
                <div className="relative h-[248px] shrink-0">
                    {!node ? (
                        <div className="absolute inset-0 flex items-center justify-center text-center p-6 select-none">
                            <p className="text-[12px] text-[var(--ed-on-surface-variant)]">
                                {trStr("Selecciona un bloque para editar su animación de entrada y sus interacciones.", language)}
                            </p>
                        </div>
                    ) : isDragging ? (
                        // La misma regla que el inspector: los campos no pueden aplicar a un bloque en el aire.
                        <div className="absolute inset-0 flex items-center justify-center text-center p-6 pointer-events-none select-none">
                            <p className="text-[12px] text-[var(--ed-on-surface-variant)]">
                                {trStr("Suelta el bloque en el lienzo para editar su movimiento.", language)}
                            </p>
                        </div>
                    ) : (
                        <div className="absolute inset-0 overflow-x-auto overflow-y-hidden custom-scrollbar px-3 py-3">
                            {/* Columnas CSS: los controles (verticales por diseño) fluyen en columnas de
                                20rem que crecen hacia la DERECHA — el dock se recorre en horizontal,
                                como el timeline de cualquier herramienta de animación. El orden del DOM
                                (y del teclado) no cambia: la fragmentación es solo visual. */}
                            <div className="h-full [column-width:20rem] [column-fill:auto] [column-gap:1.25rem] [&_fieldset]:break-inside-avoid">
                                {dockFields.map(([key, field]) => (
                                    <VersoFieldControl
                                        key={`${node.id}:${key}`}
                                        field={field}
                                        name={key}
                                        label={field.label ? trStr(field.label, language) : undefined}
                                        value={values[key]}
                                        onChange={(v) => onFieldChange(key, v)}
                                    />
                                ))}
                                <InteractionsControl
                                    key={`${node.id}:ix`}
                                    value={values.ix}
                                    ixCtx={ixCtx}
                                    // «Las palabras» solo si el RENDER del bloque emite los spans por
                                    // palabra: lo declara su definición (`ixText`), no el panel.
                                    supportsWords={def?.ixText === true}
                                    onChange={(v) => onFieldChange("ix", v)}
                                />
                            </div>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}

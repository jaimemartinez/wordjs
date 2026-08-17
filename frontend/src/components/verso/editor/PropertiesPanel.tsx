"use client";
/**
 * Verso — panel derecho de propiedades (F3, checklist W21): misma piel que el PropertiesPanel del
 * PuckEditor legacy, ya retirado (header de identidad chip 32px + nombre 12px bold + ID mono 10px; 3 pestañas
 * Contenido/Estilo/Avanzado; overlay "Panel bloqueado" durante drag; footer "Restablecer
 * estilos"), sobre el motor Verso:
 *
 *  - Campos: VersoFieldControl por entrada, valores del nodo vivo (suscripción por store),
 *    escritura vía transact.setProps con coalesceKey por campo (tecleo = una entrada de historia).
 *  - Sin selección: los campos ROOT (rootFields prop — rootFieldsPage/rootFieldsPost, la asimetría
 *    del CMS) contra doc.root.props vía setRootProps — la vista "Ajustes de página" (W41).
 *  - Pestañas: partición EXPLÍCITA por clave (panelTabs.ts) — equivalente documentado del filtrado
 *    CSS :has(.wjs-f-*) del editor actual (mismas claves, mismo resultado visual); pestañas sin
 *    campos se deshabilitan y la activa cae a Contenido al cambiar la selección (misma regla).
 *  - "Restablecer estilos": vuelve look/anim/hide a los defaultProps del tipo, vía transact
 *    (undoable), contenido intacto — la semántica exacta del reset actual.
 *
 * MOVIMIENTO: las interacciones (`ix`) y la animación de entrada (`anim`) YA NO se montan aquí —
 * viven en el DOCK inferior de movimiento (IxDock), con el ancho que su línea de tiempo necesita.
 * El reparto de panelTabs (DOCK_FIELD_KEYS) los retira de las pestañas: un solo dueño por prop.
 */
import React, { useEffect, useMemo, useState } from "react";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import { BLOCK_META } from "@/lib/blockCatalog";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry, VersoField } from "@/lib/verso/registry";
import type { VersoEditorState } from "@/lib/verso/types";
import { useStoreSlice } from "../render/context";
import VersoFieldControl, { type RenderExternalPicker } from "../fields/VersoFieldControl";
import { partitionFieldEntries, tabAvailability, type PanelTab } from "./panelTabs";

const selectState = (s: VersoEditorState) => s;

export interface VersoPropertiesPanelProps {
    handle: EditorHandle;
    registry: BlockRegistry;
    /** Campos ROOT del tipo de registro (rootFieldsPage / rootFieldsPost) — vista sin selección. */
    rootFields: Record<string, VersoField>;
    /** Picker de los campos `external` (W22): VersoEditor inyecta MediaPickerModal. */
    renderExternalPicker?: RenderExternalPicker;
    onClose: () => void;
    mobileOpen?: boolean;
}

export default function PropertiesPanel({ handle, registry, rootFields, renderExternalPicker, onClose, mobileOpen = false }: VersoPropertiesPanelProps) {
    const { t, language } = useI18n();
    const state = useStoreSlice(handle, selectState);
    const selectedId = state.selection.nodeId;
    const node = selectedId ? state.doc.nodes[selectedId] : undefined;
    const def = node ? registry.get(node.type) : undefined;
    const isDragging = state.dragPreview !== null;

    const msIcon = node ? (BLOCK_META[node.type]?.ms || "widgets") : "web";
    const label = node
        ? (def?.label ? trStr(def.label, language) : node.type)
        : trStr("Página", language);
    const blockId = node?.props.id as string | undefined;

    const fields: Record<string, VersoField> = def?.fields ?? rootFields;
    const parts = useMemo(() => partitionFieldEntries(fields), [fields]);
    // Las interacciones y la animación de entrada viven en el DOCK inferior de movimiento
    // (IxDock + DOCK_FIELD_KEYS): el inspector ya no fuerza Avanzado — pestaña vacía, pestaña fuera.
    const avail = useMemo(() => tabAvailability(fields), [fields]);

    const [tab, setTab] = useState<PanelTab>("content");
    useEffect(() => {
        // Paridad con el panel actual: si la selección cambia a un bloque sin la pestaña activa,
        // la pestaña CAE (persistentemente) a Contenido — no un derive de render, que "recordaría"
        // la pestaña stale al volver a un bloque que sí la tiene.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- corrección puntual post-selección, converge en un render
        if ((tab === "style" && !avail.style) || (tab === "advanced" && !avail.advanced)) setTab("content");
    }, [avail, tab]);

    const values: Record<string, unknown> = node ? node.props : ((state.doc.root.props as Record<string, unknown>) ?? {});

    const onFieldChange = (key: string, value: unknown) => {
        if (node) {
            handle.transact((tx) => tx.setProps(node.id, { [key]: value }), {
                coalesceKey: `props:${node.id}:${key}`,
                label: `Editar ${key}`,
            });
        } else {
            handle.transact((tx) => tx.setRootProps({ [key]: value }), {
                coalesceKey: `root:${key}`,
                label: `Editar ${key}`,
            });
        }
    };

    // El RESET del diseño, honesto: look/anim/hide del bloque a SUS defaults (contenido intacto),
    // por el camino normal de comandos — cae en la historia y Ctrl+Z lo revierte.
    const resetStyles = () => {
        if (!node || !def) return;
        const d = def.defaultProps;
        handle.transact(
            (tx) => tx.setProps(node.id, { look: d.look ?? {}, anim: d.anim ?? {}, hide: d.hide ?? {} }),
            { label: "Restablecer estilos" },
        );
    };

    const TABS = [
        { id: "content" as const, label: trStr("Contenido", language), enabled: true },
        { id: "style" as const, label: trStr("Estilo", language), enabled: avail.style },
        { id: "advanced" as const, label: trStr("Avanzado", language), enabled: avail.advanced },
    ];

    return (
        <aside
            // Modo del panel: "block" (hay selección) o "root" (ajustes de la
            // página/entrada). Ancla DETERMINISTA para los e2e — sin ella un spec
            // solo puede heurizar por texto y, con el panel a medio conmutar,
            // escribe el título de la página en el campo del bloque (cazado en CI,
            // donde el arranque es más lento que en local).
            data-verso-panel={node ? "block" : "root"}
            data-verso-panel-node={node?.id ?? undefined}
            className={`flex-col bg-[var(--ed-surface-container-lowest)] border-l border-[var(--ed-outline-variant)] ${mobileOpen ? "flex fixed inset-x-0 top-12 bottom-14 z-40" : "hidden"} md:flex md:static md:inset-auto md:w-[320px] md:shrink-0 md:z-30`}
        >
            <div className="shrink-0 p-3 flex items-center gap-2.5 bg-[var(--ed-surface-container-low)] border-b border-[var(--ed-outline-variant)]">
                <div className="w-8 h-8 shrink-0 rounded bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)] flex items-center justify-center">
                    <MSym name={msIcon} size={20} />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-[12px] font-bold text-[var(--ed-on-surface)] leading-4 truncate">{label}</h3>
                    <p
                        className="text-[10px] text-[var(--ed-on-surface-variant)] truncate"
                        style={{ fontFamily: "var(--ed-font-family-monospaced)" }}
                    >
                        {blockId ? `ID: ${blockId}` : t('editor.properties')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    title={t('editor.hideProperties')}
                    className="w-6 h-6 shrink-0 rounded flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                >
                    <MSym name="chevron_right" size={16} />
                </button>
            </div>

            {/* Tabs — el reparto de 3 vías del diseño, aquí por partición explícita (panelTabs.ts). */}
            <div className="flex shrink-0 border-b border-[var(--ed-outline-variant)]" role="tablist">
                {TABS.map((x) => (
                    <button
                        key={x.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === x.id}
                        disabled={!x.enabled}
                        onClick={() => setTab(x.id)}
                        className={`flex-1 py-2.5 text-[11px] font-medium transition-colors border-b-2 ${tab === x.id
                            ? 'text-[var(--ed-primary)] border-[var(--ed-primary)] bg-[var(--ed-surface-container-low)]'
                            : x.enabled
                                ? 'text-[var(--ed-on-surface-variant)] border-transparent hover:bg-[var(--ed-surface-container)]'
                                : 'text-[var(--ed-outline-variant)] border-transparent cursor-not-allowed'}`}
                    >
                        {x.label}
                    </button>
                ))}
            </div>

            <div className="relative flex-1 min-h-0">
                <div data-ptab={tab} className="absolute inset-0 overflow-y-auto custom-scrollbar p-3">
                    {parts[tab].map(([key, field]) => (
                        <VersoFieldControl
                            key={`${blockId ?? "root"}:${key}`}
                            field={field}
                            name={key}
                            label={field.label ? trStr(field.label, language) : undefined}
                            value={values[key]}
                            onChange={(v) => onFieldChange(key, v)}
                            renderExternalPicker={renderExternalPicker}
                        />
                    ))}
                </div>
                {/* Estado de drag — los campos no pueden aplicar a un bloque en el aire. */}
                {isDragging && (
                    <div className="absolute inset-0 z-10 bg-[var(--ed-surface-container-lowest)]/90 flex flex-col items-center justify-center text-center p-6 pointer-events-none select-none">
                        <div className="w-16 h-16 rounded-full bg-[var(--ed-surface-container)] flex items-center justify-center mb-4">
                            <MSym name="replace_image" size={32} className="text-[var(--ed-outline)]" />
                        </div>
                        <p className="text-[12px] font-semibold text-[var(--ed-on-surface)]">{trStr("Panel bloqueado", language)}</p>
                        <p className="text-[13px] text-[var(--ed-on-surface-variant)] mt-2">
                            {trStr("Suelta el bloque en el lienzo para editar sus propiedades.", language)}
                        </p>
                    </div>
                )}
            </div>

            {/* Footer — reset de estilos del bloque a sus propios defaults (undoable). */}
            {blockId && (avail.style || avail.advanced) && (
                <div className="shrink-0 p-2.5 border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)]">
                    <button
                        type="button"
                        onClick={resetStyles}
                        className="w-full py-2 rounded-md border border-[var(--ed-outline-variant)] text-[11px] font-bold uppercase tracking-wide text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] hover:text-[var(--ed-error)] transition-colors flex items-center justify-center gap-1.5"
                    >
                        <MSym name="refresh" size={14} />
                        {trStr("Restablecer estilos", language)}
                    </button>
                </div>
            )}
        </aside>
    );
}

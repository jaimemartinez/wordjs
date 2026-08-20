"use client";
/**
 * Verso — panel derecho de propiedades.
 *
 * REDISEÑO (Stitch "Architectural Precision", el mismo sistema del que salió el editor — proyecto
 * `15016963210436703665`, pantalla "Panel de Propiedades Verso"): el panel pasa de PESTAÑAS a
 * SECCIONES PLEGABLES (acordeón), que es el patrón canónico del inspector en ese sistema. Todo lo
 * visible a la vez, cada sección se colapsa; cabecera con chip de identidad, y pie de "Restablecer".
 * Solo cambia la CHROME del panel — el reparto de campos, la escritura y los anclajes de e2e no.
 *
 *  - Campos: VersoFieldControl por entrada, valores del nodo vivo (suscripción por store),
 *    escritura vía transact.setProps con coalesceKey por campo (tecleo = una entrada de historia).
 *  - Sin selección: los campos ROOT (rootFields prop — rootFieldsPage/rootFieldsPost, la asimetría
 *    del CMS) contra doc.root.props vía setRootProps — la vista "Ajustes de página".
 *  - Secciones: MISMA partición explícita por clave (panelTabs.ts) que antes alimentaba las pestañas;
 *    una sección vacía no se pinta (la de Avanzado siempre existe con un bloque, porque el panel de
 *    interacciones vive ahí). El estado de plegado es por sección y persiste entre selecciones.
 *  - "Restablecer estilos": vuelve look/anim/hide a los defaultProps del tipo, vía transact
 *    (undoable), contenido intacto.
 *
 * INTERACCIONES (F9-D): el panel de interacciones se monta en AVANZADO, junto a `anim` — es su
 * hermano mayor (`anim` es la entrada de siempre; `ix` es la timeline). Va aquí y NO como un campo
 * inyectado por `withSharedVersoFields` a propósito: ese seam está sujeto a un gate anti-drift que
 * compara clave a clave los `fields` de Verso con los de `versoConfig` (verso-coreBlocks.test.ts), y
 * `ix` no existe —ni va a existir— en el editor viejo, al que Verso sustituye.
 */
import React, { useMemo, useState } from "react";
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
    /** Picker de los campos `external`: VersoEditor inyecta MediaPickerModal. */
    renderExternalPicker?: RenderExternalPicker;
    onClose: () => void;
    mobileOpen?: boolean;
}

/** Las tres secciones del inspector, en orden. Icono Material Symbol por sección. */
const SECTIONS: { key: PanelTab; icon: string; label: string }[] = [
    { key: "content", icon: "edit_note", label: "Contenido" },
    { key: "style", icon: "palette", label: "Estilo" },
    { key: "advanced", icon: "tune", label: "Avanzado" },
];

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
    // (IxDock + DOCK_FIELD_KEYS): el inspector ya no fuerza Avanzado — sección vacía, sección fuera.
    const avail = useMemo(() => tabAvailability(fields), [fields]);

    // Plegado por sección (no por nodo): persiste al cambiar de selección, como en Figma/Framer.
    // Las tres nacen abiertas — el inspector muestra todo de un vistazo y se colapsa a voluntad.
    const [collapsed, setCollapsed] = useState<Record<PanelTab, boolean>>({
        content: false,
        style: false,
        advanced: false,
    });
    const toggle = (k: PanelTab) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));

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

    /** ¿Esta sección tiene algo que mostrar? Solo si el reparto le da campos. */
    const hasSection = (k: PanelTab) => parts[k].length > 0;

    return (
        <aside
            // Modo del panel: "block" (hay selección) o "root" (ajustes de la
            // página/entrada). Ancla DETERMINISTA para los e2e — sin ella un spec
            // solo puede heurizar por texto y, con el panel a medio conmutar,
            // escribe el título de la página en el campo del bloque.
            data-verso-panel={node ? "block" : "root"}
            data-verso-panel-node={node?.id ?? undefined}
            className={`verso-panel verso-sheet verso-sheet-right flex-col border-l border-[var(--ed-outline-variant)] ${mobileOpen ? "flex" : "hidden"} xl:flex xl:static xl:inset-auto xl:w-[336px] xl:shrink-0 xl:z-30`}
        >
            {/* Cabecera de identidad: chip 32px + nombre + ID mono + colapsar. */}
            <header className="shrink-0 h-16 px-4 flex items-center gap-3 bg-[var(--ed-surface-container-lowest)] border-b border-[var(--ed-outline-variant)]">
                <div className="w-9 h-9 shrink-0 rounded-xl bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)] flex items-center justify-center">
                    <MSym name={msIcon} size={20} />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-[13px] font-semibold tracking-[0.01em] text-[var(--ed-on-surface)] leading-5 truncate">{label}</h3>
                    <p
                        className="text-[10px] leading-3 text-[var(--ed-outline)] truncate"
                        style={{ fontFamily: "var(--ed-font-family-monospaced)" }}
                    >
                        {blockId ? `ID: ${blockId}` : t('editor.properties')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    title={t('editor.hideProperties')}
                    aria-label={t('editor.hideProperties')}
                    className="verso-icon-button w-9 h-9 shrink-0 rounded-lg flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] transition-colors"
                >
                    <MSym name="chevron_right" size={18} className="hidden xl:block" />
                    <MSym name="close" size={18} className="xl:hidden" />
                </button>
            </header>

            <div className="relative flex-1 min-h-0">
                {/* Cuerpo: secciones plegables (el reparto de 3 vías, aquí como acordeón). */}
                <main className="absolute inset-0 overflow-y-auto custom-scrollbar flex flex-col">
                    {SECTIONS.filter((s) => hasSection(s.key)).map((s, i, arr) => {
                        const open = !collapsed[s.key];
                        const isLast = i === arr.length - 1;
                        return (
                            <section
                                key={s.key}
                                data-verso-section={s.key}
                                className={isLast ? "" : "border-b border-[var(--ed-outline-variant)]"}
                            >
                                <button
                                    type="button"
                                    onClick={() => toggle(s.key)}
                                    aria-expanded={open}
                                    className="w-full min-h-11 px-4 py-3 flex items-center justify-between group hover:bg-[var(--ed-surface-container-low)] transition-colors"
                                >
                                    <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--ed-on-surface)]">
                                        <MSym name={s.icon} size={16} className="text-[var(--ed-on-surface-variant)]" />
                                        {trStr(s.label, language)}
                                    </span>
                                    <MSym
                                        name={open ? "expand_less" : "expand_more"}
                                        size={16}
                                        className="text-[var(--ed-outline)] group-hover:text-[var(--ed-on-surface)] transition-colors"
                                    />
                                </button>
                                {open && (
                                    <div className="px-4 pb-4 flex flex-col gap-4">
                                        {parts[s.key].map(([key, field]) => (
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
                                )}
                            </section>
                        );
                    })}
                </main>
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

            {/* Pie — reset de estilos del bloque a sus propios defaults (undoable). */}
            {blockId && (avail.style || avail.advanced) && (
                <footer className="shrink-0 p-4 border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)]">
                    <button
                        type="button"
                        onClick={resetStyles}
                        className="w-full min-h-10 rounded-xl border border-[var(--ed-outline-variant)] text-[11px] font-bold uppercase tracking-wide text-[var(--ed-on-surface-variant)] hover:border-[var(--ed-error)] hover:text-[var(--ed-error)] transition-colors flex items-center justify-center gap-1.5"
                    >
                        <MSym name="refresh" size={14} />
                        {trStr("Restablecer estilos", language)}
                    </button>
                </footer>
            )}
        </aside>
    );
}

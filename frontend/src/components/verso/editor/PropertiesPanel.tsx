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
import React, { useMemo, useState, useSyncExternalStore } from "react";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { humanizeFieldKey, localizeField, trStr } from "@/lib/editorI18n";
import { BLOCK_META } from "@/lib/blockCatalog";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockRegistry, VersoField } from "@/lib/verso/registry";
import type { VersoEditorState } from "@/lib/verso/types";
import { useStoreSlice } from "../render/context";
import VersoFieldControl, { type RenderExternalPicker } from "../fields/VersoFieldControl";
import { partitionFieldEntries, tabAvailability, type PanelTab } from "./panelTabs";
import { ancestorChain } from "./outlineModel";
import { DockMotion } from "./IxDock";
import { useSiteIxPresets } from "../canvas/useSiteIxPresets";

/** Por debajo de md el dock de movimiento no existe (IxDock: `hidden md:flex`): su cuerpo vive aquí. */
const PHONE_QUERY = "(max-width: 767.98px)";
function subscribePhone(cb: () => void) {
    const mq = window.matchMedia(PHONE_QUERY);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
}
function usePhoneWidth(): boolean {
    return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}

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
    /** What the document IS, as a Spanish source label ("Página" | "Entrada"): a post said "Page". */
    docLabel?: string;
}

/** Las tres secciones del inspector, en orden. Icono Material Symbol por sección. */
const SECTIONS: { key: PanelTab; icon: string; label: string }[] = [
    // "edit", no "edit_note": ese glifo no está en el subset de la fuente y se pintaba como texto «_NOTE».
    { key: "content", icon: "edit", label: "Contenido" },
    { key: "style", icon: "palette", label: "Estilo" },
    { key: "advanced", icon: "tune", label: "Avanzado" },
];

export default function PropertiesPanel({ handle, registry, rootFields, renderExternalPicker, onClose, mobileOpen = false, docLabel = "Página" }: VersoPropertiesPanelProps) {
    const { t, language } = useI18n();
    const state = useStoreSlice(handle, selectState);
    const selectedId = state.selection.nodeId;
    const node = selectedId ? state.doc.nodes[selectedId] : undefined;
    const def = node ? registry.get(node.type) : undefined;
    const isDragging = state.dragPreview !== null;
    const isPhone = usePhoneWidth();
    const ixCtx = useSiteIxPresets();
    const [motionOpen, setMotionOpen] = useState(true);

    const msIcon = node ? (BLOCK_META[node.type]?.ms || "widgets") : "web";
    const label = node
        ? (def?.label ? trStr(def.label, language) : node.type)
        : trStr(docLabel, language);
    const blockId = node?.props.id as string | undefined;
    // Ruta de la selección (Página › Sección › … › bloque): cada eslabón selecciona su contenedor.
    const crumbs = node ? ancestorChain(state.doc, registry, node.id) : [];

    const fields: Record<string, VersoField> = def?.fields ?? rootFields;
    const parts = useMemo(() => partitionFieldEntries(fields), [fields]);
    // Copias traducidas UNA vez por (campos, idioma): identidad estable entre renders, que es lo que
    // esperan los controles custom en sus dependencias. Los `custom` pasan intactos (su render manda).
    const localized = useMemo(() => {
        const out: Record<string, VersoField> = {};
        for (const [key, f] of Object.entries(fields)) out[key] = f.type === "custom" ? f : localizeField(f, language);
        return out;
    }, [fields, language]);
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

    // Los slots no se editan aquí (se arrastra en el lienzo): un aviso por slot repetía lo mismo
    // tres veces —incluido «Col 2» en unas Columnas de dos—. Se quitan del reparto y, si el bloque
    // es contenedor, queda UNA pista al principio de Contenido.
    const visibleParts = useMemo(() => {
        const keep = (entries: typeof parts.content) => entries.filter(([, f]) => f.type !== "slot");
        return { content: keep(parts.content), style: keep(parts.style), advanced: keep(parts.advanced) };
    }, [parts]);
    const isContainer = parts.content.some(([, f]) => f.type === "slot");

    /** ¿Esta sección tiene algo que mostrar? Solo si el reparto le da campos. */
    const hasSection = (k: PanelTab) => visibleParts[k].length > 0 || (k === "content" && isContainer);

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
                    {/* The block's internal id used to sit here ("ID: 1337eafd-…", in a monospace face):
                        developer information on an author's screen. */}
                    <p className="text-[10px] leading-3 text-[var(--ed-outline)] truncate">
                        {t('editor.properties')}
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

            {node && (
                <nav
                    aria-label={trStr("Ruta de la selección", language)}
                    data-verso-breadcrumb=""
                    className="shrink-0 px-3 py-1.5 flex items-center gap-0.5 overflow-x-auto scrollbar-hide whitespace-nowrap border-b border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)] text-[11px]"
                >
                    <button
                        type="button"
                        onClick={() => handle.select(null)}
                        className="shrink-0 px-1.5 py-0.5 rounded text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-primary)] hover:bg-[var(--ed-surface-container)] transition-colors"
                    >
                        {trStr(docLabel, language)}
                    </button>
                    {crumbs.map((c, i) => {
                        const current = i === crumbs.length - 1;
                        return (
                            <React.Fragment key={c.id}>
                                <MSym name="chevron_right" size={12} className="shrink-0 text-[var(--ed-outline)]" />
                                {current ? (
                                    <span aria-current="true" className="shrink-0 px-1.5 py-0.5 font-semibold text-[var(--ed-on-surface)]">
                                        {trStr(c.label, language)}
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => handle.select(c.id)}
                                        className="shrink-0 px-1.5 py-0.5 rounded text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-primary)] hover:bg-[var(--ed-surface-container)] transition-colors"
                                    >
                                        {trStr(c.label, language)}
                                    </button>
                                )}
                            </React.Fragment>
                        );
                    })}
                </nav>
            )}

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
                                        {s.key === "content" && isContainer && (
                                            <p className="flex items-start gap-2 rounded-lg bg-[var(--ed-surface-container-low)] px-3 py-2 text-[12px] leading-5 text-[var(--ed-on-surface-variant)]">
                                                <MSym name="info" size={16} className="shrink-0 mt-0.5" />
                                                {trStr("Arrastra bloques dentro de este contenedor en el lienzo, o tócalos en la biblioteca con el contenedor seleccionado.", language)}
                                            </p>
                                        )}
                                        {visibleParts[s.key].map(([key, field]) => (
                                            <VersoFieldControl
                                                key={`${blockId ?? "root"}:${key}`}
                                                // Opciones y etiquetas anidadas en el idioma del editor
                                                // (los valores no se tocan); sin label, nunca la clave cruda.
                                                field={localized[key] ?? field}
                                                name={key}
                                                label={field.label ? trStr(field.label, language) : humanizeFieldKey(key, language)}
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
                    {/* MOVIMIENTO en el móvil: el cuerpo del dock (entrada + interacciones + línea de
                        tiempo, en pestañas) con altura propia, porque sus paneles se miden contra ella. */}
                    {isPhone && node && def && !isDragging && (
                        <section data-verso-section="motion" className="border-t border-[var(--ed-outline-variant)]">
                            <button
                                type="button"
                                onClick={() => setMotionOpen((o) => !o)}
                                aria-expanded={motionOpen}
                                className="w-full min-h-11 px-4 py-3 flex items-center justify-between group hover:bg-[var(--ed-surface-container-low)] transition-colors"
                            >
                                <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--ed-on-surface)]">
                                    <MSym name="animation" size={16} className="text-[var(--ed-on-surface-variant)]" />
                                    {trStr("Movimiento", language)}
                                </span>
                                <MSym name={motionOpen ? "expand_less" : "expand_more"} size={16} className="text-[var(--ed-outline)] group-hover:text-[var(--ed-on-surface)] transition-colors" />
                            </button>
                            {motionOpen && (
                                <div className="relative h-[min(72dvh,600px)] border-t border-[var(--ed-outline-variant)]">
                                    <DockMotion key={node.id} node={node} def={def} handle={handle} ixCtx={ixCtx} language={language} />
                                </div>
                            )}
                        </section>
                    )}
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

"use client";
/**
 * Verso — DOCK DE MOVIMIENTO, con la anatomía de un editor de vídeo:
 *
 *   ┌ cabecera (plegable) ───────────────────────────────────────────────┐
 *   │ INSPECTOR (izq., 22rem, scroll) │ ESCENARIO                        │
 *   │  · animación de entrada (anim)  │  · TRANSPORTE: probar / probar   │
 *   │  · InteractionsControl entero   │    todo + scrubber (playhead)    │
 *   │    (preajuste, disparador,      │  · LÍNEA DE TIEMPO (P9) GRANDE,  │
 *   │     pasos…) SIN su timeline ni  │    siempre visible, arrastrable, │
 *   │     su transporte internos      │    a todo el ancho del lienzo    │
 *   └─────────────────────────────────┴──────────────────────────────────┘
 *
 * La línea de tiempo es la PROTAGONISTA: antes vivía plegada dentro de «Editar pasos» y había que
 * desplegarla; aquí está siempre a la vista, como en cualquier herramienta de animación. El
 * inspector y el escenario comparten la PISTA ACTIVA (el control la acepta controlada vía `stage`)
 * y los MISMOS escritores puros — un solo dueño por prop, un solo camino de escritura
 * (`handle.transact` con `coalesceKey`), la misma historia de undo.
 *
 * SOLO ESCRITORIO/TABLETA (`hidden md:flex`): en móvil el editor trabaja con hojas y el inspector
 * móvil sigue siendo el camino.
 */
import React, { useMemo, useState } from "react";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockDefinition, BlockRegistry } from "@/lib/verso/registry";
import type { VersoEditorState } from "@/lib/verso/types";
import type { IxCompileCtx } from "@/lib/verso/interactions";
import { useStoreSlice } from "../render/context";
import { useSiteIxPresets } from "../canvas/useSiteIxPresets";
import { requestIxPreview, requestIxScrub } from "../canvas/IxCanvasEngine";
import InteractionsControl, { isTimed } from "../fields/InteractionsControl";
import IxScrubberControl from "../fields/IxScrubberControl";
import IxTimeline, { IX_CLIP_MIME } from "../fields/IxTimeline";
import VersoFieldControl from "../fields/VersoFieldControl";
import {
    addTrackFromPreset,
    ixPanelState,
    ixPresetOptions,
    setDelay,
    setDuration,
    setStepAt,
    usedProps,
    IX_PANEL_CUSTOM,
    IX_PANEL_NONE,
    IX_PROP_LABELS,
} from "./ixPanelModel";
import type { IxPropKey } from "@/lib/verso/interactions";
import { dockFieldEntries } from "./panelTabs";

const selectState = (s: VersoEditorState) => s;

/** Botón del transporte — la piel de los botones compactos del editor. */
const TBTN =
    "inline-flex items-center gap-1 rounded border border-[var(--ed-outline-variant)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ed-on-surface-variant)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors";

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
                <div className="relative h-[280px] shrink-0">
                    {!node || !def ? (
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
                        // key por bloque: la pista activa y el estado del inspector vuelven a la 0
                        // al cambiar de selección — la misma regla que el panel derecho.
                        <DockMotion
                            key={node.id}
                            node={node}
                            def={def}
                            handle={handle}
                            ixCtx={ixCtx}
                            language={language}
                        />
                    )}
                </div>
            )}
        </section>
    );
}

/** El cuerpo con bloque: inspector (izquierda) + escenario (transporte y línea de tiempo). */
function DockMotion({
    node,
    def,
    handle,
    ixCtx,
    language,
}: {
    node: { id: string; type: string; props: Record<string, unknown> };
    def: BlockDefinition;
    handle: EditorHandle;
    ixCtx: IxCompileCtx | undefined;
    language: ReturnType<typeof useI18n>["language"];
}) {
    const ix = node.props.ix;
    // El MISMO modelo puro que el control: el escenario no inventa una segunda verdad.
    const st = useMemo(() => ixPanelState(ix, ixCtx), [ix, ixCtx]);
    const linked = st.presetId !== null;
    const [trackSel, setTrackSel] = useState(0);
    const active = trackSel < st.tracks.length ? trackSel : 0;
    // La PALETA DE CLIPS: los preajustes reales (sin los centinelas «Ninguna»/«Personalizada…»).
    const clips = useMemo(
        () => ixPresetOptions(ixCtx).filter((o) => o.value !== IX_PANEL_NONE && o.value !== IX_PANEL_CUSTOM),
        [ixCtx],
    );
    // Rótulo de cada CLIP: sus propiedades (máx. 2), pintadas dentro de la barra como en el diseño.
    const clipLabels = useMemo(
        () =>
            st.tracks.map((t) => {
                const props = new Set<IxPropKey>();
                for (const s of t.steps) for (const k of usedProps(s)) props.add(k);
                return [...props].slice(0, 2).map((k) => IX_PROP_LABELS[k]).join(" · ") || undefined;
            }),
        [st.tracks],
    );
    // El PLAYHEAD del escenario: la posición del recorrido manual, para la línea vertical del
    // timeline. `null` = nadie recorre (el scrubber suelta con null).
    const [playhead, setPlayhead] = useState<number | null>(null);

    const onFieldChange = (key: string, value: unknown) => {
        handle.transact((tx) => tx.setProps(node.id, { [key]: value }), {
            coalesceKey: `props:${node.id}:${key}`,
            label: `Editar ${key}`,
        });
    };

    return (
        <div className="absolute inset-0 grid grid-cols-[minmax(20rem,23rem)_1fr]">
            {/* INSPECTOR — los controles de siempre, sin su timeline ni su transporte internos. */}
            <div className="overflow-y-auto custom-scrollbar border-r border-[var(--ed-outline-variant)] px-3 py-3">
                {def ? (
                    dockFieldEntries(def.fields).map(([key, field]) => (
                        <VersoFieldControl
                            key={`${node.id}:${key}`}
                            field={field}
                            name={key}
                            label={field.label ? trStr(field.label, language) : undefined}
                            value={node.props[key]}
                            onChange={(v) => onFieldChange(key, v)}
                        />
                    ))
                ) : null}
                <InteractionsControl
                    key={`${node.id}:ix`}
                    value={ix}
                    ixCtx={ixCtx}
                    // «Las palabras» solo si el RENDER del bloque emite los spans por palabra:
                    // lo declara su definición (`ixText`), no el panel.
                    supportsWords={def?.ixText === true}
                    onChange={(v) => onFieldChange("ix", v)}
                    stage={{ trackSel: active, onTrackSel: setTrackSel }}
                />
            </div>

            {/* ESCENARIO — transporte arriba, línea de tiempo protagonista debajo. */}
            <div className="min-w-0 flex flex-col">
                <div className="h-10 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--ed-outline-variant)]">
                    {/* «Probar» PRIMARIO (diseño Stitch): el play del transporte, índigo sólido. */}
                    <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded bg-[var(--ed-primary)] px-2.5 py-0.5 text-[10px] font-semibold text-white hover:bg-[var(--ed-primary-container)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                        disabled={!st.active}
                        title={trStr("Reproducir la interacción de este bloque en el lienzo", language)}
                        aria-label="Probar la interacción de este bloque"
                        onClick={() => requestIxPreview("block")}
                    >
                        <MSym name="play_arrow" size={14} className="align-[-3px]" /> {trStr("Probar", language)}
                    </button>
                    <button
                        type="button"
                        className={TBTN}
                        disabled={!st.active}
                        title={trStr("Reproducir todas las interacciones de la página en el lienzo", language)}
                        aria-label="Probar todas las interacciones de la página"
                        onClick={() => requestIxPreview("page")}
                    >
                        {trStr("Probar todo", language)}
                    </button>
                    {/* El playhead: recorrer la interacción a mano y pararse en un paso. El scrubber
                        es el componente de siempre (deslizador + gemelo numérico), en fila. */}
                    <div className="flex-1 min-w-0 [&>div]:mb-0">
                        <IxScrubberControl
                            enabled={st.active}
                            scrollDriven={
                                st.trigger.on === "scrub" ||
                                (st.trigger.on === "view" && st.trigger.once === false)
                            }
                            // El escenario INTERCEPTA la posición para pintar el playhead sobre los
                            // carriles, y la reenvía al lienzo por el camino de siempre.
                            onScrub={(pct) => {
                                setPlayhead(pct);
                                requestIxScrub(pct);
                            }}
                        />
                    </div>
                </div>

                {/* La PALETA DE CLIPS: cada preajuste es un bloque que se ARRASTRA a la línea de
                    tiempo (y se aplica soltándolo donde caiga) — o se aplica con un clic, que es
                    el mismo camino sin ratón. Con cuerpo propio, soltar AÑADE una pista-clip. */}
                <div className="h-9 shrink-0 px-3 flex items-center gap-1.5 border-b border-[var(--ed-outline-variant)] overflow-x-auto custom-scrollbar">
                    <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-[var(--ed-outline)]">
                        {trStr("Clips", language)}
                    </span>
                    {clips.map((c) => (
                        <button
                            key={c.value}
                            type="button"
                            draggable
                            data-ix-clip={c.value}
                            title={trStr("Arrastra a la línea de tiempo, o pulsa para aplicar", language)}
                            className="shrink-0 cursor-grab rounded-md border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container)] px-2 py-0.5 text-[10px] font-medium text-[var(--ed-on-surface-variant)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] transition-colors"
                            onDragStart={(e) => {
                                e.dataTransfer.setData(IX_CLIP_MIME, c.value);
                                e.dataTransfer.effectAllowed = "copy";
                            }}
                            onClick={() => onFieldChange("ix", addTrackFromPreset(ix, c.value, ixCtx))}
                        >
                            {c.label}
                        </button>
                    ))}
                </div>

                {/* Tinta ÍNDIGO del timeline (diseño Stitch): clips lavanda, acentos primarios —
                    el componente sigue siendo agnóstico (currentColor); el tono lo pone el dock. */}
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3 text-[var(--ed-primary-container)]">
                    {st.active && st.tracks.length > 0 ? (
                        <IxTimeline
                            tracks={st.tracks}
                            active={active}
                            timed={isTimed(st.trigger.on)}
                            readOnly={linked}
                            labels={clipLabels}
                            playhead={playhead}
                            onStepAt={(t, i, at) => onFieldChange("ix", setStepAt(ix, i, at, ixCtx, t))}
                            onDelay={(t, ms) => onFieldChange("ix", setDelay(ix, ms, ixCtx, t))}
                            onDur={(t, ms) => onFieldChange("ix", setDuration(ix, ms, ixCtx, t))}
                            onSelectTrack={setTrackSel}
                            // El gesto «clic quieto → fila del paso» exigiría alcanzar las filas del
                            // inspector desde aquí; de momento el clic elige la pista, y los campos
                            // numéricos del inspector siguen siendo el camino canónico.
                            onFocusStep={(t) => setTrackSel(t)}
                            onDropPreset={(delayMs, presetId) =>
                                onFieldChange("ix", addTrackFromPreset(ix, presetId, ixCtx, delayMs))
                            }
                        />
                    ) : (
                        <div
                            className="h-full flex items-center justify-center text-center rounded border border-dashed border-[var(--ed-outline-variant)]"
                            // También la zona VACÍA acepta el primer clip: soltar aplica el preajuste.
                            onDragOver={(e) => {
                                if ([...e.dataTransfer.types].includes(IX_CLIP_MIME)) e.preventDefault();
                            }}
                            onDrop={(e) => {
                                const presetId = e.dataTransfer.getData(IX_CLIP_MIME);
                                if (!presetId) return;
                                e.preventDefault();
                                onFieldChange("ix", addTrackFromPreset(ix, presetId, ixCtx));
                            }}
                        >
                            <p className="text-[12px]">
                                {trStr("Arrastra un clip de la paleta (o elige un preajuste en el inspector) para encender la línea de tiempo.", language)}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

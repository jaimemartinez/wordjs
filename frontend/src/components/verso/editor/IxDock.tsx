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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MSym from "@/components/editor/MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import type { EditorHandle } from "@/lib/verso/store";
import type { BlockDefinition, BlockRegistry } from "@/lib/verso/registry";
import type { VersoEditorState } from "@/lib/verso/types";
import type { IxCompileCtx } from "@/lib/verso/interactions";
import { useStoreSlice } from "../render/context";
import { useSiteIxPresets } from "../canvas/useSiteIxPresets";
import { DockTabs, PresetBar, type DockPane } from "./IxDockParts";
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
const MOTION_DOCK_KEY = "verso_motion_dock";
/** Altura del cuerpo elegida arrastrando el borde superior (px); sin valor, la de siempre. */
const MOTION_DOCK_H_KEY = "verso_motion_dock_h";
const DOCK_MIN_H = 180;
/** Por debajo de este ancho el dock no cabe en dos columnas: inspector y escenario van en pestañas. */
const DOCK_TWO_COL_MIN_W = 760;

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

    // Plegado LOCAL del dock: no roba lienzo cuando todavía no hay una selección. La selección
    // puede llegar DESPUÉS del montaje (la ruta nueva arranca vacía), así que debe sincronizar el
    // estado: un bloque nuevo abre Movimiento; deseleccionar vuelve a plegarlo.
    // Quien lo PLIEGA con un bloque seleccionado lo quiere plegado: esa preferencia se recuerda
    // (localStorage `verso_motion_dock`) y las selecciones siguientes ya no lo reabren — 280 px de
    // lienzo en cada clic, para editar textos que no tienen nada que ver con el movimiento, era
    // el peaje de no recordarlo. Desplegarlo a mano vuelve al comportamiento por defecto.
    const [open, setOpen] = useState(() => Boolean(node));
    useEffect(() => {
        let keepClosed = false;
        try {
            keepClosed = localStorage.getItem(MOTION_DOCK_KEY) === "closed";
        } catch {
            /* almacenamiento bloqueado: comportamiento por defecto */
        }
        setOpen(Boolean(selectedId) && !keepClosed);
    }, [selectedId]);
    // Altura AJUSTABLE: arrastrar el borde superior del dock. La preferencia se recuerda; con la
    // ventana más baja se recorta al 70 % del alto, para que el lienzo nunca desaparezca.
    const [bodyH, setBodyH] = useState<number | null>(null);
    useEffect(() => {
        try {
            const saved = Number(localStorage.getItem(MOTION_DOCK_H_KEY));
            if (saved >= DOCK_MIN_H) setBodyH(saved);
        } catch {
            /* sin almacenamiento: altura por defecto */
        }
    }, []);
    const clampH = (h: number) => Math.round(Math.max(DOCK_MIN_H, Math.min(h, window.innerHeight * 0.7)));
    const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        const body = document.getElementById("verso-motion-dock-body");
        if (!body) return;
        e.preventDefault();
        const startY = e.clientY;
        const startH = body.getBoundingClientRect().height;
        let last = startH;
        const move = (ev: PointerEvent) => {
            last = clampH(startH + (startY - ev.clientY));
            setBodyH(last);
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            try {
                localStorage.setItem(MOTION_DOCK_H_KEY, String(last));
            } catch {
                /* la altura dura lo que la sesión */
            }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };
    const nudgeH = (delta: number) => {
        const body = document.getElementById("verso-motion-dock-body");
        if (!body) return;
        const next = clampH(body.getBoundingClientRect().height + delta);
        setBodyH(next);
        try {
            localStorage.setItem(MOTION_DOCK_H_KEY, String(next));
        } catch {
            /* idem */
        }
    };

    const toggleOpen = () => {
        const next = !open;
        setOpen(next);
        if (!selectedId) return; // plegar el estado vacío no dice nada de la preferencia
        try {
            localStorage.setItem(MOTION_DOCK_KEY, next ? "open" : "closed");
        } catch {
            /* almacenamiento bloqueado: la preferencia dura lo que la sesión */
        }
    };

    return (
        <section
            // Ancla determinista para los e2e, hermana de data-verso-panel.
            data-verso-dock={node ? "block" : "empty"}
            data-verso-dock-node={node?.id}
            aria-label={trStr("Movimiento del bloque", language)}
            className="relative hidden md:flex shrink-0 flex-col border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)]"
        >
            {open && (
                // Asa de redimensión: arrastrar el borde, o flechas ↑/↓ con el foco en ella.
                <div
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={trStr("Cambiar la altura del panel de movimiento", language)}
                    title={trStr("Arrastra para cambiar la altura", language)}
                    tabIndex={0}
                    onPointerDown={startResize}
                    onKeyDown={(e) => {
                        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                            e.preventDefault();
                            nudgeH(e.key === "ArrowUp" ? 24 : -24);
                        }
                    }}
                    className="absolute -top-1 inset-x-0 z-10 h-2 cursor-row-resize outline-none hover:bg-[var(--ed-primary)]/25 focus-visible:bg-[var(--ed-primary)]/40 transition-colors"
                />
            )}
            <header className="h-10 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--ed-outline-variant)]">
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
                    onClick={() => {
                        // Si un pointerup/pointercancel se perdió fuera del iframe, puede quedar un
                        // preview huérfano. Pulsar el propio inspector demuestra que el gesto ya
                        // terminó; límpialo antes de mostrar los controles, nunca un panel falso
                        // de “Suelta el bloque”.
                        if (state.dragPreview) handle.setDragPreview(null);
                        toggleOpen();
                    }}
                    aria-expanded={open}
                    aria-controls="verso-motion-dock-body"
                    title={trStr(open ? "Plegar el panel de movimiento" : "Desplegar el panel de movimiento", language)}
                    className="verso-icon-button !h-9 !w-9"
                >
                    <MSym name={open ? "expand_more" : "expand_less"} size={16} />
                </button>
            </header>

            {!open && !node && (
                <span className="sr-only">
                    {trStr("Selecciona un bloque para editar su animación de entrada y sus interacciones.", language)}
                </span>
            )}

            {open && (
                <div
                    id="verso-motion-dock-body"
                    data-verso-dock-body
                    className={`relative shrink-0 ${bodyH === null ? "h-[220px] xl:h-[280px]" : ""}`}
                    style={bodyH === null ? undefined : { height: bodyH }}
                >
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
    // REFERENCIA ESTABLE, obligatoria: el scrubber usa `onScrub` como dependencia de su efecto de
    // limpieza — una función nueva en cada render lo SOLTARÍA y desarmaría (la misma razón por la
    // que InteractionsControl memoiza la suya). Cazado en el drill: el playhead nunca aparecía.
    const onStageScrub = useCallback((pct: number | null) => {
        setPlayhead(pct);
        requestIxScrub(pct);
    }, []);

    const onFieldChange = (key: string, value: unknown) => {
        handle.transact((tx) => tx.setProps(node.id, { [key]: value }), {
            coalesceKey: `props:${node.id}:${key}`,
            label: `Editar ${key}`,
        });
    };

    // Dos columnas solo si caben: a 1280 px con los dos paneles abiertos la columna central mide
    // ~600 px, el inspector se llevaba 320 y el escenario quedaba en 140 (botones partidos, clips con
    // scroll, línea de tiempo ilegible). Debajo del umbral, pestañas: Ajustes | Línea de tiempo.
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [twoCol, setTwoCol] = useState(true);
    const [pane, setPane] = useState<DockPane>("settings");
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setTwoCol(el.clientWidth >= DOCK_TWO_COL_MIN_W));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const dockFields = def ? dockFieldEntries(def.fields) : [];

    const inspector = (
        <div className="h-full overflow-y-auto custom-scrollbar px-3 py-3 space-y-3">
            {/* ENTRADA — el campo `anim` pinta sus selects sin rótulo propio: aquí lleva título y una
                línea que lo distingue de la interacción (dos sistemas que el autor confundía). */}
            {dockFields.length > 0 && (
                <section className="rounded-xl border border-[var(--ed-outline-variant)] p-3" data-verso-dock-section="entrance">
                    <h4 className="text-xs font-semibold text-[var(--ed-on-surface)] flex items-center gap-1.5">
                        <MSym name="play_circle" size={14} />
                        {trStr("Animación de entrada", language)}
                    </h4>
                    <p className="text-[11px] leading-4 text-[var(--ed-on-surface-variant)] mt-0.5 mb-2">
                        {trStr("Un efecto rápido al aparecer el bloque. Para algo más elaborado, usa la interacción.", language)}
                    </p>
                    {dockFields.map(([key, field]) => (
                        <VersoFieldControl
                            key={`${node.id}:${key}`}
                            field={field}
                            name={key}
                            label={field.label ? trStr(field.label, language) : undefined}
                            value={node.props[key]}
                            onChange={(v) => onFieldChange(key, v)}
                        />
                    ))}
                </section>
            )}
            <section className="rounded-xl border border-[var(--ed-outline-variant)] p-3" data-verso-dock-section="ix">
                <PresetBar
                    ix={ix}
                    linked={linked}
                    active={st.active}
                    presetName={st.presetId ? ixCtx?.presets?.[st.presetId]?.name ?? st.presetId : null}
                    ixCtx={ixCtx}
                    language={language}
                    onLinked={(next) => onFieldChange("ix", next)}
                />
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
            </section>
        </div>
    );

    // ESCENARIO — transporte arriba, línea de tiempo protagonista debajo.
    const stage = (
            <div className="h-full min-w-0 flex flex-col">
                <div className="h-10 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--ed-outline-variant)]">
                    {/* «Probar» primario y «Probar todo» secundario a la MISMA altura y radio (antes
                        32 vs 28 px y radio 8 vs 2: hermanos que parecían de dos sistemas). */}
                    <button
                        type="button"
                        className="inline-flex h-8 shrink-0 whitespace-nowrap items-center gap-1 rounded-lg bg-[var(--ed-primary-solid,var(--ed-primary))] px-3 text-[11px] font-medium text-[var(--ed-on-primary,#fff)] hover:bg-[var(--ed-primary-hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                        disabled={!st.active}
                        title={trStr("Reproducir la interacción de este bloque en el lienzo", language)}
                        aria-label="Probar la interacción de este bloque"
                        onClick={() => requestIxPreview("block")}
                    >
                        <MSym name="play_arrow" size={14} className="align-[-3px]" /> {trStr("Probar", language)}
                    </button>
                    <button
                        type="button"
                        className="inline-flex h-8 shrink-0 whitespace-nowrap items-center rounded-lg border border-[var(--ed-outline-variant)] bg-[var(--ed-surface)] px-3 text-[11px] font-medium text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                        disabled={!st.active}
                        title={trStr("Reproducir todas las interacciones de la página en el lienzo", language)}
                        aria-label="Probar todas las interacciones de la página"
                        onClick={() => requestIxPreview("page")}
                    >
                        {trStr("Probar todo", language)}
                    </button>
                    {/* El playhead: el scrubber de siempre en su VARIANTE de transporte — una sola
                        fila alineada a la derecha, como la referencia. El escenario INTERCEPTA la
                        posición (onStageScrub, referencia ESTABLE) para pintar la línea. */}
                    <IxScrubberControl
                        variant="transport"
                        enabled={st.active}
                        scrollDriven={
                            st.trigger.on === "scrub" ||
                            (st.trigger.on === "view" && st.trigger.once === false)
                        }
                        onScrub={onStageScrub}
                    />
                </div>

                {/* La PALETA DE CLIPS: cada preajuste es un bloque que se ARRASTRA a la línea de
                    tiempo (y se aplica soltándolo donde caiga) — o se aplica con un clic, que es
                    el mismo camino sin ratón. Con cuerpo propio, soltar AÑADE una pista-clip. */}
                <div className="h-9 shrink-0 px-3 flex items-center gap-1.5 border-b border-[var(--ed-outline-variant)] overflow-x-auto custom-scrollbar">
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--ed-on-surface-variant)]">
                        {trStr("Clips", language)}
                    </span>
                    {clips.map((c) => (
                        <button
                            key={c.value}
                            type="button"
                            draggable
                            data-ix-clip={c.value}
                            title={trStr("Arrastra a la línea de tiempo, o pulsa para aplicar", language)}
                            className="inline-flex h-6 shrink-0 cursor-grab items-center rounded-md border border-[var(--ed-outline-variant)] bg-[var(--ed-surface)] px-2 text-[11px] font-normal text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] transition-colors"
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

                {/* Con la piel «stage» cada pieza lleva su color EXACTO de la referencia; la tinta
                    del contenedor solo viste lo neutro (etiquetas de carril en gris #464553). */}
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3 text-[var(--ed-on-surface-variant)]">
                    {st.active && st.tracks.length > 0 ? (
                        <IxTimeline
                            tracks={st.tracks}
                            active={active}
                            timed={isTimed(st.trigger.on)}
                            readOnly={linked}
                            labels={clipLabels}
                            playhead={playhead}
                            skin="stage"
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
    );

    return (
        <div ref={rootRef} className="absolute inset-0 flex flex-col">
            {!twoCol && <DockTabs pane={pane} onPane={setPane} tracks={st.tracks.length} language={language} />}
            <div className={`flex-1 min-h-0 ${twoCol ? "grid grid-cols-[minmax(20rem,23rem)_1fr]" : ""}`}>
                {(twoCol || pane === "settings") && (
                    <div className={twoCol ? "min-h-0 border-r border-[var(--ed-outline-variant)]" : "h-full"}>{inspector}</div>
                )}
                {(twoCol || pane === "timeline") && <div className="h-full min-h-0">{stage}</div>}
            </div>
        </div>
    );
}

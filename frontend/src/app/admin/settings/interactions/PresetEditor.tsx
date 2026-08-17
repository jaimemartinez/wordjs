"use client";
/**
 * Ajustes → Interacciones: EL FORMULARIO DE UN PREAJUSTE (F9-E).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * QUÉ SE REUTILIZA, Y QUÉ NO
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA LÓGICA es la MISMA que la del panel del bloque: cada control llama a los escritores puros de
 * `components/verso/editor/ixPanelModel.ts` (`setTriggerKind`, `addStep`, `setStepProp`…), que ya
 * están probados en node y que normalizan CADA escritura antes de devolverla. Aquí no se decide qué
 * es un paso válido, ni qué rango tiene una propiedad, ni qué pasa al pasarse de pasos: eso ya está
 * decidido en un sitio, y ese sitio no se duplica.
 *
 * EL MARKUP no se reutiliza, y es deliberado: `InteractionsControl` está escrito contra los tokens
 * `--ed-*`, que los declara `components/editor-theme.css` y **solo se cargan en las rutas del
 * editor**. Importarlo aquí traería su `body { … }` a una pantalla de Ajustes para heredar unos
 * colores; renderizarlo sin él dejaría los bordes y los fondos sin resolver. Así que esta pantalla
 * usa los componentes de admin (`Card`, `Button`, `Input`, `Select`) como el resto de Ajustes, y la
 * frontera entre las dos superficies queda donde debe estar: en la piel, no en las reglas.
 *
 * Un preajuste es EXACTAMENTE un cuerpo de interacción con nombre, así que el borrador se edita como
 * un `IxSpec` (`ixPresetToSpec`) y se convierte en preajuste al guardar. Por eso los escritores del
 * panel valen tal cual.
 *
 * PISTAS (P5): un preajuste puede llevar hasta `IX_MAX_TRACKS` pistas sobre el MISMO disparador. La
 * pista ACTIVA es estado local del formulario (elegirla no toca el borrador); todos los controles de
 * pista leen `tracks[activa]` y escriben pasando ese índice al modelo — el espejo exacto del panel
 * del bloque. La LÍNEA DE TIEMPO (P9), sobre la lista, es imagen, navegación y ajuste — un carril
 * por pista; en la activa, marcadores y retardo se arrastran o se mueven con flechas, y un clic sin
 * arrastre lleva el foco a la fila del paso (el gesto de la tira P5) — y nunca el único camino: los
 * campos numéricos siguen debajo.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Input } from "@/components/ui";
import {
    addStep,
    addTrack,
    availableProps,
    effectiveRange,
    ixPanelState,
    rangeEditable,
    removeStep,
    removeTrack,
    resetRange,
    setAlternate,
    setClickToggle,
    setClipDir,
    setDelay,
    setDuration,
    setEventName,
    setEventToggle,
    setLoadDelay,
    setOrigin,
    setPersp,
    setPointerArea,
    setPointerSmooth,
    setRangeEdge,
    setRepeat,
    setScrubSmooth,
    setScrubSrc,
    setStagger,
    setStaggerCols,
    setStaggerFrom,
    setStaggerTotal,
    setStepAt,
    setStepBez,
    setStepEase,
    setStepProp,
    setTargetKind,
    setTrackAxis,
    setTriggerKind,
    setViewOnce,
    usedProps,
    IX_AXIS_LABELS,
    IX_CLIP_DIR_LABELS,
    IX_COLOR_PROPS,
    IX_EASE_LABELS,
    IX_EDGE_LABELS,
    IX_ORIGIN_LABELS,
    IX_PROP_INPUT,
    IX_PROP_LABELS,
    IX_PROP_UNITS,
    IX_STAGGER_FROM_LABELS,
    IX_TARGET_LABELS,
    IX_TRIGGER_LABELS,
    type IxPanelTargetKind,
    type IxPanelTriggerKind,
} from "@/components/verso/editor/ixPanelModel";
// El editor de curvas es agnóstico de tokens (currentColor + opacidades): se monta aquí y en el
// panel del bloque sin arrastrar los `--ed-*` del editor, que es justo la frontera de esta pantalla.
import IxCurveEditor, { ixBezSeed, IX_BEZ_SENTINEL } from "@/components/verso/fields/IxCurveEditor";
// La línea de tiempo multipista (P9) es agnóstica de tokens por la misma razón: mismo componente
// en las dos superficies, y el tono lo pone esta pantalla con su clase de texto.
import IxTimeline from "@/components/verso/fields/IxTimeline";
import {
    compileIx,
    toRuntimeUnit,
    IX_CLIP_DIRS,
    IX_EASINGS,
    IX_EVENT_PREFIX,
    IX_MAX_STEPS,
    IX_MAX_TRACKS,
    IX_MAX_WORDS,
    IX_ORIGINS,
    IX_PERSP_DEFAULT,
    IX_PERSP_MAX,
    IX_PERSP_MIN,
    IX_PRESET_NAME_MAX,
    IX_PROP_NEUTRAL,
    IX_REPEAT_MAX,
    IX_STAGGER_MAX,
    type IxClipDir,
    type IxEase,
    type IxEdgeName,
    type IxOrigin,
    type IxPropKey,
    type IxRuntimeUnit,
    type IxSpec,
    type IxStaggerFrom,
} from "@/lib/verso/interactions";
// Los topes de la rejilla (P4) no están en la superficie del índice: se leen del módulo que los define.
import { IX_STAGGER_COLS_MAX, IX_STAGGER_COLS_MIN } from "@/lib/verso/interactions";
// Los topes del suavizado del puntero (P6), por la misma razón: del módulo que los define.
import {
    IX_POINTER_SMOOTH_DEFAULT,
    IX_POINTER_SMOOTH_MAX,
} from "@/lib/verso/interactions";
// La vista previa (P7) reutiliza el runtime del scrubber del panel —posicionar animaciones WAAPI
// pausadas—: se lee de `runtime/` directamente, igual que el lienzo, porque es DOM y no superficie
// del índice. Es SOLO del editor: ni isla de runtime ni hoja inyectada.
import type { IxDocumentLike, IxElementLike } from "@/lib/verso/interactions/runtime/host";
import {
    createIxScrubber,
    type IxScrubber,
} from "@/lib/verso/interactions/runtime/scrubber";

const TRIGGERS: IxPanelTriggerKind[] = [
    "view",
    "scrub",
    "hover",
    "click",
    "load",
    "pointer",
    "event",
];
const TARGETS: IxPanelTargetKind[] = ["self", "children", "words", "svg"];
const EASES = Object.keys(IX_EASINGS) as IxEase[];
/** Órdenes del escalonado (P4), en el orden canónico de sus etiquetas. */
const STAGGER_FROMS = Object.keys(IX_STAGGER_FROM_LABELS) as IxStaggerFrom[];
/** Ejes del cursor (P6), en el orden canónico de sus etiquetas. */
const AXES = Object.keys(IX_AXIS_LABELS) as Array<"x" | "y">;
/** Aristas de `animation-range`, en el orden en que se cruzan al hacer scroll. */
const EDGES: IxEdgeName[] = ["cover", "entry", "contain", "exit"];

/** Propiedades gobernadas por `transform-origin`: giros, escalas y sesgos. */
const ORIGIN_PROPS: readonly IxPropKey[] = [
    "scale",
    "scaleX",
    "scaleY",
    "rotate",
    "rotateX",
    "rotateY",
    "skewX",
    "skewY",
];
/** Propiedades que necesitan una perspectiva: los efectos 3D. */
const PERSP_PROPS: readonly IxPropKey[] = ["rotateX", "rotateY", "z"];

/** Entero 0xRRGGBB → el `#rrggbb` que habla `<input type="color">`. */
const intToHex = (v: number): string => `#${v.toString(16).padStart(6, "0")}`;
/** "#rrggbb" → entero 0xRRGGBB (lo ÚNICO que el documento guarda; la cadena muere en el control). */
const hexToInt = (hex: string): number => parseInt(hex.slice(1), 16);

const LABEL = "block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5";
const NUM =
    "w-full rounded-xl border-2 border-gray-100 bg-gray-50/50 px-3 py-2 text-sm text-gray-900 focus:border-blue-400 focus:outline-none";
/** El swatch nativo de las propiedades de color, con el mismo marco que los inputs numéricos. */
const COLOR =
    "h-10 w-full cursor-pointer rounded-xl border-2 border-gray-100 bg-gray-50/50 p-1 focus:border-blue-400 focus:outline-none";

/**
 * Los desplegables son `<select>` NATIVOS y no el `Select` de `@/components/ui`.
 *
 * Aquel es un botón con una lista portaleada: no acepta un `id`, así que un `<label for>` no tiene a
 * qué apuntar y el control se queda SIN NOMBRE ACCESIBLE — un lector de pantalla anuncia «Al entrar
 * en pantalla, botón» y no dice de qué. Se vio en el navegador (todas las etiquetas de los
 * desplegables apuntaban a ids inexistentes). Un `<select>` nativo se etiqueta, se navega con el
 * teclado y anuncia su valor sin que nadie tenga que acordarse.
 */
const SEL = `${NUM} appearance-none pr-8`;

interface FieldSelectProps {
    id: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
}

function FieldSelect({ id, label, value, options, onChange }: FieldSelectProps) {
    return (
        <div>
            <label className={LABEL} htmlFor={id}>
                {label}
            </label>
            <select id={id} className={SEL} value={value} onChange={(e) => onChange(e.target.value)}>
                {options.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        </div>
    );
}

export interface PresetEditorProps {
    /** El cuerpo en edición, como `IxSpec`. */
    draft: IxSpec;
    name: string;
    /** `null` en un alta; el id inmutable en una edición. */
    id: string | null;
    error: string | null;
    saving: boolean;
    onName: (name: string) => void;
    onDraft: (next: IxSpec) => void;
    onSave: () => void;
    onCancel: () => void;
}

export default function PresetEditor({
    draft,
    name,
    id,
    error,
    saving,
    onName,
    onDraft,
    onSave,
    onCancel,
}: PresetEditorProps) {
    // El estado del panel se deriva del borrador con la MISMA función que usa el editor de bloques,
    // así que el resumen, los avisos y los topes son idénticos en las dos pantallas.
    const state = ixPanelState(draft);
    // Pista ACTIVA (P5): estado LOCAL del formulario — elegir pista no toca el borrador. La
    // selección lleva el `id` del preajuste al que pertenece, así que pasar a editar OTRO la
    // invalida por derivación pura (este componente no se remonta entre ediciones), sin efectos ni
    // renders extra; y el clamp devuelve a la 0 si el recuento encoge por debajo del índice.
    const [sel, setSel] = useState<{ id: string | null; track: number }>({ id, track: 0 });
    const setTrackSel = (track: number): void => setSel({ id, track });
    const active = sel.id === id && sel.track < state.tracks.length ? sel.track : 0;
    const track = state.tracks[active];
    // Filas de la lista de pasos, por índice: la LÍNEA DE TIEMPO las enfoca desde sus marcadores.
    const stepRowRefs = useRef<Array<HTMLLIElement | null>>([]);
    const focusStepRow = (i: number): void => {
        const row = stepRowRefs.current[i];
        if (!row) return;
        row.scrollIntoView({ block: "nearest" });
        // El primer control operable de la fila (en este formulario nada está en solo lectura).
        row.querySelector<HTMLElement>("input:enabled, select:enabled, button:enabled")?.focus();
    };
    const trigger = state.trigger;
    // Progreso marcado por el RELOJ: ni `scrub` (posición del scroll) ni `pointer` (posición del
    // cursor) lo son — ahí duración, retardo y reproducción no significan nada y no se ofrecen.
    const timed = trigger.on !== "scrub" && trigger.on !== "pointer";
    // Derivados del disparador para el editor de tramo — misma lógica que el panel del bloque.
    const range = rangeEditable(trigger) ? effectiveRange(trigger) : null;
    const pageScrub = trigger.on === "scrub" && trigger.src === "page";
    const hasOwnRange = (trigger.on === "scrub" || trigger.on === "view") && trigger.range != null;
    const infinite = track?.repeat === "inf";
    const repeatCount = track && typeof track.repeat === "number" ? track.repeat : 1;
    // Unión de propiedades usadas por los pasos de la pista: cada OPCIÓN DE PISTA se ofrece solo
    // cuando algún paso usa una propiedad a la que afecta — un selector de perspectiva sin nada 3D
    // no movería nada. Misma regla que el panel del bloque.
    const trackProps = new Set<IxPropKey>();
    for (const s of track?.steps ?? []) for (const k of usedProps(s)) trackProps.add(k);
    const showClipDir = trackProps.has("clip");
    const showOrigin = ORIGIN_PROPS.some((k) => trackProps.has(k));
    const showPersp = PERSP_PROPS.some((k) => trackProps.has(k));

    /** Cada escritura devuelve un valor NUEVO ya normalizado; `undefined` (nada animable) se ignora. */
    const write = (next: IxSpec | undefined) => {
        if (next) onDraft(next);
    };

    /* ── Vista previa (P7) — el borrador compilado por el compilador REAL, sobre una caja de
       muestra. No es una imitación interpolada a mano: son los MISMOS fotogramas que emitiría la
       hoja, la misma razón por la que el scrubber del panel mueve el estado real. ────────────── */
    // `null` = el cuerpo no anima nada todavía: los mandos se deshabilitan, nunca fallan.
    const previewUnit = useMemo(() => compileIx(draft), [draft]);
    const previewRef = useRef<HTMLDivElement | null>(null);
    // La animación de «Probar» y el scrubber del deslizador, para retirarlos antes de reemplazarlos.
    const previewAnim = useRef<Animation | null>(null);
    const previewScrub = useRef<IxScrubber | null>(null);
    const [previewPct, setPreviewPct] = useState(0);

    const stopPreview = useCallback(() => {
        // `cancel()` devuelve la caja a su estilo de hoja: nunca se queda congelada a medio camino.
        previewAnim.current?.cancel();
        previewAnim.current = null;
        previewScrub.current?.stop();
        previewScrub.current = null;
    }, []);

    // Cada edición recompila: lo que estuviera sonando salió de un cuerpo VIEJO y la limpieza lo
    // retira (también al desmontar). El siguiente gesto —«Probar» o mover el deslizador— rearma.
    useEffect(() => {
        if (!previewUnit) stopPreview(); // el cuerpo dejó de animar: no hay nada que dejar puesto
        return stopPreview;
    }, [previewUnit, stopPreview]);

    /** Reproduce la PISTA 0 del borrador compilado sobre la caja (disparadores del RELOJ). */
    const playPreview = (): void => {
        const el = previewRef.current;
        if (!el || !previewUnit) return;
        stopPreview();
        // La caja es UN elemento: la pista 0 se reproduce sobre ella misma, sin resolver hijos ni
        // palabras — es una vista previa del MOVIMIENTO, no del DOM del bloque que lo reciba.
        const first = toRuntimeUnit(previewUnit).tracks[0];
        if (!first) return;
        try {
            previewAnim.current = el.animate(first.kf, {
                duration: first.dur,
                delay: first.delay,
                // `linear`: la curva de cada tramo ya viaja DENTRO de los fotogramas, igual que el
                // compilador la emite dentro de los `@keyframes`. Una curva aquí se multiplicaría.
                easing: "linear",
                fill: "both",
            });
        } catch {
            // Sin WAAPI o fotogramas que este motor no acepta: la peor vista previa es no verla.
        }
    };

    /** Coloca la vista previa en el `pct` del recorrido (disparadores SIN reloj: scrub y pointer). */
    const scrubPreview = (pct: number): void => {
        setPreviewPct(pct);
        const el = previewRef.current;
        if (!el || !previewUnit) return;
        if (!previewScrub.current) {
            const unit = toRuntimeUnit(previewUnit);
            // Cada pista se recorre sobre la PROPIA caja: aquí no hay hijos ni palabras que
            // resolver, y una pista de `children` sobre una caja sin hijos no enseñaría nada.
            const sample: IxRuntimeUnit = {
                ...unit,
                tracks: unit.tracks.map((t) => ({ ...t, target: { kind: "self" } })),
            };
            // Los casts son los MISMOS que hace `defaultIxHost` (ver IxCanvasEngine): las
            // interfaces `*Like` del runtime son un subconjunto estructural de las del DOM que
            // TypeScript no comprueba sin fricción a través de `NodeListOf`/`CSSNumberish`.
            previewScrub.current = createIxScrubber(
                el as unknown as IxElementLike,
                sample,
                document as unknown as IxDocumentLike,
            );
        }
        previewScrub.current?.set(pct);
    };

    if (!track) {
        return (
            <Card>
                <p className="text-sm text-gray-500">
                    Este preajuste se ha quedado sin pistas. Cancela y empieza de nuevo.
                </p>
                <Button variant="ghost" onClick={onCancel} className="mt-4">
                    Cancelar
                </Button>
            </Card>
        );
    }

    return (
        <Card overflow="visible">
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    onSave();
                }}
                aria-label={id ? `Editar el preajuste ${name}` : "Nuevo preajuste"}
            >
                <div className="flex items-start justify-between gap-4 mb-6">
                    <div className="min-w-0 flex-1">
                        <Input
                            label="Nombre del preajuste"
                            value={name}
                            maxLength={IX_PRESET_NAME_MAX}
                            placeholder="Aparecer tarjetas"
                            onChange={(e) => onName(e.target.value)}
                        />
                        {id && (
                            <p className="mt-1 text-xs text-gray-400">
                                Identificador: <code className="font-mono">{id}</code> — no cambia
                                aunque cambies el nombre, porque es lo que guardan los bloques.
                            </p>
                        )}
                    </div>
                </div>

                {error && (
                    <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
                        {error}
                    </p>
                )}

                {/* ── Vista previa (P7) — con un disparador del RELOJ, «Probar» reproduce; con
                    scrub o pointer no hay nada que reproducir —el progreso lo marca la posición—
                    y el deslizador POSICIONA una animación pausada, la técnica del scrubber. */}
                <fieldset className="mb-6 rounded-2xl border-2 border-gray-100 p-4">
                    <legend className="px-1 text-sm font-bold text-gray-900">Vista previa</legend>
                    <div className="mt-2 overflow-hidden rounded-xl bg-gray-50/50 p-6">
                        <div
                            ref={previewRef}
                            className="flex h-24 w-full items-center justify-center rounded-xl border-2 border-gray-200 bg-white text-sm font-medium text-gray-600"
                        >
                            Vista previa
                        </div>
                    </div>
                    {timed ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-4"
                            disabled={!previewUnit}
                            aria-label="Probar el preajuste sobre la caja de muestra"
                            onClick={playPreview}
                        >
                            Probar
                        </Button>
                    ) : (
                        <div className="mt-4">
                            <label className={LABEL} htmlFor="ixp-preview-pct">
                                Recorrido de la vista previa ({previewPct} %)
                            </label>
                            <input
                                id="ixp-preview-pct"
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={previewPct}
                                disabled={!previewUnit}
                                // El deslizador nativo ya anuncia su valor; esto le pone la unidad.
                                aria-valuetext={`${previewPct} %`}
                                className="w-full accent-blue-600"
                                onChange={(e) => scrubPreview(Number(e.target.value))}
                            />
                            <p className="mt-1 text-xs text-gray-500">
                                {trigger.on === "pointer"
                                    ? "El cursor posiciona este preajuste: recórrelo a mano para ver los pasos intermedios."
                                    : "Este preajuste avanza con el scroll: recórrelo a mano para ver los pasos intermedios."}
                            </p>
                        </div>
                    )}
                    {!previewUnit && (
                        <p className="mt-2 text-xs text-gray-500">
                            Aún no anima nada: añade alguna propiedad a sus pasos.
                        </p>
                    )}
                </fieldset>

                {/* ── Pistas (P5) — hasta IX_MAX_TRACKS cuerpos independientes sobre el MISMO
                    disparador. Todo lo de abajo (objetivo, escalonado, tiempos, reproducción,
                    opciones y pasos) lee y escribe SOLO la pista activa. */}
                <fieldset className="mb-6">
                    <legend className={LABEL}>Pistas</legend>
                    <div className="flex flex-wrap items-center gap-3">
                        {state.tracks.length > 1 && (
                            <div
                                role="radiogroup"
                                aria-label="Pista activa"
                                className="flex rounded-xl border-2 border-gray-100 p-0.5"
                            >
                                {state.tracks.map((_, i) => (
                                    <label
                                        key={i}
                                        className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm ${
                                            active === i
                                                ? "bg-blue-600 font-medium text-white"
                                                : "text-gray-700 hover:bg-gray-50"
                                        }`}
                                    >
                                        <input
                                            type="radio"
                                            name="ixp-track"
                                            className="sr-only"
                                            checked={active === i}
                                            onChange={() => setTrackSel(i)}
                                        />
                                        Pista {i + 1}
                                    </label>
                                ))}
                            </div>
                        )}
                        {state.tracks.length < IX_MAX_TRACKS && (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                title="Añadir una pista nueva (nace neutra: no mueve nada hasta que la edites)"
                                onClick={() => {
                                    write(addTrack(draft));
                                    // La nueva queda seleccionada: su índice es el recuento ANTES de añadir.
                                    setTrackSel(state.tracks.length);
                                }}
                            >
                                + Añadir pista
                            </Button>
                        )}
                        {state.tracks.length > 1 && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={`Quitar la pista ${active + 1}`}
                                onClick={() => {
                                    write(removeTrack(draft, active));
                                    setTrackSel(0);
                                }}
                            >
                                Quitar pista
                            </Button>
                        )}
                    </div>
                </fieldset>

                {/* Disparador y objetivo */}
                <div className="grid gap-4 md:grid-cols-2">
                    <FieldSelect
                        id="ixp-trigger"
                        label="Cuándo"
                        value={trigger.on}
                        onChange={(v) => write(setTriggerKind(draft, v as IxPanelTriggerKind))}
                        options={TRIGGERS.map((on) => ({ value: on, label: IX_TRIGGER_LABELS[on] }))}
                    />
                    <FieldSelect
                        id="ixp-target"
                        label="Qué se mueve"
                        value={track.target.kind}
                        onChange={(v) => write(setTargetKind(draft, v as IxPanelTargetKind, undefined, active))}
                        options={TARGETS.map((k) => ({ value: k, label: IX_TARGET_LABELS[k] }))}
                    />

                    {trigger.on === "view" && (
                        <FieldSelect
                            id="ixp-once"
                            label="Repetición"
                            value={trigger.once === false ? "each" : "once"}
                            onChange={(v) => write(setViewOnce(draft, v === "once"))}
                            options={[
                                { value: "once", label: "Una vez (necesita el runtime mínimo)" },
                                { value: "each", label: "Cada vez (CSS puro, va y viene)" },
                            ]}
                        />
                    )}

                    {trigger.on === "click" && (
                        <FieldSelect
                            id="ixp-click-toggle"
                            label="Al segundo clic"
                            value={trigger.toggle === true ? "undo" : "stay"}
                            onChange={(v) => write(setClickToggle(draft, v === "undo"))}
                            options={[
                                { value: "stay", label: "Se queda" },
                                { value: "undo", label: "Se deshace" },
                            ]}
                        />
                    )}

                    {trigger.on === "load" && (
                        <div>
                            <label className={LABEL} htmlFor="ixp-load-delay">
                                Retardo del disparador (ms)
                            </label>
                            <input
                                id="ixp-load-delay"
                                type="number"
                                className={NUM}
                                min={0}
                                max={3000}
                                step={50}
                                value={trigger.delay ?? 0}
                                onChange={(e) => write(setLoadDelay(draft, Number(e.target.value)))}
                            />
                        </div>
                    )}

                    {trigger.on === "scrub" && (
                        <>
                            <FieldSelect
                                id="ixp-scrub-src"
                                label="Qué scroll manda"
                                value={trigger.src === "page" ? "page" : "self"}
                                onChange={(v) => write(setScrubSrc(draft, v === "page" ? "page" : "self"))}
                                options={[
                                    { value: "self", label: "El recorrido del bloque" },
                                    { value: "page", label: "El scroll de la página" },
                                ]}
                            />
                            {/* Suavizado del scroll (P10) — opt-in: sin él, exactitud nativa 1:1. */}
                            <div>
                                <label className={LABEL} htmlFor="ixp-scrub-smooth">
                                    Suavizado (ms)
                                </label>
                                <input
                                    id="ixp-scrub-smooth"
                                    type="number"
                                    className={NUM}
                                    min={0}
                                    max={IX_POINTER_SMOOTH_MAX}
                                    step={10}
                                    value={trigger.smooth ?? 0}
                                    onChange={(e) => write(setScrubSmooth(draft, Number(e.target.value)))}
                                />
                                <p className="mt-1 text-xs text-gray-500">
                                    0 = sin suavizado (exactitud nativa 1:1). Con suavizado el
                                    progreso lo persigue el runtime mínimo en JavaScript: se
                                    renuncia al camino puro de CSS en el compositor.
                                </p>
                            </div>
                        </>
                    )}

                    {/* `event` (P11): la escotilla para plugins y código propio — el runtime
                        escucha el evento en el documento y arma o conmuta el estado. */}
                    {trigger.on === "event" && (
                        <>
                            <div>
                                <label className={LABEL} htmlFor="ixp-event-name">
                                    Nombre del evento
                                </label>
                                <input
                                    id="ixp-event-name"
                                    type="text"
                                    className={NUM}
                                    value={trigger.name}
                                    onChange={(e) => write(setEventName(draft, e.target.value))}
                                />
                                <p className="mt-1 text-xs text-gray-500">
                                    El evento real del DOM es <code>{IX_EVENT_PREFIX}&lt;nombre&gt;</code>.
                                    El nombre es un slug: minúsculas, números y guiones — con uno
                                    inválido se conserva el último válido.
                                </p>
                            </div>
                            <label className="flex cursor-pointer select-none items-center gap-2 self-center text-sm text-gray-700">
                                <input
                                    type="checkbox"
                                    checked={trigger.toggle === true}
                                    onChange={(e) => write(setEventToggle(draft, e.target.checked))}
                                />
                                Cada evento alterna (entra/sale)
                            </label>
                        </>
                    )}

                    {/* `pointer` (P6): el cursor POSICIONA la animación, no la dispara. Área y
                        suavizado viven en el disparador; el eje es de CADA pista (dos pistas, una
                        por eje, componen el 2D). */}
                    {trigger.on === "pointer" && (
                        <>
                            <FieldSelect
                                id="ixp-pointer-area"
                                label="Qué área sigue el cursor"
                                value={trigger.area === "page" ? "page" : "self"}
                                onChange={(v) =>
                                    write(setPointerArea(draft, v === "page" ? "page" : "self"))
                                }
                                options={[
                                    { value: "self", label: "El propio bloque" },
                                    { value: "page", label: "Toda la página" },
                                ]}
                            />
                            <div>
                                <label className={LABEL} htmlFor="ixp-pointer-smooth">
                                    Suavizado (ms)
                                </label>
                                <input
                                    id="ixp-pointer-smooth"
                                    type="number"
                                    className={NUM}
                                    min={0}
                                    max={IX_POINTER_SMOOTH_MAX}
                                    step={10}
                                    value={trigger.smooth ?? IX_POINTER_SMOOTH_DEFAULT}
                                    onChange={(e) =>
                                        write(setPointerSmooth(draft, Number(e.target.value)))
                                    }
                                />
                                <p className="mt-1 text-xs text-gray-500">
                                    0 = sigue al cursor sin retraso.
                                </p>
                            </div>
                            <div>
                                <FieldSelect
                                    id="ixp-axis"
                                    label="Eje del cursor"
                                    value={track.axis ?? "x"}
                                    onChange={(v) =>
                                        write(setTrackAxis(draft, v === "y" ? "y" : "x", undefined, active))
                                    }
                                    options={AXES.map((a) => ({
                                        value: a,
                                        label: IX_AXIS_LABELS[a],
                                    }))}
                                />
                                <p className="mt-1 text-xs text-gray-500">
                                    Dos pistas, una por eje, componen el efecto 2D (tilt/parallax).
                                </p>
                            </div>
                        </>
                    )}

                    {/* El escalonado es un reparto de RETARDOS, y con `pointer` no hay reloj que
                        retrasar: el compilador lo ignora con aviso, así que no se ofrece. */}
                    {trigger.on !== "pointer" &&
                        (track.target.kind === "children" || track.target.kind === "words") && (
                        <div>
                            <label className={LABEL} htmlFor="ixp-stagger">
                                {/* Con `total` los ms dejan de ser "entre hermanos" y pasan a ser el
                                    tiempo del primero al último: la etiqueta dice lo que significa. */}
                                {track.stagger?.total === true
                                    ? "Tiempo total (ms)"
                                    : "Escalonado entre hermanos (ms)"}
                            </label>
                            <input
                                id="ixp-stagger"
                                type="number"
                                className={NUM}
                                min={0}
                                max={IX_STAGGER_MAX}
                                step={10}
                                value={track.stagger?.each ?? 0}
                                onChange={(e) =>
                                    write(setStagger(draft, Number(e.target.value), undefined, active))
                                }
                            />
                        </div>
                    )}

                    {timed && (
                        <>
                            <div>
                                <label className={LABEL} htmlFor="ixp-dur">
                                    Duración (ms)
                                </label>
                                <input
                                    id="ixp-dur"
                                    type="number"
                                    className={NUM}
                                    min={100}
                                    max={3000}
                                    step={50}
                                    value={track.dur ?? 600}
                                    onChange={(e) =>
                                        write(setDuration(draft, Number(e.target.value), undefined, active))
                                    }
                                />
                            </div>
                            <div>
                                <label className={LABEL} htmlFor="ixp-delay">
                                    Retardo (ms)
                                </label>
                                <input
                                    id="ixp-delay"
                                    type="number"
                                    className={NUM}
                                    min={0}
                                    max={3000}
                                    step={50}
                                    value={track.delay ?? 0}
                                    onChange={(e) =>
                                        write(setDelay(draft, Number(e.target.value), undefined, active))
                                    }
                                />
                            </div>
                        </>
                    )}
                </div>

                {track.target.kind === "words" && (
                    <p className="mt-3 text-xs text-gray-500">
                        «Las palabras» solo mueve algo en los bloques que saben partir su texto
                        (Título y Cita). No se parte si el texto lleva formato o si pasa de{" "}
                        {IX_MAX_WORDS} palabras: entonces se ve igual que siempre, sin movimiento.
                        En cualquier otro bloque este objetivo no mueve nada.
                    </p>
                )}

                {/* Honestidad (P12): el trazo SVG exige el contrato del MARKUP del bloque. */}
                {track.target.kind === "svg" && (
                    <p className="mt-3 text-xs text-gray-500">
                        «El trazo SVG» mueve el trazo de los SVG del bloque marcados con la clase
                        wjs-ixd y pathLength=&quot;1&quot; (bloques propios o de plugins). Si el
                        bloque no tiene ninguno, no se anima nada.
                    </p>
                )}

                {trigger.on === "pointer" && (
                    <p role="note" className="mt-3 text-xs text-gray-500">
                        El puntero posiciona la animación (el paso 50 es el reposo). Inerte con
                        reduced-motion y en pantallas táctiles.
                    </p>
                )}

                {/* Opciones del escalonado (P4) — solo cuando HAY escalonado: sin él cada escritor
                    es un no-op y el control mentiría. Con rejilla (`cols`) la onda avanza en
                    diagonal e ignora el orden lineal, así que el selector de orden se retira. Con
                    `pointer` no se ofrece nada de esto (no hay reloj que repartir). */}
                {trigger.on !== "pointer" &&
                    (track.target.kind === "children" || track.target.kind === "words") &&
                    track.stagger && (
                        <fieldset className="mt-6 rounded-2xl border-2 border-gray-100 p-4">
                            <legend className="px-1 text-sm font-bold text-gray-900">
                                Escalonado
                            </legend>
                            <div className="mt-2 flex flex-wrap items-end gap-4">
                                {track.stagger.cols == null && (
                                    <div className="w-56">
                                        <FieldSelect
                                            id="ixp-stagger-from"
                                            label="Orden"
                                            value={track.stagger.from ?? "start"}
                                            onChange={(v) =>
                                                write(setStaggerFrom(draft, v as IxStaggerFrom, undefined, active))
                                            }
                                            options={STAGGER_FROMS.map((f) => ({
                                                value: f,
                                                label: IX_STAGGER_FROM_LABELS[f],
                                            }))}
                                        />
                                    </div>
                                )}
                                <label className="mb-2.5 flex cursor-pointer select-none items-center gap-2 text-sm text-gray-700">
                                    <input
                                        type="checkbox"
                                        checked={track.stagger.total === true}
                                        onChange={(e) =>
                                            write(setStaggerTotal(draft, e.target.checked, undefined, active))
                                        }
                                    />
                                    Repartir como tiempo total
                                </label>
                                <label className="mb-2.5 flex cursor-pointer select-none items-center gap-2 text-sm text-gray-700">
                                    <input
                                        type="checkbox"
                                        checked={track.stagger.cols != null}
                                        onChange={(e) =>
                                            write(
                                                setStaggerCols(
                                                    draft,
                                                    e.target.checked ? IX_STAGGER_COLS_MIN : null,
                                                    undefined,
                                                    active,
                                                ),
                                            )
                                        }
                                    />
                                    En rejilla
                                </label>
                                {track.stagger.cols != null && (
                                    <div className="w-36">
                                        <label className={LABEL} htmlFor="ixp-stagger-cols">
                                            Columnas
                                        </label>
                                        <input
                                            id="ixp-stagger-cols"
                                            type="number"
                                            className={NUM}
                                            min={IX_STAGGER_COLS_MIN}
                                            max={IX_STAGGER_COLS_MAX}
                                            step={1}
                                            value={track.stagger.cols}
                                            onChange={(e) =>
                                                write(setStaggerCols(draft, Number(e.target.value), undefined, active))
                                            }
                                        />
                                    </div>
                                )}
                            </div>
                        </fieldset>
                    )}

                {/* Tramo del recorrido: solo cuando el progreso lo marca el scroll (scrub, o view
                    que entra y sale). Con el scroll de la página las ARISTAS no significan nada —el
                    compilador emite solo porcentajes ahí—, así que se ofrecen únicamente los dos %. */}
                {range && (
                    <fieldset className="mt-6 rounded-2xl border-2 border-gray-100 p-4">
                        <legend className="px-1 text-sm font-bold text-gray-900">
                            Tramo del recorrido
                        </legend>
                        <div className="mt-2 grid gap-4 md:grid-cols-2">
                            {(["from", "to"] as const).map((which) => (
                                <div key={which} className="flex items-end gap-3">
                                    {!pageScrub && (
                                        <div className="min-w-0 flex-1">
                                            <FieldSelect
                                                id={`ixp-range-${which}-at`}
                                                label={which === "from" ? "Desde" : "Hasta"}
                                                value={range[which].at}
                                                onChange={(v) =>
                                                    write(setRangeEdge(draft, which, { at: v as IxEdgeName }))
                                                }
                                                options={EDGES.map((e) => ({
                                                    value: e,
                                                    label: IX_EDGE_LABELS[e],
                                                }))}
                                            />
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <label className={LABEL} htmlFor={`ixp-range-${which}-pct`}>
                                            {which === "from" ? "Desde (%)" : "Hasta (%)"}
                                        </label>
                                        <input
                                            id={`ixp-range-${which}-pct`}
                                            type="number"
                                            className={NUM}
                                            min={0}
                                            max={100}
                                            step={5}
                                            value={range[which].pct}
                                            onChange={(e) =>
                                                write(setRangeEdge(draft, which, { pct: Number(e.target.value) }))
                                            }
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                        {hasOwnRange && (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="mt-4"
                                onClick={() => write(resetRange(draft))}
                            >
                                Restablecer tramo
                            </Button>
                        )}
                    </fieldset>
                )}

                {/* Reproducción de la pista — solo con disparadores del RELOJ: con scrub o pointer
                    el progreso lo marca la posición, y «repetir» no significa nada. Con «Infinita»
                    marcada el número queda en blanco y bloqueado; desmarcarla vuelve a 1 (que borra
                    la clave). */}
                {timed && (
                    <fieldset className="mt-6 rounded-2xl border-2 border-gray-100 p-4">
                        <legend className="px-1 text-sm font-bold text-gray-900">Reproducción</legend>
                        <div className="mt-2 flex flex-wrap items-end gap-4">
                            <div className="w-36">
                                <label className={LABEL} htmlFor="ixp-repeat">
                                    Repetición
                                </label>
                                <input
                                    id="ixp-repeat"
                                    type="number"
                                    className={NUM}
                                    min={1}
                                    max={IX_REPEAT_MAX}
                                    step={1}
                                    value={infinite ? "" : repeatCount}
                                    disabled={infinite}
                                    onChange={(e) =>
                                        write(setRepeat(draft, Number(e.target.value), undefined, active))
                                    }
                                />
                            </div>
                            <label className="mb-2.5 flex cursor-pointer select-none items-center gap-2 text-sm text-gray-700">
                                <input
                                    type="checkbox"
                                    checked={infinite}
                                    onChange={(e) =>
                                        write(setRepeat(draft, e.target.checked ? "inf" : 1, undefined, active))
                                    }
                                />
                                Infinita
                            </label>
                            <label className="mb-2.5 flex cursor-pointer select-none items-center gap-2 text-sm text-gray-700">
                                <input
                                    type="checkbox"
                                    checked={track.alt === true}
                                    onChange={(e) =>
                                        write(setAlternate(draft, e.target.checked, undefined, active))
                                    }
                                />
                                Ida y vuelta
                            </label>
                        </div>
                    </fieldset>
                )}

                {/* Opciones de pista (P3): cada control aparece solo cuando algún paso usa una
                    propiedad a la que afecta — un selector de perspectiva sin nada 3D no movería
                    nada. */}
                {(showClipDir || showOrigin || showPersp) && (
                    <div className="mt-6 grid gap-4 md:grid-cols-2">
                        {showClipDir && (
                            <FieldSelect
                                id="ixp-clip-dir"
                                label="Revelado"
                                value={track.clipDir ?? "right"}
                                onChange={(v) => write(setClipDir(draft, v as IxClipDir, undefined, active))}
                                options={IX_CLIP_DIRS.map((d) => ({
                                    value: d,
                                    label: IX_CLIP_DIR_LABELS[d],
                                }))}
                            />
                        )}
                        {showOrigin && (
                            <FieldSelect
                                id="ixp-origin"
                                label="Origen del giro y la escala"
                                value={track.origin ?? "center"}
                                onChange={(v) => write(setOrigin(draft, v as IxOrigin, undefined, active))}
                                options={IX_ORIGINS.map((o) => ({
                                    value: o,
                                    label: IX_ORIGIN_LABELS[o],
                                }))}
                            />
                        )}
                        {showPersp && (
                            <div>
                                <label className={LABEL} htmlFor="ixp-persp">
                                    Perspectiva 3D (px)
                                </label>
                                <input
                                    id="ixp-persp"
                                    type="number"
                                    className={NUM}
                                    min={IX_PERSP_MIN}
                                    max={IX_PERSP_MAX}
                                    step={50}
                                    value={track.persp ?? IX_PERSP_DEFAULT}
                                    onChange={(e) =>
                                        write(setPersp(draft, Number(e.target.value), undefined, active))
                                    }
                                />
                            </div>
                        )}
                    </div>
                )}

                {/* Pasos */}
                <fieldset className="mt-8 border-t border-gray-100 pt-6">
                    <legend className="text-sm font-bold text-gray-900">
                        Pasos ({track.steps.length})
                        {state.tracks.length > 1 ? ` — pista ${active + 1}` : ""}
                    </legend>
                    {/* La LÍNEA DE TIEMPO (P9): un carril por pista sobre una escala compartida
                        (ms con reloj; 0–100 % con scrub/pointer). En la pista activa, marcadores
                        intermedios y retardo se ARRASTRAN (o se mueven con flechas); un clic sin
                        arrastre conserva el gesto de la tira P5 — llevar el foco a la fila del
                        paso. Nunca el único camino: los campos numéricos de abajo son el canónico.
                        El componente es agnóstico de tokens (`currentColor`): el tono lo pone esta
                        pantalla con su clase de texto. */}
                    <div className="mt-4 text-gray-600">
                        <IxTimeline
                            tracks={state.tracks}
                            active={active}
                            timed={timed}
                            onStepAt={(t, i, at) => write(setStepAt(draft, i, at, undefined, t))}
                            onDelay={(t, ms) => write(setDelay(draft, ms, undefined, t))}
                            onDur={(t, ms) => write(setDuration(draft, ms, undefined, t))}
                            onSelectTrack={setTrackSel}
                            onFocusStep={(t, i) => focusStepRow(i)}
                        />
                    </div>
                    <ol className="mt-4 space-y-4">
                        {track.steps.map((step, i) => {
                            const isFirst = i === 0;
                            const isLast = i === track.steps.length - 1;
                            const free = availableProps(step);
                            const used = usedProps(step);
                            return (
                                <li
                                    key={i}
                                    ref={(el) => {
                                        stepRowRefs.current[i] = el;
                                    }}
                                    className="rounded-2xl border-2 border-gray-100 p-4"
                                >
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <span className="text-sm font-bold text-gray-900">
                                            {isFirst ? "Inicio (0 %)" : isLast ? "Final (100 %)" : `Paso ${i + 1}`}
                                        </span>
                                        {!isFirst && !isLast && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                aria-label={`Quitar el paso ${i + 1}`}
                                                onClick={() => write(removeStep(draft, i, undefined, active))}
                                            >
                                                Quitar paso
                                            </Button>
                                        )}
                                    </div>

                                    <div className="grid gap-3 md:grid-cols-2">
                                        {/* Los extremos los reancla el normalizador a 0 y 100: mostrar un control
                                            que el dato va a ignorar sería mentirle al autor. */}
                                        {!isFirst && !isLast && (
                                            <div>
                                                <label className={LABEL} htmlFor={`ixp-at-${i}`}>
                                                    Momento (%)
                                                </label>
                                                <input
                                                    id={`ixp-at-${i}`}
                                                    type="number"
                                                    className={NUM}
                                                    min={1}
                                                    max={99}
                                                    step={1}
                                                    value={step.at}
                                                    onChange={(e) =>
                                                        write(setStepAt(draft, i, Number(e.target.value), undefined, active))
                                                    }
                                                />
                                            </div>
                                        )}
                                        {/* «Curva propia…» es un sentinel de UI, no un IxEase: elegirlo siembra
                                            un `bez` con el equivalente de la curva puesta; volver a un nombre
                                            pasa por `setStepEase`, que retira el bez. */}
                                        {!isLast && (
                                            <FieldSelect
                                                id={`ixp-ease-${i}`}
                                                label="Curva hasta el siguiente"
                                                value={step.bez ? IX_BEZ_SENTINEL : (step.ease ?? "out")}
                                                onChange={(v) =>
                                                    v === IX_BEZ_SENTINEL
                                                        ? write(setStepBez(draft, i, ixBezSeed(step.ease), undefined, active))
                                                        : write(setStepEase(draft, i, v as IxEase, undefined, active))
                                                }
                                                options={[
                                                    ...EASES.map((e) => ({ value: e as string, label: IX_EASE_LABELS[e] })),
                                                    { value: IX_BEZ_SENTINEL, label: "Curva propia…" },
                                                ]}
                                            />
                                        )}
                                    </div>

                                    {/* El dibujo edita el MISMO valor que sembró el selector; cada arrastre
                                        pasa por el mismo escritor puro que el resto del formulario. */}
                                    {!isLast && step.bez && (
                                        <div className="mt-3">
                                            <IxCurveEditor
                                                id={`ixp-bez-${i}`}
                                                value={step.bez}
                                                onChange={(bez) =>
                                                    write(setStepBez(draft, i, bez, undefined, active))
                                                }
                                            />
                                        </div>
                                    )}

                                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                                        {used.map((key) => (
                                            <div key={key} className="flex items-end gap-2">
                                                <div className="min-w-0 flex-1">
                                                    <label className={LABEL} htmlFor={`ixp-${i}-${key}`}>
                                                        {IX_PROP_LABELS[key]}
                                                        {IX_PROP_UNITS[key] ? ` (${IX_PROP_UNITS[key]})` : ""}
                                                    </label>
                                                    {IX_COLOR_PROPS.has(key) ? (
                                                        /* El DATO sigue siendo el entero 0xRRGGBB: la conversión
                                                           hex↔entero vive en el control, nunca en el documento. */
                                                        <input
                                                            id={`ixp-${i}-${key}`}
                                                            type="color"
                                                            className={COLOR}
                                                            value={intToHex(step.set[key] ?? IX_PROP_NEUTRAL[key])}
                                                            onChange={(e) =>
                                                                write(
                                                                    setStepProp(draft, i, key, hexToInt(e.target.value), undefined, active),
                                                                )
                                                            }
                                                        />
                                                    ) : (
                                                        <input
                                                            id={`ixp-${i}-${key}`}
                                                            type="number"
                                                            className={NUM}
                                                            min={IX_PROP_INPUT[key].min}
                                                            max={IX_PROP_INPUT[key].max}
                                                            step={IX_PROP_INPUT[key].step}
                                                            value={step.set[key] ?? IX_PROP_NEUTRAL[key]}
                                                            onChange={(e) =>
                                                                write(
                                                                    setStepProp(draft, i, key, Number(e.target.value), undefined, active),
                                                                )
                                                            }
                                                        />
                                                    )}
                                                </div>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    className="mb-1"
                                                    aria-label={`Quitar ${IX_PROP_LABELS[key]} del paso ${i + 1}`}
                                                    onClick={() =>
                                                        write(setStepProp(draft, i, key, undefined, undefined, active))
                                                    }
                                                >
                                                    ×
                                                </Button>
                                            </div>
                                        ))}
                                        {free.length > 0 && (
                                            <FieldSelect
                                                id={`ixp-add-${i}`}
                                                label="Añadir propiedad"
                                                value=""
                                                onChange={(v) =>
                                                    v &&
                                                    write(
                                                        setStepProp(
                                                            draft,
                                                            i,
                                                            v as IxPropKey,
                                                            IX_PROP_NEUTRAL[v as IxPropKey],
                                                            undefined,
                                                            active,
                                                        ),
                                                    )
                                                }
                                                options={[
                                                    { value: "", label: "Elegir…" },
                                                    ...free.map((k) => ({ value: k, label: IX_PROP_LABELS[k] })),
                                                ]}
                                            />
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ol>

                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-4"
                        disabled={track.steps.length >= IX_MAX_STEPS}
                        onClick={() => write(addStep(draft, undefined, active))}
                    >
                        + Añadir paso
                    </Button>
                    {track.steps.length >= IX_MAX_STEPS && (
                        <p className="mt-2 text-xs text-gray-500">
                            Máximo {IX_MAX_STEPS} pasos: una animación con siete puntos de control ya no
                            es una animación, es un programa.
                        </p>
                    )}
                </fieldset>

                {state.warnings.length > 0 && (
                    <ul role="note" aria-label="Avisos del preajuste" className="mt-4 space-y-1">
                        {state.warnings.map((w, i) => (
                            <li key={i} className="text-xs text-amber-700">
                                {w}
                            </li>
                        ))}
                    </ul>
                )}

                <p role="status" className="mt-6 text-xs text-gray-500">
                    {state.summary}
                </p>

                <div className="mt-4 flex gap-3">
                    <Button type="submit" loading={saving}>
                        {id ? "Guardar cambios" : "Crear preajuste"}
                    </Button>
                    <Button type="button" variant="ghost" onClick={onCancel}>
                        Cancelar
                    </Button>
                </div>
            </form>
        </Card>
    );
}

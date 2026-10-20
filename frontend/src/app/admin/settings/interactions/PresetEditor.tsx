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
import { useI18n } from "@/contexts/I18nContext";
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
    scrubSrcOf,
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
    ixSummary,
    type IxPanelTargetKind,
    type IxPanelTriggerKind,
    type IxScrubSrc,
} from "@/components/verso/editor/ixPanelModel";
import { trStr } from "@/lib/editorI18n";
import { localizeIxWarning } from "@/lib/verso/interactions/warningsI18n";
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
    const { t, language } = useI18n();
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
                    {t("interactions.editor.noTracks")}
                </p>
                <Button variant="ghost" onClick={onCancel} className="mt-4">
                    {t("interactions.editor.cancel")}
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
                aria-label={id ? t("interactions.editor.editAria").replace("{name}", name) : t("interactions.editor.newAria")}
            >
                <div className="flex items-start justify-between gap-4 mb-6">
                    <div className="min-w-0 flex-1">
                        <Input
                            label={t("interactions.editor.nameLabel")}
                            value={name}
                            maxLength={IX_PRESET_NAME_MAX}
                            placeholder={t("interactions.editor.namePlaceholder")}
                            onChange={(e) => onName(e.target.value)}
                        />
                        {id && (
                            <p className="mt-1 text-xs text-gray-400">
                                {t("interactions.editor.idLabel")} <code className="font-mono">{id}</code> {t("interactions.editor.idNote")}
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
                    <legend className="px-1 text-sm font-bold text-gray-900">{t("interactions.editor.preview")}</legend>
                    <div className="mt-2 overflow-hidden rounded-xl bg-gray-50/50 p-6">
                        <div
                            ref={previewRef}
                            className="flex h-24 w-full items-center justify-center rounded-xl border-2 border-gray-200 bg-white text-sm font-medium text-gray-600"
                        >
                            {t("interactions.editor.preview")}
                        </div>
                    </div>
                    {timed ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-4"
                            disabled={!previewUnit}
                            aria-label={t("interactions.editor.playAria")}
                            onClick={playPreview}
                        >
                            {t("interactions.editor.play")}
                        </Button>
                    ) : (
                        <div className="mt-4">
                            <label className={LABEL} htmlFor="ixp-preview-pct">
                                {t("interactions.editor.previewProgress").replace("{pct}", String(previewPct))}
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
                                    ? t("interactions.editor.previewPointerHint")
                                    : t("interactions.editor.previewScrubHint")}
                            </p>
                        </div>
                    )}
                    {!previewUnit && (
                        <p className="mt-2 text-xs text-gray-500">
                            {t("interactions.editor.previewEmpty")}
                        </p>
                    )}
                </fieldset>

                {/* ── Pistas (P5) — hasta IX_MAX_TRACKS cuerpos independientes sobre el MISMO
                    disparador. Todo lo de abajo (objetivo, escalonado, tiempos, reproducción,
                    opciones y pasos) lee y escribe SOLO la pista activa. */}
                <fieldset className="mb-6">
                    <legend className={LABEL}>{t("interactions.editor.tracks")}</legend>
                    <div className="flex flex-wrap items-center gap-3">
                        {state.tracks.length > 1 && (
                            <div
                                role="radiogroup"
                                aria-label={t("interactions.editor.activeTrack")}
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
                                        {t("interactions.editor.trackN").replace("{n}", String(i + 1))}
                                    </label>
                                ))}
                            </div>
                        )}
                        {state.tracks.length < IX_MAX_TRACKS && (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                title={t("interactions.editor.addTrackTitle")}
                                onClick={() => {
                                    write(addTrack(draft));
                                    // La nueva queda seleccionada: su índice es el recuento ANTES de añadir.
                                    setTrackSel(state.tracks.length);
                                }}
                            >
                                {t("interactions.editor.addTrack")}
                            </Button>
                        )}
                        {state.tracks.length > 1 && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={t("interactions.editor.removeTrackAria").replace("{n}", String(active + 1))}
                                onClick={() => {
                                    write(removeTrack(draft, active));
                                    setTrackSel(0);
                                }}
                            >
                                {t("interactions.editor.removeTrack")}
                            </Button>
                        )}
                    </div>
                </fieldset>

                {/* Disparador y objetivo */}
                <div className="grid gap-4 md:grid-cols-2">
                    <FieldSelect
                        id="ixp-trigger"
                        label={t("interactions.editor.when")}
                        value={trigger.on}
                        onChange={(v) => write(setTriggerKind(draft, v as IxPanelTriggerKind))}
                        options={TRIGGERS.map((on) => ({ value: on, label: trStr(IX_TRIGGER_LABELS[on], language) }))}
                    />
                    <FieldSelect
                        id="ixp-target"
                        label={t("interactions.editor.what")}
                        value={track.target.kind}
                        onChange={(v) => write(setTargetKind(draft, v as IxPanelTargetKind, undefined, active))}
                        options={TARGETS.map((k) => ({ value: k, label: trStr(IX_TARGET_LABELS[k], language) }))}
                    />

                    {trigger.on === "view" && (
                        <FieldSelect
                            id="ixp-once"
                            label={t("interactions.editor.repetition")}
                            value={trigger.once === false ? "each" : "once"}
                            onChange={(v) => write(setViewOnce(draft, v === "once"))}
                            options={[
                                { value: "once", label: t("interactions.editor.viewOnce") },
                                { value: "each", label: t("interactions.editor.viewEach") },
                            ]}
                        />
                    )}

                    {trigger.on === "click" && (
                        <FieldSelect
                            id="ixp-click-toggle"
                            label={t("interactions.editor.secondClick")}
                            value={trigger.toggle === true ? "undo" : "stay"}
                            onChange={(v) => write(setClickToggle(draft, v === "undo"))}
                            options={[
                                { value: "stay", label: t("interactions.editor.clickStay") },
                                { value: "undo", label: t("interactions.editor.clickUndo") },
                            ]}
                        />
                    )}

                    {trigger.on === "load" && (
                        <div>
                            <label className={LABEL} htmlFor="ixp-load-delay">
                                {t("interactions.editor.loadDelay")}
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
                                label={t("interactions.editor.scrubSrc")}
                                value={scrubSrcOf(trigger)}
                                onChange={(v) => write(setScrubSrc(draft, v as IxScrubSrc))}
                                options={[
                                    { value: "self", label: t("interactions.editor.scrubSrcSelf") },
                                    { value: "page", label: t("interactions.editor.scrubSrcPage") },
                                    { value: "scene", label: t("interactions.editor.scrubSrcScene") },
                                ]}
                            />
                            {/* Suavizado del scroll (P10) — opt-in: sin él, exactitud nativa 1:1. */}
                            <div>
                                <label className={LABEL} htmlFor="ixp-scrub-smooth">
                                    {t("interactions.editor.smoothMs")}
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
                                    {t("interactions.editor.scrubSmoothHint")}
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
                                    {t("interactions.editor.eventName")}
                                </label>
                                <input
                                    id="ixp-event-name"
                                    type="text"
                                    className={NUM}
                                    value={trigger.name}
                                    onChange={(e) => write(setEventName(draft, e.target.value))}
                                />
                                <p className="mt-1 text-xs text-gray-500">
                                    {t("interactions.editor.eventHelp").split("{code}")[0]}<code>{IX_EVENT_PREFIX}&lt;{t("interactions.editor.eventNameToken")}&gt;</code>
                                    {t("interactions.editor.eventHelp").split("{code}")[1] ?? ""}
                                </p>
                            </div>
                            <label className="flex cursor-pointer select-none items-center gap-2 self-center text-sm text-gray-700">
                                <input
                                    type="checkbox"
                                    checked={trigger.toggle === true}
                                    onChange={(e) => write(setEventToggle(draft, e.target.checked))}
                                />
                                {t("interactions.editor.eventToggle")}
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
                                label={t("interactions.editor.pointerArea")}
                                value={trigger.area === "page" ? "page" : "self"}
                                onChange={(v) =>
                                    write(setPointerArea(draft, v === "page" ? "page" : "self"))
                                }
                                options={[
                                    { value: "self", label: t("interactions.editor.pointerAreaSelf") },
                                    { value: "page", label: t("interactions.editor.pointerAreaPage") },
                                ]}
                            />
                            <div>
                                <label className={LABEL} htmlFor="ixp-pointer-smooth">
                                    {t("interactions.editor.smoothMs")}
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
                                    {t("interactions.editor.pointerSmoothHint")}
                                </p>
                            </div>
                            <div>
                                <FieldSelect
                                    id="ixp-axis"
                                    label={t("interactions.editor.pointerAxis")}
                                    value={track.axis ?? "x"}
                                    onChange={(v) =>
                                        write(setTrackAxis(draft, v === "y" ? "y" : "x", undefined, active))
                                    }
                                    options={AXES.map((a) => ({
                                        value: a,
                                        label: trStr(IX_AXIS_LABELS[a], language),
                                    }))}
                                />
                                <p className="mt-1 text-xs text-gray-500">
                                    {t("interactions.editor.pointerAxisHint")}
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
                                    ? t("interactions.editor.staggerTotalMs")
                                    : t("interactions.editor.staggerEachMs")}
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
                                    {t("interactions.editor.duration")}
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
                                    {t("interactions.editor.delay")}
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
                        {t("interactions.editor.wordsNote").replace("{max}", String(IX_MAX_WORDS))}
                    </p>
                )}

                {/* Honestidad (P12): el trazo SVG exige el contrato del MARKUP del bloque. */}
                {track.target.kind === "svg" && (
                    <p className="mt-3 text-xs text-gray-500">
                        {t("interactions.editor.svgNote")}
                    </p>
                )}

                {trigger.on === "pointer" && (
                    <p role="note" className="mt-3 text-xs text-gray-500">
                        {t("interactions.editor.pointerNote")}
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
                                {t("interactions.editor.stagger")}
                            </legend>
                            <div className="mt-2 flex flex-wrap items-end gap-4">
                                {track.stagger.cols == null && (
                                    <div className="w-56">
                                        <FieldSelect
                                            id="ixp-stagger-from"
                                            label={t("interactions.editor.staggerOrder")}
                                            value={track.stagger.from ?? "start"}
                                            onChange={(v) =>
                                                write(setStaggerFrom(draft, v as IxStaggerFrom, undefined, active))
                                            }
                                            options={STAGGER_FROMS.map((f) => ({
                                                value: f,
                                                label: trStr(IX_STAGGER_FROM_LABELS[f], language),
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
                                    {t("interactions.editor.staggerAsTotal")}
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
                                    {t("interactions.editor.staggerGrid")}
                                </label>
                                {track.stagger.cols != null && (
                                    <div className="w-36">
                                        <label className={LABEL} htmlFor="ixp-stagger-cols">
                                            {t("interactions.editor.staggerCols")}
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
                            {t("interactions.editor.range")}
                        </legend>
                        <div className="mt-2 grid gap-4 md:grid-cols-2">
                            {(["from", "to"] as const).map((which) => (
                                <div key={which} className="flex items-end gap-3">
                                    {!pageScrub && (
                                        <div className="min-w-0 flex-1">
                                            <FieldSelect
                                                id={`ixp-range-${which}-at`}
                                                label={which === "from" ? t("interactions.editor.rangeFrom") : t("interactions.editor.rangeTo")}
                                                value={range[which].at}
                                                onChange={(v) =>
                                                    write(setRangeEdge(draft, which, { at: v as IxEdgeName }))
                                                }
                                                options={EDGES.map((e) => ({
                                                    value: e,
                                                    label: trStr(IX_EDGE_LABELS[e], language),
                                                }))}
                                            />
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <label className={LABEL} htmlFor={`ixp-range-${which}-pct`}>
                                            {which === "from" ? t("interactions.editor.rangeFromPct") : t("interactions.editor.rangeToPct")}
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
                                {t("interactions.editor.rangeReset")}
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
                        <legend className="px-1 text-sm font-bold text-gray-900">{t("interactions.editor.playback")}</legend>
                        <div className="mt-2 flex flex-wrap items-end gap-4">
                            <div className="w-36">
                                <label className={LABEL} htmlFor="ixp-repeat">
                                    {t("interactions.editor.repetition")}
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
                                {t("interactions.editor.infinite")}
                            </label>
                            <label className="mb-2.5 flex cursor-pointer select-none items-center gap-2 text-sm text-gray-700">
                                <input
                                    type="checkbox"
                                    checked={track.alt === true}
                                    onChange={(e) =>
                                        write(setAlternate(draft, e.target.checked, undefined, active))
                                    }
                                />
                                {t("interactions.editor.alternate")}
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
                                label={t("interactions.editor.clipDir")}
                                value={track.clipDir ?? "right"}
                                onChange={(v) => write(setClipDir(draft, v as IxClipDir, undefined, active))}
                                options={IX_CLIP_DIRS.map((d) => ({
                                    value: d,
                                    label: trStr(IX_CLIP_DIR_LABELS[d], language),
                                }))}
                            />
                        )}
                        {showOrigin && (
                            <FieldSelect
                                id="ixp-origin"
                                label={t("interactions.editor.origin")}
                                value={track.origin ?? "center"}
                                onChange={(v) => write(setOrigin(draft, v as IxOrigin, undefined, active))}
                                options={IX_ORIGINS.map((o) => ({
                                    value: o,
                                    label: trStr(IX_ORIGIN_LABELS[o], language),
                                }))}
                            />
                        )}
                        {showPersp && (
                            <div>
                                <label className={LABEL} htmlFor="ixp-persp">
                                    {t("interactions.editor.perspective")}
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
                        {t("interactions.editor.steps").replace("{count}", String(track.steps.length))}
                        {state.tracks.length > 1 ? t("interactions.editor.stepsTrackSuffix").replace("{n}", String(active + 1)) : ""}
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
                                            {isFirst ? t("interactions.editor.stepStart") : isLast ? t("interactions.editor.stepEnd") : t("interactions.editor.stepN").replace("{n}", String(i + 1))}
                                        </span>
                                        {!isFirst && !isLast && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                aria-label={t("interactions.editor.removeStepAria").replace("{n}", String(i + 1))}
                                                onClick={() => write(removeStep(draft, i, undefined, active))}
                                            >
                                                {t("interactions.editor.removeStep")}
                                            </Button>
                                        )}
                                    </div>

                                    <div className="grid gap-3 md:grid-cols-2">
                                        {/* Los extremos los reancla el normalizador a 0 y 100: mostrar un control
                                            que el dato va a ignorar sería mentirle al autor. */}
                                        {!isFirst && !isLast && (
                                            <div>
                                                <label className={LABEL} htmlFor={`ixp-at-${i}`}>
                                                    {t("interactions.editor.stepAt")}
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
                                                label={t("interactions.editor.easeToNext")}
                                                value={step.bez ? IX_BEZ_SENTINEL : (step.ease ?? "out")}
                                                onChange={(v) =>
                                                    v === IX_BEZ_SENTINEL
                                                        ? write(setStepBez(draft, i, ixBezSeed(step.ease), undefined, active))
                                                        : write(setStepEase(draft, i, v as IxEase, undefined, active))
                                                }
                                                options={[
                                                    ...EASES.map((e) => ({ value: e as string, label: trStr(IX_EASE_LABELS[e], language) })),
                                                    { value: IX_BEZ_SENTINEL, label: t("interactions.editor.customCurve") },
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
                                                        {trStr(IX_PROP_LABELS[key], language)}
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
                                                    aria-label={t("interactions.editor.removePropAria").replace("{prop}", trStr(IX_PROP_LABELS[key], language)).replace("{n}", String(i + 1))}
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
                                                label={t("interactions.editor.addProp")}
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
                                                    { value: "", label: t("interactions.editor.choose") },
                                                    ...free.map((k) => ({ value: k, label: trStr(IX_PROP_LABELS[k], language) })),
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
                        {t("interactions.editor.addStep")}
                    </Button>
                    {track.steps.length >= IX_MAX_STEPS && (
                        <p className="mt-2 text-xs text-gray-500">
                            {t("interactions.editor.maxSteps").replace("{max}", String(IX_MAX_STEPS))}
                        </p>
                    )}
                </fieldset>

                {state.warnings.length > 0 && (
                    <ul role="note" aria-label={t("interactions.editor.warnings")} className="mt-4 space-y-1">
                        {state.warnings.map((w, i) => (
                            <li key={i} className="text-xs text-amber-700">
                                {localizeIxWarning(w, language)}
                            </li>
                        ))}
                    </ul>
                )}

                <p role="status" className="mt-6 text-xs text-gray-500">
                    {ixSummary(state.presetId, state.presetOk, state.trigger, state.tracks, undefined, language)}
                </p>

                <div className="mt-4 flex gap-3">
                    <Button type="submit" loading={saving}>
                        {id ? t("interactions.editor.saveChanges") : t("interactions.editor.create")}
                    </Button>
                    <Button type="button" variant="ghost" onClick={onCancel}>
                        {t("interactions.editor.cancel")}
                    </Button>
                </div>
            </form>
        </Card>
    );
}

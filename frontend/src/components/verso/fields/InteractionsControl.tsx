"use client";
/**
 * Verso — EL PANEL DE INTERACCIONES (F9-D). Los tres niveles de §6.1 de la spec, en el panel de
 * propiedades:
 *
 *   Nivel 1 — Preajuste   un desplegable (sistema + sitio + "Personalizada"). Lo que ve el 90 %.
 *   Nivel 2 — Disparador  cuándo (pantalla / scroll / ratón / clic / carga / puntero) y a quién
 *                         (el bloque, sus hijos escalonados, las palabras), con duración y retardo.
 *   Nivel 3 — Pasos       tras un `<details>`: por paso, su momento, su curva y sus propiedades.
 *
 * TODO EL MARKUP SALE DE `VersoFieldControl`: cada control es un `VersoField` (`select` / `radio` /
 * `number`) renderizado por el mismo componente que pinta el resto del panel. Eso no es estética —
 * es de dónde salen el `<label for>` con `useId`, el `fieldset/legend` del radiogrupo y el
 * `aria-label` posicional de los botones. Un control a mano aquí sería un control con su propia
 * accesibilidad, y sería la que se olvidase. Dos excepciones, ambas por tipos que `VersoField` no
 * tiene: los checkboxes («Reproducción», las opciones del escalonado y «Dónde corre»; su `<label>`
 * ENVUELVE al `<input>`, así que el nombre accesible es intrínseco y no hay un `for`/`id` que se
 * pueda desasociar) y el `<input type="color">` de las propiedades de color, que replica el
 * `label for` + `useId` de las filas numéricas.
 *
 * TODA LA LÓGICA SALE DE `ixPanelModel.ts`, que es puro y está probado en node: este fichero decide
 * qué se muestra, nunca qué se guarda. Cada escritura devuelve un valor NUEVO ya normalizado y sube
 * por `onChange` → `PropertiesPanel` → `handle.transact(tx.setProps(...))`, el único camino con
 * historia y undo. Aquí no se muta nada.
 *
 * ANUNCIO DE CAMBIOS (AA): una región `role="status"` con el resumen de lo que hay puesto — el
 * RESULTADO, no el gesto. Quien no ve el lienzo necesita oír "al entrar en pantalla, sus hijos,
 * 2 pasos", no "botón pulsado".
 *
 * PISTAS (P5): un cuerpo propio puede llevar hasta `IX_MAX_TRACKS` pistas sobre el MISMO
 * disparador. La pista ACTIVA es estado local del panel (elegirla no escribe nada en el documento;
 * el `key` por bloque del panel la devuelve a la 0 al cambiar de selección): todos los controles de
 * pista leen `tracks[activa]` y escriben pasando ese índice al modelo. La LÍNEA DE TIEMPO (P9),
 * sobre la lista, es imagen, navegación y ajuste — un carril por pista; en la activa, marcadores y
 * retardo se arrastran o se mueven con flechas, y un clic sin arrastre lleva el foco a la fila del
 * paso (el gesto de la tira P5) — y nunca el único camino: los campos numéricos siguen debajo.
 */
import React, { useCallback, useId, useMemo, useRef, useState } from "react";
import MSym from "@/components/editor/MSym";
import {
  IX_BREAKPOINTS,
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
  IX_PROP_NEUTRAL,
  IX_REPEAT_MAX,
  IX_STAGGER_MAX,
  type IxClipDir,
  type IxCompileCtx,
  type IxEase,
  type IxEdgeName,
  type IxOrigin,
  type IxPropKey,
  type IxStaggerFrom,
  type IxStep,
} from "@/lib/verso/interactions";
// Los topes de la rejilla (P4) no están en la superficie del índice: se leen del módulo que los
// define, igual que el lienzo lee `runtime/` directamente.
import { IX_STAGGER_COLS_MAX, IX_STAGGER_COLS_MIN } from "@/lib/verso/interactions";
// Los topes del suavizado del puntero (P6), por la misma razón: del módulo que los define.
import {
  IX_POINTER_SMOOTH_DEFAULT,
  IX_POINTER_SMOOTH_MAX,
} from "@/lib/verso/interactions";
// Los topes de la intensidad (P7), por la misma razón: del módulo que los define.
import { IX_AMT_MAX, IX_AMT_MIN } from "@/lib/verso/interactions";
import type {
  NumberVersoField,
  RadioVersoField,
  SelectVersoField,
  TextVersoField,
} from "@/lib/verso/registry";
import {
  addStep,
  addTrack,
  availableProps,
  clearIx,
  effectiveRange,
  ixPanelState,
  ixPresetChoice,
  ixPresetOptions,
  rangeEditable,
  removeStep,
  removeTrack,
  resetRange,
  setAlternate,
  setBreakpointOff,
  setClickToggle,
  setClipDir,
  setDelay,
  setDuration,
  setEventName,
  setEventToggle,
  setIntensity,
  setLoadDelay,
  setOrigin,
  setPersp,
  setPointerArea,
  setPointerSmooth,
  setPresetChoice,
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
  unlinkPreset,
  usedProps,
  IX_AXIS_LABELS,
  IX_BREAKPOINT_LABELS,
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
} from "../editor/ixPanelModel";
import { requestIxPreview, requestIxScrub } from "../canvas/IxCanvasEngine";
import IxCurveEditor, { ixBezSeed, IX_BEZ_SENTINEL, type IxBez } from "./IxCurveEditor";
import IxScrubberControl from "./IxScrubberControl";
import IxTimeline from "./IxTimeline";
import VersoFieldControl from "./VersoFieldControl";

const BTN =
  "rounded border border-[var(--ed-outline-variant)] px-2 py-1 text-[11px] text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] disabled:opacity-40";
const HINT = "text-[10px] text-[var(--ed-outline)] mt-1.5";
// Grupo compuesto (varios controles bajo una leyenda): mismo trazo que el fieldset de ObjectControl.
const GROUP = "mb-3 rounded border border-[var(--ed-outline-variant)] p-2";
const LEGEND = "px-1 text-xs font-medium text-[var(--ed-on-surface-variant)]";
const CHECK =
  "mb-3 flex cursor-pointer items-center gap-1.5 text-xs text-[var(--ed-on-surface-variant)]";

const TRIGGERS: IxPanelTriggerKind[] = [
  "view",
  "scrub",
  "hover",
  "click",
  "load",
  "pointer",
  "event",
];
const EASES = Object.keys(IX_EASINGS) as IxEase[];
/** Órdenes del escalonado (P4), en el orden canónico de sus etiquetas. */
const STAGGER_FROMS = Object.keys(IX_STAGGER_FROM_LABELS) as IxStaggerFrom[];
/** Ejes del cursor (P6), en el orden canónico de sus etiquetas. */
const AXES = Object.keys(IX_AXIS_LABELS) as Array<"x" | "y">;
/** Aristas de `animation-range`, en el orden en que se cruzan al hacer scroll. */
const EDGES: IxEdgeName[] = ["cover", "entry", "contain", "exit"];

/**
 * Objetivos que se ofrecen SIEMPRE. `words` (el split por palabras) no está aquí porque no es una
 * capacidad del motor sino del BLOQUE: solo las definiciones que declaran `ixText: true` emiten los
 * `<span class="wjs-ixw">` que el CSS generado necesita (hoy Heading y Quote). Ofrecerlo en un
 * bloque que no los emite produciría reglas contra un selector inexistente — una opción que no mueve
 * nada, que es exactamente por lo que estuvo retirada.
 *
 * Se añade en dos casos: cuando el bloque lo declara (`supportsWords`) y cuando el dato YA lo trae
 * puesto (puede llegar por la API o por una importación), para no dejar el radiogrupo sin selección.
 *
 * `svg` (P12) SÍ se ofrece siempre: su contrato no lo declara la definición sino el MARKUP del
 * bloque (paths `.wjs-ixd` con `pathLength=1`), que el panel no puede conocer — la honestidad va en
 * la línea de ayuda que aparece al elegirlo.
 */
const OFFERED_TARGETS: IxPanelTargetKind[] = ["self", "children"];

/**
 * Disparadores cuyo progreso lo marca el RELOJ (y por tanto tienen duración y retardo). Ni `scrub`
 * (la posición del scroll) ni `pointer` (la posición del cursor) lo son: ahí duración, retardo y
 * reproducción no significan nada, y ofrecerlos sería ofrecer controles que el compilador avisa
 * de que ignora.
 */
export const isTimed = (on: IxPanelTriggerKind): boolean => on !== "scrub" && on !== "pointer";

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

export interface InteractionsControlProps {
  /** El valor CRUDO de `props.ix` (dato hostil: el modelo lo normaliza). */
  value: unknown;
  /** Recibe el valor nuevo ya normalizado, o `undefined` para quitar la prop. */
  onChange: (value: unknown) => void;
  /** Presets del sistema + del sitio. */
  ixCtx?: IxCompileCtx;
  /**
   * El bloque seleccionado declara `ixText: true` (su render emite los spans por palabra). Lo pasa
   * `PropertiesPanel` desde la definición del registro: el panel no adivina qué sabe pintar cada
   * bloque, se lo dice el bloque.
   */
  supportsWords?: boolean;
  /**
   * Inyectable para tests; por defecto emite el evento de previsualización en el documento.
   * `block` re-arma solo el bloque seleccionado; `page`, todas las interacciones del lienzo.
   */
  onPreview?: (scope: "page" | "block") => void;
  /** Inyectable para tests; por defecto emite el evento del scrubber en el documento. */
  onScrub?: (pct: number | null) => void;
  /**
   * ESCENARIO EXTERNO (IxDock): el dock monta la LÍNEA DE TIEMPO y el TRANSPORTE (probar +
   * scrubber) en su escenario, a lo ancho — así que este control no los renderiza dentro, y la
   * pista activa pasa a ser CONTROLADA para que escenario e inspector señalen la misma. Sin
   * `stage`, el control es autónomo: exactamente el de siempre (PresetEditor no cambia).
   */
  stage?: { trackSel: number; onTrackSel: (track: number) => void };
}

export default function InteractionsControl({
  value,
  onChange,
  ixCtx,
  supportsWords = false,
  onPreview,
  onScrub,
  stage,
}: InteractionsControlProps) {
  const titleId = useId();
  const amtId = useId();
  // Referencia ESTABLE: el scrubber la usa como dependencia de su efecto de limpieza, y una función
  // nueva en cada render lo soltaría y lo re-armaría en cada pulsación de tecla del panel.
  const scrub = useCallback(
    (pct: number | null) => (onScrub ? onScrub(pct) : requestIxScrub(pct)),
    [onScrub],
  );
  const state = useMemo(() => ixPanelState(value, ixCtx), [value, ixCtx]);
  const presetOptions = useMemo(() => ixPresetOptions(ixCtx), [ixCtx]);
  // Pista ACTIVA (P5): estado LOCAL del panel — elegir pista no es editar y no escribe nada. El
  // `key` por bloque del panel remonta el componente al cambiar la selección (vuelta a la 0); el
  // clamp cubre el otro camino: si el recuento encoge por debajo del índice, se vuelve a la 0.
  // Con escenario externo (dock) la pista activa es CONTROLADA: las dos vistas señalan la misma.
  const [ownTrackSel, setOwnTrackSel] = useState(0);
  const trackSel = stage ? stage.trackSel : ownTrackSel;
  const setTrackSel = stage ? stage.onTrackSel : setOwnTrackSel;
  const active = trackSel < state.tracks.length ? trackSel : 0;
  const track = state.tracks[active];
  // Filas del nivel 3, por índice de paso: la LÍNEA DE TIEMPO las enfoca desde sus marcadores.
  const stepRowRefs = useRef<Array<HTMLLIElement | null>>([]);
  const focusStepRow = (i: number): void => {
    const row = stepRowRefs.current[i];
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    // El primer control OPERABLE de la fila: un input readOnly se enfoca; un select disabled, no.
    row.querySelector<HTMLElement>("input:enabled, select:enabled, button:enabled")?.focus();
  };
  const trigger = state.trigger;
  const linked = state.presetId !== null;
  // Dispositivos APAGADOS (P4). El dato guarda dónde NO corre; los checkboxes muestran lo contrario.
  const offList = state.spec?.off ?? [];
  // Intensidad del bloque (P7): multiplicador del MOVIMIENTO. 1 = tal cual se diseñó (sin clave).
  const amt = state.spec?.amt ?? 1;
  // Derivados del disparador para el editor de tramo. `hasOwnRange` distingue el rango DEL AUTOR del
  // por defecto del compilador: «Restablecer» solo tiene sentido cuando hay algo que borrar.
  const range = rangeEditable(trigger) ? effectiveRange(trigger) : null;
  const pageScrub = trigger.on === "scrub" && trigger.src === "page";
  const hasOwnRange = (trigger.on === "scrub" || trigger.on === "view") && trigger.range != null;
  const infinite = track?.repeat === "inf";
  const repeatCount = track && typeof track.repeat === "number" ? track.repeat : 1;
  // Unión de propiedades usadas por los pasos de la pista 0: cada OPCIÓN DE PISTA se ofrece solo
  // cuando algún paso usa una propiedad a la que afecta — un selector de perspectiva sin nada 3D
  // no movería nada (el mismo criterio que retiró `words` de los bloques que no lo emiten).
  const trackProps = new Set<IxPropKey>();
  for (const s of track?.steps ?? []) for (const k of usedProps(s)) trackProps.add(k);
  const showClipDir = trackProps.has("clip");
  const showOrigin = ORIGIN_PROPS.some((k) => trackProps.has(k));
  const showPersp = PERSP_PROPS.some((k) => trackProps.has(k));

  const presetField: SelectVersoField = { type: "select", options: presetOptions };
  const triggerField: RadioVersoField = {
    type: "radio",
    options: TRIGGERS.map((on) => ({ label: IX_TRIGGER_LABELS[on], value: on })),
  };
  const onceField: RadioVersoField = {
    type: "radio",
    options: [
      { label: "Una vez", value: true },
      { label: "Cada vez", value: false },
    ],
  };
  const clickToggleField: RadioVersoField = {
    type: "radio",
    options: [
      { label: "Se queda", value: false },
      { label: "Se deshace", value: true },
    ],
  };
  const scrubSrcField: RadioVersoField = {
    type: "radio",
    options: [
      { label: "El recorrido del bloque", value: "self" },
      { label: "El scroll de la página", value: "page" },
    ],
  };
  const pointerAreaField: RadioVersoField = {
    type: "radio",
    options: [
      { label: "El propio bloque", value: "self" },
      { label: "Toda la página", value: "page" },
    ],
  };
  // Eje del cursor por pista (P6): con la piel de pestañas del radiogrupo, como el resto.
  const axisField: RadioVersoField = {
    type: "radio",
    options: AXES.map((a) => ({ label: IX_AXIS_LABELS[a], value: a })),
  };
  const edgeField: SelectVersoField = {
    type: "select",
    options: EDGES.map((e) => ({ label: IX_EDGE_LABELS[e], value: e })),
  };
  const clipDirField: SelectVersoField = {
    type: "select",
    options: IX_CLIP_DIRS.map((d) => ({ label: IX_CLIP_DIR_LABELS[d], value: d })),
  };
  const originField: SelectVersoField = {
    type: "select",
    options: IX_ORIGINS.map((o) => ({ label: IX_ORIGIN_LABELS[o], value: o })),
  };
  const staggerFromField: SelectVersoField = {
    type: "select",
    options: STAGGER_FROMS.map((f) => ({ label: IX_STAGGER_FROM_LABELS[f], value: f })),
  };
  // Selector de pista (P5), con la piel de pestañas del radiogrupo de VersoFieldControl.
  const trackField: RadioVersoField = {
    type: "radio",
    options: state.tracks.map((_, i) => ({ label: `Pista ${i + 1}`, value: i })),
  };
  const currentTarget = track?.target.kind;
  const targets: IxPanelTargetKind[] = [
    ...OFFERED_TARGETS,
    ...(supportsWords || currentTarget === "words" ? (["words"] as const) : []),
    "svg",
  ];
  const targetField: RadioVersoField = {
    type: "radio",
    options: targets.map((kind) => ({ label: IX_TARGET_LABELS[kind], value: kind })),
  };
  const msField = (min: number, max: number, step = 50): NumberVersoField => ({
    type: "number",
    min,
    max,
    step,
  });
  // Nombre del evento (P11): un slug cerrado — la regla la aplica el escritor, no el control.
  const eventNameField: TextVersoField = { type: "text" };

  return (
    // wjs-f-ix — marcador de sección, hermano de wjs-f-anim / wjs-f-look / wjs-f-hide.
    <section className="wjs-f-ix mb-3" aria-labelledby={titleId} data-verso-ix-panel="">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h4
          id={titleId}
          className="text-xs font-semibold text-[var(--ed-on-surface)] flex items-center gap-1"
        >
          <MSym name="animation" size={14} />
          Interacción
        </h4>
        <span className="flex shrink-0 gap-1">
          {/* Con escenario externo, el TRANSPORTE (probar + scrubber) vive en el dock. */}
          {!stage && (
            <>
              <button
                type="button"
                className={BTN}
                disabled={!state.active}
                title="Reproducir la interacción de este bloque en el lienzo"
                aria-label="Probar la interacción de este bloque"
                onClick={() => (onPreview ? onPreview("block") : requestIxPreview("block"))}
              >
                <MSym name="play_arrow" size={12} className="align-[-2px]" /> Probar
              </button>
              <button
                type="button"
                className={`${BTN} px-1.5`}
                disabled={!state.active}
                title="Reproducir todas las interacciones de la página en el lienzo"
                aria-label="Probar todas las interacciones de la página"
                onClick={() => (onPreview ? onPreview("page") : requestIxPreview("page"))}
              >
                Probar todo
              </button>
            </>
          )}
          <button
            type="button"
            className={BTN}
            disabled={state.spec === null}
            aria-label="Quitar la interacción del bloque"
            onClick={() => onChange(clearIx())}
          >
            Quitar
          </button>
        </span>
      </div>

      {/* Lo que hay puesto, en una línea. `role="status"` = aria-live polite implícito. */}
      <p role="status" className="text-[10px] text-[var(--ed-on-surface-variant)] mb-2">
        {state.summary}
      </p>

      {/* ── Nivel 1 — preajuste ─────────────────────────────────────── */}
      <VersoFieldControl
        field={presetField}
        name="ix-preset"
        label="Preajuste"
        value={ixPresetChoice(state)}
        onChange={(v) => onChange(setPresetChoice(value, typeof v === "string" ? v : "", ixCtx))}
      />

      {state.active && track && (
        <>
          {/* Transporte: «Probar» (arriba) reproduce; esto recorre. Una entrada de 600 ms se ve
              pasar; una interacción ligada al scroll NO se puede ver pasar, porque su estado no
              depende del reloj sino de dónde está el bloque — para ajustar el paso intermedio hay
              que poder pararse en él. Con escenario externo, el scrubber vive en el transporte
              del dock. */}
          {!stage && (
            <IxScrubberControl
              enabled={state.active}
              scrollDriven={trigger.on === "scrub" || (trigger.on === "view" && trigger.once === false)}
              onScrub={scrub}
            />
          )}

          {/* ── Intensidad (P7) — Nivel 1, como el preajuste: multiplica la DISTANCIA al neutro de
              las propiedades espaciales, así que vale igual con un preajuste enlazado (es del
              BLOQUE, como «Dónde corre»: no lo bifurca) y con cuerpo propio. No es un VersoField
              —el contrato de campos no tiene tipo `range` y es público—, así que replica a mano el
              `label for` + `useId` que aquel daría gratis, como el color de los pasos. */}
          <div className="mb-3">
            <label
              htmlFor={amtId}
              className="block text-xs font-medium text-[var(--ed-on-surface-variant)] mb-1"
            >
              Intensidad (×{amt.toFixed(1)})
            </label>
            <input
              id={amtId}
              type="range"
              min={IX_AMT_MIN}
              max={IX_AMT_MAX}
              step={0.1}
              value={amt}
              // El deslizador nativo ya anuncia su valor; `aria-valuetext` le pone el formato «×».
              aria-valuetext={`×${amt.toFixed(1)}`}
              className="w-full accent-[var(--ed-primary)]"
              onChange={(e) => onChange(setIntensity(value, Number(e.target.value), ixCtx))}
            />
            <p className={HINT}>Multiplica el movimiento (no la opacidad ni el color).</p>
          </div>

          {/* ── Nivel 2 — disparador y objetivo ─────────────────────── */}
          <VersoFieldControl
            field={triggerField}
            name="ix-trigger"
            label="Cuándo"
            value={trigger.on}
            onChange={(v) => onChange(setTriggerKind(value, v as IxPanelTriggerKind, ixCtx))}
          />

          {trigger.on === "view" && (
            <>
              <VersoFieldControl
                field={onceField}
                name="ix-once"
                label="Repetición"
                value={trigger.once !== false}
                onChange={(v) => onChange(setViewOnce(value, v === true, ixCtx))}
              />
              <p className={HINT}>
                «Cada vez» avanza y retrocede con el scroll sin una línea de JavaScript. «Una vez» se
                queda puesta al entrar, y eso el CSS no sabe hacerlo: ese bloque carga el runtime
                mínimo.
              </p>
            </>
          )}

          {/* Las opciones de cada disparador viajan CON el disparador (el único override local que
              un bloque enlazado a un preajuste puede llevar), así que se ofrecen también enlazado —
              igual que «Cuándo». */}
          {trigger.on === "click" && (
            <VersoFieldControl
              field={clickToggleField}
              name="ix-click-toggle"
              label="Al segundo clic"
              value={trigger.toggle === true}
              onChange={(v) => onChange(setClickToggle(value, v === true, ixCtx))}
            />
          )}

          {trigger.on === "load" && (
            <VersoFieldControl
              field={msField(0, 3000)}
              name="ix-load-delay"
              label="Retardo del disparador (ms)"
              value={trigger.delay ?? 0}
              onChange={(v) => onChange(setLoadDelay(value, typeof v === "number" ? v : 0, ixCtx))}
            />
          )}

          {trigger.on === "scrub" && (
            <>
              <VersoFieldControl
                field={scrubSrcField}
                name="ix-scrub-src"
                label="Qué scroll manda"
                value={trigger.src === "page" ? "page" : "self"}
                onChange={(v) => onChange(setScrubSrc(value, v === "page" ? "page" : "self", ixCtx))}
              />
              {/* ── Suavizado del scroll (P10) — opt-in: sin él, exactitud nativa 1:1. */}
              <VersoFieldControl
                field={msField(0, IX_POINTER_SMOOTH_MAX, 10)}
                name="ix-scrub-smooth"
                label="Suavizado (ms)"
                value={trigger.smooth ?? 0}
                onChange={(v) =>
                  onChange(setScrubSmooth(value, typeof v === "number" ? v : 0, ixCtx))
                }
              />
              <p className={HINT}>0 = sin suavizado (exactitud nativa 1:1).</p>
              <p role="note" className={HINT}>
                Con suavizado el progreso lo persigue el runtime mínimo en JavaScript: se renuncia
                al camino puro de CSS en el compositor.
              </p>
            </>
          )}

          {/* ── `event` (P11): la escotilla para plugins y código propio — el runtime escucha el
              evento en el documento. El nombre viaja CON el disparador, así que se ofrece también
              enlazado a un preajuste, como el resto de opciones de «Cuándo». */}
          {trigger.on === "event" && (
            <>
              <VersoFieldControl
                field={eventNameField}
                name="ix-event-name"
                label="Nombre del evento"
                value={trigger.name}
                onChange={(v) =>
                  onChange(setEventName(value, typeof v === "string" ? v : "", ixCtx))
                }
              />
              <p className={HINT}>
                El evento real del DOM es <code>{IX_EVENT_PREFIX}&lt;nombre&gt;</code>. El nombre
                es un slug: minúsculas, números y guiones — con uno inválido se conserva el último
                válido.
              </p>
              <label className={CHECK}>
                <input
                  type="checkbox"
                  checked={trigger.toggle === true}
                  onChange={(e) => onChange(setEventToggle(value, e.target.checked, ixCtx))}
                />
                Cada evento alterna (entra/sale)
              </label>
            </>
          )}

          {/* ── `pointer` (P6): el cursor POSICIONA la animación, no la dispara. Área y suavizado
              viven en el disparador (viajan con él, también enlazado a un preajuste). */}
          {trigger.on === "pointer" && (
            <>
              <VersoFieldControl
                field={pointerAreaField}
                name="ix-pointer-area"
                label="Qué área sigue el cursor"
                value={trigger.area === "page" ? "page" : "self"}
                onChange={(v) =>
                  onChange(setPointerArea(value, v === "page" ? "page" : "self", ixCtx))
                }
              />
              <VersoFieldControl
                field={msField(0, IX_POINTER_SMOOTH_MAX, 10)}
                name="ix-pointer-smooth"
                label="Suavizado (ms)"
                value={trigger.smooth ?? IX_POINTER_SMOOTH_DEFAULT}
                onChange={(v) =>
                  onChange(
                    setPointerSmooth(
                      value,
                      typeof v === "number" ? v : IX_POINTER_SMOOTH_DEFAULT,
                      ixCtx,
                    ),
                  )
                }
              />
              <p className={HINT}>0 = sigue al cursor sin retraso.</p>
              <p role="note" className={HINT}>
                El puntero posiciona la animación (el paso 50 es el reposo). Inerte con
                reduced-motion y en pantallas táctiles.
              </p>
            </>
          )}

          {/* ── Tramo del recorrido (scrub, o view que entra y sale) ── */}
          {range && (
            <fieldset className={GROUP}>
              <legend className={LEGEND}>Tramo del recorrido</legend>
              {(["from", "to"] as const).map((which) => (
                <div key={which} className="flex gap-2">
                  {/* Con el scroll de la página las ARISTAS no significan nada (el compilador emite
                      solo porcentajes ahí): se ofrecen únicamente los dos %. */}
                  {!pageScrub && (
                    <div className="flex-1">
                      <VersoFieldControl
                        field={edgeField}
                        name={`ix-range-${which}-at`}
                        label={which === "from" ? "Desde" : "Hasta"}
                        value={range[which].at}
                        onChange={(v) =>
                          onChange(setRangeEdge(value, which, { at: v as IxEdgeName }, ixCtx))
                        }
                      />
                    </div>
                  )}
                  <div className="flex-1">
                    <VersoFieldControl
                      field={{ type: "number", min: 0, max: 100, step: 5 }}
                      name={`ix-range-${which}-pct`}
                      label={which === "from" ? "Desde (%)" : "Hasta (%)"}
                      value={range[which].pct}
                      onChange={(v) =>
                        onChange(
                          setRangeEdge(
                            value,
                            which,
                            { pct: typeof v === "number" ? v : range[which].pct },
                            ixCtx,
                          ),
                        )
                      }
                    />
                  </div>
                </div>
              ))}
              {hasOwnRange && (
                <button
                  type="button"
                  className={`${BTN} w-full`}
                  onClick={() => onChange(resetRange(value, ixCtx))}
                >
                  Restablecer tramo
                </button>
              )}
            </fieldset>
          )}

          {/* ── Dónde corre (P4) — apagar la interacción por dispositivo. Vive en el BLOQUE, como
              «Cuándo»: son los dos únicos overrides locales que un bloque enlazado a un preajuste
              puede llevar, así que se ofrece también enlazado. Marcado = corre en ese dispositivo
              (el dato guarda lo contrario: la lista `off`). */}
          <fieldset className={GROUP}>
            <legend className={LEGEND}>Dónde corre</legend>
            <div className="flex flex-wrap items-center gap-x-3">
              {IX_BREAKPOINTS.map((bp) => (
                <label key={bp} className={CHECK}>
                  <input
                    type="checkbox"
                    checked={!offList.includes(bp)}
                    onChange={(e) => onChange(setBreakpointOff(value, bp, !e.target.checked, ixCtx))}
                  />
                  {IX_BREAKPOINT_LABELS[bp]}
                </label>
              ))}
            </div>
            <p className={`${HINT} mt-0`}>
              Desmarcar los tres es quitarla, no acotarla: el modelo descarta ese gating y la
              interacción sigue corriendo en todas partes.
            </p>
          </fieldset>

          {linked ? (
            <div
              role="note"
              className="mb-3 rounded border border-dashed border-[var(--ed-outline-variant)] px-2 py-1.5 text-[11px] text-[var(--ed-on-surface-variant)]"
            >
              Los pasos vienen del preajuste y se comparten con los demás bloques que lo usan.
              Editarlo en Ajustes los cambia todos, sin tocar el contenido de ninguna página.
              <button
                type="button"
                className={`${BTN} mt-1.5 w-full`}
                onClick={() => onChange(unlinkPreset(value, ixCtx))}
              >
                Desvincular y editar solo este bloque
              </button>
            </div>
          ) : (
            <>
              {/* ── Pistas (P5) — hasta IX_MAX_TRACKS cuerpos independientes sobre el MISMO
                  disparador. Todo lo de abajo (objetivo, escalonado, tiempos, reproducción,
                  opciones y pasos) lee y escribe SOLO la pista activa. */}
              {state.tracks.length > 1 && (
                <VersoFieldControl
                  field={trackField}
                  name="ix-track"
                  label="Pista"
                  value={active}
                  onChange={(v) => setTrackSel(typeof v === "number" ? v : 0)}
                />
              )}
              <div className="mb-3 flex gap-1">
                {state.tracks.length < IX_MAX_TRACKS && (
                  <button
                    type="button"
                    className={`${BTN} flex-1`}
                    title="Añadir una pista nueva (nace neutra: no mueve nada hasta que la edites)"
                    onClick={() => {
                      onChange(addTrack(value, ixCtx));
                      // La pista nueva queda seleccionada: su índice es el recuento ANTES de añadir.
                      setTrackSel(state.tracks.length);
                    }}
                  >
                    + Añadir pista
                  </button>
                )}
                {state.tracks.length > 1 && (
                  <button
                    type="button"
                    className={`${BTN} flex-1`}
                    aria-label={`Quitar la pista ${active + 1}`}
                    onClick={() => {
                      onChange(removeTrack(value, active, ixCtx));
                      setTrackSel(0);
                    }}
                  >
                    Quitar pista
                  </button>
                )}
              </div>

              <VersoFieldControl
                field={targetField}
                name="ix-target"
                label="Qué se mueve"
                value={track.target.kind}
                onChange={(v) => onChange(setTargetKind(value, v as IxPanelTargetKind, ixCtx, active))}
              />

              {track.target.kind === "words" && (
                <p className={HINT}>
                  El texto se parte en palabras y el bloque conserva su lectura completa para los
                  lectores de pantalla. No se parte si lleva formato (negritas, enlaces) o si pasa de{" "}
                  {IX_MAX_WORDS} palabras: entonces se ve igual que siempre, sin movimiento.
                </p>
              )}

              {/* ── Honestidad (P13): el dato trae `words` pero este bloque no declara el split —
                  puede llegar por la API o por una importación. El objetivo no mueve nada, y
                  callárselo al autor sería dejarle buscar un fallo que no existe. */}
              {track.target.kind === "words" && !supportsWords && (
                <p role="note" className={HINT}>
                  Este bloque no sabe partir su texto en palabras: con este objetivo no se mueve
                  nada. Elige otro objetivo, o usa un bloque que lo declare (Título o Cita).
                </p>
              )}

              {/* ── Honestidad (P12): el trazo SVG exige el contrato del MARKUP del bloque. */}
              {track.target.kind === "svg" && (
                <p className={HINT}>
                  Mueve el trazo de los SVG del bloque marcados con la clase wjs-ixd y{" "}
                  pathLength=&quot;1&quot; (bloques propios o de plugins). Si el bloque no tiene
                  ninguno, no se anima nada.
                </p>
              )}

              {/* El escalonado es un reparto de RETARDOS, y con `pointer` no hay reloj que
                  retrasar: el compilador lo ignora con aviso, así que no se ofrece. */}
              {trigger.on !== "pointer" &&
                (track.target.kind === "children" || track.target.kind === "words") && (
                <VersoFieldControl
                  field={msField(0, IX_STAGGER_MAX)}
                  name="ix-stagger"
                  label={
                    // Con `total` los mismos ms dejan de ser "entre hermanos" y pasan a ser el
                    // tiempo del primero al último: la etiqueta dice lo que el número significa.
                    track.stagger?.total === true
                      ? "Tiempo total (ms)"
                      : "Escalonado entre hermanos (ms)"
                  }
                  value={track.stagger?.each ?? 0}
                  onChange={(v) =>
                    onChange(setStagger(value, typeof v === "number" ? v : 0, ixCtx, active))
                  }
                />
              )}

              {/* ── Opciones del escalonado (P4) — solo cuando HAY escalonado: sin él cada escritor
                  es un no-op y el control mentiría. Con rejilla (`cols`) la onda avanza en diagonal
                  e ignora el orden lineal: el selector se bloquea, no se esconde, para que se vea
                  POR QUÉ no aplica. */}
              {trigger.on !== "pointer" &&
                (track.target.kind === "children" || track.target.kind === "words") &&
                track.stagger && (
                  <fieldset className={GROUP}>
                    <legend className={LEGEND}>Escalonado</legend>
                    <VersoFieldControl
                      field={staggerFromField}
                      name="ix-stagger-from"
                      label="Orden"
                      value={track.stagger.from ?? "start"}
                      readOnly={track.stagger.cols != null}
                      onChange={(v) =>
                        onChange(setStaggerFrom(value, v as IxStaggerFrom, ixCtx, active))
                      }
                    />
                    <label className={CHECK}>
                      <input
                        type="checkbox"
                        checked={track.stagger.total === true}
                        onChange={(e) =>
                          onChange(setStaggerTotal(value, e.target.checked, ixCtx, active))
                        }
                      />
                      Repartir como tiempo total
                    </label>
                    <div className="flex flex-wrap items-end gap-x-2">
                      <label className={CHECK}>
                        <input
                          type="checkbox"
                          checked={track.stagger.cols != null}
                          onChange={(e) =>
                            onChange(
                              setStaggerCols(
                                value,
                                e.target.checked ? IX_STAGGER_COLS_MIN : null,
                                ixCtx,
                                active,
                              ),
                            )
                          }
                        />
                        En rejilla
                      </label>
                      {track.stagger.cols != null && (
                        <div className="min-w-16 flex-1">
                          <VersoFieldControl
                            field={{
                              type: "number",
                              min: IX_STAGGER_COLS_MIN,
                              max: IX_STAGGER_COLS_MAX,
                              step: 1,
                            }}
                            name="ix-stagger-cols"
                            label="Columnas"
                            value={track.stagger.cols}
                            onChange={(v) =>
                              onChange(
                                setStaggerCols(
                                  value,
                                  // Vaciar el input no apaga la rejilla: se conserva el valor puesto.
                                  typeof v === "number" ? v : (track.stagger?.cols ?? null),
                                  ixCtx,
                                  active,
                                ),
                              )
                            }
                          />
                        </div>
                      )}
                    </div>
                  </fieldset>
                )}

              {/* ── Eje del cursor (P6) — por pista: cada pista sigue UN eje, y dos pistas (una
                  por eje) componen el efecto 2D. Solo en cuerpo propio, como el resto de pistas. */}
              {trigger.on === "pointer" && (
                <>
                  <VersoFieldControl
                    field={axisField}
                    name="ix-axis"
                    label="Eje del cursor"
                    value={track.axis ?? "x"}
                    onChange={(v) => onChange(setTrackAxis(value, v === "y" ? "y" : "x", ixCtx, active))}
                  />
                  <p className={HINT}>
                    Dos pistas, una por eje, componen el efecto 2D (tilt/parallax).
                  </p>
                </>
              )}

              {isTimed(trigger.on) && (
                <div className="flex gap-2">
                  <div className="flex-1">
                    <VersoFieldControl
                      field={msField(100, 3000)}
                      name="ix-dur"
                      label="Duración (ms)"
                      value={track.dur ?? 600}
                      onChange={(v) =>
                        onChange(setDuration(value, typeof v === "number" ? v : 600, ixCtx, active))
                      }
                    />
                  </div>
                  <div className="flex-1">
                    <VersoFieldControl
                      field={msField(0, 3000)}
                      name="ix-delay"
                      label="Retardo (ms)"
                      value={track.delay ?? 0}
                      onChange={(v) =>
                        onChange(setDelay(value, typeof v === "number" ? v : 0, ixCtx, active))
                      }
                    />
                  </div>
                </div>
              )}

              {/* Reproducción de la pista — solo con disparadores del RELOJ: con scrub o pointer
                  el progreso lo marca la posición, y «repetir» no significa nada. Con «Infinita»
                  marcada el número queda en blanco y bloqueado; desmarcarla vuelve a 1 (que borra
                  la clave). */}
              {isTimed(trigger.on) && (
                <fieldset className={GROUP}>
                  <legend className={LEGEND}>Reproducción</legend>
                  <div className="flex flex-wrap items-end gap-x-2">
                    <div className="min-w-16 flex-1">
                      <VersoFieldControl
                        field={{ type: "number", min: 1, max: IX_REPEAT_MAX, step: 1 }}
                        name="ix-repeat"
                        label="Repetición"
                        value={infinite ? undefined : repeatCount}
                        readOnly={infinite}
                        onChange={(v) =>
                          onChange(setRepeat(value, typeof v === "number" ? v : 1, ixCtx, active))
                        }
                      />
                    </div>
                    <label className={CHECK}>
                      <input
                        type="checkbox"
                        checked={infinite}
                        onChange={(e) =>
                          onChange(setRepeat(value, e.target.checked ? "inf" : 1, ixCtx, active))
                        }
                      />
                      Infinita
                    </label>
                    <label className={CHECK}>
                      <input
                        type="checkbox"
                        checked={track.alt === true}
                        onChange={(e) =>
                          onChange(setAlternate(value, e.target.checked, ixCtx, active))
                        }
                      />
                      Ida y vuelta
                    </label>
                  </div>
                </fieldset>
              )}

              {/* ── Opciones de pista (P3) — cada una solo si algún paso usa lo que gobierna ── */}
              {showClipDir && (
                <VersoFieldControl
                  field={clipDirField}
                  name="ix-clip-dir"
                  label="Revelado"
                  value={track.clipDir ?? "right"}
                  onChange={(v) => onChange(setClipDir(value, v as IxClipDir, ixCtx, active))}
                />
              )}
              {showOrigin && (
                <VersoFieldControl
                  field={originField}
                  name="ix-origin"
                  label="Origen del giro y la escala"
                  value={track.origin ?? "center"}
                  onChange={(v) => onChange(setOrigin(value, v as IxOrigin, ixCtx, active))}
                />
              )}
              {showPersp && (
                <VersoFieldControl
                  field={{ type: "number", min: IX_PERSP_MIN, max: IX_PERSP_MAX, step: 50 }}
                  name="ix-persp"
                  label="Perspectiva 3D (px)"
                  value={track.persp ?? IX_PERSP_DEFAULT}
                  onChange={(v) =>
                    onChange(
                      setPersp(value, typeof v === "number" ? v : IX_PERSP_DEFAULT, ixCtx, active),
                    )
                  }
                />
              )}
            </>
          )}

          {/* ── Nivel 3 — los pasos ─────────────────────────────────── */}
          <details className="mt-1 rounded border border-[var(--ed-outline-variant)]">
            <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--ed-on-surface-variant)]">
              Editar pasos ({track.steps.length})
              {state.tracks.length > 1 ? ` — pista ${active + 1}` : ""}
            </summary>
            <div className="border-t border-[var(--ed-outline-variant)] p-2">
              {linked && (
                <p className={`${HINT} mb-2 mt-0`}>
                  Solo lectura: este bloque usa un preajuste. Desvincúlalo para editar sus pasos.
                </p>
              )}
              {/* La LÍNEA DE TIEMPO (P9): un carril por pista sobre una escala compartida (ms con
                  reloj; 0–100 % con scrub/pointer). En la pista activa, los marcadores intermedios
                  y el retardo se ARRASTRAN (o se mueven con flechas); un clic sin arrastre conserva
                  el gesto de la tira P5 — llevar el foco a la fila del paso. Nunca el único camino:
                  los campos numéricos de abajo son el canónico. El componente es agnóstico de
                  tokens (`currentColor`): el tono lo pone esta superficie con su clase de texto.
                  Con escenario externo (dock) NO se pinta aquí: vive grande en el escenario. */}
              {!stage && (
                <div className="mb-2 text-[var(--ed-on-surface-variant)]">
                  <IxTimeline
                    tracks={state.tracks}
                    active={active}
                    timed={isTimed(trigger.on)}
                    readOnly={linked}
                    onStepAt={(t, i, at) => onChange(setStepAt(value, i, at, ixCtx, t))}
                    onDelay={(t, ms) => onChange(setDelay(value, ms, ixCtx, t))}
                    onSelectTrack={setTrackSel}
                    onFocusStep={(t, i) => focusStepRow(i)}
                  />
                </div>
              )}
              <ol className="space-y-2">
                {track.steps.map((step, i) => (
                  <StepRow
                    key={i}
                    step={step}
                    index={i}
                    total={track.steps.length}
                    readOnly={linked}
                    rowRef={(el) => {
                      stepRowRefs.current[i] = el;
                    }}
                    onAt={(at) => onChange(setStepAt(value, i, at, ixCtx, active))}
                    onEase={(ease) => onChange(setStepEase(value, i, ease, ixCtx, active))}
                    onBez={(bez) => onChange(setStepBez(value, i, bez, ixCtx, active))}
                    onProp={(key, v) => onChange(setStepProp(value, i, key, v, ixCtx, active))}
                    onRemove={() => onChange(removeStep(value, i, ixCtx, active))}
                  />
                ))}
              </ol>
              {!linked && (
                <button
                  type="button"
                  className={`${BTN} mt-2 w-full`}
                  disabled={track.steps.length >= IX_MAX_STEPS}
                  onClick={() => onChange(addStep(value, ixCtx, active))}
                >
                  + Añadir paso
                </button>
              )}
              {track.steps.length >= IX_MAX_STEPS && (
                <p className={HINT}>
                  Máximo {IX_MAX_STEPS} pasos: una animación con siete puntos de control ya no es una
                  animación, es un programa.
                </p>
              )}
            </div>
          </details>

          {state.warnings.length > 0 && (
            <ul
              role="note"
              aria-label="Avisos de la interacción"
              className="mt-2 space-y-1 text-[10px] text-[var(--ed-on-surface-variant)]"
            >
              {state.warnings.map((w, i) => (
                <li key={i} className="flex gap-1">
                  <MSym name="info" size={11} className="mt-px shrink-0" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Una fila de la tira de pasos                                        */
/* ------------------------------------------------------------------ */

interface StepRowProps {
  step: IxStep;
  index: number;
  total: number;
  readOnly: boolean;
  /** El `<li>` de la fila, para que la TIRA de pasos pueda enfocarla desde su marcador. */
  rowRef: (el: HTMLLIElement | null) => void;
  onAt: (at: number) => void;
  onEase: (ease: IxEase) => void;
  onBez: (bez: IxBez) => void;
  onProp: (key: IxPropKey, value: number | undefined) => void;
  onRemove: () => void;
}

function StepRow({
  step,
  index,
  total,
  readOnly,
  rowRef,
  onAt,
  onEase,
  onBez,
  onProp,
  onRemove,
}: StepRowProps) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const free = availableProps(step);
  const used = usedProps(step);
  const label = isFirst ? "Inicio (0 %)" : isLast ? "Final (100 %)" : `Paso ${index + 1}`;

  // «Curva propia…» es un sentinel de UI (IX_BEZ_SENTINEL), no un IxEase: elegirlo siembra un
  // `bez` con el equivalente de la curva que había puesta, y a partir de ahí manda el dibujo.
  const easeField: SelectVersoField = {
    type: "select",
    options: [
      ...EASES.map((e) => ({ label: IX_EASE_LABELS[e], value: e as string })),
      { label: "Curva propia…", value: IX_BEZ_SENTINEL },
    ],
  };
  const addField: SelectVersoField = {
    type: "select",
    options: free.map((k) => ({ label: IX_PROP_LABELS[k], value: k })),
  };

  return (
    <li ref={rowRef} className="rounded border border-[var(--ed-outline-variant)] p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-[var(--ed-on-surface)]">{label}</span>
        {!readOnly && !isFirst && !isLast && (
          <button
            type="button"
            className={BTN}
            aria-label={`Quitar el paso ${index + 1}`}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>

      {/* Los extremos NO se mueven: el normalizador reancla el primero a 0 y el último a 100 para
          que la pista siempre acabe en su fotograma final (el `to` neutro del contrato de
          entradas). Mostrar un control que el dato va a ignorar sería mentirle al autor. */}
      {!isFirst && !isLast && (
        <VersoFieldControl
          field={{ type: "number", min: 1, max: 99, step: 1 }}
          name={`ix-step-at-${index}`}
          label="Momento (%)"
          value={step.at}
          readOnly={readOnly}
          onChange={(v) => onAt(typeof v === "number" ? v : step.at)}
        />
      )}

      {!isLast && (
        <>
          <VersoFieldControl
            field={easeField}
            name={`ix-step-ease-${index}`}
            label="Curva hasta el siguiente"
            value={step.bez ? IX_BEZ_SENTINEL : (step.ease ?? "out")}
            readOnly={readOnly}
            onChange={(v) => (v === IX_BEZ_SENTINEL ? onBez(ixBezSeed(step.ease)) : onEase(v as IxEase))}
          />
          {/* Con `bez` puesto, el selector dice «Curva propia…» y el dibujo edita ese mismo valor;
              volver a un nombre pasa por `setStepEase`, que retira el bez (una sola verdad por
              paso). En solo lectura (preajuste enlazado) no se monta: cada arrastre escribiría. */}
          {!readOnly && step.bez && (
            <div className="mb-3">
              <IxCurveEditor value={step.bez} onChange={onBez} />
            </div>
          )}
        </>
      )}

      {used.map((key) => (
        <div key={key} className="flex items-end gap-1">
          <div className="flex-1">
            {IX_COLOR_PROPS.has(key) ? (
              // Colores: mismo label/id que una fila numérica, con el swatch nativo. Sin unidad.
              <StepColorRow
                label={IX_PROP_LABELS[key]}
                value={step.set[key] ?? IX_PROP_NEUTRAL[key]}
                readOnly={readOnly}
                onChange={(v) => onProp(key, v)}
              />
            ) : (
              <VersoFieldControl
                field={{ type: "number", ...IX_PROP_INPUT[key] }}
                name={`ix-step-${index}-${key}`}
                label={`${IX_PROP_LABELS[key]}${IX_PROP_UNITS[key] ? ` (${IX_PROP_UNITS[key]})` : ""}`}
                value={step.set[key]}
                readOnly={readOnly}
                onChange={(v) => onProp(key, typeof v === "number" ? v : undefined)}
              />
            )}
          </div>
          {!readOnly && (
            <button
              type="button"
              className={`${BTN} mb-3`}
              aria-label={`Quitar ${IX_PROP_LABELS[key]} del paso ${index + 1}`}
              onClick={() => onProp(key, undefined)}
            >
              ×
            </button>
          )}
        </div>
      ))}

      {!readOnly && free.length > 0 && (
        <VersoFieldControl
          field={addField}
          name={`ix-step-add-${index}`}
          label="Añadir propiedad"
          value={undefined}
          onChange={(v) => onProp(v as IxPropKey, IX_PROP_NEUTRAL[v as IxPropKey])}
        />
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Una propiedad de color de un paso                                   */
/* ------------------------------------------------------------------ */

interface StepColorRowProps {
  label: string;
  /** El entero 0xRRGGBB tal cual vive en el paso. */
  value: number;
  readOnly: boolean;
  onChange: (value: number) => void;
}

/**
 * `<input type="color">` de una propiedad de color. No es un `VersoField` (no existe el tipo), así
 * que replica a mano lo que `VersoFieldControl` daría gratis: `<label for>` + `useId`. El DATO
 * sigue siendo el entero 0xRRGGBB — aquí solo se traduce hacia y desde el `#rrggbb` del control.
 */
function StepColorRow({ label, value, readOnly, onChange }: StepColorRowProps) {
  const id = useId();
  return (
    <div className="mb-3">
      <label
        htmlFor={id}
        className="block text-xs font-medium text-[var(--ed-on-surface-variant)] mb-1"
      >
        {label}
      </label>
      {/* `readOnly` no existe en un input de color (no hay caret): `disabled` es el equivalente. */}
      <input
        id={id}
        type="color"
        className="h-8 w-full cursor-pointer rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] p-0.5 disabled:cursor-default disabled:opacity-40"
        value={intToHex(value)}
        disabled={readOnly}
        onChange={(e) => onChange(hexToInt(e.target.value))}
      />
    </div>
  );
}

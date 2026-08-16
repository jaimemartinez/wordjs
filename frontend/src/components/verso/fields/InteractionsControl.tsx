"use client";
/**
 * Verso — EL PANEL DE INTERACCIONES (F9-D). Los tres niveles de §6.1 de la spec, en el panel de
 * propiedades:
 *
 *   Nivel 1 — Preajuste   un desplegable (sistema + sitio + "Personalizada"). Lo que ve el 90 %.
 *   Nivel 2 — Disparador  cuándo (pantalla / scroll / ratón / clic / carga) y a quién (el bloque,
 *                         sus hijos escalonados, las palabras), con duración y retardo.
 *   Nivel 3 — Pasos       tras un `<details>`: por paso, su momento, su curva y sus propiedades.
 *
 * TODO EL MARKUP SALE DE `VersoFieldControl`. No hay ni un `<input>` suelto en este fichero: cada
 * control es un `VersoField` (`select` / `radio` / `number`) renderizado por el mismo componente que
 * pinta el resto del panel. Eso no es estética — es de dónde salen el `<label for>` con `useId`, el
 * `fieldset/legend` del radiogrupo y el `aria-label` posicional de los botones. Un control a mano
 * aquí sería un control con su propia accesibilidad, y sería la que se olvidase.
 *
 * TODA LA LÓGICA SALE DE `ixPanelModel.ts`, que es puro y está probado en node: este fichero decide
 * qué se muestra, nunca qué se guarda. Cada escritura devuelve un valor NUEVO ya normalizado y sube
 * por `onChange` → `PropertiesPanel` → `handle.transact(tx.setProps(...))`, el único camino con
 * historia y undo. Aquí no se muta nada.
 *
 * ANUNCIO DE CAMBIOS (AA): una región `role="status"` con el resumen de lo que hay puesto — el
 * RESULTADO, no el gesto. Quien no ve el lienzo necesita oír "al entrar en pantalla, sus hijos,
 * 2 pasos", no "botón pulsado".
 */
import React, { useCallback, useId, useMemo } from "react";
import MSym from "@/components/editor/MSym";
import {
  IX_EASINGS,
  IX_MAX_STEPS,
  IX_MAX_WORDS,
  IX_PROP_NEUTRAL,
  IX_STAGGER_MAX,
  type IxCompileCtx,
  type IxEase,
  type IxPropKey,
  type IxStep,
} from "@/lib/verso/interactions";
import type { NumberVersoField, RadioVersoField, SelectVersoField } from "@/lib/verso/registry";
import {
  addStep,
  availableProps,
  clearIx,
  ixPanelState,
  ixPresetChoice,
  ixPresetOptions,
  removeStep,
  setDelay,
  setDuration,
  setPresetChoice,
  setStagger,
  setStepAt,
  setStepEase,
  setStepProp,
  setTargetKind,
  setTriggerKind,
  setViewOnce,
  unlinkPreset,
  usedProps,
  IX_EASE_LABELS,
  IX_PROP_INPUT,
  IX_PROP_LABELS,
  IX_PROP_UNITS,
  IX_TARGET_LABELS,
  IX_TRIGGER_LABELS,
  type IxPanelTargetKind,
  type IxPanelTriggerKind,
} from "../editor/ixPanelModel";
import { requestIxPreview, requestIxScrub } from "../canvas/IxCanvasEngine";
import IxScrubberControl from "./IxScrubberControl";
import VersoFieldControl from "./VersoFieldControl";

const BTN =
  "rounded border border-[var(--ed-outline-variant)] px-2 py-1 text-[11px] text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] disabled:opacity-40";
const HINT = "text-[10px] text-[var(--ed-outline)] mt-1.5";

const TRIGGERS: IxPanelTriggerKind[] = ["view", "scrub", "hover", "click", "load"];
const EASES = Object.keys(IX_EASINGS) as IxEase[];

/**
 * Objetivos que se ofrecen SIEMPRE. `words` (el split por palabras) no está aquí porque no es una
 * capacidad del motor sino del BLOQUE: solo las definiciones que declaran `ixText: true` emiten los
 * `<span class="wjs-ixw">` que el CSS generado necesita (hoy Heading y Quote). Ofrecerlo en un
 * bloque que no los emite produciría reglas contra un selector inexistente — una opción que no mueve
 * nada, que es exactamente por lo que estuvo retirada.
 *
 * Se añade en dos casos: cuando el bloque lo declara (`supportsWords`) y cuando el dato YA lo trae
 * puesto (puede llegar por la API o por una importación), para no dejar el radiogrupo sin selección.
 */
const OFFERED_TARGETS: IxPanelTargetKind[] = ["self", "children"];

/** Disparadores cuyo progreso lo marca el RELOJ (y por tanto tienen duración y retardo). */
const isTimed = (on: IxPanelTriggerKind): boolean => on !== "scrub";

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
  /** Inyectable para tests; por defecto emite el evento de previsualización en el documento. */
  onPreview?: () => void;
  /** Inyectable para tests; por defecto emite el evento del scrubber en el documento. */
  onScrub?: (pct: number | null) => void;
}

export default function InteractionsControl({
  value,
  onChange,
  ixCtx,
  supportsWords = false,
  onPreview,
  onScrub,
}: InteractionsControlProps) {
  const titleId = useId();
  // Referencia ESTABLE: el scrubber la usa como dependencia de su efecto de limpieza, y una función
  // nueva en cada render lo soltaría y lo re-armaría en cada pulsación de tecla del panel.
  const scrub = useCallback(
    (pct: number | null) => (onScrub ? onScrub(pct) : requestIxScrub(pct)),
    [onScrub],
  );
  const state = useMemo(() => ixPanelState(value, ixCtx), [value, ixCtx]);
  const presetOptions = useMemo(() => ixPresetOptions(ixCtx), [ixCtx]);
  const track = state.tracks[0];
  const trigger = state.trigger;
  const linked = state.presetId !== null;

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
  const currentTarget = track?.target.kind;
  const targets: IxPanelTargetKind[] =
    supportsWords || currentTarget === "words" ? [...OFFERED_TARGETS, "words"] : OFFERED_TARGETS;
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
          <button
            type="button"
            className={BTN}
            disabled={!state.active}
            title="Reproducir la interacción en el lienzo"
            onClick={() => (onPreview ? onPreview() : requestIxPreview())}
          >
            <MSym name="play_arrow" size={12} className="align-[-2px]" /> Probar
          </button>
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
              que poder pararse en él. */}
          <IxScrubberControl
            enabled={state.active}
            scrollDriven={trigger.on === "scrub" || (trigger.on === "view" && trigger.once === false)}
            onScrub={scrub}
          />

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
              <VersoFieldControl
                field={targetField}
                name="ix-target"
                label="Qué se mueve"
                value={track.target.kind}
                onChange={(v) => onChange(setTargetKind(value, v as IxPanelTargetKind, ixCtx))}
              />

              {track.target.kind === "words" && (
                <p className={HINT}>
                  El texto se parte en palabras y el bloque conserva su lectura completa para los
                  lectores de pantalla. No se parte si lleva formato (negritas, enlaces) o si pasa de{" "}
                  {IX_MAX_WORDS} palabras: entonces se ve igual que siempre, sin movimiento.
                </p>
              )}

              {(track.target.kind === "children" || track.target.kind === "words") && (
                <VersoFieldControl
                  field={msField(0, IX_STAGGER_MAX)}
                  name="ix-stagger"
                  label="Escalonado entre hermanos (ms)"
                  value={track.stagger?.each ?? 0}
                  onChange={(v) => onChange(setStagger(value, typeof v === "number" ? v : 0, ixCtx))}
                />
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
                        onChange(setDuration(value, typeof v === "number" ? v : 600, ixCtx))
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
                        onChange(setDelay(value, typeof v === "number" ? v : 0, ixCtx))
                      }
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Nivel 3 — los pasos ─────────────────────────────────── */}
          <details className="mt-1 rounded border border-[var(--ed-outline-variant)]">
            <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-[var(--ed-on-surface-variant)]">
              Editar pasos ({track.steps.length})
            </summary>
            <div className="border-t border-[var(--ed-outline-variant)] p-2">
              {linked && (
                <p className={`${HINT} mb-2 mt-0`}>
                  Solo lectura: este bloque usa un preajuste. Desvincúlalo para editar sus pasos.
                </p>
              )}
              <ol className="space-y-2">
                {track.steps.map((step, i) => (
                  <StepRow
                    key={i}
                    step={step}
                    index={i}
                    total={track.steps.length}
                    readOnly={linked}
                    onAt={(at) => onChange(setStepAt(value, i, at, ixCtx))}
                    onEase={(ease) => onChange(setStepEase(value, i, ease, ixCtx))}
                    onProp={(key, v) => onChange(setStepProp(value, i, key, v, ixCtx))}
                    onRemove={() => onChange(removeStep(value, i, ixCtx))}
                  />
                ))}
              </ol>
              {!linked && (
                <button
                  type="button"
                  className={`${BTN} mt-2 w-full`}
                  disabled={track.steps.length >= IX_MAX_STEPS}
                  onClick={() => onChange(addStep(value, ixCtx))}
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
  onAt: (at: number) => void;
  onEase: (ease: IxEase) => void;
  onProp: (key: IxPropKey, value: number | undefined) => void;
  onRemove: () => void;
}

function StepRow({ step, index, total, readOnly, onAt, onEase, onProp, onRemove }: StepRowProps) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const free = availableProps(step);
  const used = usedProps(step);
  const label = isFirst ? "Inicio (0 %)" : isLast ? "Final (100 %)" : `Paso ${index + 1}`;

  const easeField: SelectVersoField = {
    type: "select",
    options: EASES.map((e) => ({ label: IX_EASE_LABELS[e], value: e })),
  };
  const addField: SelectVersoField = {
    type: "select",
    options: free.map((k) => ({ label: IX_PROP_LABELS[k], value: k })),
  };

  return (
    <li className="rounded border border-[var(--ed-outline-variant)] p-2">
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
        <VersoFieldControl
          field={easeField}
          name={`ix-step-ease-${index}`}
          label="Curva hasta el siguiente"
          value={step.ease ?? "out"}
          readOnly={readOnly}
          onChange={(v) => onEase(v as IxEase)}
        />
      )}

      {used.map((key) => (
        <div key={key} className="flex items-end gap-1">
          <div className="flex-1">
            <VersoFieldControl
              field={{ type: "number", ...IX_PROP_INPUT[key] }}
              name={`ix-step-${index}-${key}`}
              label={`${IX_PROP_LABELS[key]}${IX_PROP_UNITS[key] ? ` (${IX_PROP_UNITS[key]})` : ""}`}
              value={step.set[key]}
              readOnly={readOnly}
              onChange={(v) => onProp(key, typeof v === "number" ? v : undefined)}
            />
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

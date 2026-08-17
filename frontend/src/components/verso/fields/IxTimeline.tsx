"use client";
/**
 * Verso — LÍNEA DE TIEMPO multipista de una interacción (P9). Sustituye a la TIRA de pasos (P5)
 * en el panel del bloque (`InteractionsControl`) y en Ajustes → Interacciones (`PresetEditor`).
 *
 * DOS SUPERFICIES, UN COMPONENTE (el mismo trato que IxCurveEditor): es AGNÓSTICO DE TOKENS — ni
 * `--ed-*` (que solo cargan las rutas del editor) ni la paleta del admin. Todo el color es
 * `currentColor` con opacidades, así que hereda el texto de la superficie que lo monte y no
 * arrastra ninguna hoja.
 *
 * QUÉ ENSEÑA: un CARRIL horizontal por pista, apilados sobre una MISMA escala.
 *  - Disparadores del RELOJ (`timed`): la escala son ms — de 0 al mayor `delay+dur` de todas las
 *    pistas (mínimo 1000 ms, para que una pista corta no se estire a todo el ancho) — y cada
 *    carril pinta su animación como una BARRA de `delay` a `delay+dur`.
 *  - Disparadores de POSICIÓN (scrub/pointer): la escala es 0–100 % del recorrido y no hay
 *    retardo que pintar: los pasos van directos sobre el raíl.
 *
 * TRES CAMINOS sobre el MISMO dato, como el resto del panel:
 *  - ratón/touch: en el carril ACTIVO, los marcadores intermedios se ARRASTRAN (pointer capture
 *    sobre el propio botón; `at` entero en vivo) y la barra de retardo también (ms enteros,
 *    acotados 0..3000). Un clic SIN arrastre conserva el gesto de la tira P5: lleva el foco a la
 *    fila del paso.
 *  - teclado: marcadores y barra son botones enfocables. En un marcador, ←/→ mueven ±1 % (±5 %
 *    con Mayús) e Inicio/Fin saltan a los extremos editables (1/99); en la barra, ←/→ mueven
 *    ±50 ms. Una región `aria-live` anuncia la posición nueva, porque un `aria-label` que cambia
 *    no se re-anuncia solo (el patrón de IxCurveEditor).
 *  - los campos numéricos del panel siguen DEBAJO y son el camino accesible CANÓNICO: esto es
 *    mejora, nunca el único camino.
 *
 * LOS EXTREMOS NO SE MUEVEN: el normalizador reancla el primer paso a 0 y el último a 100, así
 * que se pintan como ANCLAS (cuadradas, sin arrastre ni flechas) que solo navegan a su fila —
 * mostrar un tirador que el dato va a ignorar sería mentirle al autor.
 *
 * CARRILES NO ACTIVOS: imagen más selección. Sus marcadores y su barra son decorativos
 * (`aria-hidden`) y el carril ENTERO es un único botón «Pista N» que activa esa pista — nada
 * interactivo anidado. En SOLO LECTURA (preajuste enlazado) TODOS los carriles se pintan así:
 * se ve todo, se puede elegir pista, y nada se arrastra ni se enfoca.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  IX_DELAY_MAX,
  IX_DELAY_MIN,
  IX_DUR_MAX,
  IX_DUR_MIN,
  type IxTrack,
} from "@/lib/verso/interactions";

/**
 * Tipo MIME del arrastre de CLIPS (paleta del dock → línea de tiempo). Propio y explícito: el drop
 * solo acepta lo que la paleta puso, jamás texto arbitrario del sistema.
 */
export const IX_CLIP_MIME = "application/x-wjs-ix-preset";

/** Duración y retardo EFECTIVOS de una pista sin la clave puesta: los mismos del resto del panel. */
const DUR_FALLBACK = 600;
const DELAY_FALLBACK = 0;
/** Suelo de la escala temporal compartida: una sola pista corta no debe ocupar todo el ancho. */
const SCALE_MIN_MS = 1000;
/** Rango del `at` de un paso INTERMEDIO (los extremos están anclados a 0/100 y no se tocan). */
const AT_MIN = 1;
const AT_MAX = 99;
/** Paso de teclado de la barra de retardo: los mismos 50 ms del campo numérico del panel. */
const DELAY_KEY_STEP = 50;

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** Anillo de foco con `currentColor`: el mismo trazo en las dos superficies. */
const RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current";
/** Celda de la etiqueta del carril: compartida con el espaciador de la leyenda para alinear raíles. */
const LABEL_COL = "w-12 shrink-0 truncate text-left text-[10px]";

export interface IxTimelineProps {
  /** id del contenedor, para un anclaje o `aria-labelledby` externo opcional. */
  id?: string;
  /** TODAS las pistas efectivas (propias o del preajuste), ya normalizadas. */
  tracks: readonly IxTrack[];
  /** Índice de la pista activa (estado local del panel que monta; elegirla no escribe nada). */
  active: number;
  /** El disparador es del RELOJ (dur/delay significan algo). Si no, la escala es 0–100 %. */
  timed: boolean;
  /** Solo lectura (preajuste enlazado): todo visible, nada arrastrable salvo elegir pista. */
  readOnly?: boolean;
  /** `at` (%) nuevo de un paso INTERMEDIO de la pista, entero y acotado a 1..99. */
  onStepAt: (track: number, step: number, at: number) => void;
  /** Retardo (ms) nuevo de la pista, entero y acotado a 0..3000. */
  onDelay: (track: number, ms: number) => void;
  /**
   * Duración (ms) nueva de la pista — el ASA del borde derecho del clip (solo con reloj). Sin
   * este callback el asa no se pinta: la superficie decide si sus clips se redimensionan.
   */
  onDur?: (track: number, ms: number) => void;
  onSelectTrack: (track: number) => void;
  /** Clic sin arrastre en un marcador del carril activo: el gesto de navegación de la tira P5. */
  onFocusStep: (track: number, step: number) => void;
  /**
   * SOLTAR UN CLIP (dock): un preajuste arrastrado desde la paleta cae sobre la línea de tiempo.
   * `delayMs` es el punto de suelta en la escala compartida (0 con escalas de posición). Sin este
   * callback la línea de tiempo no es zona de suelta.
   */
  onDropPreset?: (delayMs: number, presetId: string) => void;
}

export default function IxTimeline({
  id,
  tracks,
  active,
  timed,
  readOnly = false,
  onStepAt,
  onDelay,
  onDur,
  onSelectTrack,
  onFocusStep,
  onDropPreset,
}: IxTimelineProps) {
  // El raíl del carril ACTIVO (solo hay uno): la regla que traduce clientX → posición.
  const railRef = useRef<HTMLDivElement | null>(null);
  // Qué marcador se arrastra y si LLEGÓ A MOVERSE: un clic sin arrastre debe seguir navegando a la
  // fila, y el click sintético que sigue a un arrastre debe suprimirse (una sola vez). Refs y no
  // estado: el arrastre no cambia el markup por sí mismo (lo cambia el valor que sube por onStepAt).
  const dragStep = useRef<{ step: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  // Arrastre de la barra de retardo, ANCLADO al punto de agarre: se guarda dónde empezó (clientX y
  // ms) y cada movimiento es un delta sobre eso — sin acumulación, sin deriva.
  const dragDelay = useRef<{ startX: number; base: number } | null>(null);
  // Arrastre del ASA de duración (el borde derecho del clip), con el mismo anclaje.
  const dragDur = useRef<{ startX: number; base: number } | null>(null);
  // Un clip de la paleta sobrevuela la línea de tiempo: anillo de zona de suelta.
  const [dropOver, setDropOver] = useState(false);
  const [announce, setAnnounce] = useState("");
  // CONTINUIDAD DE FOCO: activar una pista REEMPLAZA su carril (botón pasivo → div editable), así
  // que el botón que tenía el foco se desmonta y el foco caería al <body> — expulsando al usuario
  // de teclado justo antes de lo que su selección habilita. Se recuerda QUÉ pista pidió este
  // componente (nunca se roba el foco por re-renders ajenos) y tras el re-render el foco aterriza
  // en la etiqueta del carril ya activo.
  const pendingFocus = useRef<number | null>(null);
  const activeLabelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (pendingFocus.current === null || pendingFocus.current !== active) return;
    pendingFocus.current = null;
    activeLabelRef.current?.focus();
  }, [active]);

  // La escala compartida en ms. Con disparadores de posición no se usa (la escala es 0–100 %).
  const totalMs = Math.max(
    SCALE_MIN_MS,
    ...tracks.map((t) => (t.delay ?? DELAY_FALLBACK) + (t.dur ?? DUR_FALLBACK)),
  );

  /** % del ancho del raíl donde cae el `at` de un paso de la pista `t`, en la escala compartida. */
  const posPct = (t: IxTrack, at: number): number => {
    if (!timed) return at;
    const delay = t.delay ?? DELAY_FALLBACK;
    const dur = Math.max(1, t.dur ?? DUR_FALLBACK);
    return ((delay + (at / 100) * dur) / totalMs) * 100;
  };

  /** clientX → `at` (%) dentro de la pista activa: entero, acotado a 1..99. `null` = sin medida. */
  const atFromClient = (clientX: number): number | null => {
    const rail = railRef.current;
    const track = tracks[active];
    if (!rail || !track) return null;
    const rect = rail.getBoundingClientRect();
    if (rect.width === 0) return null;
    const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
    if (!timed) return clamp(Math.round(frac * 100), AT_MIN, AT_MAX);
    const delay = track.delay ?? DELAY_FALLBACK;
    const dur = Math.max(1, track.dur ?? DUR_FALLBACK);
    return clamp(Math.round(((frac * totalMs - delay) / dur) * 100), AT_MIN, AT_MAX);
  };

  /** Flechas sobre un marcador intermedio: ±1 % (±5 % con Mayús), Inicio/Fin a los extremos. */
  const keyMoveStep = (e: React.KeyboardEvent, track: number, step: number, at: number): void => {
    const delta = e.shiftKey ? 5 : 1;
    const next =
      e.key === "ArrowLeft"
        ? at - delta
        : e.key === "ArrowRight"
          ? at + delta
          : e.key === "Home"
            ? AT_MIN
            : e.key === "End"
              ? AT_MAX
              : null;
    if (next === null) return;
    e.preventDefault();
    const clamped = clamp(Math.round(next), AT_MIN, AT_MAX);
    if (clamped !== at) onStepAt(track, step, clamped);
    setAnnounce(`Paso ${step + 1} — ${clamped} %`);
  };

  /** Flechas sobre la barra de retardo: ±50 ms, acotado a 0..3000. */
  const keyMoveDelay = (e: React.KeyboardEvent, track: number, delay: number): void => {
    const next =
      e.key === "ArrowLeft"
        ? delay - DELAY_KEY_STEP
        : e.key === "ArrowRight"
          ? delay + DELAY_KEY_STEP
          : null;
    if (next === null) return;
    e.preventDefault();
    const clamped = clamp(Math.round(next), IX_DELAY_MIN, IX_DELAY_MAX);
    if (clamped !== delay) onDelay(track, clamped);
    setAnnounce(`Retardo de la pista ${track + 1} — ${clamped} ms`);
  };

  /** Flechas sobre el asa de duración: ±50 ms, acotado a los topes del modelo. */
  const keyMoveDur = (e: React.KeyboardEvent, track: number, dur: number): void => {
    const next =
      e.key === "ArrowLeft"
        ? dur - DELAY_KEY_STEP
        : e.key === "ArrowRight"
          ? dur + DELAY_KEY_STEP
          : null;
    if (next === null || !onDur) return;
    e.preventDefault();
    const clamped = clamp(Math.round(next), IX_DUR_MIN, IX_DUR_MAX);
    if (clamped !== dur) onDur(track, clamped);
    setAnnounce(`Duración de la pista ${track + 1} — ${clamped} ms`);
  };

  /** El nombre accesible de un marcador — los MISMOS de la tira P5 (los tests los fijan). */
  const markerName = (t: IxTrack, i: number): string =>
    i === 0
      ? "Inicio — 0 %"
      : i === t.steps.length - 1
        ? "Final — 100 %"
        : `Paso ${i + 1} — ${t.steps[i].at} %`;

  /**
   * Carril PASIVO (no activo, o todo el componente en solo lectura): el carril entero es UN botón
   * que activa su pista; barra y marcadores son dibujo (`aria-hidden`), nunca controles.
   */
  const passiveLane = (t: IxTrack, ti: number): React.ReactElement => {
    const isActive = ti === active;
    const delay = t.delay ?? DELAY_FALLBACK;
    const dur = t.dur ?? DUR_FALLBACK;
    return (
      <button
        key={ti}
        type="button"
        aria-pressed={isActive}
        aria-label={isActive ? `Pista ${ti + 1} (activa)` : `Pista ${ti + 1}`}
        title={isActive ? `Pista ${ti + 1} (activa)` : `Elegir la pista ${ti + 1}`}
        onClick={() => {
          // Elegir pista va a REEMPLAZAR este botón por el carril editable: pedir el aterrizaje
          // del foco ANTES del re-render (el efecto de arriba lo ejecuta después).
          pendingFocus.current = ti;
          onSelectTrack(ti);
        }}
        className={`flex w-full items-center gap-2 rounded px-1 py-0.5 ${
          isActive ? "bg-current/10" : "opacity-60 hover:opacity-100"
        } ${RING}`}
      >
        <span aria-hidden="true" className={`${LABEL_COL} ${isActive ? "font-semibold" : "font-medium"}`}>
          Pista {ti + 1}
        </span>
        <span aria-hidden="true" className="relative block h-6 flex-1">
          <span className="absolute inset-x-0 top-1/2 block h-px -translate-y-1/2 bg-current/25" />
          {timed && (
            <span
              className="absolute top-1/2 block h-1.5 -translate-y-1/2 rounded-full bg-current/30"
              style={{ left: `${(delay / totalMs) * 100}%`, width: `${(dur / totalMs) * 100}%` }}
            />
          )}
          {t.steps.map((s, si) => (
            <span
              key={si}
              className="absolute top-1/2 block h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current/60"
              style={{ left: `${posPct(t, s.at)}%` }}
            />
          ))}
        </span>
      </button>
    );
  };

  /** Carril ACTIVO y editable: barra de retardo y marcadores intermedios operables. */
  const activeLane = (t: IxTrack, ti: number): React.ReactElement => {
    const delay = t.delay ?? DELAY_FALLBACK;
    const dur = t.dur ?? DUR_FALLBACK;
    const last = t.steps.length - 1;
    return (
      <div key={ti} className="flex w-full items-center gap-2 rounded bg-current/10 px-1 py-0.5">
        <button
          type="button"
          ref={activeLabelRef}
          aria-pressed={true}
          title={`Pista ${ti + 1} (activa)`}
          onClick={() => onSelectTrack(ti)}
          className={`${LABEL_COL} rounded font-semibold ${RING}`}
        >
          Pista {ti + 1}
        </button>
        <div ref={railRef} className="relative h-6 flex-1">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-current/25"
          />
          {/* La barra de la animación (solo con reloj): su CUERPO se arrastra y mueve el retardo.
              La duración no se toca aquí — su campo numérico sigue siendo el camino. */}
          {timed && (
            <button
              type="button"
              aria-label={`Retardo de la pista ${ti + 1} — ${delay} ms`}
              title={`Retardo de la pista ${ti + 1} — ${delay} ms. Arrastra, o ←/→ (±50 ms).`}
              style={{
                left: `${(delay / totalMs) * 100}%`,
                width: `${(dur / totalMs) * 100}%`,
                touchAction: "none",
              }}
              className={`absolute top-1/2 h-2.5 -translate-y-1/2 cursor-grab rounded-full bg-current/30 hover:bg-current/40 ${RING}`}
              onPointerDown={(e) => {
                dragDelay.current = { startX: e.clientX, base: delay };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = dragDelay.current;
                const rail = railRef.current;
                if (!d || !rail) return;
                const rect = rail.getBoundingClientRect();
                if (rect.width === 0) return;
                const next = clamp(
                  Math.round(d.base + ((e.clientX - d.startX) / rect.width) * totalMs),
                  IX_DELAY_MIN,
                  IX_DELAY_MAX,
                );
                if (next !== delay) onDelay(ti, next);
              }}
              onPointerUp={() => {
                dragDelay.current = null;
              }}
              onPointerCancel={() => {
                dragDelay.current = null;
              }}
              onKeyDown={(e) => keyMoveDelay(e, ti, delay)}
            />
          )}
          {/* El ASA del clip (borde derecho): arrastra la DURACIÓN, como recortar un clip de
              vídeo. Solo con reloj y solo si la superficie la pide (onDur). */}
          {timed && onDur && (
            <button
              type="button"
              aria-label={`Duración de la pista ${ti + 1} — ${dur} ms`}
              title={`Duración de la pista ${ti + 1} — ${dur} ms. Arrastra el borde, o ←/→ (±50 ms).`}
              style={{ left: `${((delay + dur) / totalMs) * 100}%`, touchAction: "none" }}
              className={`absolute top-1/2 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm bg-current/70 hover:bg-current ${RING}`}
              onPointerDown={(e) => {
                dragDur.current = { startX: e.clientX, base: dur };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = dragDur.current;
                const rail = railRef.current;
                if (!d || !rail) return;
                const rect = rail.getBoundingClientRect();
                if (rect.width === 0) return;
                const next = clamp(
                  Math.round(d.base + ((e.clientX - d.startX) / rect.width) * totalMs),
                  IX_DUR_MIN,
                  IX_DUR_MAX,
                );
                if (next !== dur) onDur(ti, next);
              }}
              onPointerUp={() => {
                dragDur.current = null;
              }}
              onPointerCancel={() => {
                dragDur.current = null;
              }}
              onKeyDown={(e) => keyMoveDur(e, ti, dur)}
            />
          )}
          {t.steps.map((s, si) => {
            const name = markerName(t, si);
            const left = `${posPct(t, s.at)}%`;
            // Extremos: ANCLAS fijas — navegan a su fila y nada más (el normalizador los reancla
            // a 0/100, así que un tirador aquí sería un control que el dato ignora).
            if (si === 0 || si === last) {
              return (
                <button
                  key={si}
                  type="button"
                  aria-label={name}
                  title={`${name} — ir a su fila`}
                  style={{ left }}
                  className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-current/70 bg-current/50 hover:bg-current/70 ${RING}`}
                  onClick={() => onFocusStep(ti, si)}
                />
              );
            }
            return (
              <button
                key={si}
                type="button"
                aria-label={name}
                title={`${name} — arrastra o ←/→; clic para ir a su fila`}
                style={{ left, touchAction: "none" }}
                className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border border-current bg-current/80 hover:bg-current ${RING}`}
                onPointerDown={(e) => {
                  dragStep.current = { step: si, moved: false };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = dragStep.current;
                  if (!d || d.step !== si) return;
                  const at = atFromClient(e.clientX);
                  if (at === null || at === s.at) return;
                  d.moved = true;
                  onStepAt(ti, si, at);
                }}
                onPointerUp={() => {
                  if (dragStep.current?.moved) suppressClick.current = true;
                  dragStep.current = null;
                }}
                onPointerCancel={() => {
                  dragStep.current = null;
                }}
                onKeyDown={(e) => keyMoveStep(e, ti, si, s.at)}
                onClick={() => {
                  // El click sintético que cierra un ARRASTRE no navega; un clic quieto, sí (y
                  // Enter/Espacio con el teclado también llegan por aquí).
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  onFocusStep(ti, si);
                }}
              />
            );
          })}
        </div>
      </div>
    );
  };

  // ZONA DE SUELTA de clips (solo si la superficie la pide): el punto de suelta se convierte a la
  // escala compartida con el raíl del carril activo como regla — la misma que usan los arrastres.
  // Sin raíl (todo en solo lectura), el punto da igual: soltar aplica el preajuste tal cual.
  const dropDelayAt = (clientX: number): number => {
    if (!timed) return 0;
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
    return clamp(Math.round(frac * totalMs), IX_DELAY_MIN, IX_DELAY_MAX);
  };

  return (
    <div
      id={id}
      role="group"
      aria-label={
        timed
          ? "Línea de tiempo de las pistas (ms)"
          : "Línea de tiempo de las pistas (0–100 % del recorrido)"
      }
      className={`w-full rounded ${dropOver ? "outline outline-2 outline-current/60" : ""}`}
      onDragOver={
        onDropPreset
          ? (e) => {
              if (![...e.dataTransfer.types].includes(IX_CLIP_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              if (!dropOver) setDropOver(true);
            }
          : undefined
      }
      onDragLeave={onDropPreset ? () => setDropOver(false) : undefined}
      onDrop={
        onDropPreset
          ? (e) => {
              setDropOver(false);
              const presetId = e.dataTransfer.getData(IX_CLIP_MIME);
              if (!presetId) return;
              e.preventDefault();
              onDropPreset(dropDelayAt(e.clientX), presetId);
            }
          : undefined
      }
    >
      {/* La escala, decorativa: los valores canónicos viven en los campos numéricos del panel. */}
      <div aria-hidden="true" className="mb-0.5 flex items-center gap-2 px-1 text-[9px] opacity-60">
        <span className={LABEL_COL} />
        <span className="flex flex-1 justify-between">
          <span>0</span>
          <span>{timed ? `${totalMs} ms` : "100 %"}</span>
        </span>
      </div>
      <div className="space-y-1">
        {tracks.map((t, ti) => (ti === active && !readOnly ? activeLane(t, ti) : passiveLane(t, ti)))}
      </div>
      {/* Lo que anuncian las teclas: la posición NUEVA de lo movido (patrón de IxCurveEditor). */}
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </div>
  );
}

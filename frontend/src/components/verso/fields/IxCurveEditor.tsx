"use client";
/**
 * Verso — EDITOR GRÁFICO de la curva de un paso (la «Curva propia…» del selector de curvas).
 *
 * DOS SUPERFICIES, UN COMPONENTE: se monta en el panel del bloque (`InteractionsControl`) y en
 * Ajustes → Interacciones (`PresetEditor`). Por eso es AGNÓSTICO DE TOKENS: ni `--ed-*` (que solo
 * cargan las rutas del editor) ni la paleta del admin — todo el color es `currentColor` con
 * opacidades, así que hereda el texto de la superficie que lo monte y no arrastra ninguna hoja.
 *
 * EL DATO es el `bez` del paso: los cuatro números de un `cubic-bezier(x1,y1,x2,y2)`. Las X son
 * abscisas de una curva de easing (el estándar exige 0..1); las Y admiten rebasamiento (así se
 * dibuja un overshoot) y el normalizador las acota a ±4. Aquí no está la frontera: este componente
 * emite y quien escribe (`setStepBez` → normalizador) clampa pase lo que pase, como el resto del
 * panel.
 *
 * TRES CAMINOS DE EDICIÓN sobre el MISMO valor:
 *  - ratón/touch: arrastrar los dos tiradores (pointer capture sobre el propio círculo). El
 *    arrastre se acota a lo VISIBLE (y ∈ -0.5..1.5): un tirador que se pudiera sacar del dibujo ya
 *    no se podría volver a agarrar;
 *  - teclado: cada tirador es enfocable (`tabIndex=0`, `role="button"`) y las flechas lo mueven en
 *    pasos de 0,05 (0,01 con Mayús); una región `aria-live` anuncia la posición nueva, porque un
 *    `aria-label` que cambia no se re-anuncia solo. El foco se pinta con un anillo propio (el
 *    contorno nativo sobre un círculo SVG es un rectángulo, o directamente nada según navegador);
 *  - los cuatro campos numéricos de abajo — el camino accesible CANÓNICO: etiquetados, con
 *    min/max/step, y con el rango COMPLETO de Y (±4), que el dibujo no alcanza.
 *
 * GEOMETRÍA: el SVG es un cuadrado y muestra y de -0.5 a 1.5 (margen para el overshoot), así que
 * la escala vertical es la mitad de la horizontal y el cuadrado unitario (0,0)→(1,1) se pinta como
 * la banda central. `sx`/`sy` son la única traducción easing→viewBox; todo lo demás las usa.
 */
import React, { useId, useRef, useState } from "react";

/** Los cuatro números de un `cubic-bezier`: [x1, y1, x2, y2]. */
export type IxBez = [number, number, number, number];

/**
 * Sentinel del selector de curvas: «Curva propia…». No es un `IxEase` (el dato jamás lo ve): es un
 * valor de UI, hermano de `IX_PANEL_CUSTOM` del selector de preajustes.
 */
export const IX_BEZ_SENTINEL = "@bez";

/**
 * Equivalente bezier de cada curva CON NOMBRE — la semilla al pasar a «Curva propia…», para que el
 * autor empiece a deformar la curva que ya tenía puesta, no una genérica. Los seis valores son los
 * mismos `cubic-bezier` de `IX_EASINGS`; `bounce`/`elastic` no son beziers (son físicas muestreadas
 * a `linear()`), así que caen al `ease` estándar de CSS, igual que un paso sin curva declarada.
 */
export const IX_BEZ_SEEDS: Readonly<Record<string, IxBez>> = Object.freeze({
  linear: [0, 0, 1, 1],
  in: [0.4, 0, 1, 1],
  out: [0.16, 1, 0.3, 1],
  "in-out": [0.65, 0, 0.35, 1],
  spring: [0.34, 1.56, 0.64, 1],
  back: [0.68, -0.55, 0.27, 1.55],
});

/** El `ease` de CSS: la semilla de `bounce`/`elastic` y de un paso sin curva declarada. */
const IX_BEZ_SEED_DEFAULT: IxBez = [0.25, 0.1, 0.25, 1];

/** La semilla para un nombre de curva (o su ausencia). Devuelve SIEMPRE una copia fresca. */
export function ixBezSeed(ease?: string): IxBez {
  const seed = ease !== undefined ? IX_BEZ_SEEDS[ease] : undefined;
  return seed ? [...seed] : [...IX_BEZ_SEED_DEFAULT];
}

/* ------------------------------------------------------------------ */
/* Geometría del dibujo                                                */
/* ------------------------------------------------------------------ */

/** Lado del cuadrado unitario en unidades del viewBox. */
const S = 100;
/** Margen del viewBox: los tiradores y su anillo de foco en el borde no se recortan. */
const PAD = 8;
const VIEW = `${-PAD} ${-PAD} ${S + 2 * PAD} ${S + 2 * PAD}`;

/** easing → viewBox. La Y comprime 2:1 para que quepa el rebasamiento (-0.5..1.5) en un cuadrado. */
const sx = (x: number): number => x * S;
const sy = (y: number): number => 75 - y * 50;

/** Lo que el arrastre puede alcanzar: exactamente lo visible. El resto lo cubren los números. */
const DRAG_Y_MIN = -0.5;
const DRAG_Y_MAX = 1.5;
/** El tope real de Y (el mismo ±4 del normalizador) — el rango de los campos numéricos. */
const Y_MAX = 4;

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => round2(n).toFixed(2);

/* ------------------------------------------------------------------ */
/* Un campo numérico                                                   */
/* ------------------------------------------------------------------ */

interface BezNumberProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
}

function BezNumber({ id, label, value, min, max, onCommit }: BezNumberProps) {
  // Mientras se teclea manda el TEXTO local: sin él, un "-" o un "0." intermedios se pisarían con
  // el valor canónico en cada pulsación y no se podría escribir un negativo. Al salir del campo se
  // vuelve a enseñar el valor de verdad.
  const [text, setText] = useState<string | null>(null);
  return (
    <div>
      <label htmlFor={id} className="mb-0.5 block text-[10px] font-medium opacity-70">
        {label}
      </label>
      <input
        id={id}
        type="number"
        step={0.01}
        min={min}
        max={max}
        className="w-full rounded border border-current/30 bg-transparent px-1.5 py-1 text-xs"
        value={text ?? String(value)}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n)) onCommit(clamp(n, min, max));
        }}
        onBlur={() => setText(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* El editor                                                           */
/* ------------------------------------------------------------------ */

export interface IxCurveEditorProps {
  /** id para un `<label htmlFor>` externo; se aplica al primer campo numérico (X1). */
  id?: string;
  value: IxBez;
  onChange: (bez: IxBez) => void;
}

/** Los cuatro campos numéricos, en el orden del dato. */
const NUM_FIELDS = [
  { label: "X1", index: 0, min: 0, max: 1 },
  { label: "Y1", index: 1, min: -Y_MAX, max: Y_MAX },
  { label: "X2", index: 2, min: 0, max: 1 },
  { label: "Y2", index: 3, min: -Y_MAX, max: Y_MAX },
] as const;

export default function IxCurveEditor({ id, value, onChange }: IxCurveEditorProps) {
  const baseId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Qué tirador se está arrastrando. Ref y no estado: el arrastre no cambia el markup por sí
  // mismo (lo cambia el valor nuevo que sube por onChange).
  const dragRef = useRef<0 | 1 | null>(null);
  const [focused, setFocused] = useState<0 | 1 | null>(null);
  const [announce, setAnnounce] = useState("");

  const [x1, y1, x2, y2] = value;

  const setPoint = (i: 0 | 1, x: number, y: number): void => {
    const next: IxBez = [...value];
    next[i * 2] = x;
    next[i * 2 + 1] = y;
    onChange(next);
  };

  /** Coordenadas de puntero → easing, acotadas al arrastre. El elemento es cuadrado (mismo
   *  aspecto que el viewBox), así que la escala es uniforme y no hace falta matriz. */
  const fromClient = (e: React.PointerEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return null;
    const scale = rect.width / (S + 2 * PAD);
    const vx = (e.clientX - rect.left) / scale - PAD;
    const vy = (e.clientY - rect.top) / scale - PAD;
    return {
      x: clamp(round2(vx / S), 0, 1),
      y: clamp(round2((75 - vy) / 50), DRAG_Y_MIN, DRAG_Y_MAX),
    };
  };

  const nudge = (i: 0 | 1, dx: number, dy: number): void => {
    const nx = clamp(round2(value[i * 2] + dx), 0, 1);
    const ny = clamp(round2(value[i * 2 + 1] + dy), -Y_MAX, Y_MAX);
    setPoint(i, nx, ny);
    setAnnounce(`Punto de control ${i + 1}: x ${fmt(nx)}, y ${fmt(ny)}`);
  };

  return (
    <div role="group" aria-label="Editor de curva (cubic-bezier)" className="w-full max-w-xs">
      <svg
        ref={svgRef}
        viewBox={VIEW}
        className="block w-full select-none rounded border border-current/20"
        style={{ aspectRatio: "1 / 1" }}
      >
        {/* Rejilla ligera, cada 0,25 en las dos direcciones del área visible. */}
        {[0, 0.25, 0.5, 0.75, 1].map((gx) => (
          <line
            key={`v${gx}`}
            x1={sx(gx)}
            y1={sy(1.5)}
            x2={sx(gx)}
            y2={sy(-0.5)}
            stroke="currentColor"
            strokeWidth={0.5}
            opacity={0.15}
          />
        ))}
        {[-0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5].map((gy) => (
          <line
            key={`h${gy}`}
            x1={0}
            y1={sy(gy)}
            x2={S}
            y2={sy(gy)}
            stroke="currentColor"
            strokeWidth={0.5}
            opacity={0.15}
          />
        ))}
        {/* El cuadrado unitario (0,0)→(1,1): el marco de referencia del rebasamiento. */}
        <rect
          x={0}
          y={sy(1)}
          width={S}
          height={sy(0) - sy(1)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.3}
        />
        {/* La curva, de (0,0) a (1,1). */}
        <path
          d={`M 0 ${sy(0)} C ${sx(x1)} ${sy(y1)}, ${sx(x2)} ${sy(y2)}, ${S} ${sy(1)}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.9}
        />
        {/* Anclas fijas de los extremos. */}
        <circle cx={0} cy={sy(0)} r={2.5} fill="currentColor" opacity={0.6} />
        <circle cx={S} cy={sy(1)} r={2.5} fill="currentColor" opacity={0.6} />

        {([0, 1] as const).map((i) => {
          const hx = i === 0 ? x1 : x2;
          const hy = i === 0 ? y1 : y2;
          const ax = i === 0 ? 0 : S;
          const ay = i === 0 ? sy(0) : sy(1);
          return (
            <g key={i}>
              {/* Del ancla a su tirador. */}
              <line
                x1={ax}
                y1={ay}
                x2={sx(hx)}
                y2={sy(hy)}
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.45}
              />
              {/* Anillo de foco propio (ver la cabecera). */}
              {focused === i && (
                <circle
                  cx={sx(hx)}
                  cy={sy(hy)}
                  r={8}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  opacity={0.8}
                />
              )}
              <circle
                cx={sx(hx)}
                cy={sy(hy)}
                r={5}
                fill="currentColor"
                tabIndex={0}
                role="button"
                aria-label={`Punto de control ${i + 1} (x ${fmt(hx)}, y ${fmt(hy)})`}
                style={{ cursor: "grab", touchAction: "none", outline: "none" }}
                onFocus={() => setFocused(i)}
                onBlur={() => setFocused(null)}
                onPointerDown={(e) => {
                  dragRef.current = i;
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (dragRef.current !== i) return;
                  const p = fromClient(e);
                  if (p) setPoint(i, p.x, p.y);
                }}
                onPointerUp={() => {
                  dragRef.current = null;
                }}
                onPointerCancel={() => {
                  dragRef.current = null;
                }}
                onKeyDown={(e) => {
                  const delta = e.shiftKey ? 0.01 : 0.05;
                  const d: [number, number] | null =
                    e.key === "ArrowLeft"
                      ? [-delta, 0]
                      : e.key === "ArrowRight"
                        ? [delta, 0]
                        : e.key === "ArrowUp"
                          ? [0, delta]
                          : e.key === "ArrowDown"
                            ? [0, -delta]
                            : null;
                  if (!d) return;
                  e.preventDefault();
                  nudge(i, d[0], d[1]);
                }}
              />
            </g>
          );
        })}
      </svg>

      {/* El camino accesible canónico: mismo valor, rango completo. */}
      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5">
        {NUM_FIELDS.map((f) => (
          <BezNumber
            key={f.label}
            id={id !== undefined && f.index === 0 ? id : `${baseId}-${f.label}`}
            label={f.label}
            value={value[f.index]}
            min={f.min}
            max={f.max}
            onCommit={(n) => setPoint((f.index < 2 ? 0 : 1) as 0 | 1, ...pointFor(value, f.index, n))}
          />
        ))}
      </div>

      {/* Lo que anuncian las flechas: la posición NUEVA del tirador movido. */}
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </div>
  );
}

/** El par (x, y) del tirador dueño del componente `index`, con `n` en el hueco que toque. */
function pointFor(value: IxBez, index: 0 | 1 | 2 | 3, n: number): [number, number] {
  const base = index < 2 ? 0 : 2;
  const x = index === base ? n : value[base];
  const y = index === base + 1 ? n : value[base + 1];
  return [x, y];
}

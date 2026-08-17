"use client";
/**
 * Verso — EL SCRUBBER, lado panel (§6.3 de la spec, F9-D).
 *
 * Por qué esto NO es un `VersoField` y no sale de `VersoFieldControl` como el resto del panel: un
 * campo escribe en el documento, y esto no escribe NADA. No hay `onChange`, no hay `transact`, no
 * hay historia: es un mando de transporte que mueve el estado del lienzo y lo devuelve al soltarlo.
 * Meterlo en el contrato de campos (que además no tiene tipo `range`, y ese contrato es público)
 * habría sido ampliar una superficie pública para algo que no es un dato.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ UN INTERRUPTOR EXPLÍCITO Y NO «AL SOLTAR EL RATÓN»
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * La spec dice «al soltar, se retira». Con el ratón eso es evidente; con el teclado NO EXISTE
 * soltar: se llega al deslizador con el tabulador y se mueve con las flechas, y no hay ningún gesto
 * que signifique "ya he terminado". Un scrubber que solo se pudiera retirar soltando el ratón sería
 * un scrubber que quien navega con teclado no puede apagar — y dejaría el bloque congelado en su
 * último fotograma sin manera de recuperarlo.
 *
 * Así que el modo se ARMA y se SUELTA con un botón (`aria-pressed`), y el deslizador solo está
 * habilitado mientras está armado. El ratón sigue funcionando igual de bien y el teclado funciona
 * de verdad. Al desmontar, se suelta: nunca se sale de aquí con el lienzo bajo control del panel.
 *
 * ANUNCIO (AA): el valor lo anuncia el propio `input[type=range]` al cambiar — es lo que hace un
 * `slider` nativo y es lo que un lector de pantalla espera. No se añade una región `aria-live` con
 * el porcentaje: duplicaría el anuncio en cada pulsación de flecha, que es la forma más rápida de
 * que alguien apague el lector. Lo que sí se anuncia aparte es el CAMBIO DE MODO, que el botón no
 * dice solo.
 */
import React, { useCallback, useEffect, useId, useState } from "react";
import MSym from "@/components/editor/MSym";

const LABEL_CLS = "block text-xs font-medium text-[var(--ed-on-surface-variant)] mb-1";
const BTN =
  "rounded border border-[var(--ed-outline-variant)] px-2 py-1 text-[11px] text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] disabled:opacity-40";

export interface IxScrubberControlProps {
  /** Hay una interacción compilable en el bloque: sin ella no hay nada que recorrer. */
  enabled: boolean;
  /**
   * `true` cuando el progreso lo marca el SCROLL (`scrub`, o `view` que va y viene). Solo cambia el
   * texto de ayuda: recorrer una animación temporal a mano también es útil, y sale del mismo IR.
   */
  scrollDriven: boolean;
  /** Emite el porcentaje al lienzo; `null` = soltar. Inyectable para tests. */
  onScrub: (pct: number | null) => void;
  /**
   * `transport` (dock de movimiento): UNA sola fila compacta — botón «Recorrer» (que arma y hace
   * de etiqueta visible), deslizador y gemelo numérico, con las medidas de la referencia Stitch
   * (28px, radio 2px, texto 11px) y el estado de modo como `sr-only` (el transporte no lleva
   * texto de ayuda). El comportamiento — armar/soltar, un solo camino de escritura — es EL MISMO;
   * solo cambia la carcasa. Sin variante, la columna del inspector de siempre.
   */
  variant?: "transport";
}

export default function IxScrubberControl({ enabled, scrollDriven, onScrub, variant }: IxScrubberControlProps) {
  const id = useId();
  const [armed, setArmed] = useState(false);
  const [pct, setPct] = useState(0);

  const release = useCallback(() => {
    setArmed(false);
    onScrub(null);
  }, [onScrub]);

  // Desmontar (cambiar de bloque, cerrar el panel) SUELTA. Sin esto el lienzo se quedaría con una
  // animación pausada sobre un elemento que ya nadie controla.
  useEffect(() => () => onScrub(null), [onScrub]);

  // Si la interacción desaparece (el autor la quita mientras recorre), el modo se cae solo.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- soltar es sincronizar el lienzo (sistema externo) Y bajar el modo; el booleano que se escribe apaga la propia condición, así que no hay cascada
    if (!enabled && armed) release();
  }, [enabled, armed, release]);

  const arm = () => {
    setArmed(true);
    onScrub(pct);
  };

  // El ÚNICO camino de escritura del porcentaje: lo comparten el deslizador y su gemelo numérico,
  // para que los dos muevan el lienzo exactamente igual. El clamp solo trabaja para el numérico
  // (un `type=number` acepta teclear fuera de rango; el deslizador ya vive en 0..100), y un valor
  // no numérico (el campo vaciado a medio teclear) se ignora sin mover nada.
  const move = (next: number): void => {
    if (!Number.isFinite(next)) return;
    const v = Math.min(100, Math.max(0, Math.round(next)));
    setPct(v);
    if (armed) onScrub(v);
  };

  // La fila del TRANSPORTE (dock): las mismas piezas y el mismo camino de escritura, con la
  // geometría EXACTA de la referencia — grupo de 240px a la derecha, «Recorrer» como texto plano
  // (sigue siendo un botón que arma/suelta: aria-pressed), pista flexible y caja del porcentaje.
  if (variant === "transport") {
    return (
      <div className="ml-auto flex w-[240px] shrink-0 items-center gap-3">
        <button
          type="button"
          className="shrink-0 text-[11px] text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
          disabled={!enabled}
          aria-pressed={armed}
          title={
            armed
              ? "Soltar el recorrido y devolver el lienzo"
              : scrollDriven
                ? "Recorrer a mano una interacción que avanza con el scroll"
                : "Recorrer la animación a mano y pararse en cualquier punto"
          }
          onClick={() => (armed ? release() : arm())}
        >
          {armed ? "Soltar" : "Recorrer"}
        </button>
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          disabled={!enabled || !armed}
          aria-label="Recorrer a mano"
          aria-valuetext={`${pct} %`}
          className="min-w-0 flex-1 accent-[var(--ed-primary)]"
          onChange={(e) => move(Number(e.target.value))}
        />
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={pct}
          disabled={!enabled || !armed}
          aria-label="Recorrido a mano (%)"
          className="h-6 w-12 shrink-0 rounded-[2px] border border-[var(--ed-outline-variant)] bg-[var(--ed-surface)] px-1.5 text-right text-[11px] text-[var(--ed-on-surface)] disabled:opacity-40"
          onChange={(e) => e.target.value !== "" && move(Number(e.target.value))}
        />
        {/* El cambio de MODO se anuncia igual; el transporte no lleva texto de ayuda visible. */}
        <p role="status" className="sr-only">
          {!enabled
            ? "Sin interacción que recorrer."
            : armed
              ? "Recorriendo a mano: el lienzo muestra el estado intermedio."
              : "Recorrido a mano disponible."}
        </p>
      </div>
    );
  }

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={id} className={`${LABEL_CLS} mb-0`}>
          Recorrer a mano ({pct} %)
        </label>
        <button
          type="button"
          className={BTN}
          disabled={!enabled}
          aria-pressed={armed}
          onClick={() => (armed ? release() : arm())}
        >
          {/* ⚠ La fuente de iconos del editor es un SUBSET generado por nombre: un glifo que no esté
              en él se pinta como su texto de ligadura ("stop_circle" en crudo, visto en el
              navegador). Estos dos ya se usan en el chrome, así que están dentro. */}
          <MSym name={armed ? "close" : "tune"} size={12} className="align-[-2px]" />{" "}
          {armed ? "Soltar" : "Recorrer"}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          disabled={!enabled || !armed}
          // El deslizador nativo ya anuncia su valor; `aria-valuetext` solo le pone la unidad, para
          // que se lea "37 por ciento" y no un 37 suelto que no dice de qué.
          aria-valuetext={`${pct} %`}
          className="w-full accent-[var(--ed-primary)]"
          onChange={(e) => move(Number(e.target.value))}
        />
        {/* El gemelo NUMÉRICO del deslizador (P13): teclear "37" y llegar exacto, sin flechas ni
            arrastre. Mismo camino de escritura (`move`), mismo armado. La etiqueta visible del
            grupo apunta al deslizador, así que este lleva su propio nombre por `aria-label` (un
            `for` no puede señalar a dos controles). */}
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={pct}
          disabled={!enabled || !armed}
          aria-label="Recorrido a mano (%)"
          className="w-14 shrink-0 rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] px-1.5 py-0.5 text-right text-[11px] text-[var(--ed-on-surface)] disabled:opacity-40"
          // Vaciar el campo a medio teclear NO es pedir el 0 (`Number("")` lo es): se ignora.
          onChange={(e) => e.target.value !== "" && move(Number(e.target.value))}
        />
      </div>
      {/* El cambio de MODO sí necesita anunciarse: el botón cambia de nombre, pero lo que cambia de
          verdad es quién manda sobre el lienzo. */}
      <p role="status" className="text-[10px] text-[var(--ed-outline)] mt-1">
        {!enabled
          ? "Sin interacción que recorrer."
          : armed
            ? "Recorriendo a mano: el lienzo muestra el estado intermedio."
            : scrollDriven
              ? "Esta interacción avanza con el scroll: recórrela a mano para ver los pasos intermedios."
              : "Recórrela a mano para pararte en cualquier punto de la animación."}
      </p>
    </div>
  );
}

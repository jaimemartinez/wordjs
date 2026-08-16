"use client";
/**
 * Verso — seam de campos compartidos (el rol de `withSharedBlockFields` en el editor actual,
 * frontend/src/components/blocks/VisibilityField.tsx).
 *
 * `withSharedVersoFields(def)` envuelve TODA `BlockDefinition` en el punto de REGISTRO e inyecta
 * los 3 campos comunes — `hide` (visibilidad por dispositivo), `anim` (animación de entrada +
 * efecto de scroll) y `look` (apariencia completa) — con LOS MISMOS defaultProps que el wrapper
 * actual, byte a byte (verificado programáticamente en verso-coreBlocks.test.ts contra
 * versoConfig.tsx):
 *   hide: {}   anim: { type: "fade-up", duration: 600, delay: 0 }   look: {}
 *
 * DIFERENCIA DELIBERADA con withSharedBlockFields: este seam NO toca `def.render`. El wrapper
 * visual (las 4 ramas nada / solo-look / solo-hide / AnimatedShell, y las 2 capas anim↔apariencia
 * que jamás comparten elemento) lo pone VersoBlock vía SharedBlockShell — la MISMA implementación
 * (blockShell.ts) que usa el sitio público, así que la paridad canvas↔público es por construcción.
 *
 * Controles del panel: se REUTILIZAN VisibilityControl / AnimationControl / AppearanceControl tal
 * cual. Decisión examinada (encargo F3): los tres son componentes `{ value, onChange }` puros —
 * cero imports de @wordjs/puck ni de PuckEditor (solo MSym/CSSControls/blockShell) — así que son
 * agnósticos del motor y se montan como `custom` VersoField sin adaptador.
 *
 * Clamps de seguridad: el editor actual clampa duration/delay al RENDER (VisibilityField wrapper y
 * AnimatedShell: 100–3000ms / 0–3000ms) porque `_puck_data` hostil (API/WXR) puede traer un delay
 * de horas. Verso conserva ese clamp de render (SharedBlockShell→AnimatedShell) y ADEMÁS clampa en
 * la frontera de escritura del campo (`clampAnimSpec` en el onChange de `anim`): un valor fuera de
 * rango nunca llega al documento desde el panel.
 *
 * Opt-out: idéntico al actual — una definición que YA declare `fields.hide` (o no tenga render) se
 * devuelve intacta, sin inyección. Es el único mecanismo de opt-out y algún bloque puede depender
 * de él (contrato duro de f0-audit-core.md).
 */
import React from "react";
import { VisibilityControl } from "@/components/blocks/VisibilityField";
import { AnimationControl } from "@/components/blocks/AnimationField";
import { AppearanceControl } from "@/components/blocks/AppearanceField";
import type { AnimSpec, Appearance, Hide } from "@/components/blocks/blockShell";
import type { BlockDefinition, VersoField } from "./registry";

/* ------------------------------------------------------------------ */
/* Clamp de seguridad de la animación (mismos límites que el render).  */
/* ------------------------------------------------------------------ */

/** Piso/techo de `anim.duration` (ms) — mismos valores que VisibilityField/AnimatedShell. */
export const ANIM_DURATION_MIN = 100;
export const ANIM_DURATION_MAX = 3000;
/** Piso/techo de `anim.delay` (ms). */
export const ANIM_DELAY_MIN = 0;
export const ANIM_DELAY_MAX = 3000;

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Clampa duration/delay de un AnimSpec a los límites de seguridad. Solo toca claves PRESENTES y
 * numéricas: un spec sin duration sigue sin duration (el default 600ms lo aplica el render, igual
 * que hoy) — así los datos escritos por el panel Verso son byte-compatibles con los del editor
 * actual salvo que el valor estuviera fuera de rango.
 */
export function clampAnimSpec(value: AnimSpec | undefined): AnimSpec {
  const anim = value || {};
  const out: AnimSpec = { ...anim };
  if (typeof anim.duration === "number" && Number.isFinite(anim.duration)) {
    out.duration = clampNumber(anim.duration, ANIM_DURATION_MIN, ANIM_DURATION_MAX);
  }
  if (typeof anim.delay === "number" && Number.isFinite(anim.delay)) {
    out.delay = clampNumber(anim.delay, ANIM_DELAY_MIN, ANIM_DELAY_MAX);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Defaults compartidos (mismos literales que withSharedBlockFields).  */
/* ------------------------------------------------------------------ */

/** defaultProps que gana todo bloque envuelto — objetos FRESCOS por llamada (nunca compartidos). */
export function sharedFieldDefaults(): Record<string, unknown> {
  return {
    hide: {},
    anim: { type: "fade-up", duration: 600, delay: 0 },
    look: {},
  };
}

/* ------------------------------------------------------------------ */
/* El seam.                                                            */
/* ------------------------------------------------------------------ */

/**
 * Envuelve una definición con los 3 campos compartidos. Aplicar SIEMPRE en el punto de registro
 * (registerCoreBlocks lo hace para el core; F4 deberá hacerlo para los bloques de plugin).
 */
export function withSharedVersoFields(def: BlockDefinition): BlockDefinition {
  // Mismo criterio de opt-out que withSharedBlockFields: sin render, o `hide` ya declarado.
  if (!def.render || def.fields.hide) return def;

  const fields: Record<string, VersoField> = {
    ...def.fields,
    hide: {
      type: "custom",
      label: "Visibilidad por dispositivo",
      render: ({ value, onChange }) => (
        <VisibilityControl value={(value as Hide) || {}} onChange={onChange} />
      ),
    },
    anim: {
      type: "custom",
      label: "Animación de entrada",
      render: ({ value, onChange }) => (
        <AnimationControl
          value={(value as AnimSpec) || {}}
          onChange={(v) => onChange(clampAnimSpec(v))}
        />
      ),
    },
    look: {
      type: "custom",
      label: "Apariencia",
      render: ({ value, onChange }) => (
        <AppearanceControl value={(value as Appearance) || {}} onChange={onChange} />
      ),
    },
  };

  return {
    ...def,
    fields,
    defaultProps: {
      ...def.defaultProps,
      ...sharedFieldDefaults(),
    },
  };
}

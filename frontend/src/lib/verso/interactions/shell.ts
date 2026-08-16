/**
 * Verso — interacciones: LO QUE EL BLOQUE ESTAMPA (contrato compartido canvas ↔ público).
 *
 * Módulo hermano de `components/blocks/blockShell.ts`: mismas reglas (puro, sin `"use client"`, sin
 * React, solo tipos), así que las DOS superficies de render lo llaman y por construcción emiten
 * exactamente el mismo markup. `blockShell.ts` lo reexporta para que exista UN solo sitio al que
 * mire el wrapper.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * DÓNDE ENCAJA LA CAPA DE INTERACCIONES — la decisión, y por qué
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * El wrapper compartido tiene hoy DOS capas anidadas que jamás comparten elemento:
 *
 *     ① ENTRADA  .wjs-anim …            ← `animation` + `animation-fill-mode: both`
 *       └ ② APARIENCIA  .wjs-fx …       ← caja, `:hover`, `transition`
 *         └ contenido del bloque
 *
 * Están separadas porque `animation-fill-mode: both` congela el estado final de la entrada y eso
 * MATA el `:hover` de la apariencia si comparten elemento. La interacción tiene el mismo problema,
 * duplicado: usa `animation` (choca con ① por la propiedad `animation` y por `transform`) y usa
 * `:hover`/`transition` (choca con ②).
 *
 * DECISIÓN: una TERCERA capa, entre la entrada y la apariencia.
 *
 *     ① ENTRADA  .wjs-anim …
 *       └ ③ INTERACCIÓN  .wjs-ix-<hash>  ← este módulo
 *         └ ② APARIENCIA  .wjs-fx …
 *           └ contenido
 *
 * Tres razones, en orden de peso:
 *
 *  1. **La composición sale gratis.** Los `transform` de elementos ANIDADOS se componen (se
 *     multiplican las matrices); los de un mismo elemento se sobreescriben por propiedad. Con la
 *     interacción en su propia capa, una entrada que sube 28px y un paralaje de scroll conviven
 *     sin pelearse. Esto RETIRA de golpe la verruga que `wordjs-ui.css` documenta hoy ("cuando hay
 *     efecto de scroll, GANA el scroll", reglas 0,3,0) — para las unidades `ix`, nada tiene que
 *     ganar a nada.
 *  2. **Dentro de la entrada, no fuera.** Fuera de ① la interacción envolvería al elemento que la
 *     entrada anima, y un `scale` de scroll aplicado sobre el wrapper de entrada haría que el
 *     `fill-mode: both` de la entrada operase dentro de una caja ya escalada. Dentro, el orden de
 *     aplicación es el natural: primero la entrada del bloque, luego su interacción.
 *  3. **`:hover` limpio.** ③ tiene su propio `:hover` sin `animation-fill-mode` heredado de nadie,
 *     y ② conserva el suyo intacto. Ninguna de las dos tiene que saber que la otra existe.
 *
 * La capa ③ es un elemento real (un `<div>`), NUNCA `display: contents`: un elemento sin caja no
 * puede transformarse ni recortarse. Solo se emite cuando hay interacción — un bloque sin `ix` no
 * gana ningún elemento y su markup es byte-idéntico al de hoy.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 */
import type { CSSProperties } from "react";

import { compileIx, ixClassFor, type IxCompileCtx } from "./compile";
import { SYS_IX_PRESETS } from "./presets";
import type { IxNeedsRuntime, IxPage, IxUnit } from "./types";

/**
 * Contexto de compilación MÍNIMO: solo los presets del SISTEMA.
 *
 * Es el que se usa cuando quien renderiza no ha leído ajustes del sitio. Vive aquí y no en cada
 * superficie porque tenerlo declarado dos veces es tenerlo declarado mal: el wrapper compartido, el
 * canvas y los bloques que consultan su propio `ix` tienen que caer todos en el MISMO catálogo por
 * defecto, o un preajuste del sistema resolvería en una superficie y no en la otra.
 *
 * Un tema JAMÁS aporta presets: la frontera del proyecto es que un tema es su contrato de tokens y
 * no decide cuándo se mueve el contenido.
 */
export const IX_SYS_CTX: IxCompileCtx = { presets: SYS_IX_PRESETS };

/** Lo que la capa ③ necesita para renderizarse. `null` = no hay capa (el caso normal). */
export type IxLayer = {
  className: string;
  /**
   * Reservado para los escalares por bloque (`--wjs-ixv-*`: intensidad, índice de palabra…), que
   * viajan inline mientras las REGLAS viven en la hoja — el mismo reparto que ya usa el contrato de
   * bloques. Hoy siempre vacío: F9-A no tiene panel que produzca escalares.
   */
  style: CSSProperties;
  /** Solo atributos `data-*`. El runtime escribe `data-wjs-ix`; el servidor NUNCA lo hace. */
  attrs: Record<string, string>;
  needsRuntime: IxNeedsRuntime;
  unit: IxUnit;
};

/** Atributo de estado que maneja EXCLUSIVAMENTE el runtime (`armed` / `in` / `on`). */
export const IX_STATE_ATTR = "data-wjs-ix";
/** Atributo informativo con el disparador — hace el markup autodescriptivo y acota al runtime. */
export const IX_TRIGGER_ATTR = "data-wjs-ix-on";

/**
 * La capa de interacción de un bloque.
 *
 * `page` es opcional: cuando se compila la página entera (el camino de producción) la clase sale de
 * ahí, porque solo ahí se ven todas las unidades y se pueden desambiguar dos cuerpos distintos que
 * reclamen el mismo hash. Sin `page` se usa el hash desnudo — suficiente para el canvas mientras
 * el autor edita un bloque suelto, y determinista igual.
 *
 * El servidor NO estampa `data-wjs-ix`: el HTML servido no oculta nada jamás. El estado inicial de
 * una entrada `once` lo pone el navegador cuando el runtime arma el bloque; un visitante sin JS y
 * un rastreador ven el contenido entero (§7.1 — cero CLS, y nada que "tapar" al estilo IX3).
 */
export function ixLayer(raw: unknown, ctx?: IxCompileCtx, page?: IxPage): IxLayer | null {
  const unit = compileIx(raw, ctx);
  if (!unit) return null;

  const cls = page ? (ixClassFor(raw, page, ctx) ?? unit.cls) : unit.cls;

  return {
    className: cls,
    style: {},
    attrs: { [IX_TRIGGER_ATTR]: unit.body.trigger.on },
    needsRuntime: unit.needsRuntime,
    unit,
  };
}

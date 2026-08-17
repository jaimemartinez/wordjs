/**
 * Verso — el MARKUP del split por palabras (F9-D). Sin `"use client"`: exactamente este código
 * produce los spans del canvas y los del sitio público, que es la única forma de que no diverjan.
 *
 * La decisión de partir y el reparto en palabras viven en `lib/verso/interactions/words.ts` (puro,
 * probado en node). Aquí solo está la traducción a React, y son cuatro líneas a propósito.
 *
 * ⚠ EL CONTRATO DE ACCESIBILIDAD ES DE DOS PIEZAS Y ESTE FICHERO SOLO TIENE UNA.
 * Los spans van `aria-hidden="true"`; el `aria-label` con el texto íntegro lo pone el CONTENEDOR
 * (el `<h2>`, el `<blockquote>`), porque es un atributo suyo y no hay forma de emitirlo desde aquí.
 * Por eso `ixWordSpans` recibe el `IxWordSplit` ENTERO —que trae `words` y `label` juntos— y no un
 * array de palabras: quien tiene las palabras tiene también la etiqueta, y omitirla se ve.
 *
 * Por qué hace falta `aria-hidden` y no basta con partir: `transform` necesita una caja, así que
 * cada palabra es `display: inline-block` (regla estática en `wordjs-ui.css`). Una caja por palabra
 * es justo lo que hace que un lector de pantalla las trate como fragmentos independientes y lea
 * "Hola." "mundo." en vez de la frase. Ocultando los spans y nombrando el contenedor, el árbol de
 * accesibilidad ve UN nodo con el texto completo y cero nodos de texto sueltos.
 */
import React from "react";
import {
  IX_WORD_CLASS,
  IX_WORD_COUNT_VAR,
  IX_WORD_INDEX_VAR,
  type IxWordSplit,
} from "@/lib/verso/interactions";

/**
 * Las palabras como spans, separadas por un espacio de texto normal.
 *
 * El espacio va FUERA del span (un espacio final dentro de un `inline-block` se recorta y las
 * palabras se pegarían) y solo entre palabras, nunca al principio: el texto renderizado es
 * carácter a carácter `split.label`.
 *
 * `--wjs-ixv-i` es el índice que lee el `calc()` del escalonado que emite el compilador
 * (`calc(var(--wjs-ixv-i, 0) * Nms + …)`). Se emite SIEMPRE, haya escalonado o no: el valor por
 * defecto del `var()` ya cubre el caso sin escalonado, pero emitirlo de forma condicional haría que
 * el markup dependiese de una parte del dato que el bloque no debería tener que mirar.
 */
export function ixWordSpans(split: IxWordSplit): React.ReactNode {
  return split.words.map((word, i) => (
    <React.Fragment key={i}>
      {i > 0 ? " " : null}
      <span
        className={IX_WORD_CLASS}
        // El RECUENTO viaja junto al índice (P13): con los dos, el `calc()` del compilador puede
        // escalonar también desde el final o el centro con exactitud. En cada span y no en el
        // contenedor: el span es autocontenido y el contrato del bloque no crece.
        style={{ [IX_WORD_INDEX_VAR]: i, [IX_WORD_COUNT_VAR]: split.words.length } as React.CSSProperties}
        aria-hidden="true"
      >
        {word}
      </span>
    </React.Fragment>
  ));
}

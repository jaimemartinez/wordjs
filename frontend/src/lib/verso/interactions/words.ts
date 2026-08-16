/**
 * Verso — interacciones: EL SPLIT POR PALABRAS (§3.4.1 de la spec, F9-D).
 *
 * El compilador ya sabía emitir `.wjs-ix-<hash> .wjs-ixw { … }` y el retardo por hermano con
 * `calc(var(--wjs-ixv-i, 0) * Nms + …)`. Lo que faltaba era que ALGUIEN emitiera esos spans. Esto es
 * la mitad PURA de ese trabajo: decide si hay que partir y en qué, sin React y sin DOM, para que el
 * canvas y el sitio público llamen a la MISMA función y no puedan divergir.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LAS DOS CONDICIONES INNEGOCIABLES, y dónde las impone este módulo
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. **Un bloque SIN esta interacción sale byte-idéntico al de hoy.** Aquí eso es
 *    `ixTargetsWords()`: devuelve `false` para absolutamente todo lo que no sea una interacción ya
 *    resuelta (preajuste incluido) con una pista cuyo objetivo sea `words`. El bloque solo consulta
 *    esta función y, si dice que no, RETORNA SU JSX DE SIEMPRE. No se envuelve nada "por si acaso":
 *    no hay una rama del render que envuelva palabras sin que el dato lo pida.
 *
 * 2. **Accesibilidad.** Partir un titular en spans es peligroso porque `transform` obliga a
 *    `display: inline-block` (una caja sin caja no se transforma), y una caja por palabra es
 *    exactamente lo que hace que VoiceOver lea "Hola." "mundo." en vez de la frase. La respuesta es
 *    la de la spec: el CONTENEDOR lleva `aria-label` con el texto íntegro y cada span va
 *    `aria-hidden="true"`, así que el árbol de accesibilidad ve UN nodo con la frase entera y cero
 *    nodos de texto sueltos. Este módulo devuelve las dos cosas juntas (`words` y `label`) para que
 *    ningún llamante pueda emitir una sin la otra, y `label` es EXACTAMENTE `words.join(" ")`: lo
 *    que se lee y lo que se ve no pueden discrepar porque salen de la misma lista.
 *
 * FAIL-OPEN, como todo el motor: cuando no se puede partir con garantías (texto con markup, más de
 * `IX_MAX_WORDS` palabras, texto vacío) se devuelve `null` y el bloque se pinta como siempre. Se
 * pierde el movimiento, nunca el contenido.
 */
import { resolveIxBody, type IxCompileCtx } from "./compile";
import { IX_MAX_WORDS } from "./normalize";

/** La clase del span de cada palabra. El compilador emite `<sel> .wjs-ixw` contra ella. */
export const IX_WORD_CLASS = "wjs-ixw";

/*
 * El nombre de la variable del índice (`--wjs-ixv-i`) NO se declara aquí: lo posee `compile.ts`
 * (`IX_WORD_INDEX_VAR`), que es quien escribe el `var()` que la lee. Dos constantes con el mismo
 * valor en dos ficheros es una sola constante esperando a desincronizarse.
 */

/**
 * ¿La interacción de este bloque mueve LAS PALABRAS?
 *
 * Se resuelve por el cuerpo COMPILADO, no por el dato crudo: un bloque puede llevar solo
 * `{ v: 1, preset: "titular-en-cascada" }` y el objetivo `words` vivir dentro del preajuste, en
 * ajustes del sitio. Por eso hace falta el contexto — y por eso el canvas también tiene que
 * pasárselo (si no, un preajuste del sitio partiría en el público y no en el editor).
 *
 * Nunca lanza: `resolveIxBody` ya trata su entrada como hostil y devuelve `null` ante cualquier cosa
 * que no entienda.
 */
export function ixTargetsWords(raw: unknown, ctx?: IxCompileCtx): boolean {
  if (raw === undefined || raw === null) return false;
  const resolved = resolveIxBody(raw, ctx);
  if (!resolved) return false;
  return resolved.body.tracks.some((t) => t.target.kind === "words");
}

/** Las palabras y el texto íntegro que las nombra. `null` = no se parte (y el bloque no cambia). */
export type IxWordSplit = {
  /** Las palabras, en orden. Cada una va en su `<span class="wjs-ixw">`. */
  words: string[];
  /** El texto completo para el `aria-label` del contenedor. Siempre `words.join(" ")`. */
  label: string;
};

export interface IxSplitOptions {
  /**
   * `true` cuando el bloque pinta ese texto como HTML (`dangerouslySetInnerHTML`: Heading, Text).
   *
   * Entonces el split se NIEGA en cuanto el texto trae `<`, `>` o `&`, y no es paranoia de más:
   *
   *  · con `<` el texto lleva markup, y repartir `<em>dos palabras</em>` entre dos spans produce
   *    etiquetas sin cerrar — un bloque roto donde antes había un titular en cursiva;
   *  · con `&` o `>` el resultado depende de QUIÉN sanea. `sanitizeHTML` usa `sanitize-html` en el
   *    servidor y DOMPurify en el cliente, y no se garantiza que codifiquen las entidades igual.
   *    Si la decisión de partir dependiese de la salida saneada, servidor y cliente podrían
   *    discrepar en la FORMA DEL ÁRBOL y eso es un fallo de hidratación que
   *    `suppressHydrationWarning` no tapa (solo cubre texto y atributos, no la estructura).
   *
   * La prueba se hace sobre el texto CRUDO justamente para que sea la misma en las dos superficies
   * y en los dos entornos: si no hay `<`, `>` ni `&`, sanear no puede cambiar ni un byte, y las
   * palabras son texto plano que React escapa igual en todas partes.
   */
  html: boolean;
}

/**
 * Texto → palabras, o `null`.
 *
 * `IX_MAX_WORDS` (40) no es un número redondo por gusto: cada palabra es un `inline-block` con su
 * variable inline, y un párrafo de 300 palabras partido son 300 cajas y 300 estilos en línea por
 * un efecto que a esa longitud ya no se percibe. Superado el tope NO se parte —fail-open al texto
 * normal—, en vez de emitir una versión "a medias" que el autor no ha pedido.
 */
export function ixSplitWords(text: unknown, opts: IxSplitOptions): IxWordSplit | null {
  if (typeof text !== "string") return null;
  if (opts.html && /[<>&]/.test(text)) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const words = trimmed.split(/\s+/);
  if (words.length === 0 || words.length > IX_MAX_WORDS) return null;
  // El separador es UN espacio, y el mismo que se emite entre spans: lo que se lee (`label`) y lo
  // que se ve son la misma cadena por construcción, no por coincidencia.
  return { words, label: words.join(" ") };
}

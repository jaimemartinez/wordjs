/**
 * Verso — TRANSICIONES ENTRE PÁGINAS (View Transitions), ciclo 3 · C1.
 *
 * Qué es: dos reglas de CSS que le dan a un sitio multipágina renderizado en SERVIDOR el tacto de
 * una SPA — sin router, sin hidratación, sin un byte de JavaScript en la página del visitante. Es
 * la única capacidad del sector que cumple a la vez las tres reglas duras del motor (nativa,
 * cero JS de terceros, cero CLS), y por eso entra aquí y no en un plugin.
 *
 * POR QUÉ NO ES UNA INTERACCIÓN DE BLOQUE: la navegación es CHROME DEL SITIO. Un `ix` es una prop
 * de bloque; meter aquí la navegación sería mentir sobre quién es el dueño del estado. Este módulo
 * es puro (texto CSS a partir de un ajuste), lo emite el layout público una sola vez por documento,
 * y el motor de interacciones ni se entera.
 *
 * DECISIONES DE EMISIÓN, y su porqué:
 *
 *  · `@view-transition{navigation:auto}` va al NIVEL SUPERIOR, nunca dentro de un `@media`. El
 *    at-rule declara una intención de navegación, no un estilo condicional, y anidarlo arriesga que
 *    un motor lo ignore entero y la función desaparezca en silencio — el fallo más caro posible
 *    aquí. El respeto al movimiento se aplica donde SÍ es un estilo: matando la animación de los
 *    pseudo-elementos bajo `prefers-reduced-motion: reduce`. Resultado con movimiento reducido: la
 *    transición sigue ocurriendo, pero INSTANTÁNEA (corte limpio), que es exactamente lo que pide
 *    esa preferencia — no un fundido más lento.
 *
 *  · Firefox todavía no implementa la variante entre documentos: sin soporte, la regla se ignora y
 *    la navegación es la de siempre. Degradación honesta y sin coste, así que se puede enviar hoy.
 *
 *  · El vocabulario es una LISTA CERRADA (`off`/`fade`/`slide`). El autor elige un nombre; el texto
 *    CSS lo escribe este módulo. Ninguna cadena del autor llega jamás a la hoja de estilos — la
 *    misma invariante que gobierna el resto del motor.
 */

/** Estilos de transición ofrecidos, en orden canónico. `off` = no se emite ni una regla. */
export type IxVtStyle = "off" | "fade" | "slide";

export const IX_VT_STYLES: readonly IxVtStyle[] = Object.freeze(["off", "fade", "slide"]);

/** Duración de la transición, en ms. Corta a propósito: una navegación no es una animación. */
export const IX_VT_DUR_MS = 220;

/** La curva del resto del motor (la de `out`), para que la navegación se sienta del mismo sitio. */
const IX_VT_EASE = "cubic-bezier(.16,1,.3,1)";

/** Recorrido del deslizamiento, en px. */
const IX_VT_SHIFT = 24;

/**
 * Ajuste del sitio (`wjs_view_transitions`) → estilo válido. Dato HOSTIL: lo escribe un admin, pero
 * también puede llegar por importación o restauración de una copia. Cualquier cosa que no esté en
 * la lista cerrada cae a `off` — fail-safe: ante la duda, el sitio no anima.
 */
export function normalizeVtStyle(raw: unknown): IxVtStyle {
    return typeof raw === "string" && (IX_VT_STYLES as readonly string[]).includes(raw)
        ? (raw as IxVtStyle)
        : "off";
}

/**
 * El CSS de la transición, o `""` si está apagada (y entonces el layout no emite ni la etiqueta).
 * Texto determinista y compacto, como el resto del emisor: mismo estilo, comparable byte a byte.
 */
export function compileVtCss(style: IxVtStyle): string {
    if (style === "off") return "";

    const out: string[] = ["@view-transition{navigation:auto}"];

    // EL CHROME SE QUEDA QUIETO. Sin esto, la instantánea `root` incluye cabecera y pie, así que la
    // página entera se funde o se desliza en bloque — bonito, pero indistinguible de recargar. Al
    // darle a cada uno su propio nombre salen del grupo raíz y forman el suyo: con el mismo
    // contenido a ambos lados de la navegación, su morfismo por defecto no produce cambio visible.
    // Resultado: el contenido se mueve y la cabecera ni se inmuta — el gesto que distingue a una
    // aplicación de un sitio.
    //
    // El selector es HIJO DIRECTO del shell a propósito: un bloque de contenido puede pintar su
    // propio <header> dentro de <main>, y un `view-transition-name` DUPLICADO aborta la transición
    // entera (regla del estándar). Hijo directo ⇒ chrome del sitio, único por construcción.
    out.push(
        ".wjs-shell>header{view-transition-name:wjs-vt-header}",
        ".wjs-shell>footer{view-transition-name:wjs-vt-footer}",
    );

    if (style === "fade") {
        // El fundido cruzado ya es el comportamiento por defecto del navegador: aquí solo se fija
        // la duración, para que la navegación tenga el mismo tempo que el resto del movimiento.
        out.push(
            `::view-transition-old(root),::view-transition-new(root){animation-duration:${IX_VT_DUR_MS}ms}`,
        );
    } else {
        // `slide`: la página saliente se va por la izquierda y la entrante llega por la derecha.
        // Solo `opacity` y `transform` — las dos propiedades del compositor, cero reflow.
        out.push(
            `@keyframes wjs-vt-out{to{opacity:0;transform:translate3d(-${IX_VT_SHIFT}px,0,0)}}`,
            `@keyframes wjs-vt-in{from{opacity:0;transform:translate3d(${IX_VT_SHIFT}px,0,0)}}`,
            `::view-transition-old(root){animation:wjs-vt-out ${IX_VT_DUR_MS}ms ${IX_VT_EASE} both}`,
            `::view-transition-new(root){animation:wjs-vt-in ${IX_VT_DUR_MS}ms ${IX_VT_EASE} both}`,
        );
    }

    // Movimiento reducido: la transición ocurre, pero sin animación — un corte instantáneo. El
    // `!important` es el mismo criterio que el kill global de `wordjs-ui.css`: la preferencia del
    // sistema operativo gana SIEMPRE, y ningún ajuste del autor puede desmarcarla.
    out.push(
        "@media (prefers-reduced-motion:reduce){" +
            "::view-transition-group(*),::view-transition-old(*),::view-transition-new(*)" +
            "{animation:none!important}}",
    );

    return out.join("\n");
}

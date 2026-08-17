/**
 * Emite las TRANSICIONES ENTRE PÁGINAS del sitio (ciclo 3 · C1) — dos reglas de CSS y cero JS.
 *
 * Vive en el layout PÚBLICO, no en el renderer de contenido: la navegación es chrome del sitio, y
 * la variante entre documentos exige que la regla esté en el documento que SALE y en el que ENTRA.
 * Al estar en el layout, toda página pública la lleva por construcción.
 *
 * `precedence` es obligatorio por la misma razón que en ThemeLoader: sin él, React 19 deja el
 * `<style>` donde se renderiza (en el cuerpo) y no lo hoistea al `<head>`. Va al grupo `wjs-base`
 * — es chrome del sitio, no estilo del tema ni de la página.
 *
 * El texto lo escribe `compileVtCss` a partir de una lista cerrada: aquí no se concatena nada que
 * venga del ajuste, solo se elige entre variantes ya escritas en código.
 */
import { compileVtCss, normalizeVtStyle } from "@/lib/verso/interactions/viewTransitions";

export default function ViewTransitions({ setting }: { setting?: unknown }) {
    const css = compileVtCss(normalizeVtStyle(setting));
    if (css === "") return null;
    // `href` estable y derivado del CONTENIDO: dos páginas con el mismo ajuste comparten etiqueta
    // (React deduplica por href), y cambiar el estilo cambia el href — nunca se sirve el CSS viejo.
    return (
        <style href={`wjs-vt-${normalizeVtStyle(setting)}`} precedence="wjs-base">
            {css}
        </style>
    );
}

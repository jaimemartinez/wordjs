/**
 * CONTROL DE PAUSA DEL MOVIMIENTO PERPETUO (ciclo 3 · C3) — WCAG 2.2.2, nivel A.
 *
 * La norma es explícita: todo lo que se mueva solo durante más de cinco segundos tiene que poder
 * pausarse, pararse u ocultarse. Un `repeat: "inf"` es el ejemplo literal, y ofrecerlo sin control
 * era una NO-CONFORMIDAD viva justo en el motor que hace bandera de la accesibilidad.
 *
 * CERO JAVASCRIPT, a propósito: una casilla nativa y una regla `:has()` en la hoja del framework
 * (`html:has(#wjs-motion-pause:checked){--wjs-ix-play:paused}`). El compilador ya emite ese token
 * dentro del atajo `animation` de cada bucle infinito, así que marcar la casilla detiene todos a la
 * vez — incluidos los de un preajuste del sitio. Al desmarcarla siguen desde donde estaban, que es
 * lo que «pausar» significa; nada se salta ni se reinicia.
 *
 * Se pinta SOLO si la página tiene movimiento perpetuo (`page.hasInfinite`): una página sin bucles
 * no paga ni un byte, ni enseña un control que no gobernaría nada.
 *
 * Es una casilla de verdad (no un `div` con `onClick`): funciona con teclado, la anuncia el lector
 * de pantalla con su estado, y sobrevive a que el JavaScript no cargue — que es exactamente cuando
 * más falta hace un control de accesibilidad.
 */
import React from "react";

/**
 * Los textos llegan YA resueltos en el idioma del sitio (lib/public/uiStrings, desde el servidor):
 * un sitio en inglés no puede ofrecer «Pausar el movimiento». Sin ellos se conservan los de siempre.
 */
export default function MotionPause({
    pauseLabel = "Pausar el movimiento",
    resumeLabel = "Reanudar el movimiento",
}: { pauseLabel?: string; resumeLabel?: string }) {
    return (
        <div className="wjs-motion-pause">
            <input type="checkbox" id="wjs-motion-pause" className="wjs-motion-pause__input" />
            <label htmlFor="wjs-motion-pause" className="wjs-motion-pause__label">
                <span className="wjs-motion-pause__on">{pauseLabel}</span>
                <span className="wjs-motion-pause__off">{resumeLabel}</span>
            </label>
        </div>
    );
}

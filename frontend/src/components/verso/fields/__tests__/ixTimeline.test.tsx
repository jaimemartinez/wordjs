/**
 * Verso — GATE de MARKUP de IxTimeline (la línea de tiempo del dock y del editor de preajustes).
 *
 * ENTORNO node (sin jsdom): estructura por `renderToStaticMarkup`. El arrastre vive en el gate de
 * navegador; aquí se fija lo que el diseño «Motion Dock» (Stitch) añadió: la REGLA a cuartos, el
 * PLAYHEAD, el CLIP con rótulo y asa de recorte, y los nombres accesibles de siempre.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import IxTimeline from "../IxTimeline";
import type { IxTrack } from "@/lib/verso/interactions";

const TRACKS: IxTrack[] = [
    {
        target: { kind: "self" },
        steps: [{ at: 0, set: { opacity: 0 } }, { at: 100, set: { opacity: 1 } }],
        dur: 600,
        delay: 200,
    },
    {
        target: { kind: "children" },
        steps: [{ at: 0, set: { y: 40 } }, { at: 50, set: { y: 10 } }, { at: 100, set: { y: 0 } }],
    },
];

const noop = () => {};

function tl(extra: Partial<React.ComponentProps<typeof IxTimeline>> = {}) {
    return renderToStaticMarkup(
        <IxTimeline
            tracks={TRACKS}
            active={0}
            timed
            onStepAt={noop}
            onDelay={noop}
            onSelectTrack={noop}
            onFocusStep={noop}
            {...extra}
        />,
    );
}

describe("IxTimeline — el escenario del movimiento", () => {
    it("regla a cuartos de la escala compartida, en ms con reloj (suelo de 1000 ms)", () => {
        const html = tl();
        for (const tick of [">0<", ">250<", ">500<", ">750<", "1000 ms"]) expect(html).toContain(tick);
    });

    it("el PLAYHEAD se pinta a su porcentaje, y sin recorrido no existe", () => {
        expect(tl({ playhead: 37 })).toContain("calc(3.75rem + (100% - 4rem) * 0.37)");
        expect(tl({ playhead: null })).not.toContain("inset-y-0");
        expect(tl()).not.toContain("inset-y-0");
    });

    it("el CLIP activo lleva su rótulo dentro y, con onDur, el asa de recorte", () => {
        const html = tl({ labels: ["Opacidad", "Mover en Y"], onDur: noop });
        expect(html).toContain("Opacidad");
        expect(html).toContain('aria-label="Retardo de la pista 1 — 200 ms"');
        expect(html).toContain('aria-label="Duración de la pista 1 — 600 ms"');
        // Sin onDur el asa no existe: la superficie decide si sus clips se redimensionan.
        expect(tl()).not.toContain("Duración de la pista 1");
    });

    it("los nombres accesibles de siempre no cambian con la piel", () => {
        const html = tl();
        expect(html).toContain('aria-label="Inicio — 0 %"');
        expect(html).toContain('aria-label="Final — 100 %"');
        expect(html).toContain('aria-label="Pista 2"');
        expect(html).toContain('aria-label="Línea de tiempo de las pistas (ms)"');
    });
});

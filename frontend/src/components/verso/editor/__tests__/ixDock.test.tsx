/**
 * Verso — GATE del DOCK DE MOVIMIENTO (IxDock), anatomía de editor de vídeo: inspector a la
 * izquierda (control entero, en modo `stage`), escenario a la derecha con TRANSPORTE (probar +
 * scrubber) y la LÍNEA DE TIEMPO protagonista, siempre visible.
 *
 * ENTORNO node (sin jsdom, el criterio del proyecto): la ESTRUCTURA se fija con
 * `renderToStaticMarkup`; el arrastre y el aspecto son del gate de navegador. Las dependencias
 * PESADAS se simulan (el control, el timeline y el scrubber tienen sus propios tests); el MODELO
 * (`ixPanelState`) es real — el escenario decide con la misma verdad que producción.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/contexts/I18nContext", () => ({
    useI18n: () => ({ t: (k: string) => k, language: "es" }),
}));
vi.mock("../../canvas/useSiteIxPresets", () => ({ useSiteIxPresets: () => ({}) }));
vi.mock("../../canvas/IxCanvasEngine", () => ({
    requestIxPreview: () => {},
    requestIxScrub: () => {},
}));
vi.mock("@/components/editor/MSym", () => ({
    default: ({ name }: { name: string }) => <i data-msym={name} />,
}));
vi.mock("../../fields/VersoFieldControl", () => ({
    default: ({ name }: { name: string }) => <div data-field={name} />,
}));
vi.mock("../../fields/InteractionsControl", () => ({
    default: ({ supportsWords, stage }: { supportsWords?: boolean; stage?: unknown }) => (
        <div data-ix="1" data-words={supportsWords ? "1" : "0"} data-stage={stage ? "1" : "0"} />
    ),
    isTimed: (on: string) => on !== "scrub" && on !== "pointer",
}));
vi.mock("../../fields/IxTimeline", () => ({
    default: ({ readOnly, timed }: { readOnly?: boolean; timed: boolean }) => (
        <div data-timeline="1" data-readonly={readOnly ? "1" : "0"} data-timed={timed ? "1" : "0"} />
    ),
}));
vi.mock("../../fields/IxScrubberControl", () => ({
    default: ({ enabled }: { enabled: boolean }) => (
        <div data-scrubber="1" data-enabled={enabled ? "1" : "0"} />
    ),
}));
vi.mock("../../render/context", () => ({
    useStoreSlice: (h: { __state: unknown }, sel: (s: unknown) => unknown) => sel(h.__state),
}));

import IxDock from "../IxDock";
import type { BlockRegistry, VersoField } from "@/lib/verso/registry";

const FIELDS: Record<string, VersoField> = {
    title: { type: "text" } as VersoField,
    anim: { type: "custom" } as unknown as VersoField,
    hide: { type: "custom" } as unknown as VersoField,
};

const registry = {
    get: (type: string) =>
        type === "Hero"
            ? { label: "Sección Hero", fields: FIELDS, defaultProps: {}, render: () => null, ixText: true }
            : undefined,
} as unknown as BlockRegistry;

function dockFor(state: unknown) {
    const handle = { __state: state, transact: () => true } as never;
    return renderToStaticMarkup(<IxDock handle={handle} registry={registry} />);
}

const stateWith = (props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    selection: { nodeId: "n1" },
    doc: { nodes: { n1: { id: "n1", type: "Hero", props: { id: "hero-3f8a2c", ...props } } }, root: { props: {} } },
    dragPreview: null,
    ...extra,
});

/** Un `ix` mínimo y válido: el modelo REAL lo acepta y el escenario enseña su línea de tiempo. */
const IX = {
    v: 1,
    trigger: { on: "load" },
    tracks: [{ target: { kind: "self" }, steps: [{ at: 0, set: { x: 0 } }, { at: 100, set: { x: 20 } }] }],
};

describe("IxDock — anatomía de editor de vídeo", () => {
    it("con interacción: inspector en modo stage + transporte + línea de tiempo protagonista", () => {
        const html = dockFor(stateWith({ ix: IX }));
        expect(html).toContain('data-verso-dock="block"');
        // Inspector: el campo del dock (anim) y el control ENTERO en modo escenario.
        expect(html).toContain('data-field="anim"');
        expect(html).not.toContain('data-field="title"');
        expect(html).toContain('data-ix="1"');
        expect(html).toContain('data-stage="1"');
        expect(html).toContain('data-words="1"');
        // Transporte: probar, probar todo y el scrubber habilitado.
        expect(html).toContain('aria-label="Probar la interacción de este bloque"');
        expect(html).toContain('aria-label="Probar todas las interacciones de la página"');
        expect(html).toContain('data-scrubber="1"');
        expect(html).toContain('data-enabled="1"');
        // La línea de tiempo, SIEMPRE visible (sin details que desplegar) y editable (sin preset).
        expect(html).toContain('data-timeline="1"');
        expect(html).toContain('data-readonly="0"');
        expect(html).toContain('data-timed="1"');
    });

    it("sin interacción aún: el escenario lo dice honesto y no pinta timeline", () => {
        const html = dockFor(stateWith({}));
        expect(html).toContain('data-verso-dock="block"');
        expect(html).not.toContain('data-timeline="1"');
        expect(html).toContain("línea de tiempo");
        // El inspector sigue: desde ahí se elige el preajuste que la enciende.
        expect(html).toContain('data-ix="1"');
    });

    it("sin selección: estado vacío honesto, sin controles", () => {
        const html = dockFor({ ...stateWith({}), selection: { nodeId: null } });
        expect(html).toContain('data-verso-dock="empty"');
        expect(html).toContain("Selecciona un bloque");
        expect(html).not.toContain('data-ix="1"');
    });

    it("durante un arrastre: los campos no aplican a un bloque en el aire", () => {
        const html = dockFor(stateWith({ ix: IX }, { dragPreview: {} }));
        expect(html).toContain("Suelta el bloque");
        expect(html).not.toContain('data-ix="1"');
        expect(html).not.toContain('data-timeline="1"');
    });
});

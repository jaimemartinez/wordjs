/**
 * Verso — GATE del DOCK DE MOVIMIENTO (IxDock): la carcasa inferior propia de las interacciones y
 * la animación de entrada.
 *
 * ENTORNO node (sin jsdom, el criterio del proyecto): la ESTRUCTURA se fija con
 * `renderToStaticMarkup` — cabecera con plegado, ancla de e2e, el campo `anim` del dock y el panel
 * de interacciones montados, y los estados vacío/arrastre. El plegado interactivo y el aspecto son
 * del gate de navegador. Las dependencias PESADAS se simulan como en el test del inspector: este
 * test es sobre la CARCASA; los controles tienen los suyos.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/contexts/I18nContext", () => ({
    useI18n: () => ({ t: (k: string) => k, language: "es" }),
}));
vi.mock("../../canvas/useSiteIxPresets", () => ({ useSiteIxPresets: () => ({}) }));
vi.mock("@/components/editor/MSym", () => ({
    default: ({ name }: { name: string }) => <i data-msym={name} />,
}));
vi.mock("../../fields/VersoFieldControl", () => ({
    default: ({ name }: { name: string }) => <div data-field={name} />,
}));
vi.mock("../../fields/InteractionsControl", () => ({
    default: ({ supportsWords }: { supportsWords?: boolean }) => (
        <div data-ix="1" data-words={supportsWords ? "1" : "0"} />
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

const blockState = {
    selection: { nodeId: "n1" },
    doc: { nodes: { n1: { id: "n1", type: "Hero", props: { id: "hero-3f8a2c" } } }, root: { props: {} } },
    dragPreview: null,
};

describe("IxDock — el panel propio del movimiento", () => {
    it("con bloque: ancla e2e, cabecera plegable, el campo `anim` del dock y las interacciones", () => {
        const html = dockFor(blockState);
        expect(html).toContain('data-verso-dock="block"');
        expect(html).toContain('aria-expanded="true"');
        // El dock renderiza SOLO sus campos (anim) — ni title ni hide, que son del inspector.
        expect(html).toContain('data-field="anim"');
        expect(html).not.toContain('data-field="title"');
        expect(html).not.toContain('data-field="hide"');
        // El panel de interacciones entero, con `ixText` de la definición fluyendo tal cual.
        expect(html).toContain('data-ix="1"');
        expect(html).toContain('data-words="1"');
    });

    it("sin selección: estado vacío honesto, sin controles", () => {
        const html = dockFor({ ...blockState, selection: { nodeId: null } });
        expect(html).toContain('data-verso-dock="empty"');
        expect(html).toContain("Selecciona un bloque");
        expect(html).not.toContain('data-ix="1"');
        expect(html).not.toContain('data-field="anim"');
    });

    it("durante un arrastre: los campos no aplican a un bloque en el aire", () => {
        const html = dockFor({ ...blockState, dragPreview: {} });
        expect(html).toContain("Suelta el bloque");
        expect(html).not.toContain('data-ix="1"');
    });
});

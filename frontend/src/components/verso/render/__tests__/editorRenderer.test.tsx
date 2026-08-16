/**
 * Verso — tests del EditorRenderer.
 *
 * ENTORNO: node (el proyecto no tiene jsdom/happy-dom/@testing-library y las
 * dependencias nuevas están vetadas), así que:
 * - la ESTRUCTURA se verifica con renderToStaticMarkup — el mismo patrón que
 *   los tests existentes de content/__tests__ — usando los componentes REALES
 *   de blocks.tsx;
 * - la SELECTIVIDAD de re-render se verifica sobre el par {subscribe,
 *   getSnapshot} (createNodeStore) que useSyncExternalStore consume tal cual:
 *   React re-renderiza un bloque exactamente cuando ese par notifica/cambia,
 *   así que probar el par ES probar el contrato de re-render (la verificación
 *   con DOM real queda para el gate de navegador de F6).
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createEditor, type EditorHandle } from "@/lib/verso/store";
import { createBlockRegistry, makeSlotResolver, type BlockRegistry } from "@/lib/verso/registry";
import { ROOT_ID, ROOT_SLOT, type VersoData } from "@/lib/verso/types";
import {
  HeadingBlock,
  TextBlock,
  CardBlock,
  SectionBlock,
  GridBlock,
} from "@/components/content/blocks";
import SharedBlockShell from "@/components/content/SharedBlockShell";
import EditorRenderer from "../EditorRenderer";
import { createNodeStore, type VersoBlockProps, type VersoComponentMap, type VersoSlotRender } from "../context";
import { slotEntries } from "../VersoSlot";

// componentMap con los componentes REALES de blocks.tsx. Los contenedores se
// adaptan igual que en versoConfig.tsx: el slot llega como prop bajo su clave
// ("children") y el bloque lo espera como `slot`.
const componentMap: VersoComponentMap = {
  Heading: HeadingBlock as VersoComponentMap[string],
  Text: TextBlock as VersoComponentMap[string],
  Card: CardBlock as VersoComponentMap[string],
  Section: (p: VersoBlockProps) => <SectionBlock {...p} slot={p.children as VersoSlotRender} />,
  Grid: (p: VersoBlockProps) => <GridBlock {...p} slot={p.children as VersoSlotRender} />,
};

function makeRegistry(): BlockRegistry {
  const registry = createBlockRegistry();
  const render = () => null;
  registry.register([
    { type: "Section", fields: { children: { type: "slot" } }, defaultProps: {}, render },
    { type: "Grid", fields: { children: { type: "slot" } }, defaultProps: {}, render },
    { type: "Heading", fields: { title: { type: "text" } }, defaultProps: {}, render },
    { type: "Text", fields: { content: { type: "textarea" } }, defaultProps: {}, render },
    { type: "Card", fields: { title: { type: "text" } }, defaultProps: {}, render },
  ]);
  return registry;
}

const H2TOP_PROPS = {
  id: "h2top",
  title: "Fuera",
  level: "h3",
  hide: { mobile: true },
  anim: { type: "fade", duration: 600, delay: 0 },
  look: { bg: "color", bgColor: "#ff0000" },
} as const;

// Doc sintético: Section > Grid > (Heading, Text) + Card; y en raíz un Heading
// con hide/anim/look y un tipo desconocido.
function makeData(): VersoData {
  return {
    content: [
      {
        type: "Section",
        props: {
          id: "sec1",
          pad: 32,
          children: [
            {
              type: "Grid",
              props: {
                id: "grid1",
                columns: 2,
                children: [
                  { type: "Heading", props: { id: "h1", title: "Hola", level: "h2" } },
                  { type: "Text", props: { id: "t1", content: "<p>Texto</p>" } },
                ],
              },
            },
            { type: "Card", props: { id: "card1", title: "Tarjeta", description: "Desc" } },
          ],
        },
      },
      { type: "Heading", props: H2TOP_PROPS },
      { type: "Mystery", props: { id: "x1" } },
    ],
    root: { props: {} },
  };
}

function makeEditor(): { handle: EditorHandle; registry: BlockRegistry } {
  const registry = makeRegistry();
  const handle = createEditor({ initialData: makeData(), isSlot: makeSlotResolver(registry) });
  return { handle, registry };
}

function render(
  handle: EditorHandle,
  registry: BlockRegistry,
  extra?: { editorChrome?: boolean; onBlockElement?: (id: string, el: HTMLElement | null) => void },
): string {
  return renderToStaticMarkup(
    <EditorRenderer
      handle={handle}
      registry={registry}
      componentMap={componentMap}
      editorChrome={extra?.editorChrome}
      onBlockElement={extra?.onBlockElement}
    />,
  );
}

describe("EditorRenderer — estructura", () => {
  it("estampa data-wjs-block-id en la raíz de cada bloque", () => {
    const { handle, registry } = makeEditor();
    const html = render(handle, registry);
    for (const id of ["sec1", "grid1", "h1", "t1", "card1", "h2top", "x1"]) {
      expect(html).toContain(`data-wjs-block-id="${id}"`);
    }
  });

  it("renderiza cada slot como UN solo div con data-wjs-slot=nodeId:slotKey y el className del contenedor", () => {
    const { handle, registry } = makeEditor();
    const html = render(handle, registry);
    // La raíz también es un slot (zona raíz del DnD).
    expect(html.match(/data-wjs-slot="verso:root:content"/g)).toHaveLength(1);
    expect(html.match(/data-wjs-slot="sec1:children"/g)).toHaveLength(1);
    // Grid pone su layout en el wrapper del slot — contrato de ContentRenderer.
    // Las DOS clases de bloque, la propia primero (bc() en blockVars.ts): el canvas emite exactamente
  // el mismo className que el público, así que el contrato se fija aquí con la cadena completa.
  expect(html).toContain('<div class="wjs-block-grid__items wp-block-grid__items" data-wjs-slot="grid1:children">');
    // Los hijos del grid viven DENTRO de ese único div, en orden.
    const slotAt = html.indexOf('data-wjs-slot="grid1:children"');
    const h1At = html.indexOf('data-wjs-block-id="h1"');
    const t1At = html.indexOf('data-wjs-block-id="t1"');
    expect(slotAt).toBeGreaterThan(-1);
    expect(h1At).toBeGreaterThan(slotAt);
    expect(t1At).toBeGreaterThan(h1At);
  });

  it("renderiza los componentes reales de blocks.tsx (clases wp-block-*)", () => {
    const { handle, registry } = makeEditor();
    const html = render(handle, registry);
    expect(html).toContain("wp-block-section");
    expect(html).toContain("wp-block-grid");
    expect(html).toContain("wp-block-heading");
    expect(html).toContain("wp-block-text");
    expect(html).toContain("wp-block-card");
    expect(html).toContain("Hola");
    expect(html).toContain("Tarjeta");
  });

  it("un bloque sin hide/anim/look no gana wrapper del shell (rama 'nada')", () => {
    const { handle, registry } = makeEditor();
    const html = render(handle, registry);
    // El <h2> del bloque cuelga DIRECTAMENTE del div raíz del bloque.
    expect(html).toMatch(/<div data-wjs-block-id="h1"><h2/);
  });

  it("aplica el wrapper de blockShell (clases wjs-*) vía SharedBlockShell, byte-idéntico al público", () => {
    const { handle, registry } = makeEditor();
    const html = render(handle, registry);
    // Capa animada exterior: hideClasses + animClasses de blockShell.ts.
    expect(html).toContain('class="wjs-hide-mobile wjs-anim wjs-anim-fade"');
    expect(html).toContain("--wjs-anim-dur:600ms");
    // Capa de apariencia interior: appearanceToStyle.
    expect(html).toContain("background:#ff0000");
    // Paridad literal: el markup del editor CONTIENE exactamente lo que produce
    // SharedBlockShell (el twin del público) con las mismas props.
    const expected = renderToStaticMarkup(
      <SharedBlockShell hide={H2TOP_PROPS.hide} anim={H2TOP_PROPS.anim} look={H2TOP_PROPS.look}>
        <HeadingBlock {...H2TOP_PROPS} isEditing />
      </SharedBlockShell>,
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(html).toContain(expected);
  });

  it("un type sin componente en componentMap renderiza el placeholder data-verso-missing con el type visible", () => {
    const { handle, registry } = makeEditor();
    const html = render(handle, registry);
    expect(html).toContain('data-verso-missing="Mystery"');
    expect(html).toContain("<code>Mystery</code>");
  });

  it("editorChrome atenúa los bloques NO activos durante la edición inline", () => {
    const { handle, registry } = makeEditor();
    handle.setInlineEditing("h1");
    const html = render(handle, registry, { editorChrome: true });
    // El activo no se atenúa…
    expect(html).toMatch(/<div data-wjs-block-id="h1"><h2/);
    // …los demás sí.
    expect(html).toMatch(/data-wjs-block-id="t1" class="[^"]*opacity-40/);
    expect(html).toMatch(/data-wjs-block-id="card1" class="[^"]*opacity-40/);
    // Sin editorChrome, nadie se atenúa.
    const plain = render(handle, registry);
    expect(plain).not.toContain("opacity-40");
  });
});

describe("EditorRenderer — dragPreview (colocación virtual, sin mutar el doc)", () => {
  it("source new: pinta un fantasma en el slot destino, en el índice pedido", () => {
    const { handle, registry } = makeEditor();
    const before = JSON.stringify(handle.getData());
    handle.setDragPreview({
      source: { kind: "new", type: "Card" },
      targetParentId: "grid1",
      targetSlotKey: "children",
      targetIndex: 1,
    });
    const html = render(handle, registry);
    expect(html).toContain('data-verso-ghost-type="Card"');
    // Entre h1 y t1 (índice 1 del slot del grid).
    const ghostAt = html.indexOf("data-verso-ghost-type");
    expect(ghostAt).toBeGreaterThan(html.indexOf('data-wjs-block-id="h1"'));
    expect(ghostAt).toBeLessThan(html.indexOf('data-wjs-block-id="t1"'));
    // El doc NO se ha mutado.
    expect(JSON.stringify(handle.getData())).toBe(before);
    // Al limpiar el preview, el fantasma desaparece.
    handle.setDragPreview(null);
    expect(render(handle, registry)).not.toContain("data-verso-ghost");
  });

  it("source existing: el bloque se pinta movido (retirado del origen, insertado en el destino)", () => {
    const { handle, registry } = makeEditor();
    const before = JSON.stringify(handle.getData());
    handle.setDragPreview({
      source: { kind: "existing", nodeId: "card1" },
      targetParentId: ROOT_ID,
      targetSlotKey: ROOT_SLOT,
      targetIndex: 0,
    });
    const html = render(handle, registry);
    // card1 aparece UNA sola vez, y ANTES que sec1 (su antiguo padre).
    expect(html.match(/data-wjs-block-id="card1"/g)).toHaveLength(1);
    expect(html.indexOf('data-wjs-block-id="card1"')).toBeLessThan(html.indexOf('data-wjs-block-id="sec1"'));
    expect(JSON.stringify(handle.getData())).toBe(before);
  });

  it("slotEntries: movimiento dentro del mismo slot y clamp del índice", () => {
    const preview = {
      source: { kind: "existing" as const, nodeId: "b" },
      targetParentId: "p",
      targetSlotKey: "s",
      targetIndex: 99,
    };
    // b se filtra de su posición y se reinserta clampeado al final.
    expect(slotEntries(["a", "b", "c"], "p", "s", preview)).toEqual([
      { kind: "node", id: "a" },
      { kind: "node", id: "c" },
      { kind: "node", id: "b" },
    ]);
    // Slot no concernido con preview null: intacto.
    expect(slotEntries(["a", "b"], "p", "s", null)).toEqual([
      { kind: "node", id: "a" },
      { kind: "node", id: "b" },
    ]);
    // Ghost en índice negativo → clamp a 0.
    expect(
      slotEntries(["a"], "p", "s", {
        source: { kind: "new", type: "T" },
        targetParentId: "p",
        targetSlotKey: "s",
        targetIndex: -5,
      }),
    ).toEqual([
      { kind: "ghost", type: "T" },
      { kind: "node", id: "a" },
    ]);
  });
});

describe("EditorRenderer — suscripción por nodo (base del re-render selectivo)", () => {
  it("setProps a un nodo notifica SOLO a ese nodo; el hermano conserva referencia y silencio", () => {
    const { handle } = makeEditor();
    const h1Store = createNodeStore(handle, "h1");
    const t1Store = createNodeStore(handle, "t1");
    const h1Spy = vi.fn();
    const t1Spy = vi.fn();
    const unsubH1 = h1Store.subscribe(h1Spy);
    const unsubT1 = t1Store.subscribe(t1Spy);
    const h1Before = h1Store.getSnapshot();
    const t1Before = t1Store.getSnapshot();
    expect(h1Before).toBeDefined();

    handle.transact((tx) => tx.setProps("h1", { title: "Nuevo" }));

    // useSyncExternalStore re-renderiza exactamente cuando subscribe notifica y
    // getSnapshot cambia — h1 sí, su hermano t1 no.
    expect(h1Spy).toHaveBeenCalledTimes(1);
    expect(t1Spy).not.toHaveBeenCalled();
    expect(h1Store.getSnapshot()).not.toBe(h1Before);
    expect(t1Store.getSnapshot()).toBe(t1Before);
    unsubH1();
    unsubT1();
  });

  it("el markup refleja el nuevo valor tras el setProps", () => {
    const { handle, registry } = makeEditor();
    handle.transact((tx) => tx.setProps("h1", { title: "Nuevo título" }));
    const html = render(handle, registry);
    expect(html).toContain("Nuevo título");
    expect(html).not.toContain(">Hola<");
  });
});

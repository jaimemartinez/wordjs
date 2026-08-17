/**
 * Verso — motor de interacciones del CANVAS y su previsualización (F9-D).
 *
 * ENTORNO node sin jsdom: los efectos (inyectar la hoja en el `<head>` del iframe y arrancar el
 * runtime) no se ejecutan bajo `renderToStaticMarkup` y su verificación real es el gate de
 * navegador. Lo que SÍ se puede —y se debe— fijar aquí es el contrato que un refactor rompería sin
 * enterarse:
 *
 *  1. El motor **no pinta nada**. Si algún día devolviera un nodo, el DOM del canvas dejaría de ser
 *     idéntico al del sitio público y se llevaría por delante la medición del DnD y cualquier
 *     selector `:last-child` de un tema.
 *  2. La previsualización viaja como **evento del DOM**, que es lo único que cruza el iframe sin un
 *     puente de React, y se traduce al MISMO `ANIM_REPLAY_EVENT` que ya re-arma las entradas: una
 *     sola pulsación mueve las dos capas.
 *  3. El canvas y el público compilan con el MISMO `compileIxPage`. Aquí se comprueba sobre el dato:
 *     los mismos bloques dan las mismas clases y el mismo CSS en las dos superficies.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compileIxPage, collectIxSpecs, ixCtxFromSetting } from "@/lib/verso/interactions";
import { ANIM_REPLAY_EVENT } from "@/components/blocks/entranceAnimation";
import { createEditor } from "@/lib/verso/store";
import type { VersoData } from "@/lib/verso/types";
import IxCanvasEngine, { IX_PREVIEW_EVENT, IX_STYLE_ID, requestIxPreview } from "../IxCanvasEngine";
import IxRuntimeIsland from "@/components/content/IxRuntimeIsland";

const data: VersoData = {
  content: [
    { type: "Heading", props: { id: "a", title: "A", ix: { v: 1, preset: "sys:fade-up" } } },
    { type: "Heading", props: { id: "b", title: "B" } },
  ],
  root: { props: {} },
};

describe("IxCanvasEngine — sin huella en el DOM del canvas", () => {
  it("no pinta ni un nodo", () => {
    const handle = createEditor({ initialData: data });
    expect(renderToStaticMarkup(<IxCanvasEngine handle={handle} />)).toBe("");
  });

  it("la isla del runtime público tampoco: el estado inicial lo pone el navegador, no el HTML", () => {
    expect(renderToStaticMarkup(<IxRuntimeIsland units={[]} />)).toBe("");
  });

  it("el id de la hoja del canvas es estable (contrato con el `<head>` del iframe)", () => {
    expect(IX_STYLE_ID).toBe("wjs-ix");
  });
});

describe("requestIxPreview — el canal de la previsualización", () => {
  it("emite el evento de previsualización en el documento que se le pase", () => {
    const target = new EventTarget();
    const seen: string[] = [];
    target.addEventListener(IX_PREVIEW_EVENT, (e) => seen.push(e.type));
    requestIxPreview("page", target as unknown as Document);
    expect(seen).toEqual([IX_PREVIEW_EVENT]);
  });

  it("el scope viaja en el detail: `block` pide reproducir SOLO el bloque seleccionado", () => {
    const target = new EventTarget();
    const scopes: unknown[] = [];
    target.addEventListener(IX_PREVIEW_EVENT, (e) => scopes.push((e as CustomEvent).detail?.scope));
    requestIxPreview("block", target as unknown as Document);
    requestIxPreview("page", target as unknown as Document);
    expect(scopes).toEqual(["block", "page"]);
  });

  it("sin documento (SSR) no revienta: simplemente no hace nada", () => {
    expect(() => requestIxPreview("page", null)).not.toThrow();
  });

  it("el evento del panel y el del re-armado son DISTINTOS: el motor traduce uno en el otro", () => {
    // Si fueran el mismo, el panel estaría re-armando el canvas por su cuenta y el motor no podría
    // decidir NADA (ni acotar la traducción al documento del marco).
    expect(IX_PREVIEW_EVENT).not.toBe(ANIM_REPLAY_EVENT);
    expect(ANIM_REPLAY_EVENT).toBe("wjs-anim-replay");
  });
});

describe("paridad canvas ↔ público", () => {
  it("los mismos bloques dan las MISMAS clases y el MISMO CSS en las dos superficies", () => {
    const ctx = ixCtxFromSetting(undefined);
    // Público: recorre el árbol persistido. Canvas: recorre los nodos del documento normalizado.
    const publico = compileIxPage(collectIxSpecs(data), ctx);
    const handle = createEditor({ initialData: data });
    const canvas = compileIxPage(
      Object.values(handle.getDoc().nodes).map((n) => n.props.ix),
      ctx,
    );
    expect(canvas.css).toBe(publico.css);
    expect(canvas.units.map((u) => u.cls)).toEqual(publico.units.map((u) => u.cls));
    expect(canvas.runtime).toEqual(publico.runtime);
  });

  it("escribir texto en un bloque no cambia el CSS ni el manifiesto (el canvas no re-arma al teclear)", () => {
    const ctx = ixCtxFromSetting(undefined);
    const handle = createEditor({ initialData: data });
    const before = compileIxPage(
      Object.values(handle.getDoc().nodes).map((n) => n.props.ix),
      ctx,
    );
    handle.transact((tx) => tx.setProps("a", { title: "A con más texto" }));
    const after = compileIxPage(
      Object.values(handle.getDoc().nodes).map((n) => n.props.ix),
      ctx,
    );
    expect(after.css).toBe(before.css);
    expect(JSON.stringify(after.runtime)).toBe(JSON.stringify(before.runtime));
  });

  it("cambiar la interacción SÍ cambia el manifiesto (o el motor no se enteraría)", () => {
    const ctx = ixCtxFromSetting(undefined);
    const handle = createEditor({ initialData: data });
    const before = compileIxPage(
      Object.values(handle.getDoc().nodes).map((n) => n.props.ix),
      ctx,
    );
    handle.transact((tx) => tx.setProps("a", { ix: { v: 1, preset: "sys:parallax" } }));
    const after = compileIxPage(
      Object.values(handle.getDoc().nodes).map((n) => n.props.ix),
      ctx,
    );
    expect(after.css).not.toBe(before.css);
  });
});

describe("el panel escribe por el store, nunca mutando", () => {
  it("quitar la interacción BORRA la clave (no deja `ix: undefined`) y Ctrl+Z la devuelve", () => {
    const handle = createEditor({ initialData: data });
    const onChange = vi.fn();
    const h = createEditor({ initialData: data, onChange });

    h.transact((tx) => tx.setProps("a", { ix: undefined }), { label: "Quitar interacción" });
    expect(Object.hasOwn(h.getDoc().nodes.a.props, "ix")).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);

    h.undo();
    expect(h.getDoc().nodes.a.props.ix).toEqual({ v: 1, preset: "sys:fade-up" });

    // Y el documento original nunca se tocó: el store es inmutable.
    expect(handle.getDoc().nodes.a.props.ix).toEqual({ v: 1, preset: "sys:fade-up" });
  });
});

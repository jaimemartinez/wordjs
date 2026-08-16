import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useVersoCollab, type UseVersoCollabResult } from "../useVersoCollab";

/**
 * F8.3 — CONTRATO INERTE del hook.
 *
 * Alcance honesto de este fichero: el entorno de tests del frontend es `node` SIN jsdom (misma
 * decisión que el resto de la suite, ver `pluginBlocks.test.tsx`), así que `useEffect` NO se
 * ejecuta aquí. Lo que esto prueba, por tanto, es exactamente esto y nada más:
 *
 *   · el hook se monta sin romperse y devuelve la forma documentada;
 *   · con `enabled:false` — o sin `postId` — el estado inicial es INERTE: `status:"off"`, sin
 *     miembros y sin sesión. Ese es el contrato del interruptor general (el editor tiene que
 *     comportarse EXACTAMENTE como antes de que existiera la colaboración cuando está apagado);
 *   · las funciones expuestas son seguras de llamar antes de que haya sesión (no lanzan).
 *
 * La lógica de sesión — conexión, convergencia, reconexión, avisos — está probada de verdad en
 * `collab-session.test.ts` y `collab-convergence.test.ts`, que ejercitan la clase real contra un
 * transporte controlado. La verificación EN NAVEGADOR con dos perfiles queda pendiente del
 * cableado en el editor.
 */

/**
 * El resultado se OBSERVA por el marcado renderizado, no capturándolo en una variable exterior ni
 * mutando una prop: las dos cosas son efectos secundarios durante el render y React 19 las prohíbe
 * (con razón — con render concurrente el valor capturado puede no ser el que se pintó).
 *
 * Las llamadas a `sendCommand`/`doc`/`flush` de aquí abajo son legítimas dentro del render EN ESTE
 * ESTADO Y SOLO EN ESTE: con el hook apagado no hay sesión, así que las tres son puras por
 * construcción (`?.` sobre una ref nula). Eso es justo lo que el test comprueba.
 */
function Probe(props: Parameters<typeof useVersoCollab>[0]) {
  const api: UseVersoCollabResult = useVersoCollab(props);
  const observed = {
    status: api.status,
    self: api.self,
    members: api.members,
    notice: api.notice,
    pendingOps: api.pendingOps,
    epoch: api.epoch,
    siteId: api.siteId,
    sendCommandReturns: api.sendCommand({ kind: "removeNode", nodeId: "x" }),
    docReturns: api.doc(),
    setSelectionThrew: (() => { try { api.setSelection({ nodeId: "x" }); return false; } catch { return true; } })(),
    flushIsThenable: typeof api.flush()?.then === "function",
  };
  return <span>{JSON.stringify(observed)}</span>;
}

const observe = (props: Parameters<typeof useVersoCollab>[0]) =>
  JSON.parse(renderToStaticMarkup(<Probe {...props} />).replace(/^<span>|<\/span>$/g, "").replace(/&quot;/g, '"'));

describe("useVersoCollab — contrato inerte", () => {
  it("apagado: no hay sesión, ni miembros, ni siteId", () => {
    const o = observe({ postId: 5, enabled: false });
    expect(o.status).toBe("off");
    expect(o.members).toEqual([]);
    expect(o.self).toBeNull();
    expect(o.notice).toBeNull();
    expect(o.pendingOps).toBe(0);
    expect(o.epoch).toBe(0);
    expect(o.siteId).toBe("");
  });

  it("sin `postId` tampoco arranca nada", () => {
    expect(observe({ postId: null }).status).toBe("off");
  });

  it("sus funciones son seguras antes de haber sesión (no lanzan y no inventan ops)", () => {
    const o = observe({ postId: 5, enabled: false });
    expect(o.sendCommandReturns).toEqual([]);
    expect(o.docReturns).toBeNull();
    expect(o.setSelectionThrew).toBe(false);
    expect(o.flushIsThenable).toBe(true);
  });
});

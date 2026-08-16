/**
 * Verso/colaboración — CONVERGENCIA A TRAVÉS DEL TRANSPORTE (F8.3).
 *
 * El núcleo CRDT ya tiene sus propias pruebas de convergencia aplicando ops «a mano». Esto es otra
 * cosa y por eso existe aparte: aquí las ops nacen de COMANDOS DEL EDITOR, se traducen con el
 * puente, viajan por la sesión real (`VersoCollabSession`) y llegan DESORDENADAS por un servidor
 * que baraja la cola a propósito.
 *
 * Es el escalón que puede romperse aunque el álgebra sea correcta: basta que la sesión mande el
 * comando crudo en vez del efectivo, que no aplique sus propias ops a su réplica, que descarte un
 * duplicado mal, o que no detecte un hueco — y las dos pantallas acaban enseñando cosas distintas
 * con los dos motores CRDT «funcionando perfectamente».
 *
 * Criterio de convergencia: `stateSignature()` idéntica (serialización canónica del estado) Y la
 * proyección `VersoDoc` deep-equal. La firma sola no bastaría: dos estados podrían coincidir en la
 * firma y proyectar distinto si la proyección tuviera un bug.
 */

import { describe, expect, it } from "vitest";

import { VersoCollabSession } from "../client";
import { FakeCollabServer, ManualTimers, makeRng, shuffler, settleMicrotasks } from "./fakeServer";
import type { VersoData, VersoDoc, VersoHistoryCommand, VersoItem } from "../../types";

const BASE: VersoData = {
  root: { props: { title: "Página de prueba" } },
  content: [
    { type: "Heading", props: { id: "h1", text: "Hola", level: 2 } },
    { type: "Text", props: { id: "t1", text: "Primer párrafo" } },
    { type: "Text", props: { id: "t2", text: "Segundo párrafo" } },
  ],
};

const item = (id: string, text: string): VersoItem => ({ type: "Text", props: { id, text } });

/**
 * Un nodo INSERTADO en sesión se indexa internamente por su `OpId`, no por `props.id` — el puente
 * lo hace así a propósito (el OpId es único global, así que dos réplicas no pueden colisionar al
 * insertar a la vez). `props.id` sigue siendo el identificador del dato persistido, así que las
 * comprobaciones de contenido se hacen por él.
 */
const byPropId = (doc: VersoDoc, propId: string) =>
  Object.values(doc.nodes).find((n) => n.props.id === propId);

const childPropIds = (doc: VersoDoc) => doc.rootChildren.map((id) => doc.nodes[id]?.props.id);

interface Replica {
  session: VersoCollabSession;
  timers: ManualTimers;
}

function makeReplica(server: FakeCollabServer, siteId: string, userId: number, name: string): Replica {
  server.register({ siteId, userId, name });
  const timers = new ManualTimers();
  const session = new VersoCollabSession(
    {
      postId: 42,
      transport: server.transport(),
      siteId,
      flushMs: 10,
      presenceMs: 10,
      setTimer: timers.set,
      clearTimer: timers.clear,
    },
    {},
  );
  session.start();
  return { session, timers };
}

/** Deja que todas las réplicas envíen, el servidor entregue (barajando) y todo se asiente. */
async function settle(server: FakeCollabServer, replicas: Replica[], order?: <T>(x: T[]) => T[]) {
  for (let round = 0; round < 30; round++) {
    for (const r of replicas) await r.timers.run();
    await settleMicrotasks();
    if (!server.pending) break;
    server.deliver(order as never);
    await settleMicrotasks();
  }
  for (const r of replicas) await r.timers.run();
  await settleMicrotasks();
}

function expectConverged(a: Replica, b: Replica) {
  expect(a.session.signature()).toBe(b.session.signature());
  expect(a.session.doc()).toEqual(b.session.doc());
}

describe("convergencia a través del transporte", () => {
  it("dos réplicas que editan a la vez y reciben en órdenes distintos acaban IDÉNTICAS", async () => {
    const server = new FakeCollabServer(BASE);
    const A = makeReplica(server, "s_aaaaaaaaaaaaaaaa", 1, "Ana");
    const B = makeReplica(server, "s_bbbbbbbbbbbbbbbb", 2, "Bruno");
    await settle(server, [A, B]);

    // Ambas parten del MISMO snapshot: las posiciones semilla son función pura del snapshot.
    expectConverged(A, B);

    // Edición SIMULTÁNEA en el mismo sitio: A y B insertan en el mismo índice del mismo slot, y
    // además tocan props distintas del MISMO bloque (el caso frecuente que no debe pisarse).
    const aCommands: VersoHistoryCommand[] = [
      { kind: "insertNode", item: item("a1", "de Ana 1"), parentId: "verso:root", slotKey: "content", index: 1 },
      { kind: "setProps", nodeId: "h1", patch: { level: 3 } },
      { kind: "insertNode", item: item("a2", "de Ana 2"), parentId: "verso:root", slotKey: "content", index: 2 },
    ];
    const bCommands: VersoHistoryCommand[] = [
      { kind: "insertNode", item: item("b1", "de Bruno 1"), parentId: "verso:root", slotKey: "content", index: 1 },
      { kind: "setProps", nodeId: "h1", patch: { align: "center" } },
      { kind: "setProps", nodeId: "t2", patch: { text: "Segundo párrafo, editado" } },
    ];

    for (const c of aCommands) A.session.sendCommand(c);
    for (const c of bCommands) B.session.sendCommand(c);

    // Entrega BARAJADA: cada réplica ve las ops ajenas en un orden distinto.
    await settle(server, [A, B], shuffler(makeRng(20260816)) as never);

    expectConverged(A, B);

    const doc = A.session.doc()!;
    // Ninguna de las dos ediciones se pierde: props distintas del mismo bloque sobreviven ambas.
    expect(doc.nodes.h1.props.level).toBe(3);
    expect(doc.nodes.h1.props.align).toBe("center");
    // Y los cuatro bloques insertados están todos, sin duplicados.
    for (const id of ["a1", "a2", "b1"]) expect(byPropId(doc, id)).toBeTruthy();
    // Sin duplicados: ni por identidad interna ni por `props.id`.
    const ids = childPropIds(doc);
    expect(ids.filter((x) => x === "a1")).toHaveLength(1);
    expect(new Set(doc.rootChildren).size).toBe(doc.rootChildren.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mover y borrar concurrentemente converge (el move es primitivo, no remove+insert)", async () => {
    const server = new FakeCollabServer(BASE);
    const A = makeReplica(server, "s_aaaaaaaaaaaaaaaa", 1, "Ana");
    const B = makeReplica(server, "s_bbbbbbbbbbbbbbbb", 2, "Bruno");
    await settle(server, [A, B]);

    A.session.sendCommand({ kind: "moveNode", nodeId: "t1", toParentId: "verso:root", toSlotKey: "content", toIndex: 2 });
    B.session.sendCommand({ kind: "moveNode", nodeId: "t1", toParentId: "verso:root", toSlotKey: "content", toIndex: 0 });
    B.session.sendCommand({ kind: "removeNode", nodeId: "t2" });

    await settle(server, [A, B], shuffler(makeRng(7)) as never);
    expectConverged(A, B);

    const doc = A.session.doc()!;
    // Un move concurrente NO duplica: `t1` aparece exactamente una vez.
    expect(doc.rootChildren.filter((x) => x === "t1")).toHaveLength(1);
    // El borrado gana (no se resucitan nodos).
    expect(doc.rootChildren).not.toContain("t2");
  });

  it("tres réplicas con entrega barajada y semillas distintas siguen convergiendo", async () => {
    for (const seed of [1, 99, 12345]) {
      const server = new FakeCollabServer(BASE);
      const A = makeReplica(server, "s_aaaaaaaaaaaaaaaa", 1, "Ana");
      const B = makeReplica(server, "s_bbbbbbbbbbbbbbbb", 2, "Bruno");
      const C = makeReplica(server, "s_cccccccccccccccc", 3, "Carla");
      await settle(server, [A, B, C]);

      const rng = makeRng(seed);
      const replicas = [A, B, C];
      const targets = ["h1", "t1", "t2"];
      for (let i = 0; i < 30; i++) {
        const r = replicas[Math.floor(rng() * replicas.length)];
        const roll = rng();
        if (roll < 0.4) {
          r.session.sendCommand({
            kind: "setProps",
            nodeId: targets[Math.floor(rng() * targets.length)],
            patch: { [`k${Math.floor(rng() * 4)}`]: Math.floor(rng() * 1000) },
          });
        } else if (roll < 0.75) {
          r.session.sendCommand({
            kind: "insertNode",
            item: item(`n${seed}_${i}`, `bloque ${i}`),
            parentId: "verso:root",
            slotKey: "content",
            index: Math.floor(rng() * 3),
          });
        } else {
          const doc = r.session.doc()!;
          const pool = doc.rootChildren;
          if (pool.length > 1) {
            r.session.sendCommand({
              kind: "moveNode",
              nodeId: pool[Math.floor(rng() * pool.length)],
              toParentId: "verso:root",
              toSlotKey: "content",
              toIndex: Math.floor(rng() * pool.length),
            });
          }
        }
        // Entrega parcial y desordenada A MITAD de la ráfaga: así las réplicas emiten sobre
        // estados distintos entre sí, que es el escenario que de verdad rompe las cosas.
        if (i % 3 === 0) await settle(server, replicas, shuffler(rng) as never);
      }

      await settle(server, replicas, shuffler(rng) as never);
      expectConverged(A, B);
      expectConverged(B, C);
    }
  });

  it("una op DUPLICADA por el transporte es un no-op exacto (idempotencia)", async () => {
    const server = new FakeCollabServer(BASE);
    const A = makeReplica(server, "s_aaaaaaaaaaaaaaaa", 1, "Ana");
    const B = makeReplica(server, "s_bbbbbbbbbbbbbbbb", 2, "Bruno");
    await settle(server, [A, B]);

    const ops = A.session.sendCommand({
      kind: "insertNode", item: item("dup", "solo una vez"), parentId: "verso:root", slotKey: "content", index: 0,
    });
    await settle(server, [A, B]);

    const before = B.session.signature();
    // Un `resync` devuelve ops que B YA tiene aplicadas. Repetirlo varias veces es exactamente lo
    // que hace un cliente que reconecta a trompicones, y no puede mover el estado ni un byte.
    for (let i = 0; i < 3; i++) {
      await B.session.resync();
      await settle(server, [A, B]);
    }

    expect(B.session.signature()).toBe(before);
    expect(ops.length).toBeGreaterThan(0);
    expectConverged(A, B);
  });

  it("un hueco de entrega se cierra solo por `resync` y las réplicas vuelven a coincidir", async () => {
    const server = new FakeCollabServer(BASE);
    const A = makeReplica(server, "s_aaaaaaaaaaaaaaaa", 1, "Ana");
    const B = makeReplica(server, "s_bbbbbbbbbbbbbbbb", 2, "Bruno");
    await settle(server, [A, B]);

    // A inserta DOS bloques encadenados: el segundo depende posicionalmente del primero.
    A.session.sendCommand({ kind: "insertNode", item: item("g1", "uno"), parentId: "verso:root", slotKey: "content", index: 0 });
    await A.timers.run();
    A.session.sendCommand({ kind: "insertNode", item: item("g2", "dos"), parentId: "verso:root", slotKey: "content", index: 1 });
    await A.timers.run();

    // Se TIRA el primer envío y solo se entrega el segundo: B recibe una op cuya dependencia no ha
    // visto ⇒ tiene que detectar el hueco y pedir `resync` sola.
    const queued = server.pending;
    expect(queued).toBeGreaterThan(1);
    server.deliver((items) => items.slice(1));

    await settle(server, [A, B]);
    expectConverged(A, B);
    expect(byPropId(A.session.doc()!, "g1")).toBeTruthy();
    expect(byPropId(B.session.doc()!, "g1")).toBeTruthy();
    expect(byPropId(B.session.doc()!, "g2")).toBeTruthy();
    // El orden final es el mismo en las dos, no solo el conjunto.
    expect(childPropIds(B.session.doc()!)).toEqual(childPropIds(A.session.doc()!));
  });
});

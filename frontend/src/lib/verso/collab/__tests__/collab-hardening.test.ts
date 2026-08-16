/**
 * Verso/colaboración — LO QUE LA SESIÓN PROMETE CUANDO EL SERVIDOR SE PORTA MAL (F8.3).
 *
 * Cada caso de aquí sale de un fallo CONFIRMADO de la revisión adversarial del transporte, y todos
 * comparten la misma regla: un lote solo sale de la cola cuando el servidor dice qué ha hecho con
 * cada op, y nada se degrada sin decirlo.
 *
 *   · la identidad de réplica la ASIGNA el servidor y el cliente la adopta (si fuera un dato del
 *     cliente, presentar la de otro editor bastaría para emitir a su nombre);
 *   · un fallo de guardado (503) o una contabilidad que no cuadra devuelven el lote a la cola;
 *   · `persisted:false` degrada la sesión de forma VISIBLE;
 *   · el valor que el saneador del servidor reescribió se adopta (el emisor no recibe su propio eco,
 *     así que este es su único camino para no quedarse con el crudo para siempre);
 *   · un rechazo de sala recuperable se reintenta; uno terminal para la sesión.
 */

import { describe, expect, it } from "vitest";

import { deriveSite, FakeCollabServer } from "./fakeServer";
import { VersoCollabSession } from "../client";
import { ManualTimers } from "./fakeServer";
import type { CollabNotice, CollabTransport, PostResponse, StreamHandlers } from "../types";
import type { VersoData } from "../../types";

const BASE: VersoData = {
  root: { props: { title: "T" } },
  content: [{ type: "Text", props: { id: "t1", text: "uno" } }],
};

const SITE = "s_aaaaaaaaaaaaaaaa";

function makeSession(
  transport: CollabTransport,
  extra: Partial<ConstructorParameters<typeof VersoCollabSession>[0]> = {},
) {
  const timers = new ManualTimers();
  const notices: CollabNotice[] = [];
  const session = new VersoCollabSession(
    {
      postId: 7, transport, siteId: SITE, flushMs: 10, presenceMs: 10,
      setTimer: timers.set, clearTimer: timers.clear,
      ...extra,
    },
    { onNotice: (n) => notices.push(n) },
  );
  return { session, timers, notices };
}

describe("identidad de réplica asignada por el servidor", () => {
  it("adopta el `siteId` del `welcome` y firma sus ops con él, no con el nonce local", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    // Derivación REAL del doble (no idempotente), no una constante: con `siteFor = () => X` el punto
    // fijo hacía que mandar la identidad en vez del nonce diera lo mismo, y el bug era invisible.
    const asignado = deriveSite(SITE);
    server.register({ siteId: SITE, userId: 3, name: "Ana" });

    const enviados: { siteId: string }[] = [];
    const real = server.transport();
    const espia: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (url.endsWith("/ops")) enviados.push(body as { siteId: string });
        return real.post(url, body);
      },
    };
    const { session, timers } = makeSession(espia);
    session.start();
    await timers.run();

    expect(session.id).toBe(asignado);
    expect(session.snapshot().siteId).toBe(asignado);

    const ops = session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.id.site === asignado)).toBe(true);
    expect(enviados[0].siteId).toBe(asignado);
  });

  it("al RECONECTAR sigue mandando el NONCE, conserva la identidad y NO tira la cola ni pisa el canvas", async () => {
    // El defecto: el cliente guardaba el nonce y la identidad derivada en la MISMA variable, así que
    // al reconectar mandaba la derivada como nonce. Como la derivación del servidor es un HMAC (no
    // idempotente), salía OTRA identidad: `identityChanged` ⇒ `outbox = []` (las ediciones encoladas
    // a la basura), `state = buildState(base)` y `onReady` otra vez ⇒ el editor hace
    // `applyRemoteDoc(doc, {resetHistory:true})` y pisa el canvas y el deshacer. En CADA parpadeo de
    // red. Y la conexión vieja no se desalojaba en el servidor: a las 3 reconexiones, `too-many-tabs`.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 3, name: "Ana" });

    const real = server.transport();
    let tragarse = false;
    const conCorte: CollabTransport = {
      openStream: real.openStream,
      // Mientras el canal está caído, el POST de ops no llega: así hay cola pendiente que perder.
      post: async (url, body) => {
        if (tragarse && url.endsWith("/ops")) throw new Error("sin red");
        return real.post(url, body);
      },
    };

    const readies: unknown[] = [];
    const timers = new ManualTimers();
    const notices: CollabNotice[] = [];
    const session = new VersoCollabSession(
      { postId: 7, transport: conCorte, siteId: SITE, flushMs: 10, presenceMs: 10, setTimer: timers.set, clearTimer: timers.clear },
      { onNotice: (n) => notices.push(n), onReady: (doc) => readies.push(doc) },
    );

    session.start();
    await timers.run();
    const identidad = session.id;
    expect(identidad).toBe(deriveSite(SITE));

    // Se corta la red y se encola una edición que no puede salir.
    tragarse = true;
    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();
    expect(session.snapshot().pendingOps).toBeGreaterThan(0);

    server.dropStream(identidad);
    tragarse = false;
    await timers.run();

    // 1. El productor real vuelve a mandar el NONCE, no la identidad derivada.
    expect(server.openedWith).toEqual([SITE, SITE]);
    // 2. Por eso la identidad es la MISMA: es lo que permite al servidor desalojar la conexión vieja.
    expect(session.id).toBe(identidad);
    // 3. La cola sobrevivió y acabó entregándose: ni una edición perdida.
    expect(notices.some((n) => n.code === "identity-reset")).toBe(false);
    expect(session.snapshot().pendingOps).toBe(0);
    expect(server.log).toHaveLength(1);
    // 4. Y el canvas no se pisa: `onReady` es del arranque, no de cada reconexión.
    expect(readies).toHaveLength(1);
    expect(session.doc()!.nodes.t1.props.color).toBe("rojo");
  });
});

describe("los reintentos de conexión se agotan", () => {
  it("un rechazo de sala repetido deja de reintentarse en `maxRetries`, no reintenta para siempre", async () => {
    // El rechazo viaja DENTRO del stream con HTTP 200 (los headers ya salieron), así que `onopen`
    // dispara igual. Con `retries = 0` en cada apertura, la guarda `retries < maxRetries` no llegaba
    // NUNCA: una pestaña de más gastaba 1 petición/segundo indefinidamente —cada una con su
    // `authenticate` + `Post.findById` + gate— y con `server-full` entraban TODOS los editores del
    // sitio en el bucle a la vez, realimentando la saturación. El contador se pone a cero cuando la
    // sesión se establece de verdad (un `welcome`), no cuando se abre un socket.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    let intentos = 0;
    const lleno: CollabTransport = {
      openStream: (_url: string, h: StreamHandlers) => {
        intentos++;
        h.onOpen();
        h.onEvent("error", { code: "too-many-tabs", message: "demasiadas pestañas" });
        return { close: () => undefined };
      },
      post: server.transport().post,
    };
    const { session, timers, notices } = makeSession(lleno, { maxRetries: 4 });
    session.start();
    await timers.run();

    expect(intentos).toBe(5); // el primero + 4 reintentos
    expect(session.snapshot().status).toBe("offline");
    expect(notices.at(-1)!.code).toBe("transport-error");

    // Y no queda nada programado que lo reabra más tarde.
    await timers.run();
    expect(intentos).toBe(5);
  });

  it("una sesión que SÍ llega a establecerse recupera sus reintentos", async () => {
    // La contracara: poner el contador a cero en el `welcome` no puede convertir un canal sano con
    // cortes esporádicos en una sesión que se rinde a la sexta caída del día.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const { session, timers } = makeSession(server.transport(), { maxRetries: 2 });
    session.start();
    await timers.run();

    for (let i = 0; i < 5; i++) {
      server.dropStream(SITE);
      await timers.run();
      expect(session.snapshot().status).toBe("live");
    }
  });
});

describe("la sala se reinició bajo mis pies", () => {
  it("un `room_reset` NO deja la sesión en `live` y muda: avisa y re-siembra desde el contenido nuevo", async () => {
    // Si una sala se retira con alguien dentro (fila de liveness perdida, reloj corrido entre nodos),
    // su stream sigue sano: sin este aviso se quedaba en `live` hasta que tecleara, y entonces
    // descartaba el lote quedándose con un documento derivado del base VIEJO — que al guardar pisa lo
    // que se guardó por fuera y la sesión de los demás.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const { session, timers, notices } = makeSession(server.transport());
    session.start();
    await timers.run();
    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "verde" } });
    await timers.run();

    // La sala se retiró y se re-sembró desde el `_puck_data` que alguien guardó por otra vía.
    server.epoch = 2;
    server.log = [];
    server.base = JSON.stringify({ root: { props: {} }, content: [{ type: "Text", props: { id: "t1", text: "guardado" } }] });
    server.emit(deriveSite(SITE), "warning", { code: "room_reset", message: "La sesión colaborativa se reinició." });
    await timers.run();

    expect(notices.some((n) => n.code === "epoch-reset")).toBe(true);
    // Y no se queda en el aviso: se re-siembra de verdad desde el contenido nuevo.
    expect(session.snapshot().epoch).toBe(2);
    expect(session.doc()!.nodes.t1.props.text).toBe("guardado");
    expect(session.snapshot().status).toBe("live");
  });
});

describe("el servidor no se hizo cargo del lote: nunca se da por entregado", () => {
  it("un 503 devuelve las ops a la cola, avisa y reintenta", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    let caido = true;
    const roto: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (url.endsWith("/ops") && caido) {
          caido = false;
          return { status: 503, body: { code: "collab_store_failed" } } as PostResponse;
        }
        return real.post(url, body);
      },
    };
    const { session, timers, notices } = makeSession(roto);
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();

    expect(notices.some((n) => n.code === "store-failed")).toBe(true);
    expect(session.snapshot().pendingOps).toBe(0);
    expect(server.log).toHaveLength(1);
  });

  it("un 200 cuya contabilidad no cuadra devuelve el lote a la cola", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    let mentira = true;
    const tramposo: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (url.endsWith("/ops") && mentira) {
          mentira = false;
          // "OK" sin hacerse cargo de nada: ni aceptada, ni conocida, ni rechazada.
          return { status: 200, body: { ok: true, accepted: 0, known: 0, rejected: [] } } as PostResponse;
        }
        return real.post(url, body);
      },
    };
    const { session, timers, notices } = makeSession(tramposo);
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();

    expect(notices.some((n) => n.code === "store-failed")).toBe(true);
    expect(server.log).toHaveLength(1);
    expect(session.snapshot().pendingOps).toBe(0);
  });

  it("`persisted:false` (difundido pero no guardado) degrada la sesión y lo dice", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    const lleno: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (url.endsWith("/ops")) {
          return { status: 200, body: { ok: true, accepted: 1, known: 0, rejected: [], persisted: false } } as PostResponse;
        }
        return real.post(url, body);
      },
    };
    const { session, timers, notices } = makeSession(lleno);
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();

    expect(session.snapshot().status).toBe("degraded");
    expect(notices.some((n) => n.code === "log-full")).toBe(true);
  });
});

describe("adopción del valor saneado y rechazos recuperables", () => {
  it("adopta el valor que el saneador del servidor reescribió en vez de quedarse con el crudo", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    const saneador: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (url.endsWith("/ops")) {
          const ops = (body as { ops: { k: string; id: { site: string; counter: number }; nodeId?: string; key?: string }[] }).ops;
          const primera = ops.find((o) => o.k === "propSet") ?? ops[0];
          return {
            status: 200,
            body: {
              ok: true, accepted: ops.length, known: 0, rejected: [], persisted: true,
              normalized: [{ ...primera, value: "Ropa &amp; Complementos" }],
            },
          } as PostResponse;
        }
        return real.post(url, body);
      },
    };
    const { session, timers, notices } = makeSession(saneador);
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { text: "Ropa & Complementos" } });
    await timers.run();

    expect(session.doc()!.nodes.t1.props.text).toBe("Ropa &amp; Complementos");
    expect(notices.some((n) => n.code === "normalized")).toBe(true);
  });

  it("un rechazo de sala RECUPERABLE no mata la sesión: se reintenta la conexión", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    let primera = true;
    const ocupado: CollabTransport = {
      openStream: (url: string, h: StreamHandlers) => {
        if (primera) {
          primera = false;
          h.onOpen();
          h.onEvent("error", { code: "site-taken", message: "identidad ocupada" });
          return { close: () => undefined };
        }
        return real.openStream(url, h);
      },
      post: real.post,
    };
    const { session, timers } = makeSession(ocupado);
    session.start();
    await timers.run();

    expect(session.snapshot().status).toBe("live");
    expect(session.doc()).not.toBeNull();
  });

  it("un rechazo TERMINAL (forbidden) sigue parando la sesión, sin reintentos", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    let intentos = 0;
    const prohibido: CollabTransport = {
      openStream: (_url: string, h: StreamHandlers) => {
        intentos++;
        h.onOpen();
        h.onEvent("error", { code: "forbidden", message: "no puedes editar esto" });
        return { close: () => undefined };
      },
      post: real.post,
    };
    const { session, timers, notices } = makeSession(prohibido);
    session.start();
    await timers.run();

    expect(intentos).toBe(1);
    expect(notices.some((n) => n.code === "forbidden")).toBe(true);
    expect(session.snapshot().status).toBe("offline");
  });
});

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
import { ManualTimers, settleMicrotasks } from "./fakeServer";
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

/**
 * EL DOBLE TAMBIÉN SE TESTEA.
 *
 * La ronda anterior dejó escapar el bug del cliente porque `siteFor` era la función IDENTIDAD: un
 * doble que no reproduce la propiedad que se quiere probar no prueba nada. Estos casos fijan las DOS
 * propiedades de `deriveSite` de las que cuelgan los tests de identidad, para que el doble no vuelva
 * a mentir en silencio.
 */
describe("el doble deriva identidades que PODRÍAN existir", () => {
  // El `replicaId` real (`backend/src/core/collab-rooms.ts`) proyecta el HMAC sobre 16 caracteres del
  // alfabeto base32 y devuelve `s_` + esos 16: ANCHO FIJO, siempre 18. Ésa es la forma exacta, y no
  // basta con el filtro `^s_[a-z2-7]{1,32}$` de la ruta — que es más laxo y, de hecho, deja pasar la
  // cadena "undefined" enterita porque son letras minúsculas.
  const EXACTA = /^s_[a-z2-7]{16}$/;

  it("toda identidad derivada tiene el ANCHO FIJO del `replicaId` real", () => {
    // El helper hacía `(… ) ^ (i * 7)` y `^` devuelve int32 CON SIGNO: cuando el operando trae el bit
    // alto puesto (posiciones 0 y 8, ~75% de los nonces) `mix` salía negativo, `mix % 32` negativo y
    // `SITE_ALPHABET[negativo]` es `undefined`, que se concatena como la CADENA "undefined".
    // `deriveSite('s_bbbbbbbbbbbbbbbb')` daba `s_k53s2j6uundefined6qkmi5c` — 25 caracteres — y ése es
    // el nonce de Bruno en `collab-session.test.ts` y en las cinco réplicas B de la convergencia.
    //
    // Por qué el ancho y no solo el alfabeto: "undefined" son nueve letras a-z, así que las
    // identidades rotas PASABAN el filtro de la ruta. Un test de "forma" que solo mira el alfabeto
    // sigue verde con el bug dentro — lo comprobé revirtiéndolo. Lo que delata la corrupción es que
    // el identificador mide otra cosa.
    const malas: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const nonce = `s_${i.toString(32).padStart(16, "a")}`;
      const derivada = deriveSite(nonce);
      if (!EXACTA.test(derivada)) malas.push(`${nonce} -> ${derivada} (${derivada.length})`);
      // Y la derivada de una derivada también es un identificador legal: es EXACTAMENTE lo que
      // mandaba el cliente roto, y por eso no saltaba ni un 400 y el fallo era silencioso.
      const otraVuelta = deriveSite(derivada);
      if (!EXACTA.test(otraVuelta)) malas.push(`${derivada} -> ${otraVuelta} (${otraVuelta.length})`);
    }
    expect(malas.slice(0, 3)).toEqual([]);
    expect(malas).toHaveLength(0);
  });

  it("es DETERMINISTA y NO idempotente, como el `replicaId` real", () => {
    // Sin la primera propiedad el servidor no podría desalojar la conexión vieja al reconectar; sin
    // la segunda, mandar la identidad en vez del nonce daría lo mismo y el bug sería invisible.
    const nonce = "s_aaaaaaaaaaaaaaaa";
    expect(deriveSite(nonce)).toBe(deriveSite(nonce));
    expect(deriveSite(deriveSite(nonce))).not.toBe(deriveSite(nonce));
  });
});

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

/**
 * EL 429 ES UN CONTRATO CON DOS EXTREMOS, y romperlo cuesta la sesión entera.
 *
 * El servidor cuenta un strike a quien reintenta antes de su `RATE_RETRY_MS` y a los TRES cierra la
 * conexión con `rate_limit`, que este cliente trata como terminal: editor mudo hasta recargar. Los
 * dos caminos de subida tienen que respetar esa espera, y la espera tiene que salir del `welcome` —
 * no de un 1000 escrito a mano aquí que casaba con el 900 del servidor por 100 ms de casualidad.
 */
describe("la espera que pide el servidor se respeta en TODOS los caminos", () => {
  function conReloj(server: FakeCollabServer) {
    const timers = new ManualTimers();
    server.clock = () => timers.time;
    return timers;
  }

  it("la PRESENCIA espera tras un 429 en vez de re-postear cada 50 ms", async () => {
    // AQUÍ vivía F2 después de la ronda 2. `setSelection` hacía
    // `void this.post("presence", …).catch(() => undefined)`: ni siquiera miraba el status. Bajar con
    // las flechas por el documento son decenas de POST separados 50 ms; con el cubo de bytes en
    // descubierto tras un `resync` legítimo el servidor los rechazaba, contaba tres «ignoró la
    // espera» seguidos y CERRABA la sesión. ~150 ms de mover el cursor y editor mudo.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    server.refuse.presence = 3;
    const timers = conReloj(server);

    const session = new VersoCollabSession(
      {
        postId: 7, transport: server.transport(), siteId: SITE, flushMs: 10, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
      },
      {},
    );
    session.start();
    await timers.run();

    // El editor mueve el cursor de bloque en bloque: `VersoEditor` llama a `setSelection` en cada
    // cambio de nodo seleccionado.
    for (let i = 0; i < 6; i++) {
      session.setSelection({ nodeId: `n${i}` });
      await timers.run();
    }

    const presencias = server.posted.filter((p) => p.path === "presence").map((p) => p.at);
    expect(presencias.length).toBeGreaterThanOrEqual(4);   // 3 rechazados + al menos uno bueno
    expect(server.refuse.presence).toBe(0);                 // y se reintentó de verdad, no se abandonó

    // Los tres primeros fueron 429: el cliente no puede volver dentro de la ventana del servidor.
    const huecos = presencias.slice(1, 4).map((at, i) => at - presencias[i]);
    expect(Math.min(...huecos)).toBeGreaterThan(server.rateRetryMs);
  });

  it("el backoff sale del `welcome`, no de un número escrito a mano en el cliente", async () => {
    // El invariante `RATE_RETRY_MS (900) < backoff del cliente (1000)` vivía en dos ficheros de dos
    // paquetes, sin nada que los atara. Subir la constante del servidor a 5000 reabría la expulsión
    // en silencio y ningún test se ponía rojo. Ahora la ventana viaja en `limits.rateRetryMs` y el
    // cliente la respeta con margen: aquí se sube a 5000 y el cliente TIENE que esperar más.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    server.rateRetryMs = 5_000;
    server.refuse.ops = 1;
    const timers = conReloj(server);

    const session = new VersoCollabSession(
      {
        postId: 7, transport: server.transport(), siteId: SITE, flushMs: 10, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
      },
      {},
    );
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();

    const envios = server.posted.filter((p) => p.path === "ops").map((p) => p.at);
    expect(envios.length).toBe(2);                       // el 429 y el reintento que sí entra
    expect(envios[1] - envios[0]).toBeGreaterThan(server.rateRetryMs);
    expect(server.log).toHaveLength(1);                  // y la op no se pierde por el camino
  });

  it("el reintento del envío tiene PRESUPUESTO: un 503 permanente no postea para siempre", async () => {
    // El bucle a 1 Hz sin fin que se cerró en el stream (`maxRetries`) seguía abierto por la puerta
    // de `ops`: 5xx o red caída devolvían el lote a la cola con `backoffMs = 1000` FIJO y el
    // `finally` reprogramaba `flushSoon()`. Sin tope y sin rendición. Y el 503 por una fila del log
    // ilegible es permanente POR CONSTRUCCIÓN, así que la pestaña posteaba 3600 veces por hora,
    // pagando `authenticate` + `Post.findById` en cada una y agotando el `apiLimiter` global
    // (1000 req/15 min POR IP) en ~17 min para todo el que compartiera esa IP.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = conReloj(server);
    const real = server.transport();
    const roto: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (url.endsWith("/ops")) return { status: 503, body: { code: "collab_store_failed" } } as PostResponse;
        return real.post(url, body);
      },
    };
    const notices: CollabNotice[] = [];
    const session = new VersoCollabSession(
      {
        postId: 7, transport: roto, siteId: SITE, flushMs: 10, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
      },
      { onNotice: (n) => notices.push(n) },
    );
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();

    const envios = server.posted.filter((p) => p.path === "ops");
    expect(envios.length).toBeLessThanOrEqual(8);
    expect(notices.some((n) => n.code === "store-failed" && /deja de reintentar/i.test(n.message))).toBe(true);
    expect(session.snapshot().status).toBe("degraded");
    // Rendirse NO es perder: la op sigue en la cola y el documento local la conserva.
    expect(session.snapshot().pendingOps).toBe(1);

    // Y no queda nada programado: el bucle está muerto, no dormido.
    const antes = server.posted.length;
    await timers.run();
    expect(server.posted.length).toBe(antes);
  });

  it("una reconexión que SÍ se establece devuelve el presupuesto de envío", async () => {
    // Rendirse es definitivo hasta que la sesión vuelve a existir: el `welcome` es la única señal de
    // que algo cambió de verdad. Si tecleando se rearmara el reintento, el presupuesto no valdría.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = conReloj(server);
    const real = server.transport();
    let caido = true;
    const roto: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (url.endsWith("/ops") && caido) return { status: 503, body: { code: "collab_store_failed" } } as PostResponse;
        return real.post(url, body);
      },
    };
    const session = new VersoCollabSession(
      {
        postId: 7, transport: roto, siteId: SITE, flushMs: 10, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
      },
      {},
    );
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();
    expect(session.snapshot().pendingOps).toBe(1);       // se rindió con la op dentro

    // Vuelve el servidor y se cae el canal: al reconectar llega un `welcome` y todo se rearma.
    caido = false;
    server.dropStream(SITE);
    await timers.run();

    expect(session.snapshot().pendingOps).toBe(0);
    expect(server.log).toHaveLength(1);
  });

  /**
   * EL ARREGLO DE LA RONDA 4, con el hueco que lo hacía invisible ya tapado en el doble.
   *
   * La espera se perdía en el PLANIFICADOR: el 429 se procesaba cuando el POST respondía, y si
   * durante ese vuelo una pulsación armaba el temporizador corto, `flushSoon()` se encontraba la
   * ranura ocupada y RETORNABA. La espera no se aplazaba: se descartaba, y el siguiente POST salía a
   * los 100 ms, dentro de la ventana del servidor. Sin tiempo de vuelo en el doble, esa carrera NO
   * SE PUEDE REPRESENTAR — por eso los 45 tests seguían verdes con el defecto dentro.
   */
  it("una pulsación DURANTE el vuelo del 429 no adelanta el siguiente envío", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    server.latencyMs = 60;                 // RTT 120 ms: el hueco donde vive la carrera
    server.refuse.ops = 1;

    const session = new VersoCollabSession(
      {
        postId: 7, transport: server.transport(), siteId: SITE, flushMs: 100, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
      },
      {},
    );
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { a: "1" } });
    // Pulsaciones mientras el primer POST está EN EL AIRE. Cada una llama a `flushSoon()`, que es
    // por donde se colaba el temporizador de 100 ms que se comía la espera.
    for (let i = 0; i < 6; i++) {
      timers.set(() => session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { [`b${i}`]: "1" } }), 110 + i * 20);
    }
    await timers.run(5_000);

    const envios = server.posted.filter((p) => p.path === "ops").map((p) => p.at);
    expect(envios.length).toBeGreaterThanOrEqual(2);
    const hueco = envios[1] - envios[0];
    expect(
      hueco,
      `tras un 429 el siguiente envío tiene que ir DESPUÉS de la ventana del servidor, ` +
      `teclee el usuario o no: salió a los ${hueco} ms (envíos en ${JSON.stringify(envios)})`,
    ).toBeGreaterThan(server.rateRetryMs);
  });

  /**
   * DÓNDE VIVE EL INVARIANTE, y por qué no puede vivir en los planificadores.
   *
   * `resync()` es API pública y el propio cliente la llama FUERA de todo planificador (el aviso
   * `room_reset` del servidor hace `void this.resync()`). Un freno que viviera en los `xxxSoon()`
   * —la arquitectura de la ronda 3— no cubre este camino: mandaría dentro de la ventana y con el
   * acuse puesto, que es lo único que el servidor puede castigar. Tres así y fuera de la sala.
   *
   * Por eso la espera se aplica en `post()`, que es la única puerta de salida del cliente. Este test
   * es lo que separa las dos arquitecturas: con el freno en `post()` no pasa nada; con el freno solo
   * en los planificadores, el servidor expulsa.
   */
  it("un `resync` pedido A PELO durante la espera no se salta el freno", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    server.latencyMs = 30;
    server.refuse.resync = 6;

    const notices: CollabNotice[] = [];
    const session = new VersoCollabSession(
      {
        postId: 7, transport: server.transport(), siteId: SITE, flushMs: 100, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
      },
      { onNotice: (n) => notices.push(n) },
    );
    session.start();
    await timers.run();

    // TODO programado antes de correr el reloj: `run()` lo agota, y programar después dejaría las
    // peticiones FUERA de la ventana de espera — el test pasaría en verde sin probar nada.
    // El primero se rechaza y deja una espera en vigor; los tres siguientes caen DENTRO de ella,
    // que es cuando el servidor puede probar desobediencia.
    timers.set(() => { void session.resync(); }, 10);
    for (let i = 0; i < 3; i++) timers.set(() => { void session.resync(); }, 120 + i * 90);
    await timers.run(20_000);

    expect(
      server.expulsiones.length,
      `expulsado por peticiones que el propio cliente hace fuera del planificador: ` +
      `${JSON.stringify(server.posted.map((p) => `${p.path}@${p.at}=${p.status}`))}`,
    ).toBe(0);
    expect(server.posted.some((p) => p.status === 409), "y ni un 409 collab_no_session").toBe(false);
    expect(notices.some((n) => n.code === "transport-error")).toBe(false);
  });

  /**
   * El aparcado de ranuras del planificador es TRÁFICO, no corrección (la corrección la sostiene
   * `post()`, arriba). Este test lo ancla por lo que hace: sin él, cada disparo del temporizador
   * mientras el freno está puesto encola una petición más, y bajar por el documento con las flechas
   * durante una espera de un segundo son veinte POST amontonados esperando a que se suelte.
   */
  it("con el freno puesto, mover el cursor no amontona una petición por movimiento", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    server.refuse.presence = 1;

    const session = new VersoCollabSession(
      {
        postId: 7, transport: server.transport(), siteId: SITE, flushMs: 100, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
      },
      {},
    );
    session.start();
    await timers.run();

    // TODO se programa ANTES de correr el reloj: `run()` avanza hasta agotar la cola, así que
    // programar después de correrlo dejaría los movimientos FUERA de la ventana de espera y el test
    // mediría otra cosa (pasa en verde sin probar nada).
    timers.set(() => session.setSelection({ nodeId: "n0" }), 10);
    for (let i = 1; i <= 20; i++) timers.set(() => session.setSelection({ nodeId: `n${i}` }), 60 + i * 40);
    await timers.run(20_000);

    const presencias = server.posted.filter((p) => p.path === "presence");
    expect(
      presencias.length,
      `una espera no puede convertirse en una petición por movimiento: ${presencias.length} POST /presence`,
    ).toBeLessThanOrEqual(4);
  });

  it("el `resync` también respeta la espera: era el único camino que se tragaba el 429", async () => {
    // `resync()` hacía `if (res.status !== 200) return;`. Ni aplicaba la espera —así que el siguiente
    // frame de CUALQUIER camino salía como si nada— ni reintentaba, con lo que el hueco de entrega
    // que motivó el resync se quedaba abierto y la réplica divergía en silencio.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    server.refuse.resync = 1;

    const session = new VersoCollabSession(
      {
        postId: 7, transport: server.transport(), siteId: SITE, flushMs: 100, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
      },
      {},
    );
    session.start();
    await timers.run();

    // `resync()` se llama a pelo, fuera de todo temporizador: hay que dejar asentar su cadena de
    // promesas ANTES de correr el reloj, o `run()` sale sin haber visto nada programado.
    void session.resync();
    await settleMicrotasks();
    await timers.run(5_000);

    const resyncs = server.posted.filter((p) => p.path === "resync").map((p) => p.at);
    expect(resyncs.length, "un `resync` rechazado tiene que reintentarse, no perderse").toBeGreaterThanOrEqual(2);
    expect(
      resyncs[1] - resyncs[0],
      `y el reintento va DESPUÉS de la ventana del servidor: ${resyncs[1] - resyncs[0]} ms`,
    ).toBeGreaterThan(server.rateRetryMs);
  });

  it("todos los frames llevan el acuse del último aviso visto", async () => {
    // Sin `rateAck` el servidor no puede distinguir un frame EN VUELO de uno desobediente, y su única
    // salida sería volver a castigar por tiempo — que es lo que expulsaba a gente inocente. El acuse
    // es lo que sostiene la mitad de la propiedad que vive en el servidor: quitarlo no «relaja» nada,
    // reabre el defecto por el otro lado.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    server.refuse.ops = 1;

    const cuerpos: Record<string, unknown>[] = [];
    const real = server.transport();
    const espia: CollabTransport = {
      openStream: real.openStream,
      post: (url, body) => { cuerpos.push(body as Record<string, unknown>); return real.post(url, body); },
    };
    const session = new VersoCollabSession(
      {
        postId: 7, transport: espia, siteId: SITE, flushMs: 100, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
      },
      {},
    );
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { a: "1" } });
    session.setSelection({ nodeId: "n1" });
    await timers.run(5_000);

    expect(cuerpos.length).toBeGreaterThan(1);
    for (const c of cuerpos) {
      expect(typeof c.rateAck, `todo frame lleva acuse: ${JSON.stringify(c).slice(0, 120)}`).toBe("number");
    }
    // Y después del 429 el acuse SUBE: se devuelve el aviso que se acaba de recibir, no un cero fijo.
    expect(
      Math.max(...cuerpos.map((c) => Number(c.rateAck))),
      "tras un 429 el acuse tiene que subir, o el servidor nunca sabrá que nos enteramos",
    ).toBeGreaterThan(0);
  });

  it("la espera de la RECONEXIÓN también sale del `welcome`, no de un 1000 escrito a mano", async () => {
    // Era el último número duplicado: `Math.min(1000 * 2 ** retries, 30_000)`, copiado además en DOS
    // manejadores. Con la ventana del servidor a 5000, la primera reconexión tiene que esperar en esa
    // escala; con un 1000 fijo esperaría 1000 pase lo que pase.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    server.rateRetryMs = 5_000;

    const session = new VersoCollabSession(
      {
        postId: 7, transport: server.transport(), siteId: SITE, flushMs: 100, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
      },
      {},
    );
    session.start();
    await timers.run();

    const cortadoEn = timers.time;
    server.dropStream(SITE);
    await timers.run(5_000);

    // `openedWith` guarda cada apertura del stream: la segunda es la reconexión.
    expect(server.openedWith.length).toBeGreaterThanOrEqual(2);
    const reabiertoEn = server.posted.length ? server.posted[server.posted.length - 1].at : timers.time;
    expect(
      reabiertoEn - cortadoEn,
      "la unidad del backoff de reconexión es la ventana que publica el servidor",
    ).toBeGreaterThanOrEqual(server.rateRetryMs);
  });
});

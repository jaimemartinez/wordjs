/**
 * Verso/colaboración — NINGUNA OPERACIÓN SE PIERDE EN SILENCIO (F8.3).
 *
 *     O SE ENTREGA, O EL CLIENTE SE ENTERA. No hay tercera opción.
 *
 * Este fichero no comprueba que no haya errores: COMPARA NÚMEROS. Cuántas ops emitió el editor,
 * cuántas quedaron en el log del servidor y cuántas llegaron al OTRO editor. Si esos tres números no
 * coinciden, falla — y falla diciendo cuántas faltan. Una ausencia de errores es exactamente lo que
 * tenía el defecto que este fichero cierra: la rama 409 de `flush()` tiraba el lote en vuelo, emitía
 * un aviso que además mentía («la sesión se reinició» cuando solo se había caído el stream) y ningún
 * test de los 70 lo veía, porque ninguno contaba nada de punta a punta.
 *
 * DOS COSAS SIN LAS CUALES ESTO NO PROBARÍA NADA, y las dos hay que sostenerlas a propósito:
 *
 *  1. QUE EL DOBLE CONTESTE 409 SIN STREAM. El `connGate` real responde 409 `collab_no_session` a
 *     todo POST cuyo `siteId` no tenga conexión SSE viva; el doble contestaba 200, así que el hueco
 *     de la reconexión —donde el cliente sigue posteando— era ESTRUCTURALMENTE IRREPRESENTABLE. Cada
 *     escenario de aquí EXIGE que el hueco haya producido 409 de verdad (`server.sinSesion`), o el
 *     verde no significaría nada.
 *  2. QUE HAYA OPS EN VUELO CUANDO SE CAE EL CANAL. Con `flushMs` corto y tecleo continuo siempre hay
 *     un lote fuera de la cola; sin eso, «no se pierde nada» sería cierto por no haber nada que
 *     perder.
 */

import { describe, expect, it } from "vitest";

import { VersoCollabSession } from "../client";
import type { CollabNotice, CollabTransport, PostResponse, StreamHandlers } from "../types";
import { FakeCollabServer, ManualTimers, deriveSite } from "./fakeServer";

const SITE_A = "s_ana";
const SITE_B = "s_bruno";
const BASE = JSON.stringify({
  root: { props: {} },
  content: [{ type: "Text", props: { id: "t1", text: "hola" } }],
});

/** Suma la identidad que TIENE que cumplirse siempre (ver `CollabAccounting`). */
function cuadra(session: VersoCollabSession): boolean {
  const c = session.contabilidad();
  return c.emitidas === c.entregadas + c.rechazadas + c.descartadas + c.pendientes;
}

interface Hueco {
  nombre: string;
  /** Milisegundos que el stream de Ana pasa sin poder abrirse. */
  ancho: number;
  rtt: number;
}

/**
 * EL ESCENARIO DE LA PÉRDIDA, con dos editores de verdad.
 *
 * Ana teclea sin parar. A mitad de camino se le cae el canal y NO puede reabrirse durante `ancho` ms
 * —un parpadeo de red, un despliegue, el gateway reiniciándose— mientras ella sigue tecleando y su
 * cliente sigue posteando contra un servidor que ya no tiene su conexión. Al final se comprueban las
 * TRES cuentas: lo que Ana emitió, lo que quedó guardado y lo que vio Bruno.
 */
async function corre(h: Hueco) {
  const server = new FakeCollabServer(BASE, "auto");
  server.register({ siteId: SITE_A, userId: 1, name: "Ana" });
  server.register({ siteId: SITE_B, userId: 2, name: "Bruno" });
  const timers = server.useTimers(new ManualTimers());
  server.latencyMs = h.rtt / 2;

  const real = server.transport();
  const HUECO_DESDE = 2_000;
  const HUECO_HASTA = HUECO_DESDE + h.ancho;

  // El canal de Ana no puede REABRIRSE mientras dura el hueco. Es lo que distingue este test de un
  // `dropStream` suelto: con la reconexión inmediata el cliente casi no llega a postear sin sesión, y
  // el hueco —que es donde vive la pérdida— se recorre de puntillas.
  const conHueco: CollabTransport = {
    openStream: (url: string, handlers: StreamHandlers) => {
      if (timers.time >= HUECO_DESDE && timers.time < HUECO_HASTA) {
        // El fallo llega en otro tick, como cualquier fallo de red: hacerlo aquí mismo recursaría
        // dentro de `openStream` y el cliente vería un error de un stream que aún no existe.
        timers.set(() => handlers.onError(new Error("hueco de red")), 1);
        return { close: () => undefined };
      }
      return real.openStream(url, handlers);
    },
    post: real.post,
  };

  const avisos: CollabNotice[] = [];
  const ana = new VersoCollabSession(
    {
      postId: 7, transport: conHueco, siteId: SITE_A,
      flushMs: 60, presenceMs: 50, setTimer: timers.set, clearTimer: timers.clear,
    },
    { onNotice: (n) => avisos.push(n) },
  );
  const bruno = new VersoCollabSession(
    {
      postId: 7, transport: real, siteId: SITE_B,
      flushMs: 60, presenceMs: 50, setTimer: timers.set, clearTimer: timers.clear,
    },
    {},
  );
  ana.start();
  bruno.start();
  await timers.run(5_000);

  // TECLEO CONTINUO, con una clave distinta por pulsación: así cada comando es exactamente una op y
  // el documento final se puede CONTAR, no solo comparar.
  const FIN = HUECO_HASTA + 6_000;
  let emitidasPorElEditor = 0;
  let pulsaciones = 0;
  for (let t = 200; t < FIN; t += 120) {
    const n = pulsaciones++;
    timers.set(() => {
      emitidasPorElEditor += ana.sendCommand({
        kind: "setProps", nodeId: "t1", patch: { [`p${n}`]: `v${n}` },
      }).length;
    }, t);
  }
  timers.set(() => server.dropStream(deriveSite(SITE_A)), HUECO_DESDE);

  await timers.run(400_000);

  const siteA = deriveSite(SITE_A);
  const docBruno = bruno.doc();
  return {
    server,
    avisos,
    cuenta: ana.contabilidad(),
    cuadra: cuadra(ana),
    emitidasPorElEditor,
    pulsaciones,
    /** Ops de Ana que quedaron PERSISTIDAS en el log del servidor. */
    enElLog: server.log.filter((op) => op.id.site === siteA).length,
    /** Claves que Bruno tiene de verdad en su réplica: lo que «llegó a los demás». */
    enBruno: Object.keys(docBruno?.nodes.t1?.props ?? {}).filter((k) => /^p\d+$/.test(k)).length,
    /** 409 servidos en el hueco. Sin esto > 0, el escenario no reprodujo nada. */
    sinSesion: server.sinSesion.length,
    porExpulsion: server.sinSesion.filter((s) => s.porExpulsion).length,
  };
}

const HUECOS: Hueco[] = [
  // Los tres anchos que midió el verificador contra el router REAL (4, 14 y 41 ops perdidas).
  { nombre: "parpadeo de 300 ms, RTT 10", ancho: 300, rtt: 10 },
  { nombre: "hueco de 1 s, RTT 10", ancho: 1_000, rtt: 10 },
  { nombre: "hueco de 3 s, RTT 10", ancho: 3_000, rtt: 10 },
  { nombre: "hueco de 3 s, RTT 120", ancho: 3_000, rtt: 120 },
];

describe("CUENTA DE PUNTA A PUNTA: lo que emite el editor, lo que se guarda y lo que ven los demás", () => {
  for (const h of HUECOS) {
    // Plazo explícito: el runner de CI es bastante más lento que una máquina de desarrollo, y estos
    // escenarios recorren decenas de miles de milisegundos simulados con dos sesiones vivas.
    it(h.nombre, async () => {
      const r = await corre(h);

      // ANTI-VACUIDAD PRIMERO. Si el hueco no produjo ni un 409, el doble no está modelando el
      // `connGate` y todo lo de abajo se cumpliría solo.
      expect(r.sinSesion, `el hueco tiene que producir 409 collab_no_session de verdad (${h.nombre})`).toBeGreaterThan(0);
      expect(r.porExpulsion, `y ninguno puede venir de una expulsión (${h.nombre})`).toBe(0);
      expect(r.emitidasPorElEditor, `el editor tiene que emitir ops (${h.nombre})`).toBeGreaterThan(0);

      // LA CUENTA. Tres números que tienen que ser el mismo.
      expect(r.cuenta.emitidas, "la sesión cuenta lo que el editor le dio").toBe(r.emitidasPorElEditor);
      expect(
        r.enElLog,
        `${r.emitidasPorElEditor - r.enElLog} op(s) de Ana NO quedaron persistidas (${h.nombre}): ` +
        `emitidas=${r.emitidasPorElEditor}, en el log=${r.enElLog}, cuenta=${JSON.stringify(r.cuenta)}`,
      ).toBe(r.emitidasPorElEditor);
      expect(
        r.enBruno,
        `Bruno no vio ${r.pulsaciones - r.enBruno} cambio(s) de Ana (${h.nombre}): divergencia permanente`,
      ).toBe(r.pulsaciones);

      // Y LA IDENTIDAD DE LA CONTABILIDAD, que es lo que hace estructural el «no se pierde nada»:
      // un camino nuevo que se llevara un lote rompería esta suma aunque no fallara nada más.
      expect(r.cuadra, `la cuenta no cuadra (${h.nombre}): ${JSON.stringify(r.cuenta)}`).toBe(true);
      expect(r.cuenta.pendientes, "al final no puede quedar nada sin entregar").toBe(0);
      expect(r.cuenta.descartadas, "y nada se descarta: el epoch no cambió, solo se cayó el cable").toBe(0);

      // EL MENSAJE TAMBIÉN ERA FALSO. Perder el stream NO es que la sala se reinicie: decirlo así
      // manda al usuario a recargar y reconciliar un documento que está perfectamente bien.
      expect(
        r.avisos.filter((a) => a.code === "epoch-reset").map((a) => a.message),
        `un parpadeo de red no puede anunciarse como un reinicio de sesión (${h.nombre})`,
      ).toEqual([]);
    }, 30_000);
  }
});

describe("las otras salidas de la cola: ninguna es silenciosa", () => {
  /** Sesión de un solo cliente con el transporte que le pasen. */
  function sesion(transport: CollabTransport, timers: ManualTimers) {
    const avisos: CollabNotice[] = [];
    const session = new VersoCollabSession(
      {
        postId: 7, transport, siteId: SITE_A,
        flushMs: 60, presenceMs: 50, setTimer: timers.set, clearTimer: timers.clear,
      },
      { onNotice: (n) => avisos.push(n) },
    );
    return { session, avisos };
  }

  it("un 200 MUDO (portal cautivo) no cuenta como entregado: se reintenta y se dice", async () => {
    // LA PÉRDIDA MÁS CALLADA QUE HA TENIDO ESTE TRANSPORTE, y la más difícil de ver porque la
    // CONTABILIDAD CUADRABA. Un portal cautivo, la página de mantenimiento de un balanceador o un
    // service worker offline contestan 200 con algo que no es JSON; el transporte entrega `body: null`
    // y el servidor no se ha enterado de nada. La guarda de `flush` empezaba por
    // `typeof body?.accepted === "number"`, así que ante un cuerpo mudo era FALSA y el lote caía en la
    // rama del `else`, que lo daba por entregado. Medido antes del arreglo: 20 ops aplicadas en el
    // canvas del autor, ausentes del log y de la otra réplica, `pendientes: 0`, la identidad contable
    // cuadrando y CERO avisos. Una suma que se cuadra a sí misma porque nadie comprueba que el
    // servidor haya dicho algo.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE_A, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    const { session, avisos } = sesion(server.transport(), timers);
    session.start();
    await timers.run();

    // El portal se traga los envíos de ops (el stream sigue vivo: es lo que hace el caso traicionero).
    server.portalCautivo = (path) => path === "ops";
    for (let i = 0; i < 4; i++) session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { [`p${i}`]: `v${i}` } });
    // Corto a propósito: lo justo para un par de envíos, sin llegar al tope de 8 reintentos (ese
    // caso lo cubre la segunda mitad de este describe).
    await timers.run(100);
    expect(server.tragados.length, "el escenario tiene que tragarse envíos de verdad").toBeGreaterThan(0);
    expect(server.log.length, "y el servidor no puede haber guardado nada").toBe(0);

    const enVuelo = session.contabilidad();
    expect(enVuelo.entregadas, "un 200 sin cuerpo NO es una confirmación").toBe(0);
    expect(enVuelo.pendientes, "las 4 siguen en la cola, que es lo único honesto").toBe(4);
    expect(enVuelo.emitidas).toBe(
      enVuelo.entregadas + enVuelo.rechazadas + enVuelo.descartadas + enVuelo.pendientes,
    );
    expect(
      avisos.some((a) => /no dice|no confirmó|reintent/i.test(a.message)),
      `y se dice: ${JSON.stringify(avisos.map((a) => a.message))}`,
    ).toBe(true);
    // El aviso nombra la causa REAL, que no es «no se pudo guardar» sino «contestó sin decir nada»:
    // el operador que lea esto tiene que poder sospechar del portal cautivo, no de su base de datos.
    expect(avisos.some((a) => /sin decir/i.test(a.message))).toBe(true);
  });

  it("si el portal dura más que los reintentos, la sesión se RINDE diciéndolo y sin dar nada por entregado", async () => {
    // La otra mitad, y es una decisión de diseño deliberada: el cliente no reintenta para siempre
    // (machacaría al servidor y agotaría el limitador de la IP). Lo que NO puede hacer al rendirse es
    // dar el lote por bueno ni callarse: las ops siguen en la cola, contadas como pendientes, y el
    // aviso dice cuántas son y qué hacer.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE_A, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    const { session, avisos } = sesion(server.transport(), timers);
    session.start();
    await timers.run();

    server.portalCautivo = (path) => path === "ops";
    for (let i = 0; i < 4; i++) session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { [`q${i}`]: `v${i}` } });
    await timers.run(120_000);

    const c = session.contabilidad();
    expect(c.entregadas, "rendirse no es entregar").toBe(0);
    expect(c.descartadas, "y tampoco es tirarlas: siguen ahí").toBe(0);
    expect(c.pendientes).toBe(4);
    expect(c.emitidas).toBe(c.entregadas + c.rechazadas + c.descartadas + c.pendientes);
    expect(session.snapshot().status, "y el canal lo refleja").toBe("degraded");
    const rendicion = avisos.filter((a) => /deja de reintentar/i.test(a.message));
    expect(rendicion.length, `tiene que decirlo: ${JSON.stringify(avisos.map((a) => a.message))}`).toBeGreaterThan(0);
    expect(rendicion[rendicion.length - 1].message, "con el número de cambios en juego").toMatch(/4 cambio/);
  });

  it("un `collab_epoch` descarta la cola ENTERA de una vez, con el número exacto y contándolo", async () => {
    // Aquí las ops SÍ están perdidas para el canal —hablan de un estado que ya no existe— y por eso
    // la salida legítima es descartarlas. Lo que no es legítimo es hacerlo sin decir cuántas: antes
    // cada lote soltaba su propio aviso con una cifra distinta (el tamaño del lote, no el de la cola)
    // y las ops desaparecían sin quedar anotadas en ninguna parte.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE_A, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    const real = server.transport();
    let caducado = false;
    const transport: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) =>
        (caducado && url.endsWith("/ops")
          ? ({ status: 409, body: { code: "collab_epoch" } } as PostResponse)
          : real.post(url, body)),
    };
    const { session, avisos } = sesion(transport, timers);
    session.start();
    await timers.run();

    caducado = true;
    for (let i = 0; i < 5; i++) session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { [`p${i}`]: `v${i}` } });
    const emitidas = session.contabilidad().emitidas;
    expect(emitidas).toBe(5);
    await timers.run(60_000);

    const c = session.contabilidad();
    expect(c.descartadas, "las 5 salen de la cola por la puerta que las cuenta").toBe(5);
    expect(c.pendientes, "y no queda ninguna dando vueltas").toBe(0);
    expect(c.emitidas).toBe(c.entregadas + c.rechazadas + c.descartadas + c.pendientes);

    // UN aviso, con el número de la COLA entera, no uno por lote con el número del lote.
    const reinicios = avisos.filter((a) => a.code === "epoch-reset");
    expect(reinicios.length, `un solo aviso: ${JSON.stringify(reinicios.map((a) => a.message))}`).toBe(1);
    expect(reinicios[0].message).toMatch(/5 cambio/);
  });

  it("una op que NO CABE ni sola se descarta contándola, en vez de reintentarse para siempre", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE_A, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    const real = server.transport();
    const transport: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) =>
        (url.endsWith("/ops") ? ({ status: 413, body: { code: "collab_frame_too_large" } } as PostResponse) : real.post(url, body)),
    };
    const { session, avisos } = sesion(transport, timers);
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { enorme: "x".repeat(100) } });
    await timers.run(120_000);

    const c = session.contabilidad();
    expect(c.emitidas).toBe(1);
    expect(c.descartadas, "sale de la cola, y anotada").toBe(1);
    expect(c.pendientes, "si se quedara, el 413 sería un bucle infinito").toBe(0);
    expect(c.emitidas).toBe(c.entregadas + c.rechazadas + c.descartadas + c.pendientes);
    expect(avisos.some((a) => a.code === "rejected-ops")).toBe(true);
  });

  it("un POST que NO CONTESTA NUNCA no congela el envío: vence, se reintenta y acaba entregándose", async () => {
    // La pérdida más callada de todas: una promesa que no se asienta no es un error, así que no hay
    // `catch` que la vea. `flushing` se quedaba en `true` para siempre — ni un envío más, ni un
    // aviso, la cola creciendo y el canal diciendo `live`.
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE_A, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    const real = server.transport();
    let colgar = true;
    const colgados: string[] = [];
    const transport: CollabTransport = {
      openStream: real.openStream,
      post: (url, body) => {
        if (colgar && url.endsWith("/ops")) {
          colgar = false;
          colgados.push(url);
          return new Promise<PostResponse>(() => { /* jamás se asienta */ });
        }
        return real.post(url, body);
      },
    };
    const { session, avisos } = sesion(transport, timers);
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run(400_000);

    expect(colgados.length, "el escenario tiene que haber colgado un POST de verdad").toBe(1);
    const c = session.contabilidad();
    expect(c.entregadas, "el lote se reintenta y llega").toBe(c.emitidas);
    expect(c.pendientes).toBe(0);
    expect(server.log.length, "y queda persistido una sola vez (el dot hace idempotente el reenvío)").toBe(1);
    expect(avisos.some((a) => a.code === "store-failed"), "y el usuario se entera de que hubo que reintentar").toBe(true);
  });

  it("parar la sesión con la cola llena lo DICE, con el número, en vez de tirarla sin más", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE_A, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    const real = server.transport();
    let mudo = false;
    const transport: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (mudo && url.endsWith("/ops")) throw new Error("sin red");
        return real.post(url, body);
      },
    };
    const { session, avisos } = sesion(transport, timers);
    session.start();
    await timers.run();

    mudo = true;
    for (let i = 0; i < 3; i++) session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { [`p${i}`]: `v${i}` } });
    await timers.run(10_000);
    expect(session.contabilidad().pendientes, "hay cola de verdad que perder").toBe(3);

    session.stop();

    const c = session.contabilidad();
    expect(c.descartadas, "lo que quedaba se cuenta").toBe(3);
    expect(c.emitidas).toBe(c.entregadas + c.rechazadas + c.descartadas + c.pendientes);
    const ultimo = avisos.at(-1);
    expect(ultimo?.code).toBe("store-failed");
    expect(ultimo?.message, `y lo dice con el número: ${ultimo?.message}`).toMatch(/3 cambio/);
  });
});

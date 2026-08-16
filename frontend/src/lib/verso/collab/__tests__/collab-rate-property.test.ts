/**
 * Verso/colaboración — LA PROPIEDAD, no un caso (F8.3).
 *
 *     UN CLIENTE QUE RESPETA LA ESPERA QUE EL SERVIDOR LE PIDE NUNCA PUEDE SER EXPULSADO.
 *
 * Este fichero existe porque el defecto que dice esta frase se arregló tres veces y tres veces
 * reapareció en otro sitio (el camino de ops, el de presencia, el planificador del cliente). Cada
 * arreglo traía su test, cada test era correcto, y ninguno veía la siguiente mudanza porque todos
 * probaban UN CAMINO en UNA SECUENCIA. Aquí no se prueba un camino: se somete al cliente REAL a
 * combinaciones de ráfagas y se comprueba la propiedad, que es lo único que no puede mudarse de
 * sitio.
 *
 * DOS COSAS SIN LAS CUALES ESTO NO PROBARÍA NADA, y las dos faltaban:
 *
 *  1. TIEMPO DE VUELO. El doble respondía el 429 en el mismo tick. Sin latencia, entre mandar un
 *     frame y enterarse de que lo rechazan no cabe nada, así que la carrera —teclear o mover el
 *     cursor mientras el 429 vuelve— era IMPOSIBLE de representar. Aquí se recorren varios RTT.
 *  2. QUE EL DOBLE PUEDA EXPULSAR. Un servidor de mentira que solo sabe decir 429 hace que «nunca lo
 *     expulsan» sea cierto por construcción. El doble implementa la regla real, y el último test de
 *     este fichero es el CONTROL NEGATIVO que lo demuestra echando a un cliente desobediente.
 */

import { describe, expect, it } from "vitest";

import { VersoCollabSession } from "../client";
import type { CollabNotice } from "../types";
import { FakeCollabServer, ManualTimers, makeRng } from "./fakeServer";

const SITE = "s_prop";
const BASE = JSON.stringify({
  root: { props: {} },
  content: [{ type: "Text", props: { id: "t1", text: "hola" } }],
});

/** Log grande ya en la sala: es lo que hace caro el `resync` y deja el cubo de bytes en descubierto. */
function sembrarLog(server: FakeCollabServer, cuantas: number): void {
  for (let i = 1; i <= cuantas; i++) {
    server.log.push({
      k: "propSet",
      id: { site: "s_otrootrootrootro", counter: i },
      hlc: { ms: i, count: 0, site: "s_otrootrootrootro" },
      nodeId: "t1",
      key: `k${i}`,
      value: "x".repeat(120),
    } as never);
  }
}

interface Escenario {
  nombre: string;
  rtt: number;
  seed: number;
  /** Pulsaciones por segundo, aproximadas: el tecleo real es irregular. */
  tecleo: boolean;
  /** Mover el cursor por los bloques (`setSelection`) es el camino de PRESENCIA. */
  cursor: boolean;
  /** Un co-editor forzando resyncs: la ráfaga cara, y el escenario weaponizable del informe. */
  resyncs: boolean;
  /** Cortes de red en medio, para que la reconexión participe. */
  cortes: number;
}

interface Resultado {
  expulsiones: number;
  cuatrocientosNueve: number;
  rechazos: number;
  aceptados: number;
  avisos: CollabNotice[];
  estado: string;
}

async function corre(esc: Escenario): Promise<Resultado> {
  const server = new FakeCollabServer(BASE, "auto");
  server.register({ siteId: SITE, userId: 1, name: "Ana" });
  const timers = server.useTimers(new ManualTimers());
  server.latencyMs = esc.rtt / 2;

  // Cubos a escala, con la MISMA proporción que producción (ráfaga / ritmo = 4 s de recuperación),
  // para que un test dure segundos simulados y no minutos. La regla que se prueba no depende de la
  // escala; el tiempo de ejecución sí.
  server.limits.bytesBurst = 2_000;
  server.limits.maxBytesPerSec = 500;
  server.limits.opsBurst = 40;
  server.limits.maxOpsPerSec = 10;
  server.limits.presenceBurst = 6;
  server.limits.maxPresencePerSec = 3;

  sembrarLog(server, 60);

  const avisos: CollabNotice[] = [];
  const session = new VersoCollabSession(
    {
      postId: 7, transport: server.transport(), siteId: SITE,
      flushMs: 100, presenceMs: 50,
      setTimer: timers.set, clearTimer: timers.clear,
    },
    { onNotice: (n) => avisos.push(n) },
  );

  session.start();
  await timers.run(5_000);

  // PLAN DE ACTIVIDAD, con instantes absolutos. `ManualTimers.set` mide desde el reloj actual, que
  // aquí sigue siendo el del arranque, así que programarlo todo de golpe conserva los instantes.
  const rng = makeRng(esc.seed);
  const FIN = 20_000;
  let counter = 0;

  if (esc.tecleo) {
    for (let t = 200; t < FIN; t += 60 + Math.floor(rng() * 160)) {
      timers.set(() => {
        session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { [`p${counter++}`]: "a".repeat(40) } });
      }, t);
    }
  }
  if (esc.cursor) {
    for (let t = 250; t < FIN; t += 40 + Math.floor(rng() * 120)) {
      const n = counter;
      timers.set(() => session.setSelection({ nodeId: `n${n % 7}` }), t);
    }
  }
  if (esc.resyncs) {
    for (let t = 1_000; t < FIN; t += 4_000) {
      timers.set(() => { void session.resync(); }, t);
    }
  }
  for (let i = 0; i < esc.cortes; i++) {
    timers.set(() => server.dropStream(SITE), 3_000 + i * 6_500);
  }

  await timers.run(200_000);

  return {
    expulsiones: server.expulsiones.length,
    cuatrocientosNueve: server.posted.filter((p) => p.status === 409).length,
    rechazos: server.posted.filter((p) => p.status === 429).length,
    aceptados: server.posted.filter((p) => p.status === 200).length,
    avisos,
    estado: session.snapshot().status,
  };
}

/**
 * LA MATRIZ. No es adorno: el defecto de la ronda 3 solo se manifestaba con RTT alto (6/6 con 120 ms,
 * 3/6 con 10 ms), así que una sola combinación es exactamente la trampa en la que se cayó tres veces.
 */
const ESCENARIOS: Escenario[] = [
  { nombre: "resync grande + tecleo, RTT 10", rtt: 10, seed: 1, tecleo: true, cursor: false, resyncs: true, cortes: 0 },
  { nombre: "resync grande + tecleo, RTT 50", rtt: 50, seed: 2, tecleo: true, cursor: false, resyncs: true, cortes: 0 },
  { nombre: "resync grande + tecleo, RTT 120", rtt: 120, seed: 3, tecleo: true, cursor: false, resyncs: true, cortes: 0 },
  { nombre: "presencia a chorro tras un resync, RTT 50", rtt: 50, seed: 4, tecleo: false, cursor: true, resyncs: true, cortes: 0 },
  { nombre: "todo a la vez, RTT 120", rtt: 120, seed: 5, tecleo: true, cursor: true, resyncs: true, cortes: 0 },
  { nombre: "todo a la vez + 2 cortes de red, RTT 120", rtt: 120, seed: 6, tecleo: true, cursor: true, resyncs: true, cortes: 2 },
  { nombre: "todo a la vez + 2 cortes de red, RTT 50", rtt: 50, seed: 7, tecleo: true, cursor: true, resyncs: true, cortes: 2 },
  { nombre: "solo tecleo a chorro, sin resyncs, RTT 120", rtt: 120, seed: 8, tecleo: true, cursor: false, resyncs: false, cortes: 0 },
];

describe("PROPIEDAD: quien respeta la espera del servidor no puede acabar fuera de la sala", () => {
  for (const esc of ESCENARIOS) {
    it(esc.nombre, async () => {
      const r = await corre(esc);

      // LA PROPIEDAD.
      expect(
        r.expulsiones,
        `expulsado de la sala respetando la espera (${esc.nombre}): ` +
        `${r.rechazos} rechazos, ${r.cuatrocientosNueve} respuestas 409, avisos ` +
        JSON.stringify(r.avisos.map((a) => a.code)),
      ).toBe(0);
      expect(
        r.cuatrocientosNueve,
        `un 409 collab_no_session es la firma de la expulsión: no puede aparecer ni uno (${esc.nombre})`,
      ).toBe(0);
      expect(
        r.avisos.some((a) => a.code === "transport-error"),
        `la sesión no puede caerse: ${JSON.stringify(r.avisos.map((a) => `${a.code}: ${a.message}`))}`,
      ).toBe(false);
      expect(r.estado, "y al final sigue conectado").not.toBe("off");

      // CONTRA LA VACUIDAD. Si el escenario no llegó a provocar contrapresión, «no lo expulsan» no
      // dice nada: es lo que pasaba con el doble instantáneo, donde los 45 tests estaban verdes con
      // el defecto dentro. Un escenario que no rechaza nada es un escenario mal construido.
      expect(r.rechazos, `este escenario tiene que provocar 429 de verdad (${esc.nombre})`).toBeGreaterThan(0);
      // Y tiene que RECUPERARSE: frenar para siempre también sería «no lo expulsan».
      expect(r.aceptados, `y el cliente tiene que seguir entregando después (${esc.nombre})`).toBeGreaterThan(0);
    });
  }

  /**
   * CONTROL NEGATIVO. Sin esto, todo lo de arriba podría estar pasando porque el doble no sabe
   * expulsar — que es precisamente el defecto de método que dejó pasar tres rondas.
   *
   * El cliente desobediente se modela igual que el real roto: recibe el 429, LEE el aviso (lo que
   * prueba que se ha enterado) y vuelve a mandar dentro de la ventana. Eso, y solo eso, es lo que el
   * servidor puede castigar.
   */
  it("CONTROL NEGATIVO: un cliente que ACUSA el aviso y no espera SÍ acaba fuera", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    server.limits.presenceBurst = 2;
    server.limits.maxPresencePerSec = 1;

    const transport = server.transport();
    let site = "";
    let expulsion: string | null = null;
    transport.openStream(`/api/v1/collab/7/stream?siteId=${SITE}`, {
      onOpen: () => undefined,
      onEvent: (event, data) => {
        if (event === "welcome") site = (data as { self: { siteId: string } }).self.siteId;
        if (event === "error") expulsion = (data as { code: string }).code;
      },
      onError: () => undefined,
    });

    let ack = 0;
    let fuera = false;
    for (let i = 0; i < 30 && !fuera; i++) {
      const res = await transport.post(`/api/v1/collab/7/presence`, { siteId: site, sel: { nodeId: `n${i}` }, rateAck: ack });
      const body = res.body as { code?: string; rateNotice?: number } | null;
      if (typeof body?.rateNotice === "number") ack = body.rateNotice;   // se entera... y no espera
      if (res.status === 409 && body?.code === "collab_no_session") fuera = true;
      await timers.run();
    }

    expect(fuera, "el doble TIENE que saber expulsar, o los tests de arriba no prueban nada").toBe(true);
    expect(server.expulsiones.length).toBe(1);
    // Y se le dice por qué, por el mismo canal que el servidor real: el evento SSE `error`.
    expect(expulsion, "la expulsión se anuncia por el stream, no en silencio").toBe("rate_limit");
  });

  /**
   * La otra mitad del control: sin el acuse no hay prueba, así que no hay expulsión — pero el freno
   * sigue rechazándolo TODO, que es la parte que protege al servidor. Este test es el que ancla esa
   * decisión de diseño: si alguien volviera a expulsar por tiempo a secas, se pone rojo.
   */
  it("un cliente que NO acusa el aviso no se expulsa, pero se le rechaza igual", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    server.limits.presenceBurst = 2;
    server.limits.maxPresencePerSec = 1;

    const transport = server.transport();
    let site = "";
    transport.openStream(`/api/v1/collab/7/stream?siteId=${SITE}`, {
      onOpen: () => undefined,
      onEvent: (event, data) => { if (event === "welcome") site = (data as { self: { siteId: string } }).self.siteId; },
      onError: () => undefined,
    });

    let rechazos = 0;
    for (let i = 0; i < 30; i++) {
      const res = await transport.post(`/api/v1/collab/7/presence`, { siteId: site, sel: { nodeId: `n${i}` } });
      if (res.status === 429) rechazos++;
      expect(res.status, "sin acuse no hay prueba de desobediencia: no se puede cerrar la sesión").not.toBe(409);
      await timers.run();
    }
    expect(rechazos, "y aun así se le frena: la contrapresión no depende del acuse").toBeGreaterThan(0);
    expect(server.expulsiones.length).toBe(0);
  });
});

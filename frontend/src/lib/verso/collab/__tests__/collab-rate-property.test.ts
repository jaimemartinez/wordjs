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
import type { CollabAccounting, CollabNotice } from "../types";
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
  /**
   * LO QUE TARDA EL CLIENTE EN TENER EL `welcome` DELANTE (ver `FakeCollabServer.welcomeDelayMs`).
   *
   * Sin esto, la frontera de la reconexión era IRREPRESENTABLE en el doble: el `welcome` se entregaba
   * en el mismo tick que se abría el stream, así que el cliente re-sincronizaba su numeración de
   * avisos en el instante exacto en que el servidor creaba la conexión nueva y nunca podía haber
   * desacuerdo. Ahí vivía el defecto de la ronda 5, y por eso los escenarios con `cortes` estaban
   * verdes con él dentro. El retardo no es artificioso: el `welcome` lleva el snapshot del epoch y el
   * log entero, y el cliente todavía tiene que parsearlo y aplicarlo.
   */
  welcomeDelay?: number;
}

interface Resultado {
  expulsiones: number;
  /**
   * 409 `collab_no_session` SERVIDOS POR EXPULSIÓN.
   *
   * Antes esto contaba TODOS los 409 y afirmaba que ni uno podía aparecer. Era falso, y su falsedad
   * escondía un hallazgo: el servidor real devuelve ese mismo código cuando simplemente no hay
   * conexión SSE viva —lo que pasa en cada parpadeo de red— y el doble lo tapaba contestando 200.
   * Al hacerlo fiel, «ni un 409» dejó de ser cierto sin que nadie hubiera roto nada. Lo que sigue
   * siendo la propiedad es que ninguno de esos 409 venga de que nos hayan ECHADO.
   */
  sinSesionPorExpulsion: number;
  rechazos: number;
  aceptados: number;
  avisos: CollabNotice[];
  estado: string;
  /** Frames que llegaron con el acuse de la conexión ANTERIOR: la huella de la carrera. */
  acusesDeOtraConexion: number;
  /** La cuenta de punta a punta del cliente (ver `CollabAccounting`). */
  cuenta: CollabAccounting;
}

async function corre(esc: Escenario): Promise<Resultado> {
  const server = new FakeCollabServer(BASE, "auto");
  server.register({ siteId: SITE, userId: 1, name: "Ana" });
  const timers = server.useTimers(new ManualTimers());
  server.latencyMs = esc.rtt / 2;
  server.welcomeDelayMs = esc.welcomeDelay ?? 0;

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
    sinSesionPorExpulsion: server.sinSesion.filter((s) => s.porExpulsion).length,
    rechazos: server.posted.filter((p) => p.status === 429).length,
    aceptados: server.posted.filter((p) => p.status === 200).length,
    avisos,
    estado: session.snapshot().status,
    acusesDeOtraConexion: server.acusesDeOtraConexion,
    cuenta: session.contabilidad(),
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
  // RONDA 5: los tres escenarios en los que el `welcome` TARDA en llegar tras reconectar. Es el
  // hueco en el que el cliente sigue mandando con lo que sabía de la conexión anterior, y donde el
  // acuse envenenaba el contador del servidor. El verificador midió que basta con 300 ms a RTT 10 y
  // con 800 ms a RTT 120 — el `welcome` de una sala de 5000 ops son 1,80 MB.
  { nombre: "cortes con `welcome` lento (300 ms), RTT 10", rtt: 10, seed: 9, tecleo: true, cursor: true, resyncs: true, cortes: 2, welcomeDelay: 300 },
  { nombre: "cortes con `welcome` lento (800 ms), RTT 120", rtt: 120, seed: 10, tecleo: true, cursor: true, resyncs: true, cortes: 2, welcomeDelay: 800 },
  { nombre: "cortes con `welcome` lentísimo (2 s) + resyncs, RTT 50", rtt: 50, seed: 11, tecleo: true, cursor: true, resyncs: true, cortes: 3, welcomeDelay: 2_000 },
];

describe("PROPIEDAD: quien respeta la espera del servidor no puede acabar fuera de la sala", () => {
  for (const esc of ESCENARIOS) {
    it(esc.nombre, async () => {
      const r = await corre(esc);

      // LA PROPIEDAD.
      expect(
        r.expulsiones,
        `expulsado de la sala respetando la espera (${esc.nombre}): ` +
        `${r.rechazos} rechazos, avisos ` + JSON.stringify(r.avisos.map((a) => a.code)),
      ).toBe(0);
      expect(
        r.sinSesionPorExpulsion,
        `un 409 collab_no_session POR EXPULSIÓN es la firma del defecto: no puede aparecer ni uno (${esc.nombre})`,
      ).toBe(0);

      // NI UNA OP PERDIDA, EN NINGÚN ESCENARIO. Estos son los mismos recorridos que provocan cortes
      // de red, y por tanto el hueco de la reconexión: si un lote en vuelo se cayera, la suma no
      // cuadraría aunque nadie hubiera escrito un aviso. Y lo que se descarte tiene que estar DICHO.
      const c = r.cuenta;
      expect(
        c.entregadas + c.rechazadas + c.descartadas + c.pendientes,
        `la cuenta no cuadra (${esc.nombre}): ${JSON.stringify(c)}`,
      ).toBe(c.emitidas);
      // La cuenta solo dice algo si hubo ops que contar, y hay un escenario que es SOLO presencia
      // (`tecleo: false`): exigirle ops ahí haría fallar un escenario correcto, y exigírselo a todos
      // por igual sería fingir que el de presencia prueba algo que no prueba.
      if (esc.tecleo) {
        expect(c.emitidas, `este escenario tiene que emitir ops de verdad (${esc.nombre})`).toBeGreaterThan(0);
        expect(c.entregadas, `y tienen que llegar a entregarse (${esc.nombre})`).toBeGreaterThan(0);
      }
      if (c.descartadas > 0) {
        expect(
          r.avisos.some((a) => a.code === "epoch-reset" || a.code === "identity-reset" || a.code === "rejected-ops"),
          `se descartaron ${c.descartadas} ops sin decirlo (${esc.nombre})`,
        ).toBe(true);
      }
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

      // Y en los escenarios de `welcome` lento, que la CARRERA se haya representado de verdad: si
      // ningún frame llegó a aterrizar en la conexión nueva con el acuse de la vieja, «no expulsa a
      // nadie» sería cierto porque el escenario no reproduce nada. Es la misma trampa que dejó pasar
      // tres rondas con un doble sin tiempo de vuelo.
      if (esc.welcomeDelay) {
        expect(
          r.acusesDeOtraConexion,
          `este escenario existe para reproducir el frame rezagado de la conexión anterior (${esc.nombre}); ` +
          "si no llega ninguno, no prueba nada",
        ).toBeGreaterThan(0);
      }
      // PLAZO EXPLÍCITO. El reloj es virtual (ManualTimers), así que estos segundos no son espera:
      // son CPU de verdad — once escenarios que recorren miles de iteraciones del cliente REAL contra
      // el doble. En esta máquina cada caso ronda 1-2 s y los 5 s por defecto de vitest sobran; en el
      // runner de CI, que es más lento, tres casos los rozaban y caían por plazo, no por la propiedad.
      // Subirlo NO tapa nada: lo que se afirma sigue siendo lo mismo, y si la propiedad se rompe el
      // test falla igual, con su mensaje. Bajar el trabajo (menos escenarios o menos iteraciones) sí
      // taparía algo: la matriz completa es lo que hizo visible el defecto que sobrevivió tres rondas.
    }, 30_000);
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
    let seal: string | undefined;
    let fuera = false;
    for (let i = 0; i < 30 && !fuera; i++) {
      const res = await transport.post(`/api/v1/collab/7/presence`, { siteId: site, sel: { nodeId: `n${i}` }, rateAck: ack, rateSeal: seal });
      const body = res.body as { code?: string; rateNotice?: number; rateSeal?: string } | null;
      // Se entera... y no espera. El acuse va con SU SELLO: sin él, el servidor lo descarta entero
      // (es lo que impide que el acuse de una conexión cuente en otra), así que un cliente que quiera
      // desobedecer de forma DEMOSTRABLE tiene que devolver el par completo.
      if (typeof body?.rateNotice === "number") ack = body.rateNotice;
      if (typeof body?.rateSeal === "string") seal = body.rateSeal;
      if (res.status === 409 && body?.code === "collab_no_session") fuera = true;
      await timers.run();
    }

    expect(fuera, "el doble TIENE que saber expulsar, o los tests de arriba no prueban nada").toBe(true);
    expect(server.expulsiones.length).toBe(1);
    // Y se le dice por qué, por el mismo canal que el servidor real: el evento SSE `error`.
    expect(expulsion, "la expulsión se anuncia por el stream, no en silencio").toBe("rate_limit");
  });

  /**
   * CONTROL DE VACUIDAD DEL CLIENTE REAL. Todo lo de arriba dice «al cliente no lo expulsan», y hay
   * una forma barata de que eso sea cierto sin que signifique nada: que el cliente deje de mandar el
   * acuse. Sin acuse —o con el número pero sin su sello, que el servidor descarta entero— el cliente
   * es INEXPULSABLE por construcción y los ocho escenarios pasarían solos.
   *
   * Así que aquí se mira lo que el cliente REAL pone en el cable: tras un 429, el frame siguiente
   * tiene que llevar el par completo, y con el sello de quien acuñó ese aviso. Es la contrapartida de
   * `rateGate.test.ts`, que fija la decisión; esto fija que la decisión SALE.
   */
  it("el cliente REAL devuelve el acuse COMPLETO: número Y sello del que lo acuñó", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const timers = server.useTimers(new ManualTimers());
    server.limits.presenceBurst = 1;
    server.limits.maxPresencePerSec = 1;

    const real = server.transport();
    const enviados: { rateAck?: unknown; rateSeal?: unknown }[] = [];
    let ultimoRechazo: { rateNotice?: number; rateSeal?: string } | null = null;

    const session = new VersoCollabSession(
      {
        postId: 7, siteId: SITE, flushMs: 100, presenceMs: 50,
        setTimer: timers.set, clearTimer: timers.clear,
        transport: {
          openStream: real.openStream,
          post: async (url, body) => {
            enviados.push(body as { rateAck?: unknown; rateSeal?: unknown });
            const res = await real.post(url, body);
            if (res.status === 429) ultimoRechazo = res.body as { rateNotice?: number; rateSeal?: string };
            return res;
          },
        },
      },
      {},
    );

    session.start();
    await timers.run(5_000);
    for (let t = 0; t < 30; t++) {
      timers.set(() => session.setSelection({ nodeId: `n${t}` }), 100 + t * 200);
    }
    await timers.run(60_000);

    expect(ultimoRechazo, "el escenario tiene que provocar un 429 de verdad").not.toBe(null);
    const rechazo = ultimoRechazo as unknown as { rateNotice: number; rateSeal: string };
    expect(typeof rechazo.rateSeal, "el 429 del servidor trae el sello").toBe("string");

    const conElPar = enviados.filter((b) => b.rateSeal === rechazo.rateSeal && Number(b.rateAck) >= rechazo.rateNotice);
    expect(
      conElPar.length,
      "tras un 429 el cliente tiene que devolver el acuse CON su sello: sin él el servidor lo descarta, " +
      "el cliente se vuelve inexpulsable y los escenarios de arriba pasan por vacuidad",
    ).toBeGreaterThan(0);
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

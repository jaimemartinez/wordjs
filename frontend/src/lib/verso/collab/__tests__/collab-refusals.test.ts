/**
 * Verso/colaboración — EL CONTRATO DE RECHAZOS TIENE DOS EXTREMOS Y UN SOLO DUEÑO (ola 4, grupo X5).
 *
 * CLASE DEL DEFECTO: el servidor acuña los códigos y el cliente los clasificaba con una lista blanca
 * escrita a mano en otro paquete. Eso no es un contrato, son dos copias — y cuando el servidor añadió
 * `read-budget` (un rechazo que por construcción se cura solo, porque el cubo se recarga a un ritmo
 * conocido) la lista del cliente no se tocó: el código cayó en la rama terminal y lo que el servidor
 * diseñó como una ESPERA mataba la sesión colaborativa hasta recargar la página.
 *
 * Este fichero prueba la CLASE, no el ejemplo, y por eso:
 *   · RECORRE la unión `JoinRefusal` LEÍDA DEL SERVIDOR (backend/src/core/collab-rooms.ts). Una
 *     variante nueva allí entra aquí sola: si el cliente no sabe reintentarla, esto se pone rojo sin
 *     que nadie tenga que acordarse de editar el test;
 *   · la recorre DOS VECES, con el servidor que publica `retryable` y con uno anterior al cambio, que
 *     son las dos formas en las que un despliegue real puede responder;
 *   · comprueba lo contrario con un control terminal, para que «reintentarlo todo» no pase por bueno;
 *   · y fija que un freno de LECTURA frena la lectura y NO la escritura, que es la otra mitad de la
 *     regresión: una espera de un minuto aplicada al freno global deja al usuario sin poder enviar lo
 *     que está tecleando.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FakeCollabServer, ManualTimers } from "./fakeServer";
import { VersoCollabSession } from "../client";
import type { CollabNotice, CollabTransport, PostResponse, StreamHandlers } from "../types";
import type { VersoData } from "../../types";

const BASE: VersoData = {
  root: { props: { title: "T" } },
  content: [{ type: "Text", props: { id: "t1", text: "uno" } }],
};

const SITE = "s_aaaaaaaaaaaaaaaa";

/** El fichero del SERVIDOR es la fuente de la lista: leerla aquí es lo que impide la segunda copia. */
const RUTA_SALAS = path.resolve(__dirname, "../../../../../../backend/src/core/collab-rooms.ts");

function refusalsDelServidor(): string[] {
  expect(fs.existsSync(RUTA_SALAS), `no se encuentra ${RUTA_SALAS}: sin la unión del servidor este test no prueba nada`).toBe(true);
  const fuente = fs.readFileSync(RUTA_SALAS, "utf8");
  const desde = fuente.indexOf("export type JoinRefusal =");
  expect(desde).toBeGreaterThan(0);
  const cuerpo = fuente.slice(desde, fuente.indexOf(";", desde));
  const variantes = [...cuerpo.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  expect(variantes.length).toBeGreaterThanOrEqual(5);
  return variantes;
}

type Intento = { at: number };

/** Abre una sesión contra un servidor que SIEMPRE rechaza con `code`, y cuenta los intentos. */
async function sesionRechazada(code: string, extra: Record<string, unknown> = {}, maxRetries = 2) {
  const timers = new ManualTimers();
  const intentos: Intento[] = [];
  const notices: CollabNotice[] = [];
  const transporte: CollabTransport = {
    openStream: (_url: string, h: StreamHandlers) => {
      intentos.push({ at: timers.time });
      h.onOpen();
      h.onEvent("error", { code, message: "la sala no se pudo abrir", ...extra });
      return { close: () => undefined };
    },
    post: async (): Promise<PostResponse> => ({ status: 200, body: {} }),
  };
  const session = new VersoCollabSession(
    {
      postId: 7, transport: transporte, siteId: SITE, flushMs: 10, presenceMs: 10,
      maxRetries, setTimer: timers.set, clearTimer: timers.clear, now: () => timers.time,
    },
    { onNotice: (n) => notices.push(n) },
  );
  session.start();
  await timers.run();
  return { intentos, notices, session, timers };
}

describe("todo rechazo de sala que el SERVIDOR marca reintentable se reintenta", () => {
  const VARIANTES = refusalsDelServidor();

  for (const code of VARIANTES) {
    it(`'${code}': el servidor NUEVO lo marca reintentable y el cliente obedece`, async () => {
      const { intentos, session } = await sesionRechazada(code, { retryable: true });
      // 1 apertura + 2 reintentos: la sesión no se da por muerta con un rechazo que se cura solo.
      expect(intentos.length).toBe(3);
      expect(session.snapshot().status).toBe("offline");
    });

    it(`'${code}': con un servidor ANTERIOR al cambio (sin \`retryable\`) tampoco muere`, async () => {
      // La reserva importa: durante un despliegue conviven binarios. Si la lista local vuelve a
      // quedarse corta, esta mitad se pone roja aunque la otra pase.
      const { intentos } = await sesionRechazada(code);
      expect(intentos.length).toBe(3);
    });
  }

  it("un código que este cliente NO CONOCE se reintenta si el servidor dice que es reintentable", async () => {
    // Ésta es la propiedad de la CLASE, y la que hace que el defecto no pueda volver: la decisión ya
    // no depende de que alguien acuerde de añadir el código aquí.
    const { intentos } = await sesionRechazada("una-variante-que-aun-no-existe", { retryable: true });
    expect(intentos.length).toBe(3);
  });

  it("CONTROL: un rechazo TERMINAL sigue parando la sesión — con y sin la bandera", async () => {
    const conBandera = await sesionRechazada("forbidden", { retryable: false });
    expect(conBandera.intentos.length).toBe(1);
    expect(conBandera.notices.some((n) => n.code === "forbidden")).toBe(true);

    const sinBandera = await sesionRechazada("forbidden");
    expect(sinBandera.intentos.length).toBe(1);
  });

  it("la ESPERA la dice el servidor: un `read-budget` con plazo no se reintenta al ritmo del backoff", async () => {
    // El cubo de lectura se recarga a `USER_READ_BYTES_PER_SEC`, así que el plazo real puede ser de
    // decenas de segundos. Reintentar a ~1 s no solo no arregla nada: cada reintento vuelve a costar
    // trabajo al servidor. El número viaja en el propio rechazo y el cliente lo respeta, acotado por
    // su techo (30 s), que es lo que impide que un servidor mal configurado congele el editor.
    const { intentos } = await sesionRechazada("read-budget", { retryable: true, retryAfterMs: 20_000 });
    expect(intentos.length).toBe(3);
    const huecos = intentos.slice(1).map((t, i) => t.at - intentos[i].at);
    for (const h of huecos) {
      expect(h).toBeGreaterThanOrEqual(20_000);
      expect(h).toBeLessThanOrEqual(30_000);
    }
  });
});

describe("un freno de LECTURA no puede congelar la ESCRITURA", () => {
  const ESPERA = 20_000;

  // Los dos 429 que puede devolver `/resync`, recorridos juntos: comparten forma y significan cosas
  // opuestas. El de RITMO habla del cubo de la conexión —que es el mismo que paga la subida— y por
  // eso frena todo; el de LECTURA habla del presupuesto por usuario, que no frena la subida en el
  // servidor y por lo tanto tampoco puede frenarla aquí.
  const CASOS = [
    { code: "collab_read_budget", congelaLaSubida: false },
    { code: "collab_rate_limit", congelaLaSubida: true },
  ];

  for (const caso of CASOS) {
    it(`${caso.code}: la subida ${caso.congelaLaSubida ? "espera" : "sigue saliendo"}`, async () => {
      const server = new FakeCollabServer(BASE, "auto");
      server.register({ siteId: SITE, userId: 1, name: "Ana" });
      const timers = new ManualTimers();
      server.clock = () => timers.time;
      const real = server.transport();
      const transporte: CollabTransport = {
        openStream: real.openStream,
        post: async (url: string, body: unknown): Promise<PostResponse> =>
          url.endsWith("/resync")
            ? { status: 429, body: { code: caso.code, retryAfterMs: ESPERA, rateNotice: 1, rateSeal: "sello" } }
            : real.post(url, body),
      };

      const session = new VersoCollabSession(
        {
          postId: 7, transport: transporte, siteId: SITE, flushMs: 10, presenceMs: 10,
          setTimer: timers.set, clearTimer: timers.clear,
        },
        {},
      );
      session.start();
      await timers.run();

      // Un hueco de entrega cualquiera: el cliente pide reanudar y se lleva el 429.
      await session.resync();
      // Y el usuario sigue tecleando, que es lo único que no se puede parar por haber LEÍDO de más.
      session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
      await timers.run();

      const subidas = server.posted.filter((p) => p.path === "ops").map((p) => p.at);
      expect(subidas.length).toBeGreaterThan(0);
      if (caso.congelaLaSubida) {
        expect(subidas[0]).toBeGreaterThanOrEqual(ESPERA);
      } else {
        expect(subidas[0]).toBeLessThan(ESPERA / 2);
      }
      // En los dos casos la op acaba en el servidor: frenar no es perder.
      expect(server.log.length).toBeGreaterThan(0);
    });
  }
});

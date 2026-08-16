/**
 * Verso/colaboración — COMPORTAMIENTO DE LA SESIÓN DE CLIENTE (F8.3).
 *
 * Lo que aquí se fija no es la convergencia (eso es `collab-convergence.test.ts`) sino las promesas
 * que la sesión le hace al usuario cuando el canal se porta mal:
 *
 *   · nada se pierde en silencio — una op que no se pudo enviar VUELVE a la cola, y lo que no se
 *     puede reconciliar se cuenta en un aviso;
 *   · el estado del canal es VISIBLE (`live` / `degraded` / `offline`), nunca una degradación muda;
 *   · la presencia es efímera, coalescida y solo con datos públicos;
 *   · una reconexión con el MISMO epoch conserva el trabajo local; con otro epoch, avisa.
 */

import { describe, expect, it, vi } from "vitest";

import { VersoCollabSession } from "../client";
import { deriveSite, FakeCollabServer, ManualTimers, settleMicrotasks } from "./fakeServer";
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
  listeners: ConstructorParameters<typeof VersoCollabSession>[1] = {},
) {
  const timers = new ManualTimers();
  const notices: CollabNotice[] = [];
  const session = new VersoCollabSession(
    {
      postId: 7, transport, siteId: SITE, flushMs: 10, presenceMs: 10,
      setTimer: timers.set, clearTimer: timers.clear,
      ...extra,
    },
    { ...listeners, onNotice: (n) => { notices.push(n); listeners.onNotice?.(n); } },
  );
  return { session, timers, notices };
}

describe("arranque y documento inicial", () => {
  it("`onReady` entrega el documento del snapshot del epoch, con el `self` de la sala", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 3, name: "Ana" });
    const ready = vi.fn();
    const { session, timers } = makeSession(server.transport(), {}, { onReady: ready });
    session.start();
    await timers.run();

    expect(ready).toHaveBeenCalledTimes(1);
    const [doc, self] = ready.mock.calls[0];
    expect(doc.rootChildren).toHaveLength(1);
    expect(doc.nodes.t1.props.text).toBe("uno");
    expect(self).toEqual({ siteId: deriveSite(SITE), userId: 3, name: "Ana", color: "#2563eb" });
    expect(session.snapshot().status).toBe("live");
  });

  it("un `base` corrupto no tumba la sesión: arranca con un documento vacío", async () => {
    const server = new FakeCollabServer("{{{ esto no es JSON", "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const { session, timers } = makeSession(server.transport());
    session.start();
    await timers.run();

    expect(session.snapshot().status).toBe("live");
    expect(session.doc()!.rootChildren).toEqual([]);
  });
});

describe("nada se pierde en silencio", () => {
  it("si el POST falla por red, las ops VUELVEN a la cola y se reintentan", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    let failNext = true;
    const flaky: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (url.endsWith("/ops") && failNext) { failNext = false; throw new Error("red caída"); }
        return real.post(url, body);
      },
    };
    const { session, timers } = makeSession(flaky);
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();

    // Tras el fallo y el reintento, la cola queda vacía y el servidor tiene la op.
    expect(session.snapshot().pendingOps).toBe(0);
    expect(server.log).toHaveLength(1);
  });

  it("un 429 devuelve las ops a la cola y avisa, sin descartarlas", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    let limited = true;
    const throttling: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (url.endsWith("/ops") && limited) { limited = false; return { status: 429, body: null } as PostResponse; }
        return real.post(url, body);
      },
    };
    const { session, timers, notices } = makeSession(throttling);
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();

    expect(notices.some((n) => n.code === "rate-limited")).toBe(true);
    expect(session.snapshot().pendingOps).toBe(0);
    expect(server.log).toHaveLength(1);
  });

  it("las ops que el servidor RECHAZA se reportan en el momento, con su detalle", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    const picky: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => {
        if (url.endsWith("/ops")) return { status: 200, body: { ok: true, accepted: 0, rejected: [{ index: 0, code: "bad-value" }] } };
        return real.post(url, body);
      },
    };
    const { session, timers, notices } = makeSession(picky);
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "rojo" } });
    await timers.run();

    const notice = notices.find((n) => n.code === "rejected-ops");
    expect(notice).toBeTruthy();
    expect(notice!.rejected).toEqual([{ index: 0, code: "bad-value" }]);
  });

  it("un epoch caducado avisa CONTANDO los cambios que no se pudieron enviar", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    const stale: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => (url.endsWith("/ops") ? { status: 409, body: { code: "collab_epoch" } } : real.post(url, body)),
    };
    const { session, timers, notices } = makeSession(stale);
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { a: 1 } });
    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { b: 2 } });
    await timers.run();

    const notice = notices.find((n) => n.code === "epoch-reset");
    expect(notice).toBeTruthy();
    expect(notice!.message).toMatch(/2 cambio/);
  });
});

describe("estado del canal: siempre visible, nunca mudo", () => {
  it("una caída del stream pasa a `offline` y reconecta con backoff", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const { session, timers } = makeSession(server.transport());
    session.start();
    await timers.run();
    expect(session.snapshot().status).toBe("live");

    server.dropStream(SITE);
    expect(session.snapshot().status).toBe("offline");

    await timers.run();
    expect(session.snapshot().status).toBe("live");
  });

  it("una reconexión con el MISMO epoch conserva lo local y avisa de la reconexión", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const { session, timers, notices } = makeSession(server.transport());
    session.start();
    await timers.run();

    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "verde" } });
    await timers.run();
    const before = session.signature();

    server.dropStream(SITE);
    await timers.run();

    expect(notices.some((n) => n.code === "reconnected")).toBe(true);
    // El estado NO se reconstruye desde cero: la edición local sigue ahí.
    expect(session.signature()).toBe(before);
    expect(session.doc()!.nodes.t1.props.color).toBe("verde");
  });

  it("un `welcome` con OTRO epoch re-siembra y avisa del reinicio", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const { session, timers, notices } = makeSession(server.transport());
    session.start();
    await timers.run();
    session.sendCommand({ kind: "setProps", nodeId: "t1", patch: { color: "verde" } });
    await timers.run();

    // La sala se cerró y volvió a abrirse con el contenido ya guardado.
    server.epoch = 2;
    server.log = [];
    server.base = JSON.stringify({ root: { props: {} }, content: [{ type: "Text", props: { id: "t1", text: "guardado" } }] });
    server.dropStream(SITE);
    await timers.run();

    expect(notices.some((n) => n.code === "epoch-reset")).toBe(true);
    expect(session.snapshot().epoch).toBe(2);
    expect(session.doc()!.nodes.t1.props.text).toBe("guardado");
  });

  it('el servidor puede cerrar la sala ("error"): se para, se avisa y NO se reintenta', async () => {
    let handlers: StreamHandlers | null = null;
    const transport: CollabTransport = {
      openStream: (_url, h) => { handlers = h; h.onOpen(); return { close: () => undefined }; },
      post: async () => ({ status: 200, body: { ok: true } }),
    };
    const { session, timers, notices } = makeSession(transport);
    session.start();
    handlers!.onEvent("error", { code: "forbidden", message: "Sin permiso." });
    await timers.run();

    expect(session.snapshot().status).toBe("offline");
    expect(notices.at(-1)!.code).toBe("forbidden");

    // Ni un reintento: un 403 en bucle sería un ataque a nuestro propio servidor.
    const before = session.snapshot();
    await timers.run();
    expect(session.snapshot().status).toBe(before.status);
  });

  it("un log truncado deja el canal en `degraded` con un aviso accionable", async () => {
    let handlers: StreamHandlers | null = null;
    const transport: CollabTransport = {
      openStream: (_url, h) => { handlers = h; h.onOpen(); return { close: () => undefined }; },
      post: async () => ({ status: 200, body: { ok: true } }),
    };
    const { session, timers, notices } = makeSession(transport);
    session.start();
    handlers!.onEvent("welcome", {
      epoch: 1, base: JSON.stringify(BASE), ops: [], members: [],
      self: { siteId: SITE, userId: 1, name: "Ana", color: "#000" },
      serverTime: 0, truncated: true,
      limits: { maxOpsPerSec: 50, maxBytesPerSec: 1, maxFrameBytes: 1 },
    });
    await timers.run();

    expect(session.snapshot().status).toBe("degraded");
    expect(notices.some((n) => n.code === "log-full")).toBe(true);
  });
});

describe("presencia", () => {
  it("se coalesce: varias selecciones seguidas producen UN solo envío, el último", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    const real = server.transport();
    const sent: unknown[] = [];
    const spy: CollabTransport = {
      openStream: real.openStream,
      post: async (url, body) => { if (url.endsWith("/presence")) sent.push(body); return real.post(url, body); },
    };
    const { session, timers } = makeSession(spy);
    session.start();
    await timers.run();

    session.setSelection({ nodeId: "t1", field: "text", anchor: `${SITE}@1`, focus: `${SITE}@1` });
    session.setSelection({ nodeId: "t1", field: "text", anchor: `${SITE}@2`, focus: `${SITE}@2` });
    session.setSelection({ nodeId: "t1", field: "text", anchor: `${SITE}@3`, focus: `${SITE}@9` });
    await timers.run();

    expect(sent).toHaveLength(1);
    expect((sent[0] as { sel: { focus: string } }).sel.focus).toBe(`${SITE}@9`);
  });

  it("los miembros remotos entran y salen, y yo nunca aparezco en mi propia lista", async () => {
    const server = new FakeCollabServer(BASE, "auto");
    server.register({ siteId: SITE, userId: 1, name: "Ana" });
    server.register({ siteId: "s_bbbbbbbbbbbbbbbb", userId: 2, name: "Bruno" });
    const { session, timers } = makeSession(server.transport());
    session.start();
    await timers.run();

    const other = new VersoCollabSession({ postId: 7, transport: server.transport(), siteId: "s_bbbbbbbbbbbbbbbb" }, {});
    other.start();
    await settleMicrotasks();

    const members = session.snapshot().members;
    expect(members.map((m) => m.siteId)).toEqual([deriveSite("s_bbbbbbbbbbbbbbbb")]);
    expect(members[0].name).toBe("Bruno");
    expect(members.some((m) => m.siteId === deriveSite(SITE))).toBe(false);
  });
});

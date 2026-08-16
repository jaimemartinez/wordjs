/**
 * FUZZING ADVERSARIAL — 10.000 secuencias hostiles (espíritu de G-F8.6-a).
 *
 * El canal CRDT es una ruta de escritura NUEVA: lo que llega por él es dato
 * hostil hasta que se demuestre lo contrario. Invariantes que se exigen aquí:
 *
 * 1. JAMÁS un throw sin tipar: todo camino devuelve un `ApplyResult`.
 * 2. JAMÁS pérdida de contenido que no se haya borrado EXPLÍCITAMENTE.
 * 3. La proyección sigue siendo serializable y sigue pasando por `normalize`.
 * 4. Cero contaminación de prototipos (claves `__proto__`/`constructor`).
 * 5. Tiempo ACOTADO: ni un solo camino cuadrático disparado por dato ajeno.
 *
 * Lo que este fuzzer NO puede defender, y por eso se declara: un emisor
 * bizantino que REUTILIZA su causal dot `(siteId, counter)` con payloads
 * distintos hace que gane el que llegue primero. La defensa no es del álgebra
 * sino del servidor: `UNIQUE(post_id, site_id, counter)` en `collab_ops` (§5.2)
 * y el `siteId` atado a la conexión (§2.1). El test lo CONTIENE (sin crash, sin
 * corrupción) en vez de fingir que converge.
 */

import { describe, expect, it } from "vitest";
import { fromNormalized } from "../../normalize";
import { ROOT_ID, ROOT_SLOT, type VersoData } from "../../types";
import { isRichText, isSlot, mulberry32, pick, pickInt, newReplica, serialize, shuffle } from "./helpers";
import { CrdtDoc } from "../state";
import { toNormalized } from "../../normalize";
import type { CollabOp } from "../types";

const HOSTILE_SEQUENCES = 10_000;
const OPS_PER_SEQUENCE = 4;

const baseData = (): VersoData => ({
  content: [
    { type: "Heading", props: { id: "h", title: "T" } },
    { type: "Text", props: { id: "t", content: "<p>uno</p>" } },
    { type: "Section", props: { id: "s", items: [{ type: "Card", props: { id: "c", title: "A" } }] } },
  ],
  root: { props: { title: "P" } },
});

const IDS_ORIGINALES = ["h", "t", "s", "c"];

const BAD_KEYS = ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString"];
const BAD_HLCS = [
  { l: -1, c: -5, site: "s_x" },
  { l: Number.MAX_SAFE_INTEGER, c: 0, site: "s_x" },
  { l: Number.NaN, c: Number.NaN, site: "s_x" },
  { l: 0, c: 0, site: "" },
  { l: 1, c: 1, site: "~s" },
];

/** Un dot con `site` real (el núcleo rechaza los `~seed` por diseño). */
const dot = (rng: () => number, n: number) => ({ site: `s_h${pickInt(rng, 3)}`, counter: n });

function hostileOp(rng: () => number, n: number, seen: CollabOp[]): CollabOp {
  const roll = pickInt(rng, 14);
  const ghost = `fantasma-${pickInt(rng, 5)}`;
  const badHlc = pick(rng, BAD_HLCS)!;
  const badKey = pick(rng, BAD_KEYS)!;
  const pos = pick(rng, ["~s@1", "~s@99", "s_h0@7", "", "__proto__", "no-existe@1"])!;

  switch (roll) {
    case 0: // ops sobre nodos inexistentes o ya borrados
      return { k: "propSet", id: dot(rng, n), nodeId: ghost, key: "title", value: "x", hlc: badHlc };
    case 1: // nodeCreate con nodeId ya ocupado
      return {
        k: "nodeCreate",
        id: dot(rng, n),
        nodeId: pick(rng, [...IDS_ORIGINALES, ROOT_ID])!,
        type: "Text",
        props: { id: "colision" },
        propOrder: ["id"],
        slotKeys: [],
        hlc: badHlc,
      };
    case 2: // reutilización de un causal dot ya visto, con payload distinto
      return seen.length > 0
        ? { ...(pick(rng, seen) as CollabOp), k: "propSet", nodeId: "h", key: "title", value: "secuestrado", hlc: badHlc }
        : { k: "propSet", id: dot(rng, n), nodeId: "h", key: "title", value: "x", hlc: badHlc };
    case 3: // siteId semilla FALSIFICADO (reordenaría el documento de todos)
      return { k: "propSet", id: { site: "~s", counter: n }, nodeId: "h", key: "title", value: "forjado", hlc: badHlc };
    case 4: // claves peligrosas (contaminación de prototipos)
      return { k: "propSet", id: dot(rng, n), nodeId: pick(rng, IDS_ORIGINALES)!, key: badKey, value: { polluted: true }, hlc: badHlc };
    case 5: // payload malformado
      return {
        k: "nodeCreate",
        id: dot(rng, n),
        nodeId: `n${n}`,
        type: pick(rng, ["Text", "", "__proto__"])!,
        props: null as unknown as Record<string, unknown>,
        propOrder: [123 as unknown as string],
        slotKeys: [null as unknown as string],
        hlc: badHlc,
      };
    case 6: // listInsert con orígenes inventados
      return {
        k: "listInsert",
        id: dot(rng, n),
        parentId: pick(rng, [ROOT_ID, "s", ghost])!,
        slotKey: pick(rng, [ROOT_SLOT, "items", "", badKey])!,
        left: pos,
        right: pick(rng, [null, pos])!,
        nodeId: pick(rng, [ghost, "h"])!,
      };
    case 7: // move con ciclos y padres inventados
      return {
        k: "listMove",
        id: dot(rng, n),
        nodeId: pick(rng, [...IDS_ORIGINALES, ROOT_ID, ghost])!,
        toParentId: pick(rng, [...IDS_ORIGINALES, ghost, ROOT_ID])!,
        toSlotKey: pick(rng, ["items", ROOT_SLOT, badKey])!,
        left: null,
        right: null,
        hlc: badHlc,
      };
    case 8: // borrar cosas que no existen (nunca un nodo real: invariante 2)
      return { k: "nodeDelete", id: dot(rng, n), nodeId: ghost, hlc: badHlc };
    case 9: // texto sobre campos que no están abiertos / posiciones inventadas
      return {
        k: "textInsert",
        id: dot(rng, n),
        nodeId: pick(rng, [...IDS_ORIGINALES, ghost])!,
        field: pick(rng, ["content", "title", badKey])!,
        left: pos,
        right: null,
        atom: pick(rng, [{ br: false, ch: "x", marks: { bold: true, italic: false, link: null } }, null])! as never,
        hlc: badHlc,
      };
    case 10:
      return {
        k: "markSet",
        id: dot(rng, n),
        nodeId: "t",
        field: "content",
        pos,
        mark: pick(rng, ["bold", "link", "inventada"])! as never,
        value: { href: "javascript:alert(1)", newTab: true },
        hlc: badHlc,
      };
    case 11: // metadatos de forma con claves y valores basura
      return {
        k: "shapeSet",
        id: dot(rng, n),
        key: pick(rng, ["topKeyOrder", "contentKeyState", badKey, "extras:__proto__"])! as never,
        value: pick(rng, [null, 42, ["x", 1], { a: 1 }, "basura"]),
        hlc: badHlc,
      };
    case 12:
      return { k: "docReset", id: dot(rng, n), epoch: pick(rng, [-1, 0, 1e9, Number.NaN])!, snapshotHash: "" };
    default: // op de tipo desconocido / campos ausentes
      return pick(rng, [
        { k: "inventada", id: dot(rng, n) },
        { k: "propSet", id: null, nodeId: "h", key: "t", value: 1, hlc: badHlc },
        { k: "propSet", id: { site: "s_x", counter: Number.NaN }, nodeId: "h", key: "t", value: 1, hlc: badHlc },
        null,
        "no soy una op",
      ])! as unknown as CollabOp;
  }
}

const ESTADOS = new Set(["applied", "duplicate", "buffered", "rejected", "reset"]);

describe("CRDT — fuzzing adversarial", () => {
  it(`${HOSTILE_SEQUENCES.toLocaleString("es")} secuencias hostiles: sin throw, sin pérdida, con tiempo acotado`, () => {
    const rng = mulberry32(0xf0f0f0);
    const inicio = Date.now();
    const fallos: string[] = [];
    const estados: Record<string, number> = {};
    let contador = 0;

    for (let seq = 0; seq < HOSTILE_SEQUENCES && fallos.length === 0; seq++) {
      const r = CrdtDoc.fromDoc(toNormalized(baseData(), isSlot), { site: `s_v${seq % 7}`, isRichText });
      const vistas: CollabOp[] = [];
      for (let i = 0; i < OPS_PER_SEQUENCE; i++) {
        const op = hostileOp(rng, (contador += 1), vistas);
        vistas.push(op);
        let res;
        try {
          res = r.apply(op);
        } catch (e) {
          fallos.push(`seq ${seq} op ${i} (${(op as { k?: string })?.k}) LANZÓ: ${String(e)}`);
          break;
        }
        if (!res || !ESTADOS.has(res.status)) {
          fallos.push(`seq ${seq} op ${i}: estado no tipado ${JSON.stringify(res)}`);
          break;
        }
        estados[res.status] = (estados[res.status] ?? 0) + 1;
      }
      if (fallos.length > 0) break;

      // Invariante 3: la proyección sigue siendo un VersoDoc serializable.
      let json: string;
      try {
        json = JSON.stringify(fromNormalized(r.toDoc()));
      } catch (e) {
        fallos.push(`seq ${seq}: la proyección lanzó ${String(e)}`);
        break;
      }
      // Invariante 2: nada que no se borrara explícitamente ha desaparecido.
      for (const id of IDS_ORIGINALES) {
        if (!json.includes(`"${id}"`)) {
          // El caso se imprime ENTERO (ops incluidas): un fallo de fuzzing sin
          // la secuencia que lo produce no es reproducible, y por tanto no sirve.
          fallos.push(`seq ${seq}: se perdió el bloque "${id}" — ${json}\n  ops = ${JSON.stringify(vistas)}`);
          break;
        }
      }
      // Invariante 4: cero contaminación de prototipos.
      if (({} as Record<string, unknown>).polluted !== undefined) {
        fallos.push(`seq ${seq}: Object.prototype contaminado`);
      }
      if (Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")) {
        fallos.push(`seq ${seq}: Object.prototype tiene "polluted" propio`);
      }
    }

    const ms = Date.now() - inicio;
    expect(fallos.slice(0, 3)).toEqual([]);
    // El fuzzing tiene que MORDER: si todo se rechazara en la puerta, este test
    // sería verde y vacío. Se exige que una parte sustancial se APLIQUE de
    // verdad (llegando al álgebra) y que el buffer causal se ejercite.
    expect(estados.applied ?? 0, JSON.stringify(estados)).toBeGreaterThan(2_000);
    expect(estados.buffered ?? 0, JSON.stringify(estados)).toBeGreaterThan(200);
    expect(estados.rejected ?? 0, JSON.stringify(estados)).toBeGreaterThan(1_000);
    // Invariante 5: tiempo acotado (holgado a propósito: es un techo, no un benchmark).
    expect(ms, `el fuzzing tardó ${ms} ms`).toBeLessThan(60_000);
  });

  it("las ops hostiles con dots DISTINTOS convergen igual en cualquier orden", () => {
    const rng = mulberry32(0xbadbad);
    for (let seq = 0; seq < 300; seq++) {
      // Dots únicos: se excluye la reutilización de causal dot, que es
      // bizantina por definición y la corta el servidor (ver cabecera).
      const ops: CollabOp[] = [];
      const usados = new Set<string>();
      let n = seq * 100;
      while (ops.length < 8) {
        const op = hostileOp(rng, (n += 1), []);
        const id = (op as { id?: { site?: string; counter?: number } })?.id;
        const key = id ? `${id.site}@${id.counter}` : "";
        if (!id || usados.has(key)) continue;
        usados.add(key);
        ops.push(op);
      }
      const a = newReplica(baseData(), "s_a");
      for (const op of ops) a.apply(op);
      const b = newReplica(baseData(), "s_b");
      for (const op of shuffle(rng, ops)) b.apply(op);
      expect(serialize(b), `secuencia ${seq}`).toBe(serialize(a));
      expect(b.stateSignature(), `secuencia ${seq}`).toBe(a.stateSignature());
    }
  });

  it("una posición SEMILLA falsificada se rechaza con código tipado", () => {
    const r = newReplica(baseData(), "s_a");
    expect(r.apply({ k: "propSet", id: { site: "~s", counter: 1 }, nodeId: "h", key: "title", value: "x", hlc: { l: 1, c: 0, site: "~s" } })).toEqual({
      status: "rejected",
      code: "forged-seed-site",
    });
    expect(
      r.apply({
        k: "textInsert",
        id: { site: "~t:t:content", counter: 1 },
        nodeId: "t",
        field: "content",
        left: null,
        right: null,
        atom: { br: false, ch: "z", marks: { bold: false, italic: false, link: null } },
        hlc: { l: 1, c: 0, site: "s_a" },
      }),
    ).toEqual({ status: "rejected", code: "forged-seed-site" });
  });

  it("el buffer causal tiene TECHO (no es un vector de agotamiento de memoria)", () => {
    const r = newReplica(baseData(), "s_a", { maxPending: 32 });
    for (let i = 1; i <= 500; i++) {
      r.apply({ k: "propSet", id: { site: "s_z", counter: i }, nodeId: `fantasma-${i}`, key: "t", value: i, hlc: { l: i, c: 0, site: "s_z" } });
    }
    expect(r.pendingOps).toBeLessThanOrEqual(32);
    expect(serialize(r)).toBe(JSON.stringify(baseData()));
  });

  it("un reloj remoto del futuro lejano ORDENA pero no envenena el reloj local", () => {
    const r = newReplica(baseData(), "s_a", { now: () => 1_000 });
    const futuro = { l: 1_000_000_000_000, c: 0, site: "s_mal" };
    r.apply({ k: "propSet", id: { site: "s_mal", counter: 1 }, nodeId: "h", key: "title", value: "futuro", hlc: futuro });
    expect(r.toDoc().nodes.h.props.title).toBe("futuro");
    // El reloj local no se va al año 33.658: queda acotado por MAX_CLOCK_DRIFT_MS.
    expect(r.clock.peek().l).toBeLessThan(1_000 + 25 * 60 * 60 * 1000);
  });
});

/**
 * Verso F6 — FUZZING del deserializador (toNormalized / fromNormalized) y de
 * applyCommand con comandos aleatorios (a menudo inválidos a propósito).
 *
 * Generador determinista: mulberry32 con SEMILLA FIJA (el mismo PRNG que
 * labFixtures / verso-commands.test.ts) — cero Math.random, cada corrida
 * reproduce byte a byte los mismos árboles hostiles.
 *
 * Árboles hostiles cubiertos por el generador:
 *  - profundidad extrema (>100 niveles de anidamiento en un slot),
 *  - `type` no-string / `props` no-objeto / items sin id / id no-string,
 *  - ids duplicados y colisionantes con el esquema interno `#dupN`,
 *  - `zones` malformadas (no-objeto, claves sin `:`, destino inexistente,
 *    valores no-array, arrays mixtos),
 *  - "ciclos" vía REFERENCIAS REPETIDAS al mismo objeto (DAG de items — un
 *    ciclo verdadero no es representable en el JSON persistido, que es el
 *    contrato de entrada; la referencia repetida es el caso real que produce
 *    ids duplicados),
 *  - claves raras (`""`, `"#dup2"`, `"__proto__"` como own-property vía
 *    JSON.parse, unicode, espacios),
 *  - strings gigantes (~64KB, con probabilidad baja para acotar el tiempo).
 *
 * INVARIANTES:
 *  1. toNormalized / fromNormalized JAMÁS lanzan (política fail-soft).
 *  2. Sin pérdida: el round-trip es IDEMPOTENTE — out1 = from(to(x)) puede
 *     normalizar zones→slots (la única diferencia permitida), pero
 *     from(to(out1)) debe ser deep-equal a out1 (punto fijo).
 *  3. applyCommand con un comando aleatorio: o devuelve resultado, o lanza
 *     EXACTAMENTE VersoCommandError (cualquier otra excepción = fallo). En
 *     éxito, aplicar el inverso devuelve a la serialización de partida; el
 *     doc de entrada no se muta jamás (se verifica con deep-freeze periódico).
 *  4. Tiempo acotado: los 10.000 casos completos corren por DEFECTO — medidos
 *     en ~1s (muy por debajo del presupuesto de 60s/fichero), así que no hay
 *     recorte. VERSO_FUZZ_FULL=1 multiplica x5 (50.000) para barridos largos.
 */

import { describe, expect, test } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { mulberry32 } from "@/components/verso/lab/labFixtures";
import { fromNormalized, toNormalized } from "../normalize";
import { applyCommand, VersoCommandError } from "../commands";
import type { SlotResolver, VersoCommand, VersoData, VersoDoc, VersoItem } from "../types";
import { ROOT_ID, ROOT_SLOT } from "../types";

/* ------------------------------------------------------------------ */
/* Volumen y semilla                                                    */
/* ------------------------------------------------------------------ */

const FUZZ_CASES_DEFAULT = 10_000; // el encargo completo, por defecto (~1s medido)
const FUZZ_CASES = process.env.VERSO_FUZZ_FULL === "1" ? FUZZ_CASES_DEFAULT * 5 : FUZZ_CASES_DEFAULT;
const FUZZ_SEED = 0xf6f6;
/** Cada N casos, el doc de entrada de applyCommand se congela en profundidad (caro). */
const FREEZE_EVERY = 10;
const TEST_TIMEOUT_MS = 300_000;

/* ------------------------------------------------------------------ */
/* Generador                                                            */
/* ------------------------------------------------------------------ */

type Rng = () => number;

const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const int = (rng: Rng, n: number): number => Math.floor(rng() * n);
const chance = (rng: Rng, p: number): boolean => rng() < p;

const WEIRD_KEYS = [
  "",
  " ",
  "a b",
  "#dup2",
  "#dup3",
  "constructor",
  "hasOwnProperty",
  "🌀clave",
  "a.b[0]",
  "content",
  "zones",
  "root",
  "type",
  "props",
] as const;

const WEIRD_IDS = ["", "a", "a#dup2", "a#dup3", "dup", "verso:root", "🌀", " id con espacios "] as const;

function giantString(rng: Rng): string {
  // ~64KB — suficiente para estresar sin reventar el presupuesto de tiempo.
  return `g${"x".repeat(4096 * (1 + int(rng, 15)))}${int(rng, 10)}`;
}

function makeScalar(rng: Rng): unknown {
  const r = rng();
  if (r < 0.3) return `s${int(rng, 1000)}`;
  if (r < 0.45) return int(rng, 1_000_000);
  if (r < 0.55) return chance(rng, 0.5);
  if (r < 0.65) return null;
  if (r < 0.7) return rng() * 1e9;
  if (r < 0.72) return giantString(rng);
  if (r < 0.8) return { nested: { deep: `v${int(rng, 100)}` } };
  if (r < 0.9) return [int(rng, 10), `t${int(rng, 10)}`, null];
  // own-property "__proto__" (JSON.parse crea la clave propia, no el prototipo)
  return JSON.parse(`{"__proto__": ${int(rng, 100)}, "k": "v"}`) as unknown;
}

interface GenCtx {
  rng: Rng;
  /** Items ya creados — fuente de referencias REPETIDAS (mismo objeto, dos padres). */
  pool: unknown[];
  /** Presupuesto de nodos restante del caso. */
  budget: number;
}

function makeId(ctx: GenCtx): unknown {
  const { rng } = ctx;
  if (chance(rng, 0.15)) return pick(rng, WEIRD_IDS); // duplicados y colisiones #dupN frecuentes
  if (chance(rng, 0.05)) return int(rng, 100); // id no-string
  if (chance(rng, 0.03)) return undefined; // sin id
  return `n${int(rng, 40)}`; // rango corto a propósito: colisiones garantizadas
}

/** Un "item": mayormente con forma válida, con vetas hostiles. */
function makeItem(ctx: GenCtx, depth: number): unknown {
  const { rng } = ctx;
  ctx.budget -= 1;

  // Referencia repetida a un objeto YA emitido (el "ciclo" del contrato JSON).
  if (ctx.pool.length > 0 && chance(rng, 0.08)) return pick(rng, ctx.pool);

  if (chance(rng, 0.06)) return makeScalar(rng); // ni siquiera es un objeto

  const item: Record<string, unknown> = {};
  item.type = chance(rng, 0.06) ? makeScalar(rng) : pick(rng, ["Heading", "Text", "Card", "Section", "Grid", "X"]);

  if (chance(rng, 0.05)) {
    item.props = makeScalar(rng); // props no-objeto
  } else {
    const props: Record<string, unknown> = {};
    // El orden de inserción de claves importa (keyOrder): a veces id al final.
    const idFirst = chance(rng, 0.7);
    if (idFirst) props.id = makeId(ctx);
    const nProps = int(rng, 4);
    for (let i = 0; i < nProps; i++) {
      const key = chance(rng, 0.25) ? pick(rng, WEIRD_KEYS) : `p${int(rng, 6)}`;
      if (key === "id") continue;
      if (chance(rng, 0.35) && depth < 6 && ctx.budget > 0) {
        // Slot estructural: array de hijos (a veces mixto con basura).
        const kids: unknown[] = [];
        const nKids = int(rng, 3);
        for (let k = 0; k < nKids && ctx.budget > 0; k++) kids.push(makeItem(ctx, depth + 1));
        if (chance(rng, 0.15)) kids.push(makeScalar(rng)); // array mixto: NO es slot
        props[key] = kids;
      } else {
        props[key] = makeScalar(rng);
      }
    }
    if (!idFirst && !chance(rng, 0.05)) props.id = makeId(ctx);
    item.props = props;
  }

  if (chance(rng, 0.15)) item.readOnly = chance(rng, 0.5); // extra a nivel de item
  if (chance(rng, 0.05)) (item as Record<string, unknown>)[pick(rng, WEIRD_KEYS)] = makeScalar(rng);

  ctx.pool.push(item);
  return item;
}

/** Cadena de anidamiento EXTREMO: >100 niveles de children. */
function makeDeepChain(rng: Rng): unknown {
  const depth = 110 + int(rng, 80);
  let node: unknown = { type: "Text", props: { id: `deep-leaf`, content: "fondo" } };
  for (let i = depth; i > 0; i--) {
    node = { type: "Section", props: { id: `deep-${i}`, children: [node] } };
  }
  return node;
}

function makeZones(ctx: GenCtx): unknown {
  const { rng } = ctx;
  const r = rng();
  if (r < 0.15) return makeScalar(rng); // zones no-objeto
  if (r < 0.2) return null;
  if (r < 0.25) return [makeItem(ctx, 0)];
  const zones: Record<string, unknown> = {};
  const n = int(rng, 3) + 1;
  for (let i = 0; i < n; i++) {
    const key = chance(rng, 0.3)
      ? pick(rng, ["sin-dos-puntos", ":slotsolo", "idsolo:", `missing-${int(rng, 5)}:children`, ""])
      : `n${int(rng, 40)}:${chance(rng, 0.5) ? "children" : `z${int(rng, 3)}`}`;
    if (chance(rng, 0.2)) {
      zones[key] = makeScalar(rng); // valor no-array
    } else {
      const items: unknown[] = [];
      const k = int(rng, 3);
      for (let j = 0; j < k && ctx.budget > 0; j++) items.push(makeItem(ctx, 0));
      if (chance(rng, 0.15)) items.push(makeScalar(rng));
      zones[key] = items;
    }
  }
  return zones;
}

/** Caso completo: un objeto con forma (hostil) de VersoData. */
function makeHostileData(rng: Rng): unknown {
  const ctx: GenCtx = { rng, pool: [], budget: 60 };
  const data: Record<string, unknown> = {};
  const r = rng();

  // Orden top-level variable (docs reales guardan root antes que content).
  const rootFirst = chance(rng, 0.5);
  const emitRoot = (): void => {
    if (chance(rng, 0.8)) {
      data.root = chance(rng, 0.1)
        ? makeScalar(rng)
        : { props: chance(rng, 0.15) ? makeScalar(rng) : { title: `T${int(rng, 100)}` } };
    }
  };

  if (rootFirst) emitRoot();

  if (r < 0.08) {
    data.content = makeScalar(rng); // content no-array (se preserva verbatim)
  } else if (r < 0.13) {
    data.content = [makeDeepChain(rng)]; // profundidad extrema
  } else if (r < 0.18) {
    // referencias repetidas explícitas: el MISMO objeto dos/tres veces
    const shared = makeItem(ctx, 0);
    data.content = [shared, makeItem(ctx, 0), shared, chance(rng, 0.5) ? shared : makeItem(ctx, 0)];
  } else if (r < 0.93) {
    const n = int(rng, 8);
    const content: unknown[] = [];
    for (let i = 0; i < n && ctx.budget > 0; i++) content.push(makeItem(ctx, 0));
    data.content = content;
  }
  // else: sin clave content (estado "absent", real en revisiones de producción)

  if (!rootFirst) emitRoot();
  if (chance(rng, 0.4)) data.zones = makeZones(ctx);
  if (chance(rng, 0.25)) data[pick(rng, WEIRD_KEYS.filter((k) => !(k in data)))] = makeScalar(rng);

  return data;
}

/* ------------------------------------------------------------------ */
/* Resolutor de slots (a veces presente, a veces no — ambas rutas)      */
/* ------------------------------------------------------------------ */

const RESOLVER: SlotResolver = (_type, key) => {
  if (key === "children") return true;
  if (key === "p0") return false;
  return undefined;
};

/* ------------------------------------------------------------------ */
/* Comandos aleatorios                                                  */
/* ------------------------------------------------------------------ */

function someNodeId(rng: Rng, doc: VersoDoc): string {
  const keys = Object.keys(doc.nodes);
  if (keys.length === 0 || chance(rng, 0.25)) return `fantasma-${int(rng, 5)}`;
  return pick(rng, keys);
}

function someParent(rng: Rng, doc: VersoDoc): { parentId: string; slotKey: string } {
  const r = rng();
  if (r < 0.4) return { parentId: ROOT_ID, slotKey: chance(rng, 0.9) ? ROOT_SLOT : "otra" };
  const id = someNodeId(rng, doc);
  const node = doc.nodes[id];
  const slots = node ? Object.keys(node.slots) : [];
  const slotKey = slots.length > 0 && chance(rng, 0.7) ? pick(rng, slots) : pick(rng, ["children", "p1", "id", ""]);
  return { parentId: id, slotKey };
}

function randomCommand(rng: Rng, doc: VersoDoc): VersoCommand {
  const kind = pick(rng, [
    "insertNode",
    "moveNode",
    "removeNode",
    "setProps",
    "setRootProps",
    "duplicateSubtree",
    "replaceData",
  ] as const);
  switch (kind) {
    case "insertNode": {
      const { parentId, slotKey } = someParent(rng, doc);
      const item: VersoItem = {
        type: pick(rng, ["Text", "Heading", "Section"]),
        props: { id: chance(rng, 0.2) ? someNodeId(rng, doc) : `ins-${int(rng, 1000)}` },
      };
      if (chance(rng, 0.3)) (item.props as Record<string, unknown>).children = [];
      return { kind, item, parentId, slotKey, index: int(rng, 12) - 3 };
    }
    case "moveNode": {
      const { parentId, slotKey } = someParent(rng, doc);
      return { kind, nodeId: someNodeId(rng, doc), toParentId: parentId, toSlotKey: slotKey, toIndex: int(rng, 12) - 3 };
    }
    case "removeNode":
      return { kind, nodeId: someNodeId(rng, doc) };
    case "setProps": {
      const patch: Record<string, unknown> = {};
      const n = int(rng, 3) + 1;
      for (let i = 0; i < n; i++) {
        const key = chance(rng, 0.15) ? "id" : chance(rng, 0.2) ? pick(rng, WEIRD_KEYS) : `p${int(rng, 6)}`;
        patch[key] = chance(rng, 0.2) ? undefined : makeScalar(rng);
      }
      return { kind, nodeId: someNodeId(rng, doc), patch };
    }
    case "setRootProps":
      return { kind, patch: { title: `t${int(rng, 100)}`, ...(chance(rng, 0.3) ? { extra: makeScalar(rng) } : {}) } };
    case "duplicateSubtree":
      return { kind, nodeId: someNodeId(rng, doc) };
    case "replaceData": {
      // Un replaceData con data hostil: el store lo recibe de imports JSON.
      return { kind, data: makeHostileData(rng) as VersoData };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Deep-freeze (detección de mutación del doc de entrada)               */
/* ------------------------------------------------------------------ */

function deepFreeze(value: unknown, seen: Set<unknown>): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v, seen);
}

/* ------------------------------------------------------------------ */
/* Suite                                                                */
/* ------------------------------------------------------------------ */

describe(`fuzz deserializador Verso (${FUZZ_CASES} casos, seed 0x${FUZZ_SEED.toString(16)})`, () => {
  test(
    "toNormalized/fromNormalized: jamás throw, round-trip idempotente (sin pérdida)",
    { timeout: TEST_TIMEOUT_MS },
    () => {
      const rng = mulberry32(FUZZ_SEED);
      for (let i = 0; i < FUZZ_CASES; i++) {
        const data = makeHostileData(rng) as VersoData;
        const isSlot = chance(rng, 0.5) ? RESOLVER : undefined;

        let doc: VersoDoc;
        let out1: VersoData;
        let out2: VersoData;
        try {
          doc = toNormalized(data, isSlot);
          out1 = fromNormalized(doc);
          out2 = fromNormalized(toNormalized(out1, isSlot));
        } catch (err) {
          throw new Error(`caso ${i}: el pipeline lanzó (${String(err)})\n${safeStringify(data)}`);
        }

        // Punto fijo: la primera pasada puede normalizar (zones→slots); la
        // segunda ya no puede cambiar NADA — cualquier diferencia es pérdida
        // o corrupción introducida por el propio deserializador.
        if (!isDeepStrictEqual(out1, out2)) {
          expect(out2, `caso ${i}: round-trip NO idempotente\nentrada: ${safeStringify(data)}`).toEqual(out1);
        }
      }
    },
  );

  test(
    "applyCommand aleatorio: VersoCommandError tipado o inverso exacto, sin mutar la entrada",
    { timeout: TEST_TIMEOUT_MS },
    () => {
      const rng = mulberry32(FUZZ_SEED ^ 0x5eed);
      let generateCount = 0;
      const generateId = (): string => `gen-${++generateCount}`;
      for (let i = 0; i < FUZZ_CASES; i++) {
        const data = makeHostileData(rng) as VersoData;
        let doc: VersoDoc;
        try {
          doc = toNormalized(data, RESOLVER);
        } catch (err) {
          throw new Error(`caso ${i}: toNormalized lanzó (${String(err)})`);
        }
        const before = fromNormalized(doc);
        if (i % FREEZE_EVERY === 0) deepFreeze(doc, new Set());

        const cmd = randomCommand(rng, doc);
        let result: ReturnType<typeof applyCommand> | null = null;
        try {
          result = applyCommand(doc, cmd, { isSlot: RESOLVER, generateId });
        } catch (err) {
          if (!(err instanceof VersoCommandError)) {
            throw new Error(
              `caso ${i}: applyCommand lanzó algo que NO es VersoCommandError (${String(err)})\ncomando: ${safeStringify(cmd)}`,
            );
          }
          // Comando inválido: el doc de entrada debe seguir serializando igual.
          const after = fromNormalized(doc);
          if (!isDeepStrictEqual(before, after)) {
            expect(after, `caso ${i}: VersoCommandError dejó el doc TOCADO`).toEqual(before);
          }
          continue;
        }

        // Éxito: el inverso devuelve a la serialización de partida.
        let undone: VersoData;
        try {
          undone = fromNormalized(applyCommand(result.doc, result.inverse, { isSlot: RESOLVER, generateId }).doc);
        } catch (err) {
          throw new Error(`caso ${i}: el INVERSO lanzó (${String(err)})\ncomando: ${safeStringify(cmd)}`);
        }
        if (!isDeepStrictEqual(undone, before)) {
          expect(undone, `caso ${i}: inverso NO exacto\ncomando: ${safeStringify(cmd)}`).toEqual(before);
        }
        // Y la entrada sigue intacta (estructura compartida sin mutación).
        const after = fromNormalized(doc);
        if (!isDeepStrictEqual(before, after)) {
          expect(after, `caso ${i}: applyCommand MUTÓ el doc de entrada`).toEqual(before);
        }
      }
    },
  );
});

/** JSON.stringify tolerante a referencias repetidas/gigantes para mensajes de error. */
function safeStringify(value: unknown): string {
  const seen = new Set<unknown>();
  try {
    const s = JSON.stringify(
      value,
      (_k, v: unknown) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[ref repetida]";
          seen.add(v);
        }
        if (typeof v === "string" && v.length > 200) return `${v.slice(0, 200)}…(${v.length})`;
        return v;
      },
      2,
    );
    return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
  } catch {
    return "[no serializable]";
  }
}

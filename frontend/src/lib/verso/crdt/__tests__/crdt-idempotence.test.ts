/**
 * IDEMPOTENCIA y CONMUTATIVIDAD — las dos propiedades que hacen que el canal
 * pueda ser tonto (reenviar, reordenar, duplicar) sin corromper el documento.
 *
 * - Idempotencia: reaplicar una op YA integrada no cambia NADA (ni la
 *   serialización ni el estado interno) y se reporta como `duplicate`.
 * - Conmutatividad: el orden de entrega no importa. Se comprueba con TODAS las
 *   permutaciones de conjuntos pequeños, no con una muestra.
 */

import { describe, expect, it } from "vitest";
import { mulberry32, newReplica, sampleData, serialize, shuffle, simulateConcurrentSession } from "./helpers";
import type { CollabOp } from "../types";

/** Todas las permutaciones de `arr` (n! — solo para n pequeño). */
function permutations<T>(arr: readonly T[]): T[][] {
  if (arr.length <= 1) return [[...arr]];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

describe("CRDT — idempotencia", () => {
  it("reaplicar cada op N veces no cambia ni la serialización ni el estado", () => {
    for (let seed = 501; seed <= 560; seed++) {
      const { ops } = simulateConcurrentSession(sampleData(), 3, 20, seed);
      if (ops.length === 0) continue;
      const unaVez = newReplica(sampleData(), "s_1");
      for (const op of ops) unaVez.apply(op);
      const tresVeces = newReplica(sampleData(), "s_1");
      for (const op of ops) {
        tresVeces.apply(op);
        tresVeces.apply(op);
        tresVeces.apply(op);
      }
      expect(serialize(tresVeces), `seed ${seed}`).toBe(serialize(unaVez));
      expect(tresVeces.stateSignature(), `seed ${seed}`).toBe(unaVez.stateSignature());
    }
  });

  it("la reaplicación se REPORTA como `duplicate` (no como aplicada)", () => {
    const { ops } = simulateConcurrentSession(sampleData(), 3, 24, 777);
    const r = newReplica(sampleData(), "s_1");
    const aplicadas: CollabOp[] = [];
    for (const op of ops) {
      if (r.apply(op).status === "applied") aplicadas.push(op);
    }
    expect(aplicadas.length).toBeGreaterThan(5);
    for (const op of aplicadas) {
      expect(r.apply(op)).toEqual({ status: "duplicate" });
    }
  });

  it("reaplicar al FINAL de la sesión (reconexión) tampoco mueve nada", () => {
    const rng = mulberry32(4242);
    const { ops } = simulateConcurrentSession(sampleData(), 4, 26, 4242);
    const r = newReplica(sampleData(), "s_1");
    for (const op of ops) r.apply(op);
    const antes = { doc: serialize(r), sig: r.stateSignature() };
    for (const op of shuffle(rng, ops)) r.apply(op);
    expect(serialize(r)).toBe(antes.doc);
    expect(r.stateSignature()).toBe(antes.sig);
  });
});

describe("CRDT — conmutatividad", () => {
  it("TODAS las permutaciones de conjuntos de 5 ops dan el mismo resultado", () => {
    for (let seed = 601; seed <= 630; seed++) {
      const { ops } = simulateConcurrentSession(sampleData(), 3, 12, seed);
      if (ops.length < 5) continue;
      const muestra = ops.slice(0, 5);
      const referencia = (() => {
        const r = newReplica(sampleData(), "s_ref");
        for (const op of muestra) r.apply(op);
        return { doc: serialize(r), sig: r.stateSignature() };
      })();
      for (const perm of permutations(muestra)) {
        const r = newReplica(sampleData(), "s_perm");
        for (const op of perm) r.apply(op);
        expect(serialize(r), `seed ${seed} permutación ${perm.map((o) => o.k).join(">")}`).toBe(referencia.doc);
        expect(r.stateSignature()).toBe(referencia.sig);
      }
    }
  });

  it("mezclar permutación Y duplicados a la vez sigue convergiendo", () => {
    const rng = mulberry32(31337);
    for (let seed = 701; seed <= 730; seed++) {
      const { ops } = simulateConcurrentSession(sampleData(), 4, 18, seed);
      if (ops.length === 0) continue;
      const base = newReplica(sampleData(), "s_base");
      for (const op of ops) base.apply(op);
      const ruido: CollabOp[] = [];
      for (const op of shuffle(rng, ops)) {
        ruido.push(op);
        if (rng() < 0.4) ruido.push(op);
      }
      const otra = newReplica(sampleData(), "s_ruido");
      for (const op of shuffle(rng, ruido)) otra.apply(op);
      expect(serialize(otra), `seed ${seed}`).toBe(serialize(base));
      expect(otra.stateSignature(), `seed ${seed}`).toBe(base.stateSignature());
    }
  });
});

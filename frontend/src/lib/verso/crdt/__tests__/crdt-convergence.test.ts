/**
 * GATE G-F8.1-a — CONVERGENCIA por property-testing con semilla fija.
 *
 * N réplicas (3-5) generan ops concurrentes con entrega desordenada; después,
 * réplicas FRESCAS aplican el mismo conjunto de ops en permutaciones distintas
 * (incluida entrega FUERA DE ORDEN CAUSAL, que ejercita el buffer). Todas
 * tienen que terminar con:
 *   · la MISMA serialización `_puck_data` byte a byte, y
 *   · la MISMA firma de estado (tombstones y posiciones incluidos) — porque una
 *     divergencia estructural que hoy no se ve en la serialización es una bomba
 *     de relojería que estalla en la siguiente op.
 *
 * 1.000 escenarios generados. Todo sale de `mulberry32(seed)`: cualquier fallo
 * se reproduce con `SCENARIOS`/`seed` a mano.
 */

import { describe, expect, it } from "vitest";
import { newReplica, sampleData, serialize, shuffle, mulberry32, simulateConcurrentSession } from "./helpers";
import type { CollabOp } from "../types";
import type { VersoData } from "../../types";

const SCENARIOS = 1000;

/** Réplica fresca que aplica `ops` en el orden dado (el buffer causal reordena). */
function replay(data: VersoData, ops: readonly CollabOp[], site: string): { doc: string; sig: string; pending: number } {
  const r = newReplica(data, site);
  for (const op of ops) r.apply(op);
  return { doc: serialize(r), sig: r.stateSignature(), pending: r.pendingOps };
}

/**
 * PLAZO PARA TODO EL FICHERO. Mil escenarios con permutaciones aleatorias son CPU real, no espera:
 * aquí rondan 2 s y el plazo por defecto de vitest son 5, pero en el runner de CI —más lento— ya se
 * pasó y tumbó la suite. Este es el gate de CONVERGENCIA, el que menos conviene que nadie aprenda a
 * ignorar cuando se pone rojo, así que se le da margen en vez de recortar escenarios: recortar sí
 * taparía algo, porque la cobertura es justamente lo que hace visible un fallo de convergencia.
 */
const PLAZO_MS = 60_000;

describe("CRDT — convergencia (property-based, 1.000 escenarios)", () => {
  it("N réplicas + permutaciones aleatorias ⇒ misma serialización y mismo estado", () => {
    const fallos: string[] = [];
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const replicaCount = 3 + (seed % 3);
      const rounds = 14 + (seed % 17);
      const { ops, replicas } = simulateConcurrentSession(sampleData(), replicaCount, rounds, seed);
      if (ops.length === 0) continue;

      const referencia = { doc: serialize(replicas[0]), sig: replicas[0].stateSignature() };
      for (let i = 1; i < replicas.length; i++) {
        if (serialize(replicas[i]) !== referencia.doc) {
          fallos.push(`seed ${seed}: réplica generadora ${i} diverge en la serialización`);
          break;
        }
        if (replicas[i].stateSignature() !== referencia.sig) {
          fallos.push(`seed ${seed}: réplica generadora ${i} diverge en el ESTADO`);
          break;
        }
      }

      const rng = mulberry32(seed * 7919);
      for (let k = 0; k < 3; k++) {
        const out = replay(sampleData(), shuffle(rng, ops), `s_f${k}`);
        if (out.doc !== referencia.doc) {
          fallos.push(`seed ${seed}: permutación ${k} diverge en la serialización`);
          break;
        }
        if (out.sig !== referencia.sig) {
          fallos.push(`seed ${seed}: permutación ${k} diverge en el ESTADO`);
          break;
        }
        if (out.pending !== 0) {
          fallos.push(`seed ${seed}: permutación ${k} dejó ${out.pending} ops en el buffer causal`);
          break;
        }
      }
      if (fallos.length > 0) break;
    }
    expect(fallos).toEqual([]);
  }, PLAZO_MS);

  it("el orden INVERSO (peor caso causal) converge igual que el directo", () => {
    for (let seed = 2001; seed <= 2060; seed++) {
      const { ops, replicas } = simulateConcurrentSession(sampleData(), 4, 22, seed);
      if (ops.length === 0) continue;
      const directo = replay(sampleData(), ops, "s_dir");
      const inverso = replay(sampleData(), [...ops].reverse(), "s_inv");
      expect(inverso.doc, `seed ${seed}`).toBe(directo.doc);
      expect(inverso.sig, `seed ${seed}`).toBe(directo.sig);
      expect(inverso.pending, `seed ${seed}`).toBe(0);
      expect(directo.doc).toBe(serialize(replicas[0]));
    }
  }, PLAZO_MS);

  it("entrega por lotes desordenados con reentrega parcial (reconexión) converge", () => {
    for (let seed = 3001; seed <= 3040; seed++) {
      const rng = mulberry32(seed);
      const { ops } = simulateConcurrentSession(sampleData(), 3, 20, seed);
      if (ops.length === 0) continue;
      const base = replay(sampleData(), ops, "s_base");
      // Reentrega: cada op se manda 1-3 veces, en desorden (lo que hace un
      // cliente que reconecta y reenvía su cola pendiente).
      const conRepeticiones: CollabOp[] = [];
      for (const op of shuffle(rng, ops)) {
        const veces = 1 + Math.floor(rng() * 3);
        for (let i = 0; i < veces; i++) conRepeticiones.push(op);
      }
      const out = replay(sampleData(), conRepeticiones, "s_dup");
      expect(out.doc, `seed ${seed}`).toBe(base.doc);
      expect(out.sig, `seed ${seed}`).toBe(base.sig);
    }
  }, PLAZO_MS);
});

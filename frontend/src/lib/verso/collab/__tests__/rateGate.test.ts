/**
 * Verso/colaboración — EL ACUSE ES UN PAR, NO UN NÚMERO (F8.3, ronda 5).
 *
 * `RateGate` lleva la mitad de la propiedad que le toca al cliente:
 *
 *     UN CLIENTE QUE RESPETA LA ESPERA QUE EL SERVIDOR LE PIDE NUNCA PUEDE SER EXPULSADO.
 *
 * La ronda 4 la dejó cerrada contra la latencia y se rompió entera en la RECONEXIÓN. El servidor
 * numera los avisos POR CONEXIÓN y vuelve a empezar en 1 en cada una, así que comparar el aviso nuevo
 * contra «el último que apliqué» solo significa algo si los dos números son del MISMO emisor. Sin
 * mirar eso, el primer 429 de la conexión nueva (aviso 1) parecía un duplicado en vuelo de la
 * anterior (aplicado 4) y el cliente NO FRENABA — mientras el servidor, envenenado por el mismo
 * desajuste, ya lo contaba como desobediencia. Los dos lados fallaban a la vez y hacia el mismo sitio.
 *
 * Estos tests fijan la regla en el lado del cliente: un sello distinto es OTRA numeración, y lo
 * acusado hasta entonces no puede silenciar ni un aviso suyo. `publica()` (el `welcome`) sigue
 * reiniciando, pero ya no es de lo que depende la corrección: el hueco que mataba a la gente era
 * justo el rato en el que el `welcome` todavía no había llegado.
 */

import { describe, expect, it } from "vitest";

import { RateGate } from "../rateGate";

/** Cola de temporizadores manual: una espera hay que poder soltarla a mano para poder medirla. */
class Relojes {
  private items = new Map<number, () => void>();
  private seq = 0;

  readonly later = (ms: number, fn: () => void): unknown => {
    void ms;
    const id = ++this.seq;
    this.items.set(id, fn);
    return id;
  };

  readonly clear = (handle: unknown): void => {
    if (typeof handle === "number") this.items.delete(handle);
  };

  get pendientes(): number {
    return this.items.size;
  }

  /** Suelta todo lo pendiente (el equivalente a que venza la espera). */
  vencer(): void {
    const fns = [...this.items.values()];
    this.items.clear();
    for (const fn of fns) fn();
  }
}

const gateNuevo = (): { gate: RateGate; relojes: Relojes } => {
  const relojes = new Relojes();
  const gate = new RateGate({ later: relojes.later, clear: relojes.clear });
  gate.publica(900);
  return { gate, relojes };
};

describe("RateGate: el acuse está atado a la conexión que acuñó el aviso", () => {
  it("un aviso de OTRA conexión NO se descarta por duplicado, aunque su número sea menor", () => {
    // La secuencia exacta de la expulsión medida por el verificador: cuatro avisos en la conexión
    // vieja, se cae el stream, y el primer 429 de la conexión nueva llega con el número 1 ANTES de
    // que el `welcome` se haya procesado. Con solo el número, `1 <= 4` ⇒ «duplicado en vuelo» ⇒ el
    // cliente seguía enviando cada 100 ms contra un servidor que ya contaba strikes.
    const { gate, relojes } = gateNuevo();

    for (const n of [1, 2, 3, 4]) {
      gate.rechazado({ retryAfterMs: 900, rateNotice: n, rateSeal: "conexion-1" });
      relojes.vencer();
    }
    expect(gate.ack, "el cliente ha visto los cuatro avisos de la conexión 1").toBe(4);
    expect(gate.frenado, "y las esperas de la conexión 1 ya vencieron").toBe(false);

    // Reconexión: el servidor vuelve a numerar desde 1, con OTRO sello. El `welcome` todavía no ha
    // llegado (es de 1,80 MB en la sala del informe), así que `publica()` no ha corrido.
    gate.rechazado({ retryAfterMs: 900, rateNotice: 1, rateSeal: "conexion-2" });

    expect(
      gate.frenado,
      "el aviso 1 de la conexión NUEVA no es un duplicado del 4 de la vieja: hay que frenar",
    ).toBe(true);
  });

  it("tras un emisor nuevo, el acuse que se devuelve es el SUYO y no el heredado", () => {
    // Mandarle al servidor un número acuñado por otra conexión es lo que envenenaba su contador. El
    // sello viaja con el número precisamente para que ese acuse no se pueda aplicar en otra parte.
    const { gate, relojes } = gateNuevo();

    gate.rechazado({ retryAfterMs: 900, rateNotice: 4, rateSeal: "conexion-1" });
    relojes.vencer();
    expect(gate.ack).toBe(4);
    expect(gate.sello).toBe("conexion-1");

    gate.rechazado({ retryAfterMs: 900, rateNotice: 1, rateSeal: "conexion-2" });
    expect(gate.ack, "la numeración de la conexión nueva empieza por su propio 1").toBe(1);
    expect(gate.sello, "y el acuse va sellado por quien lo acuñó").toBe("conexion-2");
  });

  it("dentro de la MISMA conexión, un aviso ya aplicado sigue sin alargar la espera", () => {
    // CONTRA LA VACUIDAD del test de arriba: si «sello distinto ⇒ olvida» se hubiera implementado
    // como «olvida siempre», dos copias en vuelo del mismo 429 volverían a armar el freno y la espera
    // crecería sola. La deduplicación dentro de una conexión es lo que evita eso, y sigue viva.
    const { gate, relojes } = gateNuevo();

    gate.rechazado({ retryAfterMs: 900, rateNotice: 1, rateSeal: "conexion-1" });
    expect(gate.frenado).toBe(true);
    relojes.vencer();
    expect(gate.frenado, "la espera venció").toBe(false);

    // Segunda copia del MISMO aviso: iba por el cable cuando se emitió el primero.
    gate.rechazado({ retryAfterMs: 900, rateNotice: 1, rateSeal: "conexion-1" });
    expect(gate.frenado, "el mismo aviso no vuelve a frenar: no es una instrucción nueva").toBe(false);
  });

  it("un 429 SIN instrucción (un proxy por medio) frena igual y no inventa ningún acuse", () => {
    // Un intermediario puede responder 429 sin nada dentro. No hay nada que reconocer, así que el
    // acuse no sube —declarar una instrucción que el servidor no ha emitido sería autoinculparse—
    // pero la espera sí se aplica: ante la duda, esperar.
    const { gate } = gateNuevo();

    gate.rechazado({});
    expect(gate.frenado, "sin instrucción también se frena").toBe(true);
    expect(gate.ack, "y no se acusa nada que nadie haya dicho").toBe(0);
    expect(gate.sello).toBe(null);
  });

  it("el `welcome` reinicia la numeración y suelta el sello", () => {
    const { gate, relojes } = gateNuevo();

    gate.rechazado({ retryAfterMs: 900, rateNotice: 3, rateSeal: "conexion-1" });
    relojes.vencer();
    expect(gate.ack).toBe(3);

    gate.publica(900);
    expect(gate.ack, "sesión nueva, numeración nueva").toBe(0);
    expect(gate.sello, "y ningún emisor adoptado todavía").toBe(null);
  });
});

/**
 * Verso/colaboración — LA ESPERA DEL CLIENTE, EN UN SOLO SITIO (F8.3).
 *
 * Este módulo existe por un defecto que se arregló tres veces y tres veces reapareció en otro sitio:
 * un cliente que hacía un `resync` legítimo acababa EXPULSADO de la sala (429, 429, 429 y 409
 * `collab_no_session` con el stream cerrado). Se cerró en el camino de las operaciones y reapareció
 * en el de PRESENCIA; se cerró en el `rateCheck` del servidor y reapareció en el PLANIFICADOR del
 * cliente. Cada arreglo era correcto en su punto. Lo que se estaba parcheando era el SÍNTOMA —el
 * sitio donde ocurría la expulsión— en vez de garantizar la propiedad:
 *
 *     UN CLIENTE QUE RESPETA LA ESPERA QUE EL SERVIDOR LE PIDE NUNCA PUEDE SER EXPULSADO.
 *
 * La mitad de la propiedad que le toca al cliente es «no mandar nada mientras haya una espera en
 * vigor», y aquí está entera. No la aplica ningún planificador: los planificadores solo deciden
 * CUÁNDO les gustaría enviar, y el envío (`client.ts#post`) pasa por `ready()` sí o sí. Un
 * planificador que se olvide de la espera —que es literalmente lo que pasó en la ronda 3, donde un
 * temporizador de 100 ms ya armado se comía el backoff recién fijado— no puede saltársela, porque no
 * es él quien la aplica.
 *
 * La otra mitad la garantiza el servidor (`rateGate` en backend/src/core/collab-rooms.ts): la
 * expulsión exige que el frame traiga el acuse (`ack`) del aviso VIGENTE, cosa que un frame que ya
 * iba por el cable no puede traer.
 *
 * NO HAY NINGÚN NÚMERO DE ESPERA ESCRITO A MANO en el cliente: la ventana la publica el servidor
 * (`welcome.limits.rateRetryMs`) y la repite en cada 429, y todos los caminos (ops, presencia,
 * resync, reconexión y el freno tras un 5xx) derivan de ella. Los 1000 ms fijos que vivían aquí
 * funcionaban contra los 900 del servidor POR CASUALIDAD.
 */

/**
 * Margen SOBRE la ventana del servidor. No es una espera alternativa: es lo que hace verdadera la
 * frase «el cliente siempre espera algo más que el servidor», que es la condición que evita el
 * strike. Cubre además la granularidad de los temporizadores del navegador.
 */
const MARGEN_MS = 100;

/**
 * Techo. Un servidor mal configurado —o una respuesta manipulada por un intermediario— no puede
 * dejar el editor parado indefinidamente pidiendo una espera absurda.
 */
const TECHO_MS = 30_000;

/**
 * Unidad de espera CUANDO EL SERVIDOR TODAVÍA NO HA DICHO NADA. No es «la espera del 429»: ésa la
 * dice siempre el servidor. Ésta solo se usa en dos casos en los que no hay ninguna cifra suya que
 * derivar — reconectar antes del primer `welcome` (arranque en frío contra un servidor caído) y un
 * 429 de un intermediario, que no lleva instrucción — y por eso no duplica ningún número del
 * servidor: no hay ninguno que duplicar todavía.
 */
const SIN_NOTICIAS_MS = 1000;

export interface RateGateTimers {
  later: (ms: number, fn: () => void) => unknown;
  clear: (handle: unknown) => void;
}

/** Lo que un 429 trae del servidor. Ambos campos son opcionales: un proxy puede no ponerlos. */
export interface RateRefusal {
  retryAfterMs?: unknown;
  rateNotice?: unknown;
}

export class RateGate {
  /** Ventana publicada por el servidor en el `welcome`. Única fuente de la espera. */
  private ventanaMs = 0;
  /** Último número de aviso VISTO. Es lo que se devuelve al servidor en cada frame. */
  private visto = 0;
  /** Último número de aviso ya convertido en espera: un 429 en vuelo no la alarga dos veces. */
  private aplicado = 0;
  private freno: unknown = null;
  private esperando: (() => void)[] = [];

  constructor(private readonly timers: RateGateTimers) {}

  /**
   * Un `welcome`: sesión NUEVA. Adopta la ventana (un valor no utilizable se ignora y se conserva la
   * anterior) y REINICIA la numeración de avisos.
   *
   * Lo segundo no es higiene, es corrección: los avisos los numera la CONEXIÓN del servidor y una
   * reconexión empieza por el 1. Conservando el número viejo, el primer 429 tras reconectar traería
   * un aviso «anterior» al último aplicado y el freno se lo saltaría por creerlo un duplicado en
   * vuelo — justo la clase de fallo que este módulo existe para cerrar. Al reiniciar, el error solo
   * puede caer del lado de esperar de más.
   */
  publica(rateRetryMs: unknown): void {
    const n = Number(rateRetryMs);
    if (Number.isFinite(n) && n > 0) this.ventanaMs = n;
    this.visto = 0;
    this.aplicado = 0;
  }

  /**
   * Un 429. Fija la espera y anota el aviso para devolverlo.
   *
   * Un aviso YA aplicado no vuelve a frenar: dos frames en vuelo pueden traer el mismo rechazo, y
   * reiniciar el freno con cada copia alargaría la espera sin motivo. Uno NUEVO sí lo reinicia
   * —es una instrucción posterior— y por eso el freno se rearma en vez de acumularse.
   */
  rechazado(body: RateRefusal | null | undefined): void {
    const aviso = Number(body?.rateNotice);
    if (Number.isFinite(aviso) && aviso > 0) {
      if (aviso > this.visto) this.visto = aviso;
      if (aviso <= this.aplicado) return;
      this.aplicado = aviso;
    }
    this.frena(this.derivaEspera(body?.retryAfterMs));
  }

  /**
   * Freno que NO viene de un 429 (un 5xx, la red caída). Misma espera y mismo temporizador: hay una
   * sola cola de salida, así que hay un solo freno. No toca el acuse: no hay ninguna instrucción del
   * servidor que reconocer, y declarar una que no existe sería autoinculparse.
   */
  frenaPorFallo(): void {
    this.frena(this.espera());
  }

  /** Espera derivada de la ventana del servidor. Para quien necesite el NÚMERO (la reconexión). */
  espera(): number {
    return this.derivaEspera(undefined);
  }

  /** Techo de cualquier espera de este cliente. La reconexión lo comparte a propósito. */
  get techo(): number {
    return TECHO_MS;
  }

  /** El número de aviso que hay que devolverle al servidor en CADA frame. */
  get ack(): number {
    return this.visto;
  }

  get frenado(): boolean {
    return this.freno !== null;
  }

  /**
   * `undefined` si se puede enviar YA — el camino normal no paga ni un microtask, que es lo que
   * permite que los tests deterministas sigan midiendo lo que miden. Si hay espera en vigor,
   * devuelve la promesa que se resuelve cuando termina.
   */
  ready(): Promise<void> | undefined {
    if (this.freno === null) return undefined;
    return new Promise<void>((resolve) => this.esperando.push(resolve));
  }

  /** Re-programa `fn` para cuando el freno se suelte (o ya, si no hay freno). */
  alSoltarse(fn: () => void): void {
    if (this.freno === null) { fn(); return; }
    this.esperando.push(fn);
  }

  /** La sesión se para: ni freno colgando ni nadie esperando a un temporizador que ya no vendrá. */
  reset(): void {
    if (this.freno !== null) this.timers.clear(this.freno);
    this.freno = null;
    const pendientes = this.esperando;
    this.esperando = [];
    for (const fn of pendientes) fn();
  }

  private derivaEspera(dicha: unknown): number {
    const n = Number(dicha);
    const base = Number.isFinite(n) && n > 0 ? n : (this.ventanaMs > 0 ? this.ventanaMs : SIN_NOTICIAS_MS);
    return Math.min(base + MARGEN_MS, TECHO_MS);
  }

  private frena(ms: number): void {
    if (this.freno !== null) this.timers.clear(this.freno);
    this.freno = this.timers.later(ms, () => {
      this.freno = null;
      const pendientes = this.esperando;
      this.esperando = [];
      for (const fn of pendientes) fn();
    });
  }
}

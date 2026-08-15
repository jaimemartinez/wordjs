/**
 * Planificador de frames con BACKSTOP de visibilidad.
 *
 * `requestAnimationFrame` NO dispara en pestañas/panes ocultos (el navegador lo
 * congela por throttling), lo que dejaría al overlay sin medir y al driver DnD
 * sin flush hasta volver a ser visibles. Este scheduler corre rAF y un
 * setTimeout de backstop a la vez y CANCELA al perdedor — nunca dejar vivo el
 * timer perdedor de una carrera (lección del proyecto: el flake de CI por el
 * setTimeout filtrado de un Promise.race).
 *
 * En primer plano el rAF gana siempre (≤16ms < 100ms) y el comportamiento es
 * idéntico a rAF puro; oculto, el backstop mantiene el sistema vivo a 10fps.
 */

const FRAME_BACKSTOP_MS = 100;

interface FrameHandle {
  raf: number | null;
  timer: ReturnType<typeof setTimeout>;
}

let nextHandle = 1;
const handles = new Map<number, FrameHandle>();

const clearHandle = (id: number): FrameHandle | undefined => {
  const h = handles.get(id);
  if (!h) return undefined;
  handles.delete(id);
  if (h.raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(h.raf);
  clearTimeout(h.timer);
  return h;
};

/** Programa `cb` para el próximo frame (o el backstop, lo que llegue antes). */
export function scheduleFrame(cb: () => void): number {
  const id = nextHandle++;
  const fire = () => {
    if (!handles.has(id)) return;
    clearHandle(id);
    cb();
  };
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(fire) : null;
  const timer = setTimeout(fire, raf === null ? 16 : FRAME_BACKSTOP_MS);
  handles.set(id, { raf, timer });
  return id;
}

/** Cancela un frame programado (ambas patas, gane quien gane). */
export function cancelFrame(id: number): void {
  clearHandle(id);
}

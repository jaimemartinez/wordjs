/**
 * Verso — modelo del panel de interacciones (F9-D).
 *
 * Aquí vive la prueba de las dos reglas del panel, porque son las dos que, si se rompen, rompen algo
 * que no se ve hasta producción:
 *
 *  · **Nada llega al documento sin normalizar.** Cada escritor devuelve un `IxSpec` que
 *    `normalizeIxSpec` acepta, o `undefined`. Se comprueba compilando la salida: si el panel pudiera
 *    escribir algo que el compilador rechaza, el bloque se guardaría "con interacción" y no se
 *    movería nunca.
 *  · **Un preajuste no se bifurca en silencio.** Un bloque enlazado guarda un ID y, como mucho, su
 *    propio disparador. Nunca `tracks` junto a `preset` — eso rompería la propagación, que es el
 *    motivo entero de que los presets se guarden por referencia.
 */
import { describe, expect, it } from "vitest";
import {
  compileIx,
  ixCtxFromSite,
  normalizeIxSpec,
  parseSiteIxPresets,
  IX_MAX_STEPS,
  IX_POINTER_SMOOTH_MAX,
  SYS_IX_PRESETS,
  type IxCompileCtx,
} from "@/lib/verso/interactions";
import {
  addStep,
  addTrack,
  availableProps,
  removeTrack,
  clearIx,
  defaultIxSpec,
  effectiveRange,
  ixPanelState,
  ixPresetChoice,
  ixPresetOptions,
  rangeEditable,
  removeStep,
  resetRange,
  setAlternate,
  setBreakpointOff,
  setClickToggle,
  setClipDir,
  setDelay,
  setDuration,
  setEventName,
  setEventToggle,
  setIntensity,
  setLoadDelay,
  setOrigin,
  setPersp,
  setStaggerCols,
  setStaggerFrom,
  setStaggerTotal,
  setPresetChoice,
  setRangeEdge,
  setRepeat,
  setScrubSmooth,
  setScrubSrc,
  setStagger,
  setStepAt,
  setStepBez,
  setStepEase,
  setStepProp,
  setTargetKind,
  setTriggerKind,
  setViewOnce,
  unlinkPreset,
  usedProps,
  IX_PANEL_CUSTOM,
  IX_PANEL_NONE,
} from "../ixPanelModel";
import { IX_DEFAULT_RANGES } from "@/lib/verso/interactions";

const SITE = JSON.stringify([
  {
    id: "aparecer-tarjetas",
    name: "Aparecer tarjetas",
    trigger: { on: "view", once: true },
    tracks: [
      {
        target: { kind: "children" },
        steps: [
          { at: 0, set: { opacity: 0, y: 20 }, ease: "out" },
          { at: 100, set: { opacity: 1, y: 0 } },
        ],
        stagger: { each: 80 },
      },
    ],
    rev: 3,
  },
]);

const CTX: IxCompileCtx = ixCtxFromSite(parseSiteIxPresets(SITE));

/** Lo que el panel escribiría: normalizado y, si no es `undefined`, COMPILABLE. */
function assertWritable(value: unknown, ctx: IxCompileCtx = CTX): void {
  if (value === undefined) return;
  expect(normalizeIxSpec(value), "el panel escribió algo que el normalizador rechaza").not.toBeNull();
  expect(compileIx(value, ctx), "el panel escribió algo que el compilador no emite").not.toBeNull();
}

/* ------------------------------------------------------------------ */
/* Lectura                                                             */
/* ------------------------------------------------------------------ */

describe("ixPanelState — leer lo que el bloque tiene", () => {
  it("sin `ix`: inactivo y con un resumen que lo dice", () => {
    const s = ixPanelState(undefined, CTX);
    expect(s.active).toBe(false);
    expect(s.spec).toBeNull();
    expect(s.tracks).toEqual([]);
    expect(s.summary).toBe("Sin interacción.");
    expect(ixPresetChoice(s)).toBe(IX_PANEL_NONE);
  });

  it("enlazado a un preajuste: pistas y disparador salen del PRESET, no del bloque", () => {
    const s = ixPanelState({ v: 1, preset: "aparecer-tarjetas" }, CTX);
    expect(s.active).toBe(true);
    expect(s.presetId).toBe("aparecer-tarjetas");
    expect(s.presetOk).toBe(true);
    expect(s.custom).toBe(false);
    expect(s.tracks[0].target.kind).toBe("children");
    expect(s.tracks[0].stagger?.each).toBe(80);
    expect(ixPresetChoice(s)).toBe("aparecer-tarjetas");
    expect(s.summary).toContain("Aparecer tarjetas");
  });

  it("referencia ROTA: no está activo, pero el panel lo dice en un aviso (no en silencio)", () => {
    const s = ixPanelState({ v: 1, preset: "borrado" }, CTX);
    expect(s.active).toBe(false);
    expect(s.presetId).toBe("borrado");
    expect(s.presetOk).toBe(false);
    expect(s.warnings.join(" ")).toContain("borrado");
    expect(s.summary).toContain("no encontrado");
  });

  it("cuerpo propio: editable, y el resumen nombra disparador, objetivo y pasos", () => {
    const s = ixPanelState(defaultIxSpec(), CTX);
    expect(s.custom).toBe(true);
    expect(ixPresetChoice(s)).toBe(IX_PANEL_CUSTOM);
    expect(s.summary).toContain("al entrar en pantalla");
    expect(s.summary).toContain("este bloque");
    expect(s.summary).toContain("2 pasos");
  });

  it("un `ix` hostil no rompe el panel: se lee como 'sin interacción'", () => {
    for (const bad of [null, 42, "x", { v: 9 }, { v: 1 }, { v: 1, tracks: "no" }]) {
      expect(() => ixPanelState(bad, CTX)).not.toThrow();
      expect(ixPanelState(bad, CTX).active).toBe(false);
    }
  });
});

describe("ixPresetOptions — el desplegable del nivel 1", () => {
  it("Ninguna primero, sistema, sitio, y Personalizada al final", () => {
    const opts = ixPresetOptions(CTX);
    expect(opts[0]).toEqual({ value: IX_PANEL_NONE, label: "Ninguna" });
    expect(opts[opts.length - 1].value).toBe(IX_PANEL_CUSTOM);
    const values = opts.map((o) => o.value);
    const firstSite = values.indexOf("aparecer-tarjetas");
    const lastSys = values.lastIndexOf("sys:zoom");
    expect(firstSite).toBeGreaterThan(lastSys);
    expect(values).toContain("sys:fade-up");
  });

  it("dentro de cada grupo, por NOMBRE — que es lo que el autor lee, no el id", () => {
    const sys = ixPresetOptions(CTX).filter((o) => o.value.startsWith("sys:"));
    const labels = sys.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "es")));
    // Y no por id: por id, "sys:blur" (Desenfocar) iría primero.
    expect(labels[0]).not.toBe("Desenfocar");
  });

  it("orden estable entre llamadas (no depende del orden de claves del ajuste)", () => {
    const a = ixPresetOptions(ixCtxFromSite(parseSiteIxPresets(SITE))).map((o) => o.value);
    const b = ixPresetOptions(ixCtxFromSite(parseSiteIxPresets(SITE))).map((o) => o.value);
    expect(a).toEqual(b);
  });

  it("sin contexto: solo los dos sentinels (nunca un desplegable vacío)", () => {
    expect(ixPresetOptions(undefined).map((o) => o.value)).toEqual([
      IX_PANEL_NONE,
      IX_PANEL_CUSTOM,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Nivel 1 — preajuste                                                 */
/* ------------------------------------------------------------------ */

describe("setPresetChoice", () => {
  it("«Ninguna» quita la prop entera (el bloque vuelve a sus bytes de origen)", () => {
    expect(setPresetChoice({ v: 1, preset: "sys:fade-up" }, IX_PANEL_NONE, CTX)).toBeUndefined();
  });

  it("elegir un preajuste guarda SOLO el id — jamás una copia del cuerpo", () => {
    const out = setPresetChoice(undefined, "aparecer-tarjetas", CTX);
    expect(out).toEqual({ v: 1, preset: "aparecer-tarjetas" });
    expect((out as Record<string, unknown>).tracks).toBeUndefined();
    assertWritable(out);
  });

  it("cambiar de preajuste no arrastra el disparador del anterior", () => {
    const withTrigger = setTriggerKind({ v: 1, preset: "sys:fade-up" }, "click", CTX);
    expect((withTrigger as { trigger?: unknown }).trigger).toEqual({ on: "click" });
    const swapped = setPresetChoice(withTrigger, "aparecer-tarjetas", CTX);
    expect(swapped).toEqual({ v: 1, preset: "aparecer-tarjetas" });
  });

  it("«Personalizada» desde vacío arranca con la entrada de siempre", () => {
    const out = setPresetChoice(undefined, IX_PANEL_CUSTOM, CTX) as Record<string, unknown>;
    expect(out.preset).toBeUndefined();
    expect(Array.isArray(out.tracks)).toBe(true);
    assertWritable(out);
  });

  it("«Personalizada» desde un preajuste COPIA su cuerpo y suelta la referencia", () => {
    const out = setPresetChoice({ v: 1, preset: "aparecer-tarjetas" }, IX_PANEL_CUSTOM, CTX) as {
      preset?: string;
      tracks?: { target: { kind: string }; stagger?: { each: number } }[];
    };
    expect(out.preset).toBeUndefined();
    expect(out.tracks?.[0].target.kind).toBe("children");
    expect(out.tracks?.[0].stagger?.each).toBe(80);
    assertWritable(out);
  });
});

describe("unlinkPreset", () => {
  it("copia el cuerpo resuelto y borra la referencia; el resultado ya no propaga", () => {
    const out = unlinkPreset({ v: 1, preset: "aparecer-tarjetas" }, CTX);
    const state = ixPanelState(out, CTX);
    expect(state.presetId).toBeNull();
    expect(state.custom).toBe(true);
    expect(state.tracks[0].target.kind).toBe("children");
    assertWritable(out);
  });

  it("sobre una referencia rota no inventa un cuerpo: quita la interacción", () => {
    expect(unlinkPreset({ v: 1, preset: "borrado" }, CTX)).toBeUndefined();
  });
});

it("clearIx quita la prop", () => {
  expect(clearIx()).toBeUndefined();
});

/* ------------------------------------------------------------------ */
/* Nivel 2 — disparador                                                */
/* ------------------------------------------------------------------ */

describe("disparador", () => {
  it("con un preajuste puesto, el disparador es el ÚNICO override local (nunca `tracks`)", () => {
    const out = setTriggerKind({ v: 1, preset: "aparecer-tarjetas" }, "hover", CTX) as Record<
      string,
      unknown
    >;
    expect(out.preset).toBe("aparecer-tarjetas");
    expect(out.trigger).toEqual({ on: "hover" });
    expect(out.tracks).toBeUndefined();
    assertWritable(out);
  });

  it("con cuerpo propio, cambia el disparador y conserva las pistas", () => {
    const base = defaultIxSpec();
    const out = setTriggerKind(base, "scrub", CTX) as { trigger: unknown; tracks: unknown[] };
    expect(out.trigger).toEqual({ on: "scrub" });
    expect(out.tracks).toHaveLength(1);
    assertWritable(out);
  });

  it("`view` conserva su modo de repetición al volver a elegirlo", () => {
    const once = setViewOnce(defaultIxSpec(), false, CTX);
    expect(ixPanelState(once, CTX).trigger).toEqual({ on: "view", once: false });
    const round = setTriggerKind(setTriggerKind(once, "click", CTX), "view", CTX);
    // Al pasar por `click` se pierde el modo (el dato ya no lo lleva): vuelve al defecto seguro.
    expect(ixPanelState(round, CTX).trigger).toEqual({ on: "view", once: true });
  });

  it("`once:false` es el camino de CSS puro; `once:true`, el que necesita runtime", () => {
    const cada = compileIx(setViewOnce(defaultIxSpec(), false, CTX), CTX);
    const unaVez = compileIx(setViewOnce(defaultIxSpec(), true, CTX), CTX);
    expect(cada?.needsRuntime).toBe("no-native");
    expect(unaVez?.needsRuntime).toBe("always");
  });

  it("setViewOnce sobre un disparador que no es `view` no cambia nada", () => {
    const hover = setTriggerKind(defaultIxSpec(), "hover", CTX);
    expect(setViewOnce(hover, false, CTX)).toEqual(normalizeIxSpec(hover)?.spec);
  });
});

describe("objetivo, escalonado y tiempos", () => {
  it("cambiar el objetivo a `children` habilita el escalonado", () => {
    const out = setStagger(setTargetKind(defaultIxSpec(), "children", CTX), 120, CTX);
    const state = ixPanelState(out, CTX);
    expect(state.tracks[0].target.kind).toBe("children");
    expect(state.tracks[0].stagger?.each).toBe(120);
    assertWritable(out);
  });

  it("escalonado 0 QUITA la clave (y no deja un `{each:0}` inerte en el dato)", () => {
    const conStagger = setStagger(setTargetKind(defaultIxSpec(), "children", CTX), 120, CTX);
    const sin = setStagger(conStagger, 0, CTX) as { tracks: { stagger?: unknown }[] };
    expect(sin.tracks[0].stagger).toBeUndefined();
  });

  it("duración y retardo se CLAMPAN en la escritura, no solo al pintar", () => {
    const largo = setDuration(defaultIxSpec(), 999_999, CTX) as { tracks: { dur: number }[] };
    expect(largo.tracks[0].dur).toBe(3000);
    const corto = setDuration(defaultIxSpec(), 1, CTX) as { tracks: { dur: number }[] };
    expect(corto.tracks[0].dur).toBe(100);
    const retardo = setDelay(defaultIxSpec(), -50, CTX) as { tracks: { delay: number }[] };
    expect(retardo.tracks[0].delay).toBe(0);
  });

  it("un valor no numérico no corrompe el dato", () => {
    const out = setDuration(defaultIxSpec(), Number.NaN, CTX) as { tracks: { dur: number }[] };
    expect(out.tracks[0].dur).toBe(600);
    assertWritable(out);
  });
});

/* ------------------------------------------------------------------ */
/* Nivel 3 — pasos                                                     */
/* ------------------------------------------------------------------ */

describe("pasos", () => {
  it("añadir un paso lo mete ANTES del último: el fotograma final no se mueve", () => {
    const out = addStep(defaultIxSpec(), CTX) as { tracks: { steps: { at: number }[] }[] };
    const ats = out.tracks[0].steps.map((s) => s.at);
    expect(ats).toHaveLength(3);
    expect(ats[0]).toBe(0);
    expect(ats[ats.length - 1]).toBe(100);
    assertWritable(out);
  });

  it("el tope de pasos AVISA pero nunca rompe: al llegar a IX_MAX_STEPS deja de añadir", () => {
    let spec: unknown = defaultIxSpec();
    for (let i = 0; i < IX_MAX_STEPS + 4; i++) spec = addStep(spec, CTX);
    const state = ixPanelState(spec, CTX);
    expect(state.tracks[0].steps.length).toBeLessThanOrEqual(IX_MAX_STEPS);
    expect(state.active).toBe(true);
    assertWritable(spec);
  });

  it("los extremos no se quitan: una pista de un paso no interpola nada", () => {
    const tres = addStep(defaultIxSpec(), CTX);
    expect(ixPanelState(removeStep(tres, 0, CTX), CTX).tracks[0].steps).toHaveLength(3);
    expect(ixPanelState(removeStep(tres, 2, CTX), CTX).tracks[0].steps).toHaveLength(3);
    expect(ixPanelState(removeStep(tres, 1, CTX), CTX).tracks[0].steps).toHaveLength(2);
  });

  it("el momento de un paso intermedio se guarda; el de los extremos lo reancla el normalizador", () => {
    const tres = addStep(defaultIxSpec(), CTX);
    const movido = setStepAt(tres, 1, 30, CTX);
    expect(ixPanelState(movido, CTX).tracks[0].steps[1].at).toBe(30);
    const forzado = setStepAt(tres, 0, 40, CTX);
    expect(ixPanelState(forzado, CTX).tracks[0].steps[0].at).toBe(0);
  });

  it("el `at` intermedio queda ACOTADO entre vecinos: alcanzarlos deduplicaría y BORRARÍA el vecino", () => {
    // El normalizador ordena por `at` y deduplica iguales quedándose con el primero: sin esta cota,
    // arrastrar el 30 hasta el 60 borraba del documento el paso del 60 CON sus props y su curva.
    const spec = {
      v: 1,
      trigger: { on: "load" },
      tracks: [{
        target: { kind: "self" },
        steps: [
          { at: 0, set: { x: 0 } },
          { at: 30, set: { x: 10 }, ease: "spring" },
          { at: 60, set: { x: 20 } },
          { at: 100, set: { x: 30 } },
        ],
      }],
    };
    const arriba = ixPanelState(setStepAt(spec, 1, 60, CTX), CTX).tracks[0];
    expect(arriba.steps.map((s) => s.at)).toEqual([0, 59, 60, 100]);
    expect(arriba.steps[2].set.x).toBe(20); // el vecino SOBREVIVE, con sus props
    // Hacia abajo el ancla 0 también acota; y saltar por encima de todo no reordena nada.
    expect(ixPanelState(setStepAt(spec, 1, 0, CTX), CTX).tracks[0].steps.map((s) => s.at))
      .toEqual([0, 1, 60, 100]);
    expect(ixPanelState(setStepAt(spec, 2, 999, CTX), CTX).tracks[0].steps.map((s) => s.at))
      .toEqual([0, 30, 99, 100]);
  });

  it("cambiar el src del scrub, editar su rango o resetearlo CONSERVA el suavizado (P10)", () => {
    const base = setScrubSmooth(setTriggerKind(defaultIxSpec(), "scrub", CTX)!, 300, CTX)!;
    const src = setScrubSrc(base, "page", CTX)!;
    expect(src.trigger).toMatchObject({ on: "scrub", src: "page", smooth: 300 });
    const edged = setRangeEdge(src, "from", { pct: 20 }, CTX)!;
    expect(edged.trigger).toMatchObject({ on: "scrub", src: "page", smooth: 300 });
    const reset = resetRange(edged, CTX)!;
    expect(reset.trigger).toMatchObject({ on: "scrub", src: "page", smooth: 300 });
    expect("range" in (reset.trigger as object)).toBe(false);
  });

  it("la curva se guarda por paso", () => {
    const out = setStepEase(defaultIxSpec(), 0, "spring", CTX);
    expect(ixPanelState(out, CTX).tracks[0].steps[0].ease).toBe("spring");
    assertWritable(out);
  });

  it("poner y quitar una propiedad de UN paso", () => {
    const conEscala = setStepProp(defaultIxSpec(), 0, "scale", 0.8, CTX);
    expect(ixPanelState(conEscala, CTX).tracks[0].steps[0].set.scale).toBe(0.8);
    const sinEscala = setStepProp(conEscala, 0, "scale", undefined, CTX);
    expect(ixPanelState(sinEscala, CTX).tracks[0].steps[0].set.scale).toBeUndefined();
  });

  it("un valor fuera de rango se CLAMPA (un blur de 1e9 tumba el compositor, no 'se ve feo')", () => {
    const out = setStepProp(defaultIxSpec(), 0, "blur", 1e9, CTX);
    expect(ixPanelState(out, CTX).tracks[0].steps[0].set.blur).toBe(100);
    assertWritable(out);
  });

  it("vaciar la última propiedad de todos los pasos QUITA la interacción (nunca queda a medias)", () => {
    let spec: unknown = defaultIxSpec();
    for (const key of ["opacity", "y"] as const) {
      spec = setStepProp(spec, 0, key, undefined, CTX);
      spec = setStepProp(spec, 1, key, undefined, CTX);
    }
    expect(spec).toBeUndefined();
  });

  it("availableProps / usedProps salen en el ORDEN CANÓNICO, no en el de inserción", () => {
    const step = { at: 0, set: { y: 10, opacity: 0 } };
    expect(usedProps(step)).toEqual(["opacity", "y"]);
    expect(availableProps(step)[0]).toBe("x");
    expect(availableProps(step)).not.toContain("opacity");
  });

  it("editar un paso estando enlazado a un preajuste DESVINCULA (nunca `preset` + `tracks`)", () => {
    const out = setStepProp({ v: 1, preset: "aparecer-tarjetas" }, 0, "scale", 0.5, CTX) as Record<
      string,
      unknown
    >;
    expect(out.preset).toBeUndefined();
    expect(Array.isArray(out.tracks)).toBe(true);
    assertWritable(out);
  });
});

/* ------------------------------------------------------------------ */
/* La invariante: lo que el panel escribe, el compilador lo emite      */
/* ------------------------------------------------------------------ */

describe("opciones del disparador y de la pista (P1: lo que el modelo sabía y el panel no ofrecía)", () => {
  it("setClickToggle conmuta el flag, y quitarlo devuelve el disparador desnudo", () => {
    const base = setTriggerKind(defaultIxSpec(), "click", CTX)!;
    const on = setClickToggle(base, true, CTX)!;
    expect(on.trigger).toEqual({ on: "click", toggle: true });
    const off = setClickToggle(on, false, CTX)!;
    expect(off.trigger).toEqual({ on: "click" });
    assertWritable(on);
    assertWritable(off);
  });

  it("setClickToggle sobre un disparador que NO es click no toca nada", () => {
    const spec = defaultIxSpec();
    expect(setClickToggle(spec, true, CTX)).toEqual(normalizeIxSpec(spec)?.spec);
  });

  it("setLoadDelay escribe el retardo del disparador, y 0 borra la clave", () => {
    const base = setTriggerKind(defaultIxSpec(), "load", CTX)!;
    const delayed = setLoadDelay(base, 500, CTX)!;
    expect(delayed.trigger).toEqual({ on: "load", delay: 500 });
    const back = setLoadDelay(delayed, 0, CTX)!;
    expect(back.trigger).toEqual({ on: "load" });
    assertWritable(delayed);
  });

  it("setScrubSrc alterna bloque/página CONSERVANDO el rango del autor", () => {
    const base = setTriggerKind(defaultIxSpec(), "scrub", CTX)!;
    const ranged = setRangeEdge(base, "from", { pct: 20 }, CTX)!;
    const paged = setScrubSrc(ranged, "page", CTX)!;
    expect(paged.trigger).toMatchObject({ on: "scrub", src: "page" });
    expect((paged.trigger as { range?: unknown }).range).toMatchObject({ from: { pct: 20 } });
    const back = setScrubSrc(paged, "self", CTX)!;
    expect((back.trigger as { src?: string }).src).toBeUndefined();
    assertWritable(paged);
  });

  it("setRepeat: 1 BORRA la clave (bytes de origen), 'inf' escribe el token, y se clampa", () => {
    const spec = defaultIxSpec();
    const three = setRepeat(spec, 3, CTX)!;
    expect(three.tracks![0].repeat).toBe(3);
    const one = setRepeat(three, 1, CTX)!;
    expect("repeat" in one.tracks![0]).toBe(false);
    expect(setRepeat(spec, "inf", CTX)!.tracks![0].repeat).toBe("inf");
    expect(setRepeat(spec, 9999, CTX)!.tracks![0].repeat).toBe(50);
    assertWritable(three);
  });

  it("setAlternate escribe `alt: true` y false borra la clave", () => {
    const spec = defaultIxSpec();
    const alt = setAlternate(spec, true, CTX)!;
    expect(alt.tracks![0].alt).toBe(true);
    const back = setAlternate(alt, false, CTX)!;
    expect("alt" in back.tracks![0]).toBe(false);
  });

  it("el rango solo es editable donde el scroll manda: scrub y view+cada-vez", () => {
    expect(rangeEditable({ on: "scrub" })).toBe(true);
    expect(rangeEditable({ on: "view", once: false })).toBe(true);
    expect(rangeEditable({ on: "view", once: true })).toBe(false);
    expect(rangeEditable({ on: "click" })).toBe(false);
    expect(rangeEditable({ on: "load" })).toBe(false);
  });

  it("effectiveRange devuelve una COPIA: mutarla no toca el defecto del compilador", () => {
    const r = effectiveRange({ on: "scrub" });
    r.from.pct = 99;
    expect(IX_DEFAULT_RANGES.scrub.from.pct).toBe(0);
  });

  it("setRangeEdge parte del defecto del disparador y edita solo el borde pedido", () => {
    const base = setTriggerKind(defaultIxSpec(), "scrub", CTX)!;
    const w = setRangeEdge(base, "to", { at: "exit", pct: 60 }, CTX)!;
    expect((w.trigger as { range?: unknown }).range).toEqual({
      from: { at: "cover", pct: 0 },
      to: { at: "exit", pct: 60 },
    });
    assertWritable(w);
  });

  it("resetRange borra el rango del autor: la ausencia ES el defecto", () => {
    const base = setTriggerKind(defaultIxSpec(), "scrub", CTX)!;
    const ranged = setRangeEdge(base, "from", { pct: 30 }, CTX)!;
    const reset = resetRange(ranged, CTX)!;
    expect("range" in (reset.trigger as object)).toBe(false);
  });

  it("sobre un bloque enlazado a un preajuste, TODAS las opciones de disparador conservan el enlace", () => {
    const linked = { v: 1, preset: "aparecer-tarjetas" };
    const click = setTriggerKind(linked, "click", CTX)!;
    expect(click.preset).toBe("aparecer-tarjetas");
    const toggled = setClickToggle(click, true, CTX)!;
    expect(toggled.preset).toBe("aparecer-tarjetas");
    expect(toggled.tracks).toBeUndefined();
    const scrub = setTriggerKind(linked, "scrub", CTX)!;
    const ranged = setRangeEdge(scrub, "from", { pct: 10 }, CTX)!;
    expect(ranged.preset).toBe("aparecer-tarjetas");
    expect(ranged.tracks).toBeUndefined();
  });

  it("setStepBez escribe la curva propia clampada, null la quita, y elegir nombre la retira", () => {
    const spec = defaultIxSpec();
    const w = setStepBez(spec, 0, [0.2, 9, 0.4, -9], CTX)!;
    expect(w.tracks![0].steps[0].bez).toEqual([0.2, 4, 0.4, -4]); // Y clampada a ±4 por el normalizador
    assertWritable(w);
    const cleared = setStepBez(w, 0, null, CTX)!;
    expect("bez" in cleared.tracks![0].steps[0]).toBe(false);
    const named = setStepEase(w, 0, "bounce", CTX)!;
    expect(named.tracks![0].steps[0].ease).toBe("bounce");
    expect("bez" in named.tracks![0].steps[0]).toBe(false);
  });

  it("setClipDir / setOrigin / setPersp escriben la opción y el DEFECTO borra la clave", () => {
    const spec = defaultIxSpec();
    const up = setClipDir(spec, "up", CTX)!;
    expect(up.tracks![0].clipDir).toBe("up");
    expect("clipDir" in setClipDir(up, "right", CTX)!.tracks![0]).toBe(false);
    const tl = setOrigin(spec, "top-left", CTX)!;
    expect(tl.tracks![0].origin).toBe("top-left");
    expect("origin" in setOrigin(tl, "center", CTX)!.tracks![0]).toBe(false);
    const p = setPersp(spec, 500, CTX)!;
    expect(p.tracks![0].persp).toBe(500);
    expect("persp" in setPersp(p, 1000, CTX)!.tracks![0]).toBe(false);
    assertWritable(up);
    assertWritable(tl);
    assertWritable(p);
  });

  it("escalonado P4: from/total/cols escriben sobre el stagger existente y el defecto borra", () => {
    const base = setTargetKind(defaultIxSpec(), "children", CTX)!;
    const st = setStagger(base, 80, CTX)!;
    const fromEnd = setStaggerFrom(st, "end", CTX)!;
    expect(fromEnd.tracks![0].stagger).toEqual({ each: 80, from: "end" });
    expect("from" in setStaggerFrom(fromEnd, "start", CTX)!.tracks![0].stagger!).toBe(false);
    const total = setStaggerTotal(st, true, CTX)!;
    expect(total.tracks![0].stagger!.total).toBe(true);
    const grid = setStaggerCols(st, 3, CTX)!;
    expect(grid.tracks![0].stagger!.cols).toBe(3);
    expect("cols" in setStaggerCols(grid, null, CTX)!.tracks![0].stagger!).toBe(false);
    // Sin escalonado, los tres son no-op.
    expect(setStaggerFrom(base, "end", CTX)!.tracks![0].stagger).toBeUndefined();
    assertWritable(fromEnd);
    assertWritable(grid);
  });

  it("setBreakpointOff conmuta dispositivos, conserva el enlace a preajuste y los TRES caen", () => {
    const linked = { v: 1, preset: "aparecer-tarjetas" };
    const offMobile = setBreakpointOff(linked, "mobile", true, CTX)!;
    expect(offMobile.preset).toBe("aparecer-tarjetas");
    expect(offMobile.off).toEqual(["mobile"]);
    const offBoth = setBreakpointOff(offMobile, "desktop", true, CTX)!;
    expect(offBoth.off).toEqual(["mobile", "desktop"]);
    const backOn = setBreakpointOff(offBoth, "mobile", false, CTX)!;
    expect(backOn.off).toEqual(["desktop"]);
    // Apagar los tres = quitar el gating (lo decide el normalizador, avisando).
    const all = setBreakpointOff(offBoth, "tablet", true, CTX)!; // mobile+desktop ya estaban
    expect(all.off).toBeUndefined();
    // Cuerpo propio: también funciona y es compilable.
    const own = setBreakpointOff(defaultIxSpec(), "mobile", true, CTX)!;
    expect(own.off).toEqual(["mobile"]);
    assertWritable(own);
  });

  it("setRepeat sobre un bloque enlazado DESVINCULA (es una edición del cuerpo)", () => {
    const linked = { v: 1, preset: "aparecer-tarjetas" };
    const w = setRepeat(linked, 3, CTX)!;
    expect(w.preset).toBeUndefined();
    expect(w.tracks![0].repeat).toBe(3);
    expect(w.tracks![0].stagger?.each).toBe(80); // el cuerpo copiado es el del preset
  });
});

describe("evento a medida (P11) y suavizado del scrub (P10)", () => {
  it("setTriggerKind('event') siembra un nombre válido y setEventName lo cambia", () => {
    const base = setTriggerKind(defaultIxSpec(), "event", CTX)!;
    expect(base.trigger).toEqual({ on: "event", name: "mi-evento" });
    const named = setEventName(base, "abrir-menu", CTX)!;
    expect(named.trigger).toEqual({ on: "event", name: "abrir-menu" });
    assertWritable(named);
  });

  it("setEventName con un slug inválido conserva el estado válido anterior", () => {
    const base = setTriggerKind(defaultIxSpec(), "event", CTX)!;
    for (const bad of ["", "Mayúsculas", "con espacio", "-empieza-mal", "acentós"]) {
      expect(setEventName(base, bad, CTX)).toEqual(normalizeIxSpec(base)?.spec);
    }
  });

  it("setEventToggle conmuta el flag y quitarlo devuelve el disparador desnudo", () => {
    const base = setTriggerKind(defaultIxSpec(), "event", CTX)!;
    const on = setEventToggle(base, true, CTX)!;
    expect(on.trigger).toEqual({ on: "event", name: "mi-evento", toggle: true });
    const off = setEventToggle(on, false, CTX)!;
    expect(off.trigger).toEqual({ on: "event", name: "mi-evento" });
    assertWritable(on);
  });

  it("setEventName conserva la conmutación puesta", () => {
    const base = setEventToggle(setTriggerKind(defaultIxSpec(), "event", CTX)!, true, CTX)!;
    const renamed = setEventName(base, "abrir", CTX)!;
    expect(renamed.trigger).toEqual({ on: "event", name: "abrir", toggle: true });
  });

  it("setScrubSmooth escribe los ms clampados, 0 borra la clave y conserva src y rango", () => {
    const base = setTriggerKind(defaultIxSpec(), "scrub", CTX)!;
    const paged = setScrubSrc(setRangeEdge(base, "from", { pct: 20 }, CTX)!, "page", CTX)!;
    const smooth = setScrubSmooth(paged, 250, CTX)!;
    expect(smooth.trigger).toMatchObject({ on: "scrub", smooth: 250, src: "page" });
    expect((smooth.trigger as { range?: unknown }).range).toMatchObject({ from: { pct: 20 } });
    const back = setScrubSmooth(smooth, 0, CTX)!;
    expect("smooth" in (back.trigger as object)).toBe(false);
    // Fuera de rango: clampa el normalizador, al mismo tope que el puntero.
    expect((setScrubSmooth(base, 99999, CTX)!.trigger as { smooth?: number }).smooth).toBe(
      IX_POINTER_SMOOTH_MAX,
    );
    assertWritable(smooth);
  });

  it("setEventName / setEventToggle / setScrubSmooth sobre OTRO disparador no tocan nada", () => {
    const spec = defaultIxSpec();
    expect(setEventName(spec, "abrir", CTX)).toEqual(normalizeIxSpec(spec)?.spec);
    expect(setEventToggle(spec, true, CTX)).toEqual(normalizeIxSpec(spec)?.spec);
    expect(setScrubSmooth(spec, 100, CTX)).toEqual(normalizeIxSpec(spec)?.spec);
  });
});

describe("intensidad (P7) y conservación de las claves de bloque", () => {
  it("setIntensity escribe amt clampado y 1 lo borra", () => {
    const spec = defaultIxSpec();
    const strong = setIntensity(spec, 2, CTX)!;
    expect(strong.amt).toBe(2);
    expect(setIntensity(strong, 99, CTX)!.amt).toBe(3); // clamp IX_AMT_MAX
    expect("amt" in setIntensity(strong, 1, CTX)!).toBe(false);
    assertWritable(strong);
  });

  it("off y amt SOBREVIVEN a cambiar el disparador y el preajuste: son del bloque", () => {
    const base = setIntensity(setBreakpointOff(defaultIxSpec(), "mobile", true, CTX)!, 2, CTX)!;
    expect(base.off).toEqual(["mobile"]);
    expect(base.amt).toBe(2);
    const t = setTriggerKind(base, "click", CTX)!;
    expect(t.off).toEqual(["mobile"]);
    expect(t.amt).toBe(2);
    const p = setPresetChoice(base, "aparecer-tarjetas", CTX)!;
    expect(p.preset).toBe("aparecer-tarjetas");
    expect(p.off).toEqual(["mobile"]);
    expect(p.amt).toBe(2);
    assertWritable(p);
  });
});

describe("pistas (P5): añadir, quitar y editar por índice", () => {
  it("addTrack añade una pista NEUTRA hasta el tope y removeTrack respeta el mínimo de 1", () => {
    const spec = defaultIxSpec();
    const two = addTrack(spec, CTX)!;
    expect(two.tracks).toHaveLength(2);
    // La pista nueva no mueve nada: nace neutra (opacidad 1→1) para no pisar a la primera.
    expect(two.tracks![1].steps.map((s) => s.set)).toEqual([{ opacity: 1 }, { opacity: 1 }]);
    const three = addTrack(two, CTX)!;
    expect(three.tracks).toHaveLength(3);
    expect(addTrack(three, CTX)!.tracks).toHaveLength(3); // tope IX_MAX_TRACKS
    const back = removeTrack(three, 1, CTX)!;
    expect(back.tracks).toHaveLength(2);
    expect(removeTrack(defaultIxSpec(), 0, CTX)!.tracks).toHaveLength(1); // la última no se quita
    assertWritable(two);
    assertWritable(three);
  });

  it("los escritores editan la pista PEDIDA y no tocan las demás", () => {
    const two = addTrack(defaultIxSpec(), CTX)!;
    const w = setTargetKind(two, "children", CTX, 1)!;
    expect(w.tracks![1].target.kind).toBe("children");
    expect(w.tracks![0].target.kind).toBe("self");
    const d = setDuration(w, 1200, CTX, 1)!;
    expect(d.tracks![1].dur).toBe(1200);
    expect(d.tracks![0].dur).toBe(600);
    const p = setStepProp(d, 0, "y", 40, CTX, 1)!;
    expect(p.tracks![1].steps[0].set.y).toBe(40);
    expect(p.tracks![0].steps[0].set.y).toBe(24);
    // Índice fuera de rango: no-op normalizado, jamás lanza.
    expect(setDuration(p, 900, CTX, 7)).toEqual(normalizeIxSpec(p)?.spec);
    assertWritable(p);
  });

  it("el gating `off` SOBREVIVE a añadir pistas y a editar pasos", () => {
    const gated = setBreakpointOff(defaultIxSpec(), "mobile", true, CTX)!;
    const withTrack = addTrack(gated, CTX)!;
    expect(withTrack.off).toEqual(["mobile"]);
    const edited = setStepProp(withTrack, 0, "y", 10, CTX, 1)!;
    expect(edited.off).toEqual(["mobile"]);
  });
});

describe("invariante de escritura", () => {
  it("una sesión larga de edición deja SIEMPRE un dato compilable", () => {
    let spec: unknown = setPresetChoice(undefined, IX_PANEL_CUSTOM, CTX);
    const ops: Array<(v: unknown) => unknown> = [
      (v) => setTriggerKind(v, "hover", CTX),
      (v) => setTargetKind(v, "children", CTX),
      (v) => setStagger(v, 90, CTX),
      (v) => addStep(v, CTX),
      (v) => setStepProp(v, 1, "rotate", 12, CTX),
      (v) => setStepEase(v, 1, "back", CTX),
      (v) => setStepAt(v, 1, 45, CTX),
      (v) => setDuration(v, 800, CTX),
      (v) => setDelay(v, 150, CTX),
      (v) => setTriggerKind(v, "scrub", CTX),
      (v) => setTriggerKind(v, "view", CTX),
    ];
    for (const op of ops) {
      spec = op(spec);
      assertWritable(spec);
    }
    expect(ixPanelState(spec, CTX).active).toBe(true);
  });

  it("el CSS que sale de una edición del panel SOLO toca propiedades de compositor", () => {
    let spec: unknown = setPresetChoice(undefined, IX_PANEL_CUSTOM, CTX);
    for (const key of ["scale", "rotate", "rotateX", "blur", "clip", "x"] as const) {
      spec = setStepProp(spec, 0, key, 10, CTX);
    }
    const unit = compileIx(spec, CTX)!;
    const css = [...unit.keyframes, ...unit.rules].join("\n");
    const props = [...css.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
    const allowed = new Set([
      "opacity",
      "transform",
      "filter",
      "clip-path",
      "animation",
      "animation-delay",
      "animation-timeline",
      "animation-range",
      "animation-timing-function",
      "transition",
      "transition-delay",
    ]);
    for (const p of props) expect(allowed.has(p), `propiedad inesperada en el CSS: ${p}`).toBe(true);
  });

  it("los preajustes de SISTEMA del desplegable compilan todos", () => {
    for (const id of Object.keys(SYS_IX_PRESETS)) {
      const out = setPresetChoice(undefined, id, CTX);
      expect(out).toEqual({ v: 1, preset: id });
      assertWritable(out);
    }
  });
});

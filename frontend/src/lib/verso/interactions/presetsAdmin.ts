/**
 * Verso — interacciones: EL CATÁLOGO DE PRESETS DEL SITIO, LADO ESCRITURA (F9-E).
 *
 * `sitePresets.ts` es la frontera de LECTURA (el ajuste crudo → catálogo normalizado). Esto es la de
 * ESCRITURA: catálogo + un borrador del formulario → catálogo nuevo, o un motivo legible por el que
 * no. Puro, sin React ni DOM: la pantalla de Ajustes es markup encima de estas funciones, y todo lo
 * que decide se puede probar en node.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LAS CUATRO REGLAS, Y POR QUÉ CADA UNA
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. **TODO pasa por `normalizeIxPreset`.** El ajuste es dato hostil aunque lo escriba un admin: el
 *    mismo valor puede llegar por la API, por una importación o por una restauración de copia. Que
 *    el formulario sea nuestro no lo convierte en dato de confianza — y si el normalizador rechaza
 *    lo que el formulario produce, el que está mal es el formulario, no el normalizador. Guardar sin
 *    pasar por él sería dejar en la opción cosas que el compilador luego descarta en silencio: el
 *    admin vería su preajuste en la lista y los bloques no se moverían.
 *
 * 2. **`sys:` es INTOCABLE.** Los preajustes del sistema viven en el código y son el catálogo por
 *    defecto de todo bloque nuevo. Si un preajuste de sitio pudiera llamarse `sys:fade-up`, un admin
 *    —o una importación— redefiniría en silencio lo que otros ya están usando. El id se valida
 *    contra el patrón SIN el prefijo, y además se comprueba explícitamente.
 *
 * 3. **`rev` sube en cada guardado, siempre.** `rev` entra en el hash del CSS: si no subiera, el
 *    navegador podría servir la hoja vieja y el admin creería que su edición no ha hecho nada.
 *    Sube incluso cuando el cuerpo no cambia — es más barato invalidar de más que de menos.
 *
 * 4. **El id de un preajuste existente NO se renombra.** Los bloques guardan ese id en `_puck_data`;
 *    cambiarlo dejaría huérfanas todas sus instancias sin tocar ni un documento, que es la peor
 *    forma de romper algo: invisible en el diff y visible en la página. Renombrar el NOMBRE sí, todas
 *    las veces que se quiera: el nombre es etiqueta, el id es identidad.
 */
import { normalizeIxPreset } from "./normalize";
import { IX_MAX_SITE_PRESETS } from "./sitePresets";
import type { IxPreset, IxSpec, IxTrack, IxTrigger } from "./types";

/** Catálogo indexado por id — la forma que devuelve `parseSiteIxPresets`. */
export type IxCatalog = Record<string, IxPreset>;

/** Prefijo RESERVADO al catálogo del código. */
export const IX_SYS_PREFIX = "sys:";

/**
 * Tope del nombre visible. No es una frontera de seguridad (el nombre no llega al CSS; React lo
 * escapa al pintarlo): es que el ajuste entero tiene un tope de bytes y 50 nombres de 4 KB se lo
 * comerían antes que los cuerpos, que es lo que de verdad importa guardar.
 */
export const IX_PRESET_NAME_MAX = 60;

/** El MISMO patrón que valida `normalizeIxPreset`, sin el prefijo del sistema. */
const SITE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Lo que el formulario tiene entre manos. `id` ausente = alta. */
export interface IxPresetDraft {
  /** Solo en edición. En un alta se deriva del nombre. */
  id?: string;
  name: string;
  trigger: IxTrigger;
  tracks: IxTrack[];
}

export type IxCatalogResult =
  | { ok: true; catalog: IxCatalog; id: string }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Ids                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Nombre visible → id candidato.
 *
 * Se descomponen los acentos y se tiran las marcas combinantes (NFD + `\p{M}`), así que «Aparecer
 * Tarjetas» y «Aparecer tarjetás» dan slugs legibles y no una ristra de guiones. El id resultante
 * puede estar vacío (un nombre entero en otro alfabeto) — de eso se encarga `ixFreePresetId`, que
 * siempre devuelve algo válido.
 */
export function ixPresetSlug(name: string): string {
  return String(name ?? "")
    .normalize("NFD")
    // `\p{M}` = cualquier marca combinante: los acentos que NFD acaba de separar.
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/**
 * Un id LIBRE derivado de un nombre. Si el slug ya existe (o no queda nada tras limpiarlo), se
 * sufija hasta encontrar hueco. Determinista: el mismo nombre en el mismo catálogo da el mismo id.
 */
export function ixFreePresetId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = ixPresetSlug(name) || "preajuste";
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, 64).replace(/-+$/g, "");
    if (!used.has(candidate)) return candidate;
  }
  // Inalcanzable con el tope de 50 preajustes; existe para que la función no pueda devolver `""`.
  return `${base}-x`.slice(0, 64);
}

/* ------------------------------------------------------------------ */
/* Alta y edición                                                      */
/* ------------------------------------------------------------------ */

/**
 * Guarda un borrador en el catálogo. Devuelve un catálogo NUEVO (nada se muta) o el motivo.
 *
 * El orden de las comprobaciones importa: primero lo que es imposible arreglar desde el formulario
 * (id reservado, tope alcanzado) y luego lo que el normalizador puede rechazar del cuerpo, para que
 * el mensaje diga siempre la causa más útil.
 */
export function ixPresetSave(catalog: IxCatalog, draft: IxPresetDraft): IxCatalogResult {
  const name = String(draft.name ?? "").trim().slice(0, IX_PRESET_NAME_MAX);
  if (name === "") return { ok: false, error: "El preajuste necesita un nombre." };

  const editing = typeof draft.id === "string" && draft.id !== "";
  const id = editing ? draft.id! : ixFreePresetId(name, Object.keys(catalog));

  if (id.startsWith(IX_SYS_PREFIX)) {
    return {
      ok: false,
      error: "El espacio de nombres «sys:» está reservado a los preajustes del sistema.",
    };
  }
  if (!SITE_ID_RE.test(id)) {
    return { ok: false, error: `«${id}» no es un identificador válido.` };
  }
  if (!editing && Object.keys(catalog).length >= IX_MAX_SITE_PRESETS) {
    return {
      ok: false,
      error: `Ya hay ${IX_MAX_SITE_PRESETS} preajustes, el máximo del sitio. Borra alguno para crear otro.`,
    };
  }

  const previous = catalog[id];
  // `rev` SIEMPRE sube: entra en el hash del CSS y es lo único que garantiza que el navegador no
  // pueda servir la hoja anterior de las páginas que ya usaban este preajuste.
  const rev = (previous?.rev ?? 0) + 1;

  const preset = normalizeIxPreset({ id, name, trigger: draft.trigger, tracks: draft.tracks, rev });
  if (!preset) {
    return {
      ok: false,
      error:
        "Este preajuste no anima nada: cada pista necesita al menos dos pasos y alguna propiedad que cambie.",
    };
  }

  return { ok: true, catalog: { ...catalog, [id]: preset }, id };
}

/** Borra un preajuste. Devuelve un catálogo NUEVO; borrar lo que no existe no es un error. */
export function ixPresetDelete(catalog: IxCatalog, id: string): IxCatalog {
  if (!Object.prototype.hasOwnProperty.call(catalog, id)) return catalog;
  const next = { ...catalog };
  delete next[id];
  return next;
}

/**
 * Duplica un preajuste con un nombre nuevo y un id nuevo. `rev` arranca de 0 (lo subirá el guardado
 * a 1): la copia es un preajuste distinto, no una revisión del original.
 */
export function ixPresetDuplicate(catalog: IxCatalog, id: string): IxCatalogResult {
  const source = catalog[id];
  if (!source) return { ok: false, error: "Ese preajuste ya no existe." };
  return ixPresetSave(catalog, {
    name: `${source.name} (copia)`.slice(0, IX_PRESET_NAME_MAX),
    trigger: source.trigger,
    tracks: source.tracks,
  });
}

/* ------------------------------------------------------------------ */
/* Puente con el panel del bloque                                      */
/* ------------------------------------------------------------------ */

/**
 * El cuerpo de un preajuste, visto como la prop `ix` de un bloque.
 *
 * Es lo que permite que la pantalla de Ajustes edite disparador, objetivo y pasos con EXACTAMENTE
 * los mismos escritores puros que el panel del bloque (`ixPanelModel.ts`), ya probados: un preajuste
 * es un cuerpo de interacción con nombre, y no hay razón para tener dos editores del mismo dato que
 * un día se comporten distinto.
 */
export function ixPresetToSpec(preset: { trigger: IxTrigger; tracks: IxTrack[] }): IxSpec {
  return { v: 1, trigger: preset.trigger, tracks: preset.tracks };
}

/** El camino de vuelta. `null` cuando el borrador se ha quedado sin nada que animar. */
export function ixSpecToBody(spec: unknown): { trigger: IxTrigger; tracks: IxTrack[] } | null {
  if (!spec || typeof spec !== "object") return null;
  const s = spec as IxSpec;
  if (!s.tracks || s.tracks.length === 0) return null;
  return { trigger: s.trigger ?? { on: "view", once: true }, tracks: s.tracks };
}

/* ------------------------------------------------------------------ */
/* Recuento de usos (R6 de la spec)                                    */
/* ------------------------------------------------------------------ */

/**
 * Cuántos bloques de un `_puck_data` referencian cada preajuste.
 *
 * Borrar un preajuste no rompe nada —el bloque se renderiza VISIBLE y quieto, fail-open— pero sí
 * apaga movimiento en páginas que el admin puede no tener delante. La spec pide avisar del recuento
 * ANTES de borrar (riesgo R6), y avisar exige contar.
 *
 * El recorrido es el de `collectIxSpecs` reducido a lo que hace falta: se cuentan solo las
 * REFERENCIAS (`ix.preset`), no los cuerpos desvinculados — un bloque que copió el cuerpo ya no
 * depende del preajuste y borrarlo no le afecta.
 */
export function ixPresetUsage(data: unknown, into?: Map<string, number>): Map<string, number> {
  const out = into ?? new Map<string, number>();
  const root = (data as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(root)) return out;

  let visited = 0;
  const walk = (items: readonly unknown[], depth: number): void => {
    if (depth > 24 || visited > 5000) return;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      visited++;
      const props = (item as { props?: unknown }).props;
      if (!props || typeof props !== "object") continue;
      const bag = props as Record<string, unknown>;
      const ix = bag.ix as { preset?: unknown } | undefined;
      if (ix && typeof ix === "object" && typeof ix.preset === "string") {
        out.set(ix.preset, (out.get(ix.preset) ?? 0) + 1);
      }
      for (const value of Object.values(bag)) {
        if (Array.isArray(value) && value.some((v) => v && typeof v === "object" && "type" in v)) {
          walk(value, depth + 1);
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

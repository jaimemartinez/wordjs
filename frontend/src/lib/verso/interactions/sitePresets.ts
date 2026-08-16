/**
 * Verso — interacciones: PRESETS DEL SITIO (`wjs_ix_presets`), F9-E.
 *
 * Dónde viven los presets y por qué AHÍ (decisión de §3.5 de la spec, no reabierta aquí):
 *
 *  · En el TEMA → NO. Cambiar de tema borraría el movimiento de todas las páginas, y un tema es su
 *    contrato de tokens y nada más: ningún tema debe poder decidir CUÁNDO se mueve el contenido
 *    (ni, por supuesto, enviar JS).
 *  · En el DOCUMENTO → NO. Editar un preset reescribiría N documentos: N revisiones, N purgas y N
 *    oportunidades de romper el round-trip byte-exacto de `_puck_data`.
 *  · En AJUSTES DEL SITIO → SÍ. Una fila, una etiqueta de purga, alcance global. Y sobre todo: el
 *    bloque guarda un ID, no un cuerpo, así que editar el preset NO TOCA UN BYTE de `_puck_data`.
 *
 * ESTE MÓDULO ES LA FRONTERA DE LECTURA. El ajuste es dato hostil como cualquier otro (lo escribe
 * un admin, pero también puede llegar por importación, por la API o por una restauración): entra
 * como `unknown` y sale como un catálogo ya normalizado por `normalizeIxPreset`, o vacío. NUNCA
 * lanza — un ajuste corrupto deja el sitio sin presets de sitio (los bloques que los referencian se
 * renderizan VISIBLES y quietos), jamás una página rota. Fail-open, como todo el motor.
 *
 * Puro, sin React ni DOM: lo llama el renderer del servidor y también el editor.
 */
import { normalizeIxPreset } from "./normalize";
import { SYS_IX_PRESETS } from "./presets";
import type { IxCompileCtx } from "./compile";
import type { IxPreset } from "./types";

/** Clave de la opción en ajustes del sitio (backend: `PUBLIC_SETTINGS` en routes/settings.ts). */
export const IX_PRESETS_SETTING = "wjs_ix_presets";

/**
 * Tope de presets de sitio. No es cosmético: cada preset referenciado emite reglas en la hoja de
 * cada página que lo usa, y el presupuesto de bytes de §7.3 se mide por página. 50 catálogos
 * distintos ya son más de los que un sitio puede razonar.
 */
export const IX_MAX_SITE_PRESETS = 50;

/**
 * Tope de bytes del ajuste ANTES de parsear. `JSON.parse` de una cadena de 40 MB bloquea el hilo
 * del servidor de render; comprobar el tamaño primero cuesta O(1) y cierra ese camino. El valor es
 * holgado para 50 presets con 3 pistas de 6 pasos.
 */
export const IX_PRESETS_MAX_BYTES = 256 * 1024;

/** Prefijo RESERVADO de los presets de sistema: un preset de sitio nunca puede suplantar uno. */
const SYS_PREFIX = "sys:";

/**
 * El ajuste → catálogo indexado por id.
 *
 * Admite las dos formas en las que este dato puede llegar: la cadena JSON que guarda la opción, y
 * el valor ya parseado (array de presets o mapa id→preset) cuando quien llama lo tiene en memoria.
 * Todo lo demás — `null`, un número, HTML, JSON válido con basura dentro — devuelve `{}`.
 */
export function parseSiteIxPresets(raw: unknown): Record<string, IxPreset> {
  let value: unknown = raw;

  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return {};
    if (s.length > IX_PRESETS_MAX_BYTES) return {};
    try {
      value = JSON.parse(s);
    } catch {
      return {};
    }
  }

  const list: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null
      ? Object.values(value as Record<string, unknown>)
      : [];

  const out: Record<string, IxPreset> = {};
  let count = 0;
  for (const item of list) {
    if (count >= IX_MAX_SITE_PRESETS) break;
    const preset = normalizeIxPreset(item);
    if (!preset) continue;
    // El espacio de nombres `sys:` es del CÓDIGO. Si el ajuste pudiera definir `sys:fade-up`, un
    // admin (o una importación) redefiniría en silencio lo que los bloques nuevos usan por defecto.
    if (preset.id.startsWith(SYS_PREFIX)) continue;
    if (out[preset.id]) continue; // el primero gana: determinista
    out[preset.id] = preset;
    count++;
  }
  return out;
}

/**
 * Contexto de compilación = presets del SISTEMA + presets del SITIO.
 *
 * El orden del spread no es un detalle: los del sistema se escriben DESPUÉS, así que ni un catálogo
 * manipulado ni una colisión de ids puede sustituirlos. (`parseSiteIxPresets` ya descarta el
 * prefijo `sys:`; esto es la segunda vuelta de la misma llave.)
 */
export function ixCtxFromSite(site?: Readonly<Record<string, IxPreset>> | null): IxCompileCtx {
  if (!site || Object.keys(site).length === 0) return { presets: SYS_IX_PRESETS };
  return { presets: { ...site, ...SYS_IX_PRESETS } };
}

/** Atajo: del valor crudo del ajuste al contexto listo para `compileIxPage`. */
export function ixCtxFromSetting(raw: unknown): IxCompileCtx {
  return ixCtxFromSite(parseSiteIxPresets(raw));
}

/**
 * Catálogo → el texto que se guarda en el ajuste. Se emite como ARRAY (no como mapa) porque el
 * orden de un array es dato y el de las claves de un objeto no lo es, y porque cada entrada ya
 * lleva su `id` dentro: guardar el mapa duplicaría la clave y abriría la puerta a que las dos
 * copias discrepasen.
 */
export function serializeSiteIxPresets(presets: Readonly<Record<string, IxPreset>>): string {
  const list = Object.keys(presets)
    .sort()
    .map((id) => presets[id]);
  return JSON.stringify(list);
}

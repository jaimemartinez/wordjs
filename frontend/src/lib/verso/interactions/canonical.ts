/**
 * Verso — interacciones: JSON CANÓNICO y hash determinista.
 *
 * Por qué existe: el nombre de una clase y de unos `@keyframes` se deriva del CONTENIDO, no de la
 * identidad del bloque. Dos bloques con el mismo movimiento comparten una clase y un `@keyframes`
 * (el coste de CSS es sublineal en el número de bloques), y reguardar una página sin tocar la
 * interacción reemite CSS BYTE-IDÉNTICO → diffs limpios y caché de navegador que no se invalida
 * sola.
 *
 * Para que eso se sostenga, el hash no puede depender de:
 *  - el orden de claves que traiga `_puck_data` (JSON no lo garantiza) → claves ORDENADAS;
 *  - la representación exacta de un float (0.1+0.2) → números REDONDEADOS a 4 decimales;
 *  - la diferencia entre "clave ausente" y "clave = undefined" → `undefined` OMITIDO;
 *  - `-0` vs `0` → normalizado a `0`.
 *
 * FNV-1a de 32 bits, NO criptográfico, a propósito: esto es una clave de caché, no una frontera de
 * seguridad. El dominio de colisión es UNA página (decenas de unidades) y la colisión se detecta y
 * se resuelve al emitir (ver `compileIxPage`).
 *
 * Sin dependencias, puro, testeable en node.
 */

/** Decimales fijos del canónico. Cambiarlo cambia TODOS los hashes: no se toca. */
export const IX_NUM_PRECISION = 4;

const POW = 10 ** IX_NUM_PRECISION;

/** Redondeo estable a 4 decimales, con `-0` normalizado a `0`. */
export function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(n * POW) / POW;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Serialización canónica. No usa `JSON.stringify` sobre el objeto entero porque este necesita
 * ordenar claves y normalizar números en CADA nivel; sí lo usa para escapar cadenas (que es
 * exactamente el trabajo que hace bien y que no conviene reimplementar).
 *
 * Devuelve `undefined` solo para valores que NO deben aparecer (undefined, funciones, símbolos);
 * el llamador de arriba los omite. Un `NaN`/`Infinity` se canoniza como `null`.
 */
function enc(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    const n = value as number;
    return Number.isFinite(n) ? JSON.stringify(round4(n)) : "null";
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") return JSON.stringify(String(value));
  if (Array.isArray(value)) {
    // Un hueco o un `undefined` dentro de un array SÍ ocupa posición: se canoniza `null`.
    return `[${value.map((v) => enc(v) ?? "null").join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj).sort()) {
      const e = enc(obj[k]);
      if (e !== undefined) parts.push(`${JSON.stringify(k)}:${e}`);
    }
    return `{${parts.join(",")}}`;
  }
  return undefined; // función / símbolo → se omite
}

export function canonicalJson(value: unknown): string {
  return enc(value) ?? "null";
}

/**
 * FNV-1a 32 bits. Se mezcla el charCode UTF-16 COMPLETO (no el byte bajo): la variante clásica va
 * sobre bytes, pero lo único que este hash necesita es ser estable y bien distribuido, y truncar a
 * 8 bits haría colisionar cadenas que solo difieren fuera de ASCII.
 */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 7 caracteres base36, estables entre ejecuciones y entre procesos. */
export function ixHash(value: unknown): string {
  return fnv1a32(canonicalJson(value)).toString(36).padStart(7, "0").slice(-7);
}

/**
 * Verso — lógica PURA de los controles de campo (sin React, sin DOM).
 *
 * Extraída del componente para que el mapeo interacción→valor de onChange sea
 * testeable en el entorno node de vitest (el proyecto no tiene jsdom y las
 * dependencias nuevas están vetadas): VersoFieldControl delega aquí todo lo
 * que no es markup.
 */
import type { ArrayVersoField, VersoFieldOption } from "@/lib/verso/registry";

/* ------------------------------------------------------------------ */
/* select / radio — opciones con valores no-string.                    */
/* ------------------------------------------------------------------ */

/**
 * Índice de la opción cuyo value corresponde al valor actual. Los values de
 * VersoFieldOption pueden ser number/boolean/null/object: el <select>/<radio>
 * HTML solo transporta strings, así que el control viaja POR ÍNDICE y este
 * helper resuelve la selección actual. Objetos: identidad primero, después
 * igualdad estructural (JSON) — los configs legacy re-crean el objeto opción.
 */
export function optionIndexOf(options: readonly VersoFieldOption[], value: unknown): number {
  const byIdentity = options.findIndex((o) => Object.is(o.value, value));
  if (byIdentity !== -1) return byIdentity;
  if (value !== null && typeof value === "object") {
    const encoded = JSON.stringify(value);
    return options.findIndex(
      (o) => o.value !== null && typeof o.value === "object" && JSON.stringify(o.value) === encoded,
    );
  }
  return -1;
}

/** Valor TIPADO de la opción elegida (raw = el value string del input, un índice; "" = sin selección). */
export function optionValueAt(options: readonly VersoFieldOption[], raw: string): unknown {
  if (raw === "") return undefined; // el sentinel del select vacío: Number("") sería 0
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0 || index >= options.length) return undefined;
  return options[index].value;
}

/* ------------------------------------------------------------------ */
/* number                                                              */
/* ------------------------------------------------------------------ */

/** "" → undefined (campo vaciado); no-numérico → undefined; resto → number. */
export function parseNumberInput(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

/* ------------------------------------------------------------------ */
/* array — añadir/quitar/reordenar sin mutar.                          */
/* ------------------------------------------------------------------ */

export type ArrayItem = Record<string, unknown>;

/** Valor de un campo array normalizado a lista (cualquier otra forma → []). */
export function asArrayItems(value: unknown): ArrayItem[] {
  return Array.isArray(value) ? (value as ArrayItem[]) : [];
}

export function canAddItem(field: ArrayVersoField, items: ArrayItem[]): boolean {
  return field.max === undefined || items.length < field.max;
}

export function canRemoveItem(field: ArrayVersoField, items: ArrayItem[]): boolean {
  return items.length > (field.min ?? 0);
}

/**
 * Lista nueva con un item semilla al final. La semilla se CLONA de
 * defaultItemProps (nunca la misma referencia: editar el item N no puede
 * contaminar los defaults ni al item N+1). Respeta `max` (sin cambio).
 */
export function arrayAppend(field: ArrayVersoField, items: ArrayItem[]): ArrayItem[] {
  if (!canAddItem(field, items)) return items;
  let seed: ArrayItem = {};
  if (field.defaultItemProps) {
    try {
      seed = structuredClone(field.defaultItemProps);
    } catch {
      // defaultItemProps con valores no clonables (funciones): copia superficial.
      seed = { ...field.defaultItemProps };
    }
  }
  return [...items, seed];
}

/** Lista nueva sin el item `index`. Respeta `min` (sin cambio). */
export function arrayRemoveAt(field: ArrayVersoField, items: ArrayItem[], index: number): ArrayItem[] {
  if (!canRemoveItem(field, items) || index < 0 || index >= items.length) return items;
  return items.filter((_, i) => i !== index);
}

/** Lista nueva con el item movido de `from` a `to` (índices fuera de rango → sin cambio). */
export function arrayMove(items: ArrayItem[], from: number, to: number): ArrayItem[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Item `index` con la clave `key` parcheada (lista e item nuevos). */
export function arrayPatchItem(items: ArrayItem[], index: number, key: string, value: unknown): ArrayItem[] {
  return items.map((item, i) => (i === index ? { ...item, [key]: value } : item));
}

/* ------------------------------------------------------------------ */
/* object                                                              */
/* ------------------------------------------------------------------ */

/** Valor de un campo object normalizado a objeto plano (cualquier otra forma → {}). */
export function asObjectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Objeto nuevo con la clave parcheada. */
export function objectSet(value: unknown, key: string, v: unknown): Record<string, unknown> {
  return { ...asObjectValue(value), [key]: v };
}

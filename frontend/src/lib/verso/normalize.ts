/**
 * Verso — normalización y serialización del documento.
 *
 * `toNormalized(data)` convierte la forma persistida (contrato `_puck_data`) en el
 * documento normalizado (mapa plano id→nodo). `fromNormalized(doc)` reconstruye la
 * forma persistida EXACTA. Gate: round-trip deep-equal sobre el corpus de producción
 * (verso-roundtrip.test.ts); las únicas diferencias permitidas son la normalización
 * zones→slots ya vigente en el editor actual.
 *
 * Política fail-soft (ratificada): lo que no se entiende se PRESERVA verbatim y se
 * anota en `doc.warnings` — nunca throw, nunca pérdida. La clasificación slot/prop
 * es irrelevante para la exactitud del round-trip (un slot se re-emite en la misma
 * clave con la misma forma); solo afecta a qué puede editarse como hijos.
 */

import {
  ROOT_ID,
  ROOT_SLOT,
  type SlotResolver,
  type VersoData,
  type VersoDoc,
  type VersoItem,
  type VersoNode,
} from "./types";

const DATA_KEYS = new Set(["content", "root", "zones"]);
const ITEM_KEYS = new Set(["type", "props"]);

/** ¿Es `value` estructuralmente un VersoItem (bloque persistido)? */
export function isVersoItem(value: unknown): value is VersoItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string") return false;
  const props = v.props;
  if (typeof props !== "object" || props === null || Array.isArray(props)) return false;
  return typeof (props as Record<string, unknown>).id === "string";
}

/** ¿Es `value` un array NO VACÍO cuyos elementos son todos VersoItem? (detección estructural de slot) */
export function isVersoItemArray(value: unknown): value is VersoItem[] {
  return Array.isArray(value) && value.length > 0 && value.every(isVersoItem);
}

/**
 * Regla ÚNICA de clasificación slot/prop (compartida por `normalizeItem`, el
 * `internItem` de commands.ts y `resolveInsertTarget`):
 * - `declared === true` (el registry lo declara slot): es slot si el valor es un
 *   array vacío o un array de VersoItem — cualquier otro valor NO se re-clasifica.
 * - `declared === false` (declarado NO-slot): jamás es slot, sea cual sea la forma.
 * - `declared === undefined` (sin opinión del registry): detección estructural.
 */
export function classifySlotProp(declared: boolean | undefined, value: unknown): boolean {
  if (declared === true) return Array.isArray(value) && (value.length === 0 || isVersoItemArray(value));
  if (declared === false) return false;
  return isVersoItemArray(value);
}

interface NormalizeCtx {
  nodes: Record<string, VersoNode>;
  warnings: string[];
  isSlot?: SlotResolver;
}

function internKey(ctx: NormalizeCtx, id: string): string {
  if (!(id in ctx.nodes)) return id;
  // Sondeo de clave libre (espejo de internItem en commands.ts): un contador por id
  // se descolocaba cuando el propio dato traía claves `#dupN` literales (p.ej.
  // content ids ["a","a#dup2","a"]) y PISABA un nodo ya interneado.
  let n = 2;
  while (`${id}#dup${n}` in ctx.nodes) n += 1;
  const key = `${id}#dup${n}`;
  ctx.warnings.push(`id duplicado "${id}" — esta aparición se indexa como "${key}" (props.id intacto)`);
  return key;
}

function normalizeItem(
  ctx: NormalizeCtx,
  item: VersoItem,
  parentId: string,
  slotKey: string,
  index: number,
): string {
  const key = internKey(ctx, item.props.id);

  const props: VersoNode["props"] = { id: item.props.id };
  const slots: Record<string, string[]> = {};

  // Registrar el nodo ANTES de descender: los hijos necesitan que el padre exista
  // para la detección de duplicados y para parentId estable.
  const node: VersoNode = { id: key, type: item.type, props, slots, parentId, slotKey, index };

  // Claves desconocidas a nivel de item (p.ej. readOnly) → preservar verbatim.
  for (const k of Object.keys(item)) {
    if (!ITEM_KEYS.has(k)) {
      (node.extras ??= {})[k] = (item as unknown as Record<string, unknown>)[k];
    }
  }

  ctx.nodes[key] = node;

  for (const [k, v] of Object.entries(item.props)) {
    if (k === "id") continue;
    if (classifySlotProp(ctx.isSlot?.(item.type, k), v)) {
      slots[k] = (v as VersoItem[]).map((child, i) => normalizeItem(ctx, child, key, k, i));
    } else {
      props[k] = v;
    }
  }

  // Orden original de claves del item — solo se materializa cuando hay ≥1 slot
  // (sin slots, el orden de `props` ya ES el original y `keyOrder` sobraría).
  if (Object.keys(slots).length > 0) node.keyOrder = Object.keys(item.props);

  return key;
}

export function toNormalized(data: VersoData, isSlot?: SlotResolver): VersoDoc {
  const ctx: NormalizeCtx = { nodes: {}, warnings: [], isSlot };

  const contentKeyState: VersoDoc["contentKeyState"] = Array.isArray(data.content)
    ? "array"
    : "content" in data
      ? "verbatim"
      : "absent";
  const content = contentKeyState === "array" ? data.content : [];
  if (contentKeyState === "verbatim") {
    ctx.warnings.push("`content` presente pero no-array — preservado verbatim sin normalizar");
  }

  const rootChildren = content.map((item, i) => normalizeItem(ctx, item, ROOT_ID, ROOT_SLOT, i));

  // Zonas legacy: merge en el slot del nodo destino cuando existe; huérfanas → verbatim.
  const orphanZones: Record<string, VersoItem[]> = {};
  const zonesIsObject =
    "zones" in data && typeof data.zones === "object" && data.zones !== null && !Array.isArray(data.zones);
  const zonesKeyPresent = zonesIsObject;
  if (zonesIsObject && data.zones) {
    for (const [compound, items] of Object.entries(data.zones)) {
      const sep = compound.indexOf(":");
      const targetId = sep === -1 ? "" : compound.slice(0, sep);
      const slotName = sep === -1 ? "" : compound.slice(sep + 1);
      const target = ctx.nodes[targetId];
      if (target && slotName && Array.isArray(items) && items.every(isVersoItem)) {
        if (target.slots[slotName]) {
          // El slot ya venía poblado en props (dato mixto anómalo): no fusionar a ciegas.
          orphanZones[compound] = items;
          ctx.warnings.push(`zona legacy "${compound}" ignorada: el slot ya existe en props — preservada verbatim`);
        } else {
          target.slots[slotName] = items.map((child, i) => normalizeItem(ctx, child, targetId, slotName, i));
        }
      } else {
        orphanZones[compound] = items as VersoItem[];
        ctx.warnings.push(`zona legacy huérfana "${compound}" — preservada verbatim`);
      }
    }
  }

  // Claves top-level desconocidas → preservar verbatim. Un `zones` que NO sea objeto
  // plano (null, array, string…) también se preserva aquí tal cual (fail-soft).
  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (!DATA_KEYS.has(k)) extras[k] = (data as unknown as Record<string, unknown>)[k];
  }
  if ("zones" in data && !zonesIsObject) {
    extras.zones = (data as unknown as Record<string, unknown>).zones;
    ctx.warnings.push("`zones` no era un objeto plano — preservado verbatim sin normalizar");
  }
  if (contentKeyState === "verbatim") {
    extras.content = (data as unknown as Record<string, unknown>).content;
  }

  return {
    nodes: ctx.nodes,
    rootChildren,
    root: data.root ?? {},
    orphanZones,
    zonesKeyPresent,
    contentKeyState,
    rootKeyPresent: "root" in data,
    extras,
    warnings: ctx.warnings,
  };
}

/**
 * Emite las props de un nodo respetando `keyOrder` (cada clave: slot reconstruido
 * si está en `slots`, prop si está en `props`), después las props nuevas fuera de
 * `keyOrder` y por último los slots nuevos fuera de `keyOrder`. Sin `keyOrder`
 * (nodo sin slots al internear) equivale a props-en-orden-de-inserción + slots.
 * Compartida con `subtreeToItem`/`duplicateItemFromNode` de commands.ts.
 */
export function emitNodeProps(node: VersoNode, buildChild: (childKey: string) => VersoItem): VersoItem["props"] {
  const props = {} as VersoItem["props"];
  const bag = props as Record<string, unknown>;
  const emitted = new Set<string>();
  for (const k of node.keyOrder ?? []) {
    if (emitted.has(k)) continue;
    if (k in node.slots) {
      bag[k] = node.slots[k].map(buildChild);
      emitted.add(k);
    } else if (k in node.props) {
      bag[k] = node.props[k];
      emitted.add(k);
    }
    // Clave de keyOrder ya eliminada (setProps con undefined): se omite.
  }
  for (const [k, v] of Object.entries(node.props)) {
    if (!emitted.has(k)) bag[k] = v;
  }
  for (const [k, children] of Object.entries(node.slots)) {
    if (!emitted.has(k)) bag[k] = children.map(buildChild);
  }
  return props;
}

function buildItem(doc: VersoDoc, nodeKey: string): VersoItem {
  const node = doc.nodes[nodeKey];
  if (!node) {
    // Referencia rota (no debería ocurrir: los comandos mantienen la integridad).
    // Fail-soft: emitir un placeholder imposible de confundir en vez de lanzar.
    return { type: "verso:missing", props: { id: nodeKey } };
  }
  const props = emitNodeProps(node, (c) => buildItem(doc, c));
  const item: VersoItem = { type: node.type, props };
  if (node.extras) Object.assign(item as unknown as Record<string, unknown>, node.extras);
  return item;
}

export function fromNormalized(doc: VersoDoc): VersoData {
  const rebuilt = doc.rootChildren.map((c) => buildItem(doc, c));
  const data = {} as VersoData;
  if (doc.contentKeyState === "array" || rebuilt.length > 0) data.content = rebuilt;
  if (doc.rootKeyPresent || Object.keys(doc.root).length > 0) data.root = doc.root;
  if (doc.zonesKeyPresent || Object.keys(doc.orphanZones).length > 0) {
    data.zones = { ...doc.orphanZones };
  }
  // Extras al final (incluye `content`/`zones` verbatim de datos anómalos)…
  Object.assign(data as unknown as Record<string, unknown>, doc.extras);
  // …pero los hijos REALES siempre ganan sobre un `content` verbatim corrupto.
  if (rebuilt.length > 0) data.content = rebuilt;
  return data;
}

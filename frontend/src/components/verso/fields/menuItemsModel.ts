/**
 * Verso — modelo PURO del editor de elementos de menú (MenuItemsEditor).
 *
 * El store nav_menu es plano: cada elemento lleva `parent` (0 = raíz) y `order` (posición entre
 * hermanos). Reordenar/indentar/desindentar se expresa como una lista mínima de updates
 * `{id, {parent?, order?}}` que el editor aplica componiendo el PUT /menus/items/:itemId existente
 * (parent y order SON campos actualizables del modelo — no hace falta endpoint de reorden).
 *
 * Todo aquí es puro y determinista (testeado en node, sin DOM): la UI solo traduce clicks a estas
 * funciones y manda los updates resultantes a la API.
 */

export interface FlatMenuItem {
    id: number;
    title: string;
    url: string;
    target: string;
    parent: number;
    order: number;
}

export interface MenuItemUpdate {
    id: number;
    data: { parent?: number; order?: number };
}

/**
 * Normaliza los items crudos de GET /menus/:id (toJSON del modelo: {id, title, url, target, parent,
 * order, ...}) a la forma plana del editor. Tolerante con basura: entradas sin id numérico se
 * descartan; parent/order no numéricos caen a 0; target fuera de la whitelist cae a _self (misma
 * lección del tag-whitelist de HeadingBlock: los datos del autor rellenan huecos, nunca eligen
 * estructura).
 */
export function normalizeMenuItems(raw: unknown): FlatMenuItem[] {
    if (!Array.isArray(raw)) return [];
    const out: FlatMenuItem[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const it = entry as Record<string, unknown>;
        const id = Number(it.id);
        if (!Number.isFinite(id) || id <= 0) continue;
        const parent = Number(it.parent);
        const order = Number(it.order);
        out.push({
            id,
            title: typeof it.title === "string" ? it.title : "",
            url: typeof it.url === "string" ? it.url : "",
            target: it.target === "_blank" ? "_blank" : "_self",
            parent: Number.isFinite(parent) && parent > 0 ? parent : 0,
            order: Number.isFinite(order) ? order : 0,
        });
    }
    return out;
}

/** Hermanos bajo `parentId`, en el orden visual (order asc; id como desempate estable). */
export function siblingsOf(items: FlatMenuItem[], parentId: number): FlatMenuItem[] {
    return items
        .filter((it) => it.parent === parentId)
        .sort((a, b) => a.order - b.order || a.id - b.id);
}

/** El `order` con el que un elemento NUEVO se añade al final del grupo de `parentId`. */
export function nextMenuOrder(items: FlatMenuItem[], parentId: number): number {
    return siblingsOf(items, parentId).length;
}

/**
 * Renumera un grupo de hermanos a la secuencia contigua 0..n-1 dada por `orderedIds`, emitiendo
 * SOLO los updates que cambian algo (order distinto, o parent distinto para un elemento que entra
 * al grupo). Ids que no existan en `items` se ignoran (defensivo).
 */
function planGroup(items: FlatMenuItem[], parentId: number, orderedIds: number[]): MenuItemUpdate[] {
    const byId = new Map(items.map((it) => [it.id, it]));
    const out: MenuItemUpdate[] = [];
    orderedIds.forEach((id, index) => {
        const it = byId.get(id);
        if (!it) return;
        const data: MenuItemUpdate["data"] = {};
        if (it.parent !== parentId) data.parent = parentId;
        if (it.order !== index) data.order = index;
        if (data.parent !== undefined || data.order !== undefined) out.push({ id, data });
    });
    return out;
}

/**
 * Sube (delta -1) o baja (delta +1) un elemento entre sus hermanos. En el borde (primero hacia
 * arriba, último hacia abajo) devuelve [] — un no-op explícito, la UI deshabilita el botón.
 */
export function moveMenuItem(items: FlatMenuItem[], id: number, delta: -1 | 1): MenuItemUpdate[] {
    const item = items.find((it) => it.id === id);
    if (!item) return [];
    const sibs = siblingsOf(items, item.parent);
    const index = sibs.findIndex((it) => it.id === id);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= sibs.length) return [];
    const orderedIds = sibs.map((it) => it.id);
    [orderedIds[index], orderedIds[target]] = [orderedIds[target], orderedIds[index]];
    return planGroup(items, item.parent, orderedIds);
}

/**
 * Indenta: el elemento pasa a ser ÚLTIMO hijo de su hermano ANTERIOR (la semántica clásica de los
 * editores de menú). Sin hermano anterior (primero del grupo) → [] (no hay bajo quién anidar).
 * Emite además la renumeración del grupo que abandona, para que los hermanos queden contiguos.
 */
export function indentMenuItem(items: FlatMenuItem[], id: number): MenuItemUpdate[] {
    const item = items.find((it) => it.id === id);
    if (!item) return [];
    const sibs = siblingsOf(items, item.parent);
    const index = sibs.findIndex((it) => it.id === id);
    if (index <= 0) return [];
    const newParent = sibs[index - 1];
    const newSiblingIds = siblingsOf(items, newParent.id).map((it) => it.id);
    newSiblingIds.push(id);
    const oldGroupIds = sibs.filter((it) => it.id !== id).map((it) => it.id);
    return [
        ...planGroup(items, newParent.id, newSiblingIds),
        ...planGroup(items, item.parent, oldGroupIds),
    ];
}

/**
 * Desindenta: el elemento sale de debajo de su padre y se inserta como hermano INMEDIATAMENTE
 * POSTERIOR a él (bajo el abuelo). En la raíz → []. Si el padre no existe en la lista (cadena
 * malformada — buildMenuTree ya lo trata como raíz), se promociona al final de la raíz.
 * Emite la renumeración de ambos grupos (el que recibe y el que abandona).
 */
export function outdentMenuItem(items: FlatMenuItem[], id: number): MenuItemUpdate[] {
    const item = items.find((it) => it.id === id);
    if (!item || item.parent === 0) return [];
    const parentItem = items.find((it) => it.id === item.parent);
    const grandParentId = parentItem ? parentItem.parent : 0;

    const targetGroupIds = siblingsOf(items, grandParentId)
        .filter((it) => it.id !== id)
        .map((it) => it.id);
    if (parentItem) {
        const at = targetGroupIds.indexOf(parentItem.id);
        targetGroupIds.splice(at === -1 ? targetGroupIds.length : at + 1, 0, id);
    } else {
        targetGroupIds.push(id);
    }
    const oldGroupIds = siblingsOf(items, item.parent)
        .filter((it) => it.id !== id)
        .map((it) => it.id);
    return [
        ...planGroup(items, grandParentId, targetGroupIds),
        ...planGroup(items, item.parent, oldGroupIds),
    ];
}

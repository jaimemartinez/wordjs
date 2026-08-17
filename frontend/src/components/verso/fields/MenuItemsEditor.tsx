"use client";
/**
 * Verso — editor IN-EDITOR de los elementos del menú vinculado por el bloque NavMenu.
 *
 * DECISIÓN DE ARQUITECTURA: el bloque sigue guardando SOLO la referencia (source/location/menuId) y
 * el store nav_menu sigue siendo la única fuente de verdad. Este control es un campo `custom`
 * VIRTUAL (`items`): no escribe NADA en _puck_data (su onChange jamás se invoca) — cada mutación va
 * directa a las rutas admin existentes (/menus/:id/items, /menus/items/:itemId) y después refetchea
 * e invalida la caché de sesión (invalidateEditorMenus) para que el canvas re-renderice el <nav>
 * con el store real. Reordenar/anidar compone el PUT existente (parent y order son actualizables);
 * cero superficie nueva de backend.
 *
 * SEGURIDAD: las rutas de mutación son authenticate+isAdmin. El gate de solo-lectura es doble:
 * PROACTIVO (una sonda a /auth/me por sesión espeja el isAdmin del backend — un autor sin permisos
 * ve la lista de solo lectura desde el primer render, no una UI de mutación que revienta al usarla)
 * y REACTIVO (un 403 de cualquier mutación degrada igualmente, por si el rol cambió a mitad de
 * sesión). El gate nunca se hereda entre vinculaciones: el panel se REMONTA por key al repuntar.
 * Las URLs que teclea el autor pasan por safeMenuUrl EN EL BACKEND al escribir (no se puentea);
 * los títulos se renderizan como texto plano (nunca dangerouslySetInnerHTML).
 *
 * CARRERAS: cada load lleva un token monotónico y una resolución rancia se DESCARTA (sin el token,
 * el refetch lento de una mutación sobre el menú A podía aterrizar tras el repunte al menú B y las
 * altas siguientes escribirían en el menú equivocado). El remontaje por key es el cinturón; el
 * token, los tirantes — la carrera también existe sin repunte, con dos loads del mismo menú.
 *
 * La referencia del bloque seleccionado se lee vía VersoPanelHandleContext (el contrato del campo
 * custom no entrega props hermanas); fuera del editor Verso el control degrada a un aviso.
 */
import React from "react";
import { menusApi } from "@/lib/api";
import { buildMenuTree, type ChromeMenuItem } from "@/lib/chromeData";
import { invalidateEditorMenus } from "@/lib/useEditorMenu";
import type { EditorHandle } from "@/lib/verso/store";
import type { VersoEditorState } from "@/lib/verso/types";
import { useStoreSlice } from "../render/context";
import { useVersoPanelHandle } from "./versoPanelHandleContext";
import { refreshMenuCatalog } from "./MenuSourceControls";
import {
    indentMenuItem,
    moveMenuItem,
    nextMenuOrder,
    normalizeMenuItems,
    outdentMenuItem,
    planDeleteWithReparent,
    siblingsOf,
    type FlatMenuItem,
    type MenuItemUpdate,
} from "./menuItemsModel";

/* Mismos tokens --ed-* que el resto de controles del panel. */
const LABEL_CLS = "block text-xs font-medium text-[var(--ed-on-surface-variant)] mb-1";
const INPUT_CLS =
    "w-full rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] px-2 py-1.5 text-sm text-[var(--ed-on-surface)]";
const BTN_CLS =
    "rounded border border-[var(--ed-outline-variant)] px-1.5 py-0.5 text-xs text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] disabled:opacity-40";
const NOTICE_CLS =
    "rounded border border-dashed border-[var(--ed-outline-variant)] px-2 py-1.5 text-xs text-[var(--ed-on-surface-variant)]";

function Notice({ children }: { children: React.ReactNode }) {
    return <div role="note" className={NOTICE_CLS}>{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Árbol presentacional (exportado para test determinista sin DOM).    */
/* ------------------------------------------------------------------ */

export interface MenuTreeCallbacks {
    onMove: (id: number, delta: -1 | 1) => void;
    onIndent: (id: number) => void;
    onOutdent: (id: number) => void;
    onEdit: (id: number) => void;
    onDeleteAsk: (id: number) => void;
    onDeleteConfirm: (id: number) => void;
    onDeleteCancel: () => void;
}

export function MenuItemsTree({ nodes, depth = 0, readOnly, busy, deletingId, callbacks }: {
    nodes: ChromeMenuItem[];
    depth?: number;
    readOnly: boolean;
    busy: boolean;
    deletingId: number | null;
    callbacks: MenuTreeCallbacks;
}) {
    if (nodes.length === 0 && depth === 0) {
        return <Notice>El menú no tiene elementos todavía.</Notice>;
    }
    return (
        <ul className={depth === 0 ? "space-y-1" : "mt-1 space-y-1"} data-menu-depth={depth}>
            {nodes.map((node, index) => {
                const id = Number(node.id);
                const isRoot = depth === 0;
                const hasChildren = (node.children?.length ?? 0) > 0;
                return (
                    <li key={String(node.id)} style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
                        <div className="flex items-center gap-1 rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] px-2 py-1">
                            <span className="min-w-0 flex-1 truncate text-xs text-[var(--ed-on-surface)]" title={node.url}>
                                {node.title || "(sin título)"}
                            </span>
                            {!readOnly && deletingId === id && (
                                <span className="flex shrink-0 items-center gap-1">
                                    <span className="text-[10px] text-[var(--ed-error)]">
                                        {hasChildren ? "¿Borrar? (sus hijos suben de nivel)" : "¿Borrar?"}
                                    </span>
                                    <button type="button" className={BTN_CLS} disabled={busy}
                                        aria-label={`Confirmar borrado de ${node.title}`}
                                        onClick={() => callbacks.onDeleteConfirm(id)}>
                                        Sí
                                    </button>
                                    <button type="button" className={BTN_CLS} disabled={busy}
                                        aria-label="Cancelar borrado"
                                        onClick={() => callbacks.onDeleteCancel()}>
                                        No
                                    </button>
                                </span>
                            )}
                            {!readOnly && deletingId !== id && (
                                <span className="flex shrink-0 items-center gap-0.5">
                                    <button type="button" className={BTN_CLS} disabled={busy || index === 0}
                                        title="Subir" aria-label={`Subir ${node.title}`}
                                        onClick={() => callbacks.onMove(id, -1)}>
                                        ↑
                                    </button>
                                    <button type="button" className={BTN_CLS} disabled={busy || index === nodes.length - 1}
                                        title="Bajar" aria-label={`Bajar ${node.title}`}
                                        onClick={() => callbacks.onMove(id, 1)}>
                                        ↓
                                    </button>
                                    <button type="button" className={BTN_CLS} disabled={busy || index === 0}
                                        title="Anidar bajo el elemento anterior" aria-label={`Anidar ${node.title}`}
                                        onClick={() => callbacks.onIndent(id)}>
                                        →
                                    </button>
                                    <button type="button" className={BTN_CLS} disabled={busy || isRoot}
                                        title="Sacar un nivel" aria-label={`Desanidar ${node.title}`}
                                        onClick={() => callbacks.onOutdent(id)}>
                                        ←
                                    </button>
                                    <button type="button" className={BTN_CLS} disabled={busy}
                                        title="Editar" aria-label={`Editar ${node.title}`}
                                        onClick={() => callbacks.onEdit(id)}>
                                        ✎
                                    </button>
                                    <button type="button" className={BTN_CLS} disabled={busy}
                                        title="Borrar" aria-label={`Borrar ${node.title}`}
                                        onClick={() => callbacks.onDeleteAsk(id)}>
                                        ×
                                    </button>
                                </span>
                            )}
                        </div>
                        {hasChildren && (
                            <MenuItemsTree
                                nodes={node.children!}
                                depth={depth + 1}
                                readOnly={readOnly}
                                busy={busy}
                                deletingId={deletingId}
                                callbacks={callbacks}
                            />
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

/* ------------------------------------------------------------------ */
/* Formulario título/URL/target (alta y edición comparten forma).      */
/* ------------------------------------------------------------------ */

interface ItemDraft {
    title: string;
    url: string;
    target: string;
}

function ItemForm({ draft, setDraft, onSubmit, onCancel, submitLabel, busy }: {
    draft: ItemDraft;
    setDraft: (d: ItemDraft) => void;
    onSubmit: () => void;
    onCancel?: () => void;
    submitLabel: string;
    busy: boolean;
}) {
    const titleId = React.useId();
    const urlId = React.useId();
    const targetId = React.useId();
    return (
        <div className="mt-2 rounded border border-[var(--ed-outline-variant)] p-2 space-y-2">
            <div>
                <label htmlFor={titleId} className={LABEL_CLS}>Título</label>
                <input id={titleId} type="text" className={INPUT_CLS} value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <div>
                <label htmlFor={urlId} className={LABEL_CLS}>URL</label>
                <input id={urlId} type="text" className={INPUT_CLS} value={draft.url}
                    placeholder="/pagina o https://…"
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            </div>
            <div>
                <label htmlFor={targetId} className={LABEL_CLS}>Abrir en</label>
                <select id={targetId} className={INPUT_CLS} value={draft.target}
                    onChange={(e) => setDraft({ ...draft, target: e.target.value === "_blank" ? "_blank" : "_self" })}>
                    <option value="_self">Misma pestaña</option>
                    <option value="_blank">Pestaña nueva</option>
                </select>
            </div>
            <div className="flex gap-1">
                <button type="button" className={`${BTN_CLS} flex-1`} disabled={busy || !draft.title.trim()}
                    onClick={onSubmit}>
                    {submitLabel}
                </button>
                {onCancel && (
                    <button type="button" className={BTN_CLS} disabled={busy} onClick={onCancel}>
                        Cancelar
                    </button>
                )}
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Panel con estado: resuelve la referencia, lista y muta.             */
/* ------------------------------------------------------------------ */

interface MenuBinding {
    source: string;
    location: string;
    menuId: number;
}

type PanelStatus = "loading" | "ready" | "unbound" | "no-menu-at-location" | "error";

const EMPTY_DRAFT: ItemDraft = { title: "", url: "", target: "_self" };

function is403(error: unknown): boolean {
    return !!error && typeof error === "object" && (error as { status?: number }).status === 403;
}

function is404(error: unknown): boolean {
    return !!error && typeof error === "object" && (error as { status?: number }).status === 404;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : "Error inesperado";
}

/* ------------------------------------------------------------------ */
/* Helpers puros/inyectables — exportados para test determinista.      */
/* ------------------------------------------------------------------ */

/**
 * Identidad de la vinculación, usada como `key` del panel: repuntar el bloque REMONTA el panel y
 * ningún estado (items, forbidden, menú creado) sobrevive de un menú a otro. Misma forma que la
 * refKey de useEditorMenu: con source=location el menuId es irrelevante y no cambia la key.
 */
export function menuBindingKey(binding: MenuBinding): string {
    return binding.source === "menu"
        ? `menu:${binding.menuId > 0 ? binding.menuId : 0}`
        : `location:${binding.location || "header"}`;
}

/**
 * Espejo EXACTO del gate del backend (middleware isAdmin: `getRole() !== 'administrator'` ⇒ 403).
 * A propósito NO replica el `can()` de AuthContext (que además acepta la capability '*'): enseñar
 * la UI de mutación a alguien que el backend va a rechazar es el defecto que este gate corrige.
 */
export function canManageMenus(user: unknown): boolean {
    return !!user && typeof user === "object" && (user as { role?: unknown }).role === "administrator";
}

async function fetchMe(): Promise<unknown> {
    const res = await fetch("/api/v1/auth/me", { credentials: "include" });
    if (!res.ok) {
        const error = new Error(`auth/me ${res.status}`) as Error & { status: number };
        error.status = res.status;
        throw error;
    }
    return res.json();
}

/**
 * Sonda de permisos: /auth/me UNA vez por sesión de editor (promesa cacheada — cada NavMenu que se
 * seleccione la reutiliza). Resultado: true = admin, false = el backend rechazará las mutaciones
 * (403/401 o rol no admin), null = no se pudo saber (red caída) y el gate queda en manos del flip
 * reactivo por 403. `me` es inyectable para test; la fábrica existe para poder crear sondas frescas.
 */
export function createAdminProbe(me: () => Promise<unknown> = fetchMe): () => Promise<boolean | null> {
    let cached: Promise<boolean | null> | null = null;
    return () => {
        if (!cached) {
            cached = me().then(
                (user) => canManageMenus(user),
                (e) => (is403(e) || (!!e && typeof e === "object" && (e as { status?: number }).status === 401) ? false : null),
            );
        }
        return cached;
    };
}

const adminProbe = createAdminProbe();

/** Resultado completo de resolver una vinculación — todo lo que el panel pinta, en un solo commit. */
export interface MenuLoadOutcome {
    status: PanelStatus;
    menu: { id: number; name: string } | null;
    items: FlatMenuItem[];
    error: string | null;
}

interface MenusReadApi {
    get(id: number): Promise<unknown>;
    getByLocation(location: string): Promise<unknown>;
}

export async function resolveMenuBinding(api: MenusReadApi, binding: MenuBinding): Promise<MenuLoadOutcome> {
    const byMenu = binding.source === "menu";
    const location = binding.location || "header";
    if (byMenu && !(binding.menuId > 0)) {
        return { status: "unbound", menu: null, items: [], error: null };
    }
    try {
        const fetched = (byMenu ? await api.get(binding.menuId) : await api.getByLocation(location)) as {
            id: number;
            name: string;
            items?: unknown;
        };
        return {
            status: "ready",
            menu: { id: fetched.id, name: fetched.name },
            items: normalizeMenuItems(fetched.items),
            error: null,
        };
    } catch (e) {
        if (is404(e)) {
            return byMenu
                ? { status: "error", menu: null, items: [], error: `El menú #${binding.menuId} no existe.` }
                : { status: "no-menu-at-location", menu: null, items: [], error: null };
        }
        return { status: "error", menu: null, items: [], error: messageOf(e) };
    }
}

/**
 * Cargador con guardia de secuencia: cada llamada toma un token monotónico y SOLO la resolución del
 * token vigente llega a `commit` — una respuesta rancia (un refetch lento de mutación compitiendo
 * con una carga más nueva) se descarta en vez de pisar el estado con datos de otra petición.
 * Nunca rechaza: resolveMenuBinding convierte todo fallo en un outcome.
 */
export function createMenuLoader(
    api: MenusReadApi,
    commit: (outcome: MenuLoadOutcome) => void,
): (binding: MenuBinding) => Promise<void> {
    let seq = 0;
    return async (binding: MenuBinding): Promise<void> => {
        const token = ++seq;
        const outcome = await resolveMenuBinding(api, binding);
        if (token !== seq) return; // llegó tarde: hay una carga más nueva en vuelo o ya aterrizada
        commit(outcome);
    };
}

/**
 * Crear-y-asignar IDEMPOTENTE: la pareja create+setLocation no es atómica y el reintento ciego
 * duplicaba menús («Menú header», «Menú header», …) cuando el create triunfaba y el setLocation
 * caía. `previouslyCreatedId` (el estado que el panel recuerda vía onCreated) salta el create en el
 * reintento y solo reintenta la asignación. onCreated se invoca ANTES del setLocation precisamente
 * para que un fallo posterior no pierda el id.
 */
export async function createAndAssignMenu(
    api: { create(data: { name: string }): Promise<{ id: number }>; setLocation(id: number, location: string): Promise<unknown> },
    location: string,
    previouslyCreatedId: number | null,
    onCreated: (id: number) => void,
): Promise<void> {
    let menuId = previouslyCreatedId ?? 0;
    if (!(menuId > 0)) {
        const created = await api.create({ name: `Menú ${location}` });
        menuId = Number(created?.id);
        if (!(Number.isFinite(menuId) && menuId > 0)) {
            throw new Error("La API no devolvió el id del menú creado.");
        }
        onCreated(menuId);
    }
    await api.setLocation(menuId, location);
}

export function MenuItemsPanel({ binding }: { binding: MenuBinding }) {
    // Estado inicial DERIVADO: una referencia por menú sin menú elegido ya se sabe "unbound" sin
    // esperar a ningún efecto (y el primer render estático no miente con un "Cargando…").
    const [status, setStatus] = React.useState<PanelStatus>(
        binding.source === "menu" && !(binding.menuId > 0) ? "unbound" : "loading",
    );
    const [menu, setMenu] = React.useState<{ id: number; name: string } | null>(null);
    const [items, setItems] = React.useState<FlatMenuItem[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [forbidden, setForbidden] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [deletingId, setDeletingId] = React.useState<number | null>(null);
    const [editingId, setEditingId] = React.useState<number | null>(null);
    const [editDraft, setEditDraft] = React.useState<ItemDraft>(EMPTY_DRAFT);
    const [addDraft, setAddDraft] = React.useState<ItemDraft>(EMPTY_DRAFT);
    // El menú que "Crear menú y asignarlo" YA creó, cuando la asignación posterior falló: el
    // reintento lo reutiliza en vez de crear otro duplicado (ver createAndAssignMenu).
    const [createdMenuId, setCreatedMenuId] = React.useState<number | null>(null);

    const location = binding.location || "header";

    // Un commit tras desmontar sería un no-op de React, pero mejor ni intentarlo: el panel se
    // remonta por key al repuntar y el panel viejo no debe tocar nada.
    const deadRef = React.useRef(false);
    React.useEffect(() => {
        deadRef.current = false;
        return () => {
            deadRef.current = true;
        };
    }, []);

    const commit = React.useCallback((outcome: MenuLoadOutcome): void => {
        if (deadRef.current) return;
        setMenu(outcome.menu);
        setItems(outcome.items);
        setError(outcome.error);
        setStatus(outcome.status);
    }, []);

    // Un cargador POR MONTAJE del panel: su guardia de secuencia descarta resoluciones rancias
    // (la carrera del refetch de mutación lento contra una carga más nueva).
    const loaderRef = React.useRef<((b: MenuBinding) => Promise<void>) | null>(null);
    if (!loaderRef.current) loaderRef.current = createMenuLoader(menusApi, commit);

    const load = React.useCallback((): Promise<void> => loaderRef.current!(binding), [binding]);

    React.useEffect(() => {
        setStatus("loading");
        setDeletingId(null);
        setEditingId(null);
        // Cinturón: el remontaje por key ya estrena `forbidden`; si esta vinculación cambiara sin
        // remontar, el gate tampoco debe heredarse.
        setForbidden(false);
        void load();
    }, [load]);

    // Gate PROACTIVO: espeja el isAdmin del backend antes del primer click (la sonda es una promesa
    // cacheada de sesión — gratis tras el primer NavMenu). null = no se supo; queda el flip por 403.
    React.useEffect(() => {
        let dead = false;
        void adminProbe().then((admin) => {
            if (!dead && admin === false) setForbidden(true);
        });
        return () => {
            dead = true;
        };
    }, []);

    /** Toda mutación: API → refetch → invalidar la caché del canvas. 403 ⇒ modo solo lectura. */
    const runMutation = React.useCallback(async (mutate: () => Promise<void>): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            await mutate();
            await load();
            invalidateEditorMenus();
        } catch (e) {
            // El estado local puede haber quedado a medias (p.ej. 2 de 3 PUTs de un reorden):
            // refetch PRIMERO para pintar lo que el store REALMENTE tiene — y el aviso del fallo se
            // fija DESPUÉS, porque el commit del load pisa `error` y el mensaje debe sobrevivir.
            await load().catch(() => undefined);
            invalidateEditorMenus();
            if (is403(e)) {
                setForbidden(true);
            } else {
                setError(messageOf(e));
            }
        } finally {
            setBusy(false);
        }
    }, [load]);

    const applyUpdates = React.useCallback(async (updates: MenuItemUpdate[]): Promise<void> => {
        for (const update of updates) {
            await menusApi.updateItem(update.id, update.data);
        }
    }, []);

    const callbacks = React.useMemo<MenuTreeCallbacks>(() => ({
        onMove: (id, delta) => {
            const updates = moveMenuItem(items, id, delta);
            if (updates.length) void runMutation(() => applyUpdates(updates));
        },
        onIndent: (id) => {
            const updates = indentMenuItem(items, id);
            if (updates.length) void runMutation(() => applyUpdates(updates));
        },
        onOutdent: (id) => {
            const updates = outdentMenuItem(items, id);
            if (updates.length) void runMutation(() => applyUpdates(updates));
        },
        onEdit: (id) => {
            const item = items.find((it) => it.id === id);
            if (!item) return;
            setEditingId(id);
            setEditDraft({ title: item.title, url: item.url, target: item.target });
        },
        onDeleteAsk: (id) => setDeletingId(id),
        onDeleteCancel: () => setDeletingId(null),
        onDeleteConfirm: (id) => {
            setDeletingId(null);
            if (editingId === id) setEditingId(null);
            // Los hijos suben de nivel DE VERDAD: el backend no re-parenta (dejaría huérfanos con
            // un parent muerto), así que el plan puro se aplica vía el PUT existente ANTES del
            // DELETE — y de paso renumera el grupo superviviente contiguo (sin huecos de order).
            const updates = planDeleteWithReparent(items, id);
            void runMutation(async () => {
                await applyUpdates(updates);
                await menusApi.deleteItem(id);
            });
        },
    }), [items, editingId, runMutation, applyUpdates]);

    const submitAdd = (): void => {
        if (!menu || !addDraft.title.trim()) return;
        const draft = addDraft;
        void runMutation(async () => {
            await menusApi.addItem(menu.id, {
                title: draft.title.trim(),
                url: draft.url.trim() || "#",
                target: draft.target,
                type: "custom",
                parent: 0,
                order: nextMenuOrder(items, 0),
            });
            setAddDraft(EMPTY_DRAFT);
        });
    };

    const submitEdit = (): void => {
        if (editingId === null || !editDraft.title.trim()) return;
        const id = editingId;
        const draft = editDraft;
        void runMutation(async () => {
            await menusApi.updateItem(id, {
                title: draft.title.trim(),
                url: draft.url.trim() || "#",
                target: draft.target,
            });
            setEditingId(null);
        });
    };

    const createAndAssign = (): void => {
        void runMutation(async () => {
            await createAndAssignMenu(menusApi, location, createdMenuId, (id) => {
                setCreatedMenuId(id);
                // La lista de menús YA cambió aunque la asignación falle después: los pickers deben
                // enseñar el menú recién creado, no ocultar el efecto secundario.
                refreshMenuCatalog();
            });
            setCreatedMenuId(null); // ciclo completo: un futuro «crear» parte de cero
            refreshMenuCatalog();
        });
    };

    const editingItem = editingId === null ? null : items.find((it) => it.id === editingId) ?? null;
    const tree = React.useMemo(() => {
        const chrome: ChromeMenuItem[] = items.map((it) => ({
            id: it.id,
            title: it.title,
            url: it.url,
            order: siblingsOf(items, it.parent).findIndex((s) => s.id === it.id),
            parent: it.parent,
        }));
        return buildMenuTree(chrome);
    }, [items]);

    return (
        <div data-menu-items-editor="">
            <span className={LABEL_CLS}>Elementos del menú</span>

            {forbidden && (
                <div className="mb-2">
                    <Notice>Necesitas permisos de administrador para editar el menú.</Notice>
                </div>
            )}

            {status === "loading" && <Notice>Cargando el menú…</Notice>}

            {status === "unbound" && (
                <Notice>Elige un menú en «Menú (si el origen es Menú)» para editar sus elementos.</Notice>
            )}

            {status === "no-menu-at-location" && (
                <div className="space-y-2">
                    <Notice>No hay ningún menú asignado a la ubicación «{location}».</Notice>
                    {error && <Notice>{error}</Notice>}
                    {!forbidden && createdMenuId !== null && (
                        <Notice>El menú ya se creó; solo falló la asignación — reintenta sin miedo, no se duplica.</Notice>
                    )}
                    {!forbidden && (
                        <button type="button" className={`${BTN_CLS} w-full`} disabled={busy} onClick={createAndAssign}>
                            {createdMenuId !== null ? "Reintentar la asignación" : "Crear menú y asignarlo"}
                        </button>
                    )}
                </div>
            )}

            {status === "error" && (
                <div className="space-y-2">
                    <Notice>{error ?? "No se pudo cargar el menú."}</Notice>
                    <button type="button" className={`${BTN_CLS} w-full`} disabled={busy} onClick={() => void load()}>
                        Reintentar
                    </button>
                </div>
            )}

            {status === "ready" && (
                <div className="space-y-2">
                    <p className="text-[10px] text-[var(--ed-outline)]">
                        Menú «{menu?.name}» — los cambios se guardan al instante en el menú del sitio.
                    </p>
                    {error && <Notice>{error}</Notice>}
                    <MenuItemsTree
                        nodes={tree}
                        readOnly={forbidden}
                        busy={busy}
                        deletingId={deletingId}
                        callbacks={callbacks}
                    />
                    {!forbidden && editingItem && (
                        <ItemForm
                            draft={editDraft}
                            setDraft={setEditDraft}
                            onSubmit={submitEdit}
                            onCancel={() => setEditingId(null)}
                            submitLabel="Guardar cambios"
                            busy={busy}
                        />
                    )}
                    {!forbidden && !editingItem && (
                        <ItemForm
                            draft={addDraft}
                            setDraft={setAddDraft}
                            onSubmit={submitAdd}
                            submitLabel="Añadir elemento"
                            busy={busy}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */
/* Entrada: lee la referencia del bloque seleccionado vía el handle.   */
/* ------------------------------------------------------------------ */

/** Selector de módulo (referencia estable — contrato de useStoreSlice). */
const selectSelectedNode = (s: VersoEditorState) =>
    s.selection.nodeId ? s.doc.nodes[s.selection.nodeId] : undefined;

function BoundMenuItemsEditor({ handle }: { handle: EditorHandle }) {
    const node = useStoreSlice(handle, selectSelectedNode);
    const source = String(node?.props.source ?? "location");
    const rawLocation = node?.props.location;
    const rawMenuId = Number(node?.props.menuId);
    const menuLocation = typeof rawLocation === "string" && rawLocation ? rawLocation : "header";
    const menuId = Number.isFinite(rawMenuId) && rawMenuId > 0 ? rawMenuId : 0;

    const binding = React.useMemo<MenuBinding>(
        () => ({ source, location: menuLocation, menuId }),
        [source, menuLocation, menuId],
    );

    if (!node || node.type !== "NavMenu") {
        // El campo `items` solo existe en NavMenu; esto es un cinturón defensivo, no un camino real.
        return <Notice>Selecciona un bloque de menú de navegación.</Notice>;
    }
    // Key = identidad de la vinculación: repuntar REMONTA el panel (estado a estrenar — ni items,
    // ni forbidden, ni el id del menú creado sobreviven de un menú a otro). La guardia de secuencia
    // del cargador cubre además la carrera dentro de una MISMA vinculación.
    return <MenuItemsPanel key={menuBindingKey(binding)} binding={binding} />;
}

export default function MenuItemsEditor() {
    const handle = useVersoPanelHandle();
    if (!handle) {
        return (
            <div data-menu-items-editor="">
                <span className={LABEL_CLS}>Elementos del menú</span>
                <Notice>Los elementos del menú se editan desde el panel de propiedades del editor Verso.</Notice>
            </div>
        );
    }
    return <BoundMenuItemsEditor handle={handle} />;
}

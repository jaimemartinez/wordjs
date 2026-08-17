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
 * SEGURIDAD: las rutas de mutación son authenticate+isAdmin — un 403 degrada a lista de solo
 * lectura con aviso, nunca revienta. Las URLs que teclea el autor pasan por safeMenuUrl EN EL
 * BACKEND al escribir (no se puentea); los títulos se renderizan como texto plano (nunca
 * dangerouslySetInnerHTML).
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

    const byMenu = binding.source === "menu";
    const location = binding.location || "header";

    const load = React.useCallback(async (): Promise<void> => {
        setError(null);
        if (byMenu && !(binding.menuId > 0)) {
            setStatus("unbound");
            setMenu(null);
            setItems([]);
            return;
        }
        try {
            const fetched = byMenu
                ? await menusApi.get(binding.menuId)
                : await menusApi.getByLocation(location);
            setMenu({ id: fetched.id, name: fetched.name });
            setItems(normalizeMenuItems(fetched.items));
            setStatus("ready");
        } catch (e) {
            if (is404(e)) {
                setMenu(null);
                setItems([]);
                setStatus(byMenu ? "error" : "no-menu-at-location");
                if (byMenu) setError(`El menú #${binding.menuId} no existe.`);
                return;
            }
            setStatus("error");
            setError(messageOf(e));
        }
    }, [byMenu, binding.menuId, location]);

    React.useEffect(() => {
        setStatus("loading");
        setDeletingId(null);
        setEditingId(null);
        void load();
    }, [load]);

    /** Toda mutación: API → refetch → invalidar la caché del canvas. 403 ⇒ modo solo lectura. */
    const runMutation = React.useCallback(async (mutate: () => Promise<void>): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            await mutate();
            await load();
            invalidateEditorMenus();
        } catch (e) {
            if (is403(e)) {
                setForbidden(true);
            } else {
                setError(messageOf(e));
            }
            // El estado local puede haber quedado a medias (p.ej. 2 de 3 PUTs de un reorden):
            // refetch igualmente para pintar lo que el store REALMENTE tiene.
            await load().catch(() => undefined);
            invalidateEditorMenus();
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
            void runMutation(async () => {
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
            const created = await menusApi.create({ name: `Menú ${location}` });
            await menusApi.setLocation(created.id, location);
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
                    {!forbidden && (
                        <button type="button" className={`${BTN_CLS} w-full`} disabled={busy} onClick={createAndAssign}>
                            Crear menú y asignarlo
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
    return <MenuItemsPanel binding={binding} />;
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

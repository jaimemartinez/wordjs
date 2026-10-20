"use client";

/**
 * ChromeVersoEditor — variante DELGADA del motor Verso para /admin/chrome (checkpoint W52).
 *
 * Paridad contra documentation/verso/chrome-oracle.md: MISMO layout de 3 paneles fijos (C08: paleta
 * + estructura / canvas en card / campos del seleccionado), mismo root wrapper por part (C09, por
 * referencia del config), mismos bloques con sus bindings (C10/C11 vía chromeVersoAdapter).
 * A PROPÓSITO sin: autosave, revisiones, comentarios, a11y, InlineTiptap, CommandPalette, patrones,
 * guías ni withSharedVersoFields (el contrato de chrome es una allowlist cerrada).
 *
 * Barra propia del editor de chrome: deshacer/rehacer (botones + Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) y la
 * vista previa por dispositivo (escritorio / tableta / móvil). El iframe del lienzo se redimensiona al
 * ancho del dispositivo, así que los breakpoints REALES de los bloques públicos reaccionan (aparece el
 * menú hamburguesa, una fila se apila) — no es una simulación. Sin bloque seleccionado, el panel
 * derecho edita las props de la RAÍZ (cabecera fija / transparente sobre el hero / ancho).
 *
 * RESPONSIVE COMO VERSO: por debajo de xl (1280 px) los dos paneles laterales dejan de estar acoplados y
 * pasan a ser HOJAS que se abren desde una barra de pestañas inferior (Bloques · Estructura ·
 * Propiedades · Ajustes), igual que el editor de páginas. Las hojas viven DENTRO del área del editor
 * (absolutas, no fixed), así que no compiten con la cabecera móvil ni la barra lateral del admin.
 * Escape o tocar el velo las cierra; insertar un bloque desde la hoja la cierra para ver el resultado.
 *
 * El dato de chrome NO es _puck_data: este componente solo emite `onChange(VersoData)` en cada
 * transacción committeada / undo / redo (el store Verso no tiene el deep-equal guard de Puck, así
 * que el ref del padre nunca queda stale); guardar/restaurar/dirty viven en page.tsx.
 *
 * Canvas: FrameController (/admin/canvas-frame ya carga wordjs-ui.css + hoja del tema activo con
 * los MISMOS helpers de assetVersion que el sitio público). Overlay + DnDDriver como en el resto de
 * superficies Verso.
 */

import "@/components/editor-theme.css";
import React from "react";
import { useI18n } from "@/contexts/I18nContext";
import type { ChromePart } from "@/lib/api";
import type { ChromeData } from "@/lib/chromeData";
import { createEditor, type EditorHandle } from "@/lib/verso/store";
import type { VersoField } from "@/lib/verso/registry";
import { ROOT_ID, ROOT_SLOT, type VersoData, type VersoEditorState, type VersoItem } from "@/lib/verso/types";
import EditorRenderer from "@/components/verso/render/EditorRenderer";
import { useStoreSlice, useVersoNode } from "@/components/verso/render/context";
import VersoFieldControl from "@/components/verso/fields/VersoFieldControl";
import FrameController from "@/components/verso/canvas/FrameController";
import { GeometryStore } from "@/components/verso/overlay/GeometryStore";
import OverlayLayer from "@/components/verso/overlay/OverlayLayer";
import DnDDriver from "@/components/verso/dnd/DnDDriver";
import OutlineTree from "@/components/verso/editor/OutlineTree";
import { useAreaSize } from "@/components/verso/canvas/ViewportControls";
import { fitScale } from "@/components/verso/canvas/viewport";
import { createChromeVersoSetup } from "./chromeVersoAdapter";
import { chromeRootFields, VISIBILITY_FIELDS } from "./chromeEditorConfig";
import { withBlockIds } from "./chromeContract";
import { ChromeDeviceContext, ChromeRootContext, DEVICE_WIDTH, type ChromeDevice, type ChromeEditorRoot } from "./chromeEditorDevice";

/** What the page drives from outside the editor (templates gallery, legacy-text insertion). */
export interface ChromeEditorApi {
    /** Replace the whole composition — ONE undo step, so applying a template can be undone. */
    replace(data: ChromeData): void;
    /** Append blocks at the end of the root (the legacy footer text, offered for insertion). */
    append(blocks: ChromeData["content"]): void;
}

export interface ChromeVersoEditorProps {
    part: ChromePart;
    /** Composición efectiva YA estampada con ids (withBlockIds la pone page.tsx). */
    initialData: ChromeData;
    /** Una llamada por transacción committeada / undo / redo, con el doc serializado (forma Puck Data). */
    onChange: (data: VersoData) => void;
    /**
     * UNA llamada al montar con la SERIALIZACIÓN VERSO del documento cargado. El baseline del dirty
     * del padre debe calcularse sobre esta forma, no sobre el dato crudo: la normalización de Verso
     * emite `id` primero en los nodos sin slots (byte-distinto, deep-igual), y comparar contra el
     * crudo dejaba «sin guardar» en falso positivo permanente (defecto cazado en navegador).
     */
    onInit?: (data: VersoData) => void;
    /** Receives the editor API once mounted (and null on unmount). */
    onApi?: (api: ChromeEditorApi | null) => void;
    /**
     * What an UNSET root prop resolves to on the public site (sticky ← the theme's layout v2, width ←
     * "container", transparent ← false), so the settings panel shows the effective value, not a blank.
     */
    rootDefaults?: Record<string, unknown>;
}

const selectSelection = (s: VersoEditorState) => s.selection.nodeId;
const selectRoot = (s: VersoEditorState) => s.doc.root;
const selectDoc = (s: VersoEditorState) => s.doc;
const VISIBILITY = new Set<string>(VISIBILITY_FIELDS);
/** The sheet open on a compact screen (below xl). null = only the canvas. */
type ChromeSheet = "blocks" | "outline" | "props" | null;

/** Same breakpoint as the page editor's sheets (Verso: max-width 1279px). */
const COMPACT_QUERY = "(max-width: 1279.98px)";
const isCompact = () => typeof window !== "undefined" && window.matchMedia(COMPACT_QUERY).matches;

const DEVICES: { id: ChromeDevice; icon: string }[] = [
    { id: "desktop", icon: "fa-desktop" },
    { id: "tablet", icon: "fa-tablet-screen-button" },
    { id: "phone", icon: "fa-mobile-screen-button" },
];

/** Id imposible (empieza por NUL): useVersoNode exige un string y los hooks no pueden ser condicionales. */
const NO_SELECTION_ID = "\u0000verso:none";

/** Mismo guard de escritura que EditorHotkeys: undo/redo jamás roban un Ctrl+Z de un input. */
function isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== "function") return false;
    return !!el.closest("input, textarea, select, [contenteditable]");
}

function rootPropsOf(root: unknown): Record<string, unknown> {
    const props = (root as { props?: unknown } | undefined)?.props;
    return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

/**
 * Panel de campos del bloque seleccionado (paridad C08 con Puck.Fields). Componente propio para
 * suscribirse al NODO seleccionado (useVersoNode), no solo al id de selección: un undo/redo cambia
 * las props sin tocar la selección, y sin esta suscripción el panel se quedaba stale (defecto
 * cazado en navegador: el canvas revertía y el select seguía mostrando el valor deshecho).
 * Los tres «ocultar en…» van en su propia sección; sin selección, el panel edita la raíz.
 */
function SelectedBlockFields({
    handle,
    registry,
    part,
    rootDefaults,
}: {
    handle: EditorHandle;
    registry: ReturnType<typeof createChromeVersoSetup>["registry"];
    part: ChromePart;
    rootDefaults?: Record<string, unknown>;
}) {
    const { t } = useI18n();
    const selectedId = useStoreSlice(handle, selectSelection);
    const node = useVersoNode(handle, selectedId ?? NO_SELECTION_ID);
    const def = node ? registry.get(node.type) : undefined;
    if (!node || !def) return <RootFields handle={handle} part={part} defaults={rootDefaults} />;
    const entries = Object.entries(def.fields).filter(([, field]) => field.type !== "slot");
    const renderField = ([key, field]: [string, VersoField]) => (
        <VersoFieldControl
            key={`${node.id}:${key}`}
            field={field}
            name={key}
            // An unset "hide on …" flag means visible: show "No" rather than an unchecked pair.
            value={VISIBILITY.has(key) ? node.props[key] ?? false : node.props[key]}
            onChange={(v) =>
                handle.transact((tx) => tx.setProps(node.id, { [key]: v }), {
                    coalesceKey: `props:${node.id}:${key}`,
                    label: `Editar ${key}`,
                })
            }
        />
    );
    return (
        <>
            <p className="text-xs font-bold text-gray-700 mb-2">{def.label ?? def.type}</p>
            {entries.filter(([key]) => !VISIBILITY.has(key)).map(renderField)}
            <h4 className="mt-5 mb-1 text-[10px] font-black uppercase tracking-widest text-gray-400">{t("chrome.admin.visibility")}</h4>
            <p className="text-[11px] text-gray-400 mb-2">{t("chrome.admin.visibilityHint")}</p>
            {entries.filter(([key]) => VISIBILITY.has(key)).map(renderField)}
        </>
    );
}

/**
 * Sin selección: cómo se coloca la parte en la página (contract rootProps). setRootProps es una
 * transacción más, así que entra en deshacer/rehacer como cualquier edición.
 */
function RootFields({ handle, part, defaults }: { handle: EditorHandle; part: ChromePart; defaults?: Record<string, unknown> }) {
    const { t } = useI18n();
    const props = rootPropsOf(useStoreSlice(handle, selectRoot));
    const fields = React.useMemo(() => chromeRootFields(part) as Record<string, VersoField>, [part]);
    return (
        <>
            <p className="text-xs text-gray-400 mb-4">{t("chrome.admin.selectHint")}</p>
            {Object.keys(fields).length > 0 && (
                <>
                    <h4 className="mb-2 text-[10px] font-black uppercase tracking-widest text-gray-400">{t(`chrome.admin.rootSettings.${part}`)}</h4>
                    {Object.entries(fields).map(([key, field]) => (
                        <VersoFieldControl
                            key={`root:${key}`}
                            field={field}
                            name={key}
                            value={props[key] ?? defaults?.[key]}
                            // An empty choice ("the theme's colours") REMOVES the prop instead of storing
                            // "" — the contract's enum has no empty value and the save would be refused.
                            onChange={(v) => handle.transact((tx) => tx.setRootProps({ [key]: v === "" ? undefined : v }), { coalesceKey: `root:${key}`, label: `Editar ${key}` })}
                        />
                    ))}
                    {part === "header" && props.transparent === true && (
                        <p className="mt-2 text-[11px] text-gray-500">{t("chrome.admin.transparentHint")}</p>
                    )}
                </>
            )}
        </>
    );
}

/** Root props → the context the root wrapper reads (transparent header, full width). */
function RootProvider({ handle, children }: { handle: EditorHandle; children: React.ReactNode }) {
    const props = rootPropsOf(useStoreSlice(handle, selectRoot));
    const transparent = props.transparent === true;
    const width = props.width === "full" ? "full" : "container";
    const overlayText = props.overlayText === "light" || props.overlayText === "dark" ? props.overlayText : undefined;
    const value = React.useMemo<ChromeEditorRoot>(() => ({ transparent, width, overlayText }), [transparent, width, overlayText]);
    return <ChromeRootContext.Provider value={value}>{children}</ChromeRootContext.Provider>;
}

/** The compact screen's bottom tab bar (below xl). Subscribes to the selection so Properties vs Settings is right. */
type SheetTabId = "blocks" | "outline" | "props" | "settings";

function SheetTabs({
    handle,
    sheet,
    tabs,
    onTab,
    label,
}: {
    handle: EditorHandle;
    sheet: ChromeSheet;
    tabs: { id: SheetTabId; icon: string; label: string }[];
    onTab: (id: SheetTabId) => void;
    label: string;
}) {
    // Properties (a block selected) and Settings (nothing selected) share the right sheet.
    const selected = useStoreSlice(handle, selectSelection) !== null;
    const isActive = (id: SheetTabId) =>
        id === "props" ? sheet === "props" && selected : id === "settings" ? sheet === "props" && !selected : sheet === id;
    return (
        <nav className="xl:hidden shrink-0 flex items-stretch border-t border-gray-100 bg-white/95 backdrop-blur pb-[env(safe-area-inset-bottom)]" aria-label={label} data-wjs-chrome-tabs="">
            {tabs.map((tab) => ({ ...tab, active: isActive(tab.id) })).map((tab) => (
                <button
                    key={tab.id}
                    type="button"
                    aria-pressed={tab.active}
                    onClick={() => onTab(tab.id)}
                    data-wjs-chrome-tab={tab.id}
                    className="flex-1 min-w-0 min-h-[52px] flex flex-col items-center justify-center gap-1 px-1"
                >
                    <span className={`w-11 h-7 rounded-lg flex items-center justify-center ${tab.active ? "bg-indigo-100 text-indigo-700" : "text-gray-500"}`}>
                        <i className={`fa-solid ${tab.icon} text-sm`} aria-hidden="true"></i>
                    </span>
                    <span className={`text-[10px] leading-none truncate max-w-full ${tab.active ? "text-indigo-700 font-semibold" : "text-gray-500"}`}>{tab.label}</span>
                </button>
            ))}
        </nav>
    );
}

/** Undo / redo buttons, enabled from the store's own history after every document change. */
function HistoryButtons({ handle }: { handle: EditorHandle }) {
    const { t } = useI18n();
    useStoreSlice(handle, selectDoc); // re-render on every committed change / undo / redo
    const btn = "w-9 h-9 rounded-lg flex items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-30 disabled:hover:bg-transparent transition-colors";
    return (
        <div className="flex items-center gap-1" role="group" aria-label={t("chrome.admin.history")}>
            <button type="button" className={btn} onClick={() => handle.undo()} disabled={!handle.canUndo()} aria-label={t("chrome.admin.undo")} title={`${t("chrome.admin.undo")} (Ctrl+Z)`} data-wjs-chrome-undo="">
                <i className="fa-solid fa-rotate-left" aria-hidden="true"></i>
            </button>
            <button type="button" className={btn} onClick={() => handle.redo()} disabled={!handle.canRedo()} aria-label={t("chrome.admin.redo")} title={`${t("chrome.admin.redo")} (Ctrl+Shift+Z)`} data-wjs-chrome-redo="">
                <i className="fa-solid fa-rotate-right" aria-hidden="true"></i>
            </button>
        </div>
    );
}

export default function ChromeVersoEditor({ part, initialData, onChange, onInit, onApi, rootDefaults }: ChromeVersoEditorProps) {
    const { t } = useI18n();
    const [device, setDevice] = React.useState<ChromeDevice>("desktop");
    // Open the preview at the device the author is holding: on a phone the desktop canvas would be a
    // quarter-size thumbnail. Read once on mount (the window is an external system); the device
    // buttons still switch freely afterwards.
    React.useEffect(() => {
        const w = window.innerWidth;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- lectura única del ancho de la ventana (sistema externo) al montar
        if (w < 768) setDevice("phone");
        else if (w < 1024) setDevice("tablet");
    }, []);
    const [sheet, setSheet] = React.useState<ChromeSheet>(null);
    // Scale-to-fit, the page editor's contract (viewport.ts): the iframe keeps the device's CSS width
    // (so its media queries are the real ones) and the box is shrunk with a transform. The overlay is a
    // sibling inside the same transformed box, so selection geometry stays 1:1 at any scale.
    const areaRef = React.useRef<HTMLDivElement | null>(null);
    const area = useAreaSize(areaRef);
    const CANVAS_PAD = 24;
    const frameW = DEVICE_WIDTH[device];
    const scale = fitScale(area.width - CANVAS_PAD * 2, frameW);
    const availH = Math.max(240, area.height - CANVAS_PAD * 2);

    // Setup identidad-estable por part (la page remonta este componente por key part+mountKey).
    const setup = React.useMemo(() => createChromeVersoSetup(part), [part]);

    // onChange del padre leído por ref: el handle se crea UNA vez por montaje.
    const onChangeRef = React.useRef(onChange);
    React.useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    const handle = React.useMemo<EditorHandle>(
        () =>
            createEditor({
                initialData: initialData as unknown as VersoData,
                isSlot: setup.isSlot,
            }),
        // initialData se lee UNA vez al montar (contrato del editor); el remount por key la renueva.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [setup],
    );
    // El aviso al padre va por SUSCRIPCIÓN al slice del doc, no por el `onChange` nativo de
    // createEditor: pasar el ref a createEditor ocurría DURANTE el render (react-hooks/refs). La
    // cadencia es idéntica — `subscribe` no dispara al suscribirse (siembra su `last` con el slice
    // actual) y el store solo publica un doc nuevo en emitDocChange, es decir una vez por transacción
    // committeada / undo / redo. Es además el mismo cableado que usa VersoEditor.
    React.useEffect(
        () =>
            handle.subscribe(
                () => onChangeRef.current(handle.getData()),
                (s) => s.doc,
            ),
        [handle],
    );
    const geometry = React.useMemo(() => new GeometryStore(), []);
    React.useEffect(
        () => () => {
            handle.destroy();
            geometry.destroy();
        },
        [handle, geometry],
    );

    // Baseline del dirty del padre = la serialización VERSO del doc cargado (ver onInit en props).
    const onInitRef = React.useRef(onInit);
    React.useEffect(() => {
        onInitRef.current = onInit;
    }, [onInit]);
    React.useEffect(() => {
        onInitRef.current?.(handle.getData());
    }, [handle]);

    // API para la página (galería de plantillas, insertar el texto del pie antiguo). replaceData es UNA
    // entrada de historia: aplicar una plantilla se deshace con un solo Ctrl+Z.
    const onApiRef = React.useRef(onApi);
    React.useEffect(() => {
        onApiRef.current = onApi;
    }, [onApi]);
    React.useEffect(() => {
        const api: ChromeEditorApi = {
            replace: (data) => {
                handle.select(null);
                handle.replaceData(withBlockIds(data) as unknown as VersoData);
            },
            append: (blocks) => {
                const stamped = withBlockIds({ root: { props: {} }, content: blocks }).content as unknown as VersoItem[];
                handle.transact((tx) => {
                    let index = handle.getDoc().rootChildren.length;
                    for (const item of stamped) tx.insertNode(item, ROOT_ID, ROOT_SLOT, index++);
                }, { label: "Insertar bloques" });
            },
        };
        onApiRef.current?.(api);
        return () => onApiRef.current?.(null);
    }, [handle]);

    const [frameDoc, setFrameDoc] = React.useState<Document | null>(null);
    const onFrameReady = React.useCallback(
        (doc: Document) => {
            setFrameDoc(doc);
            geometry.attachFrame(doc, doc.defaultView, window);
        },
        [geometry],
    );
    const onBlockElement = React.useCallback(
        (id: string, el: HTMLElement | null) => geometry.registerElement(id, el),
        [geometry],
    );

    // Selección por click sobre el canvas (capture en el doc del iframe — misma técnica Verso).
    // CANVAS INERTE A NAVEGACIÓN (defecto cazado en navegador, paridad C08 con el overlay legacy
    // que se comía los clicks): los bloques de chrome SON enlaces (Logo/Nav/Button renderizan
    // next/link, y el árbol portaleado comparte el router del PADRE — un click navegaba el admin
    // entero a "/"). preventDefault en capture cancela el default del navegador Y el router de
    // next/link (su handleClick respeta defaultPrevented); la selección sigue funcionando.
    // Los BOTONES de los bloques (la hamburguesa del menú en la vista de móvil) tampoco se accionan:
    // su drawer se portalea al documento del ADMIN y taparía el editor. stopPropagation en capture
    // impide que React reciba el click; seleccionar el bloque sigue funcionando.
    React.useEffect(() => {
        if (!frameDoc) return;
        const onClick = (e: Event) => {
            const target = e.target as Element | null;
            if (target?.closest?.("a, button, [type='submit'], summary")) {
                e.preventDefault();
                e.stopPropagation();
            }
            const el = target?.closest?.("[data-wjs-block-id]") ?? null;
            handle.select(el ? el.getAttribute("data-wjs-block-id") : null);
        };
        frameDoc.addEventListener("click", onClick, true);
        return () => frameDoc.removeEventListener("click", onClick, true);
    }, [frameDoc, handle]);

    // Escape cierra la hoja abierta (pantalla compacta), como en el editor de páginas.
    React.useEffect(() => {
        if (!sheet) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSheet(null); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [sheet]);

    // Undo/redo por teclado en la ventana Y en el iframe.
    React.useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || isTypingTarget(e.target)) return;
            const key = e.key.toLowerCase();
            if (key === "z") {
                e.preventDefault();
                if (e.shiftKey) handle.redo();
                else handle.undo();
            } else if (key === "y") {
                e.preventDefault();
                handle.redo();
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        const frameWin = frameDoc?.defaultView;
        frameWin?.addEventListener("keydown", onKeyDown, true);
        return () => {
            window.removeEventListener("keydown", onKeyDown, true);
            frameWin?.removeEventListener("keydown", onKeyDown, true);
        };
    }, [handle, frameDoc]);

    // Tap-to-insert (además del drag del DnDDriver): tras la selección o al final de la raíz,
    // materializando los slots declarados que defaultProps no trae (ChromeRow.items) — la técnica
    // compartida de las superficies Verso.
    const insertType = React.useCallback(
        (type: string) => {
            const def = setup.registry.get(type);
            if (!def) return;
            const id = `${type}-${crypto.randomUUID()}`;
            let defaults: Record<string, unknown>;
            try {
                defaults = structuredClone(def.defaultProps);
            } catch {
                defaults = { ...def.defaultProps };
            }
            const item: VersoItem = { type, props: { ...defaults, id } };
            for (const [fieldKey, field] of Object.entries(def.fields)) {
                if (field.type === "slot" && !(fieldKey in item.props)) item.props[fieldKey] = [];
            }
            const doc = handle.getDoc();
            const selected = handle.getState().selection.nodeId;
            const node = selected ? doc.nodes[selected] : undefined;
            const parentId = node ? node.parentId : ROOT_ID;
            const slotKey = node ? node.slotKey : ROOT_SLOT;
            const index = node ? node.index + 1 : doc.rootChildren.length;
            if (handle.transact((tx) => tx.insertNode(item, parentId, slotKey, index), { label: `Insertar ${type}` })) {
                handle.select(id);
                // On a compact screen the palette sheet covers the canvas: close it to show the result.
                if (isCompact()) setSheet(null);
            }
        },
        [setup, handle],
    );

    const RootWrapper = setup.RootWrapper;

    // Docked side panes from xl; below it they are sheets over the canvas (see the header comment).
    const sheetBase = "absolute inset-y-0 z-30 w-[min(420px,100%)] bg-white shadow-2xl overflow-y-auto custom-scrollbar xl:static xl:z-auto xl:shadow-none xl:block";
    const leftOpen = sheet === "blocks" || sheet === "outline";
    const tabs: { id: SheetTabId; icon: string; label: string }[] = [
        { id: "blocks", icon: "fa-shapes", label: t("chrome.admin.pane.blocks") },
        { id: "outline", icon: "fa-layer-group", label: t("chrome.admin.pane.outline") },
        { id: "props", icon: "fa-sliders", label: t("chrome.admin.pane.fields") },
        { id: "settings", icon: "fa-gear", label: t("chrome.admin.tab.settings") },
    ];

    return (
        <div className="flex flex-col h-full min-h-0 w-full" data-wjs-chrome-verso={part}>
        <div className="relative flex flex-1 h-full min-h-0 w-full overflow-hidden">
            {/* Velo de las hojas (solo pantalla compacta): tocarlo cierra la hoja. */}
            {sheet && (
                <button
                    type="button"
                    aria-label={t("close")}
                    onClick={() => setSheet(null)}
                    className="xl:hidden absolute inset-0 z-20 bg-gray-900/30 backdrop-blur-[1px]"
                />
            )}

            {/* Izquierda: paleta de bloques (drag + tap) y estructura — acoplada en xl, hoja debajo */}
            <aside
                className={`${sheetBase} left-0 xl:w-64 xl:shrink-0 border-r border-gray-100 ${leftOpen ? "block" : "hidden"}`}
                data-wjs-palette=""
                data-wjs-chrome-sheet={leftOpen ? sheet : undefined}
            >
                <div className={`p-3 border-b border-gray-50 ${sheet === "outline" ? "max-xl:hidden" : ""}`}>
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                        {t("chrome.admin.pane.blocks")}
                    </h3>
                    <div className="grid grid-cols-2 xl:grid-cols-1 gap-1">
                        {setup.registry.list().map((def) => (
                            <button
                                key={def.type}
                                type="button"
                                data-wjs-palette-type={def.type}
                                onClick={() => insertType(def.type)}
                                className="w-full text-left px-3 py-2 max-xl:min-h-11 rounded-lg border border-gray-100 bg-white text-xs font-semibold text-gray-600 hover:border-indigo-200 hover:text-indigo-600 transition-colors cursor-grab"
                            >
                                {def.label ?? def.type}
                            </button>
                        ))}
                    </div>
                </div>
                <div className={`p-3 ${sheet === "blocks" ? "max-xl:hidden" : ""}`}>
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                        {t("chrome.admin.pane.outline")}
                    </h3>
                    <OutlineTree handle={handle} registry={setup.registry} />
                </div>
            </aside>

            {/* Centro: barra (deshacer/rehacer + dispositivo) y canvas en card. `relative` para que la
                capa overlay hermana del iframe comparta su sistema de coordenadas 1:1. */}
            <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
                <div className="shrink-0 flex items-center justify-between gap-2 px-3 md:px-6 py-2 border-b border-gray-100 bg-white">
                    <HistoryButtons handle={handle} />
                    <div className="flex items-center bg-gray-100 rounded-xl p-1 gap-1" role="group" aria-label={t("chrome.admin.device")}>
                        {DEVICES.map((d) => (
                            <button
                                key={d.id}
                                type="button"
                                onClick={() => setDevice(d.id)}
                                aria-pressed={device === d.id}
                                aria-label={t(`chrome.admin.device.${d.id}`)}
                                data-wjs-chrome-device={d.id}
                                title={t(`chrome.admin.device.${d.id}`)}
                                className={`flex items-center justify-center gap-2 px-3 py-1.5 max-xl:min-h-9 max-xl:min-w-11 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${device === d.id ? "bg-white text-indigo-600 shadow-sm" : "text-gray-400 hover:text-gray-600"}`}
                            >
                                <i className={`fa-solid ${d.icon}`} aria-hidden="true"></i>
                                <span className="hidden 2xl:inline">{t(`chrome.admin.device.${d.id}`)}</span>
                            </button>
                        ))}
                    </div>
                    <span className="hidden sm:inline text-[10px] font-bold uppercase tracking-widest text-gray-300 w-24 text-right" data-wjs-chrome-scale="">
                        {frameW}px{scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}
                    </span>
                </div>
                <div ref={areaRef} className="flex-1 min-h-0 overflow-hidden relative">
                    <div className="absolute inset-0 flex items-start justify-center" style={{ padding: CANVAS_PAD }}>
                    <div
                        className="relative shrink-0 bg-white shadow-xl rounded-xl overflow-hidden border border-gray-200"
                        style={{ width: frameW * scale, height: availH }}
                    >
                    <div
                        className="absolute top-0 left-0 origin-top-left"
                        style={{ width: frameW, height: availH / scale, transform: scale === 1 ? "none" : `scale(${scale})` }}
                        data-wjs-chrome-canvas={device}
                    >
                        <ChromeDeviceContext.Provider value={device}>
                            <RootProvider handle={handle}>
                                <FrameController
                                    title={t("chrome.admin.canvasTitle")}
                                    onFrameReady={onFrameReady}
                                    overlay={
                                        <>
                                            <OverlayLayer
                                                handle={handle}
                                                registry={setup.registry}
                                                geometry={geometry}
                                                frameDocument={frameDoc}
                                            />
                                            <DnDDriver
                                                handle={handle}
                                                registry={setup.registry}
                                                geometry={geometry}
                                                frameDocument={frameDoc}
                                            />
                                        </>
                                    }
                                >
                                    <RootWrapper>
                                        <EditorRenderer
                                            handle={handle}
                                            registry={setup.registry}
                                            componentMap={setup.componentMap}
                                            onBlockElement={onBlockElement}
                                            editorChrome
                                        />
                                    </RootWrapper>
                                </FrameController>
                            </RootProvider>
                        </ChromeDeviceContext.Provider>
                    </div>
                    </div>
                    </div>
                </div>
            </div>

            {/* Derecha: campos del bloque seleccionado (o de la raíz) — acoplada en xl, hoja debajo */}
            <aside
                className={`${sheetBase} right-0 xl:w-72 xl:shrink-0 border-l border-gray-100 ${sheet === "props" ? "block" : "hidden"}`}
                data-wjs-chrome-sheet={sheet === "props" ? "props" : undefined}
            >
                <div className="p-3">
                    <div className="flex items-center justify-between mb-2">
                        <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                            {t("chrome.admin.pane.fields")}
                        </h3>
                        <button type="button" onClick={() => setSheet(null)} className="xl:hidden w-11 h-11 -m-2 rounded-lg text-gray-400 hover:text-gray-700" aria-label={t("close")}>
                            <i className="fa-solid fa-xmark" aria-hidden="true"></i>
                        </button>
                    </div>
                    <SelectedBlockFields handle={handle} registry={setup.registry} part={part} rootDefaults={rootDefaults} />
                </div>
            </aside>
        </div>

            {/* Navegación compacta — móvil y tableta, como la del editor de páginas. */}
            <SheetTabs handle={handle} sheet={sheet} tabs={tabs} onTab={(id) => {
                if (id === "settings") {
                    handle.select(null);
                    setSheet("props");
                    return;
                }
                setSheet((current) => (current === id ? null : id));
            }} label={t("chrome.admin.tabs")} />
        </div>
    );
}

"use client";
/**
 * VersoEditor — wrapper de chrome del motor Verso (F3, el encargo núcleo).
 *
 * PIEL: réplica del editor actual según documentation/verso/wrapper-blueprint.md — mismas clases,
 * mismos tokens --ed-* (única fuente: puck-theme.css, importada aquí igual que en PuckEditor —
 * jamás redeclarados), mismos glifos del subset Material Symbols (todos los usados aquí están en
 * la lista de 161 del blueprint §c), mismos strings ES fuente (trStr → es/en/pt sin tocar el
 * diccionario salvo los 6 placeholders nuevos, añadidos a puckI18n con su tripleta).
 *
 * MOTOR: createEditor + registry de bloques core (registerCoreBlocks) + FrameController (iframe
 * /admin/canvas-frame + portal) + EditorRenderer + OverlayLayer + DnDDriver — el mismo conjunto
 * verificado en el Verso Lab; el chrome solo emite comandos, nunca muta el documento.
 *
 * CONTRATOS DUROS de esta ola:
 *  - localStorage `puck_show_sidebar` / `puck_show_properties` para el plegado de paneles (leídos
 *    al montar ANTES de persistir; los sheets móviles son estado aparte y no los contaminan).
 *  - Autosave por lib/autosavePolicy.ts (pisos 8000/30000, flag {autosave:true}, ok===false no
 *    estampa) y guardado manual con toast solo en éxito — cableado en saveFlow.ts (testeado).
 *  - El padre lee el documento vivo vía `handleRef` (EditorHandle.getData(), sin mirrors).
 *
 * PLACEHOLDERS DOCUMENTADOS (olas posteriores, presentes pero deshabilitados — nunca omitidos):
 *  - Plantillas/patrones (rail + panel), Recursos/media library (rail), Notas (W24) e Historial
 *    (W23) → ola 3; los botones se pintan con su glifo/label y title explicativo.
 *  - CommandPalette ⌘K → esta ola abre un placeholder modal (la paleta completa es ola 3).
 *  - Guías y contornos (W06/W56): canvasGuides depende del atributo data-puck-component del motor
 *    viejo — botón presente y deshabilitado hasta portarlo a data-wjs-block-id.
 *  - Presencia (W09), a11y (W20/W25), revisiones (W23), notas (W24), clipboard Ctrl+C/V (parte de
 *    W03) → olas posteriores; no se pintan controles muertos que fingirían funcionar.
 */
import "@/components/puck-theme.css";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MSym from "@/components/editor/MSym";
import ModernSelect from "@/components/ModernSelect";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";
import { replayAnimations } from "@/components/puck/AnimationField";
import {
    computeAutosaveWaitMs,
    shouldRunAutosave,
} from "@/lib/autosavePolicy";
import { createEditor, type EditorHandle } from "@/lib/verso/store";
import { createBlockRegistry, makeSlotResolver, type BlockRegistry, type VersoField } from "@/lib/verso/registry";
import { registerCoreBlocks } from "@/lib/verso/coreBlocks";
import { ROOT_ID, ROOT_SLOT, type VersoData, type VersoEditorState, type VersoItem } from "@/lib/verso/types";
import EditorRenderer from "../render/EditorRenderer";
import { useStoreSlice, type VersoComponentMap } from "../render/context";
import FrameController from "../canvas/FrameController";
import { useAreaSize } from "../canvas/ViewportControls";
import { DEVICE_WIDTHS, type DeviceKind } from "../canvas/viewport";
import { GeometryStore } from "../overlay/GeometryStore";
import OverlayLayer from "../overlay/OverlayLayer";
import DnDDriver from "../dnd/DnDDriver";
import { editSelectedInline } from "../overlay/actionBarCommands";
import EditorHotkeys from "./EditorHotkeys";
import SaveStateChip from "./SaveStateChip";
import BlockPalette from "./BlockPalette";
import OutlineTree from "./OutlineTree";
import PropertiesPanel from "./PropertiesPanel";
import { runBackgroundSave, runManualSave, type OnSave } from "./saveFlow";

export interface VersoEditorProps {
    /** Documento inicial (la forma persistida `_puck_data`). Se lee UNA vez al montar. */
    initialData?: VersoData;
    /** Una llamada por transacción confirmada / undo / redo, con el doc serializado. */
    onChange: (data: VersoData) => void;
    status?: string;
    onStatusChange?: (status: string) => void;
    saving?: boolean;
    hasChanges?: boolean;
    /** Contrato onSave del wrapper actual: false = bloqueado/fallido (sin stamp/toast). */
    onSave?: OnSave;
    onCancel?: () => void;
    pageId?: number;
    /** Slug del registro — habilita "Vista Previa" (/preview/slug). */
    previewSlug?: string;
    /** Raíz del breadcrumb (string ES fuente, traducido con trStr) — "Entradas" en posts. */
    breadcrumbRoot?: string;
    /** Campos ROOT del tipo (rootFieldsPage / rootFieldsPost) — la asimetría del CMS (W41). */
    rootFields: Record<string, VersoField>;
    /**
     * Expone el EditorHandle vivo al camino de guardado del padre (getData() sin mirrors,
     * commitInline() como flush pre-guardado — el sustituto de window.puckGetData/puckCommitActive).
     */
    handleRef?: React.MutableRefObject<EditorHandle | null>;
}

const VIEWPORT_ICON: Record<DeviceKind, string> = {
    desktop: "desktop_windows",
    tablet: "tablet_mac",
    mobile: "smartphone",
};
const VIEWPORT_LABEL: Record<DeviceKind, string> = {
    desktop: "Escritorio",
    tablet: "Tableta",
    mobile: "Móvil",
};
const VIEWPORT_ORDER: DeviceKind[] = ["desktop", "tablet", "mobile"];

const selectState = (s: VersoEditorState): VersoEditorState => s;

const isPhone = () => typeof window !== "undefined" && window.innerWidth < 768;

/** Segmented control del header (piel exacta del ViewportControls del editor actual). */
function HeaderViewportControls({ value, onChange }: { value: DeviceKind; onChange: (v: DeviceKind) => void }) {
    const { language } = useI18n();
    return (
        <div className="hidden lg:flex items-center bg-[var(--ed-surface-container)] p-0.5 rounded-lg">
            {VIEWPORT_ORDER.map((v) => (
                <button
                    key={v}
                    type="button"
                    title={trStr(VIEWPORT_LABEL[v], language)}
                    aria-label={trStr(VIEWPORT_LABEL[v], language)}
                    aria-pressed={value === v}
                    onClick={() => onChange(v)}
                    className={`px-2 py-1 rounded-md flex items-center justify-center transition-colors ${
                        value === v
                            ? "bg-white shadow-sm text-[var(--ed-primary)]"
                            : "text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-primary)]"
                    }`}
                >
                    <MSym name={VIEWPORT_ICON[v]} size={18} />
                </button>
            ))}
        </div>
    );
}

/** Undo/redo del header — piel exacta de HistoryControls, sobre el handle de Verso (W01). */
function HistoryControls({ handle }: { handle: EditorHandle }) {
    const { language } = useI18n();
    // El chrome re-renderiza con cada notificación del store (useStoreSlice en el padre): leer
    // canUndo/canRedo directo del handle aquí es correcto porque este componente re-renderiza con él.
    const btn = (enabled: boolean, icon: string, title: string, onClick: () => void) => (
        <button
            type="button"
            title={title}
            disabled={!enabled}
            onClick={onClick}
            className={`p-1.5 rounded-md flex items-center justify-center transition-colors ${
                enabled
                    ? "text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
                    : "text-[var(--ed-outline-variant)] cursor-not-allowed"
            }`}
        >
            <MSym name={icon} size={20} />
        </button>
    );
    return (
        <div className="flex items-center gap-0.5">
            {btn(handle.canUndo(), "undo", trStr("Deshacer (Ctrl+Z)", language), () => handle.undo())}
            {btn(handle.canRedo(), "redo", trStr("Rehacer (Ctrl+Shift+Z)", language), () => handle.redo())}
        </div>
    );
}

export default function VersoEditor({
    initialData,
    onChange,
    status = "draft",
    onStatusChange,
    saving = false,
    hasChanges = true,
    onSave,
    onCancel,
    pageId,
    previewSlug,
    breadcrumbRoot,
    rootFields,
    handleRef,
}: VersoEditorProps) {
    const { t, language } = useI18n();

    /* ---------------- motor: registry + handle + geometría ---------------- */

    const registry = useMemo<BlockRegistry>(() => {
        const r = createBlockRegistry();
        registerCoreBlocks(r);
        return r;
    }, []);
    const componentMap = useMemo<VersoComponentMap>(() => {
        const map: VersoComponentMap = {};
        for (const def of registry.list()) map[def.type] = def.render as VersoComponentMap[string];
        return map;
    }, [registry]);

    // El handle se crea UNA vez (los cambios posteriores del prop initialData no recrean el
    // editor — mismo contrato que el `data` no controlado del wrapper actual).
    const [handle] = useState<EditorHandle>(() =>
        createEditor({
            initialData: initialData ?? { content: [], root: {} },
            isSlot: makeSlotResolver(registry),
        }),
    );
    // onChange del padre: suscripción por slice del doc (una notificación por transacción
    // confirmada / undo / redo — la misma cadencia que el onChange nativo de createEditor),
    // vía ref para que un callback inline no re-suscriba.
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);
    useEffect(
        () =>
            handle.subscribe(
                () => onChangeRef.current(handle.getData()),
                (s) => s.doc,
            ),
        [handle],
    );
    const geometry = useMemo(() => new GeometryStore(), []);
    useEffect(
        () => () => {
            handle.destroy();
            geometry.destroy();
        },
        [handle, geometry],
    );

    // Handle vivo para el camino de guardado del padre (getData sin mirrors, W49).
    useEffect(() => {
        if (!handleRef) return;
        handleRef.current = handle;
        return () => {
            handleRef.current = null;
        };
    }, [handle, handleRef]);

    const state = useStoreSlice(handle, selectState);
    const isDragging = state.dragPreview !== null;
    const rootProps = (state.doc.root.props as Record<string, unknown> | undefined) ?? {};
    const docTitle =
        (typeof rootProps.title === "string" && rootProps.title) ||
        (typeof state.doc.root.title === "string" && state.doc.root.title) ||
        "";

    /* ---------------- canvas: frame + selección + inline ---------------- */

    const [frameDoc, setFrameDoc] = useState<Document | null>(null);
    const onFrameReady = useCallback(
        (doc: Document) => {
            setFrameDoc(doc);
            geometry.attachFrame(doc, doc.defaultView, window);
        },
        [geometry],
    );
    const onBlockElement = useCallback(
        (id: string, el: HTMLElement | null) => geometry.registerElement(id, el),
        [geometry],
    );

    // Selección por click + edición inline por doble click (capture en el doc del iframe).
    useEffect(() => {
        if (!frameDoc) return;
        const onClick = (e: Event) => {
            const target = e.target as Element | null;
            const el = target?.closest?.("[data-wjs-block-id]") ?? null;
            handle.select(el ? el.getAttribute("data-wjs-block-id") : null);
        };
        const onDblClick = (e: Event) => {
            const target = e.target as Element | null;
            const id = target?.closest?.("[data-wjs-block-id]")?.getAttribute("data-wjs-block-id");
            if (id) editSelectedInline(handle, registry, id);
        };
        frameDoc.addEventListener("click", onClick, true);
        frameDoc.addEventListener("dblclick", onDblClick, true);
        return () => {
            frameDoc.removeEventListener("click", onClick, true);
            frameDoc.removeEventListener("dblclick", onDblClick, true);
        };
    }, [frameDoc, handle, registry]);

    /* ---------------- inserción (paleta / tap) ---------------- */

    const insertType = useCallback(
        (type: string) => {
            const def = registry.get(type);
            if (!def) return;
            const id = crypto.randomUUID();
            let defaults: Record<string, unknown>;
            try {
                defaults = structuredClone(def.defaultProps);
            } catch {
                defaults = { ...def.defaultProps };
            }
            const item: VersoItem = { type, props: { ...defaults, id } };
            // Materializa los slots declarados que defaultProps no trae (contenedores recién
            // insertados sin zona de drop) — mismo criterio que el Verso Lab.
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
            }
        },
        [registry, handle],
    );

    /* ---------------- chrome UI state + prefs persistidas ---------------- */

    const [showSidebar, setShowSidebar] = useState(true);
    const [showProperties, setShowProperties] = useState(true);
    const [isUiLoaded, setIsUiLoaded] = useState(false);
    const [railView, setRailView] = useState<"blocks" | "outline" | "patterns">("blocks");
    const [mobileSheet, setMobileSheet] = useState<"left" | "right" | null>(null);
    const [viewport, setViewport] = useState<DeviceKind>("desktop");
    const [cmdkOpen, setCmdkOpen] = useState(false);
    const [toastMsg, setToastMsg] = useState<string | null>(null);
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const [lastSaveWasAuto, setLastSaveWasAuto] = useState(false);

    // Contrato duro (W13): mismas claves EXACTAS que el editor actual, cargadas al montar ANTES
    // de persistir (para no pisar el default). localStorage no existe en SSR — no puede ser un
    // useState initializer (impuro en render); es la misma secuencia del PuckEditor actual.
    useEffect(() => {
        const savedSidebar = localStorage.getItem("puck_show_sidebar");
        const savedProps = localStorage.getItem("puck_show_properties");
        // eslint-disable-next-line react-hooks/set-state-in-effect -- hidratación única de preferencias desde un sistema externo al montar
        if (savedSidebar !== null) setShowSidebar(savedSidebar === "true");
        if (savedProps !== null) setShowProperties(savedProps === "true");
        setIsUiLoaded(true);
    }, []);
    useEffect(() => {
        if (isUiLoaded) localStorage.setItem("puck_show_sidebar", String(showSidebar));
    }, [showSidebar, isUiLoaded]);
    useEffect(() => {
        if (isUiLoaded) localStorage.setItem("puck_show_properties", String(showProperties));
    }, [showProperties, isUiLoaded]);

    useEffect(() => {
        if (!toastMsg) return;
        const timer = setTimeout(() => setToastMsg(null), 4000);
        return () => clearTimeout(timer);
    }, [toastMsg]);

    /* ---------------- guardado: manual + autosave + preview ---------------- */

    const handleManualSave = useCallback(async () => {
        if (!onSave) return;
        const ok = await runManualSave(onSave);
        if (!ok) return;
        setSavedAt(new Date());
        setLastSaveWasAuto(false);
        setToastMsg(trStr("¡Cambios guardados con éxito!", language));
    }, [onSave, language]);

    // Autosave: solo drafts, pisos 8000/30000 (autosavePolicy), flag {autosave:true}, un fallo
    // (ok===false o excepción) no estampa nada — mismo efecto que el wrapper actual (W10).
    const lastAutosaveRef = useRef(0);
    useEffect(() => {
        if (!shouldRunAutosave({ status, hasOnSave: !!onSave, hasChanges, saving })) return;
        if (!onSave) return; // narrowing TS; shouldRunAutosave ya lo exigió
        const wait = computeAutosaveWaitMs(Date.now(), lastAutosaveRef.current);
        const timer = setTimeout(async () => {
            lastAutosaveRef.current = Date.now();
            const ok = await runBackgroundSave(onSave);
            if (!ok) return;
            setSavedAt(new Date());
            setLastSaveWasAuto(true);
        }, wait);
        return () => clearTimeout(timer);
    }, [status, onSave, hasChanges, saving]);

    // Vista previa real (W12): guarda primero si hay cambios (ignora el error — se previsualiza
    // lo último guardado) y abre /preview/<slug> en pestaña nueva.
    const handlePreview = useCallback(async () => {
        try {
            if (hasChanges && onSave) await onSave();
        } catch {
            /* preview igualmente — el usuario ve el último estado guardado */
        }
        if (previewSlug) window.open(`/preview/${previewSlug}`, "_blank", "noopener");
    }, [hasChanges, onSave, previewSlug]);

    /* ---------------- geometría del canvas (piel PreviewFrame) ---------------- */

    const areaRef = useRef<HTMLDivElement | null>(null);
    const area = useAreaSize(areaRef);
    const isDesktop = viewport === "desktop";
    const isNarrow = area.width > 0 && area.width < 640;
    const PAD = isNarrow ? 12 : isDesktop ? 28 : 24;
    const availW = Math.max(280, area.width - PAD * 2);
    const availH = Math.max(320, area.height - PAD * 2);
    const frameW = isNarrow ? availW : DEVICE_WIDTHS[viewport];
    const scale = Math.min(1, availW / frameW);
    const innerH = availH / scale;
    // Nota: no hace falta el hack de resize a 350ms del editor viejo — el ResizeObserver de
    // useAreaSize re-mide solo mientras la transición de anchura del panel corre (W14).

    const emptyCanvas = state.doc.rootChildren.length === 0;

    const railItems = [
        { id: "blocks" as const, icon: "add_box", label: trStr("Bloques", language) },
        { id: "outline" as const, icon: "layers", label: trStr("Estructura", language) },
        { id: "patterns" as const, icon: "dashboard_customize", label: trStr("Plantillas", language) },
    ];

    return (
        <div className="puck-container fixed inset-0 z-50 bg-[var(--ed-surface)]">
            <div className="flex flex-col h-screen w-full overflow-hidden">
                {/* Capa global de atajos (capture en window + iframe; re-attach en onFrameReady) */}
                <EditorHotkeys
                    handle={handle}
                    frameDocument={frameDoc}
                    onSave={handleManualSave}
                    onCommandPalette={() => setCmdkOpen((v) => !v)}
                />

                {/* HEADER — 48px, 3 grupos, hairline inferior (blueprint §a) */}
                <div className="h-12 shrink-0 z-20 relative flex items-center justify-between gap-3 px-3 bg-[var(--ed-surface)] border-b border-[var(--ed-outline-variant)]">
                    {/* Izquierda: wordmark + breadcrumb */}
                    <div className="flex items-center gap-3 min-w-0">
                        {onCancel && (
                            <button
                                type="button"
                                onClick={onCancel}
                                title={t("editor.cancel")}
                                aria-label={t("editor.cancel")}
                                className="md:hidden w-8 h-8 -ml-1 shrink-0 rounded-md flex items-center justify-center text-[var(--ed-on-surface-variant)] active:bg-[var(--ed-surface-container)]"
                            >
                                <MSym name="chevron_left" size={22} />
                            </button>
                        )}
                        <span className="text-[18px] font-black tracking-tight text-[var(--ed-primary)] select-none shrink-0">
                            WordJS
                        </span>
                        <div className="h-4 w-px bg-[var(--ed-outline-variant)] hidden md:block"></div>
                        <div className="hidden md:flex items-center gap-1.5 text-[12px] text-[var(--ed-on-surface-variant)] min-w-0">
                            {onCancel ? (
                                <button
                                    type="button"
                                    onClick={onCancel}
                                    title={t("editor.cancel")}
                                    className="shrink-0 px-1 py-0.5 rounded hover:bg-[var(--ed-surface-container)] hover:text-[var(--ed-primary)] transition-colors"
                                >
                                    {trStr(breadcrumbRoot || "Páginas", language)}
                                </button>
                            ) : (
                                <span className="shrink-0">{trStr(breadcrumbRoot || "Páginas", language)}</span>
                            )}
                            <MSym name="chevron_right" size={12} className="opacity-50 shrink-0" />
                            <span className="font-semibold text-[var(--ed-on-surface)] truncate max-w-[220px]">
                                {docTitle || trStr("Sin título", language)}
                            </span>
                        </div>
                    </div>

                    {/* Centro: viewports · historia · estado de guardado */}
                    <div className="flex items-center gap-3 shrink-0">
                        <HeaderViewportControls value={viewport} onChange={setViewport} />
                        <div className="h-4 w-px bg-[var(--ed-outline-variant)] hidden md:block"></div>
                        <HistoryControls handle={handle} />
                        {onSave && (
                            <SaveStateChip
                                saving={saving}
                                hasChanges={hasChanges}
                                savedAt={savedAt}
                                wasAuto={lastSaveWasAuto}
                                status={status}
                            />
                        )}
                        {/* Presencia (W09): llega en una ola posterior — el chip solo existe con coeditores. */}
                    </div>

                    {/* Derecha: insertar · replay · guías · propiedades · estado · preview · guardar · avatar */}
                    <div className="flex items-center gap-2 min-w-0">
                        <button
                            type="button"
                            onClick={() => setCmdkOpen(true)}
                            title={trStr("Insertar bloque (Ctrl/⌘ + K)", language)}
                            className="hidden lg:flex items-center gap-2 h-7 px-2.5 rounded-md border border-[var(--ed-outline-variant)] text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] transition-colors"
                        >
                            <MSym name="search" size={14} />
                            <span className="text-[11px]">{trStr("Insertar", language)}</span>
                            <kbd
                                className="text-[9px] text-[var(--ed-on-surface-variant)] bg-[var(--ed-surface-container)] rounded px-1 py-0.5 leading-none"
                                style={{ fontFamily: "var(--puck-font-family-monospaced)" }}
                            >⌘K</kbd>
                        </button>

                        <button
                            type="button"
                            onClick={() => {
                                if (frameDoc) replayAnimations(frameDoc);
                            }}
                            title={trStr("Reproducir las animaciones de entrada", language)}
                            className="hidden md:flex w-7 h-7 rounded-md items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] transition-colors"
                        >
                            <MSym name="play_arrow" size={18} />
                        </button>

                        {/* Guías (W06/W56): canvasGuides aún opera sobre data-puck-component — placeholder
                            deshabilitado y documentado hasta portarlo a data-wjs-block-id (ola posterior). */}
                        <button
                            type="button"
                            disabled
                            className="hidden md:flex w-7 h-7 rounded-md items-center justify-center text-[var(--ed-outline-variant)] cursor-not-allowed"
                            title={trStr("Las guías llegan en una ola posterior.", language)}
                            aria-pressed={false}
                        >
                            <MSym name="grid_view" size={16} />
                        </button>

                        <button
                            type="button"
                            onClick={() => setShowProperties(!showProperties)}
                            className={`hidden md:flex w-7 h-7 rounded-md items-center justify-center transition-colors ${showProperties ? "bg-[var(--ed-surface-container-high)] text-[var(--ed-primary)]" : "text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"}`}
                            title={showProperties ? t("editor.hideProperties") : t("editor.showProperties")}
                        >
                            <MSym name="tune" size={18} />
                        </button>

                        {onStatusChange && (
                            <div className="hidden md:block">
                                <ModernSelect
                                    value={status}
                                    onChange={(e) => onStatusChange(e.target.value)}
                                    options={[
                                        { value: "draft", label: t("editor.status.draft") },
                                        { value: "publish", label: t("editor.status.publish") },
                                        { value: "pending", label: t("editor.status.pending") },
                                    ]}
                                    placeholder={trStr("Select an option", language)}
                                    className="!py-1 !px-2 !bg-[var(--ed-surface-container)] !border-[var(--ed-outline-variant)] !rounded-md !text-[11px] min-w-[104px]"
                                />
                            </div>
                        )}

                        {previewSlug && (
                            <button
                                type="button"
                                onClick={handlePreview}
                                disabled={saving}
                                title={trStr("Vista previa en el sitio real (los borradores solo los ves tú)", language)}
                                className="hidden md:block px-4 py-1.5 rounded-lg text-[12px] font-medium text-[var(--ed-on-surface)] border border-[var(--ed-outline-variant)] hover:bg-[var(--ed-surface-container)] active:scale-95 duration-75 transition disabled:opacity-50"
                            >
                                {trStr("Vista Previa", language)}
                            </button>
                        )}

                        {onSave && (
                            <button
                                type="button"
                                onClick={handleManualSave}
                                disabled={saving || (!hasChanges && state.inlineEditingId === null)}
                                className="px-4 py-1.5 rounded-lg text-[12px] font-medium text-white bg-[var(--ed-primary)] hover:opacity-90 active:scale-95 duration-75 transition disabled:opacity-40 flex items-center gap-2"
                            >
                                {saving && <MSym name="sync" size={12} className="animate-spin" />}
                                {status === "draft" ? trStr("Guardar", language) : trStr("Publicar", language)}
                            </button>
                        )}

                        <div className="hidden md:flex w-8 h-8 rounded-full bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)] items-center justify-center shrink-0 border border-[var(--ed-outline-variant)]">
                            <MSym name="person" size={16} fill />
                        </div>
                    </div>
                </div>

                {/* ÁREA DE CONTENIDO */}
                <div className="relative flex-1 w-full bg-[var(--ed-surface-container-low)] overflow-hidden flex flex-col min-h-0 md:flex-row pb-14 md:pb-0">
                    {/* RAIL — 64px (blueprint §a). Plantillas presente (placeholder ola 3);
                        Recursos/Notas/Historial deshabilitados y documentados; Ajustes REAL. */}
                    <nav className="hidden md:flex w-16 shrink-0 bg-[var(--ed-surface)] border-r border-[var(--ed-outline-variant)] flex-col items-center py-2 gap-1 z-30">
                        {railItems.map((item) => {
                            const active = showSidebar && railView === item.id;
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => {
                                        if (showSidebar && railView === item.id) setShowSidebar(false);
                                        else {
                                            setRailView(item.id);
                                            setShowSidebar(true);
                                        }
                                    }}
                                    title={item.label}
                                    aria-pressed={active}
                                    className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors ${active
                                        ? "bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)]"
                                        : "text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)]"}`}
                                >
                                    <MSym name={item.icon} size={20} fill={active} />
                                    <span className="text-[9px] leading-none">{item.label}</span>
                                </button>
                            );
                        })}

                        <button
                            type="button"
                            disabled
                            title={trStr("La biblioteca de medios llega en una ola posterior.", language)}
                            className="w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 text-[var(--ed-outline-variant)] cursor-not-allowed"
                        >
                            <MSym name="image" size={20} />
                            <span className="text-[9px] leading-none">{trStr("Recursos", language)}</span>
                        </button>

                        <div className="mt-auto flex flex-col items-center gap-1">
                            {pageId && (
                                <button
                                    type="button"
                                    disabled
                                    title={trStr("Las notas de revisión llegan en una ola posterior.", language)}
                                    className="w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 text-[var(--ed-outline-variant)] cursor-not-allowed"
                                >
                                    <MSym name="forum" size={20} />
                                    <span className="text-[9px] leading-none">{trStr("Notas", language)}</span>
                                </button>
                            )}
                            {pageId && (
                                <button
                                    type="button"
                                    disabled
                                    title={trStr("El historial de revisiones llega en una ola posterior.", language)}
                                    className="w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 text-[var(--ed-outline-variant)] cursor-not-allowed"
                                >
                                    <MSym name="history" size={20} />
                                    <span className="text-[9px] leading-none">{trStr("Historial", language)}</span>
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => {
                                    // Deselecciona → el panel derecho cae a los campos ROOT (ajustes).
                                    handle.select(null);
                                    setShowProperties(true);
                                }}
                                title={trStr("Ajustes de página", language)}
                                className="w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                            >
                                <MSym name="settings" size={20} />
                                <span className="text-[9px] leading-none">{trStr("Ajustes", language)}</span>
                            </button>
                        </div>
                    </nav>

                    {/* PANEL IZQUIERDO — 280px docked / sheet móvil; `inert` al colapsar */}
                    <div
                        inert={!showSidebar && mobileSheet !== "left"}
                        className={`flex-col bg-[var(--ed-surface-container-lowest)] border-r border-[var(--ed-outline-variant)] md:transition-[width,opacity] duration-200 ease-in-out ${mobileSheet === "left" ? "flex fixed inset-x-0 top-12 bottom-14 z-40" : "hidden"} md:flex md:static md:inset-auto md:z-30 ${showSidebar ? "md:w-[280px] md:opacity-100" : "md:w-0 md:opacity-0 md:overflow-hidden"}`}
                    >
                        <div className="h-10 shrink-0 px-3 flex items-center justify-between bg-[var(--ed-surface-container-low)] border-b border-[var(--ed-outline-variant)]">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ed-on-surface-variant)]">
                                {railView === "blocks" ? trStr("Bloques", language)
                                    : railView === "patterns" ? trStr("Plantillas", language)
                                    : t("editor.panel.structure")}
                            </span>
                            <button
                                type="button"
                                onClick={() => {
                                    if (isPhone()) setMobileSheet(null);
                                    else setShowSidebar(false);
                                }}
                                title={t("editor.hideSidebar")}
                                className="w-6 h-6 rounded flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                            >
                                <MSym name="chevron_left" size={16} className="hidden md:block" />
                                <MSym name="close" size={16} className="md:hidden" />
                            </button>
                        </div>

                        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                            {railView === "outline" ? (
                                <div className="p-3">
                                    <OutlineTree handle={handle} registry={registry} />
                                </div>
                            ) : railView === "patterns" ? (
                                /* Placeholder documentado (ola 3): la pestaña existe, no finge funcionar. */
                                <div className="p-3">
                                    <div
                                        role="note"
                                        className="rounded border border-dashed border-[var(--ed-outline-variant)] px-3 py-4 text-center text-[12px] text-[var(--ed-on-surface-variant)]"
                                    >
                                        <MSym name="dashboard_customize" size={24} className="block mx-auto mb-2 opacity-50" />
                                        {trStr("Las plantillas llegan en una ola posterior.", language)}
                                    </div>
                                </div>
                            ) : (
                                <BlockPalette
                                    registry={registry}
                                    onInsert={(type) => {
                                        insertType(type);
                                        if (mobileSheet === "left") setMobileSheet(null);
                                    }}
                                />
                            )}
                        </div>
                    </div>

                    {/* CANVAS — retícula de puntos + tarjeta/bisel a ancho real de dispositivo,
                        escalado a caber (piel exacta del PreviewFrame actual). */}
                    <div ref={areaRef} className="flex-1 relative overflow-hidden bg-[var(--ed-surface-container-low)] h-full min-h-0">
                        <div
                            className="absolute inset-0 pointer-events-none"
                            style={{ backgroundImage: "radial-gradient(#c8c4d5 0.5px, transparent 0.5px)", backgroundSize: "20px 20px" }}
                        ></div>
                        <div className="absolute inset-0 flex items-start justify-center" style={{ padding: PAD }}>
                            <div
                                className={`relative z-10 bg-white overflow-hidden shrink-0 ${isNarrow ? "rounded-xl border border-[var(--ed-outline-variant)] shadow-lg" : isDesktop ? "border border-[var(--ed-outline-variant)] shadow-lg" : "rounded-[2rem] ring-[7px] ring-gray-900 shadow-2xl"}`}
                                style={{ width: frameW * scale, height: availH }}
                            >
                                <div
                                    className="absolute top-0 left-0 origin-top-left"
                                    style={{ width: frameW, height: innerH, transform: scale === 1 ? "none" : `scale(${scale})` }}
                                >
                                    {/* iframe + overlay HERMANOS en el contenedor transformado: comparten
                                        sistema de coordenadas y el navegador los escala juntos (contrato
                                        de viewport.ts, verificado en el lab). */}
                                    <div className="relative w-full h-full">
                                        <FrameController
                                            onFrameReady={onFrameReady}
                                            overlay={
                                                <>
                                                    <OverlayLayer
                                                        handle={handle}
                                                        registry={registry}
                                                        geometry={geometry}
                                                        frameDocument={frameDoc}
                                                    />
                                                    <DnDDriver
                                                        handle={handle}
                                                        registry={registry}
                                                        geometry={geometry}
                                                        frameDocument={frameDoc}
                                                    />
                                                </>
                                            }
                                        >
                                            <EditorRenderer
                                                handle={handle}
                                                registry={registry}
                                                componentMap={componentMap}
                                                onBlockElement={onBlockElement}
                                                editorChrome
                                            />
                                        </FrameController>
                                    </div>
                                </div>

                                {/* Estado vacío (W19; los 3 patrones rápidos llegan con los patrones, ola 3) */}
                                {emptyCanvas && (
                                    <div className="absolute inset-0 z-30 flex items-center justify-center p-6 pointer-events-none">
                                        <div className="text-center max-w-md pointer-events-none bg-white/95 backdrop-blur rounded-2xl border border-[var(--ed-outline-variant)] shadow-xl p-8">
                                            <div className="w-36 h-36 mx-auto rounded-full bg-[var(--ed-surface-container)] border border-[var(--ed-outline-variant)] flex items-center justify-center mb-6">
                                                <MSym name="space_dashboard" size={56} className="text-[var(--ed-outline)]" />
                                            </div>
                                            <h3 className="text-[18px] font-semibold tracking-tight text-[var(--ed-on-surface)] mb-2">{trStr("Comienza tu diseño", language)}</h3>
                                            <p className="text-[14px] text-[var(--ed-on-surface-variant)] mb-6">{trStr("Tu lienzo está listo. Añade el primer bloque para empezar a construir tu visión.", language)}</p>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setRailView("blocks");
                                                    if (isPhone()) setMobileSheet("left");
                                                    else setShowSidebar(true);
                                                }}
                                                className="pointer-events-auto inline-flex items-center gap-2 px-6 py-3 rounded-full bg-[var(--ed-primary)] text-white text-[12px] font-semibold hover:shadow-lg transition-all active:scale-95"
                                            >
                                                <MSym name="add_circle" size={20} />
                                                {trStr("Añadir primer bloque", language)}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* PANEL DERECHO — propiedades (docked 320px / sheet móvil) */}
                    {(showProperties || mobileSheet === "right") && (
                        <PropertiesPanel
                            handle={handle}
                            registry={registry}
                            rootFields={rootFields}
                            onClose={() => {
                                if (isPhone()) setMobileSheet(null);
                                else setShowProperties(false);
                            }}
                            mobileOpen={mobileSheet === "right"}
                        />
                    )}
                </div>

                {/* NAV INFERIOR MÓVIL — 4 pestañas (blueprint §a) */}
                <div className="md:hidden fixed inset-x-0 bottom-0 h-14 z-40 bg-[var(--ed-surface)] border-t border-[var(--ed-outline-variant)] flex items-stretch">
                    {([
                        { id: "blocks", icon: "add_box", label: trStr("Bloques", language), active: mobileSheet === "left" && railView !== "outline" },
                        { id: "layers", icon: "layers", label: trStr("Capas", language), active: mobileSheet === "left" && railView === "outline" },
                        { id: "props", icon: "tune", label: trStr("Propiedades", language), active: mobileSheet === "right" },
                        { id: "settings", icon: "settings", label: trStr("Ajustes", language), active: false },
                    ] as const).map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            aria-pressed={tab.active}
                            onClick={() => {
                                if (tab.id === "blocks") {
                                    const wasOpen = mobileSheet === "left" && railView !== "outline";
                                    setRailView("blocks");
                                    setMobileSheet(wasOpen ? null : "left");
                                } else if (tab.id === "layers") {
                                    const wasOpen = mobileSheet === "left" && railView === "outline";
                                    setRailView("outline");
                                    setMobileSheet(wasOpen ? null : "left");
                                } else if (tab.id === "props") {
                                    setMobileSheet(mobileSheet === "right" ? null : "right");
                                } else {
                                    handle.select(null);
                                    setMobileSheet("right");
                                }
                            }}
                            className="flex-1 flex flex-col items-center justify-center gap-0.5"
                        >
                            <span className={`w-10 h-6 rounded-md flex items-center justify-center transition-colors ${tab.active ? "bg-[var(--ed-primary)] text-white" : "text-[var(--ed-on-surface-variant)]"}`}>
                                <MSym name={tab.icon} size={18} fill={tab.active} />
                            </span>
                            <span className={`text-[10px] leading-none ${tab.active ? "text-[var(--ed-primary)] font-semibold" : "text-[var(--ed-on-surface-variant)]"}`}>
                                {tab.label}
                            </span>
                        </button>
                    ))}
                </div>

                {/* FAB MÓVIL — insertar (oculto con sheet abierto) */}
                {!mobileSheet && (
                    <button
                        type="button"
                        onClick={() => setCmdkOpen(true)}
                        title={trStr("Insertar bloque (Ctrl/⌘ + K)", language)}
                        className="md:hidden fixed right-4 bottom-[72px] z-40 w-12 h-12 rounded-full bg-[var(--ed-primary)] text-white shadow-xl flex items-center justify-center active:scale-95 transition"
                    >
                        <MSym name="add" size={24} />
                    </button>
                )}

                {/* Drag hint pill (solo durante un drag vivo — W07) */}
                {isDragging && (
                    <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-[70] pointer-events-none bg-[var(--ed-inverse-surface)] text-[var(--ed-inverse-on-surface)] px-4 py-2 rounded-full shadow-xl flex items-center gap-2">
                        <MSym name="info" size={18} />
                        <span className="text-[12px]">{trStr("Arrastra a una zona iluminada para añadir el bloque", language)}</span>
                    </div>
                )}

                {/* Toast — pill oscura, 4s, desplazada si el panel derecho está abierto (W11) */}
                {toastMsg && (
                    <div
                        className="fixed bottom-16 md:bottom-4 right-4 md:right-[var(--toast-right)] z-[80] bg-[var(--ed-inverse-surface)] text-[var(--ed-inverse-on-surface)] pl-3 pr-2 py-2.5 rounded-lg shadow-xl flex items-center gap-2.5"
                        style={{ "--toast-right": showProperties ? "336px" : "16px" } as React.CSSProperties}
                        role="status"
                    >
                        <MSym name="check_circle" size={20} fill className="text-[var(--ed-success)]" />
                        <span className="text-[13px] font-medium">{toastMsg}</span>
                        <button
                            type="button"
                            aria-label={t("common.close")}
                            onClick={() => setToastMsg(null)}
                            className="p-1 rounded hover:bg-white/10 transition-colors"
                        >
                            <MSym name="close" size={16} />
                        </button>
                    </div>
                )}

                {/* ⌘K — PLACEHOLDER documentado (la CommandPalette completa es ola 3). Backdrop y
                    caja con la misma geometría del original para que el reflejo visual no salte. */}
                {cmdkOpen && (
                    <div
                        className="fixed inset-0 z-[9999] flex items-start justify-center pt-[14vh] px-4"
                        style={{ background: "rgba(27,27,34,0.4)" }}
                        onClick={() => setCmdkOpen(false)}
                    >
                        <div
                            role="dialog"
                            aria-modal="true"
                            aria-label={trStr("Insertar bloque (Ctrl/⌘ + K)", language)}
                            className="w-full max-w-xl rounded-xl bg-[var(--ed-surface-container-lowest)] border border-[var(--ed-outline-variant)] shadow-2xl p-6 backdrop-blur-sm"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="flex items-center gap-2 text-[var(--ed-on-surface-variant)]">
                                <MSym name="search" size={18} />
                                <span className="text-[13px]">
                                    {trStr("La paleta de comandos completa llega en una ola posterior.", language)}
                                </span>
                            </div>
                            <p className="mt-3 text-[12px] text-[var(--ed-on-surface-variant)]">
                                {trStr("Usa el panel Bloques para insertar mientras tanto.", language)}
                            </p>
                            <div className="mt-4 flex justify-end">
                                <button
                                    type="button"
                                    onClick={() => setCmdkOpen(false)}
                                    className="px-3 py-1.5 rounded-md border border-[var(--ed-outline-variant)] text-[11px] text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] transition-colors"
                                >
                                    <kbd style={{ fontFamily: "var(--puck-font-family-monospaced)" }}>ESC</kbd>
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

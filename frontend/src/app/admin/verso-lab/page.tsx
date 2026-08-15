"use client";
/**
 * Verso Lab — harness standalone del editor (banco de pruebas del gate F2).
 *
 * GATE DE VISIBILIDAD (decisión documentada): la página monta el banco cuando
 * NODE_ENV !== "production" (dev siempre disponible) O cuando la URL trae
 * ?lab=1 (opt-in explícito). La segunda vía existe porque el gate de F2 mide
 * tiempos REALES y eso exige poder abrir el banco sobre un build de producción;
 * sin ?lab=1, en producción la ruta muestra un aviso y no monta nada (la ruta
 * ya está tras los gates de auth/MFA del admin — DashboardLayoutClient corre
 * antes del bypass del shell).
 *
 * Montaje: createEditor con un doc sintético (?fixture=30 default — el doc de
 * siempre —, ?fixture=500 el determinista de 500 bloques; ambos en
 * lab/labFixtures.ts, componentes REALES de blocks.tsx), FrameController
 * (iframe /admin/canvas-frame + portal) + EditorRenderer, capa OverlayLayer
 * hermana del iframe, panel izquierdo (tipos del registry → insertNode), panel
 * derecho (VersoFieldControl sobre registry.get(type).fields del seleccionado),
 * undo/redo con canUndo/canRedo, y HUD dev: contador de re-renders + coste del
 * último transact + PerfHud de percentiles (lab/PerfHud.tsx). Funcional, no bonito.
 *
 * DEVICE VIEWPORTS (encargo F2): ViewportControls fija el ANCHO CSS del
 * contenedor del canvas (escritorio 1280 / tableta 768 / móvil 375 — ver el
 * contrato de breakpoints con wordjs-ui.css en canvas/viewport.ts) y lo encoge
 * con transform: scale() para caber en el área medida con ResizeObserver
 * (useAreaSize). El iframe (h-full w-full) hereda ese ancho → sus media
 * queries REALES disparan. La capa overlay sigue siendo HERMANA del iframe
 * DENTRO del mismo contenedor transformado: iframe y overlay comparten el
 * sistema de coordenadas local (pre-transform) y el navegador los escala
 * juntos, así que el mapeo rects-del-iframe → overlay sigue siendo 1:1 para
 * cualquier escala (la justificación completa, en viewport.ts).
 */
import React from "react";
import {
    createEditor,
    type EditorHandle,
    type TransactOptions,
    type VersoTransactionApi,
} from "@/lib/verso/store";
import {
    createBlockRegistry,
    makeSlotResolver,
    type BlockRegistry,
} from "@/lib/verso/registry";
import {
    ROOT_ID,
    ROOT_SLOT,
    type VersoEditorState,
    type VersoItem,
} from "@/lib/verso/types";
import EditorRenderer from "@/components/verso/render/EditorRenderer";
import {
    useStoreSlice,
    type VersoBlockProps,
    type VersoComponentMap,
    type VersoSlotRender,
} from "@/components/verso/render/context";
import VersoFieldControl from "@/components/verso/fields/VersoFieldControl";
import FrameController from "@/components/verso/canvas/FrameController";
import ViewportControls, { useAreaSize } from "@/components/verso/canvas/ViewportControls";
import { canvasContainerLayout, DEVICE_WIDTHS, type DeviceKind } from "@/components/verso/canvas/viewport";
import { makeFixtureData, type LabFixtureKey } from "@/components/verso/lab/labFixtures";
import PerfHud from "@/components/verso/lab/PerfHud";
import { createPerfTracker } from "@/components/verso/lab/perf";
import { GeometryStore } from "@/components/verso/overlay/GeometryStore";
import OverlayLayer from "@/components/verso/overlay/OverlayLayer";
import { editSelectedInline } from "@/components/verso/overlay/actionBarCommands";
import DnDDriver from "@/components/verso/dnd/DnDDriver";
import {
    HeadingBlock,
    TextBlock,
    CardBlock,
    SectionBlock,
    GridBlock,
} from "@/components/content/blocks";

/* ------------------------------------------------------------------ */
/* Registry + componentMap (componentes reales de blocks.tsx).          */
/* ------------------------------------------------------------------ */

const componentMap: VersoComponentMap = {
    Heading: HeadingBlock as VersoComponentMap[string],
    Text: TextBlock as VersoComponentMap[string],
    Card: CardBlock as VersoComponentMap[string],
    // Contenedores: el slot llega bajo su clave ("children") y el bloque lo
    // espera como `slot` — misma adaptación que puckConfig/los tests del renderer.
    Section: (p: VersoBlockProps) => <SectionBlock {...p} slot={p.children as VersoSlotRender} />,
    Grid: (p: VersoBlockProps) => <GridBlock {...p} slot={p.children as VersoSlotRender} />,
};

function makeLabRegistry(): BlockRegistry {
    const registry = createBlockRegistry();
    registry.register([
        {
            type: "Heading",
            label: "Encabezado",
            category: "Texto",
            fields: {
                title: { type: "text", label: "Título" },
                level: {
                    type: "select",
                    label: "Nivel",
                    options: [
                        { label: "H1", value: "h1" },
                        { label: "H2", value: "h2" },
                        { label: "H3", value: "h3" },
                        { label: "H4", value: "h4" },
                    ],
                },
                color: { type: "text", label: "Color" },
            },
            defaultProps: { title: "Encabezado nuevo", level: "h2" },
            inline: { prop: "title", schema: "plain" },
            render: HeadingBlock,
        },
        {
            type: "Text",
            label: "Texto",
            category: "Texto",
            fields: { content: { type: "textarea", label: "Contenido" } },
            defaultProps: { content: "<p>Texto nuevo…</p>" },
            inline: { prop: "content", schema: "rich" },
            render: TextBlock,
        },
        {
            type: "Card",
            label: "Tarjeta",
            category: "Contenido",
            fields: {
                title: { type: "text", label: "Título" },
                description: { type: "textarea", label: "Descripción" },
            },
            defaultProps: { title: "Tarjeta", description: "Descripción" },
            render: CardBlock,
        },
        {
            type: "Section",
            label: "Sección",
            category: "Layout",
            fields: {
                children: { type: "slot", label: "Contenido" },
                pad: { type: "number", label: "Padding", min: 0, max: 160 },
            },
            defaultProps: { pad: 24, children: [] },
            render: SectionBlock,
        },
        {
            type: "Grid",
            label: "Rejilla",
            category: "Layout",
            fields: {
                children: { type: "slot", label: "Celdas" },
                columns: { type: "number", label: "Columnas", min: 1, max: 4 },
                gap: { type: "number", label: "Separación", min: 0, max: 80 },
            },
            defaultProps: { columns: 3, gap: 16, children: [] },
            render: GridBlock,
        },
    ]);
    return registry;
}

/* ------------------------------------------------------------------ */
/* Doc sintético: lab/labFixtures.ts (30 default; 500 determinista).    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Banco.                                                               */
/* ------------------------------------------------------------------ */

const selectState = (s: VersoEditorState): VersoEditorState => s;

/**
 * Contador de re-renders del HUD. Acumulador impuro DELIBERADO en scope de
 * módulo (un ref/useState mutado en render dispara react-hooks/refs e
 * immutability): es diagnóstico del banco, no estado de React, y el banco se
 * monta una sola vez por sesión de lab.
 */
const labRenderCounter = { value: 0 };

const PANEL_CLS =
    "flex h-full flex-col overflow-y-auto border-[var(--ed-outline-variant,#d5d2e0)] bg-[var(--ed-surface,#ffffff)] p-3";
const PANEL_TITLE_CLS =
    "mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--ed-on-surface-variant,#6b6880)]";
const TOOL_BTN_CLS =
    "rounded border border-[var(--ed-outline-variant,#d5d2e0)] px-2 py-1 text-xs text-[var(--ed-on-surface,#1c1b22)] hover:bg-[var(--ed-surface-container,#f0eef6)] disabled:opacity-40";

function VersoLabBench({ fixture }: { fixture: LabFixtureKey }) {
    const registry = React.useMemo(() => makeLabRegistry(), []);
    const handle = React.useMemo<EditorHandle>(
        () => createEditor({ initialData: makeFixtureData(fixture), isSlot: makeSlotResolver(registry) }),
        [registry, fixture],
    );
    const geometry = React.useMemo(() => new GeometryStore(), []);
    const perf = React.useMemo(() => createPerfTracker(), []);
    React.useEffect(
        () => () => {
            handle.destroy();
            geometry.destroy();
        },
        [handle, geometry],
    );

    // Re-render del banco en cada notificación del store (paneles/undo/HUD).
    const state = useStoreSlice(handle, selectState);
    const [frameDoc, setFrameDoc] = React.useState<Document | null>(null);
    const [lastTransactMs, setLastTransactMs] = React.useState<number | null>(null);
    // Sin array de deps: corre tras CADA render committeado (mutar fuera del
    // render mantiene el componente puro y contenta a react-hooks/immutability).
    // El valor mostrado va un render por detrás — irrelevante para el HUD.
    React.useEffect(() => {
        labRenderCounter.value += 1;
    });

    const timedTransact = React.useCallback(
        (fn: (tx: VersoTransactionApi) => void, opts?: TransactOptions): boolean => {
            const t0 = performance.now();
            const ok = handle.transact(fn, opts);
            const dt = performance.now() - t0;
            setLastTransactMs(dt);
            perf.record("transact", dt);
            return ok;
        },
        [handle, perf],
    );

    const onBlockElement = React.useCallback(
        (id: string, el: HTMLElement | null) => geometry.registerElement(id, el),
        [geometry],
    );

    const onFrameReady = React.useCallback(
        (doc: Document) => {
            setFrameDoc(doc);
            geometry.attachFrame(doc, doc.defaultView, window);
        },
        [geometry],
    );

    // Selección por click sobre el canvas (capture en el doc del iframe).
    React.useEffect(() => {
        if (!frameDoc) return;
        const onClick = (e: Event) => {
            const target = e.target as Element | null;
            const el = target?.closest?.("[data-wjs-block-id]") ?? null;
            handle.select(el ? el.getAttribute("data-wjs-block-id") : null);
        };
        frameDoc.addEventListener("click", onClick, true);
        return () => frameDoc.removeEventListener("click", onClick, true);
    }, [frameDoc, handle]);

    // Edición inline por doble click (capture en el doc del iframe, igual que
    // la selección): solo abre si el registry declara inline para ese type
    // (editSelectedInline ya hace esa comprobación). El botón ✎ del ActionBar
    // es la otra vía de entrada; ambas terminan en handle.setInlineEditing.
    React.useEffect(() => {
        if (!frameDoc) return;
        const onDblClick = (e: Event) => {
            const target = e.target as Element | null;
            const el = target?.closest?.("[data-wjs-block-id]") ?? null;
            const id = el?.getAttribute("data-wjs-block-id");
            if (id) editSelectedInline(handle, registry, id);
        };
        frameDoc.addEventListener("dblclick", onDblClick, true);
        return () => frameDoc.removeEventListener("dblclick", onDblClick, true);
    }, [frameDoc, handle, registry]);

    const insertType = React.useCallback(
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
            // Tras la selección si la hay; si no, al final de la raíz.
            const doc = handle.getDoc();
            const selected = handle.getState().selection.nodeId;
            const node = selected ? doc.nodes[selected] : undefined;
            const parentId = node ? node.parentId : ROOT_ID;
            const slotKey = node ? node.slotKey : ROOT_SLOT;
            const index = node ? node.index + 1 : doc.rootChildren.length;
            if (timedTransact((tx) => tx.insertNode(item, parentId, slotKey, index), { label: `Insertar ${type}` })) {
                handle.select(id);
            }
        },
        [registry, handle, timedTransact],
    );

    const selectedId = state.selection.nodeId;
    const selectedNode = selectedId ? state.doc.nodes[selectedId] : undefined;
    const selectedDef = selectedNode ? registry.get(selectedNode.type) : undefined;

    // Device-viewport: el área disponible se mide con ResizeObserver y el
    // contenedor del canvas fija el ancho del dispositivo + scale-to-fit
    // (aritmética pura en canvas/viewport.ts, testeada).
    const [device, setDevice] = React.useState<DeviceKind>("desktop");
    const areaRef = React.useRef<HTMLDivElement | null>(null);
    const area = useAreaSize(areaRef);
    const vp = canvasContainerLayout(area.width, area.height, DEVICE_WIDTHS[device]);

    return (
        <div className="fixed inset-0 z-[100] flex bg-[var(--ed-surface-container-low,#f3f2f7)] text-sm">
            {/* Panel izquierdo: tipos del registry (paleta arrastrable del DnDDriver:
                data-wjs-palette marca el drawer, data-wjs-palette-type cada item) */}
            <aside className={`${PANEL_CLS} w-52 shrink-0 border-r`} data-wjs-palette="">
                <h2 className={PANEL_TITLE_CLS}>Bloques</h2>
                <div className="flex flex-col gap-1">
                    {registry.list().map((def) => (
                        <button
                            key={def.type}
                            type="button"
                            className={`${TOOL_BTN_CLS} text-left`}
                            aria-label={`Insertar bloque ${def.label ?? def.type}`}
                            data-wjs-palette-type={def.type}
                            onClick={() => insertType(def.type)}
                        >
                            {def.label ?? def.type}
                            <span className="ml-1 text-[10px] text-[var(--ed-on-surface-variant,#6b6880)]">
                                {def.category}
                            </span>
                        </button>
                    ))}
                </div>
            </aside>

            {/* Centro: barra + canvas */}
            <main className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-center gap-2 border-b border-[var(--ed-outline-variant,#d5d2e0)] bg-[var(--ed-surface,#ffffff)] px-3 py-2">
                    <strong className="text-xs">Verso Lab</strong>
                    <button
                        type="button"
                        className={TOOL_BTN_CLS}
                        aria-label="Deshacer"
                        disabled={!handle.canUndo()}
                        onClick={() => handle.undo()}
                    >
                        ↶ Deshacer
                    </button>
                    <button
                        type="button"
                        className={TOOL_BTN_CLS}
                        aria-label="Rehacer"
                        disabled={!handle.canRedo()}
                        onClick={() => handle.redo()}
                    >
                        ↷ Rehacer
                    </button>
                    <ViewportControls value={device} onChange={setDevice} />
                    {/* HUD dev: re-renders del banco + coste del último transact + percentiles */}
                    <span
                        data-wjs-lab-hud=""
                        className="ml-auto rounded bg-[var(--ed-surface-container-high,#e8e6f0)] px-2 py-0.5 font-mono text-[11px] text-[var(--ed-on-surface-variant,#6b6880)]"
                    >
                        fixture: {fixture} · renders: {labRenderCounter.value} · transact:{" "}
                        {lastTransactMs === null ? "—" : `${lastTransactMs.toFixed(1)}ms`} · bloques:{" "}
                        {Object.keys(state.doc.nodes).length}
                    </span>
                    <PerfHud tracker={perf} />
                </header>
                <div className="min-h-0 flex-1 p-4">
                    {/* Área medida (ResizeObserver): dentro, el contenedor TRANSFORMADO del
                        canvas — ancho CSS = ancho del dispositivo, transform: scale() para
                        caber. El iframe y la capa overlay son HERMANOS dentro de ese
                        contenedor: comparten el sistema de coordenadas local (pre-transform)
                        y el navegador los escala JUNTOS, así que los rects del GeometryStore
                        (viewport del iframe) siguen mapeando 1:1 al overlay con CUALQUIER
                        escala — ver canvas/viewport.ts para la justificación completa. */}
                    <div ref={areaRef} className="relative h-full w-full overflow-hidden">
                        <div
                            data-wjs-canvas-container=""
                            data-wjs-canvas-scale={vp.scale.toFixed(4)}
                            data-wjs-canvas-device={device}
                            className="relative overflow-hidden rounded border border-[var(--ed-outline-variant,#d5d2e0)] bg-white shadow"
                            style={{
                                width: vp.width,
                                height: vp.height,
                                marginLeft: vp.offsetX,
                                transform: `scale(${vp.scale})`,
                                transformOrigin: "top left",
                            }}
                        >
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
                </div>
            </main>

            {/* Panel derecho: props del seleccionado. onKeyDownCapture: marca de
                input latency (keydown → fin del transact del onChange, ver lab/perf.ts). */}
            <aside
                className={`${PANEL_CLS} w-72 shrink-0 border-l`}
                onKeyDownCapture={() => perf.markInput()}
            >
                <h2 className={PANEL_TITLE_CLS}>Propiedades</h2>
                {selectedNode && selectedDef ? (
                    <>
                        <p className="mb-2 text-xs text-[var(--ed-on-surface-variant,#6b6880)]">
                            {selectedDef.label ?? selectedNode.type} ·{" "}
                            <code className="text-[10px]">{selectedNode.id}</code>
                        </p>
                        {Object.entries(selectedDef.fields).map(([key, field]) => (
                            <VersoFieldControl
                                key={`${selectedNode.id}:${key}`}
                                field={field}
                                name={key}
                                value={selectedNode.props[key]}
                                onChange={(v) => {
                                    // Punto donde el panel llama a setProps: el fin de ESTE
                                    // transact cierra la medición de input latency (la marca
                                    // la puso el keydown capturado en el aside).
                                    timedTransact((tx) => tx.setProps(selectedNode.id, { [key]: v }), {
                                        coalesceKey: `props:${selectedNode.id}:${key}`,
                                        label: `Editar ${key}`,
                                    });
                                    perf.endInput();
                                }}
                            />
                        ))}
                    </>
                ) : (
                    <p className="text-xs text-[var(--ed-on-surface-variant,#6b6880)]">
                        Selecciona un bloque en el lienzo.
                    </p>
                )}
            </aside>
        </div>
    );
}

export default function VersoLabPage() {
    // true en dev; en producción null hasta leer la query (?lab=1) tras montar.
    const [allowed, setAllowed] = React.useState<boolean | null>(
        process.env.NODE_ENV !== "production" ? true : null,
    );
    // ?fixture=500 → doc determinista de 500 bloques; cualquier otra cosa → 30.
    // null hasta leer la query tras montar (window no existe en SSR; el banco
    // espera a ambos estados — evita un mismatch de hidratación por la URL).
    const [fixture, setFixture] = React.useState<LabFixtureKey | null>(null);
    React.useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setAllowed((prev) => (prev === null ? params.get("lab") === "1" : prev));
        setFixture(params.get("fixture") === "500" ? "500" : "30");
    }, []);
    if (allowed === null || fixture === null) return null;
    if (!allowed) {
        return (
            <div className="p-8 text-sm text-[var(--ed-on-surface-variant,#6b6880)]">
                Verso Lab está deshabilitado en producción. Añade <code>?lab=1</code> a la URL para
                abrir el banco de pruebas.
            </div>
        );
    }
    return <VersoLabBench fixture={fixture} />;
}

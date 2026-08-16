import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * F4 — camino runtime de bloques de plugin en Verso (pluginBlocks.tsx) sobre el LOADER REAL
 * (pluginBundleLoader.ts, sin reescribir): fixtures de bundle en las DOS formas legacy
 * (`puckComponentDef` + default → single; `export const puckComponents = {...}` → multi, que el
 * loader ya normaliza a un mapa con `render` compuesto), registrándose en un BlockRegistry REAL y
 * envueltos por el seam de campos compartidos (hide/anim/look presentes, mismos defaults que el
 * legacy). También: degradación 404 / plugin caído / lista de activos caída, e identidad estable
 * del registry tras N pasadas (el contrato anti-remount).
 *
 * ENTORNO: node (sin jsdom) — mismas técnicas que pluginBundleLoader.test.ts: stub de `window`
 * (el loader solo necesita que exista), fetch mockeado, y el shim Blob→data: URL para que el
 * `import()` de blob: del loader corra en node. Los módulos se importan FRESCOS por test porque
 * las cachés del loader (activePromise/blockConfigCache) y la WeakMap de adaptación son estado de
 * sesión — y ese estado es parte de lo que se prueba.
 */

const ACTIVE_URL = "/api/v1/plugins/active";

function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function textResponse(code: string): Response {
    return { ok: true, status: 200, text: async () => code } as Response;
}

// Shim Blob→data: URL — la ÚNICA pieza que node no puede ejecutar del camino real (import de blob:).
// Copiado del patrón de pluginBundleLoader.test.ts: subclases reales, restauradas en afterEach.
function installImportableBundleShim(): void {
    const RealBlob = globalThis.Blob;
    class ShimBlob extends RealBlob {
        readonly source: string;
        constructor(parts: BlobPart[], options?: BlobPropertyBag) {
            super(parts, options);
            this.source = parts.join("");
        }
    }
    class ShimURL extends globalThis.URL { }
    (ShimURL as unknown as { createObjectURL(b: ShimBlob): string }).createObjectURL = (b) =>
        "data:text/javascript;base64," + Buffer.from(b.source, "utf8").toString("base64");
    (ShimURL as unknown as { revokeObjectURL(u: string): void }).revokeObjectURL = () => { };
    vi.stubGlobal("Blob", ShimBlob);
    vi.stubGlobal("URL", ShimURL);
}

/**
 * Bundle SINGLE-BLOCK con la forma exacta del contrato legacy (f0-audit-core.md L179):
 * `puckComponentDef` = {label?, category, fields, defaultProps} SIN render + default export aparte.
 * El loader compone `{...def, render: default}` bajo el PascalCase del slug. `marker` mantiene cada
 * data: URL único entre tests (el module loader los cachea por URL).
 */
function singleBlockBundle(marker: string): string {
    return `// ${marker}
export const puckComponentDef = {
    label: "Galería de tarjetas",
    category: "content",
    fields: { galleryId: { type: "custom", label: "Select Gallery" } },
    defaultProps: { galleryId: "" },
};
export default function CardGalleryBlock(props) { return null; }
`;
}

/** Bundle MULTI-BLOCK: `export const puckComponents = {...}` con render YA compuesto por entrada. */
function multiBlockBundle(marker: string): string {
    return `// ${marker}
function StoreRender(props) { return null; }
function OrdersRender(props) { return null; }
export const puckComponents = {
    OnlineStore: {
        label: "Tienda",
        category: "content",
        fields: { title: { type: "text", label: "Título" } },
        defaultProps: { title: "Mi tienda" },
        render: StoreRender,
    },
    StoreOrders: {
        fields: {},
        defaultProps: {},
        render: OrdersRender,
    },
};
`;
}

// Import fresco por test: las cachés módulo-nivel del loader y la memo de adaptación son estado de
// sesión bajo prueba. El registry estático generado (versoPluginRegistry.ts) se mockea VACÍO — su
// contenido real depende de la máquina (plugins in-tree gitignorados) y estos tests no deben leerlo.
async function freshModules() {
    vi.resetModules();
    vi.doMock("@/lib/versoPluginRegistry", () => ({ versoPluginComponents: {} }));
    const pluginBlocks = await import("../pluginBlocks");
    const { createBlockRegistry } = await import("../registry");
    return { ...pluginBlocks, createBlockRegistry };
}

let fetchMock: ReturnType<typeof vi.fn>;
let installedWindowStub = false;

beforeEach(() => {
    if (!(globalThis as unknown as { window?: unknown }).window) {
        (globalThis as unknown as { window: object }).window = {};
        installedWindowStub = true;
    }
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => { });
    vi.spyOn(console, "error").mockImplementation(() => { });
});

afterEach(() => {
    if (installedWindowStub) {
        delete (globalThis as unknown as { window?: unknown }).window;
        installedWindowStub = false;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/versoPluginRegistry");
});

/** fetch: /plugins/active → `active`; bundle `?type=component` → por slug según `bundles`. */
function mockPluginFetch(active: string[], bundles: Record<string, Response | (() => Response)>): void {
    fetchMock.mockImplementation(async (url: string) => {
        if (url === ACTIVE_URL) return jsonResponse(active);
        for (const [slug, res] of Object.entries(bundles)) {
            if (String(url).includes(`/plugins/${slug}/bundle`)) {
                return typeof res === "function" ? res() : res;
            }
        }
        return jsonResponse({}, 404);
    });
}

describe("adaptación runtime — forma SINGLE (puckComponentDef + default export)", () => {
    it("registra el bloque bajo el PascalCase del slug, envuelto por el seam (hide/anim/look)", async () => {
        installImportableBundleShim();
        mockPluginFetch(["card-gallery"], { "card-gallery": textResponse(singleBlockBundle("single-a")) });
        const { loadVersoPluginBlocks, createBlockRegistry } = await freshModules();
        const registry = createBlockRegistry();

        const result = await loadVersoPluginBlocks(registry);

        expect(result.registeredTypes).toEqual(["CardGallery"]);
        expect(result.pluginIdsWithBlocks).toEqual(["card-gallery"]);
        const def = registry.get("CardGallery");
        expect(def).toBeDefined();
        expect(def!.label).toBe("Galería de tarjetas");
        expect(def!.category).toBe("content");
        // Campos propios + los 3 del seam, byte-compatibles con el legacy (withSharedBlockFields).
        expect(Object.keys(def!.fields)).toEqual(
            expect.arrayContaining(["galleryId", "hide", "anim", "look"]),
        );
        expect(def!.defaultProps).toMatchObject({
            galleryId: "",
            hide: {},
            anim: { type: "fade-up", duration: 600, delay: 0 },
            look: {},
        });
        expect(registry.version()).toBe(1); // UNA llamada a register() por pasada
    });

    it("el render recibe el objeto `puck` compatible (isEditing/metadata/renderDropZone→slot/dragRef)", async () => {
        installImportableBundleShim();
        mockPluginFetch(["card-gallery"], { "card-gallery": textResponse(singleBlockBundle("single-puck")) });
        const { loadVersoPluginBlocks, createBlockRegistry } = await freshModules();
        const registry = createBlockRegistry();
        await loadVersoPluginBlocks(registry);

        const def = registry.get("CardGallery")!;
        const Wrapper = def.render as React.FC<Record<string, unknown>>;
        const slotFn = vi.fn(() => null);
        // El wrapper es un function component: invocarlo devuelve el elemento del render legacy con
        // las props del nodo + `puck` compuesto (el contrato de ComponentConfig.render del legacy).
        const element = Wrapper({ isEditing: true, children: slotFn }) as React.ReactElement<{
            puck: { isEditing: boolean; metadata: object; dragRef: null; renderDropZone: (a: { zone: string }) => unknown };
            isEditing: boolean;
        }>;
        expect(element.props.isEditing).toBe(true);
        expect(element.props.puck.isEditing).toBe(true);
        expect(element.props.puck.metadata).toEqual({});
        expect(element.props.puck.dragRef).toBeNull();
        // renderDropZone mapea la zona al slot del motor (la función que VersoBlock inyecta).
        element.props.puck.renderDropZone({ zone: "children" });
        expect(slotFn).toHaveBeenCalledTimes(1);
        // Y una zona inexistente degrada a null, nunca lanza.
        expect(element.props.puck.renderDropZone({ zone: "no-existe" })).toBeNull();

        // El pipeline completo renderiza sin lanzar (bloque hoja → markup vacío).
        expect(() => renderToStaticMarkup(React.createElement(Wrapper, { isEditing: true }))).not.toThrow();
    });
});

describe("adaptación runtime — forma MULTI (export const puckComponents)", () => {
    it("registra cada entrada bajo la CLAVE del mapa (los nombres v1 que referencian páginas guardadas)", async () => {
        installImportableBundleShim();
        mockPluginFetch(["online-store"], { "online-store": textResponse(multiBlockBundle("multi-a")) });
        const { loadVersoPluginBlocks, createBlockRegistry } = await freshModules();
        const registry = createBlockRegistry();

        const result = await loadVersoPluginBlocks(registry);

        expect(result.registeredTypes.sort()).toEqual(["OnlineStore", "StoreOrders"]);
        const store = registry.get("OnlineStore")!;
        const orders = registry.get("StoreOrders")!;
        expect(store.label).toBe("Tienda");
        expect(store.defaultProps).toMatchObject({
            title: "Mi tienda",
            hide: {},
            anim: { type: "fade-up", duration: 600, delay: 0 },
            look: {},
        });
        // El seam envuelve TODAS las entradas, también la que no declara campos propios.
        expect(Object.keys(orders.fields)).toEqual(expect.arrayContaining(["hide", "anim", "look"]));
        expect(registry.version()).toBe(1); // dos bloques, UNA pasada, UN bump
    });
});

describe("degradación suave", () => {
    it("404 del bundle (el plugin no trae bloques) resuelve sin registrar nada y sin warn", async () => {
        mockPluginFetch(["faq"], { faq: jsonResponse({}, 404) });
        const { loadVersoPluginBlocks, createBlockRegistry } = await freshModules();
        const registry = createBlockRegistry();

        const result = await loadVersoPluginBlocks(registry);

        expect(result.registeredTypes).toEqual([]);
        expect(result.pluginIdsWithBlocks).toEqual([]);
        expect(registry.list()).toEqual([]);
        expect(registry.version()).toBe(0);
    });

    it("un plugin caído (5xx) se salta con warn y el resto registra igual — jamás rompe la pasada", async () => {
        installImportableBundleShim();
        mockPluginFetch(["broken", "card-gallery"], {
            broken: jsonResponse({}, 503),
            "card-gallery": textResponse(singleBlockBundle("single-degrade")),
        });
        const { loadVersoPluginBlocks, createBlockRegistry } = await freshModules();
        const registry = createBlockRegistry();

        const result = await loadVersoPluginBlocks(registry);

        expect(result.registeredTypes).toEqual(["CardGallery"]);
        expect(result.pluginIdsWithBlocks).toEqual(["card-gallery"]);
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining("Bloques no disponibles para 'broken'"),
            expect.anything(),
        );
    });

    it("si la LISTA de activos falla, rechaza (el hook lo captura) y el registry queda intacto", async () => {
        fetchMock.mockResolvedValue(jsonResponse({}, 502));
        const { loadVersoPluginBlocks, createBlockRegistry } = await freshModules();
        const registry = createBlockRegistry();

        await expect(loadVersoPluginBlocks(registry)).rejects.toThrow(/502/);
        expect(registry.version()).toBe(0);
        expect(registry.list()).toEqual([]);
    });

    it("una entrada sin render se descarta con warn sin tumbar las demás", async () => {
        const { registerPluginBlocks, createBlockRegistry } = await freshModules();
        const registry = createBlockRegistry();
        const ok = { fields: {}, defaultProps: {}, render: () => null };
        const registered = registerPluginBlocks(registry, {
            SinRender: { fields: {}, defaultProps: {} },
            NoObjeto: 42,
            Bueno: ok,
        });
        expect(registered).toEqual(["Bueno"]);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("'SinRender' descartado"));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("'NoObjeto' descartado"));
    });
});

describe("identidad estable del registry tras N pasadas (contrato anti-remount)", () => {
    it("una pasada repetida no re-registra: misma referencia de def y de render, cero bumps", async () => {
        installImportableBundleShim();
        mockPluginFetch(["card-gallery"], { "card-gallery": textResponse(singleBlockBundle("single-stable")) });
        const { loadVersoPluginBlocks, createBlockRegistry } = await freshModules();
        const registry = createBlockRegistry();

        await loadVersoPluginBlocks(registry);
        const version = registry.version();
        const def = registry.get("CardGallery")!;
        const render = def.render;

        // N pasadas más (remount del editor, StrictMode, reload de plugins): el loader sirve el mapa
        // crudo memoizado → la adaptación (WeakMap) devuelve el MISMO BlockDefinition → se salta el
        // register(). Sin bump no hay re-render derivado; sin cambio de render no hay remount.
        await loadVersoPluginBlocks(registry);
        await loadVersoPluginBlocks(registry);

        expect(registry.version()).toBe(version);
        expect(registry.get("CardGallery")).toBe(def);
        expect(registry.get("CardGallery")!.render).toBe(render);
        // Y solo hubo UN fetch del bundle (la caché del loader, intacta a través de este módulo).
        expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("type=component"))).toHaveLength(1);
    });
});

describe("bloques estáticos (dev, generate-verso-plugin-registry.js)", () => {
    it("registerStaticPluginBlocks registra el mapa generado envuelto por el seam; repetir no bumpea", async () => {
        const { registerStaticPluginBlocks, createBlockRegistry } = await freshModules();
        const registry = createBlockRegistry();
        // Mismo shape que emite el generador: entradas con render YA compuesto.
        const staticMap = {
            Toscano: {
                label: "Toscano",
                category: "content",
                fields: { plato: { type: "text", label: "Plato" } },
                defaultProps: { plato: "" },
                render: () => null,
            },
        };

        const first = registerStaticPluginBlocks(registry, staticMap);
        expect(first).toEqual(["Toscano"]);
        expect(registry.version()).toBe(1);
        const def = registry.get("Toscano")!;
        expect(Object.keys(def.fields)).toEqual(expect.arrayContaining(["plato", "hide", "anim", "look"]));

        // Segunda pasada idéntica (StrictMode re-ejecuta el useMemo del editor): sin re-registro.
        const second = registerStaticPluginBlocks(registry, staticMap);
        expect(second).toEqual([]);
        expect(registry.version()).toBe(1);
        expect(registry.get("Toscano")).toBe(def);
    });

    it("el camino runtime hace upsert sobre el estático (misma precedencia que el spread del legacy)", async () => {
        installImportableBundleShim();
        mockPluginFetch(["card-gallery"], { "card-gallery": textResponse(singleBlockBundle("single-upsert")) });
        const { loadVersoPluginBlocks, registerStaticPluginBlocks, createBlockRegistry } = await freshModules();
        const registry = createBlockRegistry();

        const staticRender = () => null;
        registerStaticPluginBlocks(registry, {
            CardGallery: { fields: {}, defaultProps: {}, render: staticRender },
        });
        const staticDef = registry.get("CardGallery")!;

        await loadVersoPluginBlocks(registry);
        const runtimeDef = registry.get("CardGallery")!;
        expect(runtimeDef).not.toBe(staticDef); // el runtime reemplaza por clave (upsert)
        expect(runtimeDef.label).toBe("Galería de tarjetas");
        expect(registry.list()).toHaveLength(1); // upsert, no duplicado
    });
});

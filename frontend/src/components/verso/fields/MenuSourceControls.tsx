"use client";
/**
 * Verso — pickers de la referencia del bloque NavMenu (campos `location` y `menuId`).
 *
 * Sustituyen el texto/número crudo por selects poblados del store real (GET /menus +
 * GET /menus/locations, una vez por sesión), SIN cambiar el contrato de serialización: escriben
 * exactamente las mismas props que el bloque ya guarda (`location` string, `menuId` number).
 * Misma familia que CategoryField/TemplateField (control custom que trae sus propias opciones):
 *  - un valor guardado que ya no existe en el catálogo se SINTETIZA como opción visible (el autor
 *    ve lo que hay guardado y puede cambiarlo a conciencia, nunca desaparece en silencio);
 *  - si el fetch falla, el control degrada al input crudo de siempre — editable, jamás un bloqueo.
 *
 * La caché es de sesión y compartida entre los dos controles; `refreshMenuCatalog()` (la llama el
 * editor de elementos al crear un menú) la vacía y notifica para que los selects se repueblen.
 */
import React from "react";
import { menusApi, type Menu } from "@/lib/api";

export interface MenuCatalog {
    /** location → menuId asignado (GET /menus/locations). */
    locations: Record<string, number>;
    menus: Pick<Menu, "id" | "name" | "slug">[];
    /** false ⇒ ese fetch falló y el control correspondiente degrada al input crudo. */
    locationsOk: boolean;
    menusOk: boolean;
}

let catalogPromise: Promise<MenuCatalog> | null = null;
let catalogVersion = 0;
const catalogListeners = new Set<() => void>();

function getCatalogVersion(): number {
    return catalogVersion;
}

function subscribeCatalog(listener: () => void): () => void {
    catalogListeners.add(listener);
    return () => {
        catalogListeners.delete(listener);
    };
}

/** Vacía la caché del catálogo y repuebla los pickers montados (p.ej. tras crear un menú). */
export function refreshMenuCatalog(): void {
    catalogPromise = null;
    catalogVersion += 1;
    for (const listener of Array.from(catalogListeners)) listener();
}

function loadMenuCatalog(): Promise<MenuCatalog> {
    if (!catalogPromise) {
        catalogPromise = Promise.all([
            menusApi.getLocations().then(
                (locations) => ({ locations: locations ?? {}, ok: true }),
                () => ({ locations: {} as Record<string, number>, ok: false }),
            ),
            menusApi.list().then(
                (menus) => ({ menus: Array.isArray(menus) ? menus : [], ok: true }),
                () => ({ menus: [] as Menu[], ok: false }),
            ),
        ]).then(([loc, men]) => {
            const catalog: MenuCatalog = {
                locations: loc.locations,
                menus: men.menus,
                locationsOk: loc.ok,
                menusOk: men.ok,
            };
            // Un fetch fallido no se cachea la sesión entera: el siguiente montaje reintenta
            // (misma política que la caché de useEditorMenu).
            if (!loc.ok || !men.ok) catalogPromise = null;
            return catalog;
        });
    }
    return catalogPromise;
}

/** Catálogo de sesión; null mientras carga. Reactivo a refreshMenuCatalog(). */
function useMenuCatalog(): MenuCatalog | null {
    const version = React.useSyncExternalStore(subscribeCatalog, getCatalogVersion, getCatalogVersion);
    const [catalog, setCatalog] = React.useState<MenuCatalog | null>(null);
    React.useEffect(() => {
        let dead = false;
        loadMenuCatalog().then((c) => {
            if (!dead) setCatalog(c);
        });
        return () => {
            dead = true;
        };
    }, [version]);
    return catalog;
}

/* Mismas clases/tokens --ed-* que VersoFieldControl: el control custom pinta su propio label. */
const LABEL_CLS = "block text-xs font-medium text-[var(--ed-on-surface-variant)] mb-1";
const INPUT_CLS =
    "w-full rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] px-2 py-1.5 text-sm text-[var(--ed-on-surface)]";

/**
 * Campo `location`: select de las ubicaciones registradas (con el menú asignado como pista).
 * Escribe el MISMO string que el campo de texto de antes.
 */
export function MenuLocationPickerControl({ value, onChange }: {
    value: unknown;
    onChange: (v: unknown) => void;
}) {
    const catalog = useMenuCatalog();
    const id = React.useId();
    const current = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

    if (catalog && !catalog.locationsOk) {
        // Degradación: sin catálogo, el input crudo de siempre (editable, nunca un bloqueo).
        return (
            <div>
                <label htmlFor={id} className={LABEL_CLS}>Ubicación del menú (p. ej. header)</label>
                <input
                    id={id}
                    type="text"
                    className={INPUT_CLS}
                    value={current}
                    onChange={(e) => onChange(e.target.value)}
                />
                <p className="mt-1 text-[10px] text-[var(--ed-outline)]">
                    No se pudieron cargar las ubicaciones registradas.
                </p>
            </div>
        );
    }

    const locations = catalog ? Object.keys(catalog.locations) : [];
    const menuName = (menuId: number): string | undefined =>
        catalog?.menus.find((m) => m.id === menuId)?.name;
    const known = current === "" || locations.includes(current);

    return (
        <div>
            <label htmlFor={id} className={LABEL_CLS}>Ubicación del menú</label>
            <select
                id={id}
                className={INPUT_CLS}
                value={current}
                disabled={!catalog}
                onChange={(e) => onChange(e.target.value)}
            >
                {!known && <option value={current}>{`${current} (no registrada)`}</option>}
                {current === "" && <option value="">— Elige una ubicación —</option>}
                {locations.map((loc) => {
                    const assigned = menuName(Number(catalog!.locations[loc]));
                    return (
                        <option key={loc} value={loc}>
                            {assigned ? `${loc} — ${assigned}` : `${loc} — sin menú`}
                        </option>
                    );
                })}
            </select>
        </div>
    );
}

/**
 * Campo `menuId`: select de los menús existentes por nombre. Escribe el MISMO number que el campo
 * numérico de antes (0 = sin menú elegido).
 */
export function MenuPickerControl({ value, onChange }: {
    value: unknown;
    onChange: (v: unknown) => void;
}) {
    const catalog = useMenuCatalog();
    const id = React.useId();
    const parsed = Number(value);
    const current = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

    if (catalog && !catalog.menusOk) {
        return (
            <div>
                <label htmlFor={id} className={LABEL_CLS}>ID del menú (si el origen es Menú)</label>
                <input
                    id={id}
                    type="number"
                    min={0}
                    className={INPUT_CLS}
                    value={current}
                    onChange={(e) => {
                        const n = Number(e.target.value);
                        onChange(Number.isFinite(n) && n > 0 ? n : 0);
                    }}
                />
                <p className="mt-1 text-[10px] text-[var(--ed-outline)]">
                    No se pudieron cargar los menús existentes.
                </p>
            </div>
        );
    }

    const known = current === 0 || !!catalog?.menus.some((m) => m.id === current);

    return (
        <div>
            <label htmlFor={id} className={LABEL_CLS}>Menú (si el origen es Menú)</label>
            <select
                id={id}
                className={INPUT_CLS}
                value={String(current)}
                disabled={!catalog}
                onChange={(e) => {
                    const n = Number(e.target.value);
                    onChange(Number.isFinite(n) && n > 0 ? n : 0);
                }}
            >
                <option value="0">— Sin menú elegido —</option>
                {!known && <option value={String(current)}>{`Menú #${current} (no existe)`}</option>}
                {(catalog?.menus ?? []).map((m) => (
                    <option key={m.id} value={String(m.id)}>{m.name}</option>
                ))}
            </select>
        </div>
    );
}

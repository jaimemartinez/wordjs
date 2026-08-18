"use client";
/**
 * Ajustes → INTERACCIONES: la pantalla de los preajustes del sitio (`wjs_ix_presets`, F9-E).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * QUÉ ERA ESTO ANTES, Y QUÉ ES AHORA
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * El motor ya LEÍA los preajustes del sitio, los validaba, los propagaba por purga de caché y los
 * ofrecía en el panel del bloque. Lo único que faltaba era poder CREARLOS sin llamar a la API a
 * mano. Esta pantalla es esa pieza, y solo esa: no toca el contrato público, no toca el compilador y
 * no toca un byte de `_puck_data`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTO ES EL «KILLER FEATURE» Y NO UN CRUD MÁS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * Un bloque enlazado a un preajuste guarda un ID, no un cuerpo. Editar el preajuste aquí cambia su
 * `rev`, y `rev` entra en el hash del CSS de cada página que lo usa: la siguiente navegación
 * recompila con un nombre de clase nuevo y el navegador no puede servir la hoja vieja. El `git diff`
 * de `_puck_data` de esas páginas está VACÍO. Ese es el gate F9-E entero.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * EL AJUSTE ES DATO HOSTIL — EN LOS DOS SENTIDOS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * · Al LEER: lo que llega del backend pasa entero por `parseSiteIxPresets` → `normalizeIxPreset`.
 *   Puede haberlo escrito esta pantalla, pero también una importación, una restauración de copia o
 *   la API. Un catálogo corrupto deja la lista vacía; nunca una pantalla rota.
 * · Al ESCRIBIR: cada guardado pasa por `ixPresetSave`, que vuelve a normalizar y que reserva el
 *   espacio `sys:`. Y detrás sigue estando el validador de escritura del backend
 *   (`SETTING_VALIDATORS.wjs_ix_presets` en routes/settings.ts), que es la frontera de verdad: esta
 *   pantalla es una comodidad, no una autoridad.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Card, Button, EmptyState } from "@/components/ui";
import { postsApi, settingsApi } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { defaultIxSpec, IX_TARGET_LABELS, IX_TRIGGER_LABELS } from "@/components/verso/editor/ixPanelModel";
import {
    ixPresetDelete,
    ixPresetDuplicate,
    ixPresetSave,
    ixPresetToSpec,
    ixPresetUsage,
    ixSpecToBody,
    parseSiteIxPresets,
    serializeSiteIxPresets,
    IX_MAX_SITE_PRESETS,
    IX_PRESETS_SETTING,
    SYS_IX_PRESETS,
    type IxCatalog,
    type IxPreset,
    type IxSpec,
} from "@/lib/verso/interactions";
import { normalizeVtStyle, type IxVtStyle } from "@/lib/verso/interactions/viewTransitions";
import { normalizeIxMotion, type IxMotionPolicy } from "@/lib/verso/interactions";
import { ixInventoryOf, type IxInventory, type IxInventoryEntry } from "@/lib/verso/interactions/inventory";
import PresetEditor from "./PresetEditor";

/** Estado del formulario. `null` = no hay ninguno abierto. */
type Editing = { id: string | null; name: string; draft: IxSpec } | null;

/** La clave del ajuste del sitio y las etiquetas de autor de sus tres valores. */
const VT_SETTING = "wjs_view_transitions";
const VT_OPTIONS: ReadonlyArray<{ value: IxVtStyle; label: string }> = [
    { value: "off", label: "Sin transición" },
    { value: "fade", label: "Fundido" },
    { value: "slide", label: "Deslizar" },
];

/** La política de movimiento del sitio (C5) y las etiquetas de sus tres valores. */
const MOTION_SETTING = "wjs_motion";
const MOTION_OPTIONS: ReadonlyArray<{ value: IxMotionPolicy; label: string; hint: string }> = [
    { value: "full", label: "Completo", hint: "La página emite lo que cada autor puso." },
    { value: "calm", label: "Tranquilo", hint: "Nada se mueve en bucle: cada animación se reproduce una vez y se queda quieta." },
    { value: "off", label: "Apagado", hint: "Ni una regla de interacción ni un byte de motor: los bloques se ven en su estado natural." },
];

export default function InteractionPresetsPage() {
    const { confirm, alert } = useModal();
    const { addToast } = useToast();

    const [catalog, setCatalog] = useState<IxCatalog>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState<Editing>(null);
    const [error, setError] = useState<string | null>(null);
    /** Recuento de usos por preajuste, para las tarjetas. `null` = aún no se sabe (cargando o falló). */
    const [usage, setUsage] = useState<Map<string, number> | null>(null);

    /** Transición entre páginas (C1): ajuste del SITIO, vive aquí porque es movimiento, no tema. */
    const [vt, setVt] = useState<IxVtStyle>("off");
    const [vtSaving, setVtSaving] = useState(false);

    /** Política de movimiento del sitio (C5). Misma forma que la anterior: optimista con vuelta atrás. */
    const [motion, setMotion] = useState<IxMotionPolicy>("full");
    const [motionSaving, setMotionSaving] = useState(false);

    /** Inventario «dónde se mueve mi sitio» (C5). `null` = aún no se sabe (cargando o falló). */
    const [inventory, setInventory] = useState<IxInventory | null>(null);

    const load = useCallback(async () => {
        try {
            const data = await settingsApi.get();
            setCatalog(parseSiteIxPresets((data as Record<string, unknown> | null)?.[IX_PRESETS_SETTING]));
            setVt(normalizeVtStyle((data as Record<string, unknown> | null)?.[VT_SETTING]));
            setMotion(normalizeIxMotion((data as Record<string, unknown> | null)?.[MOTION_SETTING]));
        } catch (e) {
            console.error("No se pudieron leer los preajustes de interacción:", e);
            addToast("No se pudieron leer los preajustes.", "error");
        } finally {
            setLoading(false);
        }
    }, [addToast]);

    useEffect(() => {
        void load();
    }, [load]);

    /**
     * Guarda la transición entre páginas. Igual que el catálogo: se manda SOLO su clave, porque el
     * backend mergea por clave y reenviar el resto pisaría lo que otra pestaña hubiera cambiado.
     * Optimista con vuelta atrás: si el guardado falla, el botón activo vuelve al valor anterior.
     */
    const saveVt = async (next: IxVtStyle): Promise<void> => {
        if (next === vt || vtSaving) return;
        const prev = vt;
        setVt(next);
        setVtSaving(true);
        try {
            await settingsApi.update({ [VT_SETTING]: next });
            addToast(next === "off" ? "Transiciones desactivadas." : "Transición guardada.", "success");
        } catch (e) {
            setVt(prev);
            const message = e instanceof Error ? e.message : String(e);
            await alert(`No se pudo guardar: ${message}`);
        } finally {
            setVtSaving(false);
        }
    };

    /**
     * Guarda la política de movimiento. Igual que la transición: solo su clave (el backend mergea) y
     * optimista con vuelta atrás si el guardado falla.
     */
    const saveMotion = async (next: IxMotionPolicy): Promise<void> => {
        if (next === motion || motionSaving) return;
        const prev = motion;
        setMotion(next);
        setMotionSaving(true);
        try {
            await settingsApi.update({ [MOTION_SETTING]: next });
            addToast("Política de movimiento guardada.", "success");
        } catch (e) {
            setMotion(prev);
            const message = e instanceof Error ? e.message : String(e);
            await alert(`No se pudo guardar: ${message}`);
        } finally {
            setMotionSaving(false);
        }
    };

    /** Orden estable por nombre: el ajuste puede llegar en cualquier orden, la lista no baila. */
    const list = useMemo(
        () =>
            Object.values(catalog).sort(
                (a, b) => a.name.localeCompare(b.name, "es") || a.id.localeCompare(b.id),
            ),
        [catalog],
    );

    /**
     * Persiste un catálogo entero. Se manda SOLO la clave del ajuste: el backend mergea por clave, y
     * enviar el resto de ajustes desde aquí sería reescribir con lo que esta pantalla leyó al abrirse
     * — es decir, pisar en silencio lo que alguien hubiera cambiado en otra pestaña.
     */
    const persist = async (next: IxCatalog): Promise<boolean> => {
        setSaving(true);
        try {
            await settingsApi.update({ [IX_PRESETS_SETTING]: serializeSiteIxPresets(next) });
            setCatalog(next);
            return true;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await alert(`No se pudo guardar: ${message}`);
            return false;
        } finally {
            setSaving(false);
        }
    };

    const startNew = () => {
        setError(null);
        // El cuerpo de partida es el mismo que ofrece «Personalizada» en el panel del bloque: la
        // entrada de siempre, que es el punto de partida más corto hacia cualquier otra cosa.
        setEditing({ id: null, name: "", draft: defaultIxSpec() });
    };

    const startEdit = (preset: IxPreset) => {
        setError(null);
        setEditing({ id: preset.id, name: preset.name, draft: ixPresetToSpec(preset) });
    };

    const save = async () => {
        if (!editing) return;
        const body = ixSpecToBody(editing.draft);
        if (!body) {
            setError("Este preajuste no anima nada: añade alguna propiedad a sus pasos.");
            return;
        }
        const result = ixPresetSave(catalog, {
            id: editing.id ?? undefined,
            name: editing.name,
            trigger: body.trigger,
            tracks: body.tracks,
        });
        if (!result.ok) {
            setError(result.error);
            return;
        }
        if (await persist(result.catalog)) {
            setEditing(null);
            setError(null);
            addToast(
                editing.id
                    ? "Preajuste guardado. Las páginas que lo usan lo mostrarán actualizado."
                    : "Preajuste creado. Ya está en el desplegable del editor.",
                "success",
            );
        }
    };

    /**
     * Recuento de usos: cuántos bloques REFERENCIAN cada preajuste por id (riesgo R6 de la spec).
     *
     * Es UNA pasada sobre el contenido (dos GET: páginas y entradas, los mismos listados del admin)
     * con dos consumidores: las tarjetas de la lista, que lo pagan una vez al abrir la pantalla, y
     * la confirmación de borrado, que lo REHACE al pulsar — el de las tarjetas puede llevar un rato
     * en pantalla y otra pestaña puede haber enlazado el preajuste mientras tanto. Solo se cuentan
     * las referencias por id: un bloque que desvinculó el preajuste ya tiene su propio cuerpo y
     * borrar este no le afecta.
     */
    const scanUsage = useCallback(async (): Promise<Map<string, number> | null> => {
        try {
            const [pages, posts] = await Promise.all([
                postsApi.list("page", "any"),
                postsApi.list("post", "any"),
            ]);
            const counts = new Map<string, number>();
            let sawContent = false;
            for (const post of [...pages, ...posts]) {
                const raw = post.meta?._puck_data;
                if (raw === undefined || raw === null) continue;
                sawContent = true;
                let data: unknown = raw;
                if (typeof raw === "string") {
                    try {
                        data = JSON.parse(raw);
                    } catch {
                        continue;
                    }
                }
                ixPresetUsage(data, counts);
            }
            // Si NINGUNA entrada trajo su contenido, el recuento sería un 0 mentiroso.
            return sawContent ? counts : null;
        } catch {
            return null;
        }
    }, []);

    /**
     * El inventario del movimiento. Recorre los mismos contenidos que el recuento de preajustes y
     * los pasa por el COMPILADOR de verdad, así que lo que se lista es lo que las páginas emiten —
     * incluida la política del sitio, que puede estar dejando quieto todo lo que aquí se cuenta.
     */
    const scanInventory = useCallback(async (): Promise<IxInventory | null> => {
        try {
            const [pages, posts] = await Promise.all([
                postsApi.list("page", "any"),
                postsApi.list("post", "any"),
            ]);
            const entries: IxInventoryEntry[] = [];
            for (const post of [...pages, ...posts]) {
                const raw = post.meta?._puck_data;
                if (raw === undefined || raw === null) continue;
                let data: unknown = raw;
                if (typeof raw === "string") {
                    try {
                        data = JSON.parse(raw);
                    } catch {
                        continue;
                    }
                }
                entries.push({
                    id: post.id,
                    title: typeof post.title === "string" ? post.title : `#${post.id}`,
                    slug: typeof post.slug === "string" ? post.slug : "",
                    type: typeof post.type === "string" ? post.type : "page",
                    data,
                });
            }
            return ixInventoryOf(entries, { presets: { ...SYS_IX_PRESETS, ...catalog }, motion });
        } catch {
            return null;
        }
    }, [catalog, motion]);

    // El inventario se recalcula cuando cambia la política: es la pregunta «y ahora qué se mueve».
    useEffect(() => {
        let alive = true;
        void scanInventory().then((inv) => {
            if (alive) setInventory(inv);
        });
        return () => {
            alive = false;
        };
    }, [scanInventory]);

    // El recuento de las tarjetas, una vez al montar. Si el escaneo no puede saber (falló, o nada
    // trajo contenido), `usage` se queda en `null` y las tarjetas enseñan «—», nunca un 0 inventado.
    useEffect(() => {
        let alive = true;
        void scanUsage().then((counts) => {
            if (alive && counts) setUsage(counts);
        });
        return () => {
            alive = false;
        };
    }, [scanUsage]);

    const remove = async (preset: IxPreset) => {
        // Recuento FRESCO al pulsar (y de paso se refrescan las tarjetas, que pueden estar viejas).
        const counts = await scanUsage();
        if (counts) setUsage(counts);
        const uses = counts ? (counts.get(preset.id) ?? 0) : null;
        const detail =
            uses === null
                ? "Los bloques que lo usen se seguirán viendo, pero dejarán de moverse."
                : uses === 0
                    ? "Ningún bloque lo usa ahora mismo."
                    : `Lo usan ${uses} ${uses === 1 ? "bloque" : "bloques"}: se seguirán viendo, pero dejarán de moverse.`;
        const ok = await confirm(
            `Vas a borrar «${preset.name}». ${detail}`,
            "Borrar preajuste",
            true,
        );
        if (!ok) return;
        if (await persist(ixPresetDelete(catalog, preset.id))) {
            if (editing?.id === preset.id) setEditing(null);
            addToast("Preajuste borrado.", "success");
        }
    };

    const duplicate = async (preset: IxPreset) => {
        const result = ixPresetDuplicate(catalog, preset.id);
        if (!result.ok) {
            await alert(result.error);
            return;
        }
        if (await persist(result.catalog)) addToast("Preajuste duplicado.", "success");
    };

    const full = Object.keys(catalog).length >= IX_MAX_SITE_PRESETS;

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50">
            <div className="max-w-4xl mx-auto">
                <PageHeader
                    title="Interacciones"
                    subtitle="Preajustes de movimiento del sitio"
                    actions={
                        <Button icon="fa-plus" disabled={full || editing !== null} onClick={startNew}>
                            Nuevo preajuste
                        </Button>
                    }
                />

                <Card className="mb-8">
                    <h2 className="text-sm font-bold text-gray-900">Qué es un preajuste</h2>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        Un movimiento con nombre que puedes aplicar a cualquier bloque desde el editor.
                        El bloque guarda solo su <strong>nombre interno</strong>, no una copia: cuando
                        editas el preajuste aquí, <strong>todos los bloques que lo usan cambian a la
                        vez</strong>, en todas las páginas, sin tocar el contenido de ninguna.
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        Los preajustes que trae WordJS (los del sistema) no se editan ni se borran, y su
                        nombre está reservado: aquí solo viven los tuyos.
                    </p>
                </Card>

                {/* ── Movimiento del sitio (C5) — la política que manda sobre TODAS las páginas ── */}
                <Card className="mb-8">
                    <h2 className="text-sm font-bold text-gray-900">Movimiento del sitio</h2>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        Una decisión de sitio, por encima de lo que ponga cada bloque. Sirve para
                        campañas, para accesibilidad y para apagarlo todo el día que haga falta —
                        <strong> sin tocar ni una página</strong>.
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Movimiento del sitio">
                        {MOTION_OPTIONS.map((opt) => {
                            const active = motion === opt.value;
                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    aria-pressed={active}
                                    disabled={motionSaving}
                                    onClick={() => void saveMotion(opt.value)}
                                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                                        active
                                            ? "bg-gray-900 text-white"
                                            : "border border-gray-200 text-gray-600 hover:border-gray-400 hover:text-gray-900"
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            );
                        })}
                        {motionSaving && <span className="text-xs text-gray-500">Guardando…</span>}
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-gray-500">
                        {MOTION_OPTIONS.find((o) => o.value === motion)?.hint}
                    </p>
                </Card>

                {/* ── Dónde se mueve mi sitio (C5) — el inventario, con el compilador de verdad ── */}
                <Card className="mb-8">
                    <h2 className="text-sm font-bold text-gray-900">Dónde se mueve mi sitio</h2>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        Lo que las páginas <strong>emiten de verdad</strong>, no lo que alguien quiso
                        poner: se compila cada página con el mismo motor que sirve el sitio. Primero
                        lo que se mueve en bucle y lo que obliga a descargar JavaScript, que es lo
                        que conviene revisar.
                    </p>
                    {inventory === null ? (
                        <p className="mt-4 text-sm text-gray-500">Calculando…</p>
                    ) : inventory.rows.length === 0 ? (
                        <p className="mt-4 text-sm text-gray-500">
                            {motion === "off"
                                ? "El movimiento del sitio está apagado: ninguna página emite interacciones."
                                : `Ninguna de las ${inventory.totals.pages} entradas tiene movimiento.`}
                        </p>
                    ) : (
                        <>
                            <p className="mt-4 text-xs text-gray-500">
                                {inventory.totals.moving} de {inventory.totals.pages} con movimiento ·{" "}
                                {inventory.totals.blocks} bloques · {inventory.totals.infinite} en bucle ·{" "}
                                {inventory.totals.runtime} necesitan el motor ·{" "}
                                {inventory.totals.entrances} entradas clásicas ·{" "}
                                {(inventory.totals.cssBytes / 1024).toFixed(1)} KB de CSS
                            </p>
                            <div className="mt-3 overflow-x-auto">
                                <table className="w-full text-left text-xs">
                                    <thead className="text-gray-500">
                                        <tr>
                                            <th scope="col" className="py-1 pr-3 font-semibold">Página</th>
                                            <th scope="col" className="py-1 pr-3 font-semibold">Bloques</th>
                                            <th scope="col" className="py-1 pr-3 font-semibold">En bucle</th>
                                            <th scope="col" className="py-1 pr-3 font-semibold">Con motor</th>
                                            <th scope="col" className="py-1 pr-3 font-semibold">Entradas</th>
                                            <th scope="col" className="py-1 pr-3 font-semibold">Preajustes</th>
                                            <th scope="col" className="py-1 font-semibold">CSS</th>
                                        </tr>
                                    </thead>
                                    <tbody className="text-gray-700">
                                        {inventory.rows.map((row) => (
                                            <tr key={`${row.type}-${row.id}`} className="border-t border-gray-100">
                                                <td className="py-1.5 pr-3">
                                                    <a
                                                        href={`/admin/editor/${row.id}`}
                                                        className="font-medium text-gray-900 hover:underline"
                                                    >
                                                        {row.title}
                                                    </a>
                                                    <span className="ml-1 text-gray-400">/{row.slug}</span>
                                                </td>
                                                <td className="py-1.5 pr-3">
                                                    {row.blocks}
                                                    {row.units !== row.blocks && (
                                                        <span className="text-gray-400"> ({row.units} distintas)</span>
                                                    )}
                                                </td>
                                                <td className={`py-1.5 pr-3 ${row.infinite > 0 ? "font-semibold text-gray-900" : "text-gray-400"}`}>
                                                    {row.infinite || "—"}
                                                </td>
                                                <td className={`py-1.5 pr-3 ${row.runtime > 0 ? "text-gray-900" : "text-gray-400"}`}>
                                                    {row.runtime || "—"}
                                                </td>
                                                {/* La entrada CLÁSICA (`anim`) es lo que llevan casi todas las páginas
                                                    ya publicadas: sin esta columna el inventario diría que están quietas. */}
                                                <td className={`py-1.5 pr-3 ${row.entrances > 0 ? "text-gray-900" : "text-gray-400"}`}>
                                                    {row.entrances || "—"}
                                                </td>
                                                <td className="py-1.5 pr-3 text-gray-500">
                                                    {row.presets.length > 0 ? row.presets.join(", ") : "—"}
                                                </td>
                                                <td className="py-1.5 text-gray-500">
                                                    {(row.cssBytes / 1024).toFixed(1)} KB
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </Card>

                {/* ── Transiciones entre páginas (C1) — ajuste del SITIO, no de un bloque ── */}
                <Card className="mb-8">
                    <h2 className="text-sm font-bold text-gray-900">Transiciones entre páginas</h2>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        Al navegar de una página a otra, el sitio puede fundirse o deslizarse en vez de
                        parpadear en blanco. Son <strong>dos reglas de CSS</strong>: cero JavaScript, y
                        el visitante con «reducir movimiento» ve el cambio instantáneo, sin animación.
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-gray-500">
                        En los navegadores que aún no lo implementan, la navegación es la de siempre.
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Transición entre páginas">
                        {VT_OPTIONS.map((opt) => {
                            const active = vt === opt.value;
                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    aria-pressed={active}
                                    disabled={vtSaving}
                                    onClick={() => void saveVt(opt.value)}
                                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                                        active
                                            ? "bg-gray-900 text-white"
                                            : "border border-gray-200 text-gray-600 hover:border-gray-400 hover:text-gray-900"
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            );
                        })}
                        {vtSaving && <span className="text-xs text-gray-500">Guardando…</span>}
                    </div>
                </Card>

                {editing && (
                    <div className="mb-8">
                        <PresetEditor
                            draft={editing.draft}
                            name={editing.name}
                            id={editing.id}
                            error={error}
                            saving={saving}
                            onName={(name) => setEditing({ ...editing, name })}
                            onDraft={(draft) => setEditing({ ...editing, draft })}
                            onSave={save}
                            onCancel={() => {
                                setEditing(null);
                                setError(null);
                            }}
                        />
                    </div>
                )}

                {loading ? (
                    <Card>
                        <p className="text-sm text-gray-500">Cargando preajustes…</p>
                    </Card>
                ) : list.length === 0 ? (
                    <EmptyState
                        icon="fa-wand-magic-sparkles"
                        title="Todavía no hay preajustes del sitio"
                        description="Crea uno y aparecerá en el desplegable «Preajuste» de cualquier bloque del editor."
                        action={
                            editing ? undefined : (
                                <Button icon="fa-plus" onClick={startNew}>
                                    Nuevo preajuste
                                </Button>
                            )
                        }
                    />
                ) : (
                    <ul className="space-y-4" aria-label="Preajustes de interacción del sitio">
                        {list.map((preset) => (
                            <li key={preset.id}>
                                <Card>
                                    <div className="flex flex-wrap items-start justify-between gap-4">
                                        <div className="min-w-0">
                                            <h3 className="text-base font-bold text-gray-900">{preset.name}</h3>
                                            <p className="mt-1 font-mono text-xs text-gray-400">{preset.id}</p>
                                            <p className="mt-2 text-sm text-gray-600">
                                                {IX_TRIGGER_LABELS[preset.trigger.on]} ·{" "}
                                                {summaryOfTarget(preset)} ·{" "}
                                                {preset.tracks[0].steps.length} pasos · revisión {preset.rev}
                                            </p>
                                            <p className="mt-1 text-xs text-gray-500">
                                                {usageLabel(usage, preset.id)}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 gap-2">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                disabled={saving}
                                                onClick={() => startEdit(preset)}
                                            >
                                                Editar
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled={saving || full}
                                                onClick={() => void duplicate(preset)}
                                            >
                                                Duplicar
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="danger"
                                                disabled={saving}
                                                onClick={() => void remove(preset)}
                                            >
                                                Borrar
                                            </Button>
                                        </div>
                                    </div>
                                </Card>
                            </li>
                        ))}
                    </ul>
                )}

                {full && (
                    <p className="mt-6 text-sm text-gray-500">
                        Has llegado al máximo de {IX_MAX_SITE_PRESETS} preajustes del sitio. Cada uno
                        emite reglas en las páginas que lo usan, y ese presupuesto se mide por página.
                    </p>
                )}
            </div>
        </div>
    );
}

/** «Lo usan N bloques» — referencias por id del escaneo de arriba; «—» mientras no se sabe. */
function usageLabel(usage: Map<string, number> | null, id: string): string {
    if (!usage) return "—";
    const n = usage.get(id) ?? 0;
    if (n === 0) return "Sin usos";
    return n === 1 ? "Lo usa 1 bloque" : `Lo usan ${n} bloques`;
}

/** «Este bloque» / «Sus hijos» / «Las palabras» — el objetivo de la primera pista, en cristiano. */
function summaryOfTarget(preset: IxPreset): string {
    const kind = preset.tracks[0].target.kind;
    if (kind === "block") return "otro bloque";
    return IX_TARGET_LABELS[kind].toLowerCase();
}

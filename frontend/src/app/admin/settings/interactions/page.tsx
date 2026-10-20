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
import { PageHeader, Card, Button, EmptyState, DataTable } from "@/components/ui";
import { postsApi, settingsApi } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { t as translate, type Language } from "@/lib/i18n";
import { defaultIxSpec, IX_TARGET_LABELS, IX_TRIGGER_LABELS } from "@/components/verso/editor/ixPanelModel";
import { trStr } from "@/lib/editorI18n";
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
const VT_OPTIONS: ReadonlyArray<{ value: IxVtStyle; labelKey: string }> = [
    { value: "off", labelKey: "interactions.vt.off" },
    { value: "fade", labelKey: "interactions.vt.fade" },
    { value: "slide", labelKey: "interactions.vt.slide" },
];

/** La política de movimiento del sitio (C5) y las etiquetas de sus tres valores. */
const MOTION_SETTING = "wjs_motion";
const MOTION_OPTIONS: ReadonlyArray<{ value: IxMotionPolicy; labelKey: string; hintKey: string }> = [
    { value: "full", labelKey: "interactions.motion.full", hintKey: "interactions.motion.fullHint" },
    { value: "calm", labelKey: "interactions.motion.calm", hintKey: "interactions.motion.calmHint" },
    { value: "off", labelKey: "interactions.motion.off", hintKey: "interactions.motion.offHint" },
];

/** Pinta `texto **fuerte** texto` con `<strong>` en los tramos marcados (el catálogo no lleva HTML). */
function rich(text: string): React.ReactNode {
    return text.split("**").map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

export default function InteractionPresetsPage() {
    const { confirm, alert } = useModal();
    const { addToast } = useToast();
    const { t, language } = useI18n();

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
            // `t` del contexto cambia de identidad en cada render; el idioma no.
            addToast(translate("interactions.toast.loadError", language), "error");
        } finally {
            setLoading(false);
        }
    }, [addToast, language]);

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
            addToast(next === "off" ? t("interactions.toast.vtOff") : t("interactions.toast.vtSaved"), "success");
        } catch (e) {
            setVt(prev);
            const message = e instanceof Error ? e.message : String(e);
            await alert(t("interactions.error.saveFailed").replace("{message}", message));
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
            addToast(t("interactions.toast.motionSaved"), "success");
        } catch (e) {
            setMotion(prev);
            const message = e instanceof Error ? e.message : String(e);
            await alert(t("interactions.error.saveFailed").replace("{message}", message));
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
            await alert(t("interactions.error.saveFailed").replace("{message}", message));
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
            setError(t("interactions.error.noAnimation"));
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
                    ? t("interactions.toast.saved")
                    : t("interactions.toast.created"),
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
                ? t("interactions.delete.usesUnknown")
                : uses === 0
                    ? t("interactions.delete.usesNone")
                    : uses === 1
                        ? t("interactions.delete.usesOne")
                        : t("interactions.delete.usesMany").replace("{count}", String(uses));
        const ok = await confirm(
            t("interactions.delete.message").replace("{name}", preset.name).replace("{detail}", detail),
            t("interactions.delete.title"),
            true,
        );
        if (!ok) return;
        if (await persist(ixPresetDelete(catalog, preset.id))) {
            if (editing?.id === preset.id) setEditing(null);
            addToast(t("interactions.toast.deleted"), "success");
        }
    };

    const duplicate = async (preset: IxPreset) => {
        const result = ixPresetDuplicate(catalog, preset.id);
        if (!result.ok) {
            await alert(result.error);
            return;
        }
        if (await persist(result.catalog)) addToast(t("interactions.toast.duplicated"), "success");
    };

    const full = Object.keys(catalog).length >= IX_MAX_SITE_PRESETS;

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50">
            <div className="max-w-4xl mx-auto">
                <PageHeader
                    title={t("interactions.title")}
                    subtitle={t("interactions.subtitle")}
                    actions={
                        <Button icon="fa-plus" disabled={full || editing !== null} onClick={startNew}>
                            {t("interactions.newPreset")}
                        </Button>
                    }
                />

                <Card className="mb-8">
                    <h2 className="text-sm font-bold text-gray-900">{t("interactions.about.title")}</h2>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        {rich(t("interactions.about.body"))}
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        {t("interactions.about.system")}
                    </p>
                </Card>

                {/* ── Movimiento del sitio (C5) — la política que manda sobre TODAS las páginas ── */}
                <Card className="mb-8">
                    <h2 className="text-sm font-bold text-gray-900">{t("interactions.motion.title")}</h2>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        {rich(t("interactions.motion.body"))}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label={t("interactions.motion.title")}>
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
                                    {t(opt.labelKey)}
                                </button>
                            );
                        })}
                        {motionSaving && <span className="text-xs text-gray-500">{t("interactions.saving")}</span>}
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-gray-500">
                        {(() => {
                            const hintKey = MOTION_OPTIONS.find((o) => o.value === motion)?.hintKey;
                            return hintKey ? t(hintKey) : null;
                        })()}
                    </p>
                </Card>

                {/* ── Dónde se mueve mi sitio (C5) — el inventario, con el compilador de verdad ── */}
                <Card className="mb-8">
                    <h2 className="text-sm font-bold text-gray-900">{t("interactions.inventory.title")}</h2>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        {rich(t("interactions.inventory.body"))}
                    </p>
                    {inventory === null ? (
                        <p className="mt-4 text-sm text-gray-500">{t("interactions.inventory.computing")}</p>
                    ) : inventory.rows.length === 0 ? (
                        <p className="mt-4 text-sm text-gray-500">
                            {motion === "off"
                                ? t("interactions.inventory.motionOff")
                                : t("interactions.inventory.noneMoving").replace("{count}", String(inventory.totals.pages))}
                        </p>
                    ) : (
                        <>
                            <p className="mt-4 text-xs text-gray-500">
                                {t("interactions.inventory.totals")
                                    .replace("{moving}", String(inventory.totals.moving))
                                    .replace("{pages}", String(inventory.totals.pages))
                                    .replace("{blocks}", String(inventory.totals.blocks))
                                    .replace("{infinite}", String(inventory.totals.infinite))
                                    .replace("{runtime}", String(inventory.totals.runtime))
                                    .replace("{entrances}", String(inventory.totals.entrances))
                                    .replace("{kb}", (inventory.totals.cssBytes / 1024).toFixed(1))}
                            </p>
                            <DataTable
                                className="mt-3 -mx-1"
                                rows={inventory.rows}
                                rowKey={(row) => `${row.type}-${row.id}`}
                                caption={t("interactions.inventory.caption")}
                                rowLabel={(row) => row.title}
                                density="compact"
                                stackBelow="lg"
                                columns={[
                                    {
                                        key: "page",
                                        header: t("interactions.inventory.colPage"),
                                        primary: true,
                                        cell: (row) => (
                                            <span className="text-sm">
                                                <a href={`/admin/${row.type === "page" ? "pages" : "posts"}/${row.id}`} className="inline-flex items-center pointer-coarse:min-h-11 font-medium text-gray-900 hover:underline break-words">
                                                    {row.title}
                                                </a>
                                                <span className="ml-1 text-gray-500 break-all">/{row.slug}</span>
                                            </span>
                                        ),
                                    },
                                    {
                                        key: "blocks",
                                        header: t("interactions.inventory.colBlocks"),
                                        cell: (row) => (
                                            <span className="text-xs text-gray-700">
                                                {row.blocks}
                                                {row.units !== row.blocks && <span className="text-gray-500"> {t("interactions.inventory.distinct").replace("{count}", String(row.units))}</span>}
                                            </span>
                                        ),
                                    },
                                    { key: "infinite", header: t("interactions.inventory.colInfinite"), cell: (row) => <span className={`text-xs ${row.infinite > 0 ? "font-semibold text-gray-900" : "text-gray-400"}`}>{row.infinite || "—"}</span> },
                                    { key: "runtime", header: t("interactions.inventory.colRuntime"), cell: (row) => <span className={`text-xs ${row.runtime > 0 ? "text-gray-900" : "text-gray-400"}`}>{row.runtime || "—"}</span> },
                                    // La entrada CLÁSICA (`anim`) es lo que llevan casi todas las páginas
                                    // ya publicadas: sin esta columna el inventario diría que están quietas.
                                    { key: "entrances", header: t("interactions.inventory.colEntrances"), cell: (row) => <span className={`text-xs ${row.entrances > 0 ? "text-gray-900" : "text-gray-400"}`}>{row.entrances || "—"}</span> },
                                    { key: "presets", header: t("interactions.inventory.colPresets"), cell: (row) => <span className="text-xs text-gray-500 break-words">{row.presets.length > 0 ? row.presets.join(", ") : "—"}</span> },
                                    { key: "css", header: "CSS", cell: (row) => <span className="text-xs text-gray-500 whitespace-nowrap">{(row.cssBytes / 1024).toFixed(1)} KB</span> },
                                ]}
                            />
                        </>
                    )}
                </Card>

                {/* ── Transiciones entre páginas (C1) — ajuste del SITIO, no de un bloque ── */}
                <Card className="mb-8">
                    <h2 className="text-sm font-bold text-gray-900">{t("interactions.vt.title")}</h2>
                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                        {rich(t("interactions.vt.body"))}
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-gray-500">
                        {t("interactions.vt.fallback")}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label={t("interactions.vt.groupLabel")}>
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
                                    {t(opt.labelKey)}
                                </button>
                            );
                        })}
                        {vtSaving && <span className="text-xs text-gray-500">{t("interactions.saving")}</span>}
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
                        <p className="text-sm text-gray-500">{t("interactions.loading")}</p>
                    </Card>
                ) : list.length === 0 ? (
                    <EmptyState
                        icon="fa-wand-magic-sparkles"
                        title={t("interactions.empty.title")}
                        description={t("interactions.empty.description")}
                        action={
                            editing ? undefined : (
                                <Button icon="fa-plus" onClick={startNew}>
                                    {t("interactions.newPreset")}
                                </Button>
                            )
                        }
                    />
                ) : (
                    <ul className="space-y-4" aria-label={t("interactions.listLabel")}>
                        {list.map((preset) => (
                            <li key={preset.id}>
                                <Card>
                                    <div className="flex flex-wrap items-start justify-between gap-4">
                                        <div className="min-w-0">
                                            <h3 className="text-base font-bold text-gray-900">{preset.name}</h3>
                                            <p className="mt-1 font-mono text-xs text-gray-400">{preset.id}</p>
                                            <p className="mt-2 text-sm text-gray-600">
                                                {trStr(IX_TRIGGER_LABELS[preset.trigger.on], language)} ·{" "}
                                                {summaryOfTarget(preset, t, language)} ·{" "}
                                                {t("interactions.card.stepsRev")
                                                    .replace("{count}", String(preset.tracks[0].steps.length))
                                                    .replace("{rev}", String(preset.rev))}
                                            </p>
                                            <p className="mt-1 text-xs text-gray-500">
                                                {usageLabel(usage, preset.id, t)}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 gap-2">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                disabled={saving}
                                                onClick={() => startEdit(preset)}
                                            >
                                                {t("interactions.card.edit")}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled={saving || full}
                                                onClick={() => void duplicate(preset)}
                                            >
                                                {t("interactions.card.duplicate")}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="danger"
                                                disabled={saving}
                                                onClick={() => void remove(preset)}
                                            >
                                                {t("interactions.card.delete")}
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
                        {t("interactions.limitReached").replace("{max}", String(IX_MAX_SITE_PRESETS))}
                    </p>
                )}
            </div>
        </div>
    );
}

/** «Lo usan N bloques» — referencias por id del escaneo de arriba; «—» mientras no se sabe. */
function usageLabel(usage: Map<string, number> | null, id: string, t: (key: string) => string): string {
    if (!usage) return "—";
    const n = usage.get(id) ?? 0;
    if (n === 0) return t("interactions.usage.none");
    return n === 1 ? t("interactions.usage.one") : t("interactions.usage.many").replace("{count}", String(n));
}

/** «Este bloque» / «Sus hijos» / «Las palabras» — el objetivo de la primera pista, en cristiano. */
function summaryOfTarget(preset: IxPreset, t: (key: string) => string, language: Language): string {
    const kind = preset.tracks[0].target.kind;
    if (kind === "block") return t("interactions.card.otherBlock");
    return trStr(IX_TARGET_LABELS[kind], language).toLowerCase();
}

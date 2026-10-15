"use client";
/**
 * Verso — piezas del dock de movimiento que no son el inspector ni el escenario:
 *
 *  - DockTabs: con el dock estrecho (portátil con los dos paneles abiertos) inspector y escenario no
 *    caben lado a lado; van en pestañas «Ajustes | Línea de tiempo».
 *  - PresetBar: responde a «¿cómo se crean los preajustes?» DONDE se usan. Con un movimiento propio
 *    en el bloque, «Guardar como preajuste» lo pasa al catálogo del sitio y deja el bloque enlazado;
 *    «Gestionar preajustes» abre Ajustes ▸ Interacciones en otra pestaña (al volver, el editor relee
 *    el catálogo — useSiteIxPresets). Antes nada en el editor decía que los preajustes existían
 *    fuera del desplegable, ni cómo hacer uno.
 */
import React, { useState } from "react";
import MSym from "@/components/editor/MSym";
import type { Language } from "@/lib/i18n";
import { trStr } from "@/lib/editorI18n";
import { settingsApi } from "@/lib/api";
import {
    IX_PRESET_NAME_MAX,
    IX_PRESETS_SETTING,
    parseSiteIxPresets,
    serializeSiteIxPresets,
    type IxCompileCtx,
} from "@/lib/verso/interactions";
import { setSiteIxCtx } from "../canvas/useSiteIxPresets";
import { saveBlockIxAsPreset, type IxWrite } from "./ixPanelModel";

/** Ajustes ▸ Interacciones: donde viven (y se editan) los preajustes del sitio. */
export const PRESETS_ADMIN_HREF = "/admin/settings/interactions";

export type DockPane = "settings" | "timeline";

export function DockTabs({
    pane,
    onPane,
    tracks,
    language,
}: {
    pane: DockPane;
    onPane: (p: DockPane) => void;
    tracks: number;
    language: Language;
}) {
    const tabs: [DockPane, string, string][] = [
        ["settings", "tune", "Ajustes"],
        ["timeline", "animation", "Línea de tiempo"],
    ];
    return (
        <div
            role="tablist"
            aria-label={trStr("Movimiento", language)}
            className="shrink-0 h-9 px-2 flex items-center gap-1 border-b border-[var(--ed-outline-variant)]"
        >
            {tabs.map(([id, icon, label]) => (
                <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={pane === id}
                    data-verso-dock-tab={id}
                    onClick={() => onPane(id)}
                    className={`h-7 px-3 rounded-lg inline-flex items-center gap-1.5 text-[11px] font-semibold transition-colors ${
                        pane === id
                            ? "bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)]"
                            : "text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
                    }`}
                >
                    <MSym name={icon} size={14} />
                    {trStr(label, language)}
                    {id === "timeline" && tracks > 0 && <span className="text-[10px] tabular-nums opacity-70">{tracks}</span>}
                </button>
            ))}
        </div>
    );
}

export function PresetBar({
    ix,
    linked,
    active,
    presetName,
    ixCtx,
    language,
    onLinked,
}: {
    ix: unknown;
    linked: boolean;
    active: boolean;
    presetName: string | null;
    ixCtx: IxCompileCtx | undefined;
    language: Language;
    onLinked: (next: IxWrite) => void;
}) {
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
    const canSave = active && !linked;

    const save = async () => {
        if (busy) return;
        setBusy(true);
        setMsg(null);
        try {
            // Releer ANTES de escribir: el backend mergea por clave, y escribir el catálogo que el
            // editor leyó al abrirse pisaría lo guardado después en Ajustes (otra pestaña).
            const settings = (await settingsApi.get()) as Record<string, unknown> | null;
            const site = parseSiteIxPresets(settings?.[IX_PRESETS_SETTING]);
            const result = saveBlockIxAsPreset(site, name, ix, ixCtx);
            if (!result.ok) {
                setMsg({ kind: "error", text: result.error });
                return;
            }
            await settingsApi.update({ [IX_PRESETS_SETTING]: serializeSiteIxPresets(result.catalog) });
            // Primero el catálogo (que el desplegable conozca el id), luego el enlace del bloque.
            setSiteIxCtx(result.ctx);
            onLinked(result.ix);
            setNaming(false);
            setName("");
            setMsg({
                kind: "ok",
                text: `${trStr("Guardado como preajuste", language)}: «${result.catalog[result.id]?.name ?? name.trim()}»`,
            });
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            setMsg({ kind: "error", text: `${trStr("No se pudo guardar el preajuste", language)}: ${detail}` });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div data-verso-preset-bar="" className="mb-3 rounded-lg bg-[var(--ed-surface-container-low)] px-2.5 py-2">
            <div className="flex items-start gap-2">
                <MSym name="collections" size={16} className="shrink-0 mt-0.5 text-[var(--ed-on-surface-variant)]" />
                <p className="min-w-0 flex-1 text-[11px] leading-4 text-[var(--ed-on-surface-variant)]">
                    {linked ? (
                        <>
                            {trStr("Usa el preajuste", language)}{" "}
                            <strong className="font-semibold text-[var(--ed-on-surface)]">«{presetName}»</strong>.{" "}
                            {trStr("Cambiarlo en Ajustes cambia todos los bloques que lo usan.", language)}
                        </>
                    ) : active ? (
                        trStr("¿Te gusta este movimiento? Guárdalo como preajuste y reutilízalo en otros bloques.", language)
                    ) : (
                        trStr("Los preajustes son movimientos guardados del sitio: elige uno abajo, o crea el tuyo y guárdalo aquí.", language)
                    )}
                </p>
            </div>
            {naming ? (
                <form
                    className="mt-2 flex items-center gap-1.5"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                    }}
                >
                    <input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                e.preventDefault();
                                setNaming(false);
                            }
                        }}
                        maxLength={IX_PRESET_NAME_MAX}
                        placeholder={trStr("Nombre del preajuste", language)}
                        aria-label={trStr("Nombre del preajuste", language)}
                        className="min-w-0 flex-1 h-8 rounded-lg border border-[var(--ed-outline-variant)] bg-[var(--ed-surface)] px-2 text-[12px] text-[var(--ed-on-surface)] focus:outline-none focus:border-[var(--ed-primary)]"
                    />
                    <button
                        type="submit"
                        disabled={busy || name.trim() === ""}
                        aria-busy={busy}
                        className="h-8 shrink-0 rounded-lg bg-[var(--ed-primary-solid,var(--ed-primary))] px-3 text-[11px] font-semibold text-[var(--ed-on-primary,#fff)] disabled:opacity-40 inline-flex items-center"
                    >
                        {busy ? <MSym name="sync" size={14} className="animate-spin" /> : trStr("Guardar", language)}
                    </button>
                    <button
                        type="button"
                        onClick={() => setNaming(false)}
                        aria-label={trStr("Cancelar", language)}
                        title={trStr("Cancelar", language)}
                        className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
                    >
                        <MSym name="close" size={16} />
                    </button>
                </form>
            ) : (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    {canSave ? (
                        <button
                            type="button"
                            data-verso-save-preset=""
                            onClick={() => {
                                setMsg(null);
                                setNaming(true);
                            }}
                            className="h-7 rounded-lg border border-[var(--ed-outline-variant)] bg-[var(--ed-surface)] px-2.5 text-[11px] font-semibold text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] inline-flex items-center gap-1 transition-colors"
                        >
                            <MSym name="add" size={14} />
                            {trStr("Guardar como preajuste", language)}
                        </button>
                    ) : (
                        <span />
                    )}
                    <a
                        href={PRESETS_ADMIN_HREF}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ed-primary)] hover:underline whitespace-nowrap"
                    >
                        {trStr(linked ? "Editar en Ajustes" : "Gestionar preajustes", language)}
                        <MSym name="open_in_new" size={12} />
                    </a>
                </div>
            )}
            {msg && (
                <p
                    role={msg.kind === "error" ? "alert" : "status"}
                    className={`mt-1.5 text-[11px] ${msg.kind === "error" ? "text-[var(--ed-error)]" : "text-[var(--ed-on-surface)]"}`}
                >
                    {msg.text}
                </p>
            )}
        </div>
    );
}

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
import React, { useId, useState } from "react";
import { useI18n } from "@/contexts/I18nContext";
import { MotionPreview } from "@/components/motion/MotionPreview";
import { describeMotion } from "@/lib/motionLibrary";
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
import { ixPanelState, saveBlockIxAsPreset, setPresetChoice, IX_PANEL_NONE, type IxWrite } from "./ixPanelModel";

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

/**
 * «Elige un movimiento»: the obvious way to link a block to a preset (owner finding: linking a block to
 * a preset was a dropdown entry among the step editor's controls). Shows what the block does now, in
 * one sentence; «Choose» opens the site's motions and the included ones, each with its description, and
 * a LIVE preview of the option under the pointer or focus (MotionPreview, the real compiler). Choosing
 * writes through the same pure writer as the dropdown (`setPresetChoice`: the block stores the id).
 * Inline, not a popover, so it works the same in the dock and in the phone's properties sheet.
 */
export function MotionPicker({
    ix,
    ixCtx,
    presetId,
    onChoose,
}: {
    ix: unknown;
    ixCtx: IxCompileCtx | undefined;
    presetId: string | null;
    onChoose: (next: IxWrite) => void;
}) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const [hover, setHover] = useState<string | null>(null);
    const listId = useId();
    const presets = ixCtx?.presets ?? {};
    const ids = Object.keys(presets);
    const byName = (a: string, b: string) => (presets[a].name || a).localeCompare(presets[b].name || b) || a.localeCompare(b);
    const site = ids.filter((id) => !id.startsWith("sys:")).sort(byName);
    const sys = ids.filter((id) => id.startsWith("sys:")).sort(byName);
    const state = ixPanelState(ix, ixCtx);
    const current = presetId ? presets[presetId] : null;
    const now = current
        ? describeMotion(current, t)
        : state.active
            ? describeMotion({ trigger: state.trigger, tracks: state.tracks }, t)
            : t("motion.describe.none");
    const previewId = hover ?? presetId;
    const previewSpec = previewId && presets[previewId] ? { v: 1, preset: previewId } : state.active ? ix : null;
    const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

    const choose = (choice: string) => {
        onChoose(setPresetChoice(ix, choice, ixCtx));
        setOpen(false);
        setHover(null);
    };

    const option = (id: string) => {
        const p = presets[id];
        const selected = id === presetId;
        return (
            <li key={id}>
                <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={fill(t("motion.picker.use"), { name: p.name || id })}
                    onClick={() => choose(id)}
                    onPointerEnter={() => setHover(id)}
                    onFocus={() => setHover(id)}
                    data-verso-motion-option={id}
                    className={`w-full min-h-11 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${selected
                        ? "border-[var(--ed-primary)] bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)]"
                        : "border-[var(--ed-outline-variant)] bg-[var(--ed-surface)] text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)]"}`}
                >
                    <span className="block text-[12px] font-semibold leading-4">{p.name || id}</span>
                    <span className="block text-[11px] leading-4 opacity-75">{describeMotion(p, t)}</span>
                </button>
            </li>
        );
    };

    return (
        <section data-verso-motion-picker="" className="mb-3 rounded-xl border border-[var(--ed-outline-variant)] p-3">
            <div className="flex items-start gap-2">
                <MSym name="animation" size={16} className="shrink-0 mt-0.5 text-[var(--ed-on-surface-variant)]" />
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-[var(--ed-on-surface)]">
                        {current ? fill(t("motion.picker.linked"), { name: current.name || presetId || "" }) : t("motion.picker.title")}
                    </p>
                    <p className="text-[11px] leading-4 text-[var(--ed-on-surface-variant)]">{now}</p>
                    {current && (
                        <p className="mt-1 text-[11px] leading-4 text-[var(--ed-on-surface-variant)]">
                            {fill(t("motion.picker.linkedHelp"), { name: current.name || presetId || "" })}
                        </p>
                    )}
                </div>
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={listId}
                    onClick={() => setOpen((o) => !o)}
                    className="shrink-0 min-h-11 sm:min-h-8 rounded-lg bg-[var(--ed-primary-solid,var(--ed-primary))] px-3 text-[11px] font-semibold text-[var(--ed-on-primary,#fff)] hover:bg-[var(--ed-primary-hover)]"
                >
                    {current || state.active ? t("motion.picker.change") : t("motion.picker.choose")}
                </button>
            </div>
            {open && (
                <div id={listId} className="mt-3 space-y-3">
                    {previewSpec !== null && (
                        <MotionPreview spec={previewSpec} ctx={ixCtx} size="sm" tone="editor" replayKey={previewId ? previewId.length + (hover ? 1 : 0) : 0}
                            replayLabel={t("motion.preview.replay")} replayText={t("motion.preview.replayShort")} />
                    )}
                    <div role="radiogroup" aria-label={t("motion.picker.title")} className="space-y-3">
                        <button
                            type="button"
                            role="radio"
                            aria-checked={!presetId && !state.active}
                            onClick={() => choose(IX_PANEL_NONE)}
                            onPointerEnter={() => setHover(null)}
                            className="w-full min-h-11 rounded-lg border border-dashed border-[var(--ed-outline-variant)] px-2.5 text-left text-[12px] text-[var(--ed-on-surface-variant)] hover:border-[var(--ed-primary)]"
                        >
                            {t("motion.picker.none")}
                        </button>
                        {site.length > 0 && (
                            <div>
                                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--ed-on-surface-variant)]">{t("motion.picker.yours")}</p>
                                <ul className="space-y-1.5">{site.map(option)}</ul>
                            </div>
                        )}
                        <div>
                            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.03em] text-[var(--ed-on-surface-variant)]">{t("motion.picker.included")}</p>
                            <ul className="space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar pr-1">{sys.map(option)}</ul>
                        </div>
                    </div>
                    <a href={PRESETS_ADMIN_HREF} target="_blank" rel="noopener" className="inline-flex min-h-11 sm:min-h-0 items-center gap-1 text-[11px] font-medium text-[var(--ed-primary)] hover:underline">
                        {t("motion.picker.manage")}
                        <MSym name="open_in_new" size={12} />
                    </a>
                </div>
            )}
        </section>
    );
}

"use client";
/**
 * Ajustes ▸ Movimientos: the editor of ONE motion preset.
 *
 * SIMPLE by default: effect · when · speed · delay · this block or its items one after another, with
 * a live preview that replays on every change and a one-line description of what the visitor will
 * see. Each choice maps to exactly one normalized body (lib/motionLibrary `simpleToSpec`).
 *
 * ADVANCED is the full step/track/timeline editor (PresetEditor, unchanged): any body, every
 * property. A body the simple editor cannot show exactly (more steps, more tracks, custom curves…)
 * opens there; switching back offers to start over in simple mode rather than silently simplifying.
 */
import React, { useId, useMemo, useState } from "react";
import { Button, Card, Input } from "@/components/ui";
import { MotionPreview } from "@/components/motion/MotionPreview";
import { useI18n } from "@/contexts/I18nContext";
import { IX_PRESET_NAME_MAX, type IxSpec } from "@/lib/verso/interactions";
import {
    DEFAULT_SIMPLE,
    SIMPLE_DELAY_MAX,
    SIMPLE_EFFECTS,
    SIMPLE_SPEEDS,
    SIMPLE_STAGGER_MAX,
    SIMPLE_WHENS,
    describeMotion,
    effectFitsWhen,
    simpleToSpec,
    specToSimple,
    type SimpleEffect,
    type SimpleMotion,
} from "@/lib/motionLibrary";
import PresetEditor from "./PresetEditor";

const EFFECT_ICON: Record<SimpleEffect, string> = {
    fade: "fa-circle-half-stroke",
    up: "fa-arrow-up",
    down: "fa-arrow-down",
    left: "fa-arrow-right",
    right: "fa-arrow-left",
    zoomIn: "fa-magnifying-glass-plus",
    zoomOut: "fa-magnifying-glass-minus",
    lift: "fa-arrow-up-from-bracket",
};

const WHEN_ICON: Record<string, string> = {
    view: "fa-eye",
    load: "fa-bolt",
    hover: "fa-arrow-pointer",
    click: "fa-hand-pointer",
    scroll: "fa-computer-mouse",
};

export interface MotionEditorProps {
    id: string | null;
    name: string;
    draft: IxSpec;
    error: string | null;
    saving: boolean;
    onName: (name: string) => void;
    onDraft: (next: IxSpec) => void;
    onSave: () => void;
    onCancel: () => void;
}

const chip = (active: boolean, disabled = false) =>
    `inline-flex min-h-11 items-center gap-2 rounded-xl border-2 px-3 py-2 text-sm font-semibold transition-colors ${
        active
            ? "border-blue-600 bg-blue-50 text-blue-700"
            : disabled
                ? "border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed"
                : "border-gray-100 bg-white text-gray-700 hover:border-blue-300"
    }`;

export default function MotionEditor(props: MotionEditorProps) {
    const { id, name, draft, error, saving, onName, onDraft, onSave, onCancel } = props;
    const { t } = useI18n();
    const simple = useMemo(() => specToSimple(draft), [draft]);
    const [mode, setMode] = useState<"simple" | "advanced">(() => (simple ? "simple" : "advanced"));
    const [replayKey, setReplayKey] = useState(0);
    const formId = useId();

    const change = (patch: Partial<SimpleMotion>) => {
        const base = simple ?? DEFAULT_SIMPLE;
        let next: SimpleMotion = { ...base, ...patch };
        // An effect that would hide the block at rest cannot run on hover/click: fall back to «lift».
        if (!effectFitsWhen(next.effect, next.when)) next = { ...next, effect: "lift" };
        const spec = simpleToSpec(next);
        if (spec) {
            onDraft(spec);
            setReplayKey((k) => k + 1);
        }
    };

    const header = (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-black text-gray-900">{id ? t("motion.editor.editTitle") : t("motion.editor.newTitle")}</h2>
            <div role="group" aria-label={t("motion.editor.mode")} className="flex rounded-xl border border-gray-200 bg-gray-50 p-1">
                {(["simple", "advanced"] as const).map((m) => (
                    <button
                        key={m}
                        type="button"
                        aria-pressed={mode === m}
                        onClick={() => setMode(m)}
                        className={`min-h-11 sm:min-h-9 rounded-lg px-4 text-xs font-bold transition-colors ${mode === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
                    >
                        {t(`motion.editor.mode.${m}`)}
                    </button>
                ))}
            </div>
        </div>
    );

    if (mode === "advanced") {
        return (
            <div>
                <Card className="mb-4" padding="md">
                    {header}
                    <p className="text-sm text-gray-600">{t("motion.editor.advancedHelp")}</p>
                </Card>
                <PresetEditor {...props} />
            </div>
        );
    }

    const m = simple;
    return (
        <Card overflow="visible">
            {header}
            <form
                id={formId}
                onSubmit={(e) => { e.preventDefault(); onSave(); }}
                aria-label={id ? t("motion.editor.editTitle") : t("motion.editor.newTitle")}
                className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]"
            >
                <div className="min-w-0 space-y-6">
                    <Input
                        label={t("motion.editor.name")}
                        value={name}
                        maxLength={IX_PRESET_NAME_MAX}
                        placeholder={t("motion.editor.namePlaceholder")}
                        onChange={(e) => onName(e.target.value)}
                    />

                    {error && (
                        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
                    )}

                    {!m ? (
                        <div className="rounded-2xl border-2 border-dashed border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                            <p>{t("motion.editor.notSimple")}</p>
                            <div className="mt-3 flex flex-wrap gap-2">
                                <Button size="sm" variant="secondary" onClick={() => setMode("advanced")}>{t("motion.editor.openAdvanced")}</Button>
                                <Button size="sm" variant="ghost" onClick={() => change(DEFAULT_SIMPLE)}>{t("motion.editor.startOver")}</Button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <fieldset>
                                <legend className="mb-2 text-[11px] font-black uppercase tracking-widest text-gray-500">{t("motion.editor.effect")}</legend>
                                <div className="flex flex-wrap gap-2">
                                    {SIMPLE_EFFECTS.map((e) => {
                                        const fits = effectFitsWhen(e, m.when);
                                        return (
                                            <button
                                                key={e}
                                                type="button"
                                                aria-pressed={m.effect === e}
                                                disabled={!fits}
                                                title={fits ? undefined : t("motion.editor.hidesAtRest")}
                                                onClick={() => change({ effect: e })}
                                                className={chip(m.effect === e, !fits)}
                                            >
                                                <i className={`fa-solid ${EFFECT_ICON[e]} text-xs`} aria-hidden="true"></i>
                                                {t(`motion.effect.${e}`)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </fieldset>

                            <fieldset>
                                <legend className="mb-2 text-[11px] font-black uppercase tracking-widest text-gray-500">{t("motion.editor.when")}</legend>
                                <div className="flex flex-wrap gap-2">
                                    {SIMPLE_WHENS.map((w) => (
                                        <button key={w} type="button" aria-pressed={m.when === w} onClick={() => change({ when: w })} className={chip(m.when === w)}>
                                            <i className={`fa-solid ${WHEN_ICON[w]} text-xs`} aria-hidden="true"></i>
                                            {t(`motion.whenChoice.${w}`)}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>

                            {m.when === "scroll" ? (
                                <p className="rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-600">{t("motion.editor.scrollNote")}</p>
                            ) : (
                                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                                    <fieldset>
                                        <legend className="mb-2 text-[11px] font-black uppercase tracking-widest text-gray-500">{t("motion.editor.speed")}</legend>
                                        <div className="flex rounded-xl border border-gray-200 bg-gray-50 p-1">
                                            {SIMPLE_SPEEDS.map((s) => (
                                                <button key={s} type="button" aria-pressed={m.speed === s} onClick={() => change({ speed: s })}
                                                    className={`min-h-11 flex-1 rounded-lg px-2 text-xs font-bold ${m.speed === s ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
                                                    {t(`motion.speed.${s}`)}
                                                </button>
                                            ))}
                                        </div>
                                    </fieldset>
                                    <div>
                                        <label htmlFor={`${formId}-delay`} className="mb-2 block text-[11px] font-black uppercase tracking-widest text-gray-500">
                                            {t("motion.editor.delay")}: {(m.delay / 1000).toFixed(1)} s
                                        </label>
                                        <input
                                            id={`${formId}-delay`}
                                            type="range"
                                            min={0}
                                            max={SIMPLE_DELAY_MAX}
                                            step={100}
                                            value={m.delay}
                                            aria-valuetext={`${(m.delay / 1000).toFixed(1)} s`}
                                            onChange={(e) => change({ delay: Number(e.target.value) })}
                                            className="h-11 w-full accent-blue-600"
                                        />
                                    </div>
                                </div>
                            )}

                            <fieldset>
                                <legend className="mb-2 text-[11px] font-black uppercase tracking-widest text-gray-500">{t("motion.editor.appliesTo")}</legend>
                                <div className="flex flex-wrap gap-2">
                                    <button type="button" aria-pressed={m.target === "self"} onClick={() => change({ target: "self", stagger: 0 })} className={chip(m.target === "self")}>
                                        <i className="fa-solid fa-square text-xs" aria-hidden="true"></i>{t("motion.target.self")}
                                    </button>
                                    <button type="button" aria-pressed={m.target === "children"} onClick={() => change({ target: "children", stagger: m.stagger || 120 })} className={chip(m.target === "children")}>
                                        <i className="fa-solid fa-layer-group text-xs" aria-hidden="true"></i>{t("motion.target.children")}
                                    </button>
                                </div>
                                {m.target === "children" && (
                                    <div className="mt-4">
                                        <label htmlFor={`${formId}-stagger`} className="mb-2 block text-xs font-semibold text-gray-600">
                                            {t("motion.editor.stagger")}: {m.stagger} ms
                                        </label>
                                        <input
                                            id={`${formId}-stagger`}
                                            type="range"
                                            min={0}
                                            max={SIMPLE_STAGGER_MAX}
                                            step={20}
                                            value={m.stagger}
                                            aria-valuetext={`${m.stagger} ms`}
                                            onChange={(e) => change({ stagger: Number(e.target.value) })}
                                            className="h-11 w-full accent-blue-600"
                                        />
                                        <p className="mt-1 text-xs text-gray-500">{t("motion.editor.staggerHelp")}</p>
                                    </div>
                                )}
                            </fieldset>
                        </>
                    )}

                    <div className="flex flex-wrap gap-3 border-t border-gray-100 pt-6">
                        <Button type="submit" icon="fa-check" loading={saving} disabled={saving}>{id ? t("motion.editor.save") : t("motion.editor.create")}</Button>
                        <Button variant="secondary" onClick={onCancel}>{t("common.cancel")}</Button>
                    </div>
                </div>

                {/* On a phone the preview leads, stuck to the top while the choices scroll under it. */}
                <aside className="order-first lg:order-last sticky top-0 lg:top-4 z-10 self-start w-full rounded-2xl border-2 border-gray-100 bg-white/95 backdrop-blur p-3 lg:p-4 shadow-sm lg:shadow-none" aria-label={t("motion.preview.title")}>
                    <h3 className="mb-2 lg:mb-3 text-[11px] font-black uppercase tracking-widest text-gray-500">{t("motion.preview.title")}</h3>
                    <MotionPreview
                        spec={draft}
                        size="auto"
                        replayKey={replayKey}
                        replayLabel={t("motion.preview.replay")}
                    />
                    <p className="mt-2 lg:mt-3 text-sm font-medium text-gray-700" aria-live="polite">{describeMotion(draft, t)}</p>
                </aside>
            </form>
        </Card>
    );
}

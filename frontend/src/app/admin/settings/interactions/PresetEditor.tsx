"use client";
/**
 * Ajustes → Interacciones: EL FORMULARIO DE UN PREAJUSTE (F9-E).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * QUÉ SE REUTILIZA, Y QUÉ NO
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA LÓGICA es la MISMA que la del panel del bloque: cada control llama a los escritores puros de
 * `components/verso/editor/ixPanelModel.ts` (`setTriggerKind`, `addStep`, `setStepProp`…), que ya
 * están probados en node y que normalizan CADA escritura antes de devolverla. Aquí no se decide qué
 * es un paso válido, ni qué rango tiene una propiedad, ni qué pasa al pasarse de pasos: eso ya está
 * decidido en un sitio, y ese sitio no se duplica.
 *
 * EL MARKUP no se reutiliza, y es deliberado: `InteractionsControl` está escrito contra los tokens
 * `--ed-*`, que los declara `components/editor-theme.css` y **solo se cargan en las rutas del
 * editor**. Importarlo aquí traería su `body { … }` a una pantalla de Ajustes para heredar unos
 * colores; renderizarlo sin él dejaría los bordes y los fondos sin resolver. Así que esta pantalla
 * usa los componentes de admin (`Card`, `Button`, `Input`, `Select`) como el resto de Ajustes, y la
 * frontera entre las dos superficies queda donde debe estar: en la piel, no en las reglas.
 *
 * Un preajuste es EXACTAMENTE un cuerpo de interacción con nombre, así que el borrador se edita como
 * un `IxSpec` (`ixPresetToSpec`) y se convierte en preajuste al guardar. Por eso los escritores del
 * panel valen tal cual.
 */
import React from "react";
import { Button, Card, Input } from "@/components/ui";
import {
    addStep,
    availableProps,
    ixPanelState,
    removeStep,
    setDelay,
    setDuration,
    setStagger,
    setStepAt,
    setStepEase,
    setStepProp,
    setTargetKind,
    setTriggerKind,
    setViewOnce,
    usedProps,
    IX_EASE_LABELS,
    IX_PROP_INPUT,
    IX_PROP_LABELS,
    IX_PROP_UNITS,
    IX_TARGET_LABELS,
    IX_TRIGGER_LABELS,
    type IxPanelTargetKind,
    type IxPanelTriggerKind,
} from "@/components/verso/editor/ixPanelModel";
import {
    IX_EASINGS,
    IX_MAX_STEPS,
    IX_MAX_WORDS,
    IX_PRESET_NAME_MAX,
    IX_PROP_NEUTRAL,
    IX_STAGGER_MAX,
    type IxEase,
    type IxPropKey,
    type IxSpec,
} from "@/lib/verso/interactions";

const TRIGGERS: IxPanelTriggerKind[] = ["view", "scrub", "hover", "click", "load"];
const TARGETS: IxPanelTargetKind[] = ["self", "children", "words"];
const EASES = Object.keys(IX_EASINGS) as IxEase[];

const LABEL = "block text-xs font-bold uppercase tracking-wide text-gray-500 mb-1.5";
const NUM =
    "w-full rounded-xl border-2 border-gray-100 bg-gray-50/50 px-3 py-2 text-sm text-gray-900 focus:border-blue-400 focus:outline-none";

/**
 * Los desplegables son `<select>` NATIVOS y no el `Select` de `@/components/ui`.
 *
 * Aquel es un botón con una lista portaleada: no acepta un `id`, así que un `<label for>` no tiene a
 * qué apuntar y el control se queda SIN NOMBRE ACCESIBLE — un lector de pantalla anuncia «Al entrar
 * en pantalla, botón» y no dice de qué. Se vio en el navegador (todas las etiquetas de los
 * desplegables apuntaban a ids inexistentes). Un `<select>` nativo se etiqueta, se navega con el
 * teclado y anuncia su valor sin que nadie tenga que acordarse.
 */
const SEL = `${NUM} appearance-none pr-8`;

interface FieldSelectProps {
    id: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
}

function FieldSelect({ id, label, value, options, onChange }: FieldSelectProps) {
    return (
        <div>
            <label className={LABEL} htmlFor={id}>
                {label}
            </label>
            <select id={id} className={SEL} value={value} onChange={(e) => onChange(e.target.value)}>
                {options.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        </div>
    );
}

export interface PresetEditorProps {
    /** El cuerpo en edición, como `IxSpec`. */
    draft: IxSpec;
    name: string;
    /** `null` en un alta; el id inmutable en una edición. */
    id: string | null;
    error: string | null;
    saving: boolean;
    onName: (name: string) => void;
    onDraft: (next: IxSpec) => void;
    onSave: () => void;
    onCancel: () => void;
}

export default function PresetEditor({
    draft,
    name,
    id,
    error,
    saving,
    onName,
    onDraft,
    onSave,
    onCancel,
}: PresetEditorProps) {
    // El estado del panel se deriva del borrador con la MISMA función que usa el editor de bloques,
    // así que el resumen, los avisos y los topes son idénticos en las dos pantallas.
    const state = ixPanelState(draft);
    const track = state.tracks[0];
    const trigger = state.trigger;
    const timed = trigger.on !== "scrub";

    /** Cada escritura devuelve un valor NUEVO ya normalizado; `undefined` (nada animable) se ignora. */
    const write = (next: IxSpec | undefined) => {
        if (next) onDraft(next);
    };

    if (!track) {
        return (
            <Card>
                <p className="text-sm text-gray-500">
                    Este preajuste se ha quedado sin pistas. Cancela y empieza de nuevo.
                </p>
                <Button variant="ghost" onClick={onCancel} className="mt-4">
                    Cancelar
                </Button>
            </Card>
        );
    }

    return (
        <Card overflow="visible">
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    onSave();
                }}
                aria-label={id ? `Editar el preajuste ${name}` : "Nuevo preajuste"}
            >
                <div className="flex items-start justify-between gap-4 mb-6">
                    <div className="min-w-0 flex-1">
                        <Input
                            label="Nombre del preajuste"
                            value={name}
                            maxLength={IX_PRESET_NAME_MAX}
                            placeholder="Aparecer tarjetas"
                            onChange={(e) => onName(e.target.value)}
                        />
                        {id && (
                            <p className="mt-1 text-xs text-gray-400">
                                Identificador: <code className="font-mono">{id}</code> — no cambia
                                aunque cambies el nombre, porque es lo que guardan los bloques.
                            </p>
                        )}
                    </div>
                </div>

                {error && (
                    <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
                        {error}
                    </p>
                )}

                {/* Disparador y objetivo */}
                <div className="grid gap-4 md:grid-cols-2">
                    <FieldSelect
                        id="ixp-trigger"
                        label="Cuándo"
                        value={trigger.on}
                        onChange={(v) => write(setTriggerKind(draft, v as IxPanelTriggerKind))}
                        options={TRIGGERS.map((on) => ({ value: on, label: IX_TRIGGER_LABELS[on] }))}
                    />
                    <FieldSelect
                        id="ixp-target"
                        label="Qué se mueve"
                        value={track.target.kind}
                        onChange={(v) => write(setTargetKind(draft, v as IxPanelTargetKind))}
                        options={TARGETS.map((k) => ({ value: k, label: IX_TARGET_LABELS[k] }))}
                    />

                    {trigger.on === "view" && (
                        <FieldSelect
                            id="ixp-once"
                            label="Repetición"
                            value={trigger.once === false ? "each" : "once"}
                            onChange={(v) => write(setViewOnce(draft, v === "once"))}
                            options={[
                                { value: "once", label: "Una vez (necesita el runtime mínimo)" },
                                { value: "each", label: "Cada vez (CSS puro, va y viene)" },
                            ]}
                        />
                    )}

                    {(track.target.kind === "children" || track.target.kind === "words") && (
                        <div>
                            <label className={LABEL} htmlFor="ixp-stagger">
                                Escalonado entre hermanos (ms)
                            </label>
                            <input
                                id="ixp-stagger"
                                type="number"
                                className={NUM}
                                min={0}
                                max={IX_STAGGER_MAX}
                                step={10}
                                value={track.stagger?.each ?? 0}
                                onChange={(e) => write(setStagger(draft, Number(e.target.value)))}
                            />
                        </div>
                    )}

                    {timed && (
                        <>
                            <div>
                                <label className={LABEL} htmlFor="ixp-dur">
                                    Duración (ms)
                                </label>
                                <input
                                    id="ixp-dur"
                                    type="number"
                                    className={NUM}
                                    min={100}
                                    max={3000}
                                    step={50}
                                    value={track.dur ?? 600}
                                    onChange={(e) => write(setDuration(draft, Number(e.target.value)))}
                                />
                            </div>
                            <div>
                                <label className={LABEL} htmlFor="ixp-delay">
                                    Retardo (ms)
                                </label>
                                <input
                                    id="ixp-delay"
                                    type="number"
                                    className={NUM}
                                    min={0}
                                    max={3000}
                                    step={50}
                                    value={track.delay ?? 0}
                                    onChange={(e) => write(setDelay(draft, Number(e.target.value)))}
                                />
                            </div>
                        </>
                    )}
                </div>

                {track.target.kind === "words" && (
                    <p className="mt-3 text-xs text-gray-500">
                        «Las palabras» solo mueve algo en los bloques que saben partir su texto
                        (Título y Cita). No se parte si el texto lleva formato o si pasa de{" "}
                        {IX_MAX_WORDS} palabras: entonces se ve igual que siempre, sin movimiento.
                    </p>
                )}

                {/* Pasos */}
                <fieldset className="mt-8 border-t border-gray-100 pt-6">
                    <legend className="text-sm font-bold text-gray-900">
                        Pasos ({track.steps.length})
                    </legend>
                    <ol className="mt-4 space-y-4">
                        {track.steps.map((step, i) => {
                            const isFirst = i === 0;
                            const isLast = i === track.steps.length - 1;
                            const free = availableProps(step);
                            const used = usedProps(step);
                            return (
                                <li key={i} className="rounded-2xl border-2 border-gray-100 p-4">
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <span className="text-sm font-bold text-gray-900">
                                            {isFirst ? "Inicio (0 %)" : isLast ? "Final (100 %)" : `Paso ${i + 1}`}
                                        </span>
                                        {!isFirst && !isLast && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                aria-label={`Quitar el paso ${i + 1}`}
                                                onClick={() => write(removeStep(draft, i))}
                                            >
                                                Quitar paso
                                            </Button>
                                        )}
                                    </div>

                                    <div className="grid gap-3 md:grid-cols-2">
                                        {/* Los extremos los reancla el normalizador a 0 y 100: mostrar un control
                                            que el dato va a ignorar sería mentirle al autor. */}
                                        {!isFirst && !isLast && (
                                            <div>
                                                <label className={LABEL} htmlFor={`ixp-at-${i}`}>
                                                    Momento (%)
                                                </label>
                                                <input
                                                    id={`ixp-at-${i}`}
                                                    type="number"
                                                    className={NUM}
                                                    min={1}
                                                    max={99}
                                                    step={1}
                                                    value={step.at}
                                                    onChange={(e) => write(setStepAt(draft, i, Number(e.target.value)))}
                                                />
                                            </div>
                                        )}
                                        {!isLast && (
                                            <FieldSelect
                                                id={`ixp-ease-${i}`}
                                                label="Curva hasta el siguiente"
                                                value={step.ease ?? "out"}
                                                onChange={(v) => write(setStepEase(draft, i, v as IxEase))}
                                                options={EASES.map((e) => ({ value: e, label: IX_EASE_LABELS[e] }))}
                                            />
                                        )}
                                    </div>

                                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                                        {used.map((key) => (
                                            <div key={key} className="flex items-end gap-2">
                                                <div className="min-w-0 flex-1">
                                                    <label className={LABEL} htmlFor={`ixp-${i}-${key}`}>
                                                        {IX_PROP_LABELS[key]}
                                                        {IX_PROP_UNITS[key] ? ` (${IX_PROP_UNITS[key]})` : ""}
                                                    </label>
                                                    <input
                                                        id={`ixp-${i}-${key}`}
                                                        type="number"
                                                        className={NUM}
                                                        min={IX_PROP_INPUT[key].min}
                                                        max={IX_PROP_INPUT[key].max}
                                                        step={IX_PROP_INPUT[key].step}
                                                        value={step.set[key] ?? IX_PROP_NEUTRAL[key]}
                                                        onChange={(e) =>
                                                            write(setStepProp(draft, i, key, Number(e.target.value)))
                                                        }
                                                    />
                                                </div>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    className="mb-1"
                                                    aria-label={`Quitar ${IX_PROP_LABELS[key]} del paso ${i + 1}`}
                                                    onClick={() => write(setStepProp(draft, i, key, undefined))}
                                                >
                                                    ×
                                                </Button>
                                            </div>
                                        ))}
                                        {free.length > 0 && (
                                            <FieldSelect
                                                id={`ixp-add-${i}`}
                                                label="Añadir propiedad"
                                                value=""
                                                onChange={(v) =>
                                                    v &&
                                                    write(
                                                        setStepProp(
                                                            draft,
                                                            i,
                                                            v as IxPropKey,
                                                            IX_PROP_NEUTRAL[v as IxPropKey],
                                                        ),
                                                    )
                                                }
                                                options={[
                                                    { value: "", label: "Elegir…" },
                                                    ...free.map((k) => ({ value: k, label: IX_PROP_LABELS[k] })),
                                                ]}
                                            />
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ol>

                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-4"
                        disabled={track.steps.length >= IX_MAX_STEPS}
                        onClick={() => write(addStep(draft))}
                    >
                        + Añadir paso
                    </Button>
                    {track.steps.length >= IX_MAX_STEPS && (
                        <p className="mt-2 text-xs text-gray-500">
                            Máximo {IX_MAX_STEPS} pasos: una animación con siete puntos de control ya no
                            es una animación, es un programa.
                        </p>
                    )}
                </fieldset>

                {state.warnings.length > 0 && (
                    <ul role="note" aria-label="Avisos del preajuste" className="mt-4 space-y-1">
                        {state.warnings.map((w, i) => (
                            <li key={i} className="text-xs text-amber-700">
                                {w}
                            </li>
                        ))}
                    </ul>
                )}

                <p role="status" className="mt-6 text-xs text-gray-500">
                    {state.summary}
                </p>

                <div className="mt-4 flex gap-3">
                    <Button type="submit" loading={saving}>
                        {id ? "Guardar cambios" : "Crear preajuste"}
                    </Button>
                    <Button type="button" variant="ghost" onClick={onCancel}>
                        Cancelar
                    </Button>
                </div>
            </form>
        </Card>
    );
}

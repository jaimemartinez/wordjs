"use client";

import { Field, useFieldA11y, useNameCheck, type FieldProps } from "./Field";
import { INPUT_BASE_CLASS } from "./Input";

export interface SliderProps extends FieldProps {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    /** A number box beside the slider for an exact value. */
    withNumber?: boolean;
    /** Shown after the value (px, %, ms). */
    unit?: string;
    /** How the value is shown and read out (e.g. ms as "1.5 s"); overrides `unit`. */
    format?: (value: number) => string;
    /** Hide the value beside the track (when the label already says it). It is still read out. */
    showValue?: boolean;
    disabled?: boolean;
    className?: string;
    "aria-label"?: string;
}

/** Slider — a range with an optional number box; both edit the same value, clamped to min…max. */
export function Slider({ label, help, error, required, id, value, onChange, min = 0, max = 100, step = 1, withNumber, unit, format, showValue = true, disabled, className = "", ...rest }: SliderProps) {
    const { controlId, helpId, errorId, aria } = useFieldA11y({ id, help, error, required });
    useNameCheck("Slider", !!label || !!rest["aria-label"]);
    const clamp = (n: number) => Math.min(max, Math.max(min, n));
    const shown = format ? format(value) : unit ? `${value} ${unit}` : String(value);
    return (
        <Field label={label} help={help} error={error} required={required} controlId={controlId} helpId={helpId} errorId={errorId} className={className}>
            <div className="flex items-center gap-3">
                <input
                    id={controlId}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    disabled={disabled}
                    aria-label={label ? undefined : rest["aria-label"]}
                    aria-valuetext={format || unit ? shown : undefined}
                    onChange={(e) => onChange(clamp(Number(e.target.value)))}
                    data-wjs-control=""
                    {...aria}
                    className="flex-1 accent-blue-600 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                />
                {withNumber ? (
                    <div className="flex items-center gap-1">
                        <input
                            type="number"
                            min={min}
                            max={max}
                            step={step}
                            value={value}
                            disabled={disabled}
                            aria-labelledby={controlId}
                            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(clamp(n)); }}
                            className={`${INPUT_BASE_CLASS} w-20 px-2 py-1.5 text-sm rounded-lg tabular-nums`}
                        />
                        {unit && <span className="text-xs text-gray-500">{unit}</span>}
                    </div>
                ) : showValue && (
                    <output htmlFor={controlId} className="min-w-12 text-right text-sm text-gray-700 tabular-nums">{shown}</output>
                )}
            </div>
        </Field>
    );
}

export default Slider;

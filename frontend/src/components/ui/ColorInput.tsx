"use client";

import { useState } from "react";
import { Field, useFieldA11y, useKitText, useNameCheck, type FieldProps } from "./Field";
import { INPUT_BASE_CLASS, INPUT_ERROR_CLASS } from "./Input";

export interface ColorInputProps extends FieldProps {
    /** `#rrggbb` (an empty string is "no colour"). */
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    className?: string;
    "aria-label"?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** `#abc` → `#aabbcc`; anything else that is not `#rrggbb` → null. */
export function normalizeHex(input: string): string | null {
    const v = input.trim();
    const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    const full = /^#?([0-9a-f]{6})$/i.exec(v);
    return full ? `#${full[1]}`.toLowerCase() : null;
}

/**
 * ColorInput — the browser's colour well (a swatch) beside the hex text, kept in sync. The value is
 * always `#rrggbb`; text that is not a colour stays in the box (with the error) and is never sent.
 */
export function ColorInput({ label, help, error, required, id, value, onChange, disabled, className = "", ...rest }: ColorInputProps) {
    const t = useKitText();
    const [text, setText] = useState(value);
    // A new value from outside replaces the text, adjusted during render (no effect, no extra pass).
    const [seen, setSeen] = useState(value);
    if (value !== seen) {
        setSeen(value);
        setText(value);
    }
    const invalid = text !== "" && !normalizeHex(text);
    const shownError = error ?? (invalid ? t("ui.color.invalid") : undefined);
    const { controlId, helpId, errorId, aria } = useFieldA11y({ id, help, error: shownError, required });
    useNameCheck("ColorInput", !!label || !!rest["aria-label"]);
    return (
        <Field label={label} help={help} error={shownError} required={required} controlId={controlId} helpId={helpId} errorId={errorId} className={className}>
            <div className="flex items-center gap-2">
                <input
                    type="color"
                    value={HEX.test(value) ? value : "#000000"}
                    onChange={(e) => onChange(e.target.value.toLowerCase())}
                    disabled={disabled}
                    aria-label={t("ui.color.picker")}
                    data-control-border="none"
                    className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border-2 border-gray-300 bg-white p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <input
                    id={controlId}
                    type="text"
                    inputMode="text"
                    spellCheck={false}
                    maxLength={7}
                    value={text}
                    disabled={disabled}
                    aria-label={label ? undefined : rest["aria-label"]}
                    onChange={(e) => {
                        setText(e.target.value);
                        const hex = normalizeHex(e.target.value);
                        if (hex) onChange(hex);
                        else if (e.target.value === "") onChange("");
                    }}
                    onBlur={() => { const hex = normalizeHex(text); if (hex) setText(hex); }}
                    data-wjs-control=""
                    {...aria}
                    className={`${INPUT_BASE_CLASS} px-3 py-2 text-sm rounded-xl font-mono uppercase ${shownError ? INPUT_ERROR_CLASS : ""}`}
                />
            </div>
        </Field>
    );
}

export default ColorInput;

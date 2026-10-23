"use client";

/**
 * The one field contract of the admin's form kit (components/ui).
 *
 * Every control (Input, Textarea, Select, Checkbox, Radio, Switch, ColorInput, Slider, the pickers)
 * takes the same `label`, `help`, `error` and `required` props and gets the same wiring from here:
 *   - the label is tied to the control (`htmlFor`), or names it through `aria-labelledby`;
 *   - help text is `${id}-help`, the error `${id}-error` (announced when it appears, role="alert");
 *   - the control carries `aria-describedby` (help + error), `aria-invalid` while there is an error and
 *     `aria-required` when required.
 * A screen's own field errors (an API's per-field messages, a plugin's useFieldErrors) are passed as
 * `error` and are shown and announced in place, with no extra markup per screen.
 *
 * A control with no visible label must be named some other way (`aria-label` / `aria-labelledby`);
 * in development a missing name is reported once on the console, like Button's icon-only check.
 */
import React, { useCallback, useEffect, useId, useRef } from "react";
import { useOptionalI18n } from "@/contexts/I18nContext";
import { t as translate } from "@/lib/i18n";

/** The kit's own strings, in the admin language; English outside an I18nProvider (sign-in, install). */
export function useKitText() {
    const i18n = useOptionalI18n();
    return useCallback((key: string) => (i18n ? i18n.t(key) : translate(key, "en")), [i18n]);
}

export interface FieldProps {
    /** The visible label. */
    label?: React.ReactNode;
    /** Help under the control. */
    help?: React.ReactNode;
    /** An error under the control; makes it aria-invalid. */
    error?: React.ReactNode;
    /** Marks the field required (asterisk + aria-required). */
    required?: boolean;
    /** The control's id; generated when absent. */
    id?: string;
}

/** The ids and aria attributes a control gets from its field props. */
export function useFieldA11y({ id, help, error, required }: Pick<FieldProps, "id" | "help" | "error" | "required">, describedBy?: string) {
    const auto = useId();
    const controlId = id ?? `f${auto.replace(/:/g, "")}`;
    const helpId = help ? `${controlId}-help` : undefined;
    const errorId = error ? `${controlId}-error` : undefined;
    const ids = [describedBy, helpId, errorId].filter(Boolean).join(" ");
    // Only the attributes this field sets: spread after the caller's props, an `undefined` here would
    // wipe an aria-invalid the caller passed itself.
    const aria: { "aria-describedby"?: string; "aria-invalid"?: true; "aria-required"?: true } = {};
    if (ids) aria["aria-describedby"] = ids;
    if (error) aria["aria-invalid"] = true;
    if (required) aria["aria-required"] = true;
    return { controlId, helpId, errorId, aria };
}

/** Warns once per mounted control, in development, about a control that nothing names. */
export function useNameCheck(component: string, named: boolean) {
    const warned = useRef(false);
    useEffect(() => {
        if (process.env.NODE_ENV === "production" || named || warned.current) return;
        warned.current = true;
        console.warn(`${component}: give it a \`label\`, or an \`aria-label\` / \`aria-labelledby\` when it has no visible label.`);
    }, [component, named]);
}

/** The kit's label look (uppercase micro-label, gray-500: 4.8:1 on white), shared by every control. */
export const LABEL_TEXT_CLASS = "text-[11px] font-black uppercase tracking-widest text-gray-500";
export const LABEL_CLASS = `block ${LABEL_TEXT_CLASS} mb-2`;
export const HELP_CLASS = "mt-1 text-xs text-gray-500";
export const ERROR_CLASS = "mt-1 text-xs text-red-600 font-medium";

/** Label above, control, then help and error, all wired by id. */
export function Field({
    label,
    help,
    error,
    required,
    controlId,
    helpId,
    errorId,
    labelId,
    className = "",
    children,
}: Omit<FieldProps, "id"> & {
    controlId: string;
    helpId?: string;
    errorId?: string;
    /** When the control is not labelable (a button trigger, a group), the label is referenced by this id. */
    labelId?: string;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={`w-full ${className}`} data-wjs-field="">
            {label && (
                <label id={labelId} htmlFor={labelId ? undefined : controlId} className={LABEL_CLASS}>
                    {label}
                    {required && <span aria-hidden="true" className="text-red-600"> *</span>}
                </label>
            )}
            {children}
            {help && <p id={helpId} className={HELP_CLASS}>{help}</p>}
            {error && <p id={errorId} role="alert" className={ERROR_CLASS}>{error}</p>}
        </div>
    );
}

export default Field;

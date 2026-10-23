"use client";

import React, { createContext, forwardRef, useContext, useId } from "react";
import { ERROR_CLASS, HELP_CLASS, LABEL_CLASS, useFieldA11y, type FieldProps } from "./Field";
import { CHECK_INPUT_CLASS } from "./Checkbox";

interface GroupState {
    name: string;
    value?: string;
    onChange?: (value: string) => void;
    disabled?: boolean;
}
const RadioGroupContext = createContext<GroupState | null>(null);

export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value"> {
    value: string;
    label: React.ReactNode;
    /** A second line under the label. */
    description?: React.ReactNode;
}

/** Radio — one choice of a RadioGroup (name, checked state and onChange come from the group). */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
    { value, label, description, className = "", id, disabled, ...props },
    ref,
) {
    const group = useContext(RadioGroupContext);
    const auto = useId();
    const inputId = id ?? `r${auto.replace(/:/g, "")}`;
    const descId = description ? `${inputId}-desc` : undefined;
    return (
        <div className="flex items-start gap-2.5">
            <input
                ref={ref}
                id={inputId}
                type="radio"
                name={group?.name}
                value={value}
                checked={group ? group.value === value : undefined}
                onChange={group?.onChange ? () => group.onChange!(value) : undefined}
                disabled={disabled ?? group?.disabled}
                aria-describedby={descId}
                data-wjs-control=""
                {...props}
                className={`${CHECK_INPUT_CLASS} rounded-full mt-0.5 ${className}`}
            />
            <label htmlFor={inputId} className="text-sm font-medium text-gray-800 cursor-pointer select-none">
                {label}
                {description && <span id={descId} className="block text-xs font-normal text-gray-500">{description}</span>}
            </label>
        </div>
    );
});

export interface RadioGroupProps extends FieldProps {
    value?: string;
    onChange?: (value: string) => void;
    /** The radios' shared name (generated when absent). */
    name?: string;
    orientation?: "vertical" | "horizontal";
    disabled?: boolean;
    className?: string;
    children: React.ReactNode;
    "aria-label"?: string;
}

/**
 * RadioGroup — a fieldset whose legend is the label; help and error are wired to the group
 * (aria-describedby / aria-invalid), and the browser's own radio keyboard model applies.
 */
export function RadioGroup({ label, help, error, required, id, value, onChange, name, orientation = "vertical", disabled, className = "", children, ...rest }: RadioGroupProps) {
    const { controlId, helpId, errorId, aria } = useFieldA11y({ id, help, error, required });
    const auto = useId();
    return (
        <RadioGroupContext.Provider value={{ name: name ?? `rg${auto.replace(/:/g, "")}`, value, onChange, disabled }}>
            <fieldset id={controlId} role="radiogroup" aria-label={label ? undefined : rest["aria-label"]} {...aria} className={`min-w-0 ${className}`} data-wjs-field="">
                {label && (
                    <legend className={LABEL_CLASS}>
                        {label}
                        {required && <span aria-hidden="true" className="text-red-600"> *</span>}
                    </legend>
                )}
                <div className={orientation === "horizontal" ? "flex flex-wrap gap-x-6 gap-y-2" : "space-y-2"}>{children}</div>
                {help && <p id={helpId} className={HELP_CLASS}>{help}</p>}
                {error && <p id={errorId} role="alert" className={ERROR_CLASS}>{error}</p>}
            </fieldset>
        </RadioGroupContext.Provider>
    );
}

export default RadioGroup;

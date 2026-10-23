"use client";

import React, { forwardRef } from "react";
import { ERROR_CLASS, HELP_CLASS, useFieldA11y, useNameCheck, type FieldProps } from "./Field";

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type">, FieldProps {
    checked: boolean;
    onChange?: (checked: boolean) => void;
    /** The label sits before (default) or after the switch. */
    labelPosition?: "start" | "end";
    size?: "sm" | "md";
    containerClassName?: string;
}

/**
 * Switch — an on/off setting (role="switch", aria-checked). The label is clickable and names the switch;
 * help and error follow the shared field contract (components/ui/Field).
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
    { label, help, error, required, checked, onChange, labelPosition = "start", size = "md", className = "", containerClassName = "", id, disabled, ...props },
    ref,
) {
    const { controlId, helpId, errorId, aria } = useFieldA11y({ id, help, error, required }, props["aria-describedby"]);
    useNameCheck("Switch", !!label || !!props["aria-label"] || !!props["aria-labelledby"]);
    const labelId = label ? `${controlId}-label` : undefined;
    const track = size === "sm" ? "h-5 w-9" : "h-6 w-11";
    const knob = size === "sm" ? "h-4 w-4" : "h-5 w-5";
    const shift = size === "sm" ? "translate-x-4" : "translate-x-5";
    const toggle = (
        <button
            ref={ref}
            id={controlId}
            type="button"
            role="switch"
            aria-checked={checked}
            aria-labelledby={labelId}
            disabled={disabled}
            onClick={() => onChange?.(!checked)}
            data-wjs-control=""
            {...props}
            {...aria}
            className={`relative inline-flex ${track} shrink-0 items-center rounded-full transition-colors duration-200 ` +
                `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50 disabled:cursor-not-allowed ` +
                `${checked ? "bg-blue-600" : "bg-gray-500"} ${className}`}
        >
            <span aria-hidden="true" className={`${knob} rounded-full bg-white shadow transition-transform duration-200 ${checked ? shift : "translate-x-0.5"}`} />
        </button>
    );
    const text = label && (
        <span id={labelId} onClick={() => !disabled && onChange?.(!checked)} className="text-sm font-medium text-gray-800 cursor-pointer select-none">
            {label}
        </span>
    );
    return (
        <div className={containerClassName} data-wjs-field="">
            <div className={`flex items-center gap-3 ${labelPosition === "start" ? "justify-between" : ""}`}>
                {labelPosition === "start" ? <>{text}{toggle}</> : <>{toggle}{text}</>}
            </div>
            {help && <p id={helpId} className={HELP_CLASS}>{help}</p>}
            {error && <p id={errorId} role="alert" className={ERROR_CLASS}>{error}</p>}
        </div>
    );
});

export default Switch;

"use client";

import React, { forwardRef, useState } from "react";
import { Field, useFieldA11y, useKitText, useNameCheck, type FieldProps } from "./Field";

type InputSize = "sm" | "md" | "lg";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">, FieldProps {
    /** A Font Awesome icon class shown inside the field, on the left (e.g. "fa-magnifying-glass"). */
    icon?: string;
    /** Anything shown inside the field on the right: a unit, a clear button. */
    trailing?: React.ReactNode;
    /** A password field gets an eye button that shows / hides what was typed. */
    revealable?: boolean;
    size?: InputSize;
    /** Class names of the wrapper (the input's own go in className). */
    containerClassName?: string;
}

const sizeClasses: Record<InputSize, string> = {
    sm: "px-3 py-2 text-sm rounded-xl",
    md: "px-4 py-3 text-sm rounded-xl",
    lg: "px-4 py-4 text-base rounded-2xl",
};

export const INPUT_BASE_CLASS =
    "w-full bg-gray-50/50 border-2 border-gray-100 focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white " +
    "transition-all outline-none font-medium placeholder:text-gray-400 placeholder:font-normal disabled:opacity-60 disabled:cursor-not-allowed";
export const INPUT_ERROR_CLASS = "border-red-300 focus:border-red-500 focus:ring-red-100";

/**
 * Input — the admin's text field (text, email, url, password, search, tel, number), with the shared
 * field contract (components/ui/Field): label, help, error, required.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
    { label, help, error, required, icon, trailing, revealable, size = "lg", className = "", containerClassName = "", id, type = "text", ...props },
    ref,
) {
    const { controlId, helpId, errorId, aria } = useFieldA11y({ id, help, error, required }, props["aria-describedby"]);
    useNameCheck("Input", !!label || !!props["aria-label"] || !!props["aria-labelledby"]);
    const [shown, setShown] = useState(false);
    const t = useKitText();
    const canReveal = revealable && type === "password";
    const reveal = canReveal ? (
        <button
            type="button"
            onClick={() => setShown((s) => !s)}
            aria-label={t(shown ? "ui.password.hide" : "ui.password.show")}
            aria-pressed={shown}
            className="text-gray-500 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 rounded px-1"
        >
            <i className={`fa-solid ${shown ? "fa-eye-slash" : "fa-eye"}`} aria-hidden="true"></i>
        </button>
    ) : null;
    const right = reveal || trailing;
    return (
        <Field label={label} help={help} error={error} required={required} controlId={controlId} helpId={helpId} errorId={errorId} className={containerClassName}>
            <div className="relative">
                {icon && <i className={`fa-solid ${icon} absolute left-4 top-1/2 -translate-y-1/2 text-gray-400`} aria-hidden="true"></i>}
                <input
                    ref={ref}
                    id={controlId}
                    type={canReveal && shown ? "text" : type}
                    required={required}
                    data-wjs-control=""
                    {...props}
                    {...aria}
                    className={`${INPUT_BASE_CLASS} ${sizeClasses[size]} ${icon ? "pl-12" : ""} ${right ? "pr-12" : ""} ${error ? INPUT_ERROR_CLASS : ""} ${className}`}
                />
                {right && <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">{right}</div>}
            </div>
        </Field>
    );
});

export default Input;

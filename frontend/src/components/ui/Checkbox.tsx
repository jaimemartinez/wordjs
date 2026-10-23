"use client";

import React, { forwardRef, useCallback, useEffect, useRef } from "react";
import { ERROR_CLASS, HELP_CLASS, useFieldA11y, useNameCheck, type FieldProps } from "./Field";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">, FieldProps {
    /** The "some but not all" state of a select-all box. */
    indeterminate?: boolean;
    containerClassName?: string;
}

/** The box itself: shared by Checkbox and (as a circle) Radio. */
export const CHECK_INPUT_CLASS =
    "h-4 w-4 shrink-0 rounded border-gray-400 text-blue-600 accent-blue-600 cursor-pointer " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Checkbox — a box with its label beside it (the whole label is clickable), help and error under it,
 * and the shared aria wiring (components/ui/Field).
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
    { label, help, error, required, indeterminate = false, className = "", containerClassName = "", id, ...props },
    ref,
) {
    const { controlId, helpId, errorId, aria } = useFieldA11y({ id, help, error, required }, props["aria-describedby"]);
    useNameCheck("Checkbox", !!label || !!props["aria-label"] || !!props["aria-labelledby"]);
    const inner = useRef<HTMLInputElement | null>(null);
    const setRefs = useCallback((el: HTMLInputElement | null) => {
        inner.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
    }, [ref]);
    useEffect(() => { if (inner.current) inner.current.indeterminate = indeterminate; }, [indeterminate]);

    return (
        <div className={containerClassName} data-wjs-field="">
            <div className="flex items-start gap-2.5">
                <input
                    ref={setRefs}
                    id={controlId}
                    type="checkbox"
                    required={required}
                    data-wjs-control=""
                    {...props}
                    {...aria}
                    className={`${CHECK_INPUT_CLASS} mt-0.5 ${className}`}
                />
                {label && (
                    <label htmlFor={controlId} className="text-sm font-medium text-gray-800 cursor-pointer select-none">
                        {label}
                        {required && <span aria-hidden="true" className="text-red-600"> *</span>}
                    </label>
                )}
            </div>
            {help && <p id={helpId} className={`${HELP_CLASS} ml-6.5`}>{help}</p>}
            {error && <p id={errorId} role="alert" className={`${ERROR_CLASS} ml-6.5`}>{error}</p>}
        </div>
    );
});

export default Checkbox;

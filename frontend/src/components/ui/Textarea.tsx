"use client";

import React, { forwardRef, useCallback, useLayoutEffect, useRef } from "react";
import { Field, useFieldA11y, useNameCheck, type FieldProps } from "./Field";
import { INPUT_BASE_CLASS, INPUT_ERROR_CLASS } from "./Input";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement>, FieldProps {
    /** Grows with its content (up to `maxRows`) instead of scrolling. */
    autoGrow?: boolean;
    maxRows?: number;
    /** Shows "12 / 160" under the field when maxLength is set. */
    showCount?: boolean;
    containerClassName?: string;
}

/** Textarea — multi-line text with the shared field contract (components/ui/Field). */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
    { label, help, error, required, autoGrow, maxRows = 20, showCount, className = "", containerClassName = "", id, rows = 4, ...props },
    ref,
) {
    const { controlId, helpId, errorId, aria } = useFieldA11y({ id, help, error, required }, props["aria-describedby"]);
    useNameCheck("Textarea", !!label || !!props["aria-label"] || !!props["aria-labelledby"]);
    const inner = useRef<HTMLTextAreaElement | null>(null);
    const setRefs = useCallback((el: HTMLTextAreaElement | null) => {
        inner.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
    }, [ref]);

    useLayoutEffect(() => {
        const el = inner.current;
        if (!autoGrow || !el) return;
        el.style.height = "auto";
        const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
        el.style.height = `${Math.min(el.scrollHeight, line * maxRows + 32)}px`;
    }, [autoGrow, maxRows, props.value]);

    const length = typeof props.value === "string" ? props.value.length : undefined;
    return (
        <Field label={label} help={help} error={error} required={required} controlId={controlId} helpId={helpId} errorId={errorId} className={containerClassName}>
            <textarea
                ref={setRefs}
                id={controlId}
                rows={rows}
                required={required}
                data-wjs-control=""
                {...props}
                {...aria}
                className={`${INPUT_BASE_CLASS} px-4 py-3 text-sm rounded-xl ${autoGrow ? "resize-none overflow-hidden" : "resize-y"} ${error ? INPUT_ERROR_CLASS : ""} ${className}`}
            />
            {showCount && props.maxLength !== undefined && length !== undefined && (
                <p className="mt-1 text-right text-xs text-gray-500 tabular-nums" aria-live="polite">{length} / {props.maxLength}</p>
            )}
        </Field>
    );
});

export default Textarea;

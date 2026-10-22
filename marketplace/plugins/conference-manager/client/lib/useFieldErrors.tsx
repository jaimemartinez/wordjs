// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * useFieldErrors (conference-manager 2.31.1) — the in-app replacement of the browser's validation bubbles.
 *
 *   const v = useFieldErrors(language);
 *   <form {...v.form(handleSubmit)}>                       // noValidate + the check before `handleSubmit`
 *     <input name="hotel_name" required aria-invalid={v.invalid('hotel_name')} aria-describedby={v.describedBy('hotel_name')} />
 *     <FieldError id={v.errorId('hotel_name')} message={v.error('hotel_name')} />
 *
 * On submit every field is checked with the browser's constraint API (fieldErrors.ts). If any fails, the
 * submit stops, each failing field shows its message under it and the first one takes the focus. Editing a
 * field clears its message. A field is keyed by `data-field`, else `name`, else `id`.
 */
import React, { useCallback, useRef, useState } from "react";
import { useOptionalI18n } from "@/contexts/I18nContext";
import { fieldKeyOf, invalidFields } from "./fieldErrors";

export function FieldError({ message, id, className = '' }: { message?: string | null; id?: string; className?: string }) {
    if (!message) return null;
    return (
        <p id={id} role="alert" data-field-error="" className={`mt-1.5 text-xs font-bold text-red-600 flex items-start gap-1.5 ${className}`}>
            <i className="fa-solid fa-circle-exclamation mt-0.5" aria-hidden="true" />
            <span>{message}</span>
        </p>
    );
}

/** The language of the messages: the given one, else the host's (admin), else the page's <html lang>, else es. */
function useLang(given?: string): string {
    const ctx = useOptionalI18n ? useOptionalI18n() : null;
    if (given) return given;
    if (ctx && ctx.language) return ctx.language;
    const doc = typeof document !== 'undefined' ? (document.documentElement.lang || '').slice(0, 2).toLowerCase() : '';
    return doc === 'en' || doc === 'pt' ? doc : 'es';
}

export function useFieldErrors(given?: string) {
    const lang = useLang(given);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const errorsRef = useRef(errors);
    errorsRef.current = errors;
    const prefix = useRef(`fe-${Math.random().toString(36).slice(2, 8)}`).current;

    const clear = useCallback((target: any) => {
        const key = target && typeof target.getAttribute === 'function' ? fieldKeyOf(target) : '';
        if (key && errorsRef.current[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
    }, []);

    /** The props of the <form>: noValidate, and `onSubmit` that checks the fields before calling `handler`. */
    const form = (handler: (e: any) => any) => ({
        noValidate: true,
        onSubmit: (e: any) => {
            const bad = invalidFields(e.currentTarget.elements, lang);
            if (bad.length) {
                e.preventDefault();
                const next: Record<string, string> = {};
                for (const b of bad) if (b.key && !next[b.key]) next[b.key] = b.message;
                setErrors(next);
                try { bad[0].el.focus && bad[0].el.focus(); } catch { /* not focusable */ }
                return undefined;
            }
            if (Object.keys(errorsRef.current).length) setErrors({});
            return handler(e);
        },
        onInput: (e: any) => clear(e.target),
        onChange: (e: any) => clear(e.target),
    });

    const error = (key: string) => errors[key] || null;
    const errorId = (key: string) => `${prefix}-${key}`;
    return {
        form,
        error,
        errorId,
        invalid: (key: string) => (errors[key] ? true : undefined),
        describedBy: (key: string) => (errors[key] ? errorId(key) : undefined),
        reset: () => setErrors({}),
        errors,
    };
}

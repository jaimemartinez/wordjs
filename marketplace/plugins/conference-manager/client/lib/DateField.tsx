// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * DateField (conference-manager 2.33.1) — the host's own calendar (DatePicker / DateTimePicker, core #584) in
 * place of the browser's own date and date-time inputs. Same value strings as before (`YYYY-MM-DD`,
 * `YYYY-MM-DDTHH:mm`), so nothing stored or sent changes.
 *
 * The host picker is a button, which a form's constraint check does not see. When the field is `required`
 * (or a form keys its errors by `dataField`), a companion input that takes no room and no tab stop carries the
 * value: the 2.31.1 in-app check (useFieldErrors) finds it empty, shows the message under the field, and the
 * focus it gives the companion goes on to the calendar's button. Each change is announced to the form as an
 * `input` event, so a shown error clears like any other field's.
 */
import React, { useEffect, useId, useRef } from "react";
import { DatePicker, DateTimePicker } from "@/components/ui/DatePicker";

export function DateField({ withTime = false, required = false, dataField, id, value, ...props }: {
    withTime?: boolean; required?: boolean; dataField?: string; id?: string; value: string; onChange: (v: string) => void;
    min?: string; max?: string; ariaLabel?: string; label?: string; placeholder?: string; disabled?: boolean; clearable?: boolean; className?: string; title?: string;
}) {
    const autoId = useId();
    const fieldId = id || `cm-date-${autoId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const companion = useRef<HTMLInputElement | null>(null);
    const first = useRef(true);
    useEffect(() => {
        if (first.current) { first.current = false; return; }
        const el = companion.current;
        if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [value]);
    const Picker = withTime ? DateTimePicker : DatePicker;
    return (
        <div className="relative w-full min-w-0" data-cm-date-field="">
            <Picker id={fieldId} value={value || ''} clearable={!required} {...props} />
            {(required || dataField) && (
                <input
                    ref={companion}
                    tabIndex={-1}
                    aria-hidden="true"
                    className="absolute bottom-0 left-0 w-px h-px opacity-0 pointer-events-none"
                    required={required}
                    value={value || ''}
                    onChange={() => { /* follows the picker */ }}
                    data-field={dataField}
                    onFocus={() => { if (typeof document !== 'undefined') document.getElementById(fieldId)?.focus(); }}
                />
            )}
        </div>
    );
}

export default DateField;

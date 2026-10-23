"use client";

/**
 * The admin's own calendar: DatePicker (a day) and DateTimePicker (a day and a time).
 *
 * WHY. `<input type="date">` / `datetime-local` drew the BROWSER's calendar: a different one in every
 * browser and OS, deaf to the admin's palette and to the editor's dark mode, in the browser's language
 * rather than the admin's, with the week starting wherever the OS said. This one is the same everywhere,
 * speaks the admin language (es/en/pt), starts the week on the site's `start_of_week` (Settings → General)
 * and follows the admin tokens — or, opened inside the Verso editor, the editor's `--ed-*` palette,
 * light or dark.
 *
 * VALUES ARE UNCHANGED. A DatePicker's value is `YYYY-MM-DD` and a DateTimePicker's `YYYY-MM-DDTHH:mm`:
 * exactly what the native inputs produced, so callers, the API and stored data do not change. `onChange`
 * gets the new string ('' when cleared).
 *
 * ACCESSIBILITY follows the WAI-ARIA date picker dialog pattern: the trigger is a button
 * (aria-haspopup="dialog"); the calendar is a dialog whose days form a grid with one tab stop; arrows move by
 * a day or a week, Home/End to the week's edges, PageUp/PageDown by a month (Shift: a year), Enter/Space
 * pick, Escape closes and gives focus back to the trigger. Tab stays inside the dialog while it is open.
 * On a phone the calendar opens as a bottom sheet with 44px targets.
 *
 * Plugins use it through the plugin UI kit (`@wordjs/ui` → DatePicker / DateTimePicker), with no change
 * to the core per plugin.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ADMIN_Z } from "@/lib/adminLayers";
import { useOptionalI18n } from "@/contexts/I18nContext";
import { t as translate } from "@/lib/i18n";
import { useDropdownPlacement } from "@/lib/useDropdownPlacement";
import { useWeekStart } from "@/lib/useWeekStart";
import {
    clampDay, dayAllowed, displayValue, formatDateTime, formatDay, keyTarget, longDate, monthGrid, monthName,
    parseDay, parseTime, today, weekdayNames, addMonths, type DayRef, type GridCell,
} from "@/lib/datePicker";

export interface DatePickerProps {
    value: string;
    onChange: (value: string) => void;
    /** Earliest allowed day (a date, or a datetime whose date part counts). */
    min?: string;
    /** Latest allowed day. */
    max?: string;
    id?: string;
    /** Visible label above the field (optional: a caller may render its own <label htmlFor={id}>). */
    label?: string;
    /** Accessible name when there is no visible label. */
    ariaLabel?: string;
    placeholder?: string;
    disabled?: boolean;
    /** Offer "Clear" (an empty value is allowed). Default true. */
    clearable?: boolean;
    /** Override the site's first day of the week (0 = Sunday … 6 = Saturday). */
    weekStart?: number;
    /** Classes for the trigger (size, width). The palette comes from the context, not from here. */
    className?: string;
    title?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The trigger reads as a field at rest: a 3:1 border (WCAG 1.4.11), the admin's or — inside Verso, where
 * the --ed-* tokens exist — the editor's outline, and a focus ring. Callers pass size/shape only.
 */
const TRIGGER_TONE =
    "bg-[var(--ed-surface-container,#fff)] text-[var(--ed-on-surface,#1f2937)] border-[var(--ed-outline,#7c8594)] " +
    "focus-visible:outline-none focus-visible:border-blue-500 focus-visible:ring-4 focus-visible:ring-blue-500/15";
const CELL_ATTR = "data-dp-day";

/** Admin (light) and editor (light/dark, via --ed-*) palettes, as CSS custom properties on the dialog. */
const ADMIN_TOKENS: React.CSSProperties = {
    ["--dp-bg" as string]: "#ffffff",
    ["--dp-fg" as string]: "#1f2937",
    ["--dp-muted" as string]: "#6b7280",
    ["--dp-outline" as string]: "#7c8594",
    ["--dp-line" as string]: "#e5e7eb",
    ["--dp-hover" as string]: "#f3f4f6",
    ["--dp-accent" as string]: "#2563eb",
    ["--dp-on-accent" as string]: "#ffffff",
};
const EDITOR_TOKENS: React.CSSProperties = {
    ["--dp-bg" as string]: "var(--ed-surface-container-lowest, #fff)",
    ["--dp-fg" as string]: "var(--ed-on-surface, #1b1b21)",
    ["--dp-muted" as string]: "var(--ed-on-surface-variant, #5b5d6b)",
    ["--dp-outline" as string]: "var(--ed-outline, #777987)",
    ["--dp-line" as string]: "var(--ed-outline-variant, #d8dae3)",
    ["--dp-hover" as string]: "var(--ed-surface-container-high, #ececf2)",
    ["--dp-accent" as string]: "var(--ed-primary-solid, #4f46e5)",
    ["--dp-on-accent" as string]: "#ffffff",
};

/** The month's days as an ARIA grid: one tab stop (the focused day), selection, today, out-of-range days. */
export function CalendarGrid({ gridRef, titleId, weeks, headers, selected, focusDay, todayValue, min, max, lang, t, onKeyDown, onPick }: {
    gridRef?: React.Ref<HTMLTableElement>;
    titleId: string;
    weeks: GridCell[][];
    headers: { short: string; long: string }[];
    selected: DayRef | null;
    focusDay: DayRef;
    todayValue: string;
    min?: string;
    max?: string;
    lang: string;
    t: (key: string) => string;
    onKeyDown?: (e: React.KeyboardEvent) => void;
    onPick?: (day: DayRef) => void;
}) {
    return (
        <table ref={gridRef} role="grid" aria-labelledby={titleId} className="w-full border-collapse" onKeyDown={onKeyDown}>
            <thead>
                <tr>
                    {headers.map((h) => (
                        <th key={h.long} scope="col" abbr={h.long} className="h-8 text-[11px] font-semibold uppercase text-[var(--dp-muted)]">
                            {h.short.slice(0, 2)}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {weeks.map((week) => (
                    <tr key={week[0].value}>
                        {week.map((cell) => {
                            const allowed = dayAllowed(cell.value, min, max);
                            const isSelected = !!selected && formatDay(selected) === cell.value;
                            const isFocus = formatDay(focusDay) === cell.value;
                            const isToday = cell.value === todayValue;
                            return (
                                <td key={cell.value} role="gridcell" aria-selected={isSelected} className="p-0.5 text-center">
                                    <button
                                        type="button"
                                        {...{ [CELL_ATTR]: cell.value }}
                                        tabIndex={isFocus ? 0 : -1}
                                        aria-label={longDate(lang, cell.day) + (allowed ? "" : `, ${t("datePicker.outOfRange")}`)}
                                        aria-current={isToday ? "date" : undefined}
                                        aria-disabled={!allowed || undefined}
                                        onClick={() => { if (allowed) onPick?.(cell.day); }}
                                        className={[
                                            "w-full h-11 sm:h-9 rounded-lg text-sm tabular-nums",
                                            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--dp-accent)]",
                                            isSelected
                                                ? "bg-[var(--dp-accent)] text-[var(--dp-on-accent)] font-bold"
                                                : allowed ? "hover:bg-[var(--dp-hover)]" : "",
                                            !isSelected && !cell.inMonth ? "text-[var(--dp-muted)] opacity-70" : "",
                                            !allowed ? "opacity-35 line-through cursor-not-allowed" : "",
                                            isToday && !isSelected ? "ring-1 ring-inset ring-[var(--dp-accent)] font-semibold" : "",
                                        ].join(" ")}
                                    >
                                        {cell.day.d}
                                    </button>
                                </td>
                            );
                        })}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function useTranslate() {
    const i18n = useOptionalI18n();
    const lang = i18n?.language ?? "en";
    const t = useCallback((key: string) => (i18n ? i18n.t(key) : translate(key, "en")), [i18n]);
    return { t, lang };
}

function PickerField({ withTime, ...props }: DatePickerProps & { withTime: boolean }) {
    const {
        value, onChange, min, max, id, label, ariaLabel, placeholder, disabled, clearable = true, className = "", title,
    } = props;
    const { t, lang } = useTranslate();
    const knownWeekStart = useWeekStart(props.weekStart);
    const weekReady = knownWeekStart !== null;
    const weekStart = knownWeekStart ?? 1;
    const autoId = useId();
    const fieldId = id ?? `dp-${autoId}`;
    const dialogId = `${fieldId}-dialog`;
    const titleId = `${fieldId}-title`;

    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const gridRef = useRef<HTMLTableElement | null>(null);

    const [open, setOpen] = useState(false);
    const [inEditor, setInEditor] = useState(false);
    const [narrow, setNarrow] = useState(false);
    const selected = parseDay(value);
    const time = parseTime(value) ?? { h: 9, min: 0 };
    const todayRef = today();
    // The day that holds the grid's tab stop, and the month on screen.
    const [focusDay, setFocusDay] = useState<DayRef>(selected ?? clampDay(todayRef, min, max));
    const [view, setView] = useState<{ y: number; m: number }>({ y: focusDay.y, m: focusDay.m });
    const [timeDraft, setTimeDraft] = useState({ h: pad(time.h), min: pad(time.min) });

    const { coords } = useDropdownPlacement(open && !narrow, { trigger: triggerRef, list: dialogRef }, `${view.y}-${view.m}`);

    const openPicker = () => {
        if (disabled) return;
        const start = selected ?? clampDay(todayRef, min, max);
        setFocusDay(start);
        setView({ y: start.y, m: start.m });
        setTimeDraft({ h: pad(time.h), min: pad(time.min) });
        setInEditor(!!triggerRef.current?.closest(".verso-editor-ui, .verso-container, .verso-shell"));
        setNarrow(typeof window !== "undefined" && window.innerWidth < 640);
        setOpen(true);
    };
    const close = useCallback((refocus = true) => {
        setOpen(false);
        if (refocus) triggerRef.current?.focus();
    }, []);

    // Focus the grid's day when the dialog opens and whenever keyboard navigation moves it.
    useLayoutEffect(() => {
        if (!open) return;
        const cell = gridRef.current?.querySelector<HTMLButtonElement>(`[${CELL_ATTR}="${formatDay(focusDay)}"]`);
        cell?.focus({ preventScroll: true });
    }, [open, focusDay, view, weekReady]);

    // A click outside closes (the trigger toggles on its own).
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            const target = e.target as Node;
            if (dialogRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
            close(false);
        };
        document.addEventListener("pointerdown", onDown, true);
        return () => document.removeEventListener("pointerdown", onDown, true);
    }, [open, close]);

    const commitDay = (day: DayRef) => {
        if (!dayAllowed(formatDay(day), min, max)) return;
        if (withTime) {
            const h = Math.min(23, Math.max(0, Number(timeDraft.h) || 0));
            const mm = Math.min(59, Math.max(0, Number(timeDraft.min) || 0));
            onChange(formatDateTime(day, { h, min: mm }));
            setFocusDay(day);
            return; // the date-time dialog stays open for the time; "Done" closes it
        }
        onChange(formatDay(day));
        close();
    };

    const moveFocus = (day: DayRef) => {
        const next = clampDay(day, min, max);
        setFocusDay(next);
        setView({ y: next.y, m: next.m });
    };

    const onGridKey = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            commitDay(focusDay);
            return;
        }
        const target = keyTarget(e.key, e.shiftKey, focusDay, weekStart);
        if (target) {
            e.preventDefault();
            moveFocus(target);
        }
    };

    const onDialogKey = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
            return;
        }
        if (e.key !== "Tab") return;
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
            `button:not([disabled]):not([tabindex="-1"]), input:not([disabled])`,
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    const setTimePart = (part: "h" | "min", raw: string) => {
        const digits = raw.replace(/\D/g, "").slice(0, 2);
        const next = { ...timeDraft, [part]: digits };
        setTimeDraft(next);
        const day = selected ?? focusDay;
        const h = Number(next.h), mm = Number(next.min);
        if (next.h !== "" && next.min !== "" && h <= 23 && mm <= 59 && dayAllowed(formatDay(day), min, max)) {
            onChange(formatDateTime(day, { h, min: mm }));
        }
    };

    const weeks = useMemo(() => monthGrid(view.y, view.m, weekStart), [view.y, view.m, weekStart]);
    const headers = useMemo(() => weekdayNames(lang, weekStart), [lang, weekStart]);
    const shown = displayValue(lang, value, withTime);
    const chooseLabel = t(withTime ? "datePicker.chooseDateTime" : "datePicker.choose");
    const accessibleName = [label ?? ariaLabel ?? chooseLabel, shown || t("datePicker.empty")].join(", ");
    const tokens = inEditor ? EDITOR_TOKENS : ADMIN_TOKENS;
    const todayValue = formatDay(todayRef);
    const todayAllowed = dayAllowed(todayValue, min, max);

    const navButton = (labelKey: string, icon: string, onClick: () => void) => (
        <button
            type="button"
            onClick={onClick}
            aria-label={t(labelKey)}
            title={t(labelKey)}
            className="w-11 h-11 sm:w-8 sm:h-8 shrink-0 rounded-lg flex items-center justify-center text-[var(--dp-muted)] hover:bg-[var(--dp-hover)] hover:text-[var(--dp-fg)] focus-visible:outline-2 focus-visible:outline-[var(--dp-accent)]"
        >
            <i className={`fa-solid ${icon} text-xs`} aria-hidden="true" />
        </button>
    );

    const dialog = open ? (
        <div
            ref={dialogRef}
            id={dialogId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-date-picker-dialog=""
            data-dp-tone={inEditor ? "editor" : "admin"}
            onKeyDown={onDialogKey}
            className={`${inEditor ? "verso-editor-ui " : ""}bg-[var(--dp-bg)] text-[var(--dp-fg)] border border-[var(--dp-line)] shadow-2xl p-3 sm:p-4 select-none ${narrow ? "rounded-t-2xl" : "rounded-2xl"}`}
            style={{
                ...tokens,
                ...(narrow
                    ? { position: "fixed", left: 0, right: 0, bottom: 0, zIndex: ADMIN_Z.popover, paddingBottom: "max(16px, env(safe-area-inset-bottom))" }
                    : {
                        position: "fixed",
                        left: coords?.left ?? -9999,
                        top: coords?.top,
                        bottom: coords?.bottom,
                        width: 304,
                        zIndex: ADMIN_Z.popover,
                        visibility: coords ? "visible" : "hidden",
                    }),
            }}
        >
            <div className="flex items-center gap-1 mb-2">
                {navButton("datePicker.prevYear", "fa-angles-left", () => moveFocus(addMonths(focusDay, -12)))}
                {navButton("datePicker.prevMonth", "fa-chevron-left", () => moveFocus(addMonths(focusDay, -1)))}
                <h2 id={titleId} aria-live="polite" className="flex-1 text-center text-sm font-bold">
                    {monthName(lang, view.m, view.y)} {view.y}
                </h2>
                {navButton("datePicker.nextMonth", "fa-chevron-right", () => moveFocus(addMonths(focusDay, 1)))}
                {navButton("datePicker.nextYear", "fa-angles-right", () => moveFocus(addMonths(focusDay, 12)))}
            </div>

            {!weekReady ? (
                // The site's first weekday is still loading: hold the grid's space rather than draw Monday first.
                <div aria-hidden="true" className="h-[320px] sm:h-[272px]" />
            ) : (
            <CalendarGrid
                gridRef={gridRef}
                titleId={titleId}
                weeks={weeks}
                headers={headers}
                selected={selected}
                focusDay={focusDay}
                todayValue={todayValue}
                min={min}
                max={max}
                lang={lang}
                t={t}
                onKeyDown={onGridKey}
                onPick={(day) => { setFocusDay(day); commitDay(day); }}
            />
            )}

            {withTime && (
                <div className="mt-3 flex items-center gap-2 text-sm">
                    <span className="font-semibold text-[var(--dp-muted)] mr-auto">{t("datePicker.time")}</span>
                    <input
                        aria-label={t("datePicker.hours")}
                        inputMode="numeric"
                        maxLength={2}
                        value={timeDraft.h}
                        onChange={(e) => setTimePart("h", e.target.value)}
                        onBlur={() => setTimeDraft((d) => ({ ...d, h: pad(Math.min(23, Number(d.h) || 0)) }))}
                        className="w-12 h-11 sm:h-9 text-center rounded-lg border bg-transparent border-[var(--dp-outline)] tabular-nums focus:outline-2 focus:outline-[var(--dp-accent)]"
                    />
                    <span aria-hidden="true">:</span>
                    <input
                        aria-label={t("datePicker.minutes")}
                        inputMode="numeric"
                        maxLength={2}
                        value={timeDraft.min}
                        onChange={(e) => setTimePart("min", e.target.value)}
                        onBlur={() => setTimeDraft((d) => ({ ...d, min: pad(Math.min(59, Number(d.min) || 0)) }))}
                        className="w-12 h-11 sm:h-9 text-center rounded-lg border bg-transparent border-[var(--dp-outline)] tabular-nums focus:outline-2 focus:outline-[var(--dp-accent)]"
                    />
                </div>
            )}

            <div className="mt-3 pt-3 border-t border-[var(--dp-line)] flex items-center gap-2">
                <button
                    type="button"
                    disabled={!todayAllowed}
                    onClick={() => { moveFocus(todayRef); commitDay(todayRef); }}
                    className="h-11 sm:h-8 px-3 rounded-lg text-xs font-bold text-[var(--dp-accent)] hover:bg-[var(--dp-hover)] disabled:opacity-40"
                >
                    {t("datePicker.today")}
                </button>
                {clearable && (
                    <button
                        type="button"
                        disabled={!value}
                        onClick={() => { onChange(""); close(); }}
                        className="h-11 sm:h-8 px-3 rounded-lg text-xs font-bold text-[var(--dp-muted)] hover:bg-[var(--dp-hover)] disabled:opacity-40"
                    >
                        {t("datePicker.clear")}
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => close()}
                    className="ml-auto h-11 sm:h-8 px-3 rounded-lg text-xs font-bold bg-[var(--dp-accent)] text-[var(--dp-on-accent)]"
                >
                    {t(withTime ? "datePicker.done" : "datePicker.close")}
                </button>
            </div>
        </div>
    ) : null;

    return (
        <div className="w-full">
            {label && (
                <label htmlFor={fieldId} className="block text-[11px] font-black uppercase tracking-widest text-gray-500 mb-2">
                    {label}
                </label>
            )}
            <button
                ref={triggerRef}
                id={fieldId}
                type="button"
                disabled={disabled}
                title={title}
                // Named by the caller's <label htmlFor> when there is one (an aria-label would replace it);
                // otherwise by `label`/`ariaLabel`. The value is announced as the description.
                aria-label={label || ariaLabel ? accessibleName : undefined}
                aria-describedby={`${fieldId}-value`}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? dialogId : undefined}
                data-date-picker={withTime ? "datetime" : "date"}
                data-value={value}
                onClick={() => (open ? close(false) : openPicker())}
                className={`w-full flex items-center gap-2 text-left px-3 py-2.5 rounded-xl border ${TRIGGER_TONE} disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
            >
                <i className="fa-regular fa-calendar text-sm opacity-60" aria-hidden="true" />
                <span id={`${fieldId}-value`} className={`flex-1 truncate ${shown ? "" : "opacity-60"}`}>{shown || placeholder || chooseLabel}</span>
            </button>
            {dialog && typeof document !== "undefined" && createPortal(
                narrow ? (
                    <>
                        <div aria-hidden="true" onClick={() => close(false)} style={{ position: "fixed", inset: 0, zIndex: ADMIN_Z.popover - 1, background: "rgb(0 0 0 / 0.35)" }} />
                        {dialog}
                    </>
                ) : dialog,
                document.body,
            )}
        </div>
    );
}

/** A day: value `YYYY-MM-DD` ('' when empty). */
export function DatePicker(props: DatePickerProps) {
    return <PickerField {...props} withTime={false} />;
}

/** A day and a time: value `YYYY-MM-DDTHH:mm` ('' when empty), the native datetime-local format. */
export function DateTimePicker(props: DatePickerProps) {
    return <PickerField {...props} withTime={true} />;
}

export default DatePicker;

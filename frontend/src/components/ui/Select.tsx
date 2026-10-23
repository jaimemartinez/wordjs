"use client";

/**
 * Select — THE admin select (components/ui). It was two components: ModernSelect (groups, placeholder,
 * the custom trigger the resting-border rule targets) and a smaller ui/Select (value-based onChange).
 * This is ModernSelect's implementation with ui/Select's value-based API; components/ModernSelect is a
 * shim over it that keeps its event-style onChange for the screens that still import it.
 *
 * A button trigger and a portalled listbox (never clipped by an `overflow-hidden` card or dialog; placed
 * by lib/dropdownPlacement.ts), the shared field contract (components/ui/Field), options with groups,
 * descriptions and disabled entries, and an optional search box for long lists.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDropdownPlacement } from "@/lib/useDropdownPlacement";
import { ADMIN_Z } from "@/lib/adminLayers";
import { ERROR_CLASS, HELP_CLASS, LABEL_TEXT_CLASS, useFieldA11y, useKitText, useNameCheck } from "./Field";

export interface SelectOption {
    value: string | number;
    label: string;
    /** Optional heading: consecutive options with the same group are listed under it. */
    group?: string;
    /** A second line under the label. */
    description?: string;
    disabled?: boolean;
}

export interface SelectProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue"> {
    label?: React.ReactNode;
    /** Icon class shown before the label (e.g. "fa-solid fa-globe"). */
    icon?: string;
    help?: React.ReactNode;
    error?: React.ReactNode;
    required?: boolean;
    options: SelectOption[];
    value?: string | number;
    onChange?: (value: string) => void;
    placeholder?: string;
    /** A search box at the top of the open list (time zones, fonts, long lists). */
    searchable?: boolean;
    containerClassName?: string;
    disabled?: boolean;
}

/**
 * An option's label WRAPS instead of being truncated: on a phone «Equipo de conferencia · plugin
 * conference-manager» was cut to «… plugin confe…», and the open list is the one place the whole label
 * is shown. The check mark keeps its size beside a two-line label. Exported for the unit test.
 */
export const OPTION_LABEL_CLASS = "min-w-0 flex-1 whitespace-normal break-words";

/**
 * The heading over each group of options («ROLES DEL SISTEMA», «ROLES DE PLUGINS») is gray-600: it was
 * gray-400, 2.5:1 on the menu's white. The menu is 95 % white over whatever is behind it (a dimmed page,
 * the dark sidebar under a dialog's scrim), and gray-500 drops under AA there (4.3:1); gray-600 keeps
 * ≥ 6.9:1 even over black — so does the menu's empty-list line. The trigger's placeholder (gray-400 too)
 * is gray-500, on the trigger's solid gray-50. Exported for the unit test.
 */
export const GROUP_HEADING_CLASS = "px-4 pt-3 pb-1 text-[11px] font-black uppercase tracking-widest text-gray-600 break-words";
export const EMPTY_LIST_CLASS = "px-4 py-3 text-sm text-gray-600 italic";
export const PLACEHOLDER_CLASS = "text-gray-500";

export function Select({
    label,
    icon,
    help,
    error,
    required,
    options,
    value,
    onChange,
    placeholder,
    searchable = false,
    className = "",
    containerClassName = "",
    disabled = false,
    id,
    ...containerProps
}: SelectProps) {
    // The trigger is a <button>: the visible label is tied to it, and an aria-label / aria-labelledby
    // given to the component names it when there is no visible label.
    const { "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, "aria-describedby": describedBy, ...props } =
        containerProps as typeof containerProps & { "aria-label"?: string; "aria-labelledby"?: string; "aria-describedby"?: string };
    const t = useKitText();
    const { controlId, helpId, errorId, aria } = useFieldA11y({ id, help, error, required }, describedBy);
    useNameCheck("Select", !!label || !!ariaLabel || !!ariaLabelledBy);
    const listboxId = useId();
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [highlight, setHighlight] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const labelRef = useRef<HTMLLabelElement>(null);
    const triggerRef = useRef<HTMLDivElement>(null);
    const triggerButtonRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    const shown = useMemo(() => {
        const q = query.trim().toLocaleLowerCase();
        return q ? options.filter((o) => `${o.label} ${o.description ?? ""}`.toLocaleLowerCase().includes(q)) : options;
    }, [options, query]);

    // The portalled menu is position: fixed (so no `overflow-hidden` ancestor — a rounded card, a dialog
    // body — clips it) and placed by lib/dropdownPlacement.ts: ALWAYS inside the visible viewport and whole
    // whenever it can be — below the field, else above its label (in a dialog, scrolling the dialog's body
    // a little when that makes it fit), else over the label; it scrolls inside only when nothing fits.
    const { coords, update: updateCoords } = useDropdownPlacement(isOpen, { trigger: triggerRef, list: listRef, label: labelRef }, shown.length);

    const selectedOption = options.find((opt) => String(opt.value) === String(value));
    const displayLabel = selectedOption ? selectedOption.label : (placeholder ?? t("ui.select.placeholder"));

    // Outside click — check the trigger AND the portalled menu (which lives outside the container).
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (containerRef.current?.contains(target)) return;
            if (dropdownRef.current?.contains(target)) return;
            setIsOpen(false);
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isOpen]);

    // When opening, highlight the currently-selected option (or the first one the search leaves).
    useEffect(() => {
        if (!isOpen) return;
        const idx = shown.findIndex((opt) => String(opt.value) === String(value));
        setHighlight(idx >= 0 ? idx : 0);
    }, [isOpen, value, shown]);

    // Keep the highlighted row scrolled into view during keyboard navigation.
    useEffect(() => {
        if (!isOpen) return;
        listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
    }, [highlight, isOpen]);

    // Opened from inside the Verso editor, the portalled menu joins the editor's palette.
    const [inEditor, setInEditor] = useState(false);
    const open = () => {
        if (disabled) return;
        updateCoords();
        setQuery("");
        setInEditor(!!containerRef.current?.closest(".verso-container, .verso-editor-ui"));
        setIsOpen(true);
    };
    useEffect(() => {
        if (isOpen && searchable) searchRef.current?.focus({ preventScroll: true });
    }, [isOpen, searchable]);

    const close = (refocus: boolean) => {
        setIsOpen(false);
        if (refocus) triggerButtonRef.current?.focus({ preventScroll: true });
    };

    const handleToggle = () => {
        if (disabled) return;
        if (isOpen) setIsOpen(false); else open();
    };

    const handleSelect = (opt: SelectOption) => {
        if (opt.disabled) return;
        onChange?.(String(opt.value));
        close(searchable);
    };

    /** The next enabled option from `from`, in direction `dir`; stays put when there is none. */
    const step = (from: number, dir: 1 | -1) => {
        for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (!shown[i].disabled) return i;
        return from;
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (disabled) return;
        if (!isOpen) {
            if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                open();
            }
            return;
        }
        if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => step(h, 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => step(h, -1)); }
        else if (e.key === "Enter") { e.preventDefault(); if (shown[highlight]) handleSelect(shown[highlight]); }
        else if (e.key === "Escape") { e.preventDefault(); close(true); }
        else if (e.key === "Tab") setIsOpen(false);
    };

    return (
        <div className={`space-y-2 ${containerClassName}`} ref={containerRef} data-wjs-field="" {...props}>
            {label && (
                <label ref={labelRef} htmlFor={controlId} className={`flex items-center gap-2 ${LABEL_TEXT_CLASS}`}>
                    {icon && <i className={`${icon} text-blue-500/70`} aria-hidden="true"></i>}
                    {label}
                    {required && <span aria-hidden="true" className="text-red-600">*</span>}
                </label>
            )}

            <div className="relative" ref={triggerRef}>
                <button
                    ref={triggerButtonRef}
                    id={controlId}
                    aria-label={label ? undefined : ariaLabel}
                    aria-labelledby={label ? undefined : ariaLabelledBy}
                    type="button"
                    onClick={handleToggle}
                    onKeyDown={handleKeyDown}
                    disabled={disabled}
                    aria-haspopup="listbox"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? listboxId : undefined}
                    {...aria}
                    data-modern-select=""
                    className={`
                        w-full flex items-center justify-between bg-gray-50 border-2 border-gray-100 text-gray-700 py-2.5 px-4 rounded-xl
                        focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/50
                        transition-all duration-300 font-medium text-sm
                        hover:border-gray-200 hover:bg-white
                        ${isOpen ? "border-blue-500/50 bg-white ring-4 ring-blue-500/10" : ""}
                        ${error ? "border-red-300" : ""}
                        ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
                        ${className}
                    `}
                >
                    <span className={`truncate ${!selectedOption ? PLACEHOLDER_CLASS : ""}`}>
                        {displayLabel}
                    </span>
                    <i className={`fa-solid fa-chevron-down text-[11px] transition-transform duration-300 text-gray-400 ${isOpen ? "rotate-180 text-blue-500" : ""}`} aria-hidden="true"></i>
                </button>

                {/* Dropdown Menu — portalled to <body>, above any dialog it is opened from (lib/adminLayers.ts). */}
                {isOpen && coords && typeof document !== "undefined" && createPortal(
                    <div
                        ref={dropdownRef}
                        data-dropdown-side={coords.side}
                        data-modern-select-menu=""
                        style={{
                            position: "fixed",
                            left: coords.left,
                            width: coords.width,
                            top: coords.top,
                            bottom: coords.bottom,
                            zIndex: ADMIN_Z.popover,
                        }}
                        // Opened from the Verso editor, the menu (portalled out of it) joins the editor's
                        // palette: in its dark mode a white list hung off a dark panel.
                        className={`bg-white/95 backdrop-blur-xl border border-gray-100 shadow-2xl rounded-2xl overflow-hidden animate-in fade-in duration-150${inEditor ? " verso-editor-ui" : ""}`}
                    >
                        {searchable && (
                            <div className="p-2 border-b border-gray-100">
                                <input
                                    ref={searchRef}
                                    type="search"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    aria-label={t("ui.select.search")}
                                    aria-controls={listboxId}
                                    placeholder={t("ui.select.search")}
                                    data-control-border="none"
                                    className="w-full px-3 py-2 text-sm rounded-lg bg-gray-50 border border-gray-200 outline-none focus:border-blue-500"
                                />
                            </div>
                        )}
                        <div ref={listRef} id={listboxId} className="py-1 overflow-y-auto overscroll-contain custom-scrollbar" style={{ maxHeight: coords.maxHeight }} role="listbox">
                            {shown.length === 0 ? (
                                <div className={EMPTY_LIST_CLASS}>{t(query ? "ui.select.noMatch" : "ui.select.empty")}</div>
                            ) : (
                                shown.map((opt, i) => {
                                    const isSelected = String(opt.value) === String(value);
                                    const isHighlighted = i === highlight;
                                    // A heading before the first option of each group (not an option:
                                    // keyboard navigation still walks the options only).
                                    const heading = opt.group && (i === 0 || shown[i - 1].group !== opt.group)
                                        ? (
                                            <div role="presentation" className={GROUP_HEADING_CLASS} data-option-group="">
                                                {opt.group}
                                            </div>
                                        )
                                        : null;
                                    return (
                                        <React.Fragment key={opt.value}>
                                        {heading}
                                        <button
                                            type="button"
                                            role="option"
                                            aria-selected={isSelected}
                                            aria-disabled={opt.disabled || undefined}
                                            data-idx={i}
                                            onMouseEnter={() => { if (!opt.disabled) setHighlight(i); }}
                                            onClick={() => handleSelect(opt)}
                                            className={`
                                                    w-full text-left px-4 py-2.5 text-sm transition-all duration-200 flex items-center justify-between gap-3
                                                    ${opt.disabled
                                                    ? "text-gray-400 cursor-not-allowed"
                                                    : isSelected
                                                    ? "bg-blue-50 text-blue-700 font-bold"
                                                    : isHighlighted
                                                        ? "bg-gray-50 text-gray-900"
                                                        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"}
                                                `}
                                        >
                                            <span className={OPTION_LABEL_CLASS}>
                                                {opt.label}
                                                {opt.description && <span className="block text-xs font-normal text-gray-500">{opt.description}</span>}
                                            </span>
                                            {isSelected && <i className="fa-solid fa-check text-xs shrink-0" aria-hidden="true"></i>}
                                        </button>
                                        </React.Fragment>
                                    );
                                })
                            )}
                        </div>
                    </div>,
                    document.body
                )}
            </div>
            {help && <p id={helpId} className={HELP_CLASS}>{help}</p>}
            {error && <p id={errorId} role="alert" className={ERROR_CLASS}>{error}</p>}
        </div>
    );
}

export default Select;

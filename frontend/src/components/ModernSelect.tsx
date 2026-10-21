import React, { useState, useRef, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { useDropdownPlacement } from '@/lib/useDropdownPlacement';
import { ADMIN_Z } from '@/lib/adminLayers';

interface Option {
    value: string | number;
    label: string;
    /** Optional heading: consecutive options with the same group are listed under it. */
    group?: string;
}

interface ModernSelectProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'value'> {
    label?: string;
    icon?: string;
    options: Option[];
    value?: string | number;
    onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
    placeholder?: string;
    containerClassName?: string;
    disabled?: boolean;
}

/**
 * An option's label WRAPS instead of being truncated: on a phone «Equipo de conferencia · plugin
 * conference-manager» was cut to «… plugin confe…», and the open list is the one place the whole label
 * is shown. The check mark keeps its size beside a two-line label. Exported for the unit test.
 */
export const OPTION_LABEL_CLASS = 'min-w-0 flex-1 whitespace-normal break-words';

/**
 * The heading over each group of options («ROLES DEL SISTEMA», «ROLES DE PLUGINS») is gray-600: it was
 * gray-400, 2.5:1 on the menu's white. The menu is 95 % white over whatever is behind it (a dimmed page,
 * the dark sidebar under a dialog's scrim), and gray-500 drops under AA there (4.3:1); gray-600 keeps
 * ≥ 6.9:1 even over black — so does the menu's empty-list line. The trigger's placeholder (gray-400 too)
 * is gray-500, on the trigger's solid gray-50. Exported for the unit test.
 */
export const GROUP_HEADING_CLASS = 'px-4 pt-3 pb-1 text-[11px] font-black uppercase tracking-widest text-gray-600 break-words';
export const EMPTY_LIST_CLASS = 'px-4 py-3 text-sm text-gray-600 italic';
export const PLACEHOLDER_CLASS = 'text-gray-500';

const ModernSelect: React.FC<ModernSelectProps> = ({
    label,
    icon,
    options,
    value,
    onChange,
    placeholder = "Select an option",
    className = "",
    containerClassName = "",
    disabled = false,
    ...containerProps
}) => {
    // The trigger is a <button>: the visible label is tied to it (it used to be a free-standing
    // <label>), and an aria-label given to the component names it when there is no visible label —
    // the editor's status picker announced only "Draft, collapsed".
    const { "aria-label": ariaLabel, ...props } = containerProps as typeof containerProps & { "aria-label"?: string };
    const triggerId = useId();
    const [isOpen, setIsOpen] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const labelRef = useRef<HTMLLabelElement>(null);
    const triggerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // The portalled menu is position: fixed (so no `overflow-hidden` ancestor — a rounded card, a dialog
    // body — clips it) and placed by lib/dropdownPlacement.ts: ALWAYS inside the visible viewport and whole
    // whenever it can be — below the field, else above its label (in a dialog, scrolling the dialog's body
    // a little when that makes it fit), else over the label; it scrolls inside only when nothing fits.
    const { coords, update: updateCoords } = useDropdownPlacement(isOpen, { trigger: triggerRef, list: listRef, label: labelRef }, options.length);

    // Get current label
    const selectedOption = options.find(opt => String(opt.value) === String(value));
    const displayLabel = selectedOption ? selectedOption.label : placeholder;

    // Outside click — check the trigger AND the portalled menu (which lives outside the container).
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (containerRef.current?.contains(target)) return;
            if (dropdownRef.current?.contains(target)) return;
            setIsOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    // When opening, highlight the currently-selected option.
    useEffect(() => {
        if (!isOpen) return;
        const idx = options.findIndex(opt => String(opt.value) === String(value));
        setHighlight(idx >= 0 ? idx : 0);
    }, [isOpen, value, options]);

    // Keep the highlighted row scrolled into view during keyboard navigation.
    useEffect(() => {
        if (!isOpen) return;
        listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
    }, [highlight, isOpen]);

    const open = () => {
        if (disabled) return;
        updateCoords();
        setIsOpen(true);
    };

    const handleToggle = () => {
        if (disabled) return;
        if (isOpen) setIsOpen(false); else open();
    };

    const handleSelect = (val: string | number) => {
        if (onChange) {
            // Mock a native change event for compatibility
            onChange({
                target: { value: String(val) }
            } as React.ChangeEvent<HTMLSelectElement>);
        }
        setIsOpen(false);
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
        if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, options.length - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
        else if (e.key === "Enter") { e.preventDefault(); if (options[highlight]) handleSelect(options[highlight].value); }
        else if (e.key === "Escape") { e.preventDefault(); setIsOpen(false); }
    };

    return (
        <div className={`space-y-2 ${containerClassName}`} ref={containerRef} {...props}>
            {label && (
                <label ref={labelRef} htmlFor={triggerId} className="text-sm font-bold text-gray-700 flex items-center gap-2">
                    {icon && <i className={`${icon} text-blue-500/70`}></i>}
                    {label}
                </label>
            )}

            <div className="relative" ref={triggerRef}>
                {/* Trigger Button */}
                <button
                    id={triggerId}
                    aria-label={label ? undefined : ariaLabel}
                    type="button"
                    onClick={handleToggle}
                    onKeyDown={handleKeyDown}
                    disabled={disabled}
                    aria-haspopup="listbox"
                    aria-expanded={isOpen}
                    className={`
                        w-full flex items-center justify-between bg-gray-50 border-2 border-gray-100 text-gray-700 py-2.5 px-4 rounded-xl
                        focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/50
                        transition-all duration-300 font-medium text-sm
                        hover:border-gray-200 hover:bg-white
                        ${isOpen ? 'border-blue-500/50 bg-white ring-4 ring-blue-500/10' : ''}
                        ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                        ${className}
                    `}
                >
                    <span className={`truncate ${!selectedOption ? PLACEHOLDER_CLASS : ''}`}>
                        {displayLabel}
                    </span>
                    <i className={`fa-solid fa-chevron-down text-[11px] transition-transform duration-300 text-gray-400 ${isOpen ? 'rotate-180 text-blue-500' : ''}`}></i>
                </button>

                {/* Dropdown Menu — portalled to <body>, above any dialog it is opened from (lib/adminLayers.ts). */}
                {isOpen && coords && typeof document !== 'undefined' && createPortal(
                    <div
                        ref={dropdownRef}
                        data-dropdown-side={coords.side}
                        style={{
                            position: 'fixed',
                            left: coords.left,
                            width: coords.width,
                            top: coords.top,
                            bottom: coords.bottom,
                            zIndex: ADMIN_Z.popover,
                        }}
                        className="bg-white/95 backdrop-blur-xl border border-gray-100 shadow-2xl rounded-2xl overflow-hidden animate-in fade-in duration-150"
                    >
                        <div ref={listRef} className="py-1 overflow-y-auto overscroll-contain custom-scrollbar" style={{ maxHeight: coords.maxHeight }} role="listbox">
                            {options.length === 0 ? (
                                <div className={EMPTY_LIST_CLASS}>No options available</div>
                            ) : (
                                options.map((opt, i) => {
                                    const isSelected = String(opt.value) === String(value);
                                    const isHighlighted = i === highlight;
                                    // A heading before the first option of each group (not an option:
                                    // keyboard navigation still walks the options only).
                                    const heading = opt.group && (i === 0 || options[i - 1].group !== opt.group)
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
                                            data-idx={i}
                                            onMouseEnter={() => setHighlight(i)}
                                            onClick={() => handleSelect(opt.value)}
                                            className={`
                                                    w-full text-left px-4 py-2.5 text-sm transition-all duration-200 flex items-center justify-between gap-3
                                                    ${isSelected
                                                    ? 'bg-blue-50 text-blue-700 font-bold'
                                                    : isHighlighted
                                                        ? 'bg-gray-50 text-gray-900'
                                                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}
                                                `}
                                        >
                                            <span className={OPTION_LABEL_CLASS}>{opt.label}</span>
                                            {isSelected && <i className="fa-solid fa-check text-xs shrink-0"></i>}
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

            {/* Hidden native select for accessibility/forms if needed (optional) */}
            <select
                className="hidden"
                value={value}
                onChange={onChange}
                disabled={disabled}
                tabIndex={-1}
            >
                {options.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
            </select>
        </div>
    );
};

export default ModernSelect;

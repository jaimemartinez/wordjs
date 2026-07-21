import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface Option {
    value: string | number;
    label: string;
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

// Fixed-position coords for the portalled menu, so it escapes any `overflow-hidden` ancestor
// (e.g. a rounded card) that would otherwise clip the options list.
interface Coords { left: number; width: number; top?: number; bottom?: number; maxHeight: number; }

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
    ...props
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const [coords, setCoords] = useState<Coords | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Get current label
    const selectedOption = options.find(opt => String(opt.value) === String(value));
    const displayLabel = selectedOption ? selectedOption.label : placeholder;

    const updateCoords = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const gap = 8;
        const spaceBelow = window.innerHeight - rect.bottom - gap;
        const spaceAbove = rect.top - gap;
        const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
        const maxHeight = Math.max(120, Math.min(260, Math.floor(openUp ? spaceAbove : spaceBelow)));
        setCoords({
            left: rect.left,
            width: rect.width,
            top: openUp ? undefined : Math.round(rect.bottom + gap),
            bottom: openUp ? Math.round(window.innerHeight - rect.top + gap) : undefined,
            maxHeight,
        });
    }, []);

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

    // Reposition while open (capture catches inner scroll containers).
    useEffect(() => {
        if (!isOpen) return;
        updateCoords();
        const onScroll = () => updateCoords();
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };
    }, [isOpen, updateCoords]);

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
        isOpen ? setIsOpen(false) : open();
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
                <label className="text-sm font-bold text-gray-700 flex items-center gap-2">
                    {icon && <i className={`${icon} text-blue-500/70`}></i>}
                    {label}
                </label>
            )}

            <div className="relative" ref={triggerRef}>
                {/* Trigger Button */}
                <button
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
                    <span className={`truncate ${!selectedOption ? 'text-gray-400' : ''}`}>
                        {displayLabel}
                    </span>
                    <i className={`fa-solid fa-chevron-down text-[10px] transition-transform duration-300 text-gray-400 ${isOpen ? 'rotate-180 text-blue-500' : ''}`}></i>
                </button>

                {/* Dropdown Menu — portalled to <body> so it never gets clipped by an overflow-hidden card. */}
                {isOpen && coords && typeof document !== 'undefined' && createPortal(
                    <div
                        ref={dropdownRef}
                        style={{
                            position: 'fixed',
                            left: coords.left,
                            width: coords.width,
                            top: coords.top,
                            bottom: coords.bottom,
                            zIndex: 6000,
                        }}
                        className="bg-white/95 backdrop-blur-xl border border-gray-100 shadow-2xl rounded-2xl overflow-hidden animate-in fade-in duration-150"
                    >
                        <div ref={listRef} className="py-1 overflow-y-auto custom-scrollbar" style={{ maxHeight: coords.maxHeight }} role="listbox">
                            {options.length === 0 ? (
                                <div className="px-4 py-3 text-sm text-gray-400 italic">No options available</div>
                            ) : (
                                options.map((opt, i) => {
                                    const isSelected = String(opt.value) === String(value);
                                    const isHighlighted = i === highlight;
                                    return (
                                        <button
                                            key={opt.value}
                                            type="button"
                                            role="option"
                                            aria-selected={isSelected}
                                            data-idx={i}
                                            onMouseEnter={() => setHighlight(i)}
                                            onClick={() => handleSelect(opt.value)}
                                            className={`
                                                    w-full text-left px-4 py-2.5 text-sm transition-all duration-200 flex items-center justify-between
                                                    ${isSelected
                                                    ? 'bg-blue-50 text-blue-700 font-bold'
                                                    : isHighlighted
                                                        ? 'bg-gray-50 text-gray-900'
                                                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}
                                                `}
                                        >
                                            <span className="truncate">{opt.label}</span>
                                            {isSelected && <i className="fa-solid fa-check text-xs"></i>}
                                        </button>
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

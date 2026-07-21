import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface SelectOption {
    value: string;
    label: string;
}

interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    disabled?: boolean;
    className?: string;
}

// Fixed-position coordinates for the portalled dropdown, so it escapes any `overflow-hidden`
// ancestor (e.g. a rounded card) that would otherwise clip the options.
interface Coords { left: number; width: number; top?: number; bottom?: number; maxHeight: number; }

export function Select({ value, onChange, options, disabled, className }: SelectProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const [coords, setCoords] = useState<Coords | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const selectedLabel = options.find(o => o.value === value)?.label || value;

    // Measure the trigger and decide whether the menu opens downward or (when there isn't room)
    // upward. Runs on open and on scroll/resize so the menu stays pinned to the trigger.
    const updateCoords = useCallback(() => {
        const el = containerRef.current;
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

    // Close on outside click — checking BOTH the trigger and the portalled menu, since the menu
    // lives outside the container in the DOM tree.
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

    // Reposition while open; use capture so inner scroll containers are caught too.
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
        const idx = options.findIndex(o => o.value === value);
        setHighlight(idx >= 0 ? idx : 0);
    }, [isOpen, value, options]);

    // Keep the highlighted row scrolled into view during keyboard navigation.
    useEffect(() => {
        if (!isOpen) return;
        listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
    }, [highlight, isOpen]);

    const open = () => {
        if (disabled) return;
        updateCoords();      // measure before paint so the menu appears in the right place immediately
        setIsOpen(true);
    };

    const handleSelect = (newValue: string) => {
        if (disabled) return;
        onChange(newValue);
        setIsOpen(false);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
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
        <div className={`relative ${className}`} ref={containerRef}>
            <button
                type="button"
                className={`
                    w-full flex items-center justify-between gap-3
                    bg-white text-gray-700 font-medium
                    py-2.5 px-4 transition-all duration-200 rounded-xl border
                    ${isOpen ? 'border-blue-400 ring-4 ring-blue-50' : 'border-gray-200 hover:border-gray-300'}
                    ${disabled ? 'opacity-50 cursor-not-allowed bg-gray-50' : 'cursor-pointer'}
                    focus:outline-none
                `}
                onClick={() => isOpen ? setIsOpen(false) : open()}
                onKeyDown={onKeyDown}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                disabled={disabled}
            >
                <span className="truncate">{selectedLabel}</span>
                <i className={`fa-solid fa-chevron-down text-xs text-gray-400 transition-transform duration-200 ${isOpen ? 'rotate-180 text-blue-500' : ''}`}></i>
            </button>

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
                    className="bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden animate-in fade-in duration-150"
                >
                    <div
                        ref={listRef}
                        className="p-1 overflow-y-auto custom-scrollbar"
                        style={{ maxHeight: coords.maxHeight }}
                        role="listbox"
                    >
                        {options.map((option, i) => {
                            const isSelected = option.value === value;
                            const isHighlighted = i === highlight;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    data-idx={i}
                                    onMouseEnter={() => setHighlight(i)}
                                    className={`
                                        w-full flex items-center justify-between px-3 py-2.5 text-sm rounded-lg transition-colors mb-0.5
                                        ${isSelected
                                            ? 'bg-blue-50 text-blue-600 font-bold'
                                            : isHighlighted
                                                ? 'bg-gray-50 text-gray-900'
                                                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}
                                    `}
                                    onClick={() => handleSelect(option.value)}
                                >
                                    <span>{option.label}</span>
                                    {isSelected && <i className="fa-solid fa-check text-blue-500 text-xs"></i>}
                                </button>
                            );
                        })}
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}

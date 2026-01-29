import React, { useState, useRef, useEffect } from 'react';

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

export function Select({ value, onChange, options, disabled, className }: SelectProps) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const selectedLabel = options.find(o => o.value === value)?.label || value;

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleSelect = (newValue: string) => {
        if (disabled) return;
        onChange(newValue);
        setIsOpen(false);
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
                onClick={() => !disabled && setIsOpen(!isOpen)}
            >
                <span className="truncate">{selectedLabel}</span>
                <i className={`fa-solid fa-chevron-down text-xs text-gray-400 transition-transform duration-200 ${isOpen ? 'rotate-180 text-blue-500' : ''}`}></i>
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="p-1 max-h-60 overflow-y-auto custom-scrollbar">
                        {options.map((option) => {
                            const isSelected = option.value === value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    className={`
                                        w-full flex items-center justify-between px-3 py-2.5 text-sm rounded-lg transition-colors mb-0.5
                                        ${isSelected
                                            ? 'bg-blue-50 text-blue-600 font-bold'
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
                </div>
            )}
        </div>
    );
}

import React, { useState, useRef, useEffect } from 'react';

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
    const containerRef = useRef<HTMLDivElement>(null);

    // Get current label
    const selectedOption = options.find(opt => String(opt.value) === String(value));
    const displayLabel = selectedOption ? selectedOption.label : placeholder;

    // Handle outside click
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const handleToggle = () => {
        if (!disabled) setIsOpen(!isOpen);
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

    return (
        <div className={`space-y-2 ${containerClassName}`} ref={containerRef} {...props}>
            {label && (
                <label className="text-sm font-bold text-gray-700 flex items-center gap-2">
                    {icon && <i className={`${icon} text-blue-500/70`}></i>}
                    {label}
                </label>
            )}

            <div className="relative">
                {/* Trigger Button */}
                <button
                    type="button"
                    onClick={handleToggle}
                    disabled={disabled}
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

                {/* Dropdown Menu */}
                <div
                    className={`
                        absolute z-[100] mt-2 w-full bg-white/95 backdrop-blur-xl border border-gray-100 shadow-2xl rounded-2xl overflow-hidden
                        transition-all duration-200 origin-top
                        ${isOpen
                            ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto'
                            : 'opacity-0 -translate-y-2 scale-95 pointer-events-none'}
                    `}
                >
                    <div className="py-1 max-h-60 overflow-y-auto custom-scrollbar">
                        {options.length === 0 ? (
                            <div className="px-4 py-3 text-sm text-gray-400 italic">No options available</div>
                        ) : (
                            options.map((opt) => {
                                const isSelected = String(opt.value) === String(value);
                                return (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        onClick={() => handleSelect(opt.value)}
                                        className={`
                                                w-full text-left px-4 py-2.5 text-sm transition-all duration-200 flex items-center justify-between
                                                ${isSelected
                                                ? 'bg-blue-50 text-blue-700 font-bold'
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
                </div>
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

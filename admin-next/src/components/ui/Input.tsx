"use client";

import React from "react";

type InputSize = "sm" | "md" | "lg";

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
    label?: string;
    icon?: string;
    error?: string;
    size?: InputSize;
}

const sizeClasses: Record<InputSize, string> = {
    sm: "px-3 py-2 text-sm rounded-xl",
    md: "px-4 py-3 text-sm rounded-xl",
    lg: "px-4 py-4 text-base rounded-2xl",
};

/**
 * Input - Premium input component with consistent styling
 * Standard design tokens for all form inputs
 */
export function Input({
    label,
    icon,
    error,
    size = "lg",
    className = "",
    ...props
}: InputProps) {
    const baseClasses = `
        w-full bg-gray-50/50 border-2 border-gray-100 
        focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white 
        transition-all outline-none font-medium
        placeholder:text-gray-400 placeholder:font-normal
    `;

    const errorClasses = error
        ? "border-red-300 focus:border-red-500 focus:ring-red-100"
        : "";

    return (
        <div className="w-full">
            {label && (
                <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                    {label}
                </label>
            )}
            <div className="relative">
                {icon && (
                    <i className={`fa-solid ${icon} absolute left-4 top-1/2 -translate-y-1/2 text-gray-400`}></i>
                )}
                <input
                    className={`
                        ${baseClasses} 
                        ${sizeClasses[size]} 
                        ${icon ? "pl-12" : ""} 
                        ${errorClasses}
                        ${className}
                    `}
                    {...props}
                />
            </div>
            {error && (
                <p className="mt-1 text-xs text-red-500 font-medium">{error}</p>
            )}
        </div>
    );
}

export default Input;

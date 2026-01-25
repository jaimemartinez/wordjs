"use client";

import React from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "outline";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: string;
    iconPosition?: "left" | "right";
    loading?: boolean;
    children?: React.ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
    primary:
        "bg-gray-900 text-white hover:bg-blue-600 shadow-xl shadow-gray-200 hover:shadow-blue-500/30 transform hover:-translate-y-1",
    secondary:
        "bg-white border-2 border-gray-100 text-gray-600 hover:border-blue-500 hover:text-blue-600 shadow-sm",
    danger:
        "bg-red-50 text-red-600 hover:bg-red-600 hover:text-white shadow-sm hover:shadow-red-200",
    ghost:
        "text-gray-400 hover:text-gray-600 hover:bg-gray-100",
    outline:
        "bg-transparent border-2 border-gray-200 text-gray-600 hover:border-gray-400 hover:text-gray-900",
};

const sizeClasses: Record<ButtonSize, string> = {
    sm: "px-4 py-2 text-[10px] rounded-xl gap-2",
    md: "px-6 py-3 text-[10px] rounded-xl gap-2",
    lg: "px-8 py-4 text-[10px] rounded-2xl gap-3",
};

/**
 * Button - Premium button component with multiple variants
 * Matches the visual identity of conference-manager/db-migration plugins
 */
export function Button({
    variant = "primary",
    size = "lg",
    icon,
    iconPosition = "left",
    loading = false,
    children,
    className = "",
    disabled,
    ...props
}: ButtonProps) {
    const baseClasses =
        "font-black uppercase tracking-widest transition-all duration-300 active:scale-95 flex items-center justify-center";

    const iconElement = loading ? (
        <i className="fa-solid fa-spinner fa-spin text-[8px]"></i>
    ) : icon ? (
        <i className={`fa-solid ${icon} text-[8px]`}></i>
    ) : null;

    return (
        <button
            className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className} ${disabled || loading ? "opacity-50 cursor-not-allowed" : ""
                }`}
            disabled={disabled || loading}
            {...props}
        >
            {iconPosition === "left" && iconElement}
            {children && <span>{children}</span>}
            {iconPosition === "right" && iconElement}
        </button>
    );
}

export default Button;

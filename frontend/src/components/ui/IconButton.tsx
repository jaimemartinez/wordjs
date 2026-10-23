"use client";

import React, { forwardRef } from "react";

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
    /** Font Awesome icon class, e.g. "fa-trash". */
    icon: string;
    /** REQUIRED: the accessible name (aria-label) and the tooltip. An icon alone says nothing to a screen reader. */
    label: string;
    variant?: "ghost" | "secondary" | "danger";
    size?: "sm" | "md";
    pending?: boolean;
}

const variants = {
    ghost: "text-gray-600 hover:text-gray-900 hover:bg-gray-100",
    secondary: "bg-white border-2 border-gray-200 text-gray-600 hover:border-blue-500 hover:text-blue-600",
    danger: "text-red-600 hover:bg-red-50 hover:text-red-700",
};

/** IconButton — an icon-only action whose name is required by its type (`label`). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
    { icon, label, variant = "ghost", size = "md", pending, className = "", type, disabled, title, ...props },
    ref,
) {
    const box = size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";
    return (
        <button
            ref={ref}
            type={type ?? "button"}
            aria-label={label}
            title={title ?? label}
            disabled={disabled || pending}
            aria-busy={pending || undefined}
            className={`inline-flex ${box} shrink-0 items-center justify-center rounded-xl transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11 ` +
                `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
            {...props}
        >
            <i className={`fa-solid ${pending ? "fa-spinner fa-spin" : icon}`} aria-hidden="true"></i>
        </button>
    );
});

export default IconButton;

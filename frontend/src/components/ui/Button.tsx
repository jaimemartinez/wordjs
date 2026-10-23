"use client";

import React, { forwardRef } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "outline" | "link";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: string;
    iconPosition?: "left" | "right";
    /**
     * The action is running: spinner, aria-busy, disabled until it ends. With `pendingLabel` the text
     * changes too ("Saving…"), so the button says what it is doing.
     */
    pending?: boolean;
    pendingLabel?: React.ReactNode;
    /** @deprecated use `pending` — kept for the screens that pass `loading`. */
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
    // gray-600, not gray-400: the quiet variant still has to be readable (gray-400 on white is 2.5:1).
    ghost:
        "text-gray-600 hover:text-gray-900 hover:bg-gray-100",
    outline:
        "bg-transparent border-2 border-gray-200 text-gray-600 hover:border-gray-400 hover:text-gray-900",
    // Text-only action in a sentence or a card footer: blue-700 on white is 6.7:1, underlined on hover.
    link:
        "text-blue-700 hover:text-blue-900 hover:underline underline-offset-2",
};

const sizeClasses: Record<ButtonSize, string> = {
    sm: "px-4 py-2 text-[11px] rounded-xl gap-2 pointer-coarse:min-h-11",
    md: "px-6 py-3 text-[11px] rounded-xl gap-2 pointer-coarse:min-h-11",
    lg: "px-6 sm:px-8 py-4 text-[11px] rounded-2xl gap-3",
};

const LINK_SIZE = "px-1 py-0.5 text-sm rounded gap-1.5";

/** The visual classes of a Button, for the few elements that must look like one (ButtonLink). */
export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "lg", inactive = false) {
    const base = variant === "link"
        ? "font-semibold transition-colors inline-flex items-center"
        : "font-black uppercase tracking-widest transition-all duration-300 active:scale-95 flex items-center justify-center";
    return `${base} ${variantClasses[variant]} ${variant === "link" ? LINK_SIZE : sizeClasses[size]} ` +
        `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${inactive ? "opacity-50 cursor-not-allowed" : ""}`;
}

/**
 * Button — every action button of the admin (components/ui). Defaults to type="button": a form's submit
 * is always explicit (`type="submit"`), so a button added inside a form can never submit it by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
    variant = "primary",
    size = "lg",
    icon,
    iconPosition = "left",
    pending,
    pendingLabel,
    loading = false,
    children,
    className = "",
    disabled,
    type,
    ...props
}, ref) {
    const busy = !!pending || loading;
    // Icon-only buttons have no text label — require an accessible name so screen
    // readers announce something. aria-label / title flow through `props`.
    const isIconOnly = !!icon && !children;
    if (process.env.NODE_ENV !== "production" && isIconOnly && !props["aria-label"] && !props.title) {
        console.warn("Button: icon-only button is missing an accessible name — pass `aria-label` (or `title`). IconButton requires one.");
    }

    const iconElement = busy ? (
        <i className="fa-solid fa-spinner fa-spin text-[11px]" aria-hidden="true"></i>
    ) : icon ? (
        <i className={`fa-solid ${icon} text-[11px]`} aria-hidden="true"></i>
    ) : null;
    const text = busy && pendingLabel ? pendingLabel : children;

    return (
        <button
            ref={ref}
            type={type ?? "button"}
            className={`${buttonClasses(variant, size, disabled || busy)} ${className}`}
            disabled={disabled || busy}
            aria-busy={busy || undefined}
            {...props}
        >
            {iconPosition === "left" && iconElement}
            {text && <span>{text}</span>}
            {iconPosition === "right" && iconElement}
        </button>
    );
});

export default Button;

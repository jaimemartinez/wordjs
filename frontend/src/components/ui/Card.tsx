"use client";

import React from "react";

type CardVariant = "default" | "glass" | "dark" | "accent";
type AccentColor = "blue" | "green" | "red" | "orange" | "purple" | "indigo";

interface CardProps {
    children: React.ReactNode;
    variant?: CardVariant;
    color?: AccentColor;
    className?: string;
    hoverable?: boolean;
    padding?: "none" | "sm" | "md" | "lg";
    overflow?: "hidden" | "visible";
}

const variantClasses: Record<CardVariant, string> = {
    default: "bg-white border border-gray-100 shadow-xl",
    glass: "bg-white/80 backdrop-blur-xl border border-white/60 shadow-xl",
    dark: "bg-gradient-to-br from-gray-900 to-gray-800 text-white shadow-xl",
    accent: "", // handled dynamically with color
};

const accentColorClasses: Record<AccentColor, string> = {
    blue: "bg-blue-50/50 border border-blue-100",
    green: "bg-emerald-50/50 border border-emerald-100",
    red: "bg-red-50/50 border border-red-100",
    orange: "bg-orange-50/50 border border-orange-100",
    purple: "bg-purple-50/50 border border-purple-100",
    indigo: "bg-indigo-50/50 border border-indigo-100",
};

const paddingClasses = {
    none: "",
    sm: "p-4",
    md: "p-6",
    lg: "p-8",
};

/**
 * Card - Premium card component with multiple variants
 * Matches the visual identity of conference-manager/db-migration plugins
 */
export function Card({
    children,
    variant = "default",
    color = "blue",
    className = "",
    hoverable = false,
    padding = "lg",
    overflow = "hidden",
}: CardProps) {
    const baseClasses = `rounded-[40px] relative ${overflow === "hidden" ? "overflow-hidden" : "overflow-visible"}`;
    const variantClass = variant === "accent" ? accentColorClasses[color] : variantClasses[variant];
    const hoverClasses = hoverable
        ? "hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 cursor-pointer"
        : "";

    return (
        <div className={`${baseClasses} ${variantClass} ${paddingClasses[padding]} ${hoverClasses} ${className}`}>
            {children}
        </div>
    );
}

export default Card;

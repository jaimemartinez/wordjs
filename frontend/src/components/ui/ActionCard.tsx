"use client";

import React from "react";

type ActionColor = "blue" | "purple" | "green" | "orange" | "indigo" | "gray";

interface ActionCardProps {
    icon: string;
    title: string;
    description: string;
    onClick?: () => void;
    href?: string;
    color?: ActionColor;
}

const colorClasses: Record<ActionColor, string> = {
    blue: "bg-blue-500",
    purple: "bg-purple-500",
    green: "bg-emerald-500",
    orange: "bg-orange-500",
    indigo: "bg-indigo-500",
    gray: "bg-gray-500",
};

/**
 * ActionCard - Premium quick action card with icon
 * Matches the visual identity of the main dashboard QuickAction
 */
export function ActionCard({ icon, title, description, onClick, href, color = "blue" }: ActionCardProps) {
    const bgColor = colorClasses[color];

    const content = (
        <>
            {/* Icon - solid color background with white icon */}
            <div className={`w-14 h-14 rounded-2xl ${bgColor} flex items-center justify-center text-white text-xl shadow-lg group-hover:scale-110 transition-transform duration-300 flex-shrink-0`}>
                <i className={`fa-solid ${icon}`}></i>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <h4 className="font-black text-lg text-gray-900 group-hover:text-blue-600 transition-colors italic tracking-tight">{title}</h4>
                <p className="text-xs text-gray-400 font-medium mt-0.5 truncate">{description}</p>
            </div>

            {/* Arrow on hover */}
            <div className="opacity-0 group-hover:opacity-100 transition-opacity -translate-x-4 group-hover:translate-x-0 duration-300">
                <i className="fa-solid fa-arrow-right text-blue-400"></i>
            </div>
        </>
    );

    const className = "group relative flex items-center gap-6 p-6 bg-white rounded-[40px] border-2 border-gray-50 hover:border-blue-200 shadow-xl shadow-gray-100/50 hover:shadow-2xl hover:shadow-blue-500/10 hover:-translate-y-1 transition-all duration-500 text-left w-full";

    if (href) {
        return (
            <a href={href} className={className}>
                {content}
            </a>
        );
    }

    return (
        <button onClick={onClick} className={className}>
            {content}
        </button>
    );
}

export default ActionCard;

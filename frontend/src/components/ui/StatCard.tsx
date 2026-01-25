"use client";

import React from "react";

type StatColor = "blue" | "green" | "red" | "orange" | "purple" | "indigo" | "gray";

interface StatCardProps {
    icon: string;
    value: number | string;
    label: string;
    color?: StatColor;
    trend?: {
        value: number;
        isPositive: boolean;
    };
    onClick?: () => void;
}

const colorClasses: Record<StatColor, { bg: string; text: string; shadow: string }> = {
    blue: { bg: "bg-blue-50", text: "text-blue-600", shadow: "shadow-blue-100" },
    green: { bg: "bg-emerald-50", text: "text-emerald-600", shadow: "shadow-emerald-100" },
    red: { bg: "bg-red-50", text: "text-red-600", shadow: "shadow-red-100" },
    orange: { bg: "bg-orange-50", text: "text-orange-600", shadow: "shadow-orange-100" },
    purple: { bg: "bg-purple-50", text: "text-purple-600", shadow: "shadow-purple-100" },
    indigo: { bg: "bg-indigo-50", text: "text-indigo-600", shadow: "shadow-indigo-100" },
    gray: { bg: "bg-gray-50", text: "text-gray-600", shadow: "shadow-gray-100" },
};

/**
 * StatCard - Premium statistics card with icon and value
 * Matches the visual identity of conference-manager dashboard
 */
export function StatCard({ icon, value, label, color = "blue", trend, onClick }: StatCardProps) {
    const colors = colorClasses[color];
    const isClickable = !!onClick;

    return (
        <div
            className={`bg-white rounded-[40px] p-6 border border-gray-100 shadow-xl shadow-gray-100/50 group overflow-hidden relative ${isClickable
                ? "cursor-pointer hover:shadow-2xl hover:-translate-y-1 transition-all duration-300"
                : ""
                }`}
            onClick={onClick}
        >
            {/* Decorative background */}
            <div
                className={`absolute -right-6 -bottom-6 w-24 h-24 ${colors.bg} rounded-full opacity-50 group-hover:scale-150 transition-transform duration-500`}
            ></div>

            <div className="flex items-center gap-5 relative z-10">
                <div
                    className={`w-14 h-14 rounded-2xl ${colors.bg} ${colors.text} flex items-center justify-center text-2xl shadow-lg ${colors.shadow} group-hover:scale-110 transition-transform duration-300`}
                >
                    <i className={`fa-solid ${icon}`}></i>
                </div>
                <div className="flex-1">
                    <div className="flex items-end gap-2">
                        <span className="text-3xl font-black text-gray-900 italic tracking-tighter leading-none">
                            {typeof value === "number" ? value.toLocaleString() : value}
                        </span>
                        {trend && (
                            <span
                                className={`text-xs font-bold ${trend.isPositive ? "text-emerald-500" : "text-red-500"
                                    }`}
                            >
                                {trend.isPositive ? "+" : "-"}
                                {Math.abs(trend.value)}%
                            </span>
                        )}
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400 mt-1 block">
                        {label}
                    </span>
                </div>
            </div>
        </div>
    );
}

export default StatCard;

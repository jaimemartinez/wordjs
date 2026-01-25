"use client";

import React from "react";

type StatusType = "success" | "warning" | "error" | "info" | "neutral";
type BadgeSize = "sm" | "md" | "lg";

interface StatusBadgeProps {
    status: StatusType | string;
    label?: string;
    size?: BadgeSize;
    pulse?: boolean;
}

const statusColors: Record<StatusType, { bg: string; text: string; dot: string }> = {
    success: { bg: "bg-emerald-50", text: "text-emerald-600", dot: "bg-emerald-500" },
    warning: { bg: "bg-amber-50", text: "text-amber-600", dot: "bg-amber-500" },
    error: { bg: "bg-red-50", text: "text-red-600", dot: "bg-red-500" },
    info: { bg: "bg-blue-50", text: "text-blue-600", dot: "bg-blue-500" },
    neutral: { bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400" },
};

// Common status mappings
const statusMap: Record<string, StatusType> = {
    paid: "success",
    active: "success",
    completed: "success",
    published: "success",
    pending: "warning",
    partial: "warning",
    draft: "warning",
    unpaid: "error",
    error: "error",
    failed: "error",
    deleted: "error",
    inactive: "neutral",
    unknown: "neutral",
};

const sizeClasses: Record<BadgeSize, { container: string; dot: string; text: string }> = {
    sm: { container: "px-2 py-0.5 gap-1", dot: "w-1.5 h-1.5", text: "text-[8px]" },
    md: { container: "px-3 py-1 gap-1.5", dot: "w-2 h-2", text: "text-[10px]" },
    lg: { container: "px-4 py-1.5 gap-2", dot: "w-2.5 h-2.5", text: "text-xs" },
};

/**
 * StatusBadge - Premium status indicator badge
 * Supports predefined statuses (paid, pending, etc) or custom status types
 */
export function StatusBadge({ status, label, size = "md", pulse = false }: StatusBadgeProps) {
    const statusType: StatusType = statusMap[status.toLowerCase()] || "neutral";
    const colors = statusColors[statusType];
    const sizes = sizeClasses[size];
    const displayLabel = label || status;

    return (
        <span
            className={`inline-flex items-center ${sizes.container} ${colors.bg} rounded-full font-black uppercase tracking-widest`}
        >
            <span className="relative flex items-center justify-center">
                <span className={`${sizes.dot} ${colors.dot} rounded-full`}></span>
                {pulse && (
                    <span
                        className={`absolute ${sizes.dot} ${colors.dot} rounded-full animate-ping opacity-75`}
                    ></span>
                )}
            </span>
            <span className={`${sizes.text} ${colors.text}`}>{displayLabel}</span>
        </span>
    );
}

export default StatusBadge;

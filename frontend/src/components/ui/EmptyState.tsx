"use client";

import React from "react";

interface EmptyStateProps {
    icon?: string;
    title: string;
    description?: string;
    action?: React.ReactNode;
}

/**
 * EmptyState - Premium empty state placeholder
 * Used when there's no data to display
 */
export function EmptyState({ icon = "fa-inbox", title, description, action }: EmptyStateProps) {
    return (
        <div className="flex flex-col items-center justify-center py-12 md:py-20 px-4 text-center animate-in fade-in zoom-in-95 duration-500">
            <div aria-hidden="true" className="w-20 h-20 md:w-24 md:h-24 shrink-0 bg-gray-50 rounded-[32px] md:rounded-[40px] flex items-center justify-center mb-6 shadow-inner">
                <i className={`fa-solid ${icon} text-4xl text-gray-300`}></i>
            </div>
            <h3 className="text-xl md:text-2xl font-black text-gray-900 italic tracking-tighter mb-2 break-words">{title}</h3>
            {description && (
                <p className="text-gray-500 font-medium max-w-sm mx-auto leading-relaxed">{description}</p>
            )}
            {action && <div className="mt-8">{action}</div>}
        </div>
    );
}

export default EmptyState;

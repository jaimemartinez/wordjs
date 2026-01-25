"use client";

import React from "react";

interface PageHeaderProps {
    title: string;
    subtitle?: string;
    icon?: string;
    actions?: React.ReactNode;
    backButton?: {
        label?: string;
        onClick: () => void;
    };
}

/**
 * PageHeader - Premium page header with consistent styling
 * Matches the visual identity of conference-manager/db-migration plugins
 */
export function PageHeader({ title, subtitle, icon, actions, backButton }: PageHeaderProps) {
    return (
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12 flex-shrink-0">
            <div>
                {backButton && (
                    <button
                        onClick={backButton.onClick}
                        className="flex items-center gap-2 text-gray-400 hover:text-gray-600 transition-colors mb-4 group"
                    >
                        <i className="fa-solid fa-arrow-left group-hover:-translate-x-1 transition-transform"></i>
                        <span className="text-sm font-medium">{backButton.label || "Volver"}</span>
                    </button>
                )}
                <div className="flex items-center gap-4">
                    {icon && (
                        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 text-blue-600 flex items-center justify-center text-2xl shadow-inner">
                            <i className={`fa-solid ${icon}`}></i>
                        </div>
                    )}
                    <div>
                        <h1 className="text-4xl md:text-5xl font-black text-gray-900 italic tracking-tighter">
                            {title}
                        </h1>
                        {subtitle && (
                            <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                                {subtitle}
                            </p>
                        )}
                    </div>
                </div>
            </div>
            {actions && <div className="flex flex-wrap gap-4">{actions}</div>}
        </div>
    );
}

export default PageHeader;

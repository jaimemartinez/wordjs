"use client";

import React from "react";
import { useI18n } from "@/contexts/I18nContext";

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
    const { t } = useI18n();
    return (
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 md:gap-6 mb-8 md:mb-12 flex-shrink-0">
            <div className="min-w-0">
                {backButton && (
                    <button
                        onClick={backButton.onClick}
                        type="button"
                        className="flex items-center gap-2 min-h-11 text-gray-500 hover:text-gray-700 transition-colors mb-2 md:mb-4 group"
                    >
                        <i className="fa-solid fa-arrow-left group-hover:-translate-x-1 transition-transform"></i>
                        <span className="text-sm font-medium">{backButton.label || t('common.back')}</span>
                    </button>
                )}
                <div className="flex items-start sm:items-center gap-3 md:gap-4 min-w-0">
                    {icon && (
                        <div aria-hidden="true" className="w-11 h-11 md:w-14 md:h-14 text-xl md:text-2xl shrink-0 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 text-blue-600 flex items-center justify-center shadow-inner">
                            <i className={`fa-solid ${icon}`}></i>
                        </div>
                    )}
                    <div className="min-w-0">
                        <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-gray-900 italic tracking-tighter break-words">
                            {title}
                        </h1>
                        {subtitle && (
                            <p className="text-xs font-bold uppercase tracking-wide sm:tracking-widest text-gray-500 mt-1 break-words">
                                {subtitle}
                            </p>
                        )}
                    </div>
                </div>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-3 md:gap-4 min-w-0">{actions}</div>}
        </div>
    );
}

export default PageHeader;

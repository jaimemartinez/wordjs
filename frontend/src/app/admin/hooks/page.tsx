"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import LiveTimeline from "./LiveTimeline";

type HookHandler = {
    priority: number;
    pluginSlug: string;
    callback: string;
};

type HookRegistry = {
    actions: Record<string, HookHandler[]>;
    filters: Record<string, HookHandler[]>;
};

// Hook names that have a friendly localized title (i18n key: hooks.admin.title.<name>)
const HOOK_TITLE_KEYS: string[] = [
    'init',
    'rest_api_init',
    'send_headers',
    'admin_menu',
    'wp_insert_post',
    'post_updated',
    'deleted_post',
    'the_content',
    'registered_post_type',
    'wp_insert_comment',
    'deleted_comment',
    'user_registered',
    'login_failed',
    'activated_plugin',
    'deactivated_plugin',
    'updated_option',
    'switch_theme',
    'wordjs_scheduled_backup',
    'notification_sent',
    'wordjs_head',
    'wordjs_footer',
    'dynamic_sidebar',
    'admin_menu_items'
];

// Hook names that have a localized description (i18n key: hooks.admin.desc.<name>)
const HOOK_DESC_KEYS: string[] = [
    // Core Lifecycle
    'init',
    'rest_api_init',
    'send_headers',
    'admin_menu',
    'admin_menu_items',

    // Content (Posts/Pages)
    'wp_insert_post',
    'post_updated',
    'deleted_post',
    'the_content',
    'registered_post_type',

    // Comments
    'wp_insert_comment',
    'deleted_comment',

    // Users & Auth
    'user_registered',
    'login_failed',

    // System & Plugins
    'activated_plugin',
    'deactivated_plugin',
    'updated_option',
    'switch_theme',
    'wordjs_scheduled_backup',
    'notification_sent',

    // Frontend Rendering
    'wordjs_head',
    'wordjs_footer',
    'dynamic_sidebar'
];

export default function HooksPage() {
    const { t } = useI18n();
    const hookTitle = (name: string): string | null =>
        HOOK_TITLE_KEYS.includes(name) ? t(`hooks.admin.title.${name}`) : null;
    const hookDesc = (name: string): string | null =>
        HOOK_DESC_KEYS.includes(name) ? t(`hooks.admin.desc.${name}`) : null;
    const [hooks, setHooks] = useState<HookRegistry | null>(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<'actions' | 'filters' | 'live'>('actions');
    const [search, setSearch] = useState("");
    const [showDict, setShowDict] = useState(false);

    const loadHooks = async () => {
        setLoading(true);
        try {
            const data = await api('/hooks') as HookRegistry;
            setHooks(data);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadHooks();
    }, []);

    const filterHooks = (registry: Record<string, HookHandler[]>) => {
        if (!search) return registry;
        const result: Record<string, HookHandler[]> = {};
        for (const [key, handlers] of Object.entries(registry)) {
            if (key.toLowerCase().includes(search.toLowerCase())) {
                result[key] = handlers;
            } else {
                // Check handlers
                const matchingHandlers = handlers.filter(h =>
                    h.pluginSlug.toLowerCase().includes(search.toLowerCase()) ||
                    h.callback.toLowerCase().includes(search.toLowerCase())
                );
                if (matchingHandlers.length > 0) {
                    result[key] = handlers;
                }
            }
        }
        return result;
    };

    const currentData = hooks ? (activeTab === 'actions' ? hooks.actions : hooks.filters) : {};
    const filteredData = filterHooks(currentData);
    const hookNames = Object.keys(filteredData).sort();

    return (
        <div className="px-4 py-6 sm:p-8 max-w-7xl mx-auto h-full w-full overflow-y-auto">
            <div className="flex flex-wrap justify-between items-center gap-4 mb-8">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-bold text-slate-800 flex items-center gap-3">
                        <i className="fa-solid fa-microscope text-indigo-600"></i>
                        {t('hooks.admin.title')}
                    </h1>
                    <p className="text-slate-500 mt-2">{t('hooks.admin.subtitle')}</p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setShowDict(!showDict)}
                        className={`h-10 px-4 rounded-full border flex items-center gap-2 transition-all font-bold text-xs uppercase tracking-wide ${showDict ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'}`}
                    >
                        <i className="fa-solid fa-book"></i>
                        {t('hooks.admin.dictionary')}
                    </button>
                    <button
                        onClick={loadHooks}
                        className="w-11 h-11 shrink-0 rounded-full bg-white border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-200 flex items-center justify-center transition-all"
                        title={t('hooks.admin.refreshRegistry')}
                    >
                        <i className={`fa-solid fa-rotate-right ${loading ? 'fa-spin' : ''}`}></i>
                    </button>
                </div>
            </div>

            {/* Dictionary Reference */}
            {showDict && (
                <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 mb-8 animate-in slide-in-from-top-4 fade-in duration-300">
                    <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
                        <i className="fa-solid fa-book-open text-indigo-500"></i>
                        {t('hooks.admin.coreHookReference')}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {HOOK_DESC_KEYS.map((key) => (
                            <div key={key} className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex flex-col h-full">
                                <div className="flex items-center gap-2 mb-2 flex-wrap">
                                    <span className="font-bold text-slate-700 text-sm">
                                        {hookTitle(key) || key}
                                    </span>
                                    {hookTitle(key) && (
                                        <code className="text-[11px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100 select-all">
                                            {key}
                                        </code>
                                    )}
                                </div>
                                <p className="text-xs text-slate-500 leading-relaxed font-medium">{hookDesc(key)}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Controls */}
            <div className="bg-white rounded-2xl p-3 sm:p-4 shadow-sm border border-slate-100 mb-8 flex flex-col md:flex-row gap-4 justify-between items-stretch md:items-center sticky top-0 sm:top-4 z-10 w-full">
                <div role="group" className="flex flex-wrap p-1 bg-slate-100 rounded-xl max-w-full">
                    <button
                        type="button"
                        aria-pressed={activeTab === 'actions'}
                        onClick={() => setActiveTab('actions')}
                        className={`flex-1 md:flex-none min-h-11 px-4 sm:px-6 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'actions' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        {t('hooks.admin.tabActions')}
                    </button>
                    <button
                        type="button"
                        aria-pressed={activeTab === 'filters'}
                        onClick={() => setActiveTab('filters')}
                        className={`flex-1 md:flex-none min-h-11 px-4 sm:px-6 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'filters' ? 'bg-white text-pink-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        {t('hooks.admin.tabFilters')}
                    </button>
                    <button
                        type="button"
                        aria-pressed={activeTab === 'live'}
                        onClick={() => setActiveTab('live')}
                        className={`flex-1 md:flex-none min-h-11 px-4 sm:px-6 py-2 rounded-lg text-sm font-bold transition-all flex items-center justify-center gap-2 ${activeTab === 'live' ? 'bg-slate-900 text-emerald-400 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        <i className={`fa-solid fa-satellite-dish ${activeTab === 'live' ? 'animate-pulse' : ''}`}></i>
                        {t('hooks.admin.tabLive')}
                    </button>
                </div>

                <div className="relative w-full md:w-96">
                    <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i>
                    <input
                        type="text"
                        placeholder={t('hooks.admin.searchPlaceholder')}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                        disabled={activeTab === 'live'}
                    />
                </div>
            </div>

            {/* Content Switcher */}
            {activeTab === 'live' ? (
                <LiveTimeline />
            ) : (
                /* List */
                loading ? (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400 space-y-4">
                        <i className="fa-solid fa-circle-notch fa-spin text-4xl text-indigo-200"></i>
                        <p className="font-medium animate-pulse">{t('hooks.admin.scanning')}</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {hookNames.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 px-4 text-center border-2 border-dashed border-slate-100 rounded-2xl bg-slate-50/50">
                                <div className="w-12 h-12 shrink-0 bg-slate-100 rounded-full flex items-center justify-center mb-4 text-slate-300 text-xl">
                                    <i className={`fa-solid ${activeTab === 'actions' ? 'fa-bolt' : 'fa-filter'}`}></i>
                                </div>
                                <h3 className="text-slate-900 font-bold text-lg mb-1">
                                    {activeTab === 'actions' ? t('hooks.admin.emptyTitleActions') : t('hooks.admin.emptyTitleFilters')}
                                </h3>
                                <p className="text-slate-500 max-w-sm text-sm">
                                    {search
                                        ? (activeTab === 'actions'
                                            ? t('hooks.admin.emptySearchActions').replace('{query}', search)
                                            : t('hooks.admin.emptySearchFilters').replace('{query}', search))
                                        : (activeTab === 'actions'
                                            ? t('hooks.admin.emptyNoneActions')
                                            : t('hooks.admin.emptyNoneFilters'))}
                                </p>
                                {search && (
                                    <button
                                        onClick={() => setSearch('')}
                                        className="mt-4 text-indigo-600 text-sm font-bold hover:underline"
                                    >
                                        {t('hooks.admin.clearSearch')}
                                    </button>
                                )}
                            </div>
                        ) : (
                            hookNames.map(hookName => (
                                <div key={hookName} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden group hover:shadow-md transition-all duration-300">
                                    {/* Header */}
                                    <div className="px-4 sm:px-6 py-4 bg-slate-50/50 border-b border-slate-100 flex flex-wrap justify-between items-start sm:items-center gap-3 group/header hover:bg-slate-100 transition-colors cursor-default">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                                <span className="font-bold text-slate-800 text-base sm:text-lg break-words">
                                                    {hookTitle(hookName) || hookName}
                                                </span>
                                                {/* Show technical key if we have a friendly title, otherwise it's redundant */}
                                                {hookTitle(hookName) && (
                                                    <code className="text-[11px] font-mono font-bold text-slate-500 bg-slate-200/60 px-2 py-0.5 rounded border border-slate-300/50 select-all break-all">
                                                        {hookName}
                                                    </code>
                                                )}
                                            </div>

                                            {hookDesc(hookName) ? (
                                                <span className="text-xs text-slate-500 font-medium mt-1 block leading-relaxed max-w-2xl">
                                                    {hookDesc(hookName)}
                                                </span>
                                            ) : (
                                                !hookTitle(hookName) && <span className="text-xs text-slate-400 italic mt-1 block">{t('hooks.admin.customHook')}</span>
                                            )}
                                        </div>
                                        <span className={`shrink-0 text-[11px] font-bold px-3 py-1.5 rounded-full uppercase tracking-wider border ${activeTab === 'actions' ? 'bg-indigo-50 text-indigo-700 border-indigo-100' : 'bg-pink-50 text-pink-700 border-pink-100'}`}>
                                            {filteredData[hookName].length} {t('hooks.admin.handlers')}
                                        </span>
                                    </div>

                                    {/* Handlers Table */}
                                    <div className="divide-y divide-slate-50">
                                        {filteredData[hookName].map((handler, idx) => (
                                            <div key={idx} className="px-4 sm:px-6 py-3 flex items-center gap-3 sm:gap-4 hover:bg-slate-50 transition-colors">
                                                <div className="w-12 flex-shrink-0 flex flex-col items-center justify-center group/prio relative cursor-help" title={t('hooks.admin.prioTooltip')}>
                                                    <span className="text-[11px] font-bold text-slate-400 uppercase">{t('hooks.admin.prio')}</span>
                                                    <span className="text-lg font-black text-slate-700 leading-none">{handler.priority}</span>

                                                    {/* Tooltip */}
                                                    <div aria-hidden="true" className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-32 p-2 bg-slate-800 text-white text-[11px] rounded-lg opacity-0 group-hover/prio:opacity-100 transition-opacity pointer-events-none z-10 text-center font-medium">
                                                        {t('hooks.admin.prioTooltip')}
                                                    </div>
                                                </div>

                                                <div className="w-px h-8 bg-slate-100"></div>

                                                <div className="flex-1 min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2 mb-1">
                                                        <span className={`px-1.5 py-0.5 rounded text-[11px] font-bold uppercase ${handler.pluginSlug === 'core' ? 'bg-slate-100 text-slate-600' : 'bg-emerald-100 text-emerald-600'}`}>
                                                            {handler.pluginSlug === 'core' ? t('hooks.admin.badgeCore') : t('hooks.admin.badgePlugin')}
                                                        </span>
                                                        <span className="text-xs font-bold text-slate-500 truncate lowercase opacity-75">
                                                            {handler.pluginSlug}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        {handler.callback.startsWith('Anonymous:') ? (
                                                            <details className="group/code min-w-0 max-w-full">
                                                                <summary className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-100 border border-slate-200 text-[11px] font-bold text-slate-500 uppercase tracking-wide cursor-pointer hover:bg-slate-200 hover:text-slate-700 transition-colors list-none [&::-webkit-details-marker]:hidden">
                                                                    <i className="fa-solid fa-code" aria-hidden="true"></i>
                                                                    {t('hooks.admin.inlineLogic')}
                                                                    <i className="fa-solid fa-chevron-down text-[10px] group-open/code:rotate-180 transition-transform" aria-hidden="true"></i>
                                                                </summary>
                                                                <div className="mt-2 p-3 bg-slate-800 text-slate-300 text-[11px] font-mono rounded-xl shadow-xl break-all leading-relaxed whitespace-pre-wrap border border-slate-700">
                                                                    <div className="text-white font-bold mb-1 border-b border-slate-700 pb-1">{t('hooks.admin.sourcePreview')}</div>
                                                                    {handler.callback.replace('Anonymous: ', '')}
                                                                </div>
                                                            </details>
                                                        ) : (
                                                            <code className="text-xs font-mono text-indigo-600 font-bold bg-indigo-50 px-2 py-1 rounded truncate block hover:bg-indigo-100 transition-colors cursor-text select-all" title={t('hooks.admin.functionName')}>
                                                                {handler.callback}
                                                            </code>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                )
            )}
        </div>
    );
}

"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
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

const HOOK_TITLES: Record<string, string> = {
    'init': 'System Initialization',
    'rest_api_init': 'REST API Setup',
    'send_headers': 'HTTP Headers',
    'admin_menu': 'Admin Sidebar',
    'wp_insert_post': 'Post Created/Updated',
    'post_updated': 'Post Edited',
    'deleted_post': 'Post Deleted',
    'the_content': 'Content Renderer',
    'registered_post_type': 'Post Type Registration',
    'wp_insert_comment': 'New Comment',
    'deleted_comment': 'Comment Deleted',
    'user_registered': 'User Registration',
    'login_failed': 'Login Failed',
    'activated_plugin': 'Plugin Activation',
    'deactivated_plugin': 'Plugin Deactivation',
    'updated_option': 'Settings Update',
    'switch_theme': 'Theme Switch',
    'wordjs_scheduled_backup': 'System Backup',
    'notification_sent': 'Notification Dispatch',
    'wordjs_head': 'Header Scripts',
    'wordjs_footer': 'Footer Scripts',
    'dynamic_sidebar': 'Widget Area',
    'admin_menu_items': 'Admin Menu Filtering'
};

const HOOK_DESCRIPTIONS: Record<string, string> = {
    // Core Lifecycle
    'init': 'Fires after the system has finished loading but before any headers are sent.',
    'rest_api_init': 'Fires when the REST API is initializing. Register custom routes here.',
    'send_headers': 'Last chance to modify HTTP headers before content is sent.',
    'admin_menu': 'Fires when building the Admin Sidebar. Add your menu items here.',
    'admin_menu_items': 'Filters the final list of admin menu items before rendering. Use this to hide/reorder menus dynamically.',

    // Content (Posts/Pages)
    'wp_insert_post': 'Fires immediately after a post is created in the database.',
    'post_updated': 'Fires after an existing post is updated.',
    'deleted_post': 'Fires after a post has been deleted.',
    'the_content': 'Filters the post content before display. Use this to modify text.',
    'registered_post_type': 'Fires after a new Custom Post Type is registered.',

    // Comments
    'wp_insert_comment': 'Fires after a new comment is added.',
    'deleted_comment': 'Fires after a comment is deleted.',

    // Users & Auth
    'user_registered': 'Fires when a new user account is created.',
    'login_failed': 'Fires when an authentication attempt fails.',

    // System & Plugins
    'activated_plugin': 'Fires when a plugin is activated.',
    'deactivated_plugin': 'Fires when a plugin is deactivated.',
    'updated_option': 'Fires after a global setting/option is updated.',
    'switch_theme': 'Fires when the active theme is changed.',
    'wordjs_scheduled_backup': 'Daily system task to back up the database.',
    'notification_sent': 'Fires when a system notification is dispatched to a user.',

    // Frontend Rendering
    'wordjs_head': 'Filters the list of elements in the <head> tag (CSS, Scripts).',
    'wordjs_footer': 'Filters the list of elements in the footer (JS, tracking).',
    'dynamic_sidebar': 'Filters the content of a widget area/sidebar.'
};

export default function HooksPage() {
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
        <div className="p-8 max-w-7xl mx-auto h-full overflow-y-auto">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
                        <i className="fa-solid fa-microscope text-indigo-600"></i>
                        Global Hook Registry
                    </h1>
                    <p className="text-slate-500 mt-2">Inspect all active actions and filters registered by Core and Plugins.</p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setShowDict(!showDict)}
                        className={`h-10 px-4 rounded-full border flex items-center gap-2 transition-all font-bold text-xs uppercase tracking-wide ${showDict ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'}`}
                    >
                        <i className="fa-solid fa-book"></i>
                        Dictionary
                    </button>
                    <button
                        onClick={loadHooks}
                        className="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-200 flex items-center justify-center transition-all"
                        title="Refresh Registry"
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
                        Core Hook Reference
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {Object.entries(HOOK_DESCRIPTIONS).map(([key, desc]) => (
                            <div key={key} className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex flex-col h-full">
                                <div className="flex items-center gap-2 mb-2 flex-wrap">
                                    <span className="font-bold text-slate-700 text-sm">
                                        {HOOK_TITLES[key] || key}
                                    </span>
                                    {HOOK_TITLES[key] && (
                                        <code className="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100 select-all">
                                            {key}
                                        </code>
                                    )}
                                </div>
                                <p className="text-xs text-slate-500 leading-relaxed font-medium">{desc}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Controls */}
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 mb-8 flex flex-col md:flex-row gap-4 justify-between items-center sticky top-4 z-10 w-full">
                <div className="flex p-1 bg-slate-100 rounded-xl">
                    <button
                        onClick={() => setActiveTab('actions')}
                        className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'actions' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        Actions
                    </button>
                    <button
                        onClick={() => setActiveTab('filters')}
                        className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'filters' ? 'bg-white text-pink-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        Filters
                    </button>
                    <button
                        onClick={() => setActiveTab('live')}
                        className={`px-6 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2 ${activeTab === 'live' ? 'bg-slate-900 text-emerald-400 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        <i className={`fa-solid fa-satellite-dish ${activeTab === 'live' ? 'animate-pulse' : ''}`}></i>
                        Live
                    </button>
                </div>

                <div className="relative w-full md:w-96">
                    <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i>
                    <input
                        type="text"
                        placeholder="Search hooks, plugins, or functions..."
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
                        <p className="font-medium animate-pulse">Scanning application hooks...</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {hookNames.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 px-4 text-center border-2 border-dashed border-slate-100 rounded-2xl bg-slate-50/50">
                                <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-4 text-slate-300 text-xl">
                                    <i className={`fa-solid ${activeTab === 'actions' ? 'fa-bolt' : 'fa-filter'}`}></i>
                                </div>
                                <h3 className="text-slate-900 font-bold text-lg mb-1">No {activeTab} found</h3>
                                <p className="text-slate-500 max-w-sm text-sm">
                                    {search
                                        ? `No ${activeTab} match your search query "${search}"`
                                        : `There are currently no active ${activeTab} registered in the system.`}
                                </p>
                                {search && (
                                    <button
                                        onClick={() => setSearch('')}
                                        className="mt-4 text-indigo-600 text-sm font-bold hover:underline"
                                    >
                                        Clear Search
                                    </button>
                                )}
                            </div>
                        ) : (
                            hookNames.map(hookName => (
                                <div key={hookName} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden group hover:shadow-md transition-all duration-300">
                                    {/* Header */}
                                    <div className="px-6 py-4 bg-slate-50/50 border-b border-slate-100 flex justify-between items-center group/header hover:bg-slate-100 transition-colors cursor-default">
                                        <div>
                                            <div className="flex items-center gap-3">
                                                <span className="font-bold text-slate-800 text-lg">
                                                    {HOOK_TITLES[hookName] || hookName}
                                                </span>
                                                {/* Show technical key if we have a friendly title, otherwise it's redundant */}
                                                {HOOK_TITLES[hookName] && (
                                                    <code className="text-[10px] font-mono font-bold text-slate-500 bg-slate-200/60 px-2 py-0.5 rounded border border-slate-300/50 select-all">
                                                        {hookName}
                                                    </code>
                                                )}
                                            </div>

                                            {HOOK_DESCRIPTIONS[hookName] ? (
                                                <span className="text-xs text-slate-500 font-medium mt-1 block leading-relaxed max-w-2xl">
                                                    {HOOK_DESCRIPTIONS[hookName]}
                                                </span>
                                            ) : (
                                                !HOOK_TITLES[hookName] && <span className="text-xs text-slate-400 italic mt-1 block">Custom hook</span>
                                            )}
                                        </div>
                                        <span className={`text-[10px] font-bold px-3 py-1.5 rounded-full uppercase tracking-wider border ${activeTab === 'actions' ? 'bg-indigo-50 text-indigo-700 border-indigo-100' : 'bg-pink-50 text-pink-700 border-pink-100'}`}>
                                            {filteredData[hookName].length} Handlers
                                        </span>
                                    </div>

                                    {/* Handlers Table */}
                                    <div className="divide-y divide-slate-50">
                                        {filteredData[hookName].map((handler, idx) => (
                                            <div key={idx} className="px-6 py-3 flex items-center gap-4 hover:bg-slate-50 transition-colors">
                                                <div className="w-12 flex-shrink-0 flex flex-col items-center justify-center group/prio relative cursor-help">
                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Prio</span>
                                                    <span className="text-lg font-black text-slate-700 leading-none">{handler.priority}</span>

                                                    {/* Tooltip */}
                                                    <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-32 p-2 bg-slate-800 text-white text-[10px] rounded-lg opacity-0 group-hover/prio:opacity-100 transition-opacity pointer-events-none z-10 text-center font-medium">
                                                        Lower numbers run first (Default: 10)
                                                    </div>
                                                </div>

                                                <div className="w-px h-8 bg-slate-100"></div>

                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${handler.pluginSlug === 'core' ? 'bg-slate-100 text-slate-600' : 'bg-emerald-100 text-emerald-600'}`}>
                                                            {handler.pluginSlug === 'core' ? 'Core' : 'Plugin'}
                                                        </span>
                                                        <span className="text-xs font-bold text-slate-500 truncate lowercase opacity-75">
                                                            {handler.pluginSlug}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {handler.callback.startsWith('Anonymous:') ? (
                                                            <div className="group/code relative">
                                                                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-100 border border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wide cursor-help hover:bg-slate-200 hover:text-slate-700 transition-colors">
                                                                    <i className="fa-solid fa-code"></i>
                                                                    Inline Logic
                                                                </span>
                                                                {/* Code Tooltip */}
                                                                <div className="absolute left-0 bottom-full mb-2 w-64 p-3 bg-slate-800 text-slate-300 text-[10px] font-mono rounded-xl shadow-xl opacity-0 group-hover/code:opacity-100 transition-opacity pointer-events-none z-20 break-all leading-relaxed whitespace-pre-wrap border border-slate-700">
                                                                    <div className="text-white font-bold mb-1 border-b border-slate-700 pb-1">Source Preview</div>
                                                                    {handler.callback.replace('Anonymous: ', '')}
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <code className="text-xs font-mono text-indigo-600 font-bold bg-indigo-50 px-2 py-1 rounded truncate block hover:bg-indigo-100 transition-colors cursor-text select-all" title="Function Name">
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

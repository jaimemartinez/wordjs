"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { pluginsApi, Plugin } from "@/lib/api";
import { permMeta, PermissionRisk } from "@/lib/permissionMeta";
import { useMenu } from "@/contexts/MenuContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { FaPlug, FaTrash, FaDownload, FaPowerOff, FaCheck, FaExclamationTriangle, FaSlidersH, FaSearch, FaSyncAlt, FaInfoCircle, FaTimes, FaShieldAlt, FaBan } from "react-icons/fa";
import { PageHeader, Button, EmptyState } from "@/components/ui";

// ---------------------------------------------------------------------------
// Small presentational helpers (kept in-file to avoid touching shared components)
// ---------------------------------------------------------------------------

const RISK_CLASSES: Record<PermissionRisk, string> = {
    low: 'bg-green-50 text-green-700 border-green-200',
    med: 'bg-amber-50 text-amber-700 border-amber-200',
    high: 'bg-red-50 text-red-700 border-red-200',
};

function RiskBadge({ risk }: { risk: PermissionRisk }) {
    return (
        <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${RISK_CLASSES[risk]}`}>
            {risk === 'high' ? 'high risk' : risk === 'med' ? 'medium' : 'low risk'}
        </span>
    );
}

// A single permission row (platform label + risk + platform description + optional plugin reason).
function PermissionRow({ token, reason }: { token: string; reason?: string }) {
    const meta = permMeta(token);
    return (
        <div className={`flex gap-3 p-4 rounded-xl border ${RISK_CLASSES[meta.risk]}`}>
            <div className="mt-0.5 shrink-0">
                <i className={`fas ${meta.icon || 'fa-key'} text-sm opacity-70`} />
            </div>
            <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-bold text-sm text-gray-800">{meta.label}</span>
                    <RiskBadge risk={meta.risk} />
                    <span className="text-[10px] font-mono text-gray-400">{token}</span>
                </div>
                {meta.description && <p className="text-xs text-gray-600 leading-snug">{meta.description}</p>}
                {reason && (
                    <p className="text-xs text-gray-500 leading-snug mt-1 italic">
                        <span className="not-italic font-semibold text-gray-400">Plugin says: </span>{reason}
                    </p>
                )}
            </div>
        </div>
    );
}

// Runtime state → colour + label for the health dot.
const RUNTIME_META: Record<string, { dot: string; label: string; text: string }> = {
    running: { dot: 'bg-green-500', label: 'Running', text: 'text-green-600' },
    restarting: { dot: 'bg-amber-500', label: 'Restarting', text: 'text-amber-600' },
    crashed: { dot: 'bg-red-500', label: 'Crashed', text: 'text-red-600' },
    'crash-looping': { dot: 'bg-red-600 animate-pulse', label: 'Crash-looping', text: 'text-red-700' },
    stopped: { dot: 'bg-gray-400', label: 'Stopped', text: 'text-gray-500' },
};

function fmtMB(bytes?: number | null) {
    if (bytes == null) return null;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PluginsPage() {
    const { t } = useI18n();
    const [plugins, setPlugins] = useState<Plugin[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const { refreshMenus } = useMenu();

    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [permissionModalOpen, setPermissionModalOpen] = useState(false);
    const [pluginToDelete, setPluginToDelete] = useState<Plugin | null>(null);
    const [pluginToActivate, setPluginToActivate] = useState<Plugin | null>(null);
    const [password, setPassword] = useState("");
    const [deleteError, setDeleteError] = useState("");
    const [dropData, setDropData] = useState(false);

    // Structured activation-reject panel (missing grants vs hard-blocked dangerous calls).
    const [rejection, setRejection] = useState<{ pluginName: string; message?: string; missingPermissions?: string[]; dangerousCalls?: string[] } | null>(null);

    // Per-plugin detail drawer.
    const [detailPlugin, setDetailPlugin] = useState<Plugin | null>(null);

    // Restart-in-flight tracking (per slug) for the health card button.
    const [restarting, setRestarting] = useState<Record<string, boolean>>({});

    // Search + status filter (rank 11).
    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

    // Android-style per-permission grants (default-deny). The admin toggles each DECLARED capability.
    const [permsModalPlugin, setPermsModalPlugin] = useState<Plugin | null>(null);
    const [grantDraft, setGrantDraft] = useState<Set<string>>(new Set());
    const [savingPerms, setSavingPerms] = useState(false);

    // The togglable capabilities are EXACTLY what the plugin declares in its manifest (nothing more).
    // A network permission normalizes to the single "network" token (it has no read/write access level).
    const permToken = (p: { scope: string; access?: string }) =>
        p.scope === 'network' ? 'network' : `${p.scope}:${p.access || 'read'}`;
    const declaredTokens = (plugin: Plugin) =>
        Array.from(new Set((plugin.permissions || []).map(permToken)));
    // Platform reason lookup for a token (first declaring permission's reason).
    const reasonFor = (plugin: Plugin, token: string) =>
        (plugin.permissions || []).find(p => permToken(p) === token)?.reason;

    const { addToast } = useToast();

    useEffect(() => {
        loadPlugins();
    }, []);

    // Debounce the search input into the applied `search` term.
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (searchTimer.current) clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 250);
        return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    }, [searchInput]);

    // Derive the visible list (filter + search) before rendering.
    const visiblePlugins = useMemo(() => {
        return plugins.filter((p) => {
            if (statusFilter === 'active' && !p.active) return false;
            if (statusFilter === 'inactive' && p.active) return false;
            if (search) {
                const hay = `${p.name} ${p.description || ''} ${p.slug}`.toLowerCase();
                if (!hay.includes(search)) return false;
            }
            return true;
        });
    }, [plugins, statusFilter, search]);

    const openPermissions = (plugin: Plugin) => {
        // Only keep grants that the plugin actually declares (drop any stale grant for a removed perm).
        const declared = new Set(declaredTokens(plugin));
        setGrantDraft(new Set((plugin.grantedPermissions || []).filter(t => declared.has(t))));
        setPermsModalPlugin(plugin);
    };
    const toggleGrant = (token: string) => {
        setGrantDraft(prev => {
            const next = new Set(prev);
            if (next.has(token)) next.delete(token); else next.add(token);
            return next;
        });
    };
    const savePermissions = async () => {
        if (!permsModalPlugin) return;
        setSavingPerms(true);
        try {
            const res = await pluginsApi.setPermissions(permsModalPlugin.slug, Array.from(grantDraft), grantDraft.has('network'));
            setPermsModalPlugin(null);
            loadPlugins();
            refreshMenus();
            addToast(res.message || `Permissions updated for "${permsModalPlugin.name}"`, "success");
        } catch (error: any) {
            addToast("Failed to update permissions: " + (error.message || "Unknown error"), "error");
        } finally {
            setSavingPerms(false);
        }
    };

    const loadPlugins = async () => {
        try {
            const data = await pluginsApi.list();
            setPlugins(data);
            // Keep an open detail drawer fresh with the latest runtime/grant data.
            setDetailPlugin(prev => prev ? (data.find(p => p.slug === prev.slug) || null) : prev);
        } catch (error) {
            console.error("Failed to load plugins:", error);
        } finally {
            setLoading(false);
        }
    };

    const togglePlugin = async (plugin: Plugin) => {
        try {
            if (plugin.active) {
                await pluginsApi.deactivate(plugin.slug);
                loadPlugins();
                refreshMenus();
                addToast(t('plugins.deactivated'), "success");
            } else {
                // ALWAYS show modal for any activation now
                setPluginToActivate(plugin);
                setPermissionModalOpen(true);
                return;
            }
        } catch (error: any) {
            console.error("Failed to toggle plugin:", error);
            addToast("Failed to change plugin status: " + (error.message || "Unknown error"), "error");
        }
    };

    const confirmActivate = async () => {
        if (!pluginToActivate) return;
        const name = pluginToActivate.name;
        try {
            await pluginsApi.activate(pluginToActivate.slug);
            setPermissionModalOpen(false);
            setPluginToActivate(null);
            loadPlugins();
            refreshMenus();
            addToast(t('plugins.activated'), "success");
        } catch (error: any) {
            console.error("Failed to activate plugin:", error);
            const details = error && error.details;
            if (details && (Array.isArray(details.missingPermissions) || Array.isArray(details.dangerousCalls))) {
                // Structured reject: show a dedicated panel splitting fixable grants from hard blocks.
                setPermissionModalOpen(false);
                setRejection({
                    pluginName: name,
                    message: error.message,
                    missingPermissions: details.missingPermissions || [],
                    dangerousCalls: details.dangerousCalls || [],
                });
            } else {
                // Persistent toast (duration: 0) so user can read the security error
                addToast("Activation failed: " + (error.message || "Unknown error"), "error", 0);
            }
        }
    };

    const handleRestart = async (plugin: Plugin) => {
        if (!plugin.active) return;
        setRestarting(prev => ({ ...prev, [plugin.slug]: true }));
        try {
            const res = await pluginsApi.reload(plugin.slug);
            addToast(res.message || `Restarted "${plugin.name}"`, "success");
            loadPlugins();
        } catch (error: any) {
            console.error("Failed to restart plugin:", error);
            addToast("Restart failed: " + (error.message || "Unknown error"), "error");
        } finally {
            setRestarting(prev => ({ ...prev, [plugin.slug]: false }));
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.name.endsWith('.zip')) {
            addToast(t('plugins.upload.select.zip'), "error");
            return;
        }

        setUploading(true);
        const formData = new FormData();
        formData.append('plugin', file);

        try {
            await pluginsApi.upload(formData);
            addToast(t('plugins.upload.success'), "success");
            loadPlugins();
            refreshMenus();
        } catch (error: any) {
            console.error("Upload failed:", error);
            addToast(t('plugins.upload.failed') + ": " + (error.message || "Unknown error"), "error");
        } finally {
            setUploading(false);
            e.target.value = "";
        }
    };

    const initiateDelete = (plugin: Plugin) => {
        setPluginToDelete(plugin);
        setDeleteModalOpen(true);
        setPassword("");
        setDeleteError("");
        setDropData(false);
    };

    const confirmDelete = async () => {
        if (!pluginToDelete || !password) return;

        try {
            await pluginsApi.delete(pluginToDelete.slug, password, dropData);
            setDeleteModalOpen(false);
            setPluginToDelete(null);
            setPassword("");
            setDropData(false);
            loadPlugins();
            refreshMenus();
            addToast(t('common.success'), "success");
        } catch (error: any) {
            console.error("Failed to delete plugin:", error);
            setDeleteError(error.message || t('plugins.delete.failed'));
        }
    };

    return (
        <div className="h-full p-8 relative overflow-y-auto custom-scrollbar">
            {/* Animated Background */}
            <div className="fixed inset-0 overflow-hidden z-0 pointer-events-none">
                <div className="absolute top-10 left-10 w-96 h-96 bg-blue-400/20 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob"></div>
                <div className="absolute top-10 right-10 w-96 h-96 bg-purple-400/20 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-2000"></div>
                <div className="absolute -bottom-8 left-20 w-96 h-96 bg-pink-400/20 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-blob animation-delay-4000"></div>
            </div>

            {/* Delete Confirmation Modal */}
            {deleteModalOpen && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl transform transition-all scale-100 border border-white/20">
                        <div className="flex items-center gap-4 mb-6 text-red-600">
                            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                                <FaExclamationTriangle className="text-xl" />
                            </div>
                            <h3 className="text-xl font-bold text-gray-900">{t('plugins.delete.title')}</h3>
                        </div>

                        <p className="mb-6 text-gray-600 leading-relaxed">
                            {t('plugins.delete.message')} <strong className="text-gray-900">{pluginToDelete?.name}</strong>?
                        </p>

                        <div className="mb-6 space-y-2">
                            <label className="block text-sm font-bold text-gray-700 uppercase tracking-wider">
                                {t('users.password')}
                            </label>
                            <input
                                type="password"
                                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-4 focus:ring-red-100 focus:border-red-500 outline-none transition-all"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={t('users.password')}
                                autoFocus
                            />
                            {deleteError && (
                                <p className="text-red-500 text-sm font-medium flex items-center gap-2">
                                    <FaExclamationTriangle /> {deleteError}
                                </p>
                            )}
                        </div>

                        {/* Also drop the plugin's data/tables (rank 2). Default OFF — destructive & irreversible. */}
                        <label className="mb-6 flex items-start gap-3 p-3 rounded-xl border border-red-100 bg-red-50/50 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 accent-red-600"
                                checked={dropData}
                                onChange={(e) => setDropData(e.target.checked)}
                            />
                            <span className="text-sm text-gray-700 leading-snug">
                                <span className="font-bold text-red-700">Also delete this plugin&apos;s data / tables</span>
                                <span className="block text-xs text-gray-500 mt-0.5">This drops the plugin&apos;s database tables. Cannot be undone. Leave off to keep its data for a future reinstall.</span>
                            </span>
                        </label>

                        <div className="flex justify-end gap-3 pt-2">
                            <button
                                onClick={() => setDeleteModalOpen(false)}
                                className="px-5 py-2.5 text-gray-600 hover:text-gray-900 font-medium hover:bg-gray-100 rounded-xl transition-all"
                            >
                                {t('cancel')}
                            </button>
                            <button
                                onClick={confirmDelete}
                                disabled={!password}
                                className="px-5 py-2.5 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-red-500/30 transition-all transform hover:-translate-y-0.5"
                            >
                                {t('plugins.delete.confirm')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Activation Rejection Modal — structured (missing grants vs hard-blocked dangerous calls) */}
            {rejection && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl max-w-lg w-full shadow-2xl border border-white/20 max-h-[85vh] flex flex-col">
                        <div className="p-8 pb-4 flex-shrink-0">
                            <div className="flex items-center gap-4 text-red-600">
                                <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                                    <FaShieldAlt className="text-xl" />
                                </div>
                                <div>
                                    <h3 className="text-xl font-bold text-gray-900">Activation blocked</h3>
                                    <p className="text-sm text-gray-500">{rejection.pluginName}</p>
                                </div>
                            </div>
                        </div>
                        <div className="px-8 overflow-y-auto flex-1 custom-scrollbar">
                            {(rejection.dangerousCalls && rejection.dangerousCalls.length > 0) && (
                                <div className="mb-5">
                                    <div className="flex items-center gap-2 mb-2 text-red-700">
                                        <FaBan />
                                        <h4 className="font-bold text-sm">Blocked — this plugin uses forbidden code and cannot be enabled</h4>
                                    </div>
                                    <ul className="space-y-2">
                                        {rejection.dangerousCalls.map((d, i) => (
                                            <li key={i} className="text-sm text-red-800 bg-red-50 border border-red-100 rounded-lg px-3 py-2 font-mono break-words">{d}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {(rejection.missingPermissions && rejection.missingPermissions.length > 0) && (
                                <div className="mb-5">
                                    <div className="flex items-center gap-2 mb-2 text-amber-700">
                                        <FaExclamationTriangle />
                                        <h4 className="font-bold text-sm">Grant these permissions and retry</h4>
                                    </div>
                                    <ul className="space-y-2">
                                        {rejection.missingPermissions.map((m, i) => (
                                            <li key={i} className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 break-words">{m}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {(!rejection.dangerousCalls || rejection.dangerousCalls.length === 0) &&
                                (!rejection.missingPermissions || rejection.missingPermissions.length === 0) && (
                                    <p className="text-sm text-gray-600 whitespace-pre-wrap mb-4">{rejection.message || 'Activation failed.'}</p>
                                )}
                        </div>
                        <div className="p-8 pt-6 flex justify-end gap-3 flex-shrink-0 border-t border-gray-100 mt-2">
                            <button
                                onClick={() => setRejection(null)}
                                className="px-6 py-2.5 bg-gray-900 text-white rounded-xl font-bold hover:bg-gray-800 shadow-lg transition-all"
                            >
                                {t('common.close') || 'Close'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Detail Drawer — per-plugin overview, permission diff, runtime health (rank 11) */}
            {detailPlugin && (
                <div className="fixed inset-0 z-50 flex justify-end animate-in fade-in duration-200">
                    <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDetailPlugin(null)} />
                    <div className="relative bg-white w-full max-w-md h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
                        <div className="p-6 border-b border-gray-100 flex items-start justify-between gap-4">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className={`p-3 rounded-xl ${detailPlugin.active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'}`}>
                                    <FaPlug />
                                </div>
                                <div className="min-w-0">
                                    <h3 className="text-lg font-bold text-gray-900 truncate" title={detailPlugin.name}>{detailPlugin.name}</h3>
                                    <p className="text-xs text-gray-400 font-mono truncate">{detailPlugin.slug} · v{detailPlugin.version}</p>
                                </div>
                            </div>
                            <button onClick={() => setDetailPlugin(null)} className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
                                <FaTimes />
                            </button>
                        </div>

                        <div className="p-6 overflow-y-auto flex-1 custom-scrollbar space-y-6">
                            <div>
                                <p className="text-sm text-gray-600 leading-relaxed">{detailPlugin.description || 'No description provided.'}</p>
                                {(detailPlugin.author || detailPlugin.homepage) && (
                                    <div className="mt-3 space-y-1 text-xs text-gray-500">
                                        {detailPlugin.author && <div><span className="font-semibold text-gray-400">Author: </span>{detailPlugin.author}</div>}
                                        {detailPlugin.homepage && (
                                            <div className="flex items-center gap-1">
                                                <span className="font-semibold text-gray-400">Homepage: </span>
                                                <a href={detailPlugin.homepage} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate">{detailPlugin.homepage}</a>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Runtime health */}
                            {detailPlugin.active && (
                                <div>
                                    <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">Runtime health</h4>
                                    {detailPlugin.runtime ? (
                                        <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 space-y-2">
                                            {(() => {
                                                const rm = RUNTIME_META[detailPlugin.runtime.state] || RUNTIME_META.stopped;
                                                const rss = fmtMB(detailPlugin.runtime.rssBytes);
                                                return (
                                                    <>
                                                        <div className="flex items-center gap-2">
                                                            <span className={`w-2.5 h-2.5 rounded-full ${rm.dot}`} />
                                                            <span className={`text-sm font-bold ${rm.text}`}>{rm.label}</span>
                                                            {detailPlugin.runtime.pid != null && <span className="text-xs text-gray-400 font-mono">pid {detailPlugin.runtime.pid}</span>}
                                                        </div>
                                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                                                            {rss && <span>RSS: {rss}</span>}
                                                            {!!detailPlugin.runtime.restarts && <span>restarts: {detailPlugin.runtime.restarts}</span>}
                                                            {detailPlugin.runtime.lastExitCode != null && <span>last exit: {detailPlugin.runtime.lastExitCode}</span>}
                                                        </div>
                                                        {detailPlugin.runtime.lastError && (
                                                            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-2 py-1 break-words">{detailPlugin.runtime.lastError}</p>
                                                        )}
                                                    </>
                                                );
                                            })()}
                                            <button
                                                onClick={() => handleRestart(detailPlugin)}
                                                disabled={!!restarting[detailPlugin.slug]}
                                                className="mt-1 inline-flex items-center gap-2 text-xs font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-gray-600 hover:bg-blue-50 hover:text-blue-600 disabled:opacity-50 transition-colors"
                                            >
                                                <FaSyncAlt className={restarting[detailPlugin.slug] ? 'animate-spin' : ''} /> Reload
                                            </button>
                                        </div>
                                    ) : (
                                        <p className="text-xs text-gray-400">No live runtime data (not an isolated plugin).</p>
                                    )}
                                </div>
                            )}

                            {/* Requested vs granted permission diff */}
                            <div>
                                <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">Permissions</h4>
                                {declaredTokens(detailPlugin).length === 0 ? (
                                    <p className="text-xs text-gray-400">This plugin requests no permissions.</p>
                                ) : (
                                    <div className="space-y-2">
                                        {declaredTokens(detailPlugin).map((token) => {
                                            const meta = permMeta(token);
                                            const granted = (detailPlugin.grantedPermissions || []).includes(token);
                                            return (
                                                <div key={token} className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 ${RISK_CLASSES[meta.risk]}`}>
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <i className={`fas ${meta.icon || 'fa-key'} text-xs opacity-70`} />
                                                            <span className="text-sm font-bold text-gray-800">{meta.label}</span>
                                                            <RiskBadge risk={meta.risk} />
                                                        </div>
                                                        <span className="text-[10px] font-mono text-gray-400">{token}</span>
                                                    </div>
                                                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${granted ? 'bg-green-600 text-white' : 'bg-gray-300 text-gray-600'}`}>
                                                        {granted ? 'granted' : 'denied'}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Plugin Permissions Modal (activation consent) */}
            {permissionModalOpen && pluginToActivate && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl max-w-lg w-full shadow-2xl transform transition-all scale-100 border border-white/20 max-h-[85vh] flex flex-col">

                        {/* Header - Fixed */}
                        <div className="p-8 pb-4 flex-shrink-0">
                            <div className="flex items-center gap-4 text-blue-600">
                                <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                                    <FaPlug className="text-xl" />
                                </div>
                                <h3 className="text-xl font-bold text-gray-900">{t('plugins.permissions')}</h3>
                            </div>
                        </div>

                        {/* Scrollable Content */}
                        <div className="px-8 overflow-y-auto flex-1 custom-scrollbar">
                            <p className="mb-6 text-gray-600 leading-relaxed">
                                {t('plugins.requests.permissions')} <strong className="text-gray-900">{pluginToActivate.name}</strong>:
                            </p>

                            <div className="space-y-3 mb-6">
                                {declaredTokens(pluginToActivate).length > 0 ? (
                                    declaredTokens(pluginToActivate).map((token) => (
                                        <PermissionRow key={token} token={token} reason={reasonFor(pluginToActivate, token)} />
                                    ))
                                ) : (
                                    <div className="flex flex-col items-center justify-center p-8 bg-green-50 rounded-2xl border border-green-100 text-center">
                                        <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center shadow-sm mb-3">
                                            <FaCheck className="text-green-500" />
                                        </div>
                                        <p className="text-green-800 font-bold text-sm">{t('plugins.safe.to.activate')}</p>
                                        <p className="text-green-600 text-xs mt-1">{t('plugins.no.permissions')}</p>
                                    </div>
                                )}
                            </div>

                            <p className="text-xs text-gray-400 mb-2 p-3 bg-blue-50/50 rounded-lg border border-blue-100/50 italic">
                                By activating this plugin, you are granting it strict access to these system capabilities.
                            </p>
                        </div>

                        {/* Footer - Fixed */}
                        <div className="p-8 pt-6 flex justify-end gap-3 flex-shrink-0 border-t border-gray-100 mt-2">
                            <button
                                onClick={() => {
                                    setPermissionModalOpen(false);
                                    setPluginToActivate(null);
                                }}
                                className="px-5 py-2.5 text-gray-600 hover:text-gray-900 font-medium hover:bg-gray-100 rounded-xl transition-all"
                            >
                                {t('cancel')}
                            </button>
                            <button
                                onClick={confirmActivate}
                                className="px-6 py-2.5 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 shadow-lg hover:shadow-blue-500/30 transition-all transform hover:-translate-y-0.5"
                            >
                                {t('plugins.confirm.activate')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Manage Permissions Modal — Android-style per-permission grants (default-deny) */}
            {permsModalPlugin && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl max-w-lg w-full shadow-2xl border border-white/20 max-h-[85vh] flex flex-col">
                        <div className="p-8 pb-4 flex-shrink-0">
                            <div className="flex items-center gap-4 text-blue-600">
                                <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0"><FaSlidersH className="text-xl" /></div>
                                <div>
                                    <h3 className="text-xl font-bold text-gray-900">Permissions</h3>
                                    <p className="text-sm text-gray-500">{permsModalPlugin.name}</p>
                                </div>
                            </div>
                        </div>
                        <div className="px-8 overflow-y-auto flex-1 custom-scrollbar">
                            <p className="mb-4 text-gray-600 text-sm leading-relaxed">Grant only what this plugin needs. Anything left off is <strong>denied</strong> (default-deny) — the plugin can use a capability only if it both requested it and you grant it here.</p>

                            <div className="space-y-2 mb-4">
                                {declaredTokens(permsModalPlugin).length === 0 ? (
                                    <div className="p-4 bg-gray-50 rounded-xl text-gray-400 text-sm text-center">This plugin declares no permissions — it can&apos;t access anything beyond its own sandbox.</div>
                                ) : declaredTokens(permsModalPlugin).map((token) => {
                                    const on = grantDraft.has(token);
                                    const meta = permMeta(token);
                                    const highRisk = meta.risk === 'high';
                                    const activeClasses = highRisk ? 'bg-red-50 border-red-200' : meta.risk === 'med' ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200';
                                    const knobOn = highRisk ? 'bg-red-500' : meta.risk === 'med' ? 'bg-amber-500' : 'bg-green-500';
                                    const reason = reasonFor(permsModalPlugin, token);
                                    return (
                                        <div key={token} className={`rounded-xl border transition-colors ${on ? activeClasses : 'bg-gray-50 border-gray-100'}`}>
                                            <button
                                                onClick={() => toggleGrant(token)}
                                                className="w-full flex items-start justify-between gap-3 p-3 text-left"
                                            >
                                                <span className="min-w-0">
                                                    <span className="flex items-center gap-2 flex-wrap">
                                                        <i className={`fas ${meta.icon || 'fa-key'} text-xs opacity-70`} />
                                                        <span className="font-bold text-sm text-gray-800">{meta.label}</span>
                                                        <RiskBadge risk={meta.risk} />
                                                        <span className="text-[10px] font-mono text-gray-400">{token}</span>
                                                    </span>
                                                    {meta.description && <span className="block text-xs text-gray-600 leading-snug mt-1">{meta.description}</span>}
                                                    {reason && <span className="block text-xs text-gray-500 leading-snug mt-1 italic"><span className="not-italic font-semibold text-gray-400">Plugin says: </span>{reason}</span>}
                                                </span>
                                                <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 mt-0.5 ${on ? knobOn : 'bg-gray-300'}`}>
                                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
                                                </span>
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                        <div className="p-8 pt-6 flex justify-end gap-3 flex-shrink-0 border-t border-gray-100 mt-2">
                            <button onClick={() => setPermsModalPlugin(null)} className="px-5 py-2.5 text-gray-600 hover:text-gray-900 font-medium hover:bg-gray-100 rounded-xl transition-all">Cancel</button>
                            <button onClick={savePermissions} disabled={savingPerms} className="px-6 py-2.5 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 disabled:opacity-50 shadow-lg hover:shadow-blue-500/30 transition-all">
                                {savingPerms ? 'Saving…' : 'Save permissions'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <div className="relative z-10">
                <PageHeader
                    title={t('plugins.title')}
                    subtitle={t('plugins.extend.functionality')}
                    icon="fa-plug"
                    actions={
                        <div className="relative">
                            <Button
                                icon={uploading ? "fa-spinner fa-spin" : "fa-upload"}
                                loading={uploading}
                                onClick={() => document.getElementById('plugin-upload-input')?.click()}
                            >
                                {uploading ? t('plugins.installing') : t('plugins.upload')}
                            </Button>
                            <input
                                id="plugin-upload-input"
                                type="file"
                                accept=".zip"
                                className="hidden"
                                onChange={handleUpload}
                                disabled={uploading}
                            />
                        </div>
                    }
                />
            </div>

            {/* Search + status filter (rank 11) */}
            {!loading && plugins.length > 0 && (
                <div className="relative z-10 mb-6 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
                    <div className="relative flex-1 max-w-md">
                        <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm" />
                        <input
                            type="text"
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            placeholder="Search plugins…"
                            className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-gray-200 bg-white/70 backdrop-blur-md focus:ring-4 focus:ring-blue-100 focus:border-blue-400 outline-none transition-all text-sm"
                        />
                    </div>
                    <div className="flex gap-1.5">
                        {(['all', 'active', 'inactive'] as const).map((f) => (
                            <button
                                key={f}
                                onClick={() => setStatusFilter(f)}
                                className={`px-4 py-2 rounded-xl text-sm font-bold capitalize transition-all border ${statusFilter === f ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-500/20' : 'bg-white/60 text-gray-500 border-gray-200 hover:bg-white'}`}
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Plugin Grid */}
            <div className="relative z-10">
                {loading ? (
                    <div className="glass-panel rounded-[40px] p-12 text-center text-gray-400">
                        <div className="w-16 h-16 border-4 border-blue-100 border-t-blue-500 rounded-full animate-spin mx-auto mb-4"></div>
                        <p className="font-medium">{t('plugins.loading')}</p>
                    </div>
                ) : plugins.length === 0 ? (
                    <EmptyState
                        icon="fa-box-open"
                        title={t('plugins.no.plugins.found')}
                        description="Get started by uploading your first plugin using the button above."
                    />
                ) : visiblePlugins.length === 0 ? (
                    <EmptyState
                        icon="fa-search"
                        title="No plugins match your filters"
                        description="Try a different search term or status filter."
                    />
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                        {visiblePlugins.map((plugin) => {
                            const rm = plugin.runtime ? (RUNTIME_META[plugin.runtime.state] || RUNTIME_META.stopped) : null;
                            const rss = fmtMB(plugin.runtime?.rssBytes);
                            const isCrashLooping = plugin.runtime?.state === 'crash-looping';
                            return (
                            <div
                                key={plugin.slug}
                                className={`
                                    group relative rounded-2xl p-6 transition-all duration-300 border
                                    ${plugin.active
                                        ? 'bg-white/80 border-blue-100 shadow-xl shadow-blue-900/5'
                                        : 'bg-white/40 border-gray-100 shadow-sm hover:bg-white/60'}
                                    backdrop-blur-md
                                `}
                            >
                                <div className="flex justify-between items-start mb-4">
                                    <div className={`p-3 rounded-xl ${plugin.active ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30' : 'bg-gray-100 text-gray-400'}`}>
                                        <FaPlug className="text-xl" />
                                    </div>
                                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button
                                            onClick={() => setDetailPlugin(plugin)}
                                            className="p-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                                            title="Details"
                                        >
                                            <FaInfoCircle />
                                        </button>
                                        {!plugin.active && (
                                            <>
                                                <button
                                                    onClick={() => pluginsApi.download(plugin.slug)}
                                                    className="p-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                                                    title="Download Source"
                                                >
                                                    <FaDownload />
                                                </button>
                                                <button
                                                    onClick={() => initiateDelete(plugin)}
                                                    className="p-2 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                                                    title="Delete Plugin"
                                                >
                                                    <FaTrash />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>

                                <h3 className="text-xl font-bold text-gray-900 mb-2 line-clamp-1" title={plugin.name}>
                                    {plugin.name}
                                </h3>
                                <p className="text-gray-500 text-sm mb-4 h-10 line-clamp-2 leading-relaxed">
                                    {plugin.description || "No description provided."}
                                </p>

                                {/* Runtime health (rank 1) — only for active plugins with runtime data */}
                                {plugin.active && rm && (
                                    <div className="mb-4 rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-2">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${rm.dot}`} title={rm.label} />
                                                <span className={`text-xs font-bold ${rm.text}`}>{rm.label}</span>
                                                {rss && <span className="text-[11px] text-gray-400">· RSS: {rss}</span>}
                                                {!!plugin.runtime?.restarts && <span className="text-[11px] text-gray-400">· restarts: {plugin.runtime.restarts}</span>}
                                            </div>
                                            <button
                                                onClick={() => handleRestart(plugin)}
                                                disabled={!!restarting[plugin.slug]}
                                                title="Restart plugin"
                                                className="p-1.5 rounded-lg text-gray-500 hover:bg-blue-50 hover:text-blue-600 disabled:opacity-50 transition-colors"
                                            >
                                                <FaSyncAlt className={restarting[plugin.slug] ? 'animate-spin' : ''} />
                                            </button>
                                        </div>
                                        {isCrashLooping && plugin.runtime?.lastError && (
                                            <p className="text-[11px] text-red-600 mt-1 line-clamp-2 break-words" title={plugin.runtime.lastError}>{plugin.runtime.lastError}</p>
                                        )}
                                    </div>
                                )}

                                {/* Permissions section */}
                                {plugin.permissions && plugin.permissions.length > 0 && (
                                    <div className="mb-6">
                                        <div className="flex flex-wrap gap-1.5">
                                            {plugin.permissions.map((p, idx) => {
                                                const token = permToken(p);
                                                const meta = permMeta(token);
                                                return (
                                                    <span
                                                        key={idx}
                                                        title={`${meta.label} — ${meta.risk} risk${p.reason ? ` · ${p.reason}` : ''}`}
                                                        className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${RISK_CLASSES[meta.risk]}`}
                                                    >
                                                        {p.scope === 'network' ? 'network' : `${p.scope}:${p.access}`}
                                                    </span>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold text-gray-400 uppercase tracking-wider bg-gray-50 px-2 py-1 rounded-md">
                                            v{plugin.version}
                                        </span>
                                        <button
                                            onClick={() => openPermissions(plugin)}
                                            title="Manage what this plugin can access (per-permission grants)"
                                            className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md border flex items-center gap-1 transition-colors bg-gray-50 text-gray-500 border-gray-100 hover:bg-blue-50 hover:text-blue-600"
                                        >
                                            <FaSlidersH /> Permissions
                                        </button>
                                    </div>

                                    <button
                                        onClick={() => togglePlugin(plugin)}
                                        className={`
                                            px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 transition-all duration-300
                                            ${plugin.active
                                                ? 'bg-red-50 text-red-600 hover:bg-red-100'
                                                : 'bg-green-50 text-green-600 hover:bg-green-100'}
                                        `}
                                    >
                                        {plugin.active ? (
                                            <>
                                                <FaPowerOff /> {t('plugins.deactivate')}
                                            </>
                                        ) : (
                                            <>
                                                <FaCheck /> {t('plugins.activate')}
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

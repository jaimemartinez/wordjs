"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { pluginsApi, themesApi, Plugin, PluginPortConflict } from "@/lib/api";
import { permMeta, PermissionRisk } from "@/lib/permissionMeta";
import { reloadActivePlugins } from "@/lib/plugins";
import { useMenu } from "@/contexts/MenuContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { FaPlug, FaTrash, FaDownload, FaPowerOff, FaCheck, FaExclamationTriangle, FaSlidersH, FaSearch, FaSyncAlt, FaInfoCircle, FaTimes, FaShieldAlt, FaBan, FaUnlock, FaStore, FaPalette } from "react-icons/fa";
import { PageHeader, Button, EmptyState } from "@/components/ui";
import MarketplaceTab from "./MarketplaceTab";

// ---------------------------------------------------------------------------
// Small presentational helpers (kept in-file to avoid touching shared components)
// ---------------------------------------------------------------------------

const RISK_CLASSES: Record<PermissionRisk, string> = {
    low: 'bg-emerald-50/60 text-emerald-700 border-emerald-200/50 hover:bg-emerald-50 transition-colors',
    med: 'bg-amber-50/60 text-amber-700 border-amber-200/50 hover:bg-amber-50 transition-colors',
    high: 'bg-rose-50/60 text-rose-700 border-rose-200/50 hover:bg-rose-50 transition-colors',
};

function RiskBadge({ risk }: { risk: PermissionRisk }) {
    return (
        <span className={`text-[8px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded-full border shadow-sm ${RISK_CLASSES[risk]}`}>
            {risk === 'high' ? 'high risk' : risk === 'med' ? 'medium' : 'low risk'}
        </span>
    );
}

// A single permission row (platform label + risk + platform description + optional plugin reason).
function PermissionRow({ token, reason }: { token: string; reason?: string }) {
    const meta = permMeta(token);
    return (
        <div className={`flex gap-3 p-4 rounded-2xl border backdrop-blur-sm transition-all duration-300 hover:shadow-sm ${RISK_CLASSES[meta.risk]}`}>
            <div className="mt-0.5 shrink-0">
                <i className={`fas ${meta.icon || 'fa-key'} text-sm opacity-70`} />
            </div>
            <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-extrabold text-sm text-slate-800">{meta.label}</span>
                    <RiskBadge risk={meta.risk} />
                    <span className="text-[10px] font-mono text-slate-400/80 font-semibold">{token}</span>
                </div>
                {meta.description && <p className="text-xs text-slate-600 font-medium leading-relaxed">{meta.description}</p>}
                {reason && (
                    <p className="text-xs text-slate-500 leading-relaxed mt-1.5 italic">
                        <span className="not-italic font-bold text-slate-400">Plugin says: </span>{reason}
                    </p>
                )}
            </div>
        </div>
    );
}

// Runtime state → colour + label for the health dot.
const RUNTIME_META: Record<string, { dot: string; label: string; text: string }> = {
    running: { dot: 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]', label: 'Running', text: 'text-emerald-600' },
    restarting: { dot: 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]', label: 'Restarting', text: 'text-amber-600' },
    crashed: { dot: 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]', label: 'Crashed', text: 'text-rose-600' },
    'crash-looping': { dot: 'bg-rose-600 animate-pulse shadow-[0_0_8px_rgba(225,29,72,0.6)]', label: 'Crash-looping', text: 'text-rose-700' },
    stopped: { dot: 'bg-slate-400', label: 'Stopped', text: 'text-slate-500' },
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
    // Post-activation consensual port fix: a known distro MTA squatting a manifest-claimed port
    // (e.g. Postfix on 25). Set → modal explaining the PERMANENT disable, admin confirms or cancels.
    const [portConflictPrompt, setPortConflictPrompt] = useState<{ plugin: Plugin; conflict: PluginPortConflict } | null>(null);
    const [freeingPort, setFreeingPort] = useState(false);
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

    // Companion-theme install in flight (per slug) + post-install "switch to it now?" prompt.
    const [installingTheme, setInstallingTheme] = useState<Record<string, boolean>>({});
    const [themeSwitchPrompt, setThemeSwitchPrompt] = useState<{ pluginName: string; themeSlug: string } | null>(null);
    const [switchingTheme, setSwitchingTheme] = useState(false);

    // Search + status filter (rank 11).
    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

    // Installed vs Marketplace view.
    const [tab, setTab] = useState<'installed' | 'marketplace'>('installed');

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
                // The set of ACTIVE plugins just changed, and nothing here reloads the page — tell the
                // runtime plugin loader, whose active-list memo would otherwise stay stale for the rest
                // of the session (see lib/plugins.ts reloadActivePlugins).
                reloadActivePlugins();
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
        const plugin = pluginToActivate;
        const name = plugin.name;
        try {
            await pluginsApi.activate(plugin.slug);
            setPermissionModalOpen(false);
            setPluginToActivate(null);
            loadPlugins();
            refreshMenus();
            // Load the just-activated plugin's frontend hooks NOW: this page never reloads the document,
            // so without it the loader replays an active-plugin list captured before the activation and
            // the plugin's UI extensions (e.g. mail-server's mailbox toggle in the user form) stay
            // invisible until the admin reloads the tab by hand.
            reloadActivePlugins();
            addToast(t('plugins.activated'), "success");
            // Zero-config assist: if this plugin claims a system port (manifest claimPorts, e.g. mail
            // on 25) and a known distro MTA is squatting it, offer a one-click consensual fix instead
            // of silently leaving the plugin on a degraded fallback port.
            try {
                const { conflicts } = await pluginsApi.portConflicts(plugin.slug);
                const fixable = (conflicts || []).find(c => c.inUse && c.canFree);
                if (fixable) {
                    setPortConflictPrompt({ plugin, conflict: fixable });
                } else {
                    // Squatted but NOT auto-fixable (unknown occupant, not root, …): the admin still
                    // needs to know — surface the reason instead of silently discarding it.
                    const blocked = (conflicts || []).find(c => c.inUse && !c.canFree);
                    if (blocked?.reason) addToast(`${plugin.name} ${t('plugins.freeport.blocked')} ${blocked.reason}`, "warning", 0);
                }
            } catch { /* informational check — never block a successful activation on it */ }
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

    // Admin confirmed the modal: permanently disable the squatting MTA and reload the plugin so it
    // binds the freed port. The backend re-validates everything (known-MTA allowlist, manifest claim)
    // and only disables when the request carries this modal's consent (allowDisable).
    const confirmFreePort = async () => {
        if (!portConflictPrompt) return;
        const { plugin, conflict } = portConflictPrompt;
        setFreeingPort(true);
        try {
            const res = await pluginsApi.freePort(plugin.slug, conflict.port, true);
            setPortConflictPrompt(null);
            // Tell the admin what ACTUALLY happened — the squatter may have vanished on its own.
            if (res.freed) {
                addToast(`${res.label || conflict.occupant?.label || 'Service'} ${t('plugins.freeport.success')} ${plugin.name} ${t('plugins.freeport.success.post')} ${conflict.port}.`, "success");
            } else {
                addToast(`${t('plugins.freeport.already')} ${plugin.name} ${t('plugins.freeport.success.post')} ${conflict.port}.`, "success");
            }
        } catch (error: any) {
            addToast(`${t('plugins.freeport.error')} ${conflict.port}: ` + (error.message || "Unknown error"), "error", 0);
        } finally {
            setFreeingPort(false);
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

    // Companion theme (plugin-completeness option B): one click copies the plugin's bundled theme/
    // to themes/<slug>-theme (host-side, validated like an uploaded theme), then offers the switch
    // via a non-blocking modal (matches the page's modal pattern — no window.confirm).
    const handleInstallTheme = async (plugin: Plugin) => {
        setInstallingTheme(prev => ({ ...prev, [plugin.slug]: true }));
        try {
            const res = await pluginsApi.installTheme(plugin.slug, false);
            addToast(res.message || `Theme "${res.slug}" installed`, "success");
            loadPlugins();
            setThemeSwitchPrompt({ pluginName: plugin.name, themeSlug: res.slug });
        } catch (error: any) {
            addToast("Theme install failed: " + (error.message || "Unknown error"), "error", 0);
        } finally {
            setInstallingTheme(prev => ({ ...prev, [plugin.slug]: false }));
        }
    };

    const confirmThemeSwitch = async () => {
        if (!themeSwitchPrompt) return;
        setSwitchingTheme(true);
        try {
            await themesApi.activate(themeSwitchPrompt.themeSlug);
            addToast(`Theme "${themeSwitchPrompt.themeSlug}" is now active`, "success");
            setThemeSwitchPrompt(null);
        } catch (error: any) {
            addToast("Theme switch failed: " + (error.message || "Unknown error"), "error", 0);
        } finally {
            setSwitchingTheme(false);
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

            {/* Port-conflict fix modal: a known distro MTA is squatting a port this plugin claims.
                Explains exactly WHAT will be disabled, that it is PERMANENT, and asks for consent. */}
            {portConflictPrompt && (
                <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in duration-300">
                    <div className="bg-white/95 backdrop-blur-lg rounded-[32px] p-8 max-w-md w-full shadow-[0_32px_64px_-16px_rgba(0,0,0,0.12)] border border-slate-200/50 transform transition-all scale-100">
                        <div className="flex items-center gap-4 mb-6">
                            <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center flex-shrink-0 text-amber-600 shadow-sm">
                                <FaUnlock className="text-xl" />
                            </div>
                            <h3 className="text-xl font-extrabold text-slate-900">{t('plugins.freeport.title')} {portConflictPrompt.conflict.port}?</h3>
                        </div>

                        <div className="mb-6 text-slate-500 leading-relaxed space-y-3.5 text-xs font-semibold">
                            <p>
                                <strong className="text-slate-900 font-extrabold">{portConflictPrompt.conflict.occupant?.label || '?'}</strong>{' '}
                                {t('plugins.freeport.holding')} <strong className="text-slate-900 font-extrabold">{portConflictPrompt.conflict.port}</strong>;{' '}
                                <strong className="text-slate-900 font-extrabold">{portConflictPrompt.plugin.name}</strong> {t('plugins.freeport.needs')}
                            </p>
                            <p>
                                {portConflictPrompt.conflict.occupant?.loopbackOnly
                                    ? t('plugins.freeport.loopback')
                                    : <><strong className="text-rose-600 font-extrabold">{t('plugins.freeport.public')}</strong></>}
                            </p>
                            <p className="p-4 rounded-2xl border border-amber-200 bg-amber-50/50 text-amber-800 shadow-sm">
                                {t('plugins.freeport.permanent.pre')} <strong className="font-extrabold">{portConflictPrompt.conflict.occupant?.label || '—'}</strong>
                                {' '}(<code className="text-[10px] font-mono bg-amber-100 px-1 py-0.5 rounded">systemctl disable --now {portConflictPrompt.conflict.occupant?.service}</code>){' '}
                                {t('plugins.freeport.permanent.post')}
                            </p>
                        </div>

                        <div className="flex justify-end gap-3 pt-2">
                            <button
                                onClick={() => setPortConflictPrompt(null)}
                                disabled={freeingPort}
                                className="px-5 py-2.5 text-xs font-extrabold uppercase tracking-widest text-slate-500 hover:text-slate-950 hover:bg-slate-100/80 rounded-xl transition-all disabled:opacity-50"
                            >
                                {t('cancel')}
                            </button>
                            <button
                                onClick={confirmFreePort}
                                disabled={freeingPort}
                                className="px-6 py-3 bg-amber-600 hover:bg-amber-700 text-white text-xs font-extrabold uppercase tracking-widest rounded-xl transition-all disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-amber-500/20 hover:scale-102 active:scale-98"
                            >
                                {freeingPort ? (<><FaSyncAlt className="animate-spin" /> {t('plugins.freeport.freeing')}</>) : (<><FaUnlock /> {t('plugins.freeport.confirm')}</>)}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Companion-theme installed: offer the optional one-click switch (option B). */}
            {themeSwitchPrompt && (
                <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in duration-300">
                    <div className="bg-white/95 backdrop-blur-lg rounded-[32px] p-8 max-w-md w-full shadow-[0_32px_64px_-16px_rgba(0,0,0,0.12)] border border-slate-200/50 transform transition-all scale-100">
                        <div className="flex items-center gap-4 mb-6">
                            <div className="w-14 h-14 rounded-2xl bg-violet-50 border border-violet-100 flex items-center justify-center flex-shrink-0 text-violet-600 shadow-sm">
                                <FaPalette className="text-xl" />
                            </div>
                            <h3 className="text-xl font-extrabold text-slate-900">Theme installed</h3>
                        </div>
                        <div className="mb-6 text-slate-500 leading-relaxed space-y-3.5 text-xs font-semibold">
                            <p>
                                <strong className="text-slate-900 font-extrabold">{themeSwitchPrompt.pluginName}</strong>&apos;s theme is now installed as{' '}
                                <code className="text-[10px] font-mono bg-violet-50 px-1 py-0.5 rounded">{themeSwitchPrompt.themeSlug}</code>.
                            </p>
                            <p>Switch the site to this theme now? You can also do it later in Appearance → Themes.</p>
                        </div>
                        <div className="flex justify-end gap-3 pt-2">
                            <button
                                onClick={() => setThemeSwitchPrompt(null)}
                                disabled={switchingTheme}
                                className="px-5 py-2.5 text-xs font-extrabold uppercase tracking-widest text-slate-500 hover:text-slate-950 hover:bg-slate-100/80 rounded-xl transition-all disabled:opacity-50"
                            >
                                Keep current theme
                            </button>
                            <button
                                onClick={confirmThemeSwitch}
                                disabled={switchingTheme}
                                className="px-6 py-3 bg-violet-600 hover:bg-violet-700 text-white text-xs font-extrabold uppercase tracking-widest rounded-xl transition-all disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-violet-500/20 hover:scale-102 active:scale-98"
                            >
                                {switchingTheme ? (<><FaSyncAlt className="animate-spin" /> Switching…</>) : (<><FaPalette /> Switch now</>)}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {deleteModalOpen && (
                <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in duration-300">
                    <div className="bg-white/95 backdrop-blur-lg rounded-[32px] p-8 max-w-md w-full shadow-[0_32px_64px_-16px_rgba(0,0,0,0.12)] border border-slate-200/50 transform transition-all scale-100">
                        <div className="flex items-center gap-4 mb-6">
                            <div className="w-14 h-14 rounded-2xl bg-rose-50 border border-rose-100 flex items-center justify-center flex-shrink-0 text-rose-500 shadow-sm">
                                <FaExclamationTriangle className="text-xl" />
                            </div>
                            <h3 className="text-xl font-extrabold text-slate-900">{t('plugins.delete.title')}</h3>
                        </div>

                        <p className="mb-6 text-slate-600 text-xs font-semibold leading-relaxed">
                            {t('plugins.delete.message')} <strong className="text-slate-900 font-extrabold">{pluginToDelete?.name}</strong>?
                        </p>

                        <div className="mb-6 space-y-2">
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                {t('users.password')}
                            </label>
                            <input
                                type="password"
                                className="w-full px-4 py-3 rounded-2xl border border-slate-200 bg-white focus:ring-4 focus:ring-rose-500/10 focus:border-rose-500 outline-none transition-all text-xs font-semibold placeholder-slate-400 shadow-sm"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={t('users.password')}
                                autoFocus
                            />
                            {deleteError && (
                                <p className="text-rose-500 text-xs font-bold flex items-center gap-2 mt-1">
                                    <FaExclamationTriangle className="text-[10px]" /> {deleteError}
                                </p>
                            )}
                        </div>

                        {/* Also drop the plugin's data/tables (rank 2). Default OFF — destructive & irreversible. */}
                        <label className="mb-6 flex items-start gap-3 p-4 rounded-2xl border border-rose-100/40 bg-rose-50/40 cursor-pointer select-none hover:bg-rose-50/60 transition-colors shadow-sm">
                            <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500/20"
                                checked={dropData}
                                onChange={(e) => setDropData(e.target.checked)}
                            />
                            <span className="text-xs text-slate-700 leading-normal font-semibold">
                                <span className="font-extrabold text-rose-700 block mb-0.5">Also delete this plugin&apos;s data / tables</span>
                                <span className="block text-[10px] text-slate-400/90 font-medium">This drops the plugin&apos;s database tables AND its data folder (keys, attachments). Cannot be undone. Leave off to keep both for a future reinstall.</span>
                            </span>
                        </label>

                        <div className="flex justify-end gap-3 pt-2">
                            <button
                                onClick={() => setDeleteModalOpen(false)}
                                className="px-5 py-2.5 text-xs font-extrabold uppercase tracking-widest text-slate-500 hover:text-slate-950 hover:bg-slate-100/80 rounded-xl transition-all"
                            >
                                {t('cancel')}
                            </button>
                            <button
                                onClick={confirmDelete}
                                disabled={!password}
                                className="px-6 py-3 bg-rose-600 text-white rounded-xl text-xs font-extrabold uppercase tracking-widest hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-rose-500/20 hover:shadow-rose-500/40 transition-all hover:scale-102 active:scale-98"
                            >
                                {t('plugins.delete.confirm')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Activation Rejection Modal — structured (missing grants vs hard-blocked dangerous calls) */}
            {rejection && (
                <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
                    <div className="bg-white/95 backdrop-blur-lg rounded-[32px] max-w-lg w-full shadow-[0_32px_64px_-16px_rgba(0,0,0,0.12)] border border-slate-200/50 max-h-[85vh] flex flex-col transform transition-all scale-100">
                        <div className="p-8 pb-4 flex-shrink-0">
                            <div className="flex items-center gap-4">
                                <div className="w-14 h-14 rounded-2xl bg-rose-50 border border-rose-100 flex items-center justify-center flex-shrink-0 text-rose-500 shadow-sm">
                                    <FaShieldAlt className="text-xl" />
                                </div>
                                <div>
                                    <h3 className="text-lg font-extrabold text-slate-900">Activation blocked</h3>
                                    <p className="text-xs text-slate-400 font-semibold mt-0.5">{rejection.pluginName}</p>
                                </div>
                            </div>
                        </div>
                        <div className="px-8 overflow-y-auto flex-1 custom-scrollbar">
                            {(rejection.dangerousCalls && rejection.dangerousCalls.length > 0) && (
                                <div className="mb-6">
                                    <div className="flex items-center gap-2 mb-3 text-rose-800">
                                        <FaBan className="text-xs" />
                                        <h4 className="font-extrabold text-xs uppercase tracking-wider">Blocked — this plugin uses forbidden code</h4>
                                    </div>
                                    <ul className="space-y-2">
                                        {rejection.dangerousCalls.map((d, i) => (
                                            <li key={i} className="text-[11px] text-rose-800 bg-rose-50/50 border border-rose-100/50 rounded-xl px-3.5 py-2.5 font-mono break-words shadow-sm font-semibold">{d}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {(rejection.missingPermissions && rejection.missingPermissions.length > 0) && (
                                <div className="mb-6">
                                    <div className="flex items-center gap-2 mb-3 text-amber-800">
                                        <FaExclamationTriangle className="text-xs" />
                                        <h4 className="font-extrabold text-xs uppercase tracking-wider">Grant these permissions and retry</h4>
                                    </div>
                                    <ul className="space-y-2">
                                        {rejection.missingPermissions.map((m, i) => (
                                            <li key={i} className="text-[11px] text-amber-800 bg-amber-50/50 border border-amber-100/50 rounded-xl px-3.5 py-2.5 font-semibold shadow-sm break-words">{m}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {(!rejection.dangerousCalls || rejection.dangerousCalls.length === 0) &&
                                (!rejection.missingPermissions || rejection.missingPermissions.length === 0) && (
                                    <p className="text-xs text-slate-600 whitespace-pre-wrap mb-4 font-semibold leading-relaxed p-4 bg-slate-50 border border-slate-100 rounded-2xl">{rejection.message || 'Activation failed.'}</p>
                                )}
                        </div>
                        <div className="p-8 pt-6 flex justify-end gap-3 flex-shrink-0 border-t border-slate-100 mt-2">
                            <button
                                onClick={() => setRejection(null)}
                                className="px-6 py-3 bg-slate-900 text-white rounded-xl text-xs font-extrabold uppercase tracking-widest hover:bg-slate-800 shadow-lg shadow-slate-900/10 transition-all hover:scale-102 active:scale-98"
                            >
                                {t('common.close') || 'Close'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Detail Drawer — per-plugin overview, permission diff, runtime health (rank 11) */}
            {detailPlugin && (
                <div className="fixed inset-0 z-50 flex justify-end animate-in fade-in duration-300">
                    <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-sm" onClick={() => setDetailPlugin(null)} />
                    <div className="relative bg-white/95 backdrop-blur-lg w-full max-w-md h-full shadow-[0_0_50px_rgba(0,0,0,0.15)] flex flex-col border-l border-slate-200/50 animate-in slide-in-from-right duration-300">
                        <div className="p-6 border-b border-slate-100 flex items-start justify-between gap-4">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className={`p-3.5 rounded-2xl transition-all duration-300 ${detailPlugin.active ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-100 text-slate-400'}`}>
                                    <FaPlug className="text-lg" />
                                </div>
                                <div className="min-w-0">
                                    <h3 className="text-base font-extrabold text-slate-900 truncate" title={detailPlugin.name}>{detailPlugin.name}</h3>
                                    <p className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">{detailPlugin.slug} · v{detailPlugin.version}</p>
                                </div>
                            </div>
                            <button onClick={() => setDetailPlugin(null)} className="p-2 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-all">
                                <FaTimes className="text-sm" />
                            </button>
                        </div>

                        <div className="p-6 overflow-y-auto flex-1 custom-scrollbar space-y-6">
                            <div>
                                <p className="text-xs text-slate-600 font-semibold leading-relaxed">{detailPlugin.description || 'No description provided.'}</p>
                                {(detailPlugin.author || detailPlugin.homepage) && (
                                    <div className="mt-4 space-y-2 text-xs font-semibold text-slate-500 bg-slate-50 border border-slate-100 rounded-2xl p-4 shadow-sm">
                                        {detailPlugin.author && <div><span className="font-extrabold text-slate-400">Author: </span><span className="text-slate-700">{detailPlugin.author}</span></div>}
                                        {detailPlugin.homepage && (
                                            <div className="flex items-center gap-1">
                                                <span className="font-extrabold text-slate-400">Homepage: </span>
                                                <a href={detailPlugin.homepage} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-700 hover:underline truncate">{detailPlugin.homepage}</a>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Runtime health */}
                            {detailPlugin.active && (
                                <div>
                                    <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2.5">Runtime health</h4>
                                    {detailPlugin.runtime ? (
                                        <div className="rounded-2xl border border-slate-200/60 bg-slate-50/50 p-4 space-y-3 shadow-inner">
                                            {(() => {
                                                const rm = RUNTIME_META[detailPlugin.runtime.state] || RUNTIME_META.stopped;
                                                const rss = fmtMB(detailPlugin.runtime.rssBytes);
                                                return (
                                                    <>
                                                        <div className="flex items-center gap-2">
                                                            <span className={`w-2 h-2 rounded-full relative flex`} title={rm.label}>
                                                                {rm.dot.includes('bg-emerald-500') && (
                                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                                                )}
                                                                {rm.dot.includes('bg-rose-500') && (
                                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                                                                )}
                                                                {rm.dot.includes('bg-amber-500') && (
                                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                                                )}
                                                                <span className={`relative inline-flex rounded-full h-2 w-2 ${rm.dot.split(' ')[0]}`} />
                                                            </span>
                                                            <span className={`text-xs font-extrabold uppercase tracking-wide ${rm.text}`}>{rm.label}</span>
                                                            {detailPlugin.runtime.pid != null && <span className="text-[10px] text-slate-400 font-mono ml-auto">pid {detailPlugin.runtime.pid}</span>}
                                                        </div>
                                                        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-slate-500 font-semibold">
                                                            {rss && <span>RSS: <span className="text-slate-700">{rss}</span></span>}
                                                            {!!detailPlugin.runtime.restarts && <span>restarts: <span className="text-slate-700">{detailPlugin.runtime.restarts}</span></span>}
                                                            {detailPlugin.runtime.lastExitCode != null && <span>last exit: <span className="text-slate-700">{detailPlugin.runtime.lastExitCode}</span></span>}
                                                        </div>
                                                        {detailPlugin.runtime.lastError && (
                                                            <p className="text-[10px] font-mono text-rose-600 bg-rose-50/50 border border-rose-100 rounded-xl p-2.5 break-words font-semibold">{detailPlugin.runtime.lastError}</p>
                                                        )}
                                                    </>
                                                );
                                            })()}
                                            <button
                                                onClick={() => handleRestart(detailPlugin)}
                                                disabled={!!restarting[detailPlugin.slug]}
                                                className="mt-1 inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-widest px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 hover:bg-blue-50 hover:text-blue-600 disabled:opacity-50 transition-all hover:scale-102 active:scale-98 shadow-sm cursor-pointer"
                                            >
                                                <FaSyncAlt className={restarting[detailPlugin.slug] ? 'animate-spin' : ''} /> Reload
                                            </button>
                                        </div>
                                    ) : (
                                        <p className="text-[11px] font-semibold text-slate-400 bg-slate-50 border border-slate-100 rounded-xl p-3.5">No live runtime data (not an isolated plugin).</p>
                                    )}
                                </div>
                            )}

                            {/* Requested vs granted permission diff */}
                            <div>
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2.5">Permissions</h4>
                                {declaredTokens(detailPlugin).length === 0 ? (
                                    <p className="text-[11px] font-semibold text-slate-400 bg-slate-50 border border-slate-100 rounded-xl p-3.5">This plugin requests no permissions.</p>
                                ) : (
                                    <div className="space-y-2">
                                        {declaredTokens(detailPlugin).map((token) => {
                                            const meta = permMeta(token);
                                            const granted = (detailPlugin.grantedPermissions || []).includes(token);
                                            return (
                                                <div key={token} className={`flex items-center justify-between gap-2 rounded-2xl border px-4 py-3 shadow-sm transition-colors ${RISK_CLASSES[meta.risk]}`}>
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <i className={`fas ${meta.icon || 'fa-key'} text-xs opacity-75`} />
                                                            <span className="text-xs font-extrabold text-slate-800">{meta.label}</span>
                                                            <RiskBadge risk={meta.risk} />
                                                        </div>
                                                        <span className="text-[9px] font-mono text-slate-400/80 font-bold block mt-0.5">{token}</span>
                                                    </div>
                                                    <span className={`text-[8px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full shadow-sm ${granted ? 'bg-emerald-600 text-white shadow-emerald-500/10' : 'bg-slate-200 text-slate-600'}`}>
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
                <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in duration-300">
                    <div className="bg-white/95 backdrop-blur-lg rounded-[32px] max-w-lg w-full shadow-[0_32px_64px_-16px_rgba(0,0,0,0.12)] border border-slate-200/50 max-h-[85vh] flex flex-col transform transition-all scale-100">

                        {/* Header - Fixed */}
                        <div className="p-8 pb-4 flex-shrink-0">
                            <div className="flex items-center gap-4 text-blue-600">
                                <div className="w-14 h-14 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0 text-blue-600 shadow-sm">
                                    <FaPlug className="text-xl" />
                                </div>
                                <h3 className="text-xl font-extrabold text-slate-900">{t('plugins.permissions')}</h3>
                            </div>
                        </div>

                        {/* Scrollable Content */}
                        <div className="px-8 overflow-y-auto flex-1 custom-scrollbar">
                            <p className="mb-5 text-slate-600 text-xs font-semibold leading-relaxed">
                                {t('plugins.requests.permissions')} <strong className="text-slate-900 font-extrabold">{pluginToActivate.name}</strong>:
                            </p>

                            <div className="space-y-3 mb-5">
                                {declaredTokens(pluginToActivate).length > 0 ? (
                                    declaredTokens(pluginToActivate).map((token) => (
                                        <PermissionRow key={token} token={token} reason={reasonFor(pluginToActivate, token)} />
                                    ))
                                ) : (
                                    <div className="flex flex-col items-center justify-center p-8 bg-emerald-50/55 rounded-[24px] border border-emerald-100/60 text-center shadow-sm">
                                        <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-sm mb-3 text-emerald-500">
                                            <FaCheck className="text-sm" />
                                        </div>
                                        <p className="text-emerald-800 font-extrabold text-sm">{t('plugins.safe.to.activate')}</p>
                                        <p className="text-emerald-600 text-[10px] font-semibold mt-1">{t('plugins.no.permissions')}</p>
                                    </div>
                                )}
                            </div>

                            <p className="text-[10px] text-slate-400/90 mb-2 p-3 bg-blue-50/45 rounded-xl border border-blue-100/50 italic leading-relaxed font-semibold">
                                By activating this plugin, you are granting it strict access to these system capabilities.
                            </p>
                        </div>

                        {/* Footer - Fixed */}
                        <div className="p-8 pt-6 flex justify-end gap-3 flex-shrink-0 border-t border-slate-100 mt-2">
                            <button
                                onClick={() => {
                                    setPermissionModalOpen(false);
                                    setPluginToActivate(null);
                                }}
                                className="px-5 py-2.5 text-xs font-extrabold uppercase tracking-widest text-slate-500 hover:text-slate-950 hover:bg-slate-100/80 rounded-xl transition-all"
                            >
                                {t('cancel')}
                            </button>
                            <button
                                onClick={confirmActivate}
                                className="px-6 py-3 bg-blue-600 text-white rounded-xl text-xs font-extrabold uppercase tracking-widest hover:bg-blue-700 shadow-lg shadow-blue-500/20 hover:shadow-blue-500/40 transition-all hover:scale-102 active:scale-98"
                            >
                                {t('plugins.confirm.activate')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Manage Permissions Modal — Android-style per-permission grants (default-deny) */}
            {permsModalPlugin && (
                <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-300">
                    <div className="bg-white/95 backdrop-blur-lg rounded-[32px] max-w-lg w-full shadow-[0_32px_64px_-16px_rgba(0,0,0,0.12)] border border-slate-200/50 max-h-[85vh] flex flex-col transform transition-all scale-100">
                        <div className="p-8 pb-4 flex-shrink-0">
                            <div className="flex items-center gap-4 text-blue-600">
                                <div className="w-14 h-14 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0 text-blue-600 shadow-sm"><FaSlidersH className="text-xl" /></div>
                                <div>
                                    <h3 className="text-xl font-extrabold text-slate-900">Permissions</h3>
                                    <p className="text-xs text-slate-400 font-semibold mt-0.5">{permsModalPlugin.name}</p>
                                </div>
                            </div>
                        </div>
                        <div className="px-8 overflow-y-auto flex-1 custom-scrollbar">
                            <p className="mb-4 text-slate-500 text-xs font-semibold leading-relaxed">Grant only what this plugin needs. Anything left off is <strong className="text-slate-800">denied</strong> (default-deny) — the plugin can use a capability only if it both requested it and you grant it here.</p>

                            <div className="space-y-2 mb-4">
                                {declaredTokens(permsModalPlugin).length === 0 ? (
                                    <div className="p-6 bg-slate-50 border border-slate-100 rounded-2xl text-slate-400 text-xs font-semibold text-center">This plugin declares no permissions — it can&apos;t access anything beyond its own sandbox.</div>
                                ) : declaredTokens(permsModalPlugin).map((token) => {
                                    const on = grantDraft.has(token);
                                    const meta = permMeta(token);
                                    const highRisk = meta.risk === 'high';
                                    const activeClasses = highRisk ? 'bg-rose-50/80 border-rose-200/70 shadow-sm' : meta.risk === 'med' ? 'bg-amber-50/80 border-amber-200/70 shadow-sm' : 'bg-emerald-50/85 border-emerald-200/70 shadow-sm';
                                    const knobOn = highRisk ? 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.3)]' : meta.risk === 'med' ? 'bg-amber-500 shadow-[0_0_6px_rgba(251,191,36,0.3)]' : 'bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.3)]';
                                    const reason = reasonFor(permsModalPlugin, token);
                                    return (
                                        <div key={token} className={`rounded-2xl border transition-all duration-300 ${on ? activeClasses : 'bg-slate-50/50 border-slate-200/60 hover:bg-slate-50'}`}>
                                            <button
                                                onClick={() => toggleGrant(token)}
                                                className="w-full flex items-start justify-between gap-3 p-4 text-left cursor-pointer"
                                            >
                                                <span className="min-w-0">
                                                    <span className="flex items-center gap-2 flex-wrap">
                                                        <i className={`fas ${meta.icon || 'fa-key'} text-xs opacity-75`} />
                                                        <span className="font-extrabold text-sm text-slate-800">{meta.label}</span>
                                                        <RiskBadge risk={meta.risk} />
                                                        <span className="text-[10px] font-mono text-slate-400/80 font-bold">{token}</span>
                                                    </span>
                                                    {meta.description && <span className="block text-xs text-slate-600 font-medium leading-relaxed mt-1.5">{meta.description}</span>}
                                                    {reason && <span className="block text-xs text-slate-500 font-semibold leading-relaxed mt-1.5 italic"><span className="not-italic font-bold text-slate-400">Plugin says: </span>{reason}</span>}
                                                </span>
                                                <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-300 shrink-0 mt-0.5 ${on ? knobOn.split(' ')[0] : 'bg-slate-300'}`}>
                                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-300 ${on ? 'translate-x-6' : 'translate-x-1'} shadow-sm`} />
                                                </span>
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                        <div className="p-8 pt-6 flex justify-end gap-3 flex-shrink-0 border-t border-slate-100 mt-2">
                            <button onClick={() => setPermsModalPlugin(null)} className="px-5 py-2.5 text-xs font-extrabold uppercase tracking-widest text-slate-500 hover:text-slate-950 hover:bg-slate-100/80 rounded-xl transition-all">Cancel</button>
                            <button onClick={savePermissions} disabled={savingPerms} className="px-6 py-3 bg-blue-600 text-white rounded-xl text-xs font-extrabold uppercase tracking-widest hover:bg-blue-700 disabled:opacity-50 shadow-lg shadow-blue-500/20 hover:shadow-blue-500/40 transition-all hover:scale-102 active:scale-98">
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

            {/* Installed | Marketplace tabs */}
            <div className="relative z-10 inline-flex p-1 bg-slate-200/50 backdrop-blur-md rounded-2xl border border-slate-200/40 mb-8 shadow-sm">
                <button
                    onClick={() => setTab('installed')}
                    className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all duration-300 flex items-center gap-2 ${tab === 'installed' ? 'bg-white text-slate-900 shadow-md border border-slate-100/50' : 'text-slate-500 hover:text-slate-800'}`}
                >
                    <FaPlug className="text-xs" /> {t('plugins.tab.installed')}
                </button>
                <button
                    onClick={() => setTab('marketplace')}
                    className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all duration-300 flex items-center gap-2 ${tab === 'marketplace' ? 'bg-white text-slate-900 shadow-md border border-slate-100/50' : 'text-slate-500 hover:text-slate-800'}`}
                >
                    <FaStore className="text-xs" /> {t('plugins.tab.marketplace')}
                </button>
            </div>

            {/* Marketplace view */}
            {tab === 'marketplace' && (
                <div className="relative z-10">
                    <MarketplaceTab onInstalled={loadPlugins} />
                </div>
            )}

            {/* Search + status filter (rank 11) */}
            {tab === 'installed' && !loading && plugins.length > 0 && (
                <div className="relative z-10 mb-8 flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between">
                    <div className="relative flex-1 max-w-md">
                        <FaSearch className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs" />
                        <input
                            type="text"
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            placeholder="Search plugins…"
                            className="w-full pl-10 pr-4 py-3 rounded-2xl border border-slate-200/60 bg-white/50 backdrop-blur-md focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all text-xs font-semibold placeholder-slate-400 shadow-sm"
                        />
                    </div>
                    <div className="flex p-1 bg-slate-200/40 backdrop-blur-md rounded-2xl border border-slate-200/30 shadow-sm">
                        {(['all', 'active', 'inactive'] as const).map((f) => (
                            <button
                                key={f}
                                onClick={() => setStatusFilter(f)}
                                className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all duration-300 ${statusFilter === f ? 'bg-white text-slate-900 shadow-sm border border-slate-100/50' : 'text-slate-500 hover:text-slate-800'}`}
                            >
                                {t(`plugins.filter.${f}`)}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Plugin Grid */}
            <div className="relative z-10">
                {tab === 'marketplace' ? null : loading ? (
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
                                    group relative rounded-[24px] p-6 transition-all duration-500 border
                                    ${plugin.active
                                        ? 'bg-gradient-to-b from-white/95 to-slate-50/90 border-blue-200/60 shadow-[0_15px_30px_-5px_rgba(37,99,235,0.06)] shadow-blue-500/5'
                                        : 'bg-gradient-to-b from-white/60 to-white/30 border-slate-200/50 shadow-[0_10px_20px_-10px_rgba(0,0,0,0.02)] hover:bg-gradient-to-b hover:from-white/85 hover:to-white/65'}
                                    backdrop-blur-xl hover:-translate-y-1.5 hover:shadow-[0_20px_40px_-15px_rgba(0,0,0,0.08)] hover:border-slate-300/80
                                `}
                            >
                                <div className="flex justify-between items-start mb-4">
                                    <div className={`p-3.5 rounded-2xl transition-all duration-300 ${plugin.active ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-[0_8px_16px_rgba(37,99,235,0.25)]' : 'bg-slate-100 text-slate-400 group-hover:bg-slate-200/80 group-hover:text-slate-500'}`}>
                                        <FaPlug className="text-lg" />
                                    </div>
                                    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-1 group-hover:translate-y-0">
                                        <button
                                            onClick={() => setDetailPlugin(plugin)}
                                            className="p-2 rounded-xl bg-slate-50 border border-slate-200/60 text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 hover:scale-105 active:scale-95 transition-all shadow-sm"
                                            title="Details"
                                        >
                                            <FaInfoCircle className="text-sm" />
                                        </button>
                                        {!plugin.active && (
                                            <>
                                                <button
                                                    onClick={() => pluginsApi.download(plugin.slug)}
                                                    className="p-2 rounded-xl bg-slate-50 border border-slate-200/60 text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 hover:scale-105 active:scale-95 transition-all shadow-sm"
                                                    title="Download Source"
                                                >
                                                    <FaDownload className="text-sm" />
                                                </button>
                                                <button
                                                    onClick={() => initiateDelete(plugin)}
                                                    className="p-2 rounded-xl bg-rose-50 border border-rose-100 text-rose-500 hover:bg-rose-100 hover:border-rose-200 hover:scale-105 active:scale-95 transition-all shadow-sm"
                                                    title="Delete Plugin"
                                                >
                                                    <FaTrash className="text-sm" />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>

                                <h3 className="text-lg font-extrabold text-slate-900 mb-1.5 group-hover:text-blue-600 transition-colors duration-300 line-clamp-1" title={plugin.name}>
                                    {plugin.name}
                                </h3>
                                <p className="text-slate-500 text-xs mb-4 h-9 line-clamp-2 leading-relaxed font-medium">
                                    {plugin.description || "No description provided."}
                                </p>

                                {/* Runtime health (rank 1) — only for active plugins with runtime data */}
                                {plugin.active && rm && (
                                    <div className="mb-4 rounded-[16px] border border-slate-100 bg-slate-50/50 backdrop-blur-sm px-4 py-3 shadow-[inset_0_2px_4px_rgba(0,0,0,0.01)]">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span className={`w-2 h-2 rounded-full shrink-0 relative flex`} title={rm.label}>
                                                    {rm.dot.includes('bg-emerald-500') && (
                                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                                    )}
                                                    {rm.dot.includes('bg-rose-500') && (
                                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                                                    )}
                                                    {rm.dot.includes('bg-amber-500') && (
                                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                                    )}
                                                    <span className={`relative inline-flex rounded-full h-2 w-2 ${rm.dot.split(' ')[0]}`} />
                                                </span>
                                                <span className={`text-[11px] font-extrabold tracking-wide uppercase ${rm.text}`}>{rm.label}</span>
                                                <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-medium">
                                                    {rss && (
                                                        <>
                                                            <span>•</span>
                                                            <span>{rss}</span>
                                                        </>
                                                    )}
                                                    {!!plugin.runtime?.restarts && (
                                                        <>
                                                            <span>•</span>
                                                            <span>{plugin.runtime.restarts} restarts</span>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => handleRestart(plugin)}
                                                disabled={!!restarting[plugin.slug]}
                                                title="Restart plugin"
                                                className="p-1.5 rounded-xl text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 disabled:opacity-50 transition-all hover:scale-105 active:scale-95 border border-transparent hover:border-slate-200/50 shadow-sm"
                                            >
                                                <FaSyncAlt className={`text-[10px] ${restarting[plugin.slug] ? 'animate-spin' : ''}`} />
                                            </button>
                                        </div>
                                        {isCrashLooping && plugin.runtime?.lastError && (
                                            <p className="text-[10px] text-red-600 bg-red-50/50 border border-red-100 rounded-lg p-2 mt-2 font-mono break-words line-clamp-2" title={plugin.runtime.lastError}>{plugin.runtime.lastError}</p>
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
                                                        className={`text-[9px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded-full border ${RISK_CLASSES[meta.risk]}`}
                                                    >
                                                        {p.scope === 'network' ? 'network' : `${p.scope}:${p.access}`}
                                                    </span>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                <div className="flex items-center justify-between pt-4 border-t border-slate-100/80">
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider bg-slate-50 border border-slate-100 px-2 py-1 rounded-lg">
                                            v{plugin.version}
                                        </span>
                                        <button
                                            onClick={() => openPermissions(plugin)}
                                            title="Manage what this plugin can access (per-permission grants)"
                                            className="text-[9px] font-extrabold uppercase tracking-widest px-2.5 py-1.5 rounded-lg border flex items-center gap-1 transition-all bg-slate-50 hover:bg-blue-50 hover:text-blue-600 text-slate-500 border-slate-200/60 shadow-sm hover:scale-105 active:scale-95"
                                        >
                                            <FaSlidersH className="text-[10px]" /> Permissions
                                        </button>
                                        {plugin.hasTheme && (
                                            <button
                                                onClick={() => handleInstallTheme(plugin)}
                                                disabled={plugin.themeInstalled || !!installingTheme[plugin.slug]}
                                                title={plugin.themeInstalled
                                                    ? "This plugin's theme is already installed (manage it in Appearance → Themes)"
                                                    : "Install this plugin's theme"}
                                                className="text-[9px] font-extrabold uppercase tracking-widest px-2.5 py-1.5 rounded-lg border flex items-center gap-1 transition-all bg-slate-50 hover:bg-violet-50 hover:text-violet-600 text-slate-500 border-slate-200/60 shadow-sm hover:scale-105 active:scale-95 disabled:opacity-60 disabled:hover:scale-100 disabled:hover:bg-slate-50 disabled:hover:text-slate-500"
                                            >
                                                {installingTheme[plugin.slug]
                                                    ? (<><FaSyncAlt className="text-[10px] animate-spin" /> Installing…</>)
                                                    : plugin.themeInstalled
                                                        ? (<><FaCheck className="text-[10px]" /> Theme installed</>)
                                                        : (<><FaPalette className="text-[10px]" /> Install theme</>)}
                                            </button>
                                        )}
                                    </div>

                                    <button
                                        onClick={() => togglePlugin(plugin)}
                                        className={`
                                            px-4 py-2 rounded-xl font-extrabold text-xs uppercase tracking-wider flex items-center gap-2 transition-all duration-300 shadow-sm hover:scale-105 active:scale-95
                                            ${plugin.active
                                                ? 'bg-rose-50 text-rose-600 border border-rose-200/40 hover:bg-rose-600 hover:text-white hover:shadow-lg hover:shadow-rose-500/20'
                                                : 'bg-emerald-50 text-emerald-600 border border-emerald-200/40 hover:bg-emerald-600 hover:text-white hover:shadow-lg hover:shadow-emerald-500/20'}
                                        `}
                                    >
                                        {plugin.active ? (
                                            <>
                                                <FaPowerOff className="text-[10px]" /> {t('plugins.deactivate')}
                                            </>
                                        ) : (
                                            <>
                                                <FaCheck className="text-[10px]" /> {t('plugins.activate')}
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

"use client";

import { useEffect, useState } from "react";
import { pluginsApi, Plugin } from "@/lib/api";
import { useMenu } from "@/contexts/MenuContext";
import { useToast } from "@/contexts/ToastContext";
import { FaPlug, FaUpload, FaTrash, FaDownload, FaPowerOff, FaCheck, FaExclamationTriangle, FaBoxOpen } from "react-icons/fa";

export default function PluginsPage() {
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

    const { addToast } = useToast();

    useEffect(() => {
        loadPlugins();
    }, []);

    const loadPlugins = async () => {
        try {
            const data = await pluginsApi.list();
            setPlugins(data);
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
                addToast(`Plugin deactivated`, "success");
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
        try {
            await pluginsApi.activate(pluginToActivate.slug);
            setPermissionModalOpen(false);
            setPluginToActivate(null);
            loadPlugins();
            refreshMenus();
            addToast(`Plugin activated`, "success");
        } catch (error: any) {
            console.error("Failed to activate plugin:", error);
            addToast("Activation failed: " + (error.message || "Unknown error"), "error");
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.name.endsWith('.zip')) {
            addToast("Please select a .zip file", "error");
            return;
        }

        setUploading(true);
        const formData = new FormData();
        formData.append('plugin', file);

        try {
            await pluginsApi.upload(formData);
            addToast("Plugin uploaded successfully!", "success");
            loadPlugins();
            refreshMenus();
        } catch (error: any) {
            console.error("Upload failed:", error);
            addToast("Failed to upload plugin: " + (error.message || "Unknown error"), "error");
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
    };

    const confirmDelete = async () => {
        if (!pluginToDelete || !password) return;

        try {
            await pluginsApi.delete(pluginToDelete.slug, password);
            setDeleteModalOpen(false);
            setPluginToDelete(null);
            setPassword("");
            loadPlugins();
            refreshMenus();
            addToast("Plugin deleted successfully", "success");
        } catch (error: any) {
            console.error("Failed to delete plugin:", error);
            setDeleteError(error.message || "Failed to delete plugin");
        }
    };

    return (
        <div className="min-h-full p-8 relative overflow-hidden">
            {/* Animated Background */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0 pointer-events-none">
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
                            <h3 className="text-xl font-bold text-gray-900">Delete Plugin?</h3>
                        </div>

                        <p className="mb-6 text-gray-600 leading-relaxed">
                            Are you sure you want to delete <strong className="text-gray-900">{pluginToDelete?.name}</strong>?
                            This action cannot be undone and will remove all plugin files.
                        </p>

                        <div className="mb-6 space-y-2">
                            <label className="block text-sm font-bold text-gray-700 uppercase tracking-wider">
                                Confirm Password
                            </label>
                            <input
                                type="password"
                                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-4 focus:ring-red-100 focus:border-red-500 outline-none transition-all"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Enter your admin password"
                                autoFocus
                            />
                            {deleteError && (
                                <p className="text-red-500 text-sm font-medium flex items-center gap-2">
                                    <FaExclamationTriangle /> {deleteError}
                                </p>
                            )}
                        </div>

                        <div className="flex justify-end gap-3 pt-2">
                            <button
                                onClick={() => setDeleteModalOpen(false)}
                                className="px-5 py-2.5 text-gray-600 hover:text-gray-900 font-medium hover:bg-gray-100 rounded-xl transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmDelete}
                                disabled={!password}
                                className="px-5 py-2.5 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-red-500/30 transition-all transform hover:-translate-y-0.5"
                            >
                                Delete Forever
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Plugin Permissions Modal */}
            {permissionModalOpen && pluginToActivate && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl p-8 max-w-lg w-full shadow-2xl transform transition-all scale-100 border border-white/20">
                        <div className="flex items-center gap-4 mb-6 text-blue-600">
                            <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                                <FaPlug className="text-xl" />
                            </div>
                            <h3 className="text-xl font-bold text-gray-900">Authorize Plugin</h3>
                        </div>

                        <p className="mb-4 text-gray-600 leading-relaxed">
                            The plugin <strong className="text-gray-900">{pluginToActivate.name}</strong> requests the following permissions to function:
                        </p>

                        <div className="space-y-3 mb-8">
                            {pluginToActivate.permissions && pluginToActivate.permissions.length > 0 ? (
                                pluginToActivate.permissions.map((p, idx) => (
                                    <div key={idx} className="flex gap-3 p-4 bg-gray-50 rounded-xl border border-gray-100">
                                        <div className={`w-2 h-2 rounded-full mt-2 shrink-0 ${p.scope === 'database' ? 'bg-purple-500' :
                                            p.scope === 'filesystem' ? 'bg-orange-500' : 'bg-blue-500'
                                            }`} />
                                        <div>
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="font-bold text-sm text-gray-800 uppercase tracking-tight">{p.scope}</span>
                                                <span className="text-[10px] bg-white border border-gray-200 px-1.5 py-0.5 rounded text-gray-400 font-bold uppercase">{p.access}</span>
                                            </div>
                                            <p className="text-sm text-gray-500 leading-snug">{p.reason}</p>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="flex flex-col items-center justify-center p-8 bg-green-50 rounded-2xl border border-green-100 text-center">
                                    <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center shadow-sm mb-3">
                                        <FaCheck className="text-green-500" />
                                    </div>
                                    <p className="text-green-800 font-bold text-sm">Safe to Activate</p>
                                    <p className="text-green-600 text-xs mt-1">This plugin requests no special system-level permissions.</p>
                                </div>
                            )}
                        </div>

                        <p className="text-xs text-gray-400 mb-8 p-3 bg-blue-50/50 rounded-lg border border-blue-100/50 italic">
                            By activating this plugin, you are granting it strict access to these system capabilities.
                        </p>

                        <div className="flex justify-end gap-3 pt-2">
                            <button
                                onClick={() => {
                                    setPermissionModalOpen(false);
                                    setPluginToActivate(null);
                                }}
                                className="px-5 py-2.5 text-gray-600 hover:text-gray-900 font-medium hover:bg-gray-100 rounded-xl transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmActivate}
                                className="px-6 py-2.5 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 shadow-lg hover:shadow-blue-500/30 transition-all transform hover:-translate-y-0.5"
                            >
                                Confirm and Activate
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10">
                <div>
                    <h1 className="text-4xl font-black text-gray-900 tracking-tight font-oswald mb-2 flex items-center gap-3">
                        <FaPlug className="text-blue-600" />
                        Plugins
                    </h1>
                    <p className="text-lg text-gray-500 font-medium">Extend your site's functionality</p>
                </div>

                <div>
                    <label
                        className={`
                            group cursor-pointer px-6 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white 
                            hover:from-blue-700 hover:to-indigo-700 transition-all duration-300 
                            flex items-center gap-3 shadow-lg hover:shadow-blue-500/30 transform hover:-translate-y-0.5 font-bold
                            ${uploading ? 'opacity-70 cursor-wait' : ''}
                        `}
                    >
                        {uploading ? (
                            <>
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                <span>Installing...</span>
                            </>
                        ) : (
                            <>
                                <FaUpload className="group-hover:scale-110 transition-transform" />
                                <span>Upload Plugin</span>
                            </>
                        )}
                        <input
                            type="file"
                            accept=".zip"
                            className="hidden"
                            onChange={handleUpload}
                            disabled={uploading}
                        />
                    </label>
                </div>
            </div>

            {/* Plugin Grid */}
            <div className="relative z-10">
                {loading ? (
                    <div className="glass-panel rounded-3xl p-12 text-center text-gray-400">
                        <div className="w-16 h-16 border-4 border-blue-100 border-t-blue-500 rounded-full animate-spin mx-auto mb-4"></div>
                        <p className="font-medium">Loading your plugins...</p>
                    </div>
                ) : plugins.length === 0 ? (
                    <div className="glass-panel rounded-3xl p-16 text-center">
                        <div className="w-24 h-24 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-6 text-gray-300">
                            <FaBoxOpen className="text-5xl" />
                        </div>
                        <h3 className="text-2xl font-bold text-gray-800 mb-2">No plugins installed</h3>
                        <p className="text-gray-500 max-w-md mx-auto">
                            Get started by uploading your first plugin using the button above.
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                        {plugins.map((plugin) => (
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

                                {/* Permissions section */}
                                {plugin.permissions && plugin.permissions.length > 0 && (
                                    <div className="mb-6">
                                        <div className="flex flex-wrap gap-1.5">
                                            {plugin.permissions.map((p, idx) => (
                                                <span
                                                    key={idx}
                                                    title={p.reason}
                                                    className={`
                                                        text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border
                                                        ${p.scope === 'database' ? 'bg-purple-50 text-purple-600 border-purple-100' :
                                                            p.scope === 'filesystem' ? 'bg-orange-50 text-orange-600 border-orange-100' :
                                                                'bg-blue-50 text-blue-600 border-blue-100'}
                                                    `}
                                                >
                                                    {p.scope}:{p.access}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                                    <span className="text-xs font-bold text-gray-400 uppercase tracking-wider bg-gray-50 px-2 py-1 rounded-md">
                                        v{plugin.version}
                                    </span>

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
                                                <FaPowerOff /> Deactivate
                                            </>
                                        ) : (
                                            <>
                                                <FaCheck /> Activate
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

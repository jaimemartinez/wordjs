"use client";

import { useEffect, useState, useRef } from "react";
import { themesApi, Theme } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader, Button, EmptyState } from "@/components/ui";

export default function ThemesPage() {
    const [themes, setThemes] = useState<Theme[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const { confirm } = useModal();

    useEffect(() => {
        loadThemes();
    }, []);

    const loadThemes = async () => {
        try {
            const data = await themesApi.list();
            setThemes(data);
        } catch (error) {
            console.error("Failed to load themes:", error);
        } finally {
            setLoading(false);
        }
    };

    const activateTheme = async (slug: string) => {
        try {
            await themesApi.activate(slug);
            loadThemes();
            setMessage({ type: "success", text: "Theme activated successfully!" });
        } catch (error) {
            console.error("Failed to activate theme:", error);
            setMessage({ type: "error", text: "Failed to activate theme" });
        }
    };

    const handleDownload = (slug: string) => {
        themesApi.download(slug);
    };

    const handleDelete = async (slug: string) => {
        if (!await confirm("Are you sure you want to delete this theme? This action cannot be undone.", "Delete Theme", true)) return;

        try {
            await themesApi.delete(slug);
            setMessage({ type: "success", text: "Theme deleted successfully!" });
            loadThemes();
        } catch (error: any) {
            setMessage({ type: "error", text: error.message || "Failed to delete theme" });
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        setUploadProgress(0);
        setMessage(null);

        try {
            const result = await themesApi.upload(file, (progress) => {
                setUploadProgress(progress);
            });
            setMessage({ type: "success", text: result.message });
            loadThemes();
        } catch (error: any) {
            setMessage({ type: "error", text: error.message || "Upload failed" });
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50">
            {/* Header Section */}
            <div className="max-w-7xl mx-auto">
                <PageHeader
                    title="Themes"
                    subtitle="Personalize the look and feel of your public site."
                    actions={
                        <>
                            <Button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={uploading}
                                loading={uploading}
                                icon={uploading ? undefined : "fa-plus-circle"}
                            >
                                {uploading ? `${Math.round(uploadProgress)}%` : 'Install Theme'}
                            </Button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".zip"
                                onChange={handleUpload}
                                className="hidden"
                            />
                        </>
                    }
                />

                {message && (
                    <div className={`
                    max-w-7xl mx-auto mb-8 p-5 rounded-2xl flex items-center gap-4 animate-in fade-in slide-in-from-top-4 duration-300
                    ${message.type === "success"
                            ? "bg-emerald-50 border border-emerald-100 text-emerald-700"
                            : "bg-rose-50 border border-rose-100 text-rose-700"
                        }
                `}>
                        <i className={`fa-solid ${message.type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'} text-xl`}></i>
                        <p className="font-bold">{message.text}</p>
                    </div>
                )}

                <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-10 pb-20">
                    {loading ? (
                        Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="bg-gray-100 rounded-[32px] h-[420px] animate-pulse"></div>
                        ))
                    ) : themes.length === 0 ? (
                        <div className="col-span-full">
                            <EmptyState
                                icon="fa-palette"
                                title="No themes found"
                                description="Upload your first theme to get started."
                            />
                        </div>
                    ) : (
                        themes.map((theme, index) => (
                            <div
                                key={theme.slug}
                                className={`
                                group bg-white rounded-[40px] border transition-all duration-500 relative flex flex-col h-full overflow-hidden
                                animate-in fade-in slide-in-from-bottom-8 fill-mode-both
                                ${theme.active
                                        ? "border-blue-500/50 shadow-[0_25px_60px_-15px_rgba(59,130,246,0.15)] ring-1 ring-blue-500/20"
                                        : "border-gray-200 shadow-[0_15px_40px_-15px_rgba(0,0,0,0.04)] hover:shadow-[0_30px_70px_-15px_rgba(0,0,0,0.08)] hover:-translate-y-2"
                                    }
                            `}
                                style={{ animationDelay: `${index * 100}ms` }}
                            >
                                {/* Theme Preview */}
                                <div className="aspect-[4/3] overflow-hidden relative">
                                    {theme.screenshot ? (
                                        <img
                                            src={theme.screenshot}
                                            alt={theme.name}
                                            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                                        />
                                    ) : (
                                        <div className="w-full h-full bg-gradient-to-br from-indigo-50 via-white to-blue-50 flex items-center justify-center relative">
                                            <div className="absolute inset-0 opacity-[0.03] pattern-grid-lg"></div>
                                            <div className="w-20 h-20 rounded-3xl bg-white shadow-xl flex items-center justify-center text-3xl text-blue-500 relative z-10 border border-blue-50 hover:rotate-12 transition-transform duration-500">
                                                <i className="fa-solid fa-palette"></i>
                                            </div>
                                        </div>
                                    )}

                                    {theme.active && (
                                        <div className="absolute top-6 right-6">
                                            <div className="bg-blue-600 text-white px-5 py-2.5 rounded-full text-xs font-black uppercase tracking-widest flex items-center gap-2 shadow-lg shadow-blue-500/50 border border-blue-400/30 backdrop-blur-md">
                                                <span className="flex h-1.5 w-1.5 rounded-full bg-white animate-pulse"></span>
                                                Active
                                            </div>
                                        </div>
                                    )}

                                    {/* Overlay Gradient */}
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                                </div>

                                {/* Theme Info */}
                                <div className="p-8 flex-1 flex flex-col">
                                    <div className="mb-4">
                                        <div className="flex items-center justify-between gap-4 mb-2">
                                            <h3 className="text-2xl font-black text-gray-900 group-hover:text-blue-600 transition-colors truncate">
                                                {theme.name}
                                            </h3>
                                            <span className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] bg-gray-50 px-2 py-1 rounded-md">
                                                v{theme.version}
                                            </span>
                                        </div>
                                        <p className="text-gray-500 font-medium text-sm leading-relaxed line-clamp-2">
                                            {theme.description || "A beautiful look for your WordJS site with modern aesthetics."}
                                        </p>
                                    </div>

                                    <div className="mt-auto pt-6 flex flex-col gap-3">
                                        <div className="flex items-center justify-between text-xs font-bold text-gray-400 mb-2">
                                            <span>BY <span className="text-gray-900">{theme.author || 'WordJS'}</span></span>
                                        </div>

                                        {!theme.active ? (
                                            <button
                                                onClick={() => activateTheme(theme.slug)}
                                                className="w-full bg-gray-900 text-white font-black py-4 rounded-2xl transition-all duration-300 hover:bg-blue-600 hover:shadow-xl hover:shadow-blue-500/30 active:scale-95 flex items-center justify-center gap-2"
                                            >
                                                Activate Theme
                                                <i className="fa-solid fa-arrow-right text-xs opacity-50 group-hover:translate-x-1 transition-transform"></i>
                                            </button>
                                        ) : (
                                            <button
                                                className="w-full bg-blue-50 text-blue-600 font-black py-4 rounded-2xl flex items-center justify-center gap-2 border border-blue-100 cursor-default"
                                            >
                                                Currently In Use
                                            </button>
                                        )}

                                        {!theme.active && (
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => handleDownload(theme.slug)}
                                                    className="flex-1 bg-gray-50 text-gray-600 font-bold py-3 rounded-xl hover:bg-gray-100 transition-all flex items-center justify-center gap-2 text-sm"
                                                    title="Download ZIP"
                                                >
                                                    <i className="fa-solid fa-download text-xs opacity-50"></i>
                                                    Download
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(theme.slug)}
                                                    className="aspect-square bg-rose-50 text-rose-500 font-bold p-3 rounded-xl hover:bg-rose-500 hover:text-white transition-all flex items-center justify-center"
                                                    title="Delete Theme"
                                                >
                                                    <i className="fa-solid fa-trash-can text-sm"></i>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}


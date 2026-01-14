"use client";

import { useEffect, useState, useRef } from "react";
import { themesApi, Theme } from "@/lib/api";

export default function ThemesPage() {
    const [themes, setThemes] = useState<Theme[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

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
        <div className="p-6 h-full overflow-auto">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold text-gray-800">Themes</h1>
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                    {uploading ? (
                        <>
                            <i className="fa-solid fa-spinner animate-spin"></i>
                            Uploading... {Math.round(uploadProgress)}%
                        </>
                    ) : (
                        <>
                            <i className="fa-solid fa-upload"></i>
                            Upload Theme
                        </>
                    )}
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip"
                    onChange={handleUpload}
                    className="hidden"
                />
            </div>

            {message && (
                <div className={`mb-4 p-4 rounded-lg ${message.type === "success" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    {message.text}
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {loading ? (
                    <div className="col-span-full text-center text-gray-500 py-8">
                        Loading...
                    </div>
                ) : themes.length === 0 ? (
                    <div className="col-span-full text-center text-gray-500 py-8">
                        No themes found
                    </div>
                ) : (
                    themes.map((theme) => (
                        <div
                            key={theme.slug}
                            className={`bg-white rounded-lg shadow overflow-hidden ${theme.active ? "ring-2 ring-blue-500" : ""
                                }`}
                        >
                            <div className="h-40 bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center">
                                <i className="fa-solid fa-palette text-white text-6xl opacity-50"></i>
                            </div>
                            <div className="p-4">
                                <div className="flex items-center justify-between mb-2">
                                    <h3 className="text-lg font-medium text-gray-800">
                                        {theme.name}
                                    </h3>
                                    {theme.active && (
                                        <span className="bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded">
                                            Active
                                        </span>
                                    )}
                                </div>
                                <p className="text-gray-500 text-sm mb-4">
                                    {theme.description || "No description"}
                                </p>
                                {!theme.active && (
                                    <button
                                        onClick={() => activateTheme(theme.slug)}
                                        className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg transition-colors"
                                    >
                                        Activate
                                    </button>
                                )}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}


// @ts-nocheck
"use client";

// Admin page for __NAME__ — rendered inside the WordJS admin at /admin/plugin/__SLUG__
// (declared in manifest.frontend.adminPage). The `// @ts-nocheck` on line 1 is REQUIRED for
// committed plugin client files: the frontend CI type-checks the generated registries, which
// import this file directly from backend/plugins/.
//
// After activating the plugin, regenerate the admin registry so this page is picked up:
//   node frontend/scripts/generate-admin-plugin-registry.js

import { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

interface Item {
    id: string;
    title: string;
    createdAt?: string;
}

export default function __PASCAL__AdminPage() {
    const [items, setItems] = useState<Item[]>([]);
    const [title, setTitle] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        setLoading(true);
        try {
            const data = await api<Item[]>("/plugin/__SLUG__");
            setItems(Array.isArray(data) ? data : []);
            setError(null);
        } catch (err: any) {
            setError(err?.message || "Failed to load items");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const addItem = async () => {
        if (!title.trim() || saving) return;
        setSaving(true);
        try {
            await apiPost("/plugin/__SLUG__", { title: title.trim() });
            setTitle("");
            await load();
        } catch (err: any) {
            setError(err?.message || "Failed to save item");
        } finally {
            setSaving(false);
        }
    };

    const removeItem = async (id: string) => {
        try {
            await apiDelete(`/plugin/__SLUG__/${id}`);
            await load();
        } catch (err: any) {
            setError(err?.message || "Failed to delete item");
        }
    };

    return (
        <div className="p-8 max-w-3xl mx-auto">
            <h1 className="text-3xl font-extrabold mb-2">__NAME__</h1>
            <p className="text-gray-500 mb-8">
                Scaffolded by <code>wordjs create plugin</code>. Items are stored via the plugin
                options bridge and served from <code>/api/v1/plugin/__SLUG__</code>.
            </p>

            {error && (
                <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                </div>
            )}

            <div className="flex gap-2 mb-6">
                <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addItem()}
                    placeholder="New item title…"
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-xl text-sm focus:ring-blue-500 focus:border-blue-500 bg-white"
                />
                <button
                    onClick={addItem}
                    disabled={saving || !title.trim()}
                    className="px-5 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold disabled:opacity-50"
                >
                    {saving ? "Saving…" : "Add"}
                </button>
            </div>

            {loading ? (
                <p className="text-gray-400">Loading…</p>
            ) : items.length === 0 ? (
                <p className="text-gray-400">No items yet — add one above.</p>
            ) : (
                <ul className="space-y-2">
                    {items.map((item) => (
                        <li
                            key={item.id}
                            className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3"
                        >
                            <span className="font-medium">{item.title}</span>
                            <button
                                onClick={() => removeItem(item.id)}
                                className="text-sm text-red-600 hover:underline"
                            >
                                Delete
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

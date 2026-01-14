"use client";

import { useEffect, useState } from "react";
import { categoriesApi, Category } from "@/lib/api";

export default function CategoriesPage() {
    const [categories, setCategories] = useState<Category[]>([]);
    const [loading, setLoading] = useState(true);
    const [newCategory, setNewCategory] = useState("");

    useEffect(() => {
        loadCategories();
    }, []);

    const loadCategories = async () => {
        try {
            const data = await categoriesApi.list();
            setCategories(data);
        } catch (error) {
            console.error("Failed to load categories:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newCategory.trim()) return;
        try {
            await categoriesApi.create({ name: newCategory });
            setNewCategory("");
            loadCategories();
        } catch (error) {
            console.error("Failed to create category:", error);
        }
    };

    const handleDelete = async (id: number) => {
        if (!confirm("Delete this category?")) return;
        try {
            await categoriesApi.delete(id);
            loadCategories();
        } catch (error) {
            console.error("Failed to delete category:", error);
        }
    };

    return (
        <div className="p-6 h-full overflow-auto">
            <h1 className="text-2xl font-bold text-gray-800 mb-6">Categories</h1>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Add new category */}
                <div className="bg-white rounded-lg shadow p-6">
                    <h2 className="text-lg font-semibold text-gray-800 mb-4">Add New Category</h2>
                    <form onSubmit={handleCreate} className="space-y-4">
                        <input
                            type="text"
                            value={newCategory}
                            onChange={(e) => setNewCategory(e.target.value)}
                            placeholder="Category name"
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-900"
                        />
                        <button
                            type="submit"
                            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg transition-colors"
                        >
                            Add Category
                        </button>
                    </form>
                </div>

                {/* Categories list */}
                <div className="lg:col-span-2 bg-white rounded-lg shadow overflow-hidden">
                    {loading ? (
                        <div className="p-8 text-center text-gray-500">Loading...</div>
                    ) : (
                        <table className="w-full">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Slug</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Count</th>
                                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {categories.map((cat) => (
                                    <tr key={cat.id} className="hover:bg-gray-50">
                                        <td className="px-6 py-4 font-medium text-gray-800">{cat.name}</td>
                                        <td className="px-6 py-4 text-gray-500">{cat.slug}</td>
                                        <td className="px-6 py-4 text-gray-500">{cat.count}</td>
                                        <td className="px-6 py-4 text-right">
                                            <button onClick={() => handleDelete(cat.id)} className="text-red-600 hover:text-red-800">
                                                <i className="fa-solid fa-trash"></i>
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
}

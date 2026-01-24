"use client";

import { useEffect, useState } from "react";
import { categoriesApi, Category } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, Button, EmptyState, Card } from "@/components/ui";

export default function CategoriesPage() {
    const { t } = useI18n();
    const { confirm } = useModal();
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
        if (!await confirm(t('categories.delete.message') || "Delete this category?", t('categories.delete.title') || "Delete Category", true)) return;
        try {
            await categoriesApi.delete(id);
            loadCategories();
        } catch (error) {
            console.error("Failed to delete category:", error);
        }
    };

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t('categories.title') || "Categories"}
                subtitle={`${categories.length} ${t('categories.count') || 'categories'}`}
            />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Add new category */}
                <Card variant="default" padding="lg" className="h-fit">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-6 flex items-center gap-2">
                        <i className="fa-solid fa-plus-circle text-blue-500"></i>
                        {t('categories.add') || "Add New Category"}
                    </h2>
                    <form onSubmit={handleCreate} className="space-y-6">
                        <div className="relative group">
                            <i className="fa-solid fa-tag absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors"></i>
                            <input
                                type="text"
                                value={newCategory}
                                onChange={(e) => setNewCategory(e.target.value)}
                                placeholder={t('categories.name.placeholder') || "Category name"}
                                className="w-full pl-12 pr-4 py-4 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium"
                            />
                        </div>
                        <Button type="submit" icon="fa-plus" className="w-full">
                            {t('categories.add') || "Add Category"}
                        </Button>
                    </form>
                </Card>

                {/* Categories list */}
                <div className="lg:col-span-2">
                    <Card variant="default" padding="none">
                        {loading ? (
                            <div className="p-20 text-center">
                                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                            </div>
                        ) : categories.length === 0 ? (
                            <EmptyState
                                icon="fa-folder-open"
                                title={t('categories.not.found') || "No categories yet"}
                                description={t('categories.add.first') || "Create your first category to organize content."}
                            />
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-gray-100/50 bg-gray-50/30">
                                            <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                                {t('categories.name') || "Name"}
                                            </th>
                                            <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                                {t('categories.slug') || "Slug"}
                                            </th>
                                            <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                                {t('categories.count') || "Count"}
                                            </th>
                                            <th className="px-8 py-6 text-right text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                                {t('actions')}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                        {categories.map((cat) => (
                                            <tr key={cat.id} className="group hover:bg-blue-50/5 transition-colors">
                                                <td className="px-8 py-6">
                                                    <div className="flex items-center gap-4">
                                                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center text-blue-600 group-hover:scale-110 transition-transform">
                                                            <i className="fa-solid fa-folder"></i>
                                                        </div>
                                                        <span className="text-lg font-bold text-gray-700 italic tracking-tight">
                                                            {cat.name}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-8 py-6">
                                                    <span className="text-sm font-mono text-gray-400 bg-gray-50 px-3 py-1 rounded-lg">
                                                        {cat.slug}
                                                    </span>
                                                </td>
                                                <td className="px-8 py-6">
                                                    <span className="text-sm font-bold text-gray-500 bg-gray-50 px-3 py-1 rounded-full">
                                                        {cat.count}
                                                    </span>
                                                </td>
                                                <td className="px-8 py-6 text-right">
                                                    <button
                                                        onClick={() => handleDelete(cat.id)}
                                                        className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all shadow-sm hover:shadow-red-200 opacity-0 group-hover:opacity-100"
                                                    >
                                                        <i className="fa-solid fa-trash text-xs"></i>
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Card>
                </div>
            </div>
        </div>
    );
}

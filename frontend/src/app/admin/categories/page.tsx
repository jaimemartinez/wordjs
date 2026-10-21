"use client";

import { useEffect, useState } from "react";
import { categoriesApi, Category } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, Button, EmptyState, Card, DataTable } from "@/components/ui";

export default function CategoriesPage() {
    const { t } = useI18n();
    const { confirm } = useModal();
    const [categories, setCategories] = useState<Category[]>([]);
    // Lo que la BD dice que hay, tal cual lo manda X-WP-Total, y si la lectura acotada se quedó
    // corta. El subtítulo contaba `categories.length`, que con la lectura sin paginar de antes era
    // SIEMPRE 100 como mucho: a partir de la 101 no se podía ni ver ni borrar una categoría, y la
    // cabecera afirmaba que no existían.
    const [total, setTotal] = useState(0);
    const [truncated, setTruncated] = useState(false);
    const [loading, setLoading] = useState(true);
    const [newCategory, setNewCategory] = useState("");

    useEffect(() => {
        loadCategories();
    }, []);

    const loadCategories = async () => {
        try {
            const res = await categoriesApi.listAll();
            setCategories(res.data);
            setTotal(res.total);
            setTruncated(res.truncated);
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
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t('categories.title') || "Categories"}
                subtitle={
                    // El total es el de la BD; si la lectura acotada no las trajo todas se DICE,
                    // en vez de dejar creer que la tabla de abajo es la taxonomía entera.
                    `${Math.max(total, categories.length)} ${t('categories.count') || 'categories'}` +
                    (truncated ? ` · ${categories.length} ${t('loaded') || 'loaded'}` : '')
                }
            />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 md:gap-8">
                {/* Add new category */}
                <Card variant="default" padding="lg" className="h-fit">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-500 mb-6 flex items-center gap-2">
                        <i className="fa-solid fa-plus-circle text-blue-500" aria-hidden="true"></i>
                        {t('categories.add') || "Add New Category"}
                    </h2>
                    <form onSubmit={handleCreate} className="space-y-6">
                        <div className="relative group">
                            <label htmlFor="new-category-name" className="sr-only">{t('categories.name.label')}</label>
                            <i className="fa-solid fa-tag absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors" aria-hidden="true"></i>
                            <input
                                id="new-category-name"
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
                <div className="lg:col-span-2 min-w-0">
                    <Card variant="default" padding="none">
                        {loading ? (
                            <div className="p-20 text-center" role="status">
                                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" aria-hidden="true"></div>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                            </div>
                        ) : categories.length === 0 ? (
                            <EmptyState
                                icon="fa-folder-open"
                                title={t('categories.not.found') || "No categories yet"}
                                description={t('categories.add.first') || "Create your first category to organize content."}
                            />
                        ) : (
                            <DataTable
                                rows={categories}
                                rowKey={(c) => c.id}
                                caption={t('categories.title') || "Categories"}
                                rowLabel={(c) => c.name}
                                actionsLabel={t('actions')}
                                columns={[
                                    {
                                        key: "name",
                                        header: t('categories.name') || "Name",
                                        primary: true,
                                        cell: (cat) => (
                                            <div className="flex items-center gap-4">
                                                <div className="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center text-blue-600" aria-hidden="true">
                                                    <i className="fa-solid fa-folder"></i>
                                                </div>
                                                <span className="text-base md:text-lg font-bold text-gray-700 italic tracking-tight break-words min-w-0">
                                                    {cat.name}
                                                </span>
                                            </div>
                                        ),
                                    },
                                    {
                                        key: "slug",
                                        header: t('categories.slug') || "Slug",
                                        cell: (cat) => <span className="text-sm font-mono text-gray-500 bg-gray-50 px-3 py-1 rounded-lg break-all">{cat.slug}</span>,
                                    },
                                    {
                                        key: "count",
                                        header: t('categories.post.count') || "Count",
                                        cell: (cat) => <span className="text-sm font-bold text-gray-500 bg-gray-50 px-3 py-1 rounded-full">{cat.count}</span>,
                                    },
                                ]}
                                actions={(cat) => [
                                    { key: "delete", label: t('categories.delete'), icon: "fa-trash", onClick: () => handleDelete(cat.id), tone: "danger" },
                                ]}
                            />
                        )}
                    </Card>
                </div>
            </div>
        </div>
    );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { categoriesApi, Category } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, Button, EmptyState, Card, DataTable, Input, Select, Textarea } from "@/components/ui";
import { orderAsTree, selfAndDescendants } from "@/lib/categoryTree";
import { withServerReason } from "@/lib/errorText";

interface CategoryDraft {
    name: string;
    slug: string;
    description: string;
    parent: string;
}

const EMPTY_DRAFT: CategoryDraft = { name: "", slug: "", description: "", parent: "0" };

export default function CategoriesPage() {
    const { t } = useI18n();
    const { confirm } = useModal();
    const { addToast } = useToast();
    const [categories, setCategories] = useState<Category[]>([]);
    // Lo que la BD dice que hay, tal cual lo manda X-WP-Total, y si la lectura acotada se quedó
    // corta. El subtítulo contaba `categories.length`, que con la lectura sin paginar de antes era
    // SIEMPRE 100 como mucho: a partir de la 101 no se podía ni ver ni borrar una categoría, y la
    // cabecera afirmaba que no existían.
    const [total, setTotal] = useState(0);
    const [truncated, setTruncated] = useState(false);
    const [loading, setLoading] = useState(true);
    // The form on the left creates a category, or edits `editing` when one is chosen from the list.
    const [draft, setDraft] = useState<CategoryDraft>(EMPTY_DRAFT);
    const [editing, setEditing] = useState<Category | null>(null);
    const [saving, setSaving] = useState(false);

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

    // Parents first, children indented under them — the API returns a flat alphabetical list.
    const tree = useMemo(() => orderAsTree(categories), [categories]);
    const depthOf = useMemo(() => new Map(tree.map(({ category, depth }) => [category.id, depth])), [tree]);
    const parentOptions = useMemo(() => {
        const excluded = editing ? selfAndDescendants(categories, editing.id) : new Set<number>();
        return [
            { value: "0", label: t("categories.parent.none") },
            ...tree
                .filter(({ category }) => !excluded.has(category.id))
                .map(({ category, depth }) => ({ value: String(category.id), label: `${"— ".repeat(depth)}${category.name}` })),
        ];
    }, [tree, categories, editing, t]);

    const startEdit = (cat: Category) => {
        setEditing(cat);
        setDraft({ name: cat.name, slug: cat.slug, description: cat.description || "", parent: String(cat.parent || 0) });
    };

    const cancelEdit = () => {
        setEditing(null);
        setDraft(EMPTY_DRAFT);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!draft.name.trim()) return;
        setSaving(true);
        try {
            const body = {
                name: draft.name.trim(),
                description: draft.description,
                parent: Number(draft.parent) || 0,
                ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
            };
            if (editing) {
                await categoriesApi.update(editing.id, body);
                addToast(t("categories.updated"), "success");
            } else {
                await categoriesApi.create(body);
                addToast(t("categories.created"), "success");
            }
            setEditing(null);
            setDraft(EMPTY_DRAFT);
            loadCategories();
        } catch (error) {
            addToast(withServerReason(editing ? t("categories.updateFailed") : t("categories.createFailed"), error), "error");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: number) => {
        if (!await confirm(t('categories.delete.message') || "Delete this category?", t('categories.delete.title') || "Delete Category", true)) return;
        try {
            await categoriesApi.delete(id);
            if (editing?.id === id) cancelEdit();
            loadCategories();
        } catch (error) {
            addToast(withServerReason(t("categories.deleteFailed"), error), "error");
        }
    };

    const nameOf = (id?: number) => (id ? categories.find((c) => c.id === id)?.name : undefined);

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
                {/* Add a category, or edit the one chosen in the list */}
                <Card variant="default" padding="lg" className="h-fit">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-500 mb-6 flex items-center gap-2">
                        <i className={`fa-solid ${editing ? "fa-pen" : "fa-plus-circle"} text-blue-500`} aria-hidden="true"></i>
                        {editing ? t("categories.edit") : (t('categories.add') || "Add New Category")}
                    </h2>
                    <form onSubmit={handleSubmit} className="space-y-5">
                        <Input
                            id="category-name"
                            label={t('categories.name.label')}
                            icon="fa-tag"
                            value={draft.name}
                            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            placeholder={t('categories.name.placeholder') || "Category name"}
                        />
                        <Input
                            id="category-slug"
                            label={t('categories.slug')}
                            icon="fa-link"
                            value={draft.slug}
                            onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                            placeholder={t("categories.slug.placeholder")}
                        />
                        <div>
                            <span className="block text-[11px] font-black uppercase tracking-widest text-gray-500 mb-2" id="category-parent-label">{t("categories.parent")}</span>
                            <div aria-labelledby="category-parent-label" role="group">
                                <Select value={draft.parent} onChange={(v) => setDraft({ ...draft, parent: v })} options={parentOptions} />
                            </div>
                        </div>
                        <div>
                            <Textarea
                                id="category-description"
                                label={t("categories.description")}
                                rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                            />
                        </div>
                        <div className="flex flex-col gap-2">
                            <Button type="submit" icon={editing ? "fa-floppy-disk" : "fa-plus"} className="w-full" loading={saving}>
                                {editing ? t("categories.save") : (t('categories.add') || "Add Category")}
                            </Button>
                            {editing && (
                                <Button type="button" variant="ghost" className="w-full" onClick={cancelEdit}>
                                    {t("cancel")}
                                </Button>
                            )}
                        </div>
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
                                rows={tree.map(({ category }) => category)}
                                rowKey={(c) => c.id}
                                caption={t('categories.title') || "Categories"}
                                rowLabel={(c) => c.name}
                                actionsLabel={t('actions')}
                                columns={[
                                    {
                                        key: "name",
                                        header: t('categories.name') || "Name",
                                        primary: true,
                                        cell: (cat) => {
                                            const depth = depthOf.get(cat.id) || 0;
                                            const parentName = nameOf(cat.parent);
                                            return (
                                                <div className="flex items-center gap-4 min-w-0" style={depth ? { paddingInlineStart: `${Math.min(depth, 6) * 1.25}rem` } : undefined}>
                                                    <div className="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center text-blue-600" aria-hidden="true">
                                                        <i className={`fa-solid ${depth ? "fa-turn-up fa-rotate-90 text-sm" : "fa-folder"}`}></i>
                                                    </div>
                                                    <span className="min-w-0">
                                                        <span className="block text-base md:text-lg font-bold text-gray-700 italic tracking-tight break-words">
                                                            {cat.name}
                                                        </span>
                                                        {parentName && (
                                                            <span className="block text-xs text-gray-500">{t("categories.childOf")} {parentName}</span>
                                                        )}
                                                    </span>
                                                </div>
                                            );
                                        },
                                    },
                                    {
                                        key: "slug",
                                        header: t('categories.slug') || "Slug",
                                        cell: (cat) => <span className="text-sm font-mono text-gray-500 bg-gray-50 px-3 py-1 rounded-lg break-words">{cat.slug}</span>,
                                    },
                                    {
                                        key: "count",
                                        header: t('categories.post.count') || "Count",
                                        cell: (cat) => <span className="text-sm font-bold text-gray-500 bg-gray-50 px-3 py-1 rounded-full">{cat.count}</span>,
                                    },
                                ]}
                                actions={(cat) => [
                                    { key: "edit", label: t("categories.edit"), icon: "fa-pen", onClick: () => startEdit(cat) },
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

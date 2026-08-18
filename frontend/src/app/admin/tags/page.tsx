"use client";

/**
 * Pantalla de ETIQUETAS (/admin/tags) — la taxonomía `post_tag`.
 *
 * Espeja /admin/categories (mismo lienzo, misma tarjeta de alta a la izquierda, misma tabla) y le
 * añade lo que el router de etiquetas sí expone y el de categorías no: renombrar (PUT /tags/:id),
 * buscar y paginar (X-WP-Total / X-WP-TotalPages).
 *
 * Backend: backend/src/routes/tags.ts — GET público (optionalAuth), y POST/PUT/DELETE gated en
 * `manage_categories`. Aquí se refleja ese mismo permiso: sin él la lista se ve, pero no hay
 * formulario ni botones que solo darían un 403.
 *
 * Toda decisión (validar, componer el cuerpo, a qué página saltar) vive en ./tagsLogic, que se
 * prueba en node — este fichero es solo la pintura.
 */

import React, { useEffect, useState } from "react";
import { tagsApi, Tag } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { registerTranslations } from "@/lib/i18n";
import { PageHeader, Card, EmptyState, Button } from "@/components/ui";
import {
    TagDraft,
    TagDraftError,
    emptyTagDraft,
    pageAfterDelete,
    suggestSlug,
    tagCreatePayload,
    tagUpdatePayload,
    validateTagDraft,
} from "./tagsLogic";

// El diccionario core (lib/i18n.ts) no tiene claves tags.*; se registran por la misma API pública en
// tiempo de ejecución que usa /admin/forms, para poder llamar a t() igual que las pantallas vecinas.
registerTranslations({
    es: {
        "tags.title": "Etiquetas",
        "tags.subtitle": "Etiquetas de las entradas (taxonomía post_tag)",
        "tags.count": "etiquetas",
        "tags.add": "Nueva etiqueta",
        "tags.field.name": "Nombre",
        "tags.field.namePlaceholder": "Nombre de la etiqueta",
        "tags.field.slug": "Slug (opcional)",
        "tags.field.slugPlaceholder": "se genera del nombre",
        "tags.field.description": "Descripción (opcional)",
        "tags.field.descriptionPlaceholder": "Para qué sirve esta etiqueta",
        "tags.slugPreview": "Slug previsto",
        "tags.create": "Crear etiqueta",
        "tags.created": "Etiqueta creada",
        "tags.createFailed": "No se pudo crear la etiqueta",
        "tags.edit": "Renombrar",
        "tags.editTitle": "Editar etiqueta",
        "tags.save": "Guardar",
        "tags.saved": "Etiqueta actualizada",
        "tags.saveFailed": "No se pudo guardar la etiqueta",
        "tags.noChanges": "No has cambiado nada",
        "tags.cancel": "Cancelar",
        "tags.deleteTitle": "Eliminar etiqueta",
        "tags.deleteConfirm": "¿Eliminar esta etiqueta? Las entradas no se borran, solo dejan de estar etiquetadas.",
        "tags.deleted": "Etiqueta eliminada",
        "tags.deleteFailed": "No se pudo eliminar la etiqueta",
        "tags.column.name": "Nombre",
        "tags.column.slug": "Slug",
        "tags.column.count": "Entradas",
        "tags.search": "Buscar etiquetas",
        "tags.searchClear": "Quitar el filtro",
        "tags.emptyTitle": "Todavía no hay etiquetas",
        "tags.emptyDescription": "Crea la primera etiqueta para agrupar entradas por tema.",
        "tags.emptySearchTitle": "Ninguna etiqueta coincide",
        "tags.emptySearchDescription": "Prueba con otro texto o quita el filtro.",
        "tags.loadFailed": "No se pudieron cargar las etiquetas",
        "tags.readOnly": "Solo lectura: necesitas el permiso manage_categories para crear, renombrar o eliminar etiquetas.",
        "tags.error.empty": "El nombre no puede estar vacío",
        "tags.error.tooLong": "El nombre es demasiado largo",
        "tags.error.slugInvalid": "El slug solo admite minúsculas, números y guiones (o déjalo vacío)",
        "tags.error.duplicateName": "Ya existe una etiqueta con ese nombre",
        "tags.error.duplicateSlug": "Ya existe una etiqueta con ese slug",
    },
    en: {
        "tags.title": "Tags",
        "tags.subtitle": "Post tags (post_tag taxonomy)",
        "tags.count": "tags",
        "tags.add": "New tag",
        "tags.field.name": "Name",
        "tags.field.namePlaceholder": "Tag name",
        "tags.field.slug": "Slug (optional)",
        "tags.field.slugPlaceholder": "derived from the name",
        "tags.field.description": "Description (optional)",
        "tags.field.descriptionPlaceholder": "What this tag is for",
        "tags.slugPreview": "Expected slug",
        "tags.create": "Create tag",
        "tags.created": "Tag created",
        "tags.createFailed": "Could not create the tag",
        "tags.edit": "Rename",
        "tags.editTitle": "Edit tag",
        "tags.save": "Save",
        "tags.saved": "Tag updated",
        "tags.saveFailed": "Could not save the tag",
        "tags.noChanges": "Nothing changed",
        "tags.cancel": "Cancel",
        "tags.deleteTitle": "Delete tag",
        "tags.deleteConfirm": "Delete this tag? Posts are not deleted, they just stop being tagged.",
        "tags.deleted": "Tag deleted",
        "tags.deleteFailed": "Could not delete the tag",
        "tags.column.name": "Name",
        "tags.column.slug": "Slug",
        "tags.column.count": "Posts",
        "tags.search": "Search tags",
        "tags.searchClear": "Clear the filter",
        "tags.emptyTitle": "No tags yet",
        "tags.emptyDescription": "Create the first tag to group posts by topic.",
        "tags.emptySearchTitle": "No tag matches",
        "tags.emptySearchDescription": "Try another text or clear the filter.",
        "tags.loadFailed": "Could not load the tags",
        "tags.readOnly": "Read-only: you need the manage_categories permission to create, rename or delete tags.",
        "tags.error.empty": "The name cannot be empty",
        "tags.error.tooLong": "The name is too long",
        "tags.error.slugInvalid": "The slug only allows lowercase letters, digits and hyphens (or leave it empty)",
        "tags.error.duplicateName": "A tag with that name already exists",
        "tags.error.duplicateSlug": "A tag with that slug already exists",
    },
    pt: {
        "tags.title": "Etiquetas",
        "tags.subtitle": "Etiquetas das publicações (taxonomia post_tag)",
        "tags.count": "etiquetas",
        "tags.add": "Nova etiqueta",
        "tags.field.name": "Nome",
        "tags.field.namePlaceholder": "Nome da etiqueta",
        "tags.field.slug": "Slug (opcional)",
        "tags.field.slugPlaceholder": "gerado a partir do nome",
        "tags.field.description": "Descrição (opcional)",
        "tags.field.descriptionPlaceholder": "Para que serve esta etiqueta",
        "tags.slugPreview": "Slug previsto",
        "tags.create": "Criar etiqueta",
        "tags.created": "Etiqueta criada",
        "tags.createFailed": "Não foi possível criar a etiqueta",
        "tags.edit": "Renomear",
        "tags.editTitle": "Editar etiqueta",
        "tags.save": "Guardar",
        "tags.saved": "Etiqueta atualizada",
        "tags.saveFailed": "Não foi possível guardar a etiqueta",
        "tags.noChanges": "Nada foi alterado",
        "tags.cancel": "Cancelar",
        "tags.deleteTitle": "Excluir etiqueta",
        "tags.deleteConfirm": "Excluir esta etiqueta? As publicações não são excluídas, apenas deixam de estar etiquetadas.",
        "tags.deleted": "Etiqueta excluída",
        "tags.deleteFailed": "Não foi possível excluir a etiqueta",
        "tags.column.name": "Nome",
        "tags.column.slug": "Slug",
        "tags.column.count": "Publicações",
        "tags.search": "Pesquisar etiquetas",
        "tags.searchClear": "Limpar o filtro",
        "tags.emptyTitle": "Ainda não há etiquetas",
        "tags.emptyDescription": "Crie a primeira etiqueta para agrupar publicações por tema.",
        "tags.emptySearchTitle": "Nenhuma etiqueta corresponde",
        "tags.emptySearchDescription": "Tente outro texto ou limpe o filtro.",
        "tags.loadFailed": "Não foi possível carregar as etiquetas",
        "tags.readOnly": "Somente leitura: você precisa da permissão manage_categories para criar, renomear ou excluir etiquetas.",
        "tags.error.empty": "O nome não pode estar vazio",
        "tags.error.tooLong": "O nome é muito longo",
        "tags.error.slugInvalid": "O slug aceita apenas minúsculas, números e hífens (ou deixe vazio)",
        "tags.error.duplicateName": "Já existe uma etiqueta com esse nome",
        "tags.error.duplicateSlug": "Já existe uma etiqueta com esse slug",
    },
});

const PER_PAGE = 20;
/** Espera antes de buscar, para no lanzar una petición por tecla. */
const SEARCH_DEBOUNCE_MS = 300;

const inputClass =
    "w-full px-4 py-3.5 bg-gray-50/50 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium text-sm";

export default function TagsPage() {
    const { user } = useAuth();
    const { confirm } = useModal();
    const { addToast } = useToast();
    const { t } = useI18n();

    const [tags, setTags] = useState<Tag[]>([]);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");

    const [draft, setDraft] = useState<TagDraft>(emptyTagDraft());
    const [creating, setCreating] = useState(false);

    const [editingId, setEditingId] = useState<number | null>(null);
    const [editDraft, setEditDraft] = useState<TagDraft>(emptyTagDraft());
    const [savingId, setSavingId] = useState<number | null>(null);
    const [deletingId, setDeletingId] = useState<number | null>(null);

    // El mismo permiso que gatea POST/PUT/DELETE en el router: sin él no se pintan controles que
    // solo servirían para cobrar un 403.
    const canManage =
        !!user?.capabilities &&
        (user.capabilities.includes("*") || user.capabilities.includes("manage_categories"));

    const loadTags = async (pageNum: number, term: string) => {
        setLoading(true);
        setError(null);
        try {
            const res = await tagsApi.listPaged({ page: pageNum, perPage: PER_PAGE, search: term || undefined });
            setTags(res.data);
            setTotal(res.total);
            setTotalPages(res.totalPages);
        } catch (e: any) {
            setError(e?.message || t("tags.loadFailed"));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTags(page, search);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, search]);

    // Buscar con retardo, y volver siempre a la página 1: el resultado filtrado tiene otra paginación.
    // Los dos setState caen en el MISMO lote de React, así que sale UNA sola petición, no dos.
    useEffect(() => {
        const id = setTimeout(() => {
            const term = searchInput.trim();
            if (term === search) return;
            setSearch(term);
            setPage(1);
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(id);
    }, [searchInput, search]);

    const errorMessage = (code: Exclude<TagDraftError, null>) => t(`tags.error.${code}`);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canManage || creating) return;
        const invalid = validateTagDraft(draft, tags, null);
        if (invalid) {
            addToast(errorMessage(invalid), "error");
            return;
        }
        setCreating(true);
        try {
            await tagsApi.create(tagCreatePayload(draft));
            addToast(t("tags.created"), "success");
            setDraft(emptyTagDraft());
            // Una etiqueta nueva se ordena por nombre: recargar la página actual es lo honesto.
            await loadTags(page, search);
        } catch (e: any) {
            addToast(e?.message || t("tags.createFailed"), "error");
        } finally {
            setCreating(false);
        }
    };

    const startEdit = (tag: Tag) => {
        setEditingId(tag.id);
        setEditDraft({ name: tag.name, slug: tag.slug, description: tag.description || "" });
    };

    const cancelEdit = () => {
        setEditingId(null);
        setEditDraft(emptyTagDraft());
    };

    const saveEdit = async (tag: Tag) => {
        if (!canManage || savingId !== null) return;
        const invalid = validateTagDraft(editDraft, tags, tag.id);
        if (invalid) {
            addToast(errorMessage(invalid), "error");
            return;
        }
        const patch = tagUpdatePayload(editDraft, { name: tag.name, slug: tag.slug, description: tag.description });
        if (!patch) {
            addToast(t("tags.noChanges"), "info");
            cancelEdit();
            return;
        }
        setSavingId(tag.id);
        try {
            await tagsApi.update(tag.id, patch);
            addToast(t("tags.saved"), "success");
            cancelEdit();
            await loadTags(page, search);
        } catch (e: any) {
            addToast(e?.message || t("tags.saveFailed"), "error");
        } finally {
            setSavingId(null);
        }
    };

    const remove = async (tag: Tag) => {
        if (!canManage) return;
        if (!(await confirm(t("tags.deleteConfirm"), t("tags.deleteTitle"), true))) return;
        setDeletingId(tag.id);
        try {
            await tagsApi.remove(tag.id);
            addToast(t("tags.deleted"), "success");
            if (editingId === tag.id) cancelEdit();
            const next = pageAfterDelete(tags.length, page);
            if (next !== page) setPage(next); // el efecto recarga
            else await loadTags(page, search);
        } catch (e: any) {
            addToast(e?.message || t("tags.deleteFailed"), "error");
        } finally {
            setDeletingId(null);
        }
    };

    const slugPreview = suggestSlug(draft.name);

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t("tags.title")}
                subtitle={`${t("tags.subtitle")} · ${total} ${t("tags.count")}`}
                icon="fa-tags"
            />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Alta — misma columna y mismo sitio que en /admin/categories */}
                <Card variant="default" padding="lg" className="h-fit">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-6 flex items-center gap-2">
                        <i className="fa-solid fa-plus-circle text-blue-500"></i>
                        {t("tags.add")}
                    </h2>

                    {canManage ? (
                        <form onSubmit={handleCreate} className="space-y-5">
                            <div>
                                <label htmlFor="tag-name" className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                                    {t("tags.field.name")}
                                </label>
                                <input
                                    id="tag-name"
                                    type="text"
                                    value={draft.name}
                                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                                    placeholder={t("tags.field.namePlaceholder")}
                                    className={inputClass}
                                />
                            </div>

                            <div>
                                <label htmlFor="tag-slug" className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                                    {t("tags.field.slug")}
                                </label>
                                <input
                                    id="tag-slug"
                                    type="text"
                                    value={draft.slug}
                                    onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                                    placeholder={t("tags.field.slugPlaceholder")}
                                    className={`${inputClass} font-mono`}
                                />
                                {!draft.slug && slugPreview && (
                                    <p className="mt-2 text-[11px] text-gray-400">
                                        {t("tags.slugPreview")}: <code className="font-mono text-gray-500">{slugPreview}</code>
                                    </p>
                                )}
                            </div>

                            <div>
                                <label htmlFor="tag-description" className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                                    {t("tags.field.description")}
                                </label>
                                <textarea
                                    id="tag-description"
                                    value={draft.description}
                                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                                    placeholder={t("tags.field.descriptionPlaceholder")}
                                    rows={3}
                                    className={`${inputClass} resize-y`}
                                />
                            </div>

                            <Button type="submit" icon="fa-plus" className="w-full" loading={creating} disabled={creating}>
                                {t("tags.create")}
                            </Button>
                        </form>
                    ) : (
                        <p className="text-sm text-gray-400 leading-relaxed">
                            <i className="fa-solid fa-lock mr-2 text-gray-300"></i>
                            {t("tags.readOnly")}
                        </p>
                    )}
                </Card>

                {/* Lista */}
                <div className="lg:col-span-2 space-y-6">
                    <div className="relative">
                        <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 text-sm"></i>
                        <input
                            type="search"
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            placeholder={t("tags.search")}
                            aria-label={t("tags.search")}
                            className={`${inputClass} pl-11`}
                        />
                        {searchInput && (
                            <button
                                type="button"
                                onClick={() => setSearchInput("")}
                                title={t("tags.searchClear")}
                                aria-label={t("tags.searchClear")}
                                className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-all"
                            >
                                <i className="fa-solid fa-xmark text-xs"></i>
                            </button>
                        )}
                    </div>

                    <Card variant="default" padding="none">
                        {loading ? (
                            <div className="p-20 text-center">
                                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t("common.loading")}</p>
                            </div>
                        ) : error ? (
                            <div className="p-20 text-center">
                                <i className="fa-solid fa-triangle-exclamation text-3xl text-amber-400 mb-4"></i>
                                <p className="text-gray-500 text-sm font-bold mb-2">{t("tags.loadFailed")}</p>
                                <p className="text-gray-400 text-xs">{error}</p>
                            </div>
                        ) : tags.length === 0 ? (
                            <EmptyState
                                icon="fa-tags"
                                title={search ? t("tags.emptySearchTitle") : t("tags.emptyTitle")}
                                description={search ? t("tags.emptySearchDescription") : t("tags.emptyDescription")}
                            />
                        ) : (
                            <>
                                <div className="overflow-x-auto">
                                    <table className="w-full">
                                        <thead>
                                            <tr className="border-b border-gray-100/50 bg-gray-50/30">
                                                <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                                    {t("tags.column.name")}
                                                </th>
                                                <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                                    {t("tags.column.slug")}
                                                </th>
                                                <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                                    {t("tags.column.count")}
                                                </th>
                                                <th className="px-8 py-6 text-right text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                                    {t("actions")}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-50">
                                            {tags.map((tag) => {
                                                const editing = editingId === tag.id;
                                                return (
                                                    <React.Fragment key={tag.id}>
                                                        <tr className="group hover:bg-blue-50/5 transition-colors">
                                                            <td className="px-8 py-6">
                                                                <div className="flex items-center gap-4">
                                                                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center text-blue-600 group-hover:scale-110 transition-transform shrink-0">
                                                                        <i className="fa-solid fa-tag"></i>
                                                                    </div>
                                                                    <div className="min-w-0">
                                                                        <span className="block text-lg font-bold text-gray-700 italic tracking-tight break-words">
                                                                            {tag.name}
                                                                        </span>
                                                                        {tag.description && (
                                                                            <span className="block text-xs text-gray-400 break-words">{tag.description}</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </td>
                                                            <td className="px-8 py-6">
                                                                <span className="text-sm font-mono text-gray-400 bg-gray-50 px-3 py-1 rounded-lg break-all">
                                                                    {tag.slug}
                                                                </span>
                                                            </td>
                                                            <td className="px-8 py-6">
                                                                <span className="text-sm font-bold text-gray-500 bg-gray-50 px-3 py-1 rounded-full">
                                                                    {tag.count}
                                                                </span>
                                                            </td>
                                                            <td className="px-8 py-6 text-right">
                                                                {canManage ? (
                                                                    <div className="flex items-center justify-end gap-2">
                                                                        <button
                                                                            onClick={() => (editing ? cancelEdit() : startEdit(tag))}
                                                                            title={editing ? t("tags.cancel") : t("tags.edit")}
                                                                            aria-label={editing ? t("tags.cancel") : t("tags.edit")}
                                                                            className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white flex items-center justify-center transition-all shadow-sm"
                                                                        >
                                                                            <i className={`fa-solid ${editing ? "fa-xmark" : "fa-pen"} text-xs`}></i>
                                                                        </button>
                                                                        <button
                                                                            onClick={() => remove(tag)}
                                                                            disabled={deletingId === tag.id}
                                                                            title={t("tags.deleteTitle")}
                                                                            aria-label={t("tags.deleteTitle")}
                                                                            className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all shadow-sm hover:shadow-red-200 disabled:opacity-50"
                                                                        >
                                                                            <i className={`fa-solid ${deletingId === tag.id ? "fa-spinner fa-spin" : "fa-trash"} text-xs`}></i>
                                                                        </button>
                                                                    </div>
                                                                ) : (
                                                                    <span className="text-gray-300">—</span>
                                                                )}
                                                            </td>
                                                        </tr>

                                                        {editing && canManage && (
                                                            <tr className="bg-gray-50/60">
                                                                <td colSpan={4} className="px-8 py-6 border-t border-gray-100">
                                                                    <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4">
                                                                        {t("tags.editTitle")}
                                                                    </h3>
                                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                                                                        <div>
                                                                            <label
                                                                                htmlFor={`tag-edit-name-${tag.id}`}
                                                                                className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2"
                                                                            >
                                                                                {t("tags.field.name")}
                                                                            </label>
                                                                            <input
                                                                                id={`tag-edit-name-${tag.id}`}
                                                                                type="text"
                                                                                value={editDraft.name}
                                                                                onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                                                                                className={`${inputClass} bg-white`}
                                                                            />
                                                                        </div>
                                                                        <div>
                                                                            <label
                                                                                htmlFor={`tag-edit-slug-${tag.id}`}
                                                                                className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2"
                                                                            >
                                                                                {t("tags.field.slug")}
                                                                            </label>
                                                                            <input
                                                                                id={`tag-edit-slug-${tag.id}`}
                                                                                type="text"
                                                                                value={editDraft.slug}
                                                                                onChange={(e) => setEditDraft({ ...editDraft, slug: e.target.value })}
                                                                                className={`${inputClass} bg-white font-mono`}
                                                                            />
                                                                        </div>
                                                                        <div className="md:col-span-2">
                                                                            <label
                                                                                htmlFor={`tag-edit-description-${tag.id}`}
                                                                                className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2"
                                                                            >
                                                                                {t("tags.field.description")}
                                                                            </label>
                                                                            <textarea
                                                                                id={`tag-edit-description-${tag.id}`}
                                                                                value={editDraft.description}
                                                                                onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                                                                                rows={2}
                                                                                className={`${inputClass} bg-white resize-y`}
                                                                            />
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex flex-wrap gap-3">
                                                                        <Button
                                                                            size="md"
                                                                            icon="fa-check"
                                                                            loading={savingId === tag.id}
                                                                            disabled={savingId === tag.id}
                                                                            onClick={() => saveEdit(tag)}
                                                                        >
                                                                            {t("tags.save")}
                                                                        </Button>
                                                                        <Button size="md" variant="secondary" icon="fa-xmark" onClick={cancelEdit}>
                                                                            {t("tags.cancel")}
                                                                        </Button>
                                                                    </div>
                                                                </td>
                                                            </tr>
                                                        )}
                                                    </React.Fragment>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>

                                {/* Paginador — mismo cromo que el de /admin/forms */}
                                {totalPages > 1 && (
                                    <div className="px-8 py-5 border-t border-gray-100/50 bg-gray-50/30 flex items-center justify-between">
                                        <button
                                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                                            disabled={page <= 1}
                                            className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 transition-all"
                                        >
                                            <i className="fa-solid fa-chevron-left mr-2"></i>
                                            {t("table.previous")}
                                        </button>
                                        <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                            {t("table.pageOf").replace("{page}", String(page)).replace("{total}", String(totalPages))}
                                        </span>
                                        <button
                                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                                            disabled={page >= totalPages}
                                            className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 transition-all"
                                        >
                                            {t("table.next")}
                                            <i className="fa-solid fa-chevron-right ml-2"></i>
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </Card>
                </div>
            </div>
        </div>
    );
}

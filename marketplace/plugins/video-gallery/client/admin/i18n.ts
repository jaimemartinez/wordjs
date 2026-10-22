// @ts-nocheck
"use client";

// The Video Gallery admin screens follow the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // gallery list
    'list.title': 'Galerías de Video',
    'list.subtitle': 'Administra tus colecciones de videos',
    'list.loading': 'Cargando galerías...',
    'list.newGallery': 'Nueva Galería',
    'list.videoCount': '{n} videos',
    'list.noDescription': 'Sin descripción',
    'list.deleteGallery': 'Eliminar galería',
    'list.id': 'ID: {id}',
    'list.manage': 'Gestionar',
    // create gallery modal
    'create.namePlaceholder': 'Nombre de la galería',
    'create.descPlaceholder': 'Descripción (opcional)',
    'create.submit': 'Crear',
    'create.error': 'No se pudo crear la galería',
    // delete gallery
    'gallery.confirmDelete': '¿Eliminar esta galería? Se perderán todos sus videos.',
    'gallery.confirmDeleteTitle': 'Eliminar galería',
    'gallery.deleteError': 'No se pudo eliminar la galería',
    // detail view
    'detail.fallbackTitle': 'Detalle de galería',
    'detail.subtitle': 'Gestionando videos de esta galería',
    'detail.back': 'Volver a Galerías',
    'detail.addVideoPlus': '+ Agregar Video',
    'detail.addVideo': 'Agregar Video',
    'detail.empty': 'Esta galería está vacía.',
    'detail.edit': 'Editar',
    'detail.delete': 'Eliminar',
    'detail.buttonFallback': 'BOTÓN',
    'detail.reorderError': 'No se pudo guardar el nuevo orden',
    // video actions
    'video.confirmDelete': '¿Eliminar este video?',
    'video.confirmDeleteTitle': 'Eliminar Video',
    'video.saveError': 'No se pudo guardar el video',
    'video.defaultButton': 'VER EN YOUTUBE',
    // video modal
    'modal.edit': 'Editar Video',
    'modal.new': 'Nuevo Video',
    'modal.title': 'Título del Video',
    'modal.titlePlaceholder': 'p. ej. Conferencia Anual 2024',
    'modal.url': 'URL de YouTube',
    'modal.preview': 'Vista previa',
    'modal.buttonText': 'Texto del Botón',
    'modal.buttonPlaceholder': 'VER VIDEO',
    'modal.order': 'Orden Manual',
    'modal.description': 'Descripción',
    'modal.descPlaceholder': 'Breve descripción del contenido...',
    'modal.saving': 'Guardando...',
    'modal.save': 'Guardar Video',
    // common
    'common.cancel': 'Cancelar',
};

const en = {
    // gallery list
    'list.title': 'Video Galleries',
    'list.subtitle': 'Manage your video collections',
    'list.loading': 'Loading galleries...',
    'list.newGallery': 'New Gallery',
    'list.videoCount': '{n} videos',
    'list.noDescription': 'No description',
    'list.deleteGallery': 'Delete gallery',
    'list.id': 'ID: {id}',
    'list.manage': 'Manage',
    // create gallery modal
    'create.namePlaceholder': 'Gallery name',
    'create.descPlaceholder': 'Description (optional)',
    'create.submit': 'Create',
    'create.error': 'Failed to create gallery',
    // delete gallery
    'gallery.confirmDelete': 'Delete this gallery? All videos in it will be lost.',
    'gallery.confirmDeleteTitle': 'Delete Gallery',
    'gallery.deleteError': 'Failed to delete gallery',
    // detail view
    'detail.fallbackTitle': 'Gallery details',
    'detail.subtitle': 'Managing the videos in this gallery',
    'detail.back': 'Back to Galleries',
    'detail.addVideoPlus': '+ Add Video',
    'detail.addVideo': 'Add Video',
    'detail.empty': 'This gallery is empty.',
    'detail.edit': 'Edit',
    'detail.delete': 'Delete',
    'detail.buttonFallback': 'BUTTON',
    'detail.reorderError': 'Failed to save new order',
    // video actions
    'video.confirmDelete': 'Delete this video?',
    'video.confirmDeleteTitle': 'Delete Video',
    'video.saveError': 'Failed to save video',
    'video.defaultButton': 'WATCH ON YOUTUBE',
    // video modal
    'modal.edit': 'Edit Video',
    'modal.new': 'New Video',
    'modal.title': 'Video Title',
    'modal.titlePlaceholder': 'e.g. Annual Conference 2024',
    'modal.url': 'YouTube URL',
    'modal.preview': 'Preview',
    'modal.buttonText': 'Button Text',
    'modal.buttonPlaceholder': 'WATCH VIDEO',
    'modal.order': 'Manual Order',
    'modal.description': 'Description',
    'modal.descPlaceholder': 'Short description of the content...',
    'modal.saving': 'Saving...',
    'modal.save': 'Save Video',
    // common
    'common.cancel': 'Cancel',
};

const pt = {
    // gallery list
    'list.title': 'Galerias de Vídeo',
    'list.subtitle': 'Gerencie suas coleções de vídeos',
    'list.loading': 'Carregando galerias...',
    'list.newGallery': 'Nova Galeria',
    'list.videoCount': '{n} vídeos',
    'list.noDescription': 'Sem descrição',
    'list.deleteGallery': 'Excluir galeria',
    'list.id': 'ID: {id}',
    'list.manage': 'Gerenciar',
    // create gallery modal
    'create.namePlaceholder': 'Nome da galeria',
    'create.descPlaceholder': 'Descrição (opcional)',
    'create.submit': 'Criar',
    'create.error': 'Não foi possível criar a galeria',
    // delete gallery
    'gallery.confirmDelete': 'Excluir esta galeria? Todos os vídeos dela serão perdidos.',
    'gallery.confirmDeleteTitle': 'Excluir galeria',
    'gallery.deleteError': 'Não foi possível excluir a galeria',
    // detail view
    'detail.fallbackTitle': 'Detalhes da galeria',
    'detail.subtitle': 'Gerenciando os vídeos desta galeria',
    'detail.back': 'Voltar às Galerias',
    'detail.addVideoPlus': '+ Adicionar Vídeo',
    'detail.addVideo': 'Adicionar Vídeo',
    'detail.empty': 'Esta galeria está vazia.',
    'detail.edit': 'Editar',
    'detail.delete': 'Excluir',
    'detail.buttonFallback': 'BOTÃO',
    'detail.reorderError': 'Não foi possível salvar a nova ordem',
    // video actions
    'video.confirmDelete': 'Excluir este vídeo?',
    'video.confirmDeleteTitle': 'Excluir Vídeo',
    'video.saveError': 'Não foi possível salvar o vídeo',
    'video.defaultButton': 'VER NO YOUTUBE',
    // video modal
    'modal.edit': 'Editar Vídeo',
    'modal.new': 'Novo Vídeo',
    'modal.title': 'Título do Vídeo',
    'modal.titlePlaceholder': 'ex.: Conferência Anual 2024',
    'modal.url': 'URL do YouTube',
    'modal.preview': 'Pré-visualização',
    'modal.buttonText': 'Texto do Botão',
    'modal.buttonPlaceholder': 'VER VÍDEO',
    'modal.order': 'Ordem Manual',
    'modal.description': 'Descrição',
    'modal.descPlaceholder': 'Breve descrição do conteúdo...',
    'modal.saving': 'Salvando...',
    'modal.save': 'Salvar Vídeo',
    // common
    'common.cancel': 'Cancelar',
};

const TABLES = { es, en, pt };
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' };

export function translate(lang, key, vars) {
    const table = TABLES[lang] || es;
    let s = table[key] ?? en[key] ?? key;
    if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
    return s;
}

/** The current admin language and a `t(key, vars)` bound to it. */
export function useT() {
    const ctx = useOptionalI18n ? useOptionalI18n() : null;
    let lang = ctx?.language;
    if (!lang && typeof document !== 'undefined') lang = document.documentElement.lang || '';
    lang = String(lang || '').slice(0, 2).toLowerCase();
    if (lang !== 'es' && lang !== 'en' && lang !== 'pt') lang = 'es';
    const t = (key, vars) => translate(lang, key, vars);
    return { t, lang, locale: LOCALES[lang] };
}

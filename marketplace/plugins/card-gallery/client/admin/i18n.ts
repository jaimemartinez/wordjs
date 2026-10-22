// @ts-nocheck
"use client";

// The Card Gallery admin screens follow the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // list view
    'list.title': 'Galerías de Tarjetas',
    'list.subtitle': 'Administra tus colecciones de tarjetas',
    'list.loading': 'Cargando galerías...',
    'list.newGallery': 'Nueva Galería',
    'list.cards': 'Tarjetas',
    'list.noLocation': 'Sin ubicación',
    'list.deleteGallery': 'Eliminar galería',
    'list.manage': 'Gestionar Galería',
    // create gallery modal
    'create.title': 'Nueva Galería',
    'create.namePlaceholder': 'Nombre de la galería',
    'create.submit': 'Crear',
    'common.cancel': 'Cancelar',
    // detail view
    'detail.subtitle': 'Gestionando tarjetas',
    'detail.addCard': 'Agregar Tarjeta',
    'detail.emptyTitle': 'Esta galería está vacía',
    'detail.emptyText': 'Agrega tarjetas para mostrar contenido visual atractivo.',
    'detail.start': 'Comenzar',
    'card.edit': 'Editar',
    'card.delete': 'Eliminar',
    'card.hasButton': 'BTN',
    // card editor modal
    'editor.newCard': 'Nueva Tarjeta',
    'editor.editCard': 'Editar Tarjeta',
    'editor.title': 'Título *',
    'editor.titlePlaceholder': 'Nombre del evento o tarjeta',
    'editor.subtitle': 'Subtítulo',
    'editor.subtitlePlaceholder': 'Ubicación o detalle corto',
    'editor.dates': 'Fechas',
    'editor.datesPlaceholder': 'Ej: 15-18 ENE 2026',
    'editor.image': 'Imagen',
    'editor.imagePlaceholder': 'URL de imagen',
    'editor.previewAlt': 'Vista previa',
    'editor.preview': 'Vista Previa',
    'editor.buttonAction': 'Acción del Botón',
    'editor.buttonText': 'Texto',
    'editor.buttonTextPlaceholder': 'INSCRÍBETE',
    'editor.buttonTextDefault': 'INSCRÍBETE AQUÍ',
    'editor.buttonLink': 'Enlace',
    'editor.saving': 'Guardando...',
    'editor.save': 'Guardar Tarjeta',
    // alerts and confirmations
    'error.createGallery': 'No se pudo crear la galería',
    'error.deleteGallery': 'No se pudo eliminar la galería',
    'error.saveCard': 'No se pudo guardar la tarjeta',
    'error.deleteCard': 'No se pudo eliminar la tarjeta',
    'error.saveOrder': 'No se pudo guardar el nuevo orden',
    'confirm.deleteGallery': '¿Seguro que quieres eliminar esta galería y todas sus tarjetas?',
    'confirm.deleteGalleryTitle': 'Eliminar galería',
    'confirm.deleteCard': '¿Seguro que quieres eliminar esta tarjeta?',
    'confirm.deleteCardTitle': 'Eliminar tarjeta',
};

const en = {
    // list view
    'list.title': 'Card Galleries',
    'list.subtitle': 'Manage your card collections',
    'list.loading': 'Loading galleries...',
    'list.newGallery': 'New Gallery',
    'list.cards': 'Cards',
    'list.noLocation': 'No location',
    'list.deleteGallery': 'Delete gallery',
    'list.manage': 'Manage Gallery',
    // create gallery modal
    'create.title': 'New Gallery',
    'create.namePlaceholder': 'Gallery name',
    'create.submit': 'Create',
    'common.cancel': 'Cancel',
    // detail view
    'detail.subtitle': 'Managing cards',
    'detail.addCard': 'Add Card',
    'detail.emptyTitle': 'This gallery is empty',
    'detail.emptyText': 'Add cards to show engaging visual content.',
    'detail.start': 'Get started',
    'card.edit': 'Edit',
    'card.delete': 'Delete',
    'card.hasButton': 'BTN',
    // card editor modal
    'editor.newCard': 'New Card',
    'editor.editCard': 'Edit Card',
    'editor.title': 'Title *',
    'editor.titlePlaceholder': 'Event or card name',
    'editor.subtitle': 'Subtitle',
    'editor.subtitlePlaceholder': 'Location or short detail',
    'editor.dates': 'Dates',
    'editor.datesPlaceholder': 'E.g. JAN 15-18 2026',
    'editor.image': 'Image',
    'editor.imagePlaceholder': 'Image URL',
    'editor.previewAlt': 'Preview',
    'editor.preview': 'Preview',
    'editor.buttonAction': 'Button Action',
    'editor.buttonText': 'Text',
    'editor.buttonTextPlaceholder': 'SIGN UP',
    'editor.buttonTextDefault': 'SIGN UP HERE',
    'editor.buttonLink': 'Link',
    'editor.saving': 'Saving...',
    'editor.save': 'Save Card',
    // alerts and confirmations
    'error.createGallery': 'Failed to create gallery',
    'error.deleteGallery': 'Failed to delete gallery',
    'error.saveCard': 'Failed to save card',
    'error.deleteCard': 'Failed to delete card',
    'error.saveOrder': 'Failed to save new order',
    'confirm.deleteGallery': 'Are you sure you want to delete this gallery and all its cards?',
    'confirm.deleteGalleryTitle': 'Delete Gallery',
    'confirm.deleteCard': 'Are you sure you want to delete this card?',
    'confirm.deleteCardTitle': 'Delete Card',
};

const pt = {
    // list view
    'list.title': 'Galerias de Cartões',
    'list.subtitle': 'Gerencie suas coleções de cartões',
    'list.loading': 'Carregando galerias...',
    'list.newGallery': 'Nova Galeria',
    'list.cards': 'Cartões',
    'list.noLocation': 'Sem local',
    'list.deleteGallery': 'Excluir galeria',
    'list.manage': 'Gerenciar Galeria',
    // create gallery modal
    'create.title': 'Nova Galeria',
    'create.namePlaceholder': 'Nome da galeria',
    'create.submit': 'Criar',
    'common.cancel': 'Cancelar',
    // detail view
    'detail.subtitle': 'Gerenciando cartões',
    'detail.addCard': 'Adicionar Cartão',
    'detail.emptyTitle': 'Esta galeria está vazia',
    'detail.emptyText': 'Adicione cartões para exibir conteúdo visual atraente.',
    'detail.start': 'Começar',
    'card.edit': 'Editar',
    'card.delete': 'Excluir',
    'card.hasButton': 'BTN',
    // card editor modal
    'editor.newCard': 'Novo Cartão',
    'editor.editCard': 'Editar Cartão',
    'editor.title': 'Título *',
    'editor.titlePlaceholder': 'Nome do evento ou cartão',
    'editor.subtitle': 'Subtítulo',
    'editor.subtitlePlaceholder': 'Local ou detalhe curto',
    'editor.dates': 'Datas',
    'editor.datesPlaceholder': 'Ex.: 15-18 JAN 2026',
    'editor.image': 'Imagem',
    'editor.imagePlaceholder': 'URL da imagem',
    'editor.previewAlt': 'Pré-visualização',
    'editor.preview': 'Pré-visualização',
    'editor.buttonAction': 'Ação do Botão',
    'editor.buttonText': 'Texto',
    'editor.buttonTextPlaceholder': 'INSCREVA-SE',
    'editor.buttonTextDefault': 'INSCREVA-SE AQUI',
    'editor.buttonLink': 'Link',
    'editor.saving': 'Salvando...',
    'editor.save': 'Salvar Cartão',
    // alerts and confirmations
    'error.createGallery': 'Não foi possível criar a galeria',
    'error.deleteGallery': 'Não foi possível excluir a galeria',
    'error.saveCard': 'Não foi possível salvar o cartão',
    'error.deleteCard': 'Não foi possível excluir o cartão',
    'error.saveOrder': 'Não foi possível salvar a nova ordem',
    'confirm.deleteGallery': 'Tem certeza de que deseja excluir esta galeria e todos os seus cartões?',
    'confirm.deleteGalleryTitle': 'Excluir galeria',
    'confirm.deleteCard': 'Tem certeza de que deseja excluir este cartão?',
    'confirm.deleteCardTitle': 'Excluir cartão',
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

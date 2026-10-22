// @ts-nocheck
"use client";

// The Photo Carousel admin screen follows the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // header
    'app.title': 'Carruseles',
    'app.subtitle': 'Administra tus presentaciones de imágenes',
    // messages
    'msg.loadError': 'No se pudieron cargar los carruseles. Asegúrate de que el plugin Photo Carousel esté activo.',
    'msg.nameRequired': 'Escribe un nombre para el carrusel',
    'msg.saveError': 'No se pudo guardar: {msg}',
    'msg.deleteError': 'No se pudo eliminar: {msg}',
    'msg.unknownError': 'Error desconocido',
    'msg.shortcodeCopied': '¡Shortcode copiado!',
    'confirm.deleteBody': '¿Seguro que quieres eliminar este carrusel? Esta acción no se puede deshacer.',
    'confirm.deleteTitle': 'Eliminar carrusel',
    // grid
    'grid.new': 'Nuevo carrusel',
    'grid.newHelp': 'Crea una nueva presentación para las cabeceras o el contenido de tus páginas.',
    'grid.imageCount': '{n} imágenes',
    'grid.edit': 'Editar',
    'grid.delete': 'Eliminar',
    'grid.autoplay': 'Reproducción automática',
    'grid.manual': 'Manual',
    'grid.interval': 'intervalo de {s}s',
    'grid.copyShortcode': 'Haz clic para copiar el shortcode',
    // modal
    'modal.edit': 'Editar carrusel',
    'modal.new': 'Nuevo carrusel',
    'modal.name': 'Nombre',
    'modal.namePlaceholder': 'p. ej. Portada principal',
    'modal.images': 'Imágenes ({n})',
    'modal.dragHint': 'Arrastra para reordenar',
    'modal.removeImage': 'Quitar imagen',
    'modal.addImage': 'Añadir imagen',
    'modal.imageDetails': 'Detalles de la imagen',
    'modal.done': 'Listo',
    'modal.bigTitle': 'Título grande',
    'modal.bigTitlePlaceholder': 'p. ej. CONFERENCIAS',
    'modal.subtitle': 'Subtítulo',
    'modal.subtitlePlaceholder': 'p. ej. BUCARAMANGA',
    'modal.paragraph': 'Texto del párrafo',
    'modal.paragraphPlaceholder': 'Descripción detallada o mensaje...',
    'modal.buttonText': 'Texto del botón',
    'modal.buttonTextPlaceholder': 'Etiqueta del botón',
    'modal.buttonLink': 'Enlace del botón',
    'modal.settings': 'Ajustes',
    'modal.location': 'Ubicación',
    'modal.locationNone': 'Ninguna (uso con shortcode)',
    'modal.locationHero': 'Hero (portada)',
    'modal.autoplay': 'Reproducción automática',
    'modal.enabled': 'Activada',
    'modal.disabled': 'Desactivada',
    'modal.interval': 'Intervalo',
    'modal.cancel': 'Cancelar',
    'modal.saving': 'Guardando...',
    'modal.save': 'Guardar carrusel',
};

const en = {
    // header
    'app.title': 'Carousels',
    'app.subtitle': 'Manage your image slideshows',
    // messages
    'msg.loadError': 'Failed to load carousels. Make sure the Photo Carousel plugin is active.',
    'msg.nameRequired': 'Please enter a name for the carousel',
    'msg.saveError': 'Failed to save: {msg}',
    'msg.deleteError': 'Failed to delete: {msg}',
    'msg.unknownError': 'Unknown error',
    'msg.shortcodeCopied': 'Shortcode copied!',
    'confirm.deleteBody': 'Are you sure you want to delete this carousel? This action cannot be undone.',
    'confirm.deleteTitle': 'Delete Carousel',
    // grid
    'grid.new': 'New Carousel',
    'grid.newHelp': 'Create a new slideshow for your page headers or content.',
    'grid.imageCount': '{n} images',
    'grid.edit': 'Edit',
    'grid.delete': 'Delete',
    'grid.autoplay': 'Autoplay',
    'grid.manual': 'Manual',
    'grid.interval': '{s}s interval',
    'grid.copyShortcode': 'Click to copy shortcode',
    // modal
    'modal.edit': 'Edit Carousel',
    'modal.new': 'New Carousel',
    'modal.name': 'Name',
    'modal.namePlaceholder': 'e.g. Homepage Hero',
    'modal.images': 'Images ({n})',
    'modal.dragHint': 'Drag to reorder',
    'modal.removeImage': 'Remove image',
    'modal.addImage': 'Add Image',
    'modal.imageDetails': 'Image Details',
    'modal.done': 'Done',
    'modal.bigTitle': 'Big Title',
    'modal.bigTitlePlaceholder': 'e.g. CONFERENCES',
    'modal.subtitle': 'Subtitle',
    'modal.subtitlePlaceholder': 'e.g. BUCARAMANGA',
    'modal.paragraph': 'Paragraph Text',
    'modal.paragraphPlaceholder': 'Detailed description or message...',
    'modal.buttonText': 'Button Text',
    'modal.buttonTextPlaceholder': 'Button Label',
    'modal.buttonLink': 'Button Link',
    'modal.settings': 'Settings',
    'modal.location': 'Location',
    'modal.locationNone': 'None (Shortcode usage)',
    'modal.locationHero': 'Hero (Homepage)',
    'modal.autoplay': 'Autoplay',
    'modal.enabled': 'Enabled',
    'modal.disabled': 'Disabled',
    'modal.interval': 'Interval',
    'modal.cancel': 'Cancel',
    'modal.saving': 'Saving...',
    'modal.save': 'Save Carousel',
};

const pt = {
    // header
    'app.title': 'Carrosséis',
    'app.subtitle': 'Gerencie suas apresentações de imagens',
    // messages
    'msg.loadError': 'Não foi possível carregar os carrosséis. Verifique se o plugin Photo Carousel está ativo.',
    'msg.nameRequired': 'Digite um nome para o carrossel',
    'msg.saveError': 'Não foi possível salvar: {msg}',
    'msg.deleteError': 'Não foi possível excluir: {msg}',
    'msg.unknownError': 'Erro desconhecido',
    'msg.shortcodeCopied': 'Shortcode copiado!',
    'confirm.deleteBody': 'Tem certeza de que deseja excluir este carrossel? Esta ação não pode ser desfeita.',
    'confirm.deleteTitle': 'Excluir carrossel',
    // grid
    'grid.new': 'Novo carrossel',
    'grid.newHelp': 'Crie uma nova apresentação para os cabeçalhos ou o conteúdo das suas páginas.',
    'grid.imageCount': '{n} imagens',
    'grid.edit': 'Editar',
    'grid.delete': 'Excluir',
    'grid.autoplay': 'Reprodução automática',
    'grid.manual': 'Manual',
    'grid.interval': 'intervalo de {s}s',
    'grid.copyShortcode': 'Clique para copiar o shortcode',
    // modal
    'modal.edit': 'Editar carrossel',
    'modal.new': 'Novo carrossel',
    'modal.name': 'Nome',
    'modal.namePlaceholder': 'ex.: Destaque da página inicial',
    'modal.images': 'Imagens ({n})',
    'modal.dragHint': 'Arraste para reordenar',
    'modal.removeImage': 'Remover imagem',
    'modal.addImage': 'Adicionar imagem',
    'modal.imageDetails': 'Detalhes da imagem',
    'modal.done': 'Concluído',
    'modal.bigTitle': 'Título grande',
    'modal.bigTitlePlaceholder': 'ex.: CONFERÊNCIAS',
    'modal.subtitle': 'Subtítulo',
    'modal.subtitlePlaceholder': 'ex.: BUCARAMANGA',
    'modal.paragraph': 'Texto do parágrafo',
    'modal.paragraphPlaceholder': 'Descrição detalhada ou mensagem...',
    'modal.buttonText': 'Texto do botão',
    'modal.buttonTextPlaceholder': 'Rótulo do botão',
    'modal.buttonLink': 'Link do botão',
    'modal.settings': 'Configurações',
    'modal.location': 'Local',
    'modal.locationNone': 'Nenhum (uso com shortcode)',
    'modal.locationHero': 'Hero (página inicial)',
    'modal.autoplay': 'Reprodução automática',
    'modal.enabled': 'Ativada',
    'modal.disabled': 'Desativada',
    'modal.interval': 'Intervalo',
    'modal.cancel': 'Cancelar',
    'modal.saving': 'Salvando...',
    'modal.save': 'Salvar carrossel',
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

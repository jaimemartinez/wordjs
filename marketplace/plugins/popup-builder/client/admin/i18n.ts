// @ts-nocheck
"use client";

// The Popup Builder admin screens follow the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // shell
    'app.title': 'Popups',
    'app.subtitle': 'Anuncios y promociones en todo el sitio · uno activo a la vez',
    'app.new': 'Nuevo popup',
    'app.loading': 'Cargando…',
    'app.empty': 'Todavía no hay popups. Crea el primero para mostrar un anuncio en el sitio público.',
    'app.create': 'Crear popup',
    'app.footnote': 'El popup activo se muestra automáticamente en todas las páginas públicas mientras el plugin esté activo. Marcar «Volver a mostrar a todos» al editar reinicia la frecuencia de todos los visitantes.',
    'app.loadError': 'Error al cargar los popups: {msg}',
    'app.error': 'Error: {msg}',
    'app.deleteError': 'Error al eliminar: {msg}',
    'app.confirmDelete': '¿Eliminar el popup "{title}"? Esta acción no se puede deshacer.',
    'app.saved': 'Popup guardado correctamente.',
    'common.cancel': 'Cancelar',
    'common.close': 'Cerrar',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    'common.edit': 'Editar',
    'common.delete': 'Eliminar',
    // triggers
    'trigger.delay': 'Retardo (segundos)',
    'trigger.scroll': 'Porcentaje de scroll',
    'trigger.exit': 'Intención de salida',
    'trigger.sumScroll': 'Scroll {n}%',
    'trigger.sumExit': 'Intención de salida',
    'trigger.sumDelay': 'Retardo {n} s',
    // frequency (select options)
    'freq.always': 'Siempre',
    'freq.session': 'Una vez por sesión',
    'freq.visitor': 'Una vez por visitante',
    'freq.daily': 'Una vez al día',
    // frequency (short labels on the list cards)
    'freqShort.always': 'Siempre',
    'freqShort.session': '1× por sesión',
    'freqShort.visitor': '1× por visitante',
    'freqShort.daily': '1× al día',
    // preview
    'preview.title': 'Título del popup',
    'preview.body': 'Texto del popup…',
    // editor modal
    'editor.edit': 'Editar popup',
    'editor.new': 'Nuevo popup',
    'editor.title': 'Título *',
    'editor.titlePlaceholder': '¡Oferta de verano!',
    'editor.body': 'Texto',
    'editor.bodyPlaceholder': 'Describe la promoción o el anuncio…',
    'editor.image': 'URL de la imagen (opcional)',
    'editor.imagePlaceholder': '/uploads/promo.jpg o https://…',
    'editor.buttonLabel': 'Texto del botón',
    'editor.buttonLabelPlaceholder': 'Ver oferta',
    'editor.buttonUrl': 'URL del botón',
    'editor.buttonUrlPlaceholder': '/tienda o https://…',
    'editor.trigger': 'Disparador',
    'editor.valueScroll': '% de scroll',
    'editor.valueSeconds': 'Segundos',
    'editor.frequency': 'Frecuencia',
    'editor.startsAt': 'Mostrar desde (opcional)',
    'editor.endsAt': 'Mostrar hasta (opcional)',
    'editor.activate': 'Activar este popup al guardar (desactiva los demás)',
    'editor.bump': 'Volver a mostrar a todos (reinicia la frecuencia de los visitantes)',
    'editor.preview': 'Vista previa',
    'editor.saveError': 'No se pudo guardar el popup.',
    // list card
    'card.active': 'Activo',
    'card.inactive': 'Inactivo',
    'card.from': 'Desde {date}',
    'card.until': 'Hasta {date}',
    'card.views': 'Vistas',
    'card.clicks': 'Clics',
    'card.ctr': 'CTR',
    'card.deactivate': 'Desactivar',
    'card.activate': 'Activar',
};

const en = {
    // shell
    'app.title': 'Popups',
    'app.subtitle': 'Site-wide announcements and promotions · one active at a time',
    'app.new': 'New popup',
    'app.loading': 'Loading…',
    'app.empty': 'No popups yet. Create the first one to show an announcement on the public site.',
    'app.create': 'Create popup',
    'app.footnote': 'The active popup is shown automatically on every public page while the plugin is active. Ticking “Show to everyone again” when editing resets the frequency for all visitors.',
    'app.loadError': 'Error loading popups: {msg}',
    'app.error': 'Error: {msg}',
    'app.deleteError': 'Error deleting: {msg}',
    'app.confirmDelete': 'Delete the popup "{title}"? This cannot be undone.',
    'app.saved': 'Popup saved successfully.',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    // triggers
    'trigger.delay': 'Delay (seconds)',
    'trigger.scroll': 'Scroll percentage',
    'trigger.exit': 'Exit intent',
    'trigger.sumScroll': 'Scroll {n}%',
    'trigger.sumExit': 'Exit intent',
    'trigger.sumDelay': 'Delay {n} s',
    // frequency (select options)
    'freq.always': 'Always',
    'freq.session': 'Once per session',
    'freq.visitor': 'Once per visitor',
    'freq.daily': 'Once a day',
    // frequency (short labels on the list cards)
    'freqShort.always': 'Always',
    'freqShort.session': '1× per session',
    'freqShort.visitor': '1× per visitor',
    'freqShort.daily': '1× a day',
    // preview
    'preview.title': 'Popup title',
    'preview.body': 'Popup text…',
    // editor modal
    'editor.edit': 'Edit popup',
    'editor.new': 'New popup',
    'editor.title': 'Title *',
    'editor.titlePlaceholder': 'Summer sale!',
    'editor.body': 'Text',
    'editor.bodyPlaceholder': 'Describe the promotion or announcement…',
    'editor.image': 'Image URL (optional)',
    'editor.imagePlaceholder': '/uploads/promo.jpg or https://…',
    'editor.buttonLabel': 'Button text',
    'editor.buttonLabelPlaceholder': 'See offer',
    'editor.buttonUrl': 'Button URL',
    'editor.buttonUrlPlaceholder': '/shop or https://…',
    'editor.trigger': 'Trigger',
    'editor.valueScroll': 'Scroll %',
    'editor.valueSeconds': 'Seconds',
    'editor.frequency': 'Frequency',
    'editor.startsAt': 'Show from (optional)',
    'editor.endsAt': 'Show until (optional)',
    'editor.activate': 'Activate this popup on save (deactivates the others)',
    'editor.bump': 'Show to everyone again (resets visitor frequency)',
    'editor.preview': 'Preview',
    'editor.saveError': 'Could not save the popup.',
    // list card
    'card.active': 'Active',
    'card.inactive': 'Inactive',
    'card.from': 'From {date}',
    'card.until': 'Until {date}',
    'card.views': 'Views',
    'card.clicks': 'Clicks',
    'card.ctr': 'CTR',
    'card.deactivate': 'Deactivate',
    'card.activate': 'Activate',
};

const pt = {
    // shell
    'app.title': 'Popups',
    'app.subtitle': 'Anúncios e promoções em todo o site · um ativo por vez',
    'app.new': 'Novo popup',
    'app.loading': 'Carregando…',
    'app.empty': 'Ainda não há popups. Crie o primeiro para exibir um anúncio no site público.',
    'app.create': 'Criar popup',
    'app.footnote': 'O popup ativo é exibido automaticamente em todas as páginas públicas enquanto o plugin estiver ativo. Marcar «Mostrar novamente a todos» ao editar reinicia a frequência de todos os visitantes.',
    'app.loadError': 'Erro ao carregar os popups: {msg}',
    'app.error': 'Erro: {msg}',
    'app.deleteError': 'Erro ao excluir: {msg}',
    'app.confirmDelete': 'Excluir o popup "{title}"? Esta ação não pode ser desfeita.',
    'app.saved': 'Popup salvo com sucesso.',
    'common.cancel': 'Cancelar',
    'common.close': 'Fechar',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    'common.edit': 'Editar',
    'common.delete': 'Excluir',
    // triggers
    'trigger.delay': 'Atraso (segundos)',
    'trigger.scroll': 'Porcentagem de rolagem',
    'trigger.exit': 'Intenção de saída',
    'trigger.sumScroll': 'Rolagem {n}%',
    'trigger.sumExit': 'Intenção de saída',
    'trigger.sumDelay': 'Atraso {n} s',
    // frequency (select options)
    'freq.always': 'Sempre',
    'freq.session': 'Uma vez por sessão',
    'freq.visitor': 'Uma vez por visitante',
    'freq.daily': 'Uma vez por dia',
    // frequency (short labels on the list cards)
    'freqShort.always': 'Sempre',
    'freqShort.session': '1× por sessão',
    'freqShort.visitor': '1× por visitante',
    'freqShort.daily': '1× por dia',
    // preview
    'preview.title': 'Título do popup',
    'preview.body': 'Texto do popup…',
    // editor modal
    'editor.edit': 'Editar popup',
    'editor.new': 'Novo popup',
    'editor.title': 'Título *',
    'editor.titlePlaceholder': 'Oferta de verão!',
    'editor.body': 'Texto',
    'editor.bodyPlaceholder': 'Descreva a promoção ou o anúncio…',
    'editor.image': 'URL da imagem (opcional)',
    'editor.imagePlaceholder': '/uploads/promo.jpg ou https://…',
    'editor.buttonLabel': 'Texto do botão',
    'editor.buttonLabelPlaceholder': 'Ver oferta',
    'editor.buttonUrl': 'URL do botão',
    'editor.buttonUrlPlaceholder': '/loja ou https://…',
    'editor.trigger': 'Gatilho',
    'editor.valueScroll': '% de rolagem',
    'editor.valueSeconds': 'Segundos',
    'editor.frequency': 'Frequência',
    'editor.startsAt': 'Mostrar a partir de (opcional)',
    'editor.endsAt': 'Mostrar até (opcional)',
    'editor.activate': 'Ativar este popup ao salvar (desativa os demais)',
    'editor.bump': 'Mostrar novamente a todos (reinicia a frequência dos visitantes)',
    'editor.preview': 'Pré-visualização',
    'editor.saveError': 'Não foi possível salvar o popup.',
    // list card
    'card.active': 'Ativo',
    'card.inactive': 'Inativo',
    'card.from': 'A partir de {date}',
    'card.until': 'Até {date}',
    'card.views': 'Visualizações',
    'card.clicks': 'Cliques',
    'card.ctr': 'CTR',
    'card.deactivate': 'Desativar',
    'card.activate': 'Ativar',
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

// @ts-nocheck
"use client";

// The Notification Bar admin screen follows the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    'app.title': 'Barra de Anuncios',
    'app.subtitle': 'Aviso fijo en todo el sitio — mensaje, enlace, colores y programación',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    // preview
    'preview.label': 'Vista previa ({where})',
    'preview.top': 'arriba del sitio',
    'preview.bottom': 'abajo del sitio',
    'preview.empty': '(escribe un mensaje abajo)',
    'status.on': 'Activa',
    'status.off': 'Desactivada',
    // form
    'form.enabled': 'Mostrar la barra en el sitio',
    'form.message': 'Mensaje',
    'form.messagePlaceholder': 'Ej.: Envío gratis en pedidos superiores a 50 € hasta el domingo',
    'form.linkLabel': 'Etiqueta del enlace (opcional)',
    'form.linkLabelPlaceholder': 'Ver ofertas',
    'form.linkUrl': 'URL del enlace (opcional)',
    'form.linkUrlPlaceholder': 'https://… o /pagina',
    'form.bgColor': 'Color de fondo',
    'form.textColor': 'Color del texto',
    'form.position': 'Posición',
    'form.posTop': 'Superior (arriba)',
    'form.posBottom': 'Inferior (abajo)',
    'form.dismissible': 'Permitir cerrar la barra (botón ×)',
    'form.startsAt': 'Mostrar desde (opcional)',
    'form.endsAt': 'Mostrar hasta (opcional)',
    'form.clearSchedule': 'Quitar programación',
    'form.reprompt': 'Volver a mostrar a quienes la cerraron',
    'form.repromptHelp': 'Al guardar se incrementa la versión del aviso (actual: v{version}), así la barra reaparece para los visitantes que ya la habían cerrado. Úsalo cuando cambies el mensaje.',
    // messages
    'msg.loadError': 'Error: no se pudo cargar la configuración. ¿Está activo el plugin?',
    'msg.savedReprompt': 'Guardado — la barra se volverá a mostrar a todos (versión {version}).',
    'msg.saved': 'Guardado — la configuración de la barra se actualizó.',
    'msg.saveError': 'Error al guardar: {msg}',
    'footnote': 'La barra se muestra en todas las páginas públicas mientras el plugin esté activo y "Mostrar la barra" esté marcado. Si defines un rango de fechas, solo aparece dentro de ese rango. El cierre se recuerda en el navegador del visitante hasta que incrementes la versión.',
};

const en = {
    'app.title': 'Announcement Bar',
    'app.subtitle': 'Site-wide sticky notice — message, link, colors and schedule',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    // preview
    'preview.label': 'Preview ({where})',
    'preview.top': 'top of the site',
    'preview.bottom': 'bottom of the site',
    'preview.empty': '(write a message below)',
    'status.on': 'Active',
    'status.off': 'Disabled',
    // form
    'form.enabled': 'Show the bar on the site',
    'form.message': 'Message',
    'form.messagePlaceholder': 'E.g.: Free shipping on orders over €50 until Sunday',
    'form.linkLabel': 'Link label (optional)',
    'form.linkLabelPlaceholder': 'See offers',
    'form.linkUrl': 'Link URL (optional)',
    'form.linkUrlPlaceholder': 'https://… or /page',
    'form.bgColor': 'Background color',
    'form.textColor': 'Text color',
    'form.position': 'Position',
    'form.posTop': 'Top',
    'form.posBottom': 'Bottom',
    'form.dismissible': 'Allow closing the bar (× button)',
    'form.startsAt': 'Show from (optional)',
    'form.endsAt': 'Show until (optional)',
    'form.clearSchedule': 'Clear schedule',
    'form.reprompt': 'Show it again to those who closed it',
    'form.repromptHelp': 'Saving bumps the notice version (current: v{version}), so the bar reappears for visitors who had already closed it. Use it when you change the message.',
    // messages
    'msg.loadError': 'Error: the configuration could not be loaded. Is the plugin active?',
    'msg.savedReprompt': 'Saved — the bar will be shown to everyone again (version {version}).',
    'msg.saved': 'Saved — the bar configuration was updated.',
    'msg.saveError': 'Error saving: {msg}',
    'footnote': 'The bar is shown on every public page while the plugin is active and "Show the bar" is checked. If you set a date range, it only appears within that range. Closing it is remembered in the visitor\'s browser until you bump the version.',
};

const pt = {
    'app.title': 'Barra de Avisos',
    'app.subtitle': 'Aviso fixo em todo o site — mensagem, link, cores e agendamento',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    // preview
    'preview.label': 'Pré-visualização ({where})',
    'preview.top': 'topo do site',
    'preview.bottom': 'rodapé do site',
    'preview.empty': '(escreva uma mensagem abaixo)',
    'status.on': 'Ativa',
    'status.off': 'Desativada',
    // form
    'form.enabled': 'Mostrar a barra no site',
    'form.message': 'Mensagem',
    'form.messagePlaceholder': 'Ex.: Frete grátis em pedidos acima de 50 € até domingo',
    'form.linkLabel': 'Texto do link (opcional)',
    'form.linkLabelPlaceholder': 'Ver ofertas',
    'form.linkUrl': 'URL do link (opcional)',
    'form.linkUrlPlaceholder': 'https://… ou /pagina',
    'form.bgColor': 'Cor de fundo',
    'form.textColor': 'Cor do texto',
    'form.position': 'Posição',
    'form.posTop': 'Superior (em cima)',
    'form.posBottom': 'Inferior (embaixo)',
    'form.dismissible': 'Permitir fechar a barra (botão ×)',
    'form.startsAt': 'Mostrar a partir de (opcional)',
    'form.endsAt': 'Mostrar até (opcional)',
    'form.clearSchedule': 'Remover agendamento',
    'form.reprompt': 'Mostrar novamente para quem a fechou',
    'form.repromptHelp': 'Ao salvar, a versão do aviso é incrementada (atual: v{version}), assim a barra reaparece para os visitantes que já a tinham fechado. Use quando mudar a mensagem.',
    // messages
    'msg.loadError': 'Erro: não foi possível carregar a configuração. O plugin está ativo?',
    'msg.savedReprompt': 'Salvo — a barra voltará a ser mostrada para todos (versão {version}).',
    'msg.saved': 'Salvo — a configuração da barra foi atualizada.',
    'msg.saveError': 'Erro ao salvar: {msg}',
    'footnote': 'A barra é mostrada em todas as páginas públicas enquanto o plugin estiver ativo e "Mostrar a barra" estiver marcado. Se você definir um intervalo de datas, ela só aparece dentro desse intervalo. O fechamento é lembrado no navegador do visitante até você incrementar a versão.',
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

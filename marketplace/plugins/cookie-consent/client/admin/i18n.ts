// @ts-nocheck
"use client";

// The Cookie Consent admin screen follows the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
// Note: the banner's own texts (default message/button labels and the preview's fallbacks) are site
// content that mirrors public/banner.js, so they are not part of these tables.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // shell
    'app.title': 'Cookie Consent',
    'app.subtitle': 'Banner de cookies (RGPD) en todo el sitio público + estadísticas anónimas',
    // form
    'form.enabled': 'Mostrar el banner en el sitio público',
    'form.message': 'Mensaje (máx. 500 caracteres)',
    'form.accept': 'Botón aceptar (máx. 40)',
    'form.reject': 'Botón rechazar (máx. 40)',
    'form.policy': 'URL de la política de cookies (opcional)',
    'form.policyPh': 'https://misitio.com/politica-de-cookies',
    'form.position': 'Posición',
    'form.position.bottom': 'Barra inferior (todo el ancho)',
    'form.position.corner': 'Tarjeta en la esquina',
    'form.theme': 'Tema',
    'form.theme.dark': 'Oscuro',
    'form.theme.light': 'Claro',
    'form.reprompt.title': 'Volver a preguntar a todos',
    'form.reprompt.text': 'Al guardar se invalida el consentimiento guardado de cada visitante y el banner se muestra de nuevo (versión actual: {version}).',
    'form.help': 'El banner aparece en el sitio público cuando el plugin está activo y habilitado.',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    // messages
    'msg.savedReprompt': 'Guardado — el banner volverá a mostrarse a todos los visitantes (versión {version}).',
    'msg.saved': 'Configuración guardada.',
    'msg.saveError': 'Error al guardar: {msg}',
    // preview
    'preview.title': 'Vista previa',
    'preview.help': 'Vista aproximada — en el sitio público el banner usa su propia hoja de estilos y se adapta al ancho real de la página.',
    // stats
    'stats.title': 'Estadísticas de consentimiento',
    'stats.anonymous': 'Registro anónimo — sin datos personales',
    'stats.noData': 'Sin datos todavía — las elecciones de los visitantes aparecerán aquí.',
    'stats.total': 'Total',
    'stats.accepted': 'Aceptados',
    'stats.rejected': 'Rechazados',
    'stats.acceptPct': '% aceptación',
    'stats.noChoices': 'Aún no hay elecciones registradas.',
    'stats.last30': 'Últimos 30 días con actividad',
};

const en = {
    'app.title': 'Cookie Consent',
    'app.subtitle': 'Cookie banner (GDPR) across the whole public site + anonymous statistics',
    'form.enabled': 'Show the banner on the public site',
    'form.message': 'Message (max. 500 characters)',
    'form.accept': 'Accept button (max. 40)',
    'form.reject': 'Reject button (max. 40)',
    'form.policy': 'Cookie policy URL (optional)',
    'form.policyPh': 'https://mysite.com/cookie-policy',
    'form.position': 'Position',
    'form.position.bottom': 'Bottom bar (full width)',
    'form.position.corner': 'Corner card',
    'form.theme': 'Theme',
    'form.theme.dark': 'Dark',
    'form.theme.light': 'Light',
    'form.reprompt.title': 'Ask everyone again',
    'form.reprompt.text': "Saving invalidates every visitor's stored consent and the banner is shown again (current version: {version}).",
    'form.help': 'The banner appears on the public site when the plugin is active and enabled.',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'msg.savedReprompt': 'Saved — the banner will be shown again to every visitor (version {version}).',
    'msg.saved': 'Settings saved.',
    'msg.saveError': 'Error saving: {msg}',
    'preview.title': 'Preview',
    'preview.help': 'Approximate view — on the public site the banner uses its own stylesheet and adapts to the real page width.',
    'stats.title': 'Consent statistics',
    'stats.anonymous': 'Anonymous log — no personal data',
    'stats.noData': "No data yet — visitors' choices will appear here.",
    'stats.total': 'Total',
    'stats.accepted': 'Accepted',
    'stats.rejected': 'Rejected',
    'stats.acceptPct': '% accepted',
    'stats.noChoices': 'No choices recorded yet.',
    'stats.last30': 'Last 30 days with activity',
};

const pt = {
    'app.title': 'Cookie Consent',
    'app.subtitle': 'Banner de cookies (LGPD/GDPR) em todo o site público + estatísticas anônimas',
    'form.enabled': 'Mostrar o banner no site público',
    'form.message': 'Mensagem (máx. 500 caracteres)',
    'form.accept': 'Botão aceitar (máx. 40)',
    'form.reject': 'Botão recusar (máx. 40)',
    'form.policy': 'URL da política de cookies (opcional)',
    'form.policyPh': 'https://meusite.com/politica-de-cookies',
    'form.position': 'Posição',
    'form.position.bottom': 'Barra inferior (largura total)',
    'form.position.corner': 'Cartão no canto',
    'form.theme': 'Tema',
    'form.theme.dark': 'Escuro',
    'form.theme.light': 'Claro',
    'form.reprompt.title': 'Perguntar novamente a todos',
    'form.reprompt.text': 'Ao salvar, o consentimento armazenado de cada visitante é invalidado e o banner é exibido novamente (versão atual: {version}).',
    'form.help': 'O banner aparece no site público quando o plugin está ativo e habilitado.',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    'msg.savedReprompt': 'Salvo — o banner voltará a ser exibido a todos os visitantes (versão {version}).',
    'msg.saved': 'Configurações salvas.',
    'msg.saveError': 'Erro ao salvar: {msg}',
    'preview.title': 'Pré-visualização',
    'preview.help': 'Visualização aproximada — no site público o banner usa sua própria folha de estilos e se adapta à largura real da página.',
    'stats.title': 'Estatísticas de consentimento',
    'stats.anonymous': 'Registro anônimo — sem dados pessoais',
    'stats.noData': 'Ainda sem dados — as escolhas dos visitantes aparecerão aqui.',
    'stats.total': 'Total',
    'stats.accepted': 'Aceitos',
    'stats.rejected': 'Recusados',
    'stats.acceptPct': '% de aceitação',
    'stats.noChoices': 'Ainda não há escolhas registradas.',
    'stats.last30': 'Últimos 30 dias com atividade',
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

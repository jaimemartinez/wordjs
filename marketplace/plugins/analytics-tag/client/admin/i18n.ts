// @ts-nocheck
"use client";

// The Analytics Tag admin screen follows the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // header
    'app.title': 'Analytics',
    'app.subtitle': 'Etiqueta de analítica en todo el sitio — GA4, Plausible o Matomo',
    'app.loading': 'Cargando configuración…',
    'app.loadError': 'No se pudo cargar la configuración: {msg}',
    // settings form
    'enabled.label': 'Activar la analítica',
    'enabled.hint': 'Inyecta el script del proveedor elegido en todas las páginas públicas del sitio.',
    'provider.label': 'Proveedor',
    'ga4.label': 'ID de medición (GA4)',
    'ga4.help': 'Lo encuentras en Google Analytics → Administrar → Flujos de datos. Formato G-XXXXXXXXXX.',
    'plausible.label': 'Dominio (Plausible)',
    'plausible.placeholder': 'midominio.com',
    'plausible.help': 'El dominio tal como está dado de alta en Plausible — solo el nombre de host, sin https:// ni rutas.',
    'matomo.urlLabel': 'URL de la instancia Matomo',
    'matomo.urlPlaceholder': 'https://analitica.midominio.com',
    'matomo.urlHelp': 'Debe ser una URL https://. El cargador le añade /matomo.js y /matomo.php automáticamente.',
    'matomo.siteLabel': 'ID de sitio (Matomo)',
    'matomo.siteHelp': 'Solo dígitos — el idSite que Matomo asigna a este sitio web.',
    'consent.label': 'Respetar el consentimiento de cookies',
    'consent.hint': 'Espera a que el visitante acepte las cookies si el plugin cookie-consent está activo. Si el visitante las rechaza, no se carga nada; si no hay gestor de consentimiento instalado, el script se carga igualmente.',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    'saved': 'Configuración guardada.',
    'error.save': 'Error al guardar: {msg}',
    // status card
    'status.title': 'Estado',
    'status.injecting': 'Inyectando',
    'status.notInjecting': 'Sin inyectar',
    'status.disabled': 'La analítica está desactivada — no se inyecta ningún script en el sitio público.',
    'status.incomplete': 'Activada pero incompleta: faltan datos de {provider}. Completa los campos y guarda.',
    'status.injectedEverywhere': ' se inyecta en todas las páginas públicas.',
    'status.ga4Detail': 'gtag.js con el ID ',
    'status.plausibleDetail': 'plausible.io/js/script.js para el dominio ',
    'status.matomoDetail': ' con idSite ',
    'status.waitsConsent': 'Espera la aceptación de cookies del visitante (integración con cookie-consent; sin gestor de consentimiento se carga directamente).',
    'status.immediate': 'Se inyecta inmediatamente, sin esperar consentimiento.',
    'footnote1': 'El script cargador se sirve solo en las páginas públicas mientras el plugin está activo. Recuerda conceder el permiso de ',
    'footnote2': ' al plugin en la pantalla de Plugins para que el cargador pueda publicarse.',
};

const en = {
    // header
    'app.title': 'Analytics',
    'app.subtitle': 'Site-wide analytics tag — GA4, Plausible or Matomo',
    'app.loading': 'Loading settings…',
    'app.loadError': 'Could not load the settings: {msg}',
    // settings form
    'enabled.label': 'Enable analytics',
    'enabled.hint': "Injects the chosen provider's script on every public page of the site.",
    'provider.label': 'Provider',
    'ga4.label': 'Measurement ID (GA4)',
    'ga4.help': 'You can find it in Google Analytics → Admin → Data streams. Format G-XXXXXXXXXX.',
    'plausible.label': 'Domain (Plausible)',
    'plausible.placeholder': 'mydomain.com',
    'plausible.help': 'The domain exactly as it is registered in Plausible — just the host name, without https:// or paths.',
    'matomo.urlLabel': 'Matomo instance URL',
    'matomo.urlPlaceholder': 'https://analytics.mydomain.com',
    'matomo.urlHelp': 'Must be an https:// URL. The loader appends /matomo.js and /matomo.php automatically.',
    'matomo.siteLabel': 'Site ID (Matomo)',
    'matomo.siteHelp': 'Digits only — the idSite Matomo assigns to this website.',
    'consent.label': 'Respect cookie consent',
    'consent.hint': "Waits for the visitor to accept cookies if the cookie-consent plugin is active. If the visitor rejects them, nothing is loaded; if no consent manager is installed, the script loads anyway.",
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'saved': 'Settings saved.',
    'error.save': 'Error saving: {msg}',
    // status card
    'status.title': 'Status',
    'status.injecting': 'Injecting',
    'status.notInjecting': 'Not injecting',
    'status.disabled': 'Analytics is disabled — no script is injected on the public site.',
    'status.incomplete': 'Enabled but incomplete: {provider} details are missing. Fill in the fields and save.',
    'status.injectedEverywhere': ' is injected on every public page.',
    'status.ga4Detail': 'gtag.js with the ID ',
    'status.plausibleDetail': 'plausible.io/js/script.js for the domain ',
    'status.matomoDetail': ' with idSite ',
    'status.waitsConsent': "Waits for the visitor's cookie acceptance (cookie-consent integration; without a consent manager it loads directly).",
    'status.immediate': 'Injected immediately, without waiting for consent.',
    'footnote1': 'The loader script is served only on public pages while the plugin is active. Remember to grant the ',
    'footnote2': ' permission to the plugin on the Plugins screen so the loader can be published.',
};

const pt = {
    // header
    'app.title': 'Analytics',
    'app.subtitle': 'Tag de analytics em todo o site — GA4, Plausible ou Matomo',
    'app.loading': 'Carregando configurações…',
    'app.loadError': 'Não foi possível carregar as configurações: {msg}',
    // settings form
    'enabled.label': 'Ativar o analytics',
    'enabled.hint': 'Injeta o script do provedor escolhido em todas as páginas públicas do site.',
    'provider.label': 'Provedor',
    'ga4.label': 'ID de métricas (GA4)',
    'ga4.help': 'Você o encontra em Google Analytics → Administrador → Fluxos de dados. Formato G-XXXXXXXXXX.',
    'plausible.label': 'Domínio (Plausible)',
    'plausible.placeholder': 'meudominio.com',
    'plausible.help': 'O domínio exatamente como está cadastrado no Plausible — apenas o nome do host, sem https:// nem caminhos.',
    'matomo.urlLabel': 'URL da instância do Matomo',
    'matomo.urlPlaceholder': 'https://analytics.meudominio.com',
    'matomo.urlHelp': 'Deve ser uma URL https://. O carregador acrescenta /matomo.js e /matomo.php automaticamente.',
    'matomo.siteLabel': 'ID do site (Matomo)',
    'matomo.siteHelp': 'Somente dígitos — o idSite que o Matomo atribui a este site.',
    'consent.label': 'Respeitar o consentimento de cookies',
    'consent.hint': 'Aguarda o visitante aceitar os cookies se o plugin cookie-consent estiver ativo. Se o visitante os recusar, nada é carregado; se não houver gerenciador de consentimento instalado, o script é carregado mesmo assim.',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    'saved': 'Configurações salvas.',
    'error.save': 'Erro ao salvar: {msg}',
    // status card
    'status.title': 'Status',
    'status.injecting': 'Injetando',
    'status.notInjecting': 'Sem injetar',
    'status.disabled': 'O analytics está desativado — nenhum script é injetado no site público.',
    'status.incomplete': 'Ativado, mas incompleto: faltam dados do {provider}. Preencha os campos e salve.',
    'status.injectedEverywhere': ' é injetado em todas as páginas públicas.',
    'status.ga4Detail': 'gtag.js com o ID ',
    'status.plausibleDetail': 'plausible.io/js/script.js para o domínio ',
    'status.matomoDetail': ' com idSite ',
    'status.waitsConsent': 'Aguarda a aceitação de cookies do visitante (integração com o cookie-consent; sem gerenciador de consentimento, é carregado diretamente).',
    'status.immediate': 'É injetado imediatamente, sem aguardar consentimento.',
    'footnote1': 'O script carregador é servido apenas nas páginas públicas enquanto o plugin está ativo. Lembre-se de conceder a permissão de ',
    'footnote2': ' ao plugin na tela de Plugins para que o carregador possa ser publicado.',
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

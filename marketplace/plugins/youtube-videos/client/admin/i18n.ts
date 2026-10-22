// @ts-nocheck
"use client";

// The YouTube Videos admin screen follows the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // shell
    'app.title': 'YouTube Videos',
    'app.subtitle': 'Configura la sincronización de videos para el editor visual',
    // settings form
    'form.title': 'Ajustes de Sincronización',
    'form.channel': 'Canal (UC…, @handle o URL)',
    'form.channelPh': '@micanal · UCxxxxxxxx · https://youtube.com/@micanal',
    'form.ttl': 'Intervalo de Actualización de Caché (minutos)',
    'form.ttlHelp': 'Tiempo que el plugin mantendrá los vídeos guardados localmente antes de consultar a YouTube de nuevo (mínimo 1 minuto).',
    'form.apiKey': 'YouTube Data API v3 key (opcional)',
    'form.apiKeyPhSet': '(configurada — escribe para reemplazar)',
    'form.apiKeyPhUnset': '(sin key: modo RSS, últimos 15 videos)',
    'form.apiKeyNote': 'Sin API Key se utiliza el feed RSS público del canal (límite de 15 videos). Para obtener el historial completo (hasta 500 videos) ingresa una API Key válida.',
    'form.clearKey': 'Quitar la API Key guardada (volver a modo RSS)',
    'form.refresh': 'Actualizar',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    // messages
    'msg.savedButFailed': 'Guardado, pero la carga falló: {error}',
    'msg.saved': 'Guardado — {count} videos (modo {mode}).',
    'msg.modeApi': 'API completa',
    'msg.modeRss': 'RSS',
    'msg.saveError': 'Error al guardar: {msg}',
    'msg.loadFailed': 'La carga falló: {error}',
    'msg.refreshed': 'Actualizado — {count} videos.',
    'msg.error': 'Error: {msg}',
    // status card
    'status.title': 'Estado del Plugin',
    'status.videos': 'Videos importados',
    'status.mode': 'Modo de carga',
    'status.modeApi': 'API v3',
    'status.modeRss': 'RSS Feed',
    'status.lastUpdate': 'Última actualización',
    'status.never': 'Nunca',
    'status.loading': 'Cargando estado...',
    'status.lastError': 'Último error: {error}',
    // preview
    'preview.title': 'Vista Previa de Videos',
    'preview.cached': 'En caché',
    'preview.empty': 'Sin videos cargados aún. Configura el canal e importa los videos.',
    'preview.note.before': 'Para mostrar estos videos en tu sitio web, agrega el bloque',
    'preview.note.after': 'en el editor visual. Podrás configurar filtros, límites de cantidad, reproducción automática e intervalos.',
};

const en = {
    'app.title': 'YouTube Videos',
    'app.subtitle': 'Set up video syncing for the visual editor',
    'form.title': 'Sync Settings',
    'form.channel': 'Channel (UC…, @handle or URL)',
    'form.channelPh': '@mychannel · UCxxxxxxxx · https://youtube.com/@mychannel',
    'form.ttl': 'Cache Refresh Interval (minutes)',
    'form.ttlHelp': 'How long the plugin keeps the videos stored locally before checking YouTube again (minimum 1 minute).',
    'form.apiKey': 'YouTube Data API v3 key (optional)',
    'form.apiKeyPhSet': '(set — type to replace)',
    'form.apiKeyPhUnset': '(no key: RSS mode, latest 15 videos)',
    'form.apiKeyNote': "Without an API key the channel's public RSS feed is used (limit of 15 videos). To get the full history (up to 500 videos), enter a valid API key.",
    'form.clearKey': 'Remove the saved API key (go back to RSS mode)',
    'form.refresh': 'Refresh',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'msg.savedButFailed': 'Saved, but loading failed: {error}',
    'msg.saved': 'Saved — {count} videos ({mode} mode).',
    'msg.modeApi': 'full API',
    'msg.modeRss': 'RSS',
    'msg.saveError': 'Error saving: {msg}',
    'msg.loadFailed': 'Loading failed: {error}',
    'msg.refreshed': 'Refreshed — {count} videos.',
    'msg.error': 'Error: {msg}',
    'status.title': 'Plugin Status',
    'status.videos': 'Imported videos',
    'status.mode': 'Loading mode',
    'status.modeApi': 'API v3',
    'status.modeRss': 'RSS Feed',
    'status.lastUpdate': 'Last update',
    'status.never': 'Never',
    'status.loading': 'Loading status...',
    'status.lastError': 'Last error: {error}',
    'preview.title': 'Video Preview',
    'preview.cached': 'Cached',
    'preview.empty': 'No videos loaded yet. Set up the channel and import the videos.',
    'preview.note.before': 'To show these videos on your website, add the',
    'preview.note.after': 'block in the visual editor. You can configure filters, count limits, autoplay and intervals.',
};

const pt = {
    'app.title': 'YouTube Videos',
    'app.subtitle': 'Configure a sincronização de vídeos para o editor visual',
    'form.title': 'Configurações de Sincronização',
    'form.channel': 'Canal (UC…, @handle ou URL)',
    'form.channelPh': '@meucanal · UCxxxxxxxx · https://youtube.com/@meucanal',
    'form.ttl': 'Intervalo de Atualização do Cache (minutos)',
    'form.ttlHelp': 'Tempo que o plugin manterá os vídeos armazenados localmente antes de consultar o YouTube novamente (mínimo 1 minuto).',
    'form.apiKey': 'Chave da YouTube Data API v3 (opcional)',
    'form.apiKeyPhSet': '(configurada — digite para substituir)',
    'form.apiKeyPhUnset': '(sem chave: modo RSS, últimos 15 vídeos)',
    'form.apiKeyNote': 'Sem chave de API é usado o feed RSS público do canal (limite de 15 vídeos). Para obter o histórico completo (até 500 vídeos), informe uma chave de API válida.',
    'form.clearKey': 'Remover a chave de API salva (voltar ao modo RSS)',
    'form.refresh': 'Atualizar',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    'msg.savedButFailed': 'Salvo, mas o carregamento falhou: {error}',
    'msg.saved': 'Salvo — {count} vídeos (modo {mode}).',
    'msg.modeApi': 'API completa',
    'msg.modeRss': 'RSS',
    'msg.saveError': 'Erro ao salvar: {msg}',
    'msg.loadFailed': 'O carregamento falhou: {error}',
    'msg.refreshed': 'Atualizado — {count} vídeos.',
    'msg.error': 'Erro: {msg}',
    'status.title': 'Status do Plugin',
    'status.videos': 'Vídeos importados',
    'status.mode': 'Modo de carregamento',
    'status.modeApi': 'API v3',
    'status.modeRss': 'Feed RSS',
    'status.lastUpdate': 'Última atualização',
    'status.never': 'Nunca',
    'status.loading': 'Carregando status...',
    'status.lastError': 'Último erro: {error}',
    'preview.title': 'Pré-visualização dos Vídeos',
    'preview.cached': 'Em cache',
    'preview.empty': 'Ainda não há vídeos carregados. Configure o canal e importe os vídeos.',
    'preview.note.before': 'Para exibir estes vídeos no seu site, adicione o bloco',
    'preview.note.after': 'no editor visual. Você poderá configurar filtros, limites de quantidade, reprodução automática e intervalos.',
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

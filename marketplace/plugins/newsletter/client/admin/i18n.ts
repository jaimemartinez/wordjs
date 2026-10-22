// @ts-nocheck
"use client";

// The Newsletter admin screens follow the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // shell
    'app.title': 'Newsletter',
    'app.subtitle': 'Suscriptores + campañas de correo con enlace de baja automático',
    'app.closeNotice': 'Cerrar aviso',
    'app.mailError': 'No se pudo enviar el correo de confirmación ({msg}). Las nuevas suscripciones quedan pendientes hasta que el correo funcione.',
    'tab.subs': 'Suscriptores',
    'tab.camps': 'Campañas',
    'common.cancel': 'Cancelar',
    'common.close': 'Cerrar',
    'common.delete': 'Eliminar',
    'common.edit': 'Editar',
    // subscriber statuses
    'status.pending': 'Pendiente',
    'status.confirmed': 'Confirmado',
    'status.unsubscribed': 'Cancelado',
    // stats and filter chips
    'stats.total': 'Total',
    'filter.all': 'Todos',
    'filter.confirmed': 'Confirmados',
    'filter.pending': 'Pendientes',
    'filter.unsubscribed': 'Cancelados',
    // subscribers tab
    'subs.searchPlaceholder': 'Buscar por correo o nombre…',
    'subs.searchLabel': 'Buscar por correo o nombre',
    'subs.exportCsv': 'Exportar CSV',
    'subs.emptyFiltered': 'No hay suscriptores con ese filtro.',
    'subs.emptyNone': 'No hay suscriptores todavía — agrega el bloque Newsletter a una página.',
    'subs.colEmail': 'Correo',
    'subs.colName': 'Nombre',
    'subs.colStatus': 'Estado',
    'subs.colDate': 'Fecha',
    'subs.confirmDelete': '¿Eliminar este suscriptor definitivamente?',
    'subs.deleteError': 'No se pudo eliminar el suscriptor.',
    'subs.exportError': 'No se pudo exportar el CSV.',
    'subs.csvName': 'suscriptores.csv',
    // campaigns tab
    'camps.title': 'Campañas',
    'camps.new': 'Nueva campaña',
    'camps.empty': 'No hay campañas todavía — crea la primera con "Nueva campaña".',
    'camps.metaSent': 'Enviada · {sent} enviados{failed} · {date}',
    'camps.metaFailed': ' · {n} fallidos',
    'camps.metaDraft': 'Borrador · creada {date}',
    'camps.statusSent': 'Enviada',
    'camps.statusDraft': 'Borrador',
    'camps.sendTest': 'Enviar prueba',
    'camps.sending': 'Enviando…',
    'camps.sendTo': 'Enviar a {n} confirmados',
    'camps.footnote1': 'Los envíos van únicamente a los suscriptores ',
    'camps.footnoteStrong': 'confirmados',
    'camps.footnote2': '. Cada correo incluye automáticamente un enlace para cancelar la suscripción. Usa "Enviar prueba" para revisar el resultado antes del envío definitivo.',
    'camps.confirmDelete': '¿Eliminar la campaña "{subject}"?',
    'camps.deleteError': 'No se pudo eliminar la campaña.',
    'camps.testPrompt': 'Correo para enviar la prueba:',
    'camps.testSent': 'Prueba enviada a {to}.',
    'camps.testError': 'No se pudo enviar la prueba.',
    'camps.noConfirmed': 'No hay suscriptores confirmados a los que enviar.',
    'camps.confirmSend': '¿Enviar "{subject}" a {n} suscriptores confirmados? Esta acción no se puede deshacer.',
    'camps.sent': 'Campaña enviada: {sent} correos enviados{failed}.',
    'camps.sentFailed': ', {n} fallidos',
    'camps.sendError': 'No se pudo enviar la campaña.',
    'camps.saved': 'Campaña guardada.',
    // campaign modal
    'modal.edit': 'Editar campaña',
    'modal.new': 'Nueva campaña',
    'modal.subject': 'Asunto',
    'modal.subjectPlaceholder': 'Novedades de este mes',
    'modal.body': 'Contenido (HTML)',
    'modal.bodyPlaceholder': '<h1>Hola</h1>\n<p>Escribe aquí el contenido del boletín…</p>',
    'modal.help': 'Se permite HTML básico: <h1>–<h3>, <p>, <a>, <strong>, <em>, <ul>/<li>, <img>… El enlace para cancelar la suscripción se añade automáticamente al final de cada correo.',
    'modal.saving': 'Guardando…',
    'modal.saveDraft': 'Guardar borrador',
    'modal.saveError': 'No se pudo guardar la campaña.',
};

const en = {
    // shell
    'app.title': 'Newsletter',
    'app.subtitle': 'Subscribers + email campaigns with an automatic unsubscribe link',
    'app.closeNotice': 'Dismiss notice',
    'app.mailError': 'The confirmation email could not be sent ({msg}). New subscriptions stay pending until email works.',
    'tab.subs': 'Subscribers',
    'tab.camps': 'Campaigns',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    // subscriber statuses
    'status.pending': 'Pending',
    'status.confirmed': 'Confirmed',
    'status.unsubscribed': 'Unsubscribed',
    // stats and filter chips
    'stats.total': 'Total',
    'filter.all': 'All',
    'filter.confirmed': 'Confirmed',
    'filter.pending': 'Pending',
    'filter.unsubscribed': 'Unsubscribed',
    // subscribers tab
    'subs.searchPlaceholder': 'Search by email or name…',
    'subs.searchLabel': 'Search by email or name',
    'subs.exportCsv': 'Export CSV',
    'subs.emptyFiltered': 'No subscribers match that filter.',
    'subs.emptyNone': 'No subscribers yet — add the Newsletter block to a page.',
    'subs.colEmail': 'Email',
    'subs.colName': 'Name',
    'subs.colStatus': 'Status',
    'subs.colDate': 'Date',
    'subs.confirmDelete': 'Permanently delete this subscriber?',
    'subs.deleteError': 'Could not delete the subscriber.',
    'subs.exportError': 'Could not export the CSV.',
    'subs.csvName': 'subscribers.csv',
    // campaigns tab
    'camps.title': 'Campaigns',
    'camps.new': 'New campaign',
    'camps.empty': 'No campaigns yet — create the first one with "New campaign".',
    'camps.metaSent': 'Sent · {sent} delivered{failed} · {date}',
    'camps.metaFailed': ' · {n} failed',
    'camps.metaDraft': 'Draft · created {date}',
    'camps.statusSent': 'Sent',
    'camps.statusDraft': 'Draft',
    'camps.sendTest': 'Send test',
    'camps.sending': 'Sending…',
    'camps.sendTo': 'Send to {n} confirmed',
    'camps.footnote1': 'Campaigns go only to ',
    'camps.footnoteStrong': 'confirmed',
    'camps.footnote2': ' subscribers. Every email automatically includes an unsubscribe link. Use "Send test" to review the result before the final send.',
    'camps.confirmDelete': 'Delete the campaign "{subject}"?',
    'camps.deleteError': 'Could not delete the campaign.',
    'camps.testPrompt': 'Email address to send the test to:',
    'camps.testSent': 'Test sent to {to}.',
    'camps.testError': 'Could not send the test.',
    'camps.noConfirmed': 'There are no confirmed subscribers to send to.',
    'camps.confirmSend': 'Send "{subject}" to {n} confirmed subscribers? This cannot be undone.',
    'camps.sent': 'Campaign sent: {sent} emails delivered{failed}.',
    'camps.sentFailed': ', {n} failed',
    'camps.sendError': 'Could not send the campaign.',
    'camps.saved': 'Campaign saved.',
    // campaign modal
    'modal.edit': 'Edit campaign',
    'modal.new': 'New campaign',
    'modal.subject': 'Subject',
    'modal.subjectPlaceholder': "This month's news",
    'modal.body': 'Content (HTML)',
    'modal.bodyPlaceholder': '<h1>Hello</h1>\n<p>Write the newsletter content here…</p>',
    'modal.help': 'Basic HTML is allowed: <h1>–<h3>, <p>, <a>, <strong>, <em>, <ul>/<li>, <img>… The unsubscribe link is added automatically at the end of every email.',
    'modal.saving': 'Saving…',
    'modal.saveDraft': 'Save draft',
    'modal.saveError': 'Could not save the campaign.',
};

const pt = {
    // shell
    'app.title': 'Newsletter',
    'app.subtitle': 'Assinantes + campanhas de e-mail com link de descadastro automático',
    'app.closeNotice': 'Fechar aviso',
    'app.mailError': 'Não foi possível enviar o e-mail de confirmação ({msg}). As novas inscrições ficam pendentes até o e-mail funcionar.',
    'tab.subs': 'Assinantes',
    'tab.camps': 'Campanhas',
    'common.cancel': 'Cancelar',
    'common.close': 'Fechar',
    'common.delete': 'Excluir',
    'common.edit': 'Editar',
    // subscriber statuses
    'status.pending': 'Pendente',
    'status.confirmed': 'Confirmado',
    'status.unsubscribed': 'Descadastrado',
    // stats and filter chips
    'stats.total': 'Total',
    'filter.all': 'Todos',
    'filter.confirmed': 'Confirmados',
    'filter.pending': 'Pendentes',
    'filter.unsubscribed': 'Descadastrados',
    // subscribers tab
    'subs.searchPlaceholder': 'Buscar por e-mail ou nome…',
    'subs.searchLabel': 'Buscar por e-mail ou nome',
    'subs.exportCsv': 'Exportar CSV',
    'subs.emptyFiltered': 'Nenhum assinante com esse filtro.',
    'subs.emptyNone': 'Ainda não há assinantes — adicione o bloco Newsletter a uma página.',
    'subs.colEmail': 'E-mail',
    'subs.colName': 'Nome',
    'subs.colStatus': 'Status',
    'subs.colDate': 'Data',
    'subs.confirmDelete': 'Excluir este assinante definitivamente?',
    'subs.deleteError': 'Não foi possível excluir o assinante.',
    'subs.exportError': 'Não foi possível exportar o CSV.',
    'subs.csvName': 'assinantes.csv',
    // campaigns tab
    'camps.title': 'Campanhas',
    'camps.new': 'Nova campanha',
    'camps.empty': 'Ainda não há campanhas — crie a primeira com "Nova campanha".',
    'camps.metaSent': 'Enviada · {sent} enviados{failed} · {date}',
    'camps.metaFailed': ' · {n} com falha',
    'camps.metaDraft': 'Rascunho · criada em {date}',
    'camps.statusSent': 'Enviada',
    'camps.statusDraft': 'Rascunho',
    'camps.sendTest': 'Enviar teste',
    'camps.sending': 'Enviando…',
    'camps.sendTo': 'Enviar para {n} confirmados',
    'camps.footnote1': 'Os envios vão somente para os assinantes ',
    'camps.footnoteStrong': 'confirmados',
    'camps.footnote2': '. Cada e-mail inclui automaticamente um link para cancelar a inscrição. Use "Enviar teste" para revisar o resultado antes do envio definitivo.',
    'camps.confirmDelete': 'Excluir a campanha "{subject}"?',
    'camps.deleteError': 'Não foi possível excluir a campanha.',
    'camps.testPrompt': 'E-mail para enviar o teste:',
    'camps.testSent': 'Teste enviado para {to}.',
    'camps.testError': 'Não foi possível enviar o teste.',
    'camps.noConfirmed': 'Não há assinantes confirmados para enviar.',
    'camps.confirmSend': 'Enviar "{subject}" para {n} assinantes confirmados? Esta ação não pode ser desfeita.',
    'camps.sent': 'Campanha enviada: {sent} e-mails enviados{failed}.',
    'camps.sentFailed': ', {n} com falha',
    'camps.sendError': 'Não foi possível enviar a campanha.',
    'camps.saved': 'Campanha salva.',
    // campaign modal
    'modal.edit': 'Editar campanha',
    'modal.new': 'Nova campanha',
    'modal.subject': 'Assunto',
    'modal.subjectPlaceholder': 'Novidades deste mês',
    'modal.body': 'Conteúdo (HTML)',
    'modal.bodyPlaceholder': '<h1>Olá</h1>\n<p>Escreva aqui o conteúdo do boletim…</p>',
    'modal.help': 'HTML básico é permitido: <h1>–<h3>, <p>, <a>, <strong>, <em>, <ul>/<li>, <img>… O link para cancelar a inscrição é adicionado automaticamente ao final de cada e-mail.',
    'modal.saving': 'Salvando…',
    'modal.saveDraft': 'Salvar rascunho',
    'modal.saveError': 'Não foi possível salvar a campanha.',
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

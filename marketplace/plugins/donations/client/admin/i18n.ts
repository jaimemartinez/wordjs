// @ts-nocheck
"use client";

// The Donations admin screens follow the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // shell
    'app.title': 'Donaciones',
    'app.subtitle': 'Campañas con termómetro de meta · pago manual + Stripe opcional · exportación CSV',
    'tab.campaigns': 'Campañas',
    'tab.donations': 'Donaciones',
    'tab.config': 'Configuración',
    'common.cancel': 'Cancelar',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    'common.edit': 'Editar',
    'common.delete': 'Eliminar',
    'common.error': 'Error: {msg}',
    'common.noName': '(sin nombre)',
    // donation statuses
    'status.pending': 'Pendiente',
    'status.paid': 'Pagada',
    'status.cancelled': 'Cancelada',
    // campaign modal
    'camp.edit': 'Editar campaña',
    'camp.new': 'Nueva campaña',
    'camp.title': 'Título',
    'camp.slug': 'Slug (vacío = se genera del título)',
    'camp.slugPlaceholder': 'mi-campana',
    'camp.description': 'Descripción',
    'camp.goal': 'Meta ({symbol}) — 0 = sin meta',
    'camp.active': 'Activa',
    'camp.inactive': 'Inactiva',
    'camp.image': 'URL de imagen (opcional)',
    'camp.imagePlaceholder': '/uploads/2026/07/imagen.jpg',
    'camp.goalInvalid': 'La meta debe ser un número mayor o igual a 0.',
    'camp.saveError': 'No se pudo guardar la campaña.',
    // campaign card
    'camp.of': 'de',
    'camp.raisedNoGoal': 'recaudados (sin meta)',
    'camp.counts': '{paid} pagadas · {total} en total',
    // campaigns tab
    'campaigns.new': 'Nueva campaña',
    'campaigns.empty': 'Sin campañas todavía — crea la primera para empezar a recibir donaciones.',
    'campaigns.usage1': 'En el editor visual, agrega el bloque ',
    'campaigns.usage2': ' — muestra la campaña con su termómetro, montos sugeridos y formulario de donación (con su slug o la primera activa).',
    'campaigns.loadError': 'Error al cargar campañas: {msg}',
    'campaigns.confirmDelete': '¿Eliminar la campaña "{title}" y TODAS sus donaciones? Esta acción no se puede deshacer.',
    'campaigns.deleted': 'Campaña "{title}" eliminada.',
    'campaigns.saved': 'Campaña guardada.',
    // donations tab
    'donations.campaign': 'Campaña',
    'donations.all': 'Todas',
    'donations.status': 'Estado',
    'donations.allStatuses': 'Todos',
    'donations.exportCsv': 'Exportar CSV',
    'donations.raisedPaid': 'Recaudado (pagadas)',
    'donations.pending': 'Pendiente',
    'donations.count': 'Donaciones',
    'donations.empty': 'No hay donaciones con estos filtros.',
    'donations.colDate': 'Fecha',
    'donations.colDonor': 'Donante',
    'donations.colCampaign': 'Campaña',
    'donations.colAmount': 'Monto',
    'donations.colMethod': 'Método',
    'donations.colStatus': 'Estado',
    'donations.anonymous': 'Anónimo',
    'donations.methodCard': 'Tarjeta',
    'donations.methodManual': 'Manual',
    'donations.changeStatus': 'Cambiar estado de la donación',
    'donations.loadError': 'Error al cargar donaciones: {msg}',
    'donations.confirmDelete': '¿Eliminar la donación de {name} por {amount}?',
    'donations.exportError': 'Error al exportar: {msg}',
    'donations.csvName': 'donaciones.csv',
    // config tab
    'config.symbol': 'Símbolo de moneda',
    'config.code': 'Código de moneda (ISO, 3 letras)',
    'config.presets': 'Montos sugeridos (separados por comas, en {symbol})',
    'config.manual': 'Instrucciones de pago manual (siempre disponibles)',
    'config.manualPlaceholder': 'Transferencia a la cuenta 000-000000-00 del Banco X.\nEnvía tu comprobante a donaciones@misitio.com indicando tu referencia.',
    'config.notify': 'Email de notificaciones (nuevas donaciones)',
    'config.notifyPlaceholder': 'admin@misitio.com',
    'config.stripe': 'Stripe secret key (opcional — habilita pago con tarjeta)',
    'config.stripeSet': '(configurada — escribe para reemplazar)',
    'config.stripeUnset': 'sk_live_… (sin key: solo pago manual)',
    'config.stripeHelp': 'La key nunca se muestra de vuelta. Sin key, el bloque solo ofrece pago manual con las instrucciones de arriba. La verificación del pago se hace en el servidor al volver de Stripe.',
    'config.stripeClear': 'Quitar la key (deshabilitar pago con tarjeta)',
    'config.save': 'Guardar configuración',
    'config.saved': 'Configuración guardada.',
    'config.saveError': 'Error al guardar: {msg}',
};

const en = {
    // shell
    'app.title': 'Donations',
    'app.subtitle': 'Campaigns with a goal thermometer · manual payment + optional Stripe · CSV export',
    'tab.campaigns': 'Campaigns',
    'tab.donations': 'Donations',
    'tab.config': 'Settings',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'common.error': 'Error: {msg}',
    'common.noName': '(no name)',
    // donation statuses
    'status.pending': 'Pending',
    'status.paid': 'Paid',
    'status.cancelled': 'Cancelled',
    // campaign modal
    'camp.edit': 'Edit campaign',
    'camp.new': 'New campaign',
    'camp.title': 'Title',
    'camp.slug': 'Slug (empty = generated from the title)',
    'camp.slugPlaceholder': 'my-campaign',
    'camp.description': 'Description',
    'camp.goal': 'Goal ({symbol}) — 0 = no goal',
    'camp.active': 'Active',
    'camp.inactive': 'Inactive',
    'camp.image': 'Image URL (optional)',
    'camp.imagePlaceholder': '/uploads/2026/07/image.jpg',
    'camp.goalInvalid': 'The goal must be a number greater than or equal to 0.',
    'camp.saveError': 'The campaign could not be saved.',
    // campaign card
    'camp.of': 'of',
    'camp.raisedNoGoal': 'raised (no goal)',
    'camp.counts': '{paid} paid · {total} in total',
    // campaigns tab
    'campaigns.new': 'New campaign',
    'campaigns.empty': 'No campaigns yet — create the first one to start receiving donations.',
    'campaigns.usage1': 'In the visual editor, add the ',
    'campaigns.usage2': ' block — it shows the campaign with its thermometer, suggested amounts and the donation form (by its slug, or the first active one).',
    'campaigns.loadError': 'Error loading campaigns: {msg}',
    'campaigns.confirmDelete': 'Delete the campaign "{title}" and ALL its donations? This cannot be undone.',
    'campaigns.deleted': 'Campaign "{title}" deleted.',
    'campaigns.saved': 'Campaign saved.',
    // donations tab
    'donations.campaign': 'Campaign',
    'donations.all': 'All',
    'donations.status': 'Status',
    'donations.allStatuses': 'All',
    'donations.exportCsv': 'Export CSV',
    'donations.raisedPaid': 'Raised (paid)',
    'donations.pending': 'Pending',
    'donations.count': 'Donations',
    'donations.empty': 'No donations match these filters.',
    'donations.colDate': 'Date',
    'donations.colDonor': 'Donor',
    'donations.colCampaign': 'Campaign',
    'donations.colAmount': 'Amount',
    'donations.colMethod': 'Method',
    'donations.colStatus': 'Status',
    'donations.anonymous': 'Anonymous',
    'donations.methodCard': 'Card',
    'donations.methodManual': 'Manual',
    'donations.changeStatus': 'Change donation status',
    'donations.loadError': 'Error loading donations: {msg}',
    'donations.confirmDelete': 'Delete the donation from {name} for {amount}?',
    'donations.exportError': 'Error exporting: {msg}',
    'donations.csvName': 'donations.csv',
    // config tab
    'config.symbol': 'Currency symbol',
    'config.code': 'Currency code (ISO, 3 letters)',
    'config.presets': 'Suggested amounts (comma-separated, in {symbol})',
    'config.manual': 'Manual payment instructions (always available)',
    'config.manualPlaceholder': 'Transfer to account 000-000000-00 at Bank X.\nSend your receipt to donations@mysite.com quoting your reference.',
    'config.notify': 'Notification email (new donations)',
    'config.notifyPlaceholder': 'admin@mysite.com',
    'config.stripe': 'Stripe secret key (optional — enables card payments)',
    'config.stripeSet': '(set — type to replace)',
    'config.stripeUnset': 'sk_live_… (no key: manual payment only)',
    'config.stripeHelp': 'The key is never shown back. Without a key, the block only offers manual payment with the instructions above. Payments are verified on the server when the donor returns from Stripe.',
    'config.stripeClear': 'Remove the key (disable card payments)',
    'config.save': 'Save settings',
    'config.saved': 'Settings saved.',
    'config.saveError': 'Error saving: {msg}',
};

const pt = {
    // shell
    'app.title': 'Doações',
    'app.subtitle': 'Campanhas com termômetro de meta · pagamento manual + Stripe opcional · exportação CSV',
    'tab.campaigns': 'Campanhas',
    'tab.donations': 'Doações',
    'tab.config': 'Configurações',
    'common.cancel': 'Cancelar',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    'common.edit': 'Editar',
    'common.delete': 'Excluir',
    'common.error': 'Erro: {msg}',
    'common.noName': '(sem nome)',
    // donation statuses
    'status.pending': 'Pendente',
    'status.paid': 'Paga',
    'status.cancelled': 'Cancelada',
    // campaign modal
    'camp.edit': 'Editar campanha',
    'camp.new': 'Nova campanha',
    'camp.title': 'Título',
    'camp.slug': 'Slug (vazio = gerado a partir do título)',
    'camp.slugPlaceholder': 'minha-campanha',
    'camp.description': 'Descrição',
    'camp.goal': 'Meta ({symbol}) — 0 = sem meta',
    'camp.active': 'Ativa',
    'camp.inactive': 'Inativa',
    'camp.image': 'URL da imagem (opcional)',
    'camp.imagePlaceholder': '/uploads/2026/07/imagem.jpg',
    'camp.goalInvalid': 'A meta deve ser um número maior ou igual a 0.',
    'camp.saveError': 'Não foi possível salvar a campanha.',
    // campaign card
    'camp.of': 'de',
    'camp.raisedNoGoal': 'arrecadados (sem meta)',
    'camp.counts': '{paid} pagas · {total} no total',
    // campaigns tab
    'campaigns.new': 'Nova campanha',
    'campaigns.empty': 'Nenhuma campanha ainda — crie a primeira para começar a receber doações.',
    'campaigns.usage1': 'No editor visual, adicione o bloco ',
    'campaigns.usage2': ' — ele mostra a campanha com seu termômetro, valores sugeridos e o formulário de doação (pelo slug ou a primeira ativa).',
    'campaigns.loadError': 'Erro ao carregar campanhas: {msg}',
    'campaigns.confirmDelete': 'Excluir a campanha "{title}" e TODAS as suas doações? Esta ação não pode ser desfeita.',
    'campaigns.deleted': 'Campanha "{title}" excluída.',
    'campaigns.saved': 'Campanha salva.',
    // donations tab
    'donations.campaign': 'Campanha',
    'donations.all': 'Todas',
    'donations.status': 'Status',
    'donations.allStatuses': 'Todos',
    'donations.exportCsv': 'Exportar CSV',
    'donations.raisedPaid': 'Arrecadado (pagas)',
    'donations.pending': 'Pendente',
    'donations.count': 'Doações',
    'donations.empty': 'Não há doações com estes filtros.',
    'donations.colDate': 'Data',
    'donations.colDonor': 'Doador',
    'donations.colCampaign': 'Campanha',
    'donations.colAmount': 'Valor',
    'donations.colMethod': 'Método',
    'donations.colStatus': 'Status',
    'donations.anonymous': 'Anônimo',
    'donations.methodCard': 'Cartão',
    'donations.methodManual': 'Manual',
    'donations.changeStatus': 'Alterar status da doação',
    'donations.loadError': 'Erro ao carregar doações: {msg}',
    'donations.confirmDelete': 'Excluir a doação de {name} no valor de {amount}?',
    'donations.exportError': 'Erro ao exportar: {msg}',
    'donations.csvName': 'doacoes.csv',
    // config tab
    'config.symbol': 'Símbolo da moeda',
    'config.code': 'Código da moeda (ISO, 3 letras)',
    'config.presets': 'Valores sugeridos (separados por vírgulas, em {symbol})',
    'config.manual': 'Instruções de pagamento manual (sempre disponíveis)',
    'config.manualPlaceholder': 'Transferência para a conta 000-000000-00 do Banco X.\nEnvie seu comprovante para doacoes@meusite.com informando sua referência.',
    'config.notify': 'E-mail de notificações (novas doações)',
    'config.notifyPlaceholder': 'admin@meusite.com',
    'config.stripe': 'Chave secreta do Stripe (opcional — habilita pagamento com cartão)',
    'config.stripeSet': '(configurada — digite para substituir)',
    'config.stripeUnset': 'sk_live_… (sem chave: apenas pagamento manual)',
    'config.stripeHelp': 'A chave nunca é exibida de volta. Sem chave, o bloco oferece apenas pagamento manual com as instruções acima. O pagamento é verificado no servidor no retorno do Stripe.',
    'config.stripeClear': 'Remover a chave (desabilitar pagamento com cartão)',
    'config.save': 'Salvar configurações',
    'config.saved': 'Configurações salvas.',
    'config.saveError': 'Erro ao salvar: {msg}',
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

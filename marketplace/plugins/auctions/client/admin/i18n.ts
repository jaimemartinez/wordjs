// @ts-nocheck
"use client";

// The Auctions admin screens follow the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // shell
    'app.title': 'Subastas',
    'app.subtitle': 'Pujas públicas · incremento mínimo · extensión anti-sniping · ganadores',
    'tab.auctions': 'Subastas',
    'tab.bids': 'Pujas',
    'tab.report': 'Reporte',
    'common.cancel': 'Cancelar',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    'common.edit': 'Editar',
    'common.delete': 'Eliminar',
    'common.error': 'Error: {msg}',
    // statuses
    'status.active': 'Activa',
    'status.ended': 'Finalizada',
    'status.cancelled': 'Cancelada',
    'status.draft': 'Borrador',
    // settings bar
    'settings.currency': 'Moneda',
    'settings.whoBids': 'Quién puja',
    'settings.verifyEmail': 'Correo confirmado con código',
    'settings.verifyLogin': 'Solo usuarios con sesión',
    'settings.verifyNone': 'Cualquiera (sin verificar)',
    'settings.jump': 'Salto máx. %',
    'settings.jumpHelp': 'Cuánto puede subir el precio una sola puja (0 = sin límite)',
    'settings.saved': 'Ajustes guardados.',
    // messages
    'msg.loadAuctionsError': 'Error al cargar subastas: {msg}',
    'msg.loadBidsError': 'Error al cargar pujas: {msg}',
    'msg.loadReportError': 'Error al cargar el reporte: {msg}',
    'msg.created': 'Subasta creada.',
    'msg.updated': 'Subasta actualizada.',
    'msg.ended': 'Subasta finalizada.',
    'msg.cancelled': 'Subasta cancelada.',
    'msg.deleted': 'Subasta eliminada.',
    'msg.bidDeleted': 'Puja eliminada.',
    'confirm.endNow': '¿Finalizar ahora la subasta "{title}"? El líder actual será el ganador.',
    'confirm.cancel': '¿Cancelar la subasta "{title}"? No habrá ganador.',
    'confirm.delete': '¿Eliminar la subasta "{title}" y TODAS sus pujas? Esta acción no se puede deshacer.',
    'confirm.deleteBid': '¿Eliminar la puja de {name} por {amount}? El precio actual se recalcula automáticamente.',
    // auctions tab
    'auctions.new': 'Nueva subasta',
    'auctions.empty': 'Sin subastas todavía — crea la primera con "Nueva subasta".',
    'auctions.noPhoto': 'Sin foto',
    'auctions.bidOne': '{n} puja',
    'auctions.bidMany': '{n} pujas',
    'auctions.unpublished': ' · no publicada',
    'auctions.bids': 'Pujas',
    'auctions.endNow': 'Finalizar ahora',
    'auctions.usage1': 'En el editor visual, agrega el bloque ',
    'auctions.usage2': ' — muestra la cuadrícula de subastas activas (o una sola, indicando su slug) con cuenta regresiva y formulario de puja.',
    // bids tab
    'bids.auction': 'Subasta',
    'bids.select': '— Selecciona una subasta —',
    'bids.selectHelp': 'Selecciona una subasta para ver sus pujas (incluye correos — solo visible aquí).',
    'bids.empty': 'Esta subasta no tiene pujas todavía.',
    'bids.name': 'Nombre',
    'bids.email': 'Correo',
    'bids.amount': 'Monto',
    'bids.date': 'Fecha',
    'bids.leading': 'Puja líder',
    // report tab
    'report.title': 'Ganadores y contacto para la entrega',
    'report.empty': 'Sin subastas todavía.',
    'report.auction': 'Subasta',
    'report.status': 'Estado',
    'report.bids': 'Pujas',
    'report.price': 'Precio final / actual',
    'report.winner': 'Ganador · contacto',
    'report.closes': 'Cierre',
    'report.void': 'Sin pujas — desierta',
    'report.leader': 'Líder: {name}',
    // modal
    'form.new': 'Nueva subasta',
    'form.edit': 'Editar subasta',
    'form.title': 'Título *',
    'form.description': 'Descripción',
    'form.imageUrl': 'URL de la imagen',
    'form.imagePlaceholder': 'https://… o /uploads/…',
    'form.startPrice': 'Precio inicial ({symbol}) *',
    'form.minIncrement': 'Incremento mínimo ({symbol}) *',
    'form.startsAt': 'Inicio (opcional)',
    'form.endsAt': 'Fin *',
    'form.antiSnipe': 'Anti-sniping (minutos)',
    'form.antiSnipeHelp': 'Una puja en los últimos N minutos extiende el cierre N minutos.',
    'form.status': 'Estado',
    'form.published': 'Publicada (visible en el sitio)',
    'form.invalidStartPrice': 'Precio inicial inválido.',
    'form.invalidIncrement': 'El incremento mínimo debe ser mayor que 0.',
    'form.endsRequired': 'La fecha de fin es obligatoria.',
};

const en = {
    // shell
    'app.title': 'Auctions',
    'app.subtitle': 'Public bidding · minimum increment · anti-sniping extension · winners',
    'tab.auctions': 'Auctions',
    'tab.bids': 'Bids',
    'tab.report': 'Report',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'common.error': 'Error: {msg}',
    // statuses
    'status.active': 'Active',
    'status.ended': 'Ended',
    'status.cancelled': 'Cancelled',
    'status.draft': 'Draft',
    // settings bar
    'settings.currency': 'Currency',
    'settings.whoBids': 'Who can bid',
    'settings.verifyEmail': 'Email confirmed with a code',
    'settings.verifyLogin': 'Signed-in users only',
    'settings.verifyNone': 'Anyone (unverified)',
    'settings.jump': 'Max. jump %',
    'settings.jumpHelp': 'How much a single bid can raise the price (0 = no limit)',
    'settings.saved': 'Settings saved.',
    // messages
    'msg.loadAuctionsError': 'Error loading auctions: {msg}',
    'msg.loadBidsError': 'Error loading bids: {msg}',
    'msg.loadReportError': 'Error loading the report: {msg}',
    'msg.created': 'Auction created.',
    'msg.updated': 'Auction updated.',
    'msg.ended': 'Auction ended.',
    'msg.cancelled': 'Auction cancelled.',
    'msg.deleted': 'Auction deleted.',
    'msg.bidDeleted': 'Bid deleted.',
    'confirm.endNow': 'End the auction "{title}" now? The current leader will be the winner.',
    'confirm.cancel': 'Cancel the auction "{title}"? There will be no winner.',
    'confirm.delete': 'Delete the auction "{title}" and ALL its bids? This cannot be undone.',
    'confirm.deleteBid': 'Delete the bid from {name} for {amount}? The current price is recalculated automatically.',
    // auctions tab
    'auctions.new': 'New auction',
    'auctions.empty': 'No auctions yet — create the first one with "New auction".',
    'auctions.noPhoto': 'No photo',
    'auctions.bidOne': '{n} bid',
    'auctions.bidMany': '{n} bids',
    'auctions.unpublished': ' · not published',
    'auctions.bids': 'Bids',
    'auctions.endNow': 'End now',
    'auctions.usage1': 'In the visual editor, add the ',
    'auctions.usage2': ' block — it shows the grid of active auctions (or a single one, by its slug) with a countdown and a bid form.',
    // bids tab
    'bids.auction': 'Auction',
    'bids.select': '— Select an auction —',
    'bids.selectHelp': 'Select an auction to see its bids (includes emails — only visible here).',
    'bids.empty': 'This auction has no bids yet.',
    'bids.name': 'Name',
    'bids.email': 'Email',
    'bids.amount': 'Amount',
    'bids.date': 'Date',
    'bids.leading': 'Leading bid',
    // report tab
    'report.title': 'Winners and contact details for delivery',
    'report.empty': 'No auctions yet.',
    'report.auction': 'Auction',
    'report.status': 'Status',
    'report.bids': 'Bids',
    'report.price': 'Final / current price',
    'report.winner': 'Winner · contact',
    'report.closes': 'Closes',
    'report.void': 'No bids — no sale',
    'report.leader': 'Leader: {name}',
    // modal
    'form.new': 'New auction',
    'form.edit': 'Edit auction',
    'form.title': 'Title *',
    'form.description': 'Description',
    'form.imageUrl': 'Image URL',
    'form.imagePlaceholder': 'https://… or /uploads/…',
    'form.startPrice': 'Starting price ({symbol}) *',
    'form.minIncrement': 'Minimum increment ({symbol}) *',
    'form.startsAt': 'Start (optional)',
    'form.endsAt': 'End *',
    'form.antiSnipe': 'Anti-sniping (minutes)',
    'form.antiSnipeHelp': 'A bid in the last N minutes extends the closing time by N minutes.',
    'form.status': 'Status',
    'form.published': 'Published (visible on the site)',
    'form.invalidStartPrice': 'Invalid starting price.',
    'form.invalidIncrement': 'The minimum increment must be greater than 0.',
    'form.endsRequired': 'The end date is required.',
};

const pt = {
    // shell
    'app.title': 'Leilões',
    'app.subtitle': 'Lances públicos · incremento mínimo · extensão anti-sniping · vencedores',
    'tab.auctions': 'Leilões',
    'tab.bids': 'Lances',
    'tab.report': 'Relatório',
    'common.cancel': 'Cancelar',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    'common.edit': 'Editar',
    'common.delete': 'Excluir',
    'common.error': 'Erro: {msg}',
    // statuses
    'status.active': 'Ativo',
    'status.ended': 'Encerrado',
    'status.cancelled': 'Cancelado',
    'status.draft': 'Rascunho',
    // settings bar
    'settings.currency': 'Moeda',
    'settings.whoBids': 'Quem pode dar lances',
    'settings.verifyEmail': 'E-mail confirmado com código',
    'settings.verifyLogin': 'Somente usuários com sessão',
    'settings.verifyNone': 'Qualquer pessoa (sem verificação)',
    'settings.jump': 'Salto máx. %',
    'settings.jumpHelp': 'Quanto um único lance pode aumentar o preço (0 = sem limite)',
    'settings.saved': 'Configurações salvas.',
    // messages
    'msg.loadAuctionsError': 'Erro ao carregar os leilões: {msg}',
    'msg.loadBidsError': 'Erro ao carregar os lances: {msg}',
    'msg.loadReportError': 'Erro ao carregar o relatório: {msg}',
    'msg.created': 'Leilão criado.',
    'msg.updated': 'Leilão atualizado.',
    'msg.ended': 'Leilão encerrado.',
    'msg.cancelled': 'Leilão cancelado.',
    'msg.deleted': 'Leilão excluído.',
    'msg.bidDeleted': 'Lance excluído.',
    'confirm.endNow': 'Encerrar agora o leilão "{title}"? O líder atual será o vencedor.',
    'confirm.cancel': 'Cancelar o leilão "{title}"? Não haverá vencedor.',
    'confirm.delete': 'Excluir o leilão "{title}" e TODOS os seus lances? Esta ação não pode ser desfeita.',
    'confirm.deleteBid': 'Excluir o lance de {name} por {amount}? O preço atual é recalculado automaticamente.',
    // auctions tab
    'auctions.new': 'Novo leilão',
    'auctions.empty': 'Nenhum leilão ainda — crie o primeiro com "Novo leilão".',
    'auctions.noPhoto': 'Sem foto',
    'auctions.bidOne': '{n} lance',
    'auctions.bidMany': '{n} lances',
    'auctions.unpublished': ' · não publicado',
    'auctions.bids': 'Lances',
    'auctions.endNow': 'Encerrar agora',
    'auctions.usage1': 'No editor visual, adicione o bloco ',
    'auctions.usage2': ' — ele mostra a grade de leilões ativos (ou um só, indicando o slug) com contagem regressiva e formulário de lance.',
    // bids tab
    'bids.auction': 'Leilão',
    'bids.select': '— Selecione um leilão —',
    'bids.selectHelp': 'Selecione um leilão para ver os lances (inclui e-mails — visível somente aqui).',
    'bids.empty': 'Este leilão ainda não tem lances.',
    'bids.name': 'Nome',
    'bids.email': 'E-mail',
    'bids.amount': 'Valor',
    'bids.date': 'Data',
    'bids.leading': 'Lance líder',
    // report tab
    'report.title': 'Vencedores e contato para a entrega',
    'report.empty': 'Nenhum leilão ainda.',
    'report.auction': 'Leilão',
    'report.status': 'Status',
    'report.bids': 'Lances',
    'report.price': 'Preço final / atual',
    'report.winner': 'Vencedor · contato',
    'report.closes': 'Encerramento',
    'report.void': 'Sem lances — deserto',
    'report.leader': 'Líder: {name}',
    // modal
    'form.new': 'Novo leilão',
    'form.edit': 'Editar leilão',
    'form.title': 'Título *',
    'form.description': 'Descrição',
    'form.imageUrl': 'URL da imagem',
    'form.imagePlaceholder': 'https://… ou /uploads/…',
    'form.startPrice': 'Preço inicial ({symbol}) *',
    'form.minIncrement': 'Incremento mínimo ({symbol}) *',
    'form.startsAt': 'Início (opcional)',
    'form.endsAt': 'Fim *',
    'form.antiSnipe': 'Anti-sniping (minutos)',
    'form.antiSnipeHelp': 'Um lance nos últimos N minutos estende o encerramento em N minutos.',
    'form.status': 'Status',
    'form.published': 'Publicado (visível no site)',
    'form.invalidStartPrice': 'Preço inicial inválido.',
    'form.invalidIncrement': 'O incremento mínimo deve ser maior que 0.',
    'form.endsRequired': 'A data de término é obrigatória.',
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

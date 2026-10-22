// @ts-nocheck
"use client";

// The Events Calendar admin screen follows the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // shell
    'app.title': 'Eventos',
    'app.subtitle': 'Calendario de eventos → bloque EventsCalendar en el editor visual',
    'app.newEvent': 'Nuevo evento',
    'app.footnote.before': 'En el editor visual, agrega el bloque',
    'app.footnote.after': '— muestra los eventos como lista de próximos o como calendario mensual, con descripción opcional.',
    // scopes
    'scope.upcoming': 'Próximos',
    'scope.past': 'Pasados',
    'scope.all': 'Todos',
    // list
    'list.loading': 'Cargando eventos…',
    'list.emptyUpcoming': 'No hay eventos próximos.',
    'list.emptyPast': 'No hay eventos pasados.',
    'list.emptyAll': 'Todavía no hay eventos — crea el primero.',
    'col.event': 'Evento',
    'col.date': 'Fecha',
    'col.location': 'Lugar',
    'col.actions': 'Acciones',
    'common.edit': 'Editar',
    'common.delete': 'Eliminar',
    'common.cancel': 'Cancelar',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    // messages
    'msg.loadError': 'Error al cargar los eventos: {msg}',
    'msg.deleteConfirm': '¿Eliminar el evento "{title}"? Esta acción no se puede deshacer.',
    'msg.deleted': 'Evento eliminado.',
    'msg.deleteError': 'Error al eliminar: {msg}',
    'msg.updated': 'Evento actualizado.',
    'msg.created': 'Evento creado.',
    'msg.saveError': 'No se pudo guardar el evento.',
    // form
    'form.editTitle': 'Editar evento',
    'form.newTitle': 'Nuevo evento',
    'form.title': 'Título *',
    'form.titlePh': 'Nombre del evento',
    'form.allDay': 'Todo el día',
    'form.starts': 'Inicio *',
    'form.ends': 'Fin (opcional)',
    'form.location': 'Lugar',
    'form.locationPh': 'Auditorio, dirección…',
    'form.color': 'Color',
    'form.url': 'Enlace "Más info" (opcional)',
    'form.description': 'Descripción',
    'form.descriptionPh': 'Detalles del evento…',
    'form.errTitle': 'El título es obligatorio.',
    'form.errStart': 'La fecha de inicio es obligatoria.',
    'form.errEnd': 'La fecha de fin debe ser igual o posterior a la de inicio.',
    // dates
    'when.allDay': 'Todo el día',
    'month.0': 'ene', 'month.1': 'feb', 'month.2': 'mar', 'month.3': 'abr', 'month.4': 'may', 'month.5': 'jun',
    'month.6': 'jul', 'month.7': 'ago', 'month.8': 'sep', 'month.9': 'oct', 'month.10': 'nov', 'month.11': 'dic',
};

const en = {
    'app.title': 'Events',
    'app.subtitle': 'Events calendar → EventsCalendar block in the visual editor',
    'app.newEvent': 'New event',
    'app.footnote.before': 'In the visual editor, add the',
    'app.footnote.after': 'block — it shows the events as an upcoming list or as a monthly calendar, with an optional description.',
    'scope.upcoming': 'Upcoming',
    'scope.past': 'Past',
    'scope.all': 'All',
    'list.loading': 'Loading events…',
    'list.emptyUpcoming': 'No upcoming events.',
    'list.emptyPast': 'No past events.',
    'list.emptyAll': 'No events yet — create the first one.',
    'col.event': 'Event',
    'col.date': 'Date',
    'col.location': 'Location',
    'col.actions': 'Actions',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'msg.loadError': 'Error loading the events: {msg}',
    'msg.deleteConfirm': 'Delete the event "{title}"? This cannot be undone.',
    'msg.deleted': 'Event deleted.',
    'msg.deleteError': 'Error deleting: {msg}',
    'msg.updated': 'Event updated.',
    'msg.created': 'Event created.',
    'msg.saveError': 'Could not save the event.',
    'form.editTitle': 'Edit event',
    'form.newTitle': 'New event',
    'form.title': 'Title *',
    'form.titlePh': 'Event name',
    'form.allDay': 'All day',
    'form.starts': 'Start *',
    'form.ends': 'End (optional)',
    'form.location': 'Location',
    'form.locationPh': 'Auditorium, address…',
    'form.color': 'Color',
    'form.url': '"More info" link (optional)',
    'form.description': 'Description',
    'form.descriptionPh': 'Event details…',
    'form.errTitle': 'The title is required.',
    'form.errStart': 'The start date is required.',
    'form.errEnd': 'The end date must be the same as or later than the start date.',
    'when.allDay': 'All day',
    'month.0': 'Jan', 'month.1': 'Feb', 'month.2': 'Mar', 'month.3': 'Apr', 'month.4': 'May', 'month.5': 'Jun',
    'month.6': 'Jul', 'month.7': 'Aug', 'month.8': 'Sep', 'month.9': 'Oct', 'month.10': 'Nov', 'month.11': 'Dec',
};

const pt = {
    'app.title': 'Eventos',
    'app.subtitle': 'Calendário de eventos → bloco EventsCalendar no editor visual',
    'app.newEvent': 'Novo evento',
    'app.footnote.before': 'No editor visual, adicione o bloco',
    'app.footnote.after': '— ele mostra os eventos como lista de próximos ou como calendário mensal, com descrição opcional.',
    'scope.upcoming': 'Próximos',
    'scope.past': 'Passados',
    'scope.all': 'Todos',
    'list.loading': 'Carregando eventos…',
    'list.emptyUpcoming': 'Não há eventos próximos.',
    'list.emptyPast': 'Não há eventos passados.',
    'list.emptyAll': 'Ainda não há eventos — crie o primeiro.',
    'col.event': 'Evento',
    'col.date': 'Data',
    'col.location': 'Local',
    'col.actions': 'Ações',
    'common.edit': 'Editar',
    'common.delete': 'Excluir',
    'common.cancel': 'Cancelar',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    'msg.loadError': 'Erro ao carregar os eventos: {msg}',
    'msg.deleteConfirm': 'Excluir o evento "{title}"? Esta ação não pode ser desfeita.',
    'msg.deleted': 'Evento excluído.',
    'msg.deleteError': 'Erro ao excluir: {msg}',
    'msg.updated': 'Evento atualizado.',
    'msg.created': 'Evento criado.',
    'msg.saveError': 'Não foi possível salvar o evento.',
    'form.editTitle': 'Editar evento',
    'form.newTitle': 'Novo evento',
    'form.title': 'Título *',
    'form.titlePh': 'Nome do evento',
    'form.allDay': 'Dia inteiro',
    'form.starts': 'Início *',
    'form.ends': 'Fim (opcional)',
    'form.location': 'Local',
    'form.locationPh': 'Auditório, endereço…',
    'form.color': 'Cor',
    'form.url': 'Link "Mais informações" (opcional)',
    'form.description': 'Descrição',
    'form.descriptionPh': 'Detalhes do evento…',
    'form.errTitle': 'O título é obrigatório.',
    'form.errStart': 'A data de início é obrigatória.',
    'form.errEnd': 'A data de fim deve ser igual ou posterior à de início.',
    'when.allDay': 'Dia inteiro',
    'month.0': 'jan', 'month.1': 'fev', 'month.2': 'mar', 'month.3': 'abr', 'month.4': 'mai', 'month.5': 'jun',
    'month.6': 'jul', 'month.7': 'ago', 'month.8': 'set', 'month.9': 'out', 'month.10': 'nov', 'month.11': 'dez',
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

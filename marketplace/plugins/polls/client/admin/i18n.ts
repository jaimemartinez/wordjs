// @ts-nocheck
"use client";

// The Polls admin screen follows the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // shell
    'app.title': 'Encuestas',
    'app.subtitle': 'Crea encuestas y publícalas con el bloque Polls del editor visual',
    'app.newPoll': 'Nueva encuesta',
    // results visibility
    'showResults.after': 'Tras votar',
    'showResults.always': 'Siempre',
    'showResults.never': 'Nunca',
    // list
    'list.loading': 'Cargando…',
    'list.empty': 'Todavía no hay encuestas. Crea la primera con "Nueva encuesta".',
    'status.open': 'Abierta',
    'status.closed': 'Cerrada',
    'meta.votes.one': '{n} voto',
    'meta.votes.other': '{n} votos',
    'meta.results': 'Resultados: {mode}',
    'action.close': 'Cerrar',
    'action.open': 'Abrir',
    'common.edit': 'Editar',
    'common.delete': 'Eliminar',
    'common.cancel': 'Cancelar',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    'usage.p1': 'Usa el bloque',
    'usage.p2': 'con el ID',
    'usage.p3': '.',
    // messages
    'msg.loadError': 'Error al cargar: {msg}',
    'msg.error': 'Error: {msg}',
    'msg.deleteConfirm': '¿Eliminar la encuesta "{question}" y todos sus votos? Esta acción no se puede deshacer.',
    // modal
    'form.editTitle': 'Editar encuesta',
    'form.newTitle': 'Nueva encuesta',
    'form.question': 'Pregunta',
    'form.questionPh': '¿Cuál es tu opción favorita?',
    'form.options': 'Opciones ({count}/{max})',
    'form.option': 'Opción {n}',
    'form.removeOption': 'Quitar opción',
    'form.addOption': 'Agregar opción',
    'form.editHelp': 'Al editar se conservan los votos de las opciones existentes; quitar una opción no borra sus votos.',
    'form.showResults': 'Mostrar resultados',
    'form.errQuestion': 'La pregunta es obligatoria.',
    'form.errOptionText': 'Todas las opciones deben tener texto.',
    'form.errMinOptions': 'Se necesitan al menos {min} opciones.',
    'form.saveError': 'No se pudo guardar la encuesta.',
};

const en = {
    'app.title': 'Polls',
    'app.subtitle': 'Create polls and publish them with the Polls block in the visual editor',
    'app.newPoll': 'New poll',
    'showResults.after': 'After voting',
    'showResults.always': 'Always',
    'showResults.never': 'Never',
    'list.loading': 'Loading…',
    'list.empty': 'No polls yet. Create the first one with "New poll".',
    'status.open': 'Open',
    'status.closed': 'Closed',
    'meta.votes.one': '{n} vote',
    'meta.votes.other': '{n} votes',
    'meta.results': 'Results: {mode}',
    'action.close': 'Close',
    'action.open': 'Open',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'usage.p1': 'Use the',
    'usage.p2': 'block with ID',
    'usage.p3': '.',
    'msg.loadError': 'Error loading: {msg}',
    'msg.error': 'Error: {msg}',
    'msg.deleteConfirm': 'Delete the poll "{question}" and all its votes? This cannot be undone.',
    'form.editTitle': 'Edit poll',
    'form.newTitle': 'New poll',
    'form.question': 'Question',
    'form.questionPh': 'What is your favorite option?',
    'form.options': 'Options ({count}/{max})',
    'form.option': 'Option {n}',
    'form.removeOption': 'Remove option',
    'form.addOption': 'Add option',
    'form.editHelp': 'Editing keeps the votes of existing options; removing an option does not delete its votes.',
    'form.showResults': 'Show results',
    'form.errQuestion': 'The question is required.',
    'form.errOptionText': 'Every option must have text.',
    'form.errMinOptions': 'At least {min} options are needed.',
    'form.saveError': 'Could not save the poll.',
};

const pt = {
    'app.title': 'Enquetes',
    'app.subtitle': 'Crie enquetes e publique-as com o bloco Polls do editor visual',
    'app.newPoll': 'Nova enquete',
    'showResults.after': 'Após votar',
    'showResults.always': 'Sempre',
    'showResults.never': 'Nunca',
    'list.loading': 'Carregando…',
    'list.empty': 'Ainda não há enquetes. Crie a primeira com "Nova enquete".',
    'status.open': 'Aberta',
    'status.closed': 'Fechada',
    'meta.votes.one': '{n} voto',
    'meta.votes.other': '{n} votos',
    'meta.results': 'Resultados: {mode}',
    'action.close': 'Fechar',
    'action.open': 'Abrir',
    'common.edit': 'Editar',
    'common.delete': 'Excluir',
    'common.cancel': 'Cancelar',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    'usage.p1': 'Use o bloco',
    'usage.p2': 'com o ID',
    'usage.p3': '.',
    'msg.loadError': 'Erro ao carregar: {msg}',
    'msg.error': 'Erro: {msg}',
    'msg.deleteConfirm': 'Excluir a enquete "{question}" e todos os seus votos? Esta ação não pode ser desfeita.',
    'form.editTitle': 'Editar enquete',
    'form.newTitle': 'Nova enquete',
    'form.question': 'Pergunta',
    'form.questionPh': 'Qual é a sua opção favorita?',
    'form.options': 'Opções ({count}/{max})',
    'form.option': 'Opção {n}',
    'form.removeOption': 'Remover opção',
    'form.addOption': 'Adicionar opção',
    'form.editHelp': 'Ao editar, os votos das opções existentes são mantidos; remover uma opção não apaga seus votos.',
    'form.showResults': 'Mostrar resultados',
    'form.errQuestion': 'A pergunta é obrigatória.',
    'form.errOptionText': 'Todas as opções devem ter texto.',
    'form.errMinOptions': 'São necessárias pelo menos {min} opções.',
    'form.saveError': 'Não foi possível salvar a enquete.',
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

// @ts-nocheck
"use client";

// The FAQ admin screen follows the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // shell
    'app.title': 'FAQ',
    'app.subtitle': 'Preguntas frecuentes por categoría → bloque acordeón con SEO',
    'app.newQuestion': 'Nueva pregunta',
    // list
    'list.title': 'Preguntas',
    'count.questions.one': '{n} pregunta',
    'count.questions.other': '{n} preguntas',
    'count.categories.one': '{n} categoría',
    'count.categories.other': '{n} categorías',
    'list.loading': 'Cargando…',
    'list.empty': 'No hay preguntas todavía — crea la primera con "Nueva pregunta".',
    'list.noCategory': 'Sin categoría',
    'row.moveUp': 'Subir',
    'row.moveDown': 'Bajar',
    'row.clickToHide': 'Clic para ocultar',
    'row.clickToPublish': 'Clic para publicar',
    'row.published': 'Publicada',
    'row.hidden': 'Oculta',
    'common.edit': 'Editar',
    'common.delete': 'Eliminar',
    'common.cancel': 'Cancelar',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    // help card
    'help.title': 'Cómo mostrarlas en tu sitio',
    'help.p1': 'En el editor visual, agrega el bloque',
    'help.p2': ': renderiza estas preguntas como un acordeón filtrable por categoría e incluye datos estructurados',
    'help.p3': ', lo que permite que Google muestre tus preguntas como resultados enriquecidos en el buscador — a diferencia del bloque estático "Accordion" del núcleo, que no aporta ese marcado SEO.',
    // messages
    'msg.loadError': 'Error al cargar la lista: {msg}',
    'msg.required': 'La pregunta y la respuesta son obligatorias.',
    'msg.updated': 'Pregunta actualizada.',
    'msg.created': 'Pregunta creada.',
    'msg.saveError': 'Error al guardar: {msg}',
    'msg.toggleError': 'Error al cambiar la visibilidad: {msg}',
    'msg.deleteConfirm': '¿Eliminar esta pregunta de forma permanente?',
    'msg.deleted': 'Pregunta eliminada.',
    'msg.deleteError': 'Error al eliminar: {msg}',
    'msg.reorderError': 'Error al reordenar: {msg}',
    // modal
    'form.editTitle': 'Editar pregunta',
    'form.newTitle': 'Nueva pregunta',
    'form.question': 'Pregunta',
    'form.questionPh': '¿Cómo puedo…?',
    'form.answer': 'Respuesta',
    'form.answerPh': 'Escribe la respuesta (texto plano; los saltos de línea se respetan)',
    'form.category': 'Categoría (opcional)',
    'form.categoryPh': 'General, Envíos, Pagos…',
};

const en = {
    'app.title': 'FAQ',
    'app.subtitle': 'Frequently asked questions by category → accordion block with SEO',
    'app.newQuestion': 'New question',
    'list.title': 'Questions',
    'count.questions.one': '{n} question',
    'count.questions.other': '{n} questions',
    'count.categories.one': '{n} category',
    'count.categories.other': '{n} categories',
    'list.loading': 'Loading…',
    'list.empty': 'No questions yet — create the first one with "New question".',
    'list.noCategory': 'Uncategorized',
    'row.moveUp': 'Move up',
    'row.moveDown': 'Move down',
    'row.clickToHide': 'Click to hide',
    'row.clickToPublish': 'Click to publish',
    'row.published': 'Published',
    'row.hidden': 'Hidden',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'help.title': 'How to show them on your site',
    'help.p1': 'In the visual editor, add the',
    'help.p2': ' block: it renders these questions as an accordion filterable by category and includes',
    'help.p3': ' structured data, which lets Google show your questions as rich results in search — unlike the core\'s static "Accordion" block, which provides no such SEO markup.',
    'msg.loadError': 'Error loading the list: {msg}',
    'msg.required': 'The question and the answer are required.',
    'msg.updated': 'Question updated.',
    'msg.created': 'Question created.',
    'msg.saveError': 'Error saving: {msg}',
    'msg.toggleError': 'Error changing the visibility: {msg}',
    'msg.deleteConfirm': 'Delete this question permanently?',
    'msg.deleted': 'Question deleted.',
    'msg.deleteError': 'Error deleting: {msg}',
    'msg.reorderError': 'Error reordering: {msg}',
    'form.editTitle': 'Edit question',
    'form.newTitle': 'New question',
    'form.question': 'Question',
    'form.questionPh': 'How can I…?',
    'form.answer': 'Answer',
    'form.answerPh': 'Write the answer (plain text; line breaks are kept)',
    'form.category': 'Category (optional)',
    'form.categoryPh': 'General, Shipping, Payments…',
};

const pt = {
    'app.title': 'FAQ',
    'app.subtitle': 'Perguntas frequentes por categoria → bloco acordeão com SEO',
    'app.newQuestion': 'Nova pergunta',
    'list.title': 'Perguntas',
    'count.questions.one': '{n} pergunta',
    'count.questions.other': '{n} perguntas',
    'count.categories.one': '{n} categoria',
    'count.categories.other': '{n} categorias',
    'list.loading': 'Carregando…',
    'list.empty': 'Ainda não há perguntas — crie a primeira com "Nova pergunta".',
    'list.noCategory': 'Sem categoria',
    'row.moveUp': 'Subir',
    'row.moveDown': 'Descer',
    'row.clickToHide': 'Clique para ocultar',
    'row.clickToPublish': 'Clique para publicar',
    'row.published': 'Publicada',
    'row.hidden': 'Oculta',
    'common.edit': 'Editar',
    'common.delete': 'Excluir',
    'common.cancel': 'Cancelar',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    'help.title': 'Como exibi-las no seu site',
    'help.p1': 'No editor visual, adicione o bloco',
    'help.p2': ': ele renderiza estas perguntas como um acordeão filtrável por categoria e inclui dados estruturados',
    'help.p3': ', o que permite ao Google exibir suas perguntas como resultados aprimorados na busca — ao contrário do bloco estático "Accordion" do núcleo, que não oferece essa marcação de SEO.',
    'msg.loadError': 'Erro ao carregar a lista: {msg}',
    'msg.required': 'A pergunta e a resposta são obrigatórias.',
    'msg.updated': 'Pergunta atualizada.',
    'msg.created': 'Pergunta criada.',
    'msg.saveError': 'Erro ao salvar: {msg}',
    'msg.toggleError': 'Erro ao alterar a visibilidade: {msg}',
    'msg.deleteConfirm': 'Excluir esta pergunta permanentemente?',
    'msg.deleted': 'Pergunta excluída.',
    'msg.deleteError': 'Erro ao excluir: {msg}',
    'msg.reorderError': 'Erro ao reordenar: {msg}',
    'form.editTitle': 'Editar pergunta',
    'form.newTitle': 'Nova pergunta',
    'form.question': 'Pergunta',
    'form.questionPh': 'Como posso…?',
    'form.answer': 'Resposta',
    'form.answerPh': 'Escreva a resposta (texto simples; as quebras de linha são mantidas)',
    'form.category': 'Categoria (opcional)',
    'form.categoryPh': 'Geral, Envios, Pagamentos…',
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

// @ts-nocheck
"use client";

// The Testimonials admin screens follow the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // shell
    'app.title': 'Testimonios',
    'app.subtitle': 'Moderación + bloque "Testimonials" en el editor visual',
    'app.new': 'Nuevo testimonio',
    'app.loadError': 'Error al cargar: {msg}',
    'app.approved': 'Testimonio de {name} aprobado.',
    'app.approveError': 'Error al aprobar: {msg}',
    'app.confirmDelete': '¿Eliminar el testimonio de {name}? Esta acción no se puede deshacer.',
    'app.deleted': 'Testimonio eliminado.',
    'app.deleteError': 'Error al eliminar: {msg}',
    'app.settingsError': 'Error al guardar la configuración: {msg}',
    'app.saved': 'Testimonio guardado.',
    'common.cancel': 'Cancelar',
    'common.save': 'Guardar',
    'common.saving': 'Guardando…',
    'common.edit': 'Editar',
    'common.delete': 'Eliminar',
    // settings toggle
    'settings.title': 'Permitir envíos públicos desde el bloque',
    'settings.desc1': 'Si está activo, el bloque puede mostrar un formulario público; los envíos entran como',
    'settings.descStrong': ' pendientes',
    'settings.desc2': ' y solo se publican cuando los apruebas aquí.',
    // tabs and empty states
    'tab.pending': 'Pendientes',
    'tab.approved': 'Aprobados ({n})',
    'empty.pending': 'No hay testimonios pendientes de moderación.',
    'empty.approved': 'No hay testimonios aprobados todavía — crea uno con “Nuevo testimonio”.',
    // footnote (the block name "Testimonials" and its editor category "Testimonios" are proper names)
    'footnote.before': 'En el editor visual, agrega el bloque ',
    'footnote.after': ' (categoría Testimonios) — muestra los testimonios aprobados en carrusel o cuadrícula y, si lo permites arriba, un formulario de envío público. (El bloque estático "Testimonial" del núcleo es distinto: uno solo, escrito a mano en el editor.)',
    // stars
    'stars.label': '{n} de 5 estrellas',
    'stars.rating': 'Calificación',
    // card
    'card.public': 'Público',
    'card.admin': 'Admin',
    'card.approve': 'Aprobar',
    // modal
    'modal.edit': 'Editar testimonio',
    'modal.new': 'Nuevo testimonio',
    'modal.name': 'Nombre *',
    'modal.role': 'Cargo / Empresa',
    'modal.photo': 'URL de la foto (http/https, opcional)',
    'modal.content': 'Testimonio *',
    'modal.status': 'Estado',
    'modal.statusApproved': 'Aprobado',
    'modal.statusPending': 'Pendiente',
    'modal.saveError': 'No se pudo guardar el testimonio.',
};

const en = {
    // shell
    'app.title': 'Testimonials',
    'app.subtitle': 'Moderation + "Testimonials" block in the visual editor',
    'app.new': 'New testimonial',
    'app.loadError': 'Error loading: {msg}',
    'app.approved': 'Testimonial from {name} approved.',
    'app.approveError': 'Error approving: {msg}',
    'app.confirmDelete': 'Delete the testimonial from {name}? This cannot be undone.',
    'app.deleted': 'Testimonial deleted.',
    'app.deleteError': 'Error deleting: {msg}',
    'app.settingsError': 'Error saving the settings: {msg}',
    'app.saved': 'Testimonial saved.',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    // settings toggle
    'settings.title': 'Allow public submissions from the block',
    'settings.desc1': 'When enabled, the block can show a public form; submissions arrive as',
    'settings.descStrong': ' pending',
    'settings.desc2': ' and are only published once you approve them here.',
    // tabs and empty states
    'tab.pending': 'Pending',
    'tab.approved': 'Approved ({n})',
    'empty.pending': 'No testimonials awaiting moderation.',
    'empty.approved': 'No approved testimonials yet — create one with “New testimonial”.',
    // footnote (the block name "Testimonials" and its editor category "Testimonios" are proper names)
    'footnote.before': 'In the visual editor, add the ',
    'footnote.after': ' block (category Testimonios) — it shows the approved testimonials as a carousel or grid and, if you allow it above, a public submission form. (The core\'s static "Testimonial" block is different: a single one, written by hand in the editor.)',
    // stars
    'stars.label': '{n} out of 5 stars',
    'stars.rating': 'Rating',
    // card
    'card.public': 'Public',
    'card.admin': 'Admin',
    'card.approve': 'Approve',
    // modal
    'modal.edit': 'Edit testimonial',
    'modal.new': 'New testimonial',
    'modal.name': 'Name *',
    'modal.role': 'Role / Company',
    'modal.photo': 'Photo URL (http/https, optional)',
    'modal.content': 'Testimonial *',
    'modal.status': 'Status',
    'modal.statusApproved': 'Approved',
    'modal.statusPending': 'Pending',
    'modal.saveError': 'Could not save the testimonial.',
};

const pt = {
    // shell
    'app.title': 'Depoimentos',
    'app.subtitle': 'Moderação + bloco "Testimonials" no editor visual',
    'app.new': 'Novo depoimento',
    'app.loadError': 'Erro ao carregar: {msg}',
    'app.approved': 'Depoimento de {name} aprovado.',
    'app.approveError': 'Erro ao aprovar: {msg}',
    'app.confirmDelete': 'Excluir o depoimento de {name}? Esta ação não pode ser desfeita.',
    'app.deleted': 'Depoimento excluído.',
    'app.deleteError': 'Erro ao excluir: {msg}',
    'app.settingsError': 'Erro ao salvar as configurações: {msg}',
    'app.saved': 'Depoimento salvo.',
    'common.cancel': 'Cancelar',
    'common.save': 'Salvar',
    'common.saving': 'Salvando…',
    'common.edit': 'Editar',
    'common.delete': 'Excluir',
    // settings toggle
    'settings.title': 'Permitir envios públicos a partir do bloco',
    'settings.desc1': 'Se ativado, o bloco pode exibir um formulário público; os envios entram como',
    'settings.descStrong': ' pendentes',
    'settings.desc2': ' e só são publicados quando você os aprova aqui.',
    // tabs and empty states
    'tab.pending': 'Pendentes',
    'tab.approved': 'Aprovados ({n})',
    'empty.pending': 'Não há depoimentos aguardando moderação.',
    'empty.approved': 'Ainda não há depoimentos aprovados — crie um com “Novo depoimento”.',
    // footnote (the block name "Testimonials" and its editor category "Testimonios" are proper names)
    'footnote.before': 'No editor visual, adicione o bloco ',
    'footnote.after': ' (categoria Testimonios) — ele mostra os depoimentos aprovados em carrossel ou grade e, se você permitir acima, um formulário de envio público. (O bloco estático "Testimonial" do núcleo é diferente: um só, escrito à mão no editor.)',
    // stars
    'stars.label': '{n} de 5 estrelas',
    'stars.rating': 'Avaliação',
    // card
    'card.public': 'Público',
    'card.admin': 'Admin',
    'card.approve': 'Aprovar',
    // modal
    'modal.edit': 'Editar depoimento',
    'modal.new': 'Novo depoimento',
    'modal.name': 'Nome *',
    'modal.role': 'Cargo / Empresa',
    'modal.photo': 'URL da foto (http/https, opcional)',
    'modal.content': 'Depoimento *',
    'modal.status': 'Status',
    'modal.statusApproved': 'Aprovado',
    'modal.statusPending': 'Pendente',
    'modal.saveError': 'Não foi possível salvar o depoimento.',
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

/**
 * The consent e-mails (conference-manager 2.33.4) in the conference's e-mail language: «Autorizaciones ›
 * Idioma de los correos», by default the site's language (WPLANG). Three messages — the link, the one-time code
 * and the copy of what was authorized — in Spanish, English and Portuguese. Each returns { subject, text, html }.
 *
 * 2.36.11: their words and layout live in server/mail-templates.js («Plantillas de correo», editable by a WordJS
 * administrator); these are the DEFAULT renderings (no stored edit), kept for callers without the templates.
 * The LEGAL text quoted in the copy (what the person signed) stays exactly as signed, whatever the e-mail
 * language: it is the evidence — the layout draws it, no template text holds it.
 */
'use strict';

const tpl = require('./mail-templates');

const LANGS = ['es', 'en', 'pt'];
/** «es_ES», «pt-BR», «EN» → es / pt / en; anything else → null. */
const langOf = (raw) => { const l = String(raw || '').toLowerCase().slice(0, 2); return LANGS.includes(l) ? l : null; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ORGANIZERS = { es: 'los organizadores', en: 'the organisers', pt: 'os organizadores' };

function linkMail(lang, { conference, name, link, days }) {
    return tpl.renderMessage('consent.link', lang, { conference, name, days }, { action: { url: link } });
}
function codeMail(lang, { conference, code }) {
    return tpl.renderMessage('consent.code', lang, { conference, code }, { code });
}
/** `ev` is the «granted» row, `d` its data. */
function confirmationMail(lang, { conference, ev, d }) {
    const l = langOf(lang) || 'es';
    return tpl.renderMessage('consent.confirmation', l, { conference, contact: d.contact || ORGANIZERS[l] }, { record: tpl.recordOf(l, ev, d) });
}

module.exports = { LANGS, langOf, linkMail, codeMail, confirmationMail, esc, ORGANIZERS };

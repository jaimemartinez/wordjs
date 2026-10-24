/**
 * «Enviar» in a person's «Escarapela» section (conference-manager 2.36.6): the e-mail with the person's own badge
 * link — their «Mi inscripción» page — and how to use it: open it, keep it on the phone's home screen, turn the
 * notices on (meal calls, boarding) and keep it to themselves. In the conference's e-mail language («Autorizaciones ›
 * Idioma de los correos»).
 *
 * 2.36.11: its words and layout live in server/mail-templates.js (template «badge.link», editable from «Plantillas
 * de correo»); this is the DEFAULT rendering, for callers without the templates. The link is the layout's button.
 */
'use strict';

const tpl = require('./mail-templates');

function badgeMail(lang, { conference, name, link }) {
    return tpl.renderMessage('badge.link', lang, { conference, name }, { action: { url: link } });
}

module.exports = { badgeMail };

/**
 * «Enviar» in a person's «Escarapela» section (conference-manager 2.36.6): the e-mail with the person's own badge
 * link — their «Mi inscripción» page — and how to use it: open it, keep it on the phone's home screen, turn the
 * notices on (meal calls, boarding) and keep it to themselves. In the conference's e-mail language («Autorizaciones ›
 * Idioma de los correos»), built like the consent e-mails (server/consent-mail.js: { subject, text, html }, every
 * value escaped).
 */
'use strict';

const { langOf, esc, shell } = require('./consent-mail');

const T = {
    es: {
        hello: (n) => `Hola${n ? ` ${n}` : ''}:`,
        subject: (c) => `Tu escarapela · ${c}`,
        body: (c) => `Esta es tu escarapela de «${c}». Ábrela desde tu celular:`,
        button: 'Abrir mi escarapela',
        howTitle: 'Cómo usarla',
        how: [
            'Ábrela con el botón (o el enlace). La primera vez te pide tu documento: así nadie más la ve.',
            'Guárdala en la pantalla de inicio: en iPhone, en Safari toca Compartir › «Agregar a inicio»; en Android, en Chrome toca el menú ⋮ › «Agregar a la pantalla principal».',
            'Activa los avisos en la página: te llegan cuando llamen a tu grupo a comer y cuando salga tu bus.',
        ],
        personal: 'El enlace es personal: no lo compartas con nadie.',
        ignore: 'Si no esperabas este correo, ignóralo.',
    },
    en: {
        hello: (n) => `Hello${n ? ` ${n}` : ''},`,
        subject: (c) => `Your badge · ${c}`,
        body: (c) => `This is your badge for «${c}». Open it on your phone:`,
        button: 'Open my badge',
        howTitle: 'How to use it',
        how: [
            'Open it with the button (or the link). The first time it asks for your ID document, so nobody else can see it.',
            'Keep it on your home screen: on an iPhone, in Safari tap Share › «Add to Home Screen»; on Android, in Chrome tap the ⋮ menu › «Add to Home screen».',
            'Turn the notices on in the page: you get one when your group is called to eat and when your bus leaves.',
        ],
        personal: 'The link is personal: do not share it with anyone.',
        ignore: 'If you did not expect this e-mail, ignore it.',
    },
    pt: {
        hello: (n) => `Olá${n ? `, ${n}` : ''}:`,
        subject: (c) => `Seu crachá · ${c}`,
        body: (c) => `Este é o seu crachá de «${c}». Abra-o no seu celular:`,
        button: 'Abrir meu crachá',
        howTitle: 'Como usar',
        how: [
            'Abra-o com o botão (ou o link). Na primeira vez ele pede o seu documento: assim ninguém mais o vê.',
            'Guarde-o na tela inicial: no iPhone, no Safari toque em Compartilhar › «Adicionar à Tela de Início»; no Android, no Chrome toque no menu ⋮ › «Adicionar à tela inicial».',
            'Ative os avisos na página: você recebe um quando chamarem o seu grupo para comer e quando o seu ônibus sair.',
        ],
        personal: 'O link é pessoal: não o compartilhe com ninguém.',
        ignore: 'Se você não esperava este e-mail, ignore-o.',
    },
};

function badgeMail(lang, { conference, name, link }) {
    const L = T[langOf(lang) || 'es'];
    const subject = L.subject(conference);
    const text = `${L.hello(name)}\n\n${L.body(conference)}\n\n${link}\n\n${L.howTitle}:\n${L.how.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n${L.personal}\n${L.ignore}`;
    const html = shell(subject, `<p>${esc(L.hello(name))}</p><p>${esc(L.body(conference))}</p>`
        + `<p><a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600">${esc(L.button)}</a></p>`
        + `<p style="font-size:13px;color:#6b7280;word-break:break-all">${esc(link)}</p>`
        + `<p style="margin-top:16px;font-weight:600">${esc(L.howTitle)}</p>`
        + `<ol style="padding-left:20px;font-size:14px">${L.how.map(x => `<li style="margin:4px 0">${esc(x)}</li>`).join('')}</ol>`
        + `<p style="font-weight:600">${esc(L.personal)}</p><p style="color:#6b7280;font-size:13px">${esc(L.ignore)}</p>`);
    return { subject, text, html };
}

module.exports = { badgeMail };

/**
 * The consent e-mails (conference-manager 2.33.4) in the conference's e-mail language: «Autorizaciones ›
 * Idioma de los correos», by default the site's language (WPLANG). Three messages — the link, the one-time code
 * and the copy of what was authorized — in Spanish, English and Portuguese. Each returns { subject, text, html };
 * every value put into the HTML is escaped (esc), nothing is parsed or stripped.
 *
 * The LEGAL text quoted in the copy (what the person signed) stays exactly as signed, whatever the e-mail
 * language: it is the evidence.
 */
'use strict';

const LANGS = ['es', 'en', 'pt'];
/** «es_ES», «pt-BR», «EN» → es / pt / en; anything else → null. */
const langOf = (raw) => { const l = String(raw || '').toLowerCase().slice(0, 2); return LANGS.includes(l) ? l : null; };

const T = {
    es: {
        hello: (n) => `Hola${n ? ` ${n}` : ''}:`,
        linkSubject: (c) => `Autoriza el uso de tus datos · ${c}`,
        linkBody: (c) => `Tu coordinador te inscribió en «${c}». Para confirmar la inscripción, lee la política de datos y da tu autorización`,
        linkButton: 'Revisar y autorizar',
        linkValid: (d) => `El enlace vale ${d} días y se usa una sola vez. Si no esperabas este correo, ignóralo.`,
        codeSubject: (code) => `Tu código de autorización: ${code}`,
        codeTitle: 'Tu código de autorización',
        codeBody: (c) => `Tu código para firmar la autorización de datos de «${c}» es:`,
        codeNote: 'Vence en 10 minutos. No lo compartas con nadie: ni tu coordinador ni los organizadores te lo pedirán.',
        doneSubject: (c) => `Autorización registrada · ${c}`,
        doneBody: (c) => `Registramos tu autorización para «${c}»:`,
        yes: 'Sí', no: 'No',
        rows: { person: 'Persona inscrita', rep: 'Representante legal', general: 'Tratamiento de datos personales', health: 'Datos sensibles de salud', image: 'Uso de imagen', policy: 'Política', version: (v) => `versión ${v}`, policySha: 'Huella de la versión de la política (SHA-256)', when: 'Fecha y hora (UTC)', textSha: 'Huella del texto aceptado (SHA-256)' },
        signed: 'Texto que aceptaste', policyLink: 'Política', organizers: 'los organizadores',
        policyAt: (u) => `Puedes consultar la política en ${u}.`,
        revoke: (c) => `Para revocar tu autorización o ejercer tus derechos, escribe a ${c}.`,
    },
    en: {
        hello: (n) => `Hello${n ? ` ${n}` : ''},`,
        linkSubject: (c) => `Consent to the use of your data · ${c}`,
        linkBody: (c) => `Your coordinator registered you for «${c}». To confirm the registration, read the data policy and give your consent`,
        linkButton: 'Review and consent',
        linkValid: (d) => `The link is valid for ${d} days and works once. If you did not expect this e-mail, ignore it.`,
        codeSubject: (code) => `Your consent code: ${code}`,
        codeTitle: 'Your consent code',
        codeBody: (c) => `Your code to sign the data consent for «${c}» is:`,
        codeNote: 'It expires in 10 minutes. Do not share it with anyone: neither your coordinator nor the organisers will ask for it.',
        doneSubject: (c) => `Consent recorded · ${c}`,
        doneBody: (c) => `We recorded your consent for «${c}»:`,
        yes: 'Yes', no: 'No',
        rows: { person: 'Registered person', rep: 'Legal guardian', general: 'Processing of personal data', health: 'Sensitive health data', image: 'Use of image', policy: 'Policy', version: (v) => `version ${v}`, policySha: 'Fingerprint of the policy version (SHA-256)', when: 'Date and time (UTC)', textSha: 'Fingerprint of the accepted text (SHA-256)' },
        signed: 'The text you accepted', policyLink: 'Policy', organizers: 'the organisers',
        policyAt: (u) => `You can read the policy at ${u}.`,
        revoke: (c) => `To revoke your consent or exercise your rights, write to ${c}.`,
    },
    pt: {
        hello: (n) => `Olá${n ? `, ${n}` : ''}:`,
        linkSubject: (c) => `Autorize o uso dos seus dados · ${c}`,
        linkBody: (c) => `Seu coordenador inscreveu você em «${c}». Para confirmar a inscrição, leia a política de dados e dê sua autorização`,
        linkButton: 'Revisar e autorizar',
        linkValid: (d) => `O link vale ${d} dias e só pode ser usado uma vez. Se você não esperava este e-mail, ignore-o.`,
        codeSubject: (code) => `Seu código de autorização: ${code}`,
        codeTitle: 'Seu código de autorização',
        codeBody: (c) => `Seu código para assinar a autorização de dados de «${c}» é:`,
        codeNote: 'Vence em 10 minutos. Não o compartilhe com ninguém: nem seu coordenador nem os organizadores vão pedi-lo.',
        doneSubject: (c) => `Autorização registrada · ${c}`,
        doneBody: (c) => `Registramos sua autorização para «${c}»:`,
        yes: 'Sim', no: 'Não',
        rows: { person: 'Pessoa inscrita', rep: 'Representante legal', general: 'Tratamento de dados pessoais', health: 'Dados sensíveis de saúde', image: 'Uso de imagem', policy: 'Política', version: (v) => `versão ${v}`, policySha: 'Impressão digital da versão da política (SHA-256)', when: 'Data e hora (UTC)', textSha: 'Impressão digital do texto aceito (SHA-256)' },
        signed: 'Texto que você aceitou', policyLink: 'Política', organizers: 'os organizadores',
        policyAt: (u) => `Você pode consultar a política em ${u}.`,
        revoke: (c) => `Para revogar sua autorização ou exercer seus direitos, escreva para ${c}.`,
    },
};
const t = (lang) => T[langOf(lang) || 'es'];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shell = (title, inner) => `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111827;line-height:1.55">`
    + `<h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>${inner}</div>`;

function linkMail(lang, { conference, name, link, days }) {
    const L = t(lang);
    const subject = L.linkSubject(conference);
    const text = `${L.hello(name)}\n\n${L.linkBody(conference)}:\n\n${link}\n\n${L.linkValid(days)}`;
    const html = shell(subject, `<p>${esc(L.hello(name))}</p><p>${esc(L.linkBody(conference))}:</p>`
        + `<p><a href="${esc(link)}" style="display:inline-block;background:#111827;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600">${esc(L.linkButton)}</a></p>`
        + `<p style="color:#6b7280;font-size:13px">${esc(L.linkValid(days))}</p>`);
    return { subject, text, html };
}

function codeMail(lang, { conference, code }) {
    const L = t(lang);
    const subject = L.codeSubject(code);
    const text = `${L.codeBody(conference)} ${code}\n\n${L.codeNote}`;
    const html = shell(L.codeTitle, `<p>${esc(L.codeBody(conference))}</p>`
        + `<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:8px 0">${esc(code)}</p>`
        + `<p style="color:#6b7280;font-size:13px">${esc(L.codeNote)}</p>`);
    return { subject, text, html };
}

/** `ev` is the «granted» row, `d` its data. */
function confirmationMail(lang, { conference, ev, d }) {
    const L = t(lang);
    const yes = (v) => (v ? L.yes : L.no);
    const R = L.rows;
    const subject = L.doneSubject(conference);
    const contact = d.contact || L.organizers;
    const rows = [
        [R.person, d.subject.name],
        ...(d.representative ? [[R.rep, `${d.representative.name} (${d.representative.relationship})`]] : []),
        [R.general, yes(ev.general)],
        [R.health, yes(ev.health)],
        [R.image, yes(ev.image)],
        [R.policy, `${R.version(d.policy.version)} · ${d.policy.url}`],
        ...(d.policy.sha256 ? [[R.policySha, d.policy.sha256]] : []),
        [R.when, ev.at_utc],
        [R.textSha, ev.text_sha256],
    ];
    const text = `${L.doneBody(conference)}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${L.signed}:\n${d.text}\n\n${L.policyAt(d.policy.url)} ${L.revoke(contact)}`;
    const html = shell(subject, `<p>${esc(L.doneBody(conference))}</p><table style="border-collapse:collapse;font-size:14px">`
        + rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;word-break:break-all">${esc(v)}</td></tr>`).join('')
        + `</table><p style="margin-top:16px;font-weight:600">${esc(L.signed)}</p><p style="white-space:pre-wrap;font-size:13px;color:#374151">${esc(d.text)}</p>`
        + `<p>${esc(L.policyLink)}: <a href="${esc(d.policy.url)}">${esc(d.policy.url)}</a></p>`
        + `<p style="color:#6b7280;font-size:13px">${esc(L.revoke(contact))}</p>`);
    return { subject, text, html };
}

module.exports = { LANGS, langOf, linkMail, codeMail, confirmationMail };

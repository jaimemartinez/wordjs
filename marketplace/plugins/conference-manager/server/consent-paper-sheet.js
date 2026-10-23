/**
 * The printable consent sheet (conference-manager 2.34.0, «Consentimiento en papel»): one locality's list of people
 * who have not authorized yet, to sign by hand. A self-contained, print-ready HTML page (no script, no external
 * file) in Spanish, English or Portuguese, on Letter («carta», by default) or A4, landscape. EVERY page has:
 *   - on top, the compact authorization: the controller and contact, the purpose, the rights, the policy in force
 *     (address, version and SHA-256), and ONE authorization — the configured general, image and health texts in a
 *     single block, the health and image parts said to be voluntary — and how to sign; whoever signs on any page
 *     reads what they sign;
 *   - the signature rows, as many as fit under that header: #, name (pre-filled), document (to write), signature,
 *     two narrow opt-out boxes «No autorizo datos de salud» and «No autorizo uso de imagen» (unmarked = authorized;
 *     the registration goes ahead either way), and the legal representative of a minor (name, document,
 *     signature); the blank rows after the pre-filled ones are for walk-ins;
 *   - at the bottom of the printed page, the sheet's id, «page i of n» and a QR code with both («CMP:<id>:<i>/<n>»),
 *     so a scanned page is matched to its sheet.
 * Every value put into the HTML is escaped (esc); nothing is parsed or stripped.
 *
 * `sheetText` is the plain text the sheet shows (what a paper signature accepted): its SHA-256 goes into the
 * evidence, the same way the consent page's text does.
 */
'use strict';

const { encodeQr } = require('./badge-qr');

const LANGS = ['es', 'en', 'pt'];

const T = {
    es: {
        title: 'Autorización para el tratamiento de datos personales',
        sheet: 'Hoja', page: (i, n) => `Página ${i} de ${n}`, locality: 'Localidad', conference: 'Conferencia', printed: 'Impresa (UTC)',
        controller: 'Responsable', contact: 'Contacto',
        purpose: 'Finalidad', purposeText: (c) => `Gestionar la inscripción a «${c}»: registro, logística, hospedaje, alimentación y comunicaciones del evento.`,
        rights: 'Derechos', rightsText: (mail) => `Usted puede conocer, actualizar, rectificar y suprimir sus datos, y revocar esta autorización, escribiendo a ${mail}.`,
        policy: 'Política', version: (v) => `versión ${v}`,
        auth: 'Autorización',
        how: 'Cómo firmar: escriba su número de documento y firme; su firma da la autorización de esta página. Si no autoriza sus datos de salud o el uso de su imagen, marque la casilla correspondiente. Para un menor de edad firma su padre, madre o representante legal, con su nombre y documento.',
        voluntary: 'La autorización de mis datos de salud y la del uso de mi imagen son voluntarias: no estoy obligado a darlas. Si no las doy, marco la casilla «No autorizo…» de mi fila; mi inscripción sigue adelante igual.',
        col: { n: '#', name: 'Nombre', doc: 'Documento', sign: 'Firma', health: 'No autorizo datos de salud', image: 'No autorizo uso de imagen', rep: 'Representante legal (menores)', repName: 'Nombre', repDoc: 'Documento', repSign: 'Firma' },
        organizers: 'los organizadores',
    },
    en: {
        title: 'Consent to the processing of personal data',
        sheet: 'Sheet', page: (i, n) => `Page ${i} of ${n}`, locality: 'Locality', conference: 'Conference', printed: 'Printed (UTC)',
        controller: 'Controller', contact: 'Contact',
        purpose: 'Purpose', purposeText: (c) => `Managing the registration for «${c}»: registration, logistics, lodging, meals and the event's communications.`,
        rights: 'Rights', rightsText: (mail) => `You may access, update, correct and delete your data, and revoke this consent, by writing to ${mail}.`,
        policy: 'Policy', version: (v) => `version ${v}`,
        auth: 'Consent',
        how: 'How to sign: write your document number and sign; your signature gives the consent on this page. If you do not consent to your health data or to the use of your image, tick that box. For a minor, their parent or legal guardian signs, with their name and document.',
        voluntary: 'The consent to my health data and to the use of my image is voluntary: I am not obliged to give it. If I do not give it, I tick the «I do not consent…» box in my row; my registration goes ahead all the same.',
        col: { n: '#', name: 'Name', doc: 'Document', sign: 'Signature', health: 'I do not consent to health data', image: 'I do not consent to use of image', rep: 'Legal guardian (minors)', repName: 'Name', repDoc: 'Document', repSign: 'Signature' },
        organizers: 'the organisers',
    },
    pt: {
        title: 'Autorização para o tratamento de dados pessoais',
        sheet: 'Folha', page: (i, n) => `Página ${i} de ${n}`, locality: 'Localidade', conference: 'Conferência', printed: 'Impressa (UTC)',
        controller: 'Responsável', contact: 'Contato',
        purpose: 'Finalidade', purposeText: (c) => `Gerir a inscrição em «${c}»: registro, logística, hospedagem, alimentação e comunicações do evento.`,
        rights: 'Direitos', rightsText: (mail) => `Você pode conhecer, atualizar, retificar e excluir seus dados, e revogar esta autorização, escrevendo para ${mail}.`,
        policy: 'Política', version: (v) => `versão ${v}`,
        auth: 'Autorização',
        how: 'Como assinar: escreva o número do seu documento e assine; sua assinatura dá a autorização desta página. Se não autorizar seus dados de saúde ou o uso da sua imagem, marque a casinha correspondente. Por um menor de idade assina o pai, a mãe ou o representante legal, com nome e documento.',
        voluntary: 'A autorização dos meus dados de saúde e a do uso da minha imagem são voluntárias: não sou obrigado a dá-las. Se não as der, marco a casinha «Não autorizo…» da minha linha; minha inscrição segue igual.',
        col: { n: '#', name: 'Nome', doc: 'Documento', sign: 'Assinatura', health: 'Não autorizo dados de saúde', image: 'Não autorizo uso de imagem', rep: 'Representante legal (menores)', repName: 'Nome', repDoc: 'Documento', repSign: 'Assinatura' },
        organizers: 'os organizadores',
    },
};
const langOf = (l) => (LANGS.includes(String(l || '').toLowerCase()) ? String(l).toLowerCase() : 'es');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A QR code as an inline SVG (one path, crisp when printed). */
function qrSvg(text, sizeMm = 22) {
    const qr = encodeQr(text, 'M');
    const n = qr.modules.length, q = 2; // quiet zone
    let d = '';
    qr.modules.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + q} ${y + q}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" width="${sizeMm}mm" height="${sizeMm}mm" shape-rendering="crispEdges" aria-hidden="true"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** The single authorization a signature gives: the general, image and health texts as one block. */
const oneAuthorization = (texts) => [texts.general, texts.image, texts.health].map(x => String(x || '').trim()).filter(Boolean).join(' ');

/**
 * Paper sizes (landscape, 8 mm margins): the printable box of each page. Every page of the sheet is exactly that
 * box (a flex column, the footer pushed to its bottom), so the footer sits at the real bottom of the printed page.
 * «carta» (Letter, the Colombian standard) by default; A4 on request.
 */
const PAPERS = {
    letter: { css: 'letter landscape', w: 263, h: 198 },
    a4: { css: 'A4 landscape', w: 280, h: 192 },
};
const paperOf = (p) => (PAPERS[String(p || '').toLowerCase()] ? String(p).toLowerCase() : 'letter');

// What a page needs, in mm, to fit its rows under the header (estimates on the safe side: a row too many would push
// the footer onto a page of its own). 11 pt ≈ 2.05 mm a character, 9.5 pt ≈ 1.75 mm, line heights ×1.3.
const ROW_MM = 12.5, THEAD_MM = 14, FOOT_MM = 19, GAPS_MM = 12;
const linesOf = (text, charsPerLine) => Math.max(1, Math.ceil(String(text || '').length / charsPerLine));
function headerMm(paper, parts) {
    const colW = (paper.w - 8) / 2;                     // two columns for the facts and the authorization
    const per = (pt) => Math.floor(colW / (pt === 11 ? 2.05 : 1.78));
    const full = Math.floor(paper.w / 1.95);            // the 10 pt how-to line across the page
    const facts = Math.max(
        parts.factsLeft.reduce((n, t) => n + linesOf(t, per(9.5)), 0),
        parts.factsRight.reduce((n, t) => n + linesOf(t, per(9.5)), 0)) * 4.3;
    const auth = Math.ceil(linesOf(parts.auth, per(11)) / 2) * 5.05;
    return 8 /* title */ + facts + auth + linesOf(parts.how, full) * 4.6 + GAPS_MM;
}
/** How many rows each page holds for this header on this paper (at least 3). */
function rowsPerPage(paper, parts) {
    return Math.max(3, Math.floor((paper.h - headerMm(paper, parts) - THEAD_MM - FOOT_MM) / ROW_MM));
}

/**
 * The text the sheet shows, as plain text (its SHA-256 is the evidence's text_sha256).
 * `s`: { lang, conference, location, policy: { url, version, sha256 }, responsible, contact, texts: { general, health, image } }
 */
function sheetText(s) {
    const L = T[langOf(s.lang)];
    const contact = s.contact || L.organizers;
    return [
        `${L.title} — ${s.conference}`,
        `${L.locality}: ${s.location}`,
        `${L.controller}: ${s.responsible || L.organizers}`,
        `${L.contact}: ${contact}`,
        `${L.purpose}: ${L.purposeText(s.conference)}`,
        `${L.rights}: ${L.rightsText(contact)}`,
        `${L.policy}: ${s.policy.url} (${L.version(s.policy.version)}; SHA-256 ${s.policy.sha256})`,
        `${L.auth}: ${oneAuthorization(s.texts)} ${L.voluntary}`,
        L.how,
    ].join('\n');
}

/**
 * The sheet's HTML. `s` as sheetText's, plus { code, created_utc, people: [{ row, name }], blank, paper? }.
 * Every page is self-contained: the compact authorization (who, what for, rights, policy, the one authorization
 * text, that health and image are voluntary, how to sign) on top, the signature rows under it, and the footer
 * (QR, sheet id, page i of n) at the bottom — so whoever signs page 3 reads what they sign.
 */
function sheetHtml(s) {
    const lang = langOf(s.lang);
    const L = T[lang];
    const paperKey = paperOf(s.paper);
    const paper = PAPERS[paperKey];
    const people = Array.isArray(s.people) ? s.people : [];
    const blank = Math.max(0, Number(s.blank) || 0);
    const lines = [...people.map(p => ({ row: p.row, name: p.name })), ...Array.from({ length: blank }, (_, i) => ({ row: people.length + i + 1, name: '' }))];
    const contact = s.contact || L.organizers;
    const authText = oneAuthorization(s.texts);
    const factsLeft = [`${L.controller}: ${s.responsible || L.organizers}`, `${L.contact}: ${contact}`, `${L.policy}: ${s.policy.url} · ${L.version(s.policy.version)}`, 'SHA-256 ' + s.policy.sha256];
    const factsRight = [`${L.purpose}: ${L.purposeText(s.conference)}`, `${L.rights}: ${L.rightsText(contact)}`];
    const perPage = rowsPerPage(paper, { factsLeft, factsRight, auth: `${authText} ${L.voluntary}`, how: L.how });
    const total = Math.max(1, Math.ceil(lines.length / perPage));
    const printed = String(s.created_utc || '').replace('T', ' ').slice(0, 16);

    const header = `<header class="head">
<div class="top"><h1>${esc(L.title)}</h1><div class="meta">${esc(L.conference)}: <b>${esc(s.conference)}</b> · ${esc(L.locality)}: <b>${esc(s.location)}</b> · ${esc(L.sheet)} <b>${esc(s.code)}</b> · <span class="nw">${esc(L.printed)}: ${esc(printed)}</span></div></div>
<div class="facts">
<div><p><b>${esc(L.controller)}:</b> ${esc(s.responsible || L.organizers)}</p><p><b>${esc(L.contact)}:</b> ${esc(contact)}</p><p><b>${esc(L.policy)}:</b> ${esc(s.policy.url)} · ${esc(L.version(s.policy.version))}</p><p class="sha">SHA-256 ${esc(s.policy.sha256)}</p></div>
<div><p><b>${esc(L.purpose)}:</b> ${esc(L.purposeText(s.conference))}</p><p><b>${esc(L.rights)}:</b> ${esc(L.rightsText(contact))}</p></div>
</div>
<div class="auth"><b>${esc(L.auth)}.</b> ${esc(authText)} <b>${esc(L.voluntary)}</b></div>
<p class="how">${esc(L.how)}</p>
</header>`;
    const foot = (i) => `<footer class="foot"><div class="qr">${qrSvg(`CMP:${s.code}:${i}/${total}`, 15)}</div>`
        + `<div><b>${esc(L.sheet)} ${esc(s.code)}</b> · ${esc(L.page(i, total))}<br>${esc(s.conference)} · ${esc(L.locality)}: ${esc(s.location)} · ${esc(L.policy)} ${esc(L.version(s.policy.version))}</div></footer>`;
    const box = '<span class="box"></span>';
    const thead = `<thead><tr><th rowspan="2" class="n">${esc(L.col.n)}</th><th rowspan="2" class="name">${esc(L.col.name)}</th><th rowspan="2" class="doc">${esc(L.col.doc)}</th><th rowspan="2" class="sign">${esc(L.col.sign)}</th><th rowspan="2" class="opt">${esc(L.col.health)}</th><th rowspan="2" class="opt">${esc(L.col.image)}</th><th colspan="3">${esc(L.col.rep)}</th></tr>
<tr><th class="rname">${esc(L.col.repName)}</th><th class="rdoc">${esc(L.col.repDoc)}</th><th>${esc(L.col.repSign)}</th></tr></thead>`;

    const pages = [];
    for (let p = 0; p < total; p++) {
        const chunk = lines.slice(p * perPage, (p + 1) * perPage);
        const body = chunk.map(l => `<tr${l.name ? '' : ' class="walk"'}><td class="n">${esc(l.row)}</td><td class="name">${esc(l.name)}</td><td></td><td></td><td class="opt">${box}</td><td class="opt">${box}</td><td></td><td></td><td></td></tr>`).join('');
        pages.push(`<section class="page">
${header}
<table>${thead}<tbody>${body}</tbody></table>
${foot(p + 1)}
</section>`);
    }

    return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(L.sheet)} ${esc(s.code)} — ${esc(s.conference)} · ${esc(s.location)}</title>
<style>
@page { size: ${paper.css}; margin: 8mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #111; font-size: 11pt; line-height: 1.3; background: #fff; }
.page { width: ${paper.w}mm; height: ${paper.h}mm; display: flex; flex-direction: column; overflow: hidden; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
@media screen { body { background: #e5e7eb; padding: 12px 0; } .page { background: #fff; margin: 0 auto 12px; padding: 0; box-shadow: 0 0 0 8mm #fff, 0 1px 4px 8mm rgba(0,0,0,.12); } }
.head { flex: none; }
.top { display: flex; align-items: baseline; justify-content: space-between; gap: 6mm; border-bottom: 1.5px solid #111; padding-bottom: 1mm; }
h1 { font-size: 13pt; margin: 0; white-space: nowrap; }
.meta { font-size: 9pt; color: #333; text-align: right; }
.nw { white-space: nowrap; }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8mm; font-size: 9.5pt; margin: 1.5mm 0; }
.facts p { margin: 0 0 0.6mm; }
.facts .sha { font-size: 7.5pt; color: #555; word-break: break-all; }
.auth { column-count: 2; column-gap: 8mm; text-align: left; font-size: 11pt; border-top: 1px solid #999; padding-top: 1.5mm; }
.how { margin: 1.5mm 0 2mm; font-size: 10pt; padding: 1mm 2mm; border: 1px solid #999; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; flex: none; }
th, td { border: 1px solid #333; padding: 1px 4px; vertical-align: middle; }
th { font-size: 8.5pt; background: #f1f1f1; line-height: 1.15; }
td { height: ${ROW_MM}mm; font-size: 11pt; }
.n { width: 8mm; text-align: center; } .name { width: 64mm; } .doc { width: 30mm; } .sign { width: 42mm; } .opt { width: 17mm; text-align: center; } .rname { width: 38mm; } .rdoc { width: 26mm; }
tr.walk td.name { background: #fafafa; }
.box { display: inline-block; width: 4.5mm; height: 4.5mm; border: 1px solid #111; }
.foot { margin-top: auto; display: flex; gap: 3mm; align-items: center; font-size: 8.5pt; color: #333; padding-top: 2mm; }
</style></head>
<body>
${pages.join('\n')}
</body></html>`;
}

module.exports = { sheetHtml, sheetText, qrSvg, rowsPerPage, PAPERS, LANGS };

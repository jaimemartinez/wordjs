/**
 * The printable consent sheet (conference-manager 2.34.0, «Consentimiento en papel»): one locality's list of people
 * who have not authorized yet, to sign by hand. A self-contained, print-ready HTML page (no script, no external
 * file) in Spanish, English or Portuguese:
 *   - page 1: the policy in force (its version, address and SHA-256), the controller and contact, the purpose, the
 *     rights and how to exercise them, and ONE authorization: the configured general, image and health texts in a
 *     single block, with the health and image parts said to be voluntary — one signature covers it all;
 *   - then the signature pages, ROWS_PER_PAGE rows each: #, name (pre-filled), document (to write), signature, two
 *     narrow opt-out boxes «No autorizo datos de salud» and «No autorizo uso de imagen» (unmarked = authorized; the
 *     registration goes ahead either way), and the legal representative of a minor (name, document, signature); the
 *     blank rows after the pre-filled ones are for walk-ins;
 *   - every page carries the sheet's id, «page i of n» and a QR code with both («CMP:<id>:<i>/<n>»), so a scanned
 *     page is matched to its sheet.
 * Every value put into the HTML is escaped (esc); nothing is parsed or stripped.
 *
 * `sheetText` is the plain text the sheet shows (what a paper signature accepted): its SHA-256 goes into the
 * evidence, the same way the consent page's text does.
 */
'use strict';

const { encodeQr } = require('./badge-qr');

const ROWS_PER_PAGE = 10;
const LANGS = ['es', 'en', 'pt'];

const T = {
    es: {
        title: 'Autorización para el tratamiento de datos personales',
        sheet: 'Hoja', page: (i, n) => `Página ${i} de ${n}`, locality: 'Localidad', conference: 'Conferencia', printed: 'Impresa (UTC)',
        controller: 'Responsable del tratamiento', contact: 'Contacto para ejercer sus derechos',
        purpose: 'Finalidad', purposeText: (c) => `Gestionar la inscripción a «${c}»: registro, logística, hospedaje, alimentación y comunicaciones del evento.`,
        rights: 'Derechos', rightsText: (mail) => `Usted puede conocer, actualizar, rectificar y suprimir sus datos, y revocar esta autorización, escribiendo a ${mail}.`,
        policy: 'Política de tratamiento de datos', version: (v) => `versión ${v}`, sha: 'Huella de la versión (SHA-256)',
        auth: 'Autorización',
        how: 'Cómo firmar: escriba su número de documento y firme; su firma da la autorización de esta página. Si no autoriza sus datos de salud o el uso de su imagen, marque la casilla correspondiente. Para un menor de edad firma su padre, madre o representante legal, con su nombre y documento.',
        voluntary: 'La autorización de mis datos de salud y la del uso de mi imagen son voluntarias: no estoy obligado a darlas. Si no las doy, marco la casilla «No autorizo…» de mi fila; mi inscripción sigue adelante igual.',
        refer: (v) => `Al firmar acepto los textos de la página 1 (política, ${v}).`,
        col: { n: '#', name: 'Nombre', doc: 'Documento', sign: 'Firma', health: 'No autorizo datos de salud', image: 'No autorizo uso de imagen', rep: 'Representante legal (menores)', repName: 'Nombre', repDoc: 'Documento', repSign: 'Firma' },
        organizers: 'los organizadores',
    },
    en: {
        title: 'Consent to the processing of personal data',
        sheet: 'Sheet', page: (i, n) => `Page ${i} of ${n}`, locality: 'Locality', conference: 'Conference', printed: 'Printed (UTC)',
        controller: 'Data controller', contact: 'Contact to exercise your rights',
        purpose: 'Purpose', purposeText: (c) => `Managing the registration for «${c}»: registration, logistics, lodging, meals and the event's communications.`,
        rights: 'Rights', rightsText: (mail) => `You may access, update, correct and delete your data, and revoke this consent, by writing to ${mail}.`,
        policy: 'Data processing policy', version: (v) => `version ${v}`, sha: 'Fingerprint of the version (SHA-256)',
        auth: 'Consent',
        how: 'How to sign: write your document number and sign; your signature gives the consent on this page. If you do not consent to your health data or to the use of your image, tick that box. For a minor, their parent or legal guardian signs, with their name and document.',
        voluntary: 'The consent to my health data and to the use of my image is voluntary: I am not obliged to give it. If I do not give it, I tick the «I do not consent…» box in my row; my registration goes ahead all the same.',
        refer: (v) => `By signing I accept the texts on page 1 (policy, ${v}).`,
        col: { n: '#', name: 'Name', doc: 'Document', sign: 'Signature', health: 'I do not consent to health data', image: 'I do not consent to use of image', rep: 'Legal guardian (minors)', repName: 'Name', repDoc: 'Document', repSign: 'Signature' },
        organizers: 'the organisers',
    },
    pt: {
        title: 'Autorização para o tratamento de dados pessoais',
        sheet: 'Folha', page: (i, n) => `Página ${i} de ${n}`, locality: 'Localidade', conference: 'Conferência', printed: 'Impressa (UTC)',
        controller: 'Responsável pelo tratamento', contact: 'Contato para exercer seus direitos',
        purpose: 'Finalidade', purposeText: (c) => `Gerir a inscrição em «${c}»: registro, logística, hospedagem, alimentação e comunicações do evento.`,
        rights: 'Direitos', rightsText: (mail) => `Você pode conhecer, atualizar, retificar e excluir seus dados, e revogar esta autorização, escrevendo para ${mail}.`,
        policy: 'Política de tratamento de dados', version: (v) => `versão ${v}`, sha: 'Impressão digital da versão (SHA-256)',
        auth: 'Autorização',
        how: 'Como assinar: escreva o número do seu documento e assine; sua assinatura dá a autorização desta página. Se não autorizar seus dados de saúde ou o uso da sua imagem, marque a casinha correspondente. Por um menor de idade assina o pai, a mãe ou o representante legal, com nome e documento.',
        voluntary: 'A autorização dos meus dados de saúde e a do uso da minha imagem são voluntárias: não sou obrigado a dá-las. Se não as der, marco a casinha «Não autorizo…» da minha linha; minha inscrição segue igual.',
        refer: (v) => `Ao assinar aceito os textos da página 1 (política, ${v}).`,
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

/** How many pages a sheet of `rows` lines has (the cover page plus the signature pages). */
const pageCountOf = (rows) => 1 + Math.max(1, Math.ceil(rows / ROWS_PER_PAGE));

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
 * The sheet's HTML. `s` as sheetText's, plus { code, created_utc, people: [{ row, name }], blank }.
 */
function sheetHtml(s) {
    const lang = langOf(s.lang);
    const L = T[lang];
    const people = Array.isArray(s.people) ? s.people : [];
    const blank = Math.max(0, Number(s.blank) || 0);
    const lines = [...people.map(p => ({ row: p.row, name: p.name })), ...Array.from({ length: blank }, (_, i) => ({ row: people.length + i + 1, name: '' }))];
    const total = pageCountOf(lines.length);
    const contact = s.contact || L.organizers;
    const foot = (i) => `<footer class="foot"><div class="qr">${qrSvg(`CMP:${s.code}:${i}/${total}`)}</div>`
        + `<div><b>${esc(L.sheet)} ${esc(s.code)}</b> · ${esc(L.page(i, total))}<br>${esc(s.conference)} · ${esc(L.locality)}: ${esc(s.location)} · ${esc(L.policy)} ${esc(L.version(s.policy.version))}</div></footer>`;
    const optOut = '<span class="box"></span>';

    const cover = `<section class="page">
<h1>${esc(L.title)}</h1>
<p class="meta">${esc(L.conference)}: <b>${esc(s.conference)}</b> · ${esc(L.locality)}: <b>${esc(s.location)}</b> · ${esc(L.sheet)} <b>${esc(s.code)}</b> · ${esc(L.printed)}: ${esc(String(s.created_utc || '').replace('T', ' ').slice(0, 16))}</p>
<dl>
<dt>${esc(L.controller)}</dt><dd>${esc(s.responsible || L.organizers)}</dd>
<dt>${esc(L.contact)}</dt><dd>${esc(contact)}</dd>
<dt>${esc(L.purpose)}</dt><dd>${esc(L.purposeText(s.conference))}</dd>
<dt>${esc(L.rights)}</dt><dd>${esc(L.rightsText(contact))}</dd>
<dt>${esc(L.policy)}</dt><dd>${esc(s.policy.url)} — ${esc(L.version(s.policy.version))}<br><small>${esc(L.sha)}: <code>${esc(s.policy.sha256)}</code></small></dd>
</dl>
<h2>${esc(L.auth)}</h2><p class="legal">${esc(oneAuthorization(s.texts))}</p>
<p class="legal"><b>${esc(L.voluntary)}</b></p>
<p class="how">${esc(L.how)}</p>
${foot(1)}
</section>`;

    const pages = [];
    for (let p = 0; p < total - 1; p++) {
        const chunk = lines.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE);
        const body = chunk.map(l => `<tr${l.name ? '' : ' class="walk"'}><td class="n">${esc(l.row)}</td><td class="name">${esc(l.name)}</td><td></td><td></td><td class="opt">${optOut}</td><td class="opt">${optOut}</td><td></td><td></td><td></td></tr>`).join('');
        pages.push(`<section class="page">
<p class="refer"><b>${esc(L.title)}</b> · ${esc(L.refer(L.version(s.policy.version)))}</p>
<table><thead><tr><th rowspan="2" class="n">${esc(L.col.n)}</th><th rowspan="2" class="name">${esc(L.col.name)}</th><th rowspan="2" class="doc">${esc(L.col.doc)}</th><th rowspan="2" class="sign">${esc(L.col.sign)}</th><th rowspan="2" class="yncol">${esc(L.col.health)}</th><th rowspan="2" class="yncol">${esc(L.col.image)}</th><th colspan="3">${esc(L.col.rep)}</th></tr>
<tr><th class="rname">${esc(L.col.repName)}</th><th class="doc">${esc(L.col.repDoc)}</th><th class="sign">${esc(L.col.repSign)}</th></tr></thead>
<tbody>${body}</tbody></table>
${foot(p + 2)}
</section>`);
    }

    return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(L.sheet)} ${esc(s.code)} — ${esc(s.conference)} · ${esc(s.location)}</title>
<style>
@page { size: landscape; margin: 10mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #111; font-size: 10.5pt; background: #fff; }
.page { position: relative; min-height: 180mm; padding-bottom: 30mm; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
@media screen { body { background: #e5e7eb; } .page { background: #fff; max-width: 277mm; margin: 12px auto; padding: 10mm 10mm 34mm; box-shadow: 0 1px 4px rgba(0,0,0,.15); } }
h1 { font-size: 16pt; margin: 0 0 4px; } h2 { font-size: 11pt; margin: 10px 0 2px; }
.meta, .refer { margin: 0 0 8px; color: #333; }
dl { display: grid; grid-template-columns: 52mm 1fr; gap: 2px 8px; margin: 6px 0; } dt { font-weight: 700; } dd { margin: 0; }
code { font-size: 8.5pt; word-break: break-all; }
.legal { margin: 0; white-space: pre-wrap; text-align: justify; }
.how { margin-top: 10px; padding: 6px 8px; border: 1px solid #999; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border: 1px solid #333; padding: 2px 4px; vertical-align: middle; }
th { font-size: 8.5pt; background: #f1f1f1; }
td { height: 13mm; }
.n { width: 8mm; text-align: center; } .name { width: 50mm; } .doc { width: 28mm; } .sign { width: 40mm; } .yncol { width: 19mm; font-size: 7.5pt; } .rname { width: 40mm; }
td.opt { text-align: center; }
tr.walk td.name { background: #fafafa; }
.box { display: inline-block; width: 4.5mm; height: 4.5mm; border: 1px solid #111; }
.foot { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 8px; align-items: center; font-size: 8.5pt; color: #333; }
@media screen { .foot { left: 10mm; right: 10mm; bottom: 8mm; } }
</style></head>
<body>
${cover}
${pages.join('\n')}
</body></html>`;
}

module.exports = { sheetHtml, sheetText, qrSvg, pageCountOf, ROWS_PER_PAGE, LANGS };

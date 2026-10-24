/**
 * «Plantillas de correo» (conference-manager 2.36.11): every e-mail the plugin sends, editable from the admin
 * (WordJS administrators), in Spanish, English and Portuguese, wrapped in one responsive, e-mail-safe layout.
 *
 * THE MESSAGES. Five: the consent link, the one-time code, the copy of the authorization, the badge link and the
 * welcome to a locality's coordinator. Each has a default subject, a text BEFORE and a text AFTER the part the
 * system draws, an action label, and the placeholders its texts may use ({conference}, {name} …). An edit is
 * stored per message and language; a language without one uses the default («Restaurar original» deletes it).
 *
 * WHAT AN ADMINISTRATOR CAN NEVER EDIT — the parts that carry authority are not text in the template:
 *   - the action link (the consent link with its single-use token, the badge link, the portal's address) is
 *     handed to render() by the sender and the layout draws it as the button and as the copy-this-address line;
 *     no placeholder holds a URL, so an edited text cannot drop the link, point it elsewhere or copy the token;
 *   - the one-time code is drawn by the layout in its box (and only the code message has a {code} for its subject);
 *   - the copy of the authorization (what the person signed, its fingerprints) is drawn by the layout as signed;
 *   - the welcome message never receives a locality's access code — there is no value to put it in.
 *
 * SAFETY — the texts are NEVER HTML. They are plain text with a tiny markup: a blank line starts a paragraph,
 * lines starting «- » make a list, **bold**, and [text](https://…) / mailto: links. Everything is escaped first and
 * the HTML is generated from that, so whatever is typed (tags included) shows as text; a value put into a
 * placeholder is inserted after the markup was read, escaped, so it can never become markup or a link. A line
 * whose placeholders are all empty is left out (an admin contact that is not configured). The plain-text
 * alternative is generated from the same source, never from the HTML. Subjects are one line of plain text.
 */
'use strict';

const LANGS = ['es', 'en', 'pt'];
const langOf = (raw) => { const l = String(raw || '').toLowerCase().slice(0, 2); return LANGS.includes(l) ? l : 'es'; };
const LIMITS = { subject: 200, body: 5000, after: 3000, action: 60 };

const L3 = (es, en, pt) => ({ es, en, pt });

/** The registry: what each message is, its placeholders (with the samples the preview uses) and its defaults. */
const DEFS = [
    {
        id: 'consent.link', block: 'action',
        name: L3('Autorización de datos: enlace', 'Data consent: link', 'Autorização de dados: link'),
        description: L3('Se envía a la persona inscrita para que lea la política y autorice el uso de sus datos.', 'Sent to the registered person to read the policy and consent to the use of their data.', 'Enviado à pessoa inscrita para ler a política e autorizar o uso dos seus dados.'),
        placeholders: [
            { key: 'name', label: L3('Nombre de la persona', 'Person\'s name', 'Nome da pessoa'), sample: L3('Ana', 'Ana', 'Ana') },
            { key: 'conference', label: L3('Conferencia', 'Conference', 'Conferência'), sample: L3('Asume el Riesgo', 'Asume el Riesgo', 'Asume el Riesgo') },
            { key: 'days', label: L3('Días de validez del enlace', 'Days the link is valid', 'Dias de validade do link'), sample: L3('14', '14', '14') },
        ],
        subject: L3('Autoriza el uso de tus datos · {conference}', 'Consent to the use of your data · {conference}', 'Autorize o uso dos seus dados · {conference}'),
        body: L3(
            'Hola {name}:\n\nTu coordinador te inscribió en «{conference}». Para confirmar la inscripción, lee la política de datos y da tu autorización.',
            'Hello {name},\n\nYour coordinator registered you for «{conference}». To confirm the registration, read the data policy and give your consent.',
            'Olá, {name}:\n\nSeu coordenador inscreveu você em «{conference}». Para confirmar a inscrição, leia a política de dados e dê sua autorização.'),
        after: L3(
            'El enlace vale {days} días y se usa una sola vez. Si no esperabas este correo, ignóralo.',
            'The link is valid for {days} days and works once. If you did not expect this e-mail, ignore it.',
            'O link vale {days} dias e só pode ser usado uma vez. Se você não esperava este e-mail, ignore-o.'),
        action: L3('Revisar y autorizar', 'Review and consent', 'Revisar e autorizar'),
    },
    {
        id: 'consent.code', block: 'code',
        name: L3('Autorización de datos: código', 'Data consent: code', 'Autorização de dados: código'),
        description: L3('El código de un solo uso con el que la persona firma su autorización.', 'The one-time code the person signs their consent with.', 'O código de uso único com que a pessoa assina sua autorização.'),
        placeholders: [
            { key: 'conference', label: L3('Conferencia', 'Conference', 'Conferência'), sample: L3('Asume el Riesgo', 'Asume el Riesgo', 'Asume el Riesgo') },
            { key: 'code', label: L3('Código (solo en el asunto)', 'Code (subject only)', 'Código (só no assunto)'), sample: L3('482913', '482913', '482913'), subjectOnly: true },
        ],
        subject: L3('Tu código de autorización: {code}', 'Your consent code: {code}', 'Seu código de autorização: {code}'),
        body: L3('Tu código para firmar la autorización de datos de «{conference}» es:', 'Your code to sign the data consent for «{conference}» is:', 'Seu código para assinar a autorização de dados de «{conference}» é:'),
        after: L3(
            'Vence en 10 minutos. No lo compartas con nadie: ni tu coordinador ni los organizadores te lo pedirán.',
            'It expires in 10 minutes. Do not share it with anyone: neither your coordinator nor the organisers will ask for it.',
            'Vence em 10 minutos. Não o compartilhe com ninguém: nem seu coordenador nem os organizadores vão pedi-lo.'),
    },
    {
        id: 'consent.confirmation', block: 'record',
        name: L3('Autorización de datos: copia de lo autorizado', 'Data consent: copy of the consent', 'Autorização de dados: cópia do autorizado'),
        description: L3('La copia de lo que la persona autorizó, con la política y las huellas. El registro no se edita: es la evidencia.', 'The copy of what the person consented to, with the policy and fingerprints. The record is not editable: it is the evidence.', 'A cópia do que a pessoa autorizou, com a política e as impressões digitais. O registro não é editável: é a evidência.'),
        placeholders: [
            { key: 'conference', label: L3('Conferencia', 'Conference', 'Conferência'), sample: L3('Asume el Riesgo', 'Asume el Riesgo', 'Asume el Riesgo') },
            { key: 'contact', label: L3('Correo de contacto de datos', 'Data contact e-mail', 'E-mail de contato de dados'), sample: L3('datos@ejemplo.org', 'data@example.org', 'dados@exemplo.org') },
        ],
        subject: L3('Autorización registrada · {conference}', 'Consent recorded · {conference}', 'Autorização registrada · {conference}'),
        body: L3('Registramos tu autorización para «{conference}»:', 'We recorded your consent for «{conference}»:', 'Registramos sua autorização para «{conference}»:'),
        after: L3(
            'Para revocar tu autorización o ejercer tus derechos, escribe a {contact}.',
            'To revoke your consent or exercise your rights, write to {contact}.',
            'Para revogar sua autorização ou exercer seus direitos, escreva para {contact}.'),
    },
    {
        id: 'badge.link', block: 'action',
        name: L3('Escarapela', 'Badge', 'Crachá'),
        description: L3('El enlace personal a la escarapela de la persona («Mi inscripción») y cómo usarla.', 'The person\'s personal link to their badge («Mi inscripción») and how to use it.', 'O link pessoal para o crachá da pessoa («Mi inscripción») e como usá-lo.'),
        placeholders: [
            { key: 'name', label: L3('Nombre de la persona', 'Person\'s name', 'Nome da pessoa'), sample: L3('Ana', 'Ana', 'Ana') },
            { key: 'conference', label: L3('Conferencia', 'Conference', 'Conferência'), sample: L3('Asume el Riesgo', 'Asume el Riesgo', 'Asume el Riesgo') },
        ],
        subject: L3('Tu escarapela · {conference}', 'Your badge · {conference}', 'Seu crachá · {conference}'),
        body: L3('Hola {name}:\n\nEsta es tu escarapela de «{conference}». Ábrela desde tu celular:', 'Hello {name},\n\nThis is your badge for «{conference}». Open it on your phone:', 'Olá, {name}:\n\nEste é o seu crachá de «{conference}». Abra-o no seu celular:'),
        after: L3(
            '**Cómo usarla**\n- Ábrela con el botón (o el enlace). La primera vez te pide tu documento: así nadie más la ve.\n- Guárdala en la pantalla de inicio: en iPhone, en Safari toca Compartir › «Agregar a inicio»; en Android, en Chrome toca el menú ⋮ › «Agregar a la pantalla principal».\n- Activa los avisos en la página: te llegan cuando llamen a tu grupo a comer y cuando salga tu bus.\n\n**El enlace es personal: no lo compartas con nadie.**\n\nSi no esperabas este correo, ignóralo.',
            '**How to use it**\n- Open it with the button (or the link). The first time it asks for your ID document, so nobody else can see it.\n- Keep it on your home screen: on an iPhone, in Safari tap Share › «Add to Home Screen»; on Android, in Chrome tap the ⋮ menu › «Add to Home screen».\n- Turn the notices on in the page: you get one when your group is called to eat and when your bus leaves.\n\n**The link is personal: do not share it with anyone.**\n\nIf you did not expect this e-mail, ignore it.',
            '**Como usar**\n- Abra-o com o botão (ou o link). Na primeira vez ele pede o seu documento: assim ninguém mais o vê.\n- Guarde-o na tela inicial: no iPhone, no Safari toque em Compartilhar › «Adicionar à Tela de Início»; no Android, no Chrome toque no menu ⋮ › «Adicionar à tela inicial».\n- Ative os avisos na página: você recebe um quando chamarem o seu grupo para comer e quando o seu ônibus sair.\n\n**O link é pessoal: não o compartilhe com ninguém.**\n\nSe você não esperava este e-mail, ignore-o.'),
        action: L3('Abrir mi escarapela', 'Open my badge', 'Abrir meu crachá'),
    },
    {
        id: 'location.welcome', block: 'action',
        name: L3('Bienvenida al encargado de la localidad', 'Welcome to the locality\'s coordinator', 'Boas-vindas ao responsável da localidade'),
        description: L3('Al correo del encargado de una localidad: qué es el portal y cómo entrar. Nunca lleva el código de acceso: pídeselo a la administración.', 'To a locality\'s coordinator: what the portal is and how to get in. It never carries the access code: they ask the administration for it.', 'Para o responsável de uma localidade: o que é o portal e como entrar. Nunca leva o código de acesso: peça-o à administração.'),
        placeholders: [
            { key: 'location', label: L3('Localidad', 'Locality', 'Localidade'), sample: L3('Norte', 'Norte', 'Norte') },
            { key: 'conference', label: L3('Conferencia', 'Conference', 'Conferência'), sample: L3('Asume el Riesgo', 'Asume el Riesgo', 'Asume el Riesgo') },
            { key: 'admin_contact', label: L3('Contacto de la administración', 'Administration contact', 'Contato da administração'), sample: L3('datos@ejemplo.org', 'data@example.org', 'dados@exemplo.org') },
        ],
        subject: L3('Eres el encargado de {location} · {conference}', 'You coordinate {location} · {conference}', 'Você é o responsável por {location} · {conference}'),
        body: L3(
            'Hola:\n\nTe registraron como encargado de la localidad **{location}** en «{conference}». Desde el portal de localidades inscribes a las personas de tu localidad, sigues sus pagos y organizas su hospedaje.\n\nPara entrar necesitas el **código de acceso** de tu localidad. Por seguridad no lo enviamos por correo: pídeselo a la administración.',
            'Hello,\n\nYou were registered as the coordinator of **{location}** for «{conference}». In the localities portal you register your locality\'s people, follow their payments and arrange their lodging.\n\nTo get in you need your locality\'s **access code**. For security it is never sent by e-mail: ask the administration for it.',
            'Olá:\n\nVocê foi registrado como responsável pela localidade **{location}** em «{conference}». No portal de localidades você inscreve as pessoas da sua localidade, acompanha os pagamentos e organiza a hospedagem.\n\nPara entrar você precisa do **código de acesso** da sua localidade. Por segurança ele não é enviado por e-mail: peça-o à administração.'),
        after: L3(
            'Contacto de la administración: {admin_contact}\n\nSi no esperabas este correo, ignóralo.',
            'Administration contact: {admin_contact}\n\nIf you did not expect this e-mail, ignore it.',
            'Contato da administração: {admin_contact}\n\nSe você não esperava este e-mail, ignore-o.'),
        action: L3('Abrir el portal', 'Open the portal', 'Abrir o portal'),
    },
];
const DEF = new Map(DEFS.map(d => [d.id, d]));

/** The layout's own words (not editable): the copy-this-address line, the footer, the record's labels. */
const LAYOUT = {
    es: { copy: 'Si el botón no funciona, copia esta dirección en tu navegador:', sent: (s) => `Enviado por ${s}.`, yes: 'Sí', no: 'No', signed: 'Texto que aceptaste', policy: 'Política',
        rows: { person: 'Persona inscrita', rep: 'Representante legal', general: 'Tratamiento de datos personales', health: 'Datos sensibles de salud', image: 'Uso de imagen', policy: 'Política', version: (v) => `versión ${v}`, policySha: 'Huella de la versión de la política (SHA-256)', when: 'Fecha y hora (UTC)', textSha: 'Huella del texto aceptado (SHA-256)' } },
    en: { copy: 'If the button does not work, copy this address into your browser:', sent: (s) => `Sent by ${s}.`, yes: 'Yes', no: 'No', signed: 'The text you accepted', policy: 'Policy',
        rows: { person: 'Registered person', rep: 'Legal guardian', general: 'Processing of personal data', health: 'Sensitive health data', image: 'Use of image', policy: 'Policy', version: (v) => `version ${v}`, policySha: 'Fingerprint of the policy version (SHA-256)', when: 'Date and time (UTC)', textSha: 'Fingerprint of the accepted text (SHA-256)' } },
    pt: { copy: 'Se o botão não funcionar, copie este endereço no seu navegador:', sent: (s) => `Enviado por ${s}.`, yes: 'Sim', no: 'Não', signed: 'Texto que você aceitou', policy: 'Política',
        rows: { person: 'Pessoa inscrita', rep: 'Representante legal', general: 'Tratamento de dados pessoais', health: 'Dados sensíveis de saúde', image: 'Uso de imagem', policy: 'Política', version: (v) => `versão ${v}`, policySha: 'Impressão digital da versão da política (SHA-256)', when: 'Data e hora (UTC)', textSha: 'Impressão digital do texto aceito (SHA-256)' } },
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Control characters never reach a text (the placeholder marker below uses one).
const clean = (s, max) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
const MARK = '\u0001';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const ACCENT = '#2563eb';

/**
 * Read a text into blocks — paragraphs (lines kept as line breaks) and lists — with each placeholder replaced by a
 * marker (its index). A line whose placeholders are ALL empty is left out. Pure: no HTML is involved yet.
 */
function parse(src, values) {
    const vals = [];
    const lines = [];
    for (const raw of clean(src, 10000).split('\n')) {
        let used = 0, filled = 0;
        const line = raw.replace(/\{([a-z_]{1,40})\}/g, (m, key) => {
            if (!Object.prototype.hasOwnProperty.call(values, key)) return m; // not a placeholder of this message: text
            used++;
            const v = String(values[key] == null ? '' : values[key]).replace(/\s+/g, ' ').trim();
            if (v) filled++;
            vals.push(v);
            return `${MARK}${vals.length - 1}${MARK}`;
        });
        if (used && !filled) continue;
        lines.push(line);
    }
    const blocks = [];
    let cur = null;
    for (const line of lines) {
        if (!line.trim()) { cur = null; continue; }
        const item = /^\s*-\s+(.*)$/.exec(line);
        if (item) {
            if (!cur || cur.type !== 'list') { cur = { type: 'list', items: [] }; blocks.push(cur); }
            cur.items.push(item[1]);
        } else {
            if (!cur || cur.type !== 'p') { cur = { type: 'p', lines: [] }; blocks.push(cur); }
            cur.lines.push(line.trim());
        }
    }
    return { blocks, vals };
}
const LINK_RE = /\[([^\]\n]{1,200})\]\(((?:https?:\/\/|mailto:)[^\s()<>"']{1,500})\)/g;
/** One line of markup → HTML (escaped first; then **bold** and literal links; then the escaped values). */
function inlineHtml(s, vals) {
    let h = esc(s);
    h = h.replace(/\*\*([^*\n]{1,300})\*\*/g, '<strong>$1</strong>');
    h = h.replace(LINK_RE, (m, text, url) => (url.includes(MARK) ? m : `<a href="${url}" style="color:${ACCENT};text-decoration:underline">${text}</a>`));
    return h.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (m, i) => esc(vals[Number(i)] || ''));
}
/** The same line as plain text. */
function inlineText(s, vals) {
    let t = s.replace(/\*\*([^*\n]{1,300})\*\*/g, '$1');
    t = t.replace(LINK_RE, (m, text, url) => (url.includes(MARK) ? m : `${text} (${url})`));
    return t.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (m, i) => vals[Number(i)] || '');
}
const P_STYLE = `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:#1f2937`;
function textToHtml(src, values) {
    const { blocks, vals } = parse(src, values);
    return blocks.map(b => (b.type === 'p'
        ? `<p style="${P_STYLE}">${b.lines.map(l => inlineHtml(l, vals)).join('<br>')}</p>`
        : `<ul style="margin:0 0 16px;padding:0 0 0 22px;font-family:${FONT};font-size:15px;line-height:1.6;color:#1f2937">${b.items.map(i => `<li style="margin:0 0 6px">${inlineHtml(i, vals)}</li>`).join('')}</ul>`)).join('');
}
function textToPlain(src, values) {
    const { blocks, vals } = parse(src, values);
    return blocks.map(b => (b.type === 'p' ? b.lines.map(l => inlineText(l, vals)).join('\n') : b.items.map(i => `- ${inlineText(i, vals)}`).join('\n'))).join('\n\n');
}
/** A subject: one line, plain text, its placeholders filled. */
function subjectOf(src, values) {
    return clean(src, LIMITS.subject * 2).replace(/\s+/g, ' ').replace(/\{([a-z_]{1,40})\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k] == null ? '' : values[k]).replace(/\s+/g, ' ').trim() : m)).trim().slice(0, LIMITS.subject);
}

/** The part the system draws: the button, the code or the record — never text from the template. */
function blockHtml(def, lang, label, extras) {
    const W = LAYOUT[lang];
    if (def.block === 'action' && extras.action && extras.action.url) {
        const url = esc(extras.action.url);
        return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 20px"><tr><td class="cm-btn" style="border-radius:12px;background:${ACCENT}">`
            + `<a href="${url}" target="_blank" style="display:inline-block;padding:14px 26px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px">${esc(label)}</a>`
            + `</td></tr></table><p style="margin:0 0 20px;font-family:${FONT};font-size:13px;line-height:1.5;color:#6b7280">${esc(W.copy)}<br><a href="${url}" style="color:${ACCENT};word-break:break-all">${url}</a></p>`;
    }
    if (def.block === 'code' && extras.code) {
        return `<div style="margin:4px 0 20px;padding:18px;border-radius:12px;background:#eff6ff;border:1px solid #bfdbfe;text-align:center;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#1e3a8a">${esc(extras.code)}</div>`;
    }
    if (def.block === 'record' && extras.record) {
        const r = extras.record;
        return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:4px 0 20px;border-collapse:collapse;font-family:${FONT};font-size:14px">`
            + r.rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;border-bottom:1px solid #f3f4f6">${esc(k)}</td><td style="padding:6px 0;color:#111827;word-break:break-all;border-bottom:1px solid #f3f4f6">${esc(v)}</td></tr>`).join('')
            + `</table><p style="margin:0 0 8px;font-family:${FONT};font-size:14px;font-weight:700;color:#111827">${esc(W.signed)}</p>`
            + `<p style="margin:0 0 16px;padding:12px 14px;border-left:3px solid #e5e7eb;background:#f9fafb;white-space:pre-wrap;font-family:${FONT};font-size:13px;line-height:1.55;color:#374151">${esc(r.signed)}</p>`
            + (r.policyUrl ? `<p style="margin:0 0 16px;font-family:${FONT};font-size:14px;color:#374151">${esc(W.policy)}: <a href="${esc(r.policyUrl)}" style="color:${ACCENT}">${esc(r.policyUrl)}</a></p>` : '');
    }
    return '';
}
function blockText(def, lang, label, extras) {
    const W = LAYOUT[lang];
    if (def.block === 'action' && extras.action && extras.action.url) return `${label}: ${extras.action.url}`;
    if (def.block === 'code' && extras.code) return String(extras.code);
    if (def.block === 'record' && extras.record) {
        const r = extras.record;
        return `${r.rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${W.signed}:\n${r.signed}${r.policyUrl ? `\n\n${W.policy}: ${r.policyUrl}` : ''}`;
    }
    return '';
}
/** The record rows of the authorization copy (`ev` the «granted» row, `d` its data). */
function recordOf(lang, ev, d) {
    const W = LAYOUT[langOf(lang)];
    const R = W.rows;
    const yes = (v) => (v ? W.yes : W.no);
    return {
        rows: [
            [R.person, d.subject.name],
            ...(d.representative ? [[R.rep, `${d.representative.name} (${d.representative.relationship})`]] : []),
            [R.general, yes(ev.general)], [R.health, yes(ev.health)], [R.image, yes(ev.image)],
            [R.policy, `${R.version(d.policy.version)} · ${d.policy.url}`],
            ...(d.policy.sha256 ? [[R.policySha, d.policy.sha256]] : []),
            [R.when, ev.at_utc], [R.textSha, ev.text_sha256],
        ],
        signed: d.text, policyUrl: d.policy.url,
    };
}

/**
 * Render one message: { subject, html, text }. `edit` = the stored edit of this language (or a draft), null for
 * the defaults; `values` fill the placeholders (only this message's); `extras` = { action: { url }, code, record }
 * — what the layout draws; `brand` = { site, heading }.
 */
function renderMessage(id, lang, values, extras = {}, edit = null, brand = {}) {
    const def = DEF.get(id);
    if (!def) throw new Error(`unknown e-mail template ${id}`);
    const l = langOf(lang);
    const pick = (k) => (edit && typeof edit[k] === 'string' && edit[k].trim() ? edit[k] : def[k] ? def[k][l] : '');
    const keys = new Set(def.placeholders.map(p => p.key));
    const vals = Object.fromEntries([...keys].map(k => [k, values && values[k] != null ? values[k] : '']));
    // {code} fills the subject of the code message only; its texts never receive it (the layout draws the code).
    const textVals = Object.fromEntries(Object.entries(vals).filter(([k]) => !def.placeholders.find(p => p.key === k && p.subjectOnly)));
    const subject = subjectOf(pick('subject'), vals);
    const label = clean(pick('action'), LIMITS.action).trim() || (def.action ? def.action[l] : '');
    const before = pick('body'), after = pick('after');
    const W = LAYOUT[l];
    const site = String(brand.site || '').trim();
    const heading = String(brand.heading || values.conference || site || '').trim();
    const preheader = textToPlain(before, textVals).replace(/\s+/g, ' ').slice(0, 140);
    const inner = textToHtml(before, textVals) + blockHtml(def, l, label, extras) + textToHtml(after, textVals);
    const html = '<!doctype html><html lang="' + l + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">'
        + `<title>${esc(subject)}</title><style>@media (max-width:600px){.cm-card{padding:26px 20px!important}.cm-outer{padding:12px 8px!important}.cm-btn a{display:block!important;text-align:center!important}}</style></head>`
        + '<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%">'
        + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>`
        + '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f4f6"><tr><td class="cm-outer" align="center" style="padding:28px 12px">'
        + '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">'
        + (heading ? `<tr><td style="padding:0 6px 14px;font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">${esc(heading)}</td></tr>` : '')
        + `<tr><td class="cm-card" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;padding:34px 38px;border-top:4px solid ${ACCENT}">${inner}</td></tr>`
        + (site ? `<tr><td style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:#9ca3af;text-align:center">${esc(W.sent(site))}</td></tr>` : '')
        + '</table></td></tr></table></body></html>';
    const text = [textToPlain(before, textVals), blockText(def, l, label, extras), textToPlain(after, textVals), site ? W.sent(site) : '']
        .filter(s => s && s.trim()).join('\n\n');
    return { subject, html, text, lang: l };
}

/** The samples a preview and a test message use (and a sample link, code or record). */
function samplesOf(id, lang, base = 'https://example.org') {
    const def = DEF.get(id);
    const l = langOf(lang);
    const values = Object.fromEntries(def.placeholders.map(p => [p.key, p.sample[l]]));
    const extras = def.block === 'action' ? { action: { url: `${String(base).replace(/\/+$/, '')}/portal/conference` } }
        : def.block === 'code' ? { code: values.code || '482913' }
        : { record: recordOf(l, { general: 1, health: 1, image: 0, at_utc: '2030-01-10T15:04:05.000Z', text_sha256: 'a1b2c3…' },
            { subject: { name: values.name || 'Ana Pérez' }, representative: null, policy: { version: '1.0', url: `${base}/politica-de-datos`, sha256: 'd4e5f6…' }, text: 'Autorizo a …' }) };
    return { values, extras };
}

/** A draft or stored edit, checked: { subject, body, after, action } trimmed to the limits, or an error message. */
function cleanEdit(b) {
    const out = {
        subject: clean(b && b.subject, LIMITS.subject + 1).replace(/\s+/g, ' ').trim(),
        body: clean(b && b.body, LIMITS.body + 1),
        after: clean(b && b.after, LIMITS.after + 1),
        action: clean(b && b.action, LIMITS.action + 1).replace(/\s+/g, ' ').trim(),
    };
    if (!out.subject) return { error: 'Escribe el asunto.', field: 'subject' };
    if (out.subject.length > LIMITS.subject) return { error: `El asunto es demasiado largo (máximo ${LIMITS.subject} caracteres).`, field: 'subject' };
    if (!out.body.trim()) return { error: 'Escribe el texto del correo.', field: 'body' };
    if (out.body.length > LIMITS.body) return { error: `El texto es demasiado largo (máximo ${LIMITS.body} caracteres).`, field: 'body' };
    if (out.after.length > LIMITS.after) return { error: `El texto final es demasiado largo (máximo ${LIMITS.after} caracteres).`, field: 'after' };
    if (out.action.length > LIMITS.action) return { error: `El texto del botón es demasiado largo (máximo ${LIMITS.action} caracteres).`, field: 'action' };
    return { edit: out };
}

function createMailTemplates(base) {
    const { db, T, P, createUniqueIndex } = base;
    T.mailTemplates = `${P}mail_templates`;
    let D = null;

    async function migrate() {
        await db.createTable(T.mailTemplates, [
            'id INT_PK',
            'template_id VARCHAR(40) NOT NULL',
            'lang VARCHAR(4) NOT NULL',
            'subject TEXT',
            'body TEXT',
            'after_text TEXT',
            'action_label TEXT',
            'updated_s INT',
            'updated_by VARCHAR(120)',
        ]);
        await createUniqueIndex(`${P}uidx_mail_templates`, T.mailTemplates, 'template_id, lang');
    }
    async function editOf(id, lang) {
        const r = await db.get(`SELECT subject, body, after_text, action_label FROM ${T.mailTemplates} WHERE template_id = ? AND lang = ?`, [id, langOf(lang)]);
        return r ? { subject: r.subject || '', body: r.body || '', after: r.after_text || '', action: r.action_label || '' } : null;
    }
    /** The message as it goes out: the stored edit of its language (else the default), the site's name. */
    async function render(id, lang, values, extras = {}) {
        let edit = null;
        try { edit = await editOf(id, lang); } catch { /* the table is not there yet: the default */ }
        const site = D && D.siteName ? await D.siteName().catch(() => '') : '';
        return renderMessage(id, lang, values, extras, edit, { site });
    }

    // Test messages: a few per administrator (in memory; the process restarting resets it, which is harmless).
    const tests = new Map();
    const testAllowed = (who) => {
        const now = Date.now();
        const list = (tests.get(who) || []).filter(t => now - t < 10 * 60 * 1000);
        if (list.length >= 5) return false;
        list.push(now);
        tests.set(who, list);
        return true;
    };

    function install(deps) {
        D = deps;
        const { http, sendError, httpError, actorOf } = deps;
        const defOr404 = (req, res) => {
            const def = DEF.get(String(req.params.id || ''));
            if (!def) { res.status(404).json({ error: 'Plantilla no encontrada.' }); return null; }
            return def;
        };
        const draftOf = (b) => {
            const c = cleanEdit(b || {});
            if (c.error) { const e = httpError(400, c.error); e.field = c.field; throw e; }
            return c.edit;
        };
        // GET /mail-templates → every message: its words, placeholders, defaults and edits (WordJS administrators).
        http.route('get', '/mail-templates', { auth: true, admin: true }, async (req, res) => {
            try {
                const rows = await db.all(`SELECT template_id, lang, subject, body, after_text, action_label, updated_s, updated_by FROM ${T.mailTemplates}`);
                res.json({
                    langs: LANGS, limits: LIMITS,
                    templates: DEFS.map(d => ({
                        id: d.id, block: d.block, name: d.name, description: d.description, has_action: !!d.action,
                        placeholders: d.placeholders.map(p => ({ key: p.key, label: p.label, sample: p.sample, subject_only: !!p.subjectOnly })),
                        defaults: Object.fromEntries(LANGS.map(l => [l, { subject: d.subject[l], body: d.body[l], after: d.after ? d.after[l] : '', action: d.action ? d.action[l] : '' }])),
                        edits: Object.fromEntries(rows.filter(r => r.template_id === d.id).map(r => [r.lang, { subject: r.subject || '', body: r.body || '', after: r.after_text || '', action: r.action_label || '', updated_at: r.updated_s ? new Date(Number(r.updated_s) * 1000).toISOString() : null, updated_by: r.updated_by || null }])),
                    })),
                });
            } catch (e) { sendError(res, e); }
        });
        // POST /mail-templates/:id/save { lang, subject, body, after, action } → the edit of that language.
        // (The four actions — save, restore, preview, test — share one route: index.js ROUTE_GROUPS.)
        http.route('post', '/mail-templates/:id/save', { auth: true, admin: true }, async (req, res) => {
            const def = defOr404(req, res);
            if (!def) return;
            try {
                const b = req.body || {};
                const lang = LANGS.includes(b.lang) ? b.lang : null;
                if (!lang) return res.status(400).json({ error: 'Idioma inválido (es, en o pt).', field: 'lang' });
                const e = draftOf(b);
                const vals = [e.subject, e.body, e.after, def.action ? e.action : '', Math.floor(Date.now() / 1000), actorOf(req) ? String(actorOf(req)).slice(0, 120) : null];
                const r = await db.run(`UPDATE ${T.mailTemplates} SET subject = ?, body = ?, after_text = ?, action_label = ?, updated_s = ?, updated_by = ? WHERE template_id = ? AND lang = ?`, [...vals, def.id, lang]);
                if (!(r && r.changes)) {
                    try { await db.run(`INSERT INTO ${T.mailTemplates} (subject, body, after_text, action_label, updated_s, updated_by, template_id, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [...vals, def.id, lang]); }
                    catch { await db.run(`UPDATE ${T.mailTemplates} SET subject = ?, body = ?, after_text = ?, action_label = ?, updated_s = ?, updated_by = ? WHERE template_id = ? AND lang = ?`, [...vals, def.id, lang]); }
                }
                res.json({ success: true });
            } catch (e) { sendError(res, e); }
        });
        // POST /mail-templates/:id/restore { lang } → «Restaurar original» (the default again).
        http.route('post', '/mail-templates/:id/restore', { auth: true, admin: true }, async (req, res) => {
            const def = defOr404(req, res);
            if (!def) return;
            try {
                const raw = String((req.body && req.body.lang) || '');
                const lang = LANGS.includes(raw) ? raw : null;
                if (!lang) return res.status(400).json({ error: 'Idioma inválido (es, en o pt).', field: 'lang' });
                await db.run(`DELETE FROM ${T.mailTemplates} WHERE template_id = ? AND lang = ?`, [def.id, lang]);
                res.json({ success: true });
            } catch (e) { sendError(res, e); }
        });
        // POST /mail-templates/:id/preview { lang, subject, body, after, action } → the draft rendered with samples.
        http.route('post', '/mail-templates/:id/preview', { auth: true, admin: true }, async (req, res) => {
            const def = defOr404(req, res);
            if (!def) return;
            try {
                const b = req.body || {};
                const lang = langOf(b.lang);
                const draft = draftOf(b);
                const { values, extras } = samplesOf(def.id, lang, await D.siteLinkBase().catch(() => '') || 'https://example.org');
                const site = D.siteName ? await D.siteName().catch(() => '') : '';
                res.json(renderMessage(def.id, lang, values, extras, draft, { site }));
            } catch (e) { sendError(res, e); }
        });
        // POST /mail-templates/:id/test { lang, …draft } → the draft, with samples, to the administrator's own e-mail.
        http.route('post', '/mail-templates/:id/test', { auth: true, admin: true }, async (req, res) => {
            const def = defOr404(req, res);
            if (!def) return;
            try {
                const to = req.user && (req.user.userEmail || req.user.user_email);
                if (!to) return res.status(409).json({ error: 'Tu cuenta no tiene correo: no hay a dónde enviar la prueba.' });
                if (!testAllowed(String(actorOf(req) || to))) return res.status(429).json({ error: 'Enviaste varias pruebas seguidas. Espera unos minutos.' });
                const b = req.body || {};
                const lang = langOf(b.lang);
                const draft = draftOf(b);
                const { values, extras } = samplesOf(def.id, lang, await D.siteLinkBase().catch(() => '') || 'https://example.org');
                const site = D.siteName ? await D.siteName().catch(() => '') : '';
                const m = renderMessage(def.id, lang, values, extras, draft, { site });
                try { await D.mail({ to, subject: `[Prueba] ${m.subject}`, text: m.text, html: m.html }); }
                catch (e) { return res.status(502).json({ error: 'No se pudo enviar la prueba: revisa el correo del sitio.' }); }
                res.json({ success: true, sent: true, to_masked: String(to).replace(/^(.).*(@.).*(\..*)$/, '$1***$2***$3') });
            } catch (e) { sendError(res, e); }
        });
    }

    return { migrate, install, render, editOf };
}

module.exports = { createMailTemplates, renderMessage, recordOf, samplesOf, cleanEdit, textToHtml, textToPlain, langOf, DEFS, LANGS, LIMITS };

/**
 * WordJS — EMAIL TEMPLATES: every message the core sends, editable from Settings → Emails, wrapped in one
 * HTML layout.
 *
 * THE REGISTRY. Each message has an id (`account.password_reset`), a default subject, body and button label
 * per language (en / es / pt), and the placeholders its body may use (`{site_name}`, `{user_name}` …).
 * An administrator's edits are stored per message and language in the option `email_templates`; a
 * language with no edit uses the default. Plugins can add their own messages to the same registry
 * (registerEmailTemplate, with `source` set to the plugin folder) and render them through the same layout.
 *
 * WHAT AN ADMINISTRATOR CAN NEVER EDIT. The parts of a message that carry authority are not text in the
 * template: the action link (a reset or verification URL, which holds a single-use token) is handed to
 * render() by the sender as `action.url`, and the layout draws it as the button and, again, as the
 * copy-this-address line under it. No placeholder ever holds that URL, so an edited body cannot drop the
 * link, point it elsewhere or copy the token into the subject or another field. A template that declares
 * an action ALWAYS gets the button: the body is the text around it.
 *
 * SAFETY. Stored bodies are sanitized on save with a small allowlist suited to mail (paragraphs, emphasis,
 * lists, quotes, headings and http/https/mailto links). Placeholder values are escaped before they are put
 * into the body, and the body is sanitized again after substitution, so a value can never become markup
 * (an anonymous registrant chooses `{user_name}`). Subjects are plain text on one line.
 *
 * THE TEXT PART is generated from the same rendered body by an HTML parser (never a pattern over HTML), so
 * the two alternatives always say the same thing.
 */

const sanitizeHtml = require('sanitize-html');
const { Parser } = require('htmlparser2');
const { escHtml } = require('./formatting');

export type EmailLang = 'en' | 'es' | 'pt';
export const EMAIL_LANGS: EmailLang[] = ['en', 'es', 'pt'];

type Localized = Record<EmailLang, string>;

export interface EmailPlaceholder {
    key: string;
    label: Localized;
    /** The value the preview and the test message use. */
    sample: Localized;
}

export interface EmailTemplateDef {
    id: string;
    /** Settings → Emails groups messages by this. */
    group: 'account' | 'site' | 'comments' | 'plugin';
    name: Localized;
    description: Localized;
    /** Messages about sign-in and the site's integrity: editing them needs a recent password (sudo). */
    security: boolean;
    /** Which transport carries it: account mail (core/account-mail) or the site's mail provider. */
    transport: 'account' | 'site';
    placeholders: EmailPlaceholder[];
    /** The button the system draws with the sender's URL; absent = the message has no link. */
    action?: { label: Localized };
    /** The body may hold no link at all (a message a phishing attempt would copy): links are unwrapped. */
    noLinks?: boolean;
    subject: Localized;
    body: Localized;
    /** The plugin folder that registered it; core messages have none. */
    source?: string;
}

export interface TemplateEdit { subject?: string; body?: string; actionLabel?: string }
type Overrides = Record<string, Partial<Record<EmailLang, TemplateEdit>>>;

export interface EmailLayout {
    /** Button and accent colour (#rrggbb); '' = the theme's primary colour. */
    accentColor: string;
    /** Page background behind the card (#rrggbb); '' = the default. */
    backgroundColor: string;
    /** Show the site logo in the header (falls back to the site name). */
    showLogo: boolean;
    /** One line under the site address in the footer (plain text). */
    footerText: string;
}

export interface RenderedEmail { subject: string; html: string; text: string; lang: EmailLang }

class EmailTemplateError extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 400, code = 'rest_invalid_param') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const TEMPLATES_OPTION = 'email_templates';
const LAYOUT_OPTION = 'email_layout';
const MAX_SUBJECT = 200;
const MAX_BODY = 20_000;
const MAX_LABEL = 80;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}(?:\.[a-z0-9][a-z0-9_-]{0,63}){1,3}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const DEFAULT_ACCENT = '#2563eb';
const DEFAULT_BACKGROUND = '#f4f5f7';

function L(en: string, es: string, pt: string): Localized { return { en, es, pt }; }

const P = {
    site_name: { key: 'site_name', label: L('Site name', 'Nombre del sitio', 'Nome do site'), sample: L('My site', 'Mi sitio', 'Meu site') },
    user_name: { key: 'user_name', label: L('Username', 'Nombre de usuario', 'Nome de usuário'), sample: L('jane', 'ana', 'ana') },
    expires: { key: 'expires', label: L('Link lifetime', 'Validez del enlace', 'Validade do link'), sample: L('30 minutes', '30 minutos', '30 minutos') },
    change: { key: 'change', label: L('What changed', 'Qué cambió', 'O que mudou'), sample: L('Main address changed to www.example.com by admin (Settings → Site address).', 'Dirección principal cambiada a www.example.com por admin (Ajustes → Dirección del sitio).', 'Endereço principal alterado para www.example.com por admin (Configurações → Endereço do site).') },
    post_title: { key: 'post_title', label: L('Entry title', 'Título de la entrada', 'Título do post'), sample: L('Hello world', 'Hola mundo', 'Olá mundo') },
    comment_author: { key: 'comment_author', label: L('Commenter', 'Autor del comentario', 'Autor do comentário'), sample: L('Alex', 'Alex', 'Alex') },
    comment_excerpt: { key: 'comment_excerpt', label: L('Comment text', 'Texto del comentario', 'Texto do comentário'), sample: L('Great post, thanks!', '¡Muy buena entrada, gracias!', 'Ótimo post, obrigado!') },
} as const;

/** The core's messages. Their defaults say what the hard-coded messages said before Settings → Emails. */
const CORE_TEMPLATES: EmailTemplateDef[] = [
    {
        id: 'account.verify_email', group: 'account', security: true, transport: 'account',
        name: L('Email verification', 'Verificación de correo', 'Verificação de e-mail'),
        description: L('Sent to someone who signs up, with the link that creates the account.', 'Se envía a quien se registra, con el enlace que crea la cuenta.', 'Enviado a quem se cadastra, com o link que cria a conta.'),
        placeholders: [P.site_name, P.user_name, P.expires],
        action: { label: L('Verify your email', 'Verificar tu correo', 'Verificar seu e-mail') },
        subject: L('Verify your email for {site_name}', 'Verifica tu correo para {site_name}', 'Verifique seu e-mail para {site_name}'),
        body: L(
            '<p>Welcome to <strong>{site_name}</strong>! Please confirm this email address to create your account (<strong>{user_name}</strong>).</p><p>The link is valid for {expires}.</p><p>If you did not ask for this account, you can safely ignore this email: nothing is created until the link is followed.</p>',
            '<p>¡Te damos la bienvenida a <strong>{site_name}</strong>! Confirma esta dirección de correo para crear tu cuenta (<strong>{user_name}</strong>).</p><p>El enlace es válido durante {expires}.</p><p>Si no pediste esta cuenta, puedes ignorar este correo: no se crea nada hasta que se sigue el enlace.</p>',
            '<p>Boas-vindas a <strong>{site_name}</strong>! Confirme este endereço de e-mail para criar sua conta (<strong>{user_name}</strong>).</p><p>O link é válido por {expires}.</p><p>Se você não pediu esta conta, pode ignorar este e-mail: nada é criado até que o link seja seguido.</p>'),
    },
    {
        id: 'account.signup_attempt', group: 'account', security: true, transport: 'account',
        name: L('Sign-up with an existing address', 'Registro con una dirección existente', 'Cadastro com um endereço existente'),
        description: L('Sent to the owner of an address when someone tries to create a second account with it.', 'Se envía al dueño de una dirección cuando alguien intenta crear otra cuenta con ella.', 'Enviado ao dono de um endereço quando alguém tenta criar outra conta com ele.'),
        placeholders: [P.site_name],
        subject: L('Sign-up attempt on {site_name}', 'Intento de registro en {site_name}', 'Tentativa de cadastro em {site_name}'),
        body: L(
            '<p>Someone tried to create a new {site_name} account with this email address. It already has an account, so nothing was created.</p><p>If this was you, sign in instead, or use "Forgot password" if you no longer know your password. If it was not you, you can ignore this message.</p>',
            '<p>Alguien intentó crear una cuenta nueva en {site_name} con esta dirección de correo. Ya tiene una cuenta, así que no se creó nada.</p><p>Si fuiste tú, inicia sesión, o usa «¿Olvidaste tu contraseña?» si ya no la recuerdas. Si no fuiste tú, puedes ignorar este mensaje.</p>',
            '<p>Alguém tentou criar uma nova conta em {site_name} com este endereço de e-mail. Ele já tem uma conta, então nada foi criado.</p><p>Se foi você, entre na sua conta, ou use "Esqueci a senha" se não lembra mais da sua senha. Se não foi você, pode ignorar esta mensagem.</p>'),
    },
    {
        id: 'account.password_reset', group: 'account', security: true, transport: 'account',
        name: L('Password reset', 'Restablecer contraseña', 'Redefinição de senha'),
        description: L('Sent when someone asks to reset a password, with the single-use reset link.', 'Se envía cuando alguien pide restablecer una contraseña, con el enlace de un solo uso.', 'Enviado quando alguém pede para redefinir uma senha, com o link de uso único.'),
        placeholders: [P.site_name, P.user_name, P.expires],
        action: { label: L('Reset your password', 'Restablecer tu contraseña', 'Redefinir sua senha') },
        subject: L('Password reset for {site_name}', 'Restablecer la contraseña de {site_name}', 'Redefinição de senha de {site_name}'),
        body: L(
            '<p>Someone requested a password reset for your <strong>{site_name}</strong> account (<strong>{user_name}</strong>).</p><p>The link is valid for {expires}.</p><p>If you did not request this, you can safely ignore this email; your password will not change.</p>',
            '<p>Alguien pidió restablecer la contraseña de tu cuenta de <strong>{site_name}</strong> (<strong>{user_name}</strong>).</p><p>El enlace es válido durante {expires}.</p><p>Si no lo pediste, puedes ignorar este correo; tu contraseña no cambiará.</p>',
            '<p>Alguém pediu para redefinir a senha da sua conta em <strong>{site_name}</strong> (<strong>{user_name}</strong>).</p><p>O link é válido por {expires}.</p><p>Se você não pediu isso, pode ignorar este e-mail; sua senha não vai mudar.</p>'),
    },
    {
        id: 'account.mail_test', group: 'account', security: true, transport: 'account',
        name: L('Account email test', 'Prueba del correo de cuentas', 'Teste do e-mail de contas'),
        description: L('Sent by "Send a test" in Settings → Account email.', 'Lo envía «Enviar una prueba» en Ajustes → Correo de cuentas.', 'Enviado por "Enviar um teste" em Configurações → E-mail de contas.'),
        placeholders: [P.site_name],
        subject: L('{site_name}: account email test', '{site_name}: prueba del correo de cuentas', '{site_name}: teste do e-mail de contas'),
        body: L(
            '<p>This is a test from {site_name}. Password-reset and verification messages will be sent this way.</p>',
            '<p>Esta es una prueba de {site_name}. Los mensajes de restablecimiento de contraseña y de verificación se enviarán así.</p>',
            '<p>Este é um teste de {site_name}. As mensagens de redefinição de senha e de verificação serão enviadas assim.</p>'),
    },
    {
        id: 'site.address_changed', group: 'site', security: true, transport: 'site', noLinks: true,
        name: L('Site address changed', 'Dirección del sitio cambiada', 'Endereço do site alterado'),
        description: L('Sent to the administration address when the site\'s address changes. It never carries a link.', 'Se envía a la dirección de administración cuando cambia la dirección del sitio. Nunca lleva un enlace.', 'Enviado ao endereço de administração quando o endereço do site muda. Nunca leva um link.'),
        placeholders: [P.site_name, P.change],
        subject: L('{site_name}: site address changed', '{site_name}: la dirección del sitio cambió', '{site_name}: o endereço do site mudou'),
        body: L(
            '<p>{change}</p><p>If you did not expect this change, sign in to your site the way you usually do and review Settings → Site address. This message contains no links on purpose.</p>',
            '<p>{change}</p><p>Si no esperabas este cambio, inicia sesión en tu sitio como lo haces siempre y revisa Ajustes → Dirección del sitio. Este mensaje no contiene enlaces a propósito.</p>',
            '<p>{change}</p><p>Se você não esperava esta mudança, entre no seu site como sempre faz e revise Configurações → Endereço do site. Esta mensagem não contém links de propósito.</p>'),
    },
    {
        id: 'comments.moderation', group: 'comments', security: false, transport: 'site',
        name: L('Comment awaiting moderation', 'Comentario pendiente de moderación', 'Comentário aguardando moderação'),
        description: L('Sent to the administration address when a comment is held for moderation (Settings → Discussion).', 'Se envía a la dirección de administración cuando un comentario queda retenido (Ajustes → Comentarios).', 'Enviado ao endereço de administração quando um comentário fica retido (Configurações → Discussão).'),
        placeholders: [P.site_name, P.post_title, P.comment_author, P.comment_excerpt],
        action: { label: L('Review it in the admin', 'Revisarlo en el panel', 'Revisar no painel') },
        subject: L('[{site_name}] Please moderate: “{post_title}”', '[{site_name}] Por favor, modera: «{post_title}»', '[{site_name}] Modere, por favor: “{post_title}”'),
        body: L(
            '<p>A new comment by {comment_author} on “{post_title}” is waiting for your approval.</p><p><em>“{comment_excerpt}”</em></p>',
            '<p>Un comentario nuevo de {comment_author} en «{post_title}» está esperando tu aprobación.</p><p><em>“{comment_excerpt}”</em></p>',
            '<p>Um novo comentário de {comment_author} em “{post_title}” está aguardando sua aprovação.</p><p><em>“{comment_excerpt}”</em></p>'),
    },
    {
        id: 'comments.new', group: 'comments', security: false, transport: 'site',
        name: L('New comment on your entry', 'Nuevo comentario en tu entrada', 'Novo comentário no seu post'),
        description: L('Sent to an entry\'s author when a comment on it is approved (Settings → Discussion).', 'Se envía al autor de una entrada cuando se aprueba un comentario en ella (Ajustes → Comentarios).', 'Enviado ao autor de um post quando um comentário nele é aprovado (Configurações → Discussão).'),
        placeholders: [P.site_name, P.post_title, P.comment_author, P.comment_excerpt],
        action: { label: L('Review it in the admin', 'Revisarlo en el panel', 'Revisar no painel') },
        subject: L('[{site_name}] Comment: “{post_title}”', '[{site_name}] Comentario: «{post_title}»', '[{site_name}] Comentário: “{post_title}”'),
        body: L(
            '<p>{comment_author} commented on your entry “{post_title}”.</p><p><em>“{comment_excerpt}”</em></p>',
            '<p>{comment_author} comentó en tu entrada «{post_title}».</p><p><em>“{comment_excerpt}”</em></p>',
            '<p>{comment_author} comentou no seu post “{post_title}”.</p><p><em>“{comment_excerpt}”</em></p>'),
    },
];

/** Words the layout itself writes (not editable: they sit next to the system's link). */
const LAYOUT_TEXT = {
    copyLink: L('If the button does not work, copy this address into your browser:', 'Si el botón no funciona, copia esta dirección en tu navegador:', 'Se o botão não funcionar, copie este endereço no seu navegador:'),
    sentBy: L('This message was sent by {site_name}.', 'Este mensaje lo envió {site_name}.', 'Esta mensagem foi enviada por {site_name}.'),
};

const registry = new Map<string, EmailTemplateDef>();
for (const t of CORE_TEMPLATES) registry.set(t.id, t);

function opts() { return require('./options'); }

// ── Registry ────────────────────────────────────────────────────────────────────────────────────────────

function localized(v: any, field: string): Localized {
    const en = typeof v === 'string' ? v : v && typeof v.en === 'string' ? v.en : '';
    if (!en) throw new EmailTemplateError(`${field} needs at least an English text.`);
    const pick = (l: EmailLang) => (v && typeof v[l] === 'string' && v[l] ? v[l] : en);
    return { en, es: pick('es'), pt: pick('pt') };
}

/**
 * Add a message to the registry (a plugin's own message, `source` = its folder). Core ids cannot be
 * replaced, and a plugin's ids must start with its folder name (`newsletter.confirm`).
 */
function registerEmailTemplate(def: any, source?: string): EmailTemplateDef {
    const id = String(def && def.id || '');
    if (!ID_RE.test(id)) throw new EmailTemplateError('A template id is dotted lower-case words, like "myplugin.welcome".');
    const existing = registry.get(id);
    if (existing && !existing.source) throw new EmailTemplateError(`"${id}" is a core message and cannot be replaced.`, 409, 'email_template_exists');
    if (source) {
        if (!id.startsWith(`${source}.`)) throw new EmailTemplateError(`A plugin's template ids start with its folder: "${source}.…".`);
        if (existing && existing.source !== source) throw new EmailTemplateError(`"${id}" belongs to another plugin.`, 409, 'email_template_exists');
    }
    const placeholders: EmailPlaceholder[] = (Array.isArray(def.placeholders) ? def.placeholders : []).slice(0, 30).map((p: any) => {
        const key = String(p && p.key || '');
        if (!KEY_RE.test(key)) throw new EmailTemplateError(`Placeholder "${key}" must be lower-case letters, digits and underscores.`);
        return { key, label: localized(p.label || key, 'A placeholder label'), sample: localized(p.sample || key, 'A placeholder sample') };
    });
    if (!placeholders.some((p) => p.key === 'site_name')) placeholders.unshift(P.site_name);
    const t: EmailTemplateDef = {
        id,
        group: source ? 'plugin' : (['account', 'site', 'comments'].includes(def.group) ? def.group : 'site'),
        name: localized(def.name || id, 'The template name'),
        description: localized(def.description || ' ', 'The template description'),
        security: def.security === true,
        transport: def.transport === 'account' && !source ? 'account' : 'site',
        placeholders,
        action: def.action ? { label: localized(def.action.label, 'The button label') } : undefined,
        noLinks: def.noLinks === true,
        subject: localized(def.subject, 'The subject'),
        body: (() => {
            const b = localized(def.body, 'The body');
            const noLinks = def.noLinks === true;
            return { en: sanitizeBody(b.en, noLinks), es: sanitizeBody(b.es, noLinks), pt: sanitizeBody(b.pt, noLinks) };
        })(),
        source: source || undefined,
    };
    registry.set(id, t);
    return t;
}

/** Remove a plugin's templates (on deactivation). Core messages stay. */
function unregisterPluginTemplates(source: string): void {
    for (const [id, t] of registry) if (t.source === source) registry.delete(id);
}

function getTemplate(id: string): EmailTemplateDef {
    const t = registry.get(id);
    if (!t) throw new EmailTemplateError(`No email template "${id}".`, 404, 'email_template_not_found');
    return t;
}

function listTemplates(): EmailTemplateDef[] { return Array.from(registry.values()); }

// ── Sanitizing ──────────────────────────────────────────────────────────────────────────────────────────

const BODY_POLICY = {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'h2', 'h3', 'hr'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    // The editor writes <b>/<i>; mail clients render both, but one spelling keeps the layout's CSS simple.
    transformTags: { b: 'strong', i: 'em' },
};

const NO_LINKS_POLICY = { ...BODY_POLICY, allowedTags: BODY_POLICY.allowedTags.filter((t) => t !== 'a'), allowedAttributes: {} };

/** A body as it may be stored: the mail allowlist, nothing else (and no links where the message forbids them). */
function sanitizeBody(html: any, noLinks = false): string {
    const s = String(html == null ? '' : html);
    if (s.length > MAX_BODY) throw new EmailTemplateError(`The message is too long (at most ${MAX_BODY} characters).`);
    return sanitizeHtml(s, noLinks ? NO_LINKS_POLICY : BODY_POLICY).trim();
}

/** A subject or a button label: plain text on one line. */
function plainLine(v: any, max: number): string {
    return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

// ── Stored edits and the layout settings ────────────────────────────────────────────────────────────────

function parseJson(raw: unknown): any {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

async function readOverrides(): Promise<Overrides> {
    const v = parseJson(await opts().getOption(TEMPLATES_OPTION, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

async function readLayout(): Promise<EmailLayout> {
    const v = parseJson(await opts().getOption(LAYOUT_OPTION, '')) || {};
    return {
        accentColor: typeof v.accentColor === 'string' && HEX_RE.test(v.accentColor) ? v.accentColor : '',
        backgroundColor: typeof v.backgroundColor === 'string' && HEX_RE.test(v.backgroundColor) ? v.backgroundColor : '',
        showLogo: v.showLogo !== false,
        footerText: typeof v.footerText === 'string' ? plainLine(v.footerText, 200) : '',
    };
}

function validateLayout(input: any): EmailLayout {
    const color = (v: any, name: string) => {
        const s = String(v == null ? '' : v).trim();
        if (s && !HEX_RE.test(s)) throw new EmailTemplateError(`${name} must be a colour like #2563eb.`);
        return s.toLowerCase();
    };
    return {
        accentColor: color(input && input.accentColor, 'The button colour'),
        backgroundColor: color(input && input.backgroundColor, 'The background colour'),
        showLogo: !(input && input.showLogo === false),
        footerText: plainLine(input && input.footerText, 200),
    };
}

async function saveLayout(input: any): Promise<EmailLayout> {
    const layout = validateLayout(input || {});
    await opts().updateOption(LAYOUT_OPTION, JSON.stringify(layout));
    return layout;
}

function normalizeLang(v: any): EmailLang | null {
    const s = String(v || '').trim().toLowerCase().slice(0, 2);
    return (EMAIL_LANGS as string[]).includes(s) ? (s as EmailLang) : null;
}

/** The site's language (WPLANG, `es_ES` → es), or English. */
async function siteLang(): Promise<EmailLang> {
    try { return normalizeLang(await opts().getOption('WPLANG', 'en')) || 'en'; } catch { return 'en'; }
}

/**
 * The language of the person who asked for a message (sign-up, password reset): the admin-language cookie
 * the sign-in screens set, else the browser's first es/en/pt preference, else null (the site's language).
 * Only ever picks among the three languages, so the caller's header can choose nothing else.
 */
function langFromRequest(req: any): EmailLang | null {
    try {
        const cookie = normalizeLang(req && req.cookies && req.cookies['wordjs-lang']);
        if (cookie) return cookie;
        const header = String((req && req.headers && req.headers['accept-language']) || '').slice(0, 200);
        for (const part of header.split(',')) {
            const l = normalizeLang(part.split(';')[0]);
            if (l) return l;
        }
    } catch { /* the site's language */ }
    return null;
}

/** "30 minutes" / "24 hours" in a message's language. */
function durationText(ms: number, lang: EmailLang | null): string {
    const l: EmailLang = lang || 'en';
    const minutes = Math.round(ms / 60_000);
    const words = {
        en: { m: ['minute', 'minutes'], h: ['hour', 'hours'], d: ['day', 'days'] },
        es: { m: ['minuto', 'minutos'], h: ['hora', 'horas'], d: ['día', 'días'] },
        pt: { m: ['minuto', 'minutos'], h: ['hora', 'horas'], d: ['dia', 'dias'] },
    }[l];
    const say = (n: number, w: string[]) => `${n} ${n === 1 ? w[0] : w[1]}`;
    if (minutes < 120) return say(minutes, words.m);
    if (minutes < 48 * 60 && minutes % 60 === 0) return say(minutes / 60, words.h);
    if (minutes % (24 * 60) === 0) return say(minutes / (24 * 60), words.d);
    return say(Math.round(minutes / 60), words.h);
}

/**
 * Save an administrator's edit of one message in one language. Every field is validated against the
 * template: the subject is one plain line, the body passes the mail allowlist, and the button label is
 * only kept for a message that has a button.
 */
async function saveTemplate(id: string, lang: string, input: TemplateEdit): Promise<TemplateEdit> {
    const t = getTemplate(id);
    const l = normalizeLang(lang);
    if (!l || l !== String(lang)) throw new EmailTemplateError('The language must be en, es or pt.');
    const subject = plainLine(input && input.subject, MAX_SUBJECT);
    if (!subject) throw new EmailTemplateError('Write a subject.');
    const body = sanitizeBody(input && input.body, t.noLinks);
    if (!plainText(body).trim()) throw new EmailTemplateError('Write the message.');
    const edit: TemplateEdit = { subject, body };
    if (t.action) {
        const label = plainLine(input && input.actionLabel, MAX_LABEL);
        if (!label) throw new EmailTemplateError('Write the button text.');
        edit.actionLabel = label;
    }
    const all = await readOverrides();
    all[id] = { ...(all[id] || {}), [l]: edit };
    await opts().updateOption(TEMPLATES_OPTION, JSON.stringify(all));
    return edit;
}

/** Drop an edit (one language, or every language) so the default is used again. */
async function resetTemplate(id: string, lang?: string): Promise<void> {
    getTemplate(id);
    const l = lang ? normalizeLang(lang) : null;
    if (lang && (!l || l !== lang)) throw new EmailTemplateError('The language must be en, es or pt.');
    const all = await readOverrides();
    if (!all[id]) return;
    if (l) {
        delete all[id][l];
        if (!Object.keys(all[id]).length) delete all[id];
    } else {
        delete all[id];
    }
    await opts().updateOption(TEMPLATES_OPTION, JSON.stringify(all));
}

/** The text one message uses in one language: the administrator's edit, else the default. */
function effective(t: EmailTemplateDef, overrides: Overrides, lang: EmailLang): { subject: string; body: string; actionLabel: string; customized: boolean } {
    const edit = overrides[t.id] && overrides[t.id][lang];
    const subject = edit && typeof edit.subject === 'string' && edit.subject ? plainLine(edit.subject, MAX_SUBJECT) : t.subject[lang];
    // Stored edits were sanitized on save; they are sanitized again here, so a value written around the
    // admin screen (an import, a direct option write) is held to the same allowlist.
    const body = edit && typeof edit.body === 'string' && edit.body ? sanitizeBody(edit.body, t.noLinks) : t.body[lang];
    const actionLabel = t.action ? (edit && edit.actionLabel ? plainLine(edit.actionLabel, MAX_LABEL) : t.action.label[lang]) : '';
    return { subject, body, actionLabel, customized: !!edit };
}

/** Everything the admin screen shows for one message. */
async function describeTemplate(id: string) {
    const t = getTemplate(id);
    const overrides = await readOverrides();
    const langs: Record<string, any> = {};
    for (const l of EMAIL_LANGS) {
        const e = effective(t, overrides, l);
        langs[l] = { ...e, defaults: { subject: t.subject[l], body: t.body[l], actionLabel: t.action ? t.action.label[l] : '' } };
    }
    return { ...summary(t, overrides), languages: langs };
}

function summary(t: EmailTemplateDef, overrides: Overrides) {
    return {
        id: t.id,
        group: t.group,
        name: t.name,
        description: t.description,
        security: t.security,
        hasAction: !!t.action,
        noLinks: !!t.noLinks,
        source: t.source || null,
        placeholders: t.placeholders.map((p) => ({ key: p.key, label: p.label })),
        customized: EMAIL_LANGS.filter((l) => !!(overrides[t.id] && overrides[t.id][l])),
    };
}

async function listSummaries() {
    const overrides = await readOverrides();
    return listTemplates().map((t) => summary(t, overrides));
}

// ── Rendering ───────────────────────────────────────────────────────────────────────────────────────────

/** Put the declared placeholders' values into a string. Unknown `{words}` are left as they are. */
function substitute(s: string, values: Record<string, string>, escape: boolean): string {
    return s.replace(/\{([a-z][a-z0-9_]{0,39})\}/g, (whole, key) => {
        if (!Object.prototype.hasOwnProperty.call(values, key)) return whole;
        return escape ? escHtml(values[key]) : values[key];
    });
}

/**
 * The plain-text alternative of a body (already-sanitized HTML), read with an HTML parser: paragraphs and
 * headings become blank-line-separated blocks, list items get a dash, quotes a "> ", and a link keeps its
 * address after the words.
 */
function plainText(html: string): string {
    let out = '';
    const hrefs: string[] = [];
    const quote: number[] = [];
    let linkText = '';
    let inLink = false;
    const block = () => { if (out && !out.endsWith('\n\n')) out = out.replace(/[ \t]+$/, '') + (out.endsWith('\n') ? '\n' : '\n\n'); };
    const parser = new Parser({
        onopentag(name: string, attrs: Record<string, string>) {
            if (name === 'p' || name === 'h2' || name === 'h3' || name === 'ul' || name === 'ol') block();
            else if (name === 'blockquote') { block(); quote.push(1); out += '> '; }
            else if (name === 'li') { if (out && !out.endsWith('\n')) out += '\n'; out += '- '; }
            else if (name === 'br') out += quote.length ? '\n> ' : '\n';
            else if (name === 'hr') { block(); out += '----\n\n'; }
            else if (name === 'a') { inLink = true; linkText = ''; hrefs.push(attrs.href || ''); }
        },
        ontext(text: string) {
            const t = text.replace(/\s+/g, ' ');
            if (inLink) linkText += t;
            if (out.endsWith('\n') || out === '' || out.endsWith('> ') || out.endsWith('- ')) out += t.replace(/^ /, '');
            else out += t;
        },
        onclosetag(name: string) {
            if (name === 'a') {
                inLink = false;
                const href = hrefs.pop() || '';
                if (href && href !== linkText.trim() && !href.startsWith('mailto:')) out += ` (${href})`;
            } else if (name === 'p' || name === 'h2' || name === 'h3' || name === 'ul' || name === 'ol') block();
            else if (name === 'blockquote') { quote.pop(); block(); }
        },
    }, { decodeEntities: true });
    parser.write(html);
    parser.end();
    return out.split('\n').map((line) => line.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The colours and identity the layout draws with. */
interface Brand { siteName: string; siteUrl: string; logoUrl: string; accent: string; background: string; footerText: string }

/** `hex` mixed toward white by `amount` (0..1): the accent made readable on a dark background. */
function lighten(hex: string, amount: number): string {
    const n = parseInt(hex.slice(1), 16);
    const mix = (c: number) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
    return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

/** Black or white text on a background, whichever reads better (WCAG relative luminance). */
function onColor(hex: string): string {
    const n = parseInt(hex.slice(1), 16);
    const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return lum > 0.4 ? '#111827' : '#ffffff';
}

/**
 * The site's primary colour: the customizer's `--wjs-color-primary` when it is a plain hex colour, else
 * the one the active theme's style.css declares in :root, else a neutral blue.
 */
async function themeAccent(): Promise<string> {
    const hex = (v: unknown) => {
        const s = String(v == null ? '' : v).trim().toLowerCase();
        if (HEX_RE.test(s)) return s;
        return /^#[0-9a-f]{3}$/.test(s) ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : '';
    };
    try {
        const themes = require('./themes');
        const snap = await themes.getActiveThemeSnapshot();
        const fromMods = hex(snap && snap.mods && snap.mods['--wjs-color-primary']);
        if (fromMods) return fromMods;
        const theme = await themes.getActiveTheme();
        if (theme && theme.path) {
            const css = await require('fs').promises.readFile(require('path').join(theme.path, 'style.css'), 'utf8');
            const declared = hex(require('./theme-verify').parseRootTokens(css).get('--wjs-color-primary'));
            if (declared) return declared;
        }
    } catch { /* the default */ }
    return DEFAULT_ACCENT;
}

/** The site logo (Settings → General stores its URL; a relative one is made absolute on the site's address). */
async function siteLogoUrl(base: string): Promise<string> {
    try {
        let url = String((await opts().getOption('site_logo', '')) || '').trim();
        if (!url) return '';
        if (url.startsWith('/') && !url.startsWith('//')) url = base + url;
        return /^https?:\/\//i.test(url) ? url : '';
    } catch {
        return '';
    }
}

async function brand(layoutOverride?: Partial<EmailLayout>): Promise<Brand> {
    const layout = { ...(await readLayout()), ...(layoutOverride ? validateLayout({ ...(await readLayout()), ...layoutOverride }) : {}) };
    const siteName = String((await opts().getOption('blogname', 'WordJS')) || 'WordJS');
    let siteUrl: string;
    try { siteUrl = String(await require('./site-address').linkBase()).replace(/\/+$/, ''); } catch { siteUrl = ''; }
    return {
        siteName,
        siteUrl,
        logoUrl: layout.showLogo ? await siteLogoUrl(siteUrl) : '',
        accent: layout.accentColor || await themeAccent(),
        background: layout.backgroundColor || DEFAULT_BACKGROUND,
        footerText: layout.footerText,
    };
}

/**
 * The full message: the layout around the body. Table-based with inline styles (what mail clients
 * render), a `color-scheme` declaration and a dark-mode block for the clients that read <style>.
 */
function layoutHtml(b: Brand, lang: EmailLang, subject: string, bodyHtml: string, action: { url: string; label: string } | null): string {
    const accent = b.accent;
    const onAccent = onColor(accent);
    const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const header = b.logoUrl
        ? `<img src="${escHtml(b.logoUrl)}" alt="${escHtml(b.siteName)}" height="40" style="display:block;height:40px;max-width:240px;border:0;outline:none;text-decoration:none">`
        : `<span class="wjs-title" style="font-family:${font};font-size:20px;font-weight:700;color:#111827">${escHtml(b.siteName)}</span>`;
    const styled = bodyHtml
        .split('<p>').join('<p style="margin:0 0 16px">')
        .split('<blockquote>').join(`<blockquote style="margin:0 0 16px;padding:8px 14px;border-left:3px solid ${accent};color:#374151;background:#f9fafb">`)
        .split('<h2>').join('<h2 style="margin:0 0 12px;font-size:20px;line-height:28px">')
        .split('<h3>').join('<h3 style="margin:0 0 10px;font-size:17px;line-height:24px">')
        .split('<ul>').join('<ul style="margin:0 0 16px;padding-left:22px">')
        .split('<ol>').join('<ol style="margin:0 0 16px;padding-left:22px">')
        .split('<a href=').join(`<a style="color:${accent}" href=`);
    const button = action
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr><td class="wjs-btn" bgcolor="${accent}" style="border-radius:8px;background:${accent}">`
            + `<a href="${escHtml(action.url)}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${font};font-size:16px;font-weight:600;line-height:20px;color:${onAccent};text-decoration:none;border-radius:8px">${escHtml(action.label)}</a>`
            + `</td></tr></table>`
            + `<p class="wjs-muted" style="margin:0 0 4px;font-size:13px;line-height:20px;color:#6b7280">${escHtml(LAYOUT_TEXT.copyLink[lang])}</p>`
            + `<p style="margin:0 0 8px;font-size:13px;line-height:20px;word-break:break-all"><a class="wjs-link" href="${escHtml(action.url)}" style="color:${accent}">${escHtml(action.url)}</a></p>`
        : '';
    const footer = [
        escHtml(substitute(LAYOUT_TEXT.sentBy[lang], { site_name: b.siteName }, false)),
        // The address is text, not a link: some messages (site address changed) must carry no link at all.
        b.siteUrl ? escHtml(b.siteUrl.replace(/^https?:\/\//, '')) : '',
        b.footerText ? escHtml(b.footerText) : '',
    ].filter(Boolean).join('<br>');
    return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escHtml(subject)}</title>
<style>
@media (prefers-color-scheme: dark) {
  body, .wjs-bg { background:#111318 !important; }
  .wjs-body p a, .wjs-body li a, .wjs-link { color:${lighten(accent, 0.45)} !important; }
  .wjs-card { background:#1c1f26 !important; border-color:#2d313a !important; }
  .wjs-body, .wjs-body p, .wjs-body li, .wjs-title { color:#e5e7eb !important; }
  .wjs-body blockquote { background:#252932 !important; color:#d1d5db !important; }
  .wjs-muted, .wjs-footer { color:#9ca3af !important; }
}
</style></head>
<body style="margin:0;padding:0;background:${b.background}">
<table role="presentation" class="wjs-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${b.background}" style="background:${b.background}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
<tr><td style="padding:0 8px 20px">${header}</td></tr>
<tr><td class="wjs-card" bgcolor="#ffffff" style="background:#ffffff;border:1px solid #e5e7eb;border-top:4px solid ${accent};border-radius:12px;padding:32px">
<div class="wjs-body" style="font-family:${font};font-size:16px;line-height:24px;color:#1f2937">${styled}${button}</div>
</td></tr>
<tr><td class="wjs-footer" style="padding:20px 8px;font-family:${font};font-size:12px;line-height:18px;color:#6b7280;text-align:center">${footer}</td></tr>
</table></td></tr></table>
</body></html>`;
}

export interface RenderOptions {
    lang?: string | null;
    /** The placeholders' values (escaped by the renderer). */
    values?: Record<string, unknown>;
    /** The system's link (reset / verify / review). Required for, and only used by, a template with a button. */
    actionUrl?: string;
    /** Render a draft instead of the stored text (the admin preview). Sanitized like a save. */
    draft?: TemplateEdit;
    /** Preview a layout change before it is saved. */
    layout?: Partial<EmailLayout>;
}

/** Render one message: subject, the full HTML and the plain-text alternative. */
async function renderEmail(id: string, options: RenderOptions = {}): Promise<RenderedEmail> {
    const t = getTemplate(id);
    const lang = normalizeLang(options.lang) || await siteLang();
    const b = await brand(options.layout);
    let { subject, body, actionLabel } = effective(t, await readOverrides(), lang);
    if (options.draft) {
        if (typeof options.draft.subject === 'string' && plainLine(options.draft.subject, MAX_SUBJECT)) subject = plainLine(options.draft.subject, MAX_SUBJECT);
        if (typeof options.draft.body === 'string') body = sanitizeBody(options.draft.body, t.noLinks);
        if (t.action && typeof options.draft.actionLabel === 'string' && plainLine(options.draft.actionLabel, MAX_LABEL)) actionLabel = plainLine(options.draft.actionLabel, MAX_LABEL);
    }

    // Only the template's declared placeholders, as strings; the site name always comes from the site.
    const values: Record<string, string> = {};
    for (const p of t.placeholders) {
        const v = options.values && options.values[p.key];
        values[p.key] = v == null ? '' : String(v).slice(0, 2000);
    }
    values.site_name = b.siteName;

    let action: { url: string; label: string } | null = null;
    if (t.action) {
        const url = String(options.actionUrl || '');
        if (!/^https?:\/\//i.test(url)) throw new EmailTemplateError(`"${id}" needs its link.`, 500, 'email_action_missing');
        action = { url, label: actionLabel };
    }

    const finalSubject = plainLine(substitute(subject, values, false), MAX_SUBJECT * 2);
    // Values are escaped into the sanitized body, then the result is sanitized again: an escaped value is
    // text, and nothing a value holds can turn into a tag or an attribute.
    const finalBody = sanitizeHtml(substitute(body, values, true), t.noLinks ? NO_LINKS_POLICY : BODY_POLICY).trim();
    const html = layoutHtml(b, lang, finalSubject, finalBody, action);

    const textParts = [plainText(finalBody)];
    if (action) textParts.push(`${action.label}:\n${action.url}`);
    textParts.push(['--', substitute(LAYOUT_TEXT.sentBy[lang], { site_name: b.siteName }, false), b.siteUrl.replace(/^https?:\/\//, ''), b.footerText].filter(Boolean).join('\n'));
    return { subject: finalSubject, html, text: textParts.filter(Boolean).join('\n\n'), lang };
}

/** The sample values a preview or a test message uses, in one language. */
function sampleValues(id: string, lang: EmailLang): Record<string, string> {
    const t = getTemplate(id);
    const out: Record<string, string> = {};
    for (const p of t.placeholders) out[p.key] = p.sample[lang];
    return out;
}

/** Render with sample values and a harmless sample link — the admin preview and "Send a test". */
async function renderSample(id: string, lang: string, draft?: TemplateEdit, layout?: Partial<EmailLayout>): Promise<RenderedEmail> {
    const t = getTemplate(id);
    const l = normalizeLang(lang) || await siteLang();
    let base: string;
    try { base = String(await require('./site-address').linkBase()).replace(/\/+$/, ''); } catch { base = ''; }
    return renderEmail(id, {
        lang: l,
        values: sampleValues(id, l),
        actionUrl: t.action ? `${/^https?:\/\//.test(base) ? base : 'https://example.com'}/` : undefined,
        draft,
        layout,
    });
}

/**
 * Render a message and hand it to its transport: account mail for sign-in messages (core/account-mail —
 * never a plugin an administrator did not allow), the site's mail provider for the others. Not waited
 * for and never throws: callers answer the same whatever the mail system does. Returns false when the
 * message could not even be rendered or no transport exists.
 */
async function sendTemplated(id: string, to: string, options: RenderOptions = {}): Promise<boolean> {
    const log = require('./module-logger').moduleLogger('core/email-templates');
    try {
        const t = getTemplate(id);
        const m = await renderEmail(id, options);
        const msg = { to, subject: m.subject, text: m.text, html: m.html };
        if (t.transport === 'account') {
            await require('./account-mail').handOffAccountMail(msg);
            return true;
        }
        const send = require('./mail-provider').sendMailFn();
        if (typeof send !== 'function') return false;
        Promise.resolve(send(msg)).catch((e: any) => log.warn({ code: e && e.code }, `[email] "${id}" was not sent`));
        return true;
    } catch (e: any) {
        log.warn({ code: e && e.code }, `[email] "${id}" was not sent`);
        return false;
    }
}

/** Send the sample of a message to `to` through its transport, WAITING for the answer (Settings → Emails). */
async function sendSample(id: string, lang: string, to: string, draft?: TemplateEdit): Promise<void> {
    const t = getTemplate(id);
    const m = await renderSample(id, lang, draft);
    const msg = { to, subject: m.subject, text: m.text, html: m.html };
    try {
        if (t.transport === 'account') {
            await require('./account-mail').sendAccountMail(msg);
            return;
        }
        const send = require('./mail-provider').sendMailFn();
        if (typeof send !== 'function') throw new EmailTemplateError('This site has no mail provider: install and set up a mail plugin first.', 409, 'email_no_provider');
        await send(msg);
    } catch (e: any) {
        if (e instanceof EmailTemplateError) throw e;
        if (e && e.code === 'account_mail_unavailable') throw new EmailTemplateError('Account email is not set up: configure it in Settings → Account email first.', 409, 'account_mail_unavailable');
        throw new EmailTemplateError(`The test was not sent: ${String(e && (e.response || e.message) || e).slice(0, 300)}`, 502, 'email_send_failed');
    }
}

async function getLayout(): Promise<EmailLayout & { themeAccent: string }> {
    return { ...(await readLayout()), themeAccent: await themeAccent() };
}

module.exports = {
    EMAIL_LANGS,
    TEMPLATES_OPTION,
    LAYOUT_OPTION,
    EmailTemplateError,
    registerEmailTemplate,
    unregisterPluginTemplates,
    getTemplate,
    listTemplates,
    listSummaries,
    describeTemplate,
    saveTemplate,
    resetTemplate,
    getLayout,
    saveLayout,
    renderEmail,
    renderSample,
    sendTemplated,
    sendSample,
    sanitizeBody,
    plainText,
    siteLang,
    normalizeLang,
    langFromRequest,
    durationText,
};

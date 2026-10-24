// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
/**
 * «Copiar mensaje» (conference-manager 2.33.2) — the consent request as a message staff paste into WhatsApp (or
 * any chat), next to «Enviar / Reenviar enlace». Pure helpers, no React: the text in the staff member's language
 * (plain text; WhatsApp shows *x* in bold), a wa.me link, and the clipboard write with its fallback signal.
 *
 * The link comes from POST /consent/share (admin) or /portal/consent/share (coordinators): a NEW single-use link,
 * logged «link_shared», with no e-mail sent. The signature is unchanged — the code still goes to the person's
 * e-mail, which the message says.
 */
import { consentT, type ConsentLang } from "./consentI18n";

export type ShareInfo = {
    link: string; first_name?: string; conference?: string; policy_version?: string; policy_url?: string;
    link_days?: number; email_masked?: string; phone?: string; phone_wa?: string;
};

/** The message, line by line: greeting, why, the personal link, the policy and how signing works. */
export function consentMessage(lang: ConsentLang | string, info: ShareInfo): string {
    const t = consentT(lang);
    const name = String(info.first_name || '').trim();
    return [
        name ? t('msg.hello', { name }) : t('msg.hello.anon'),
        '',
        t('msg.body', { conference: info.conference || '', version: info.policy_version || '' }),
        info.link,
        '',
        t('msg.policy', { version: info.policy_version || '', url: info.policy_url || '' }),
        '',
        info.email_masked ? t('msg.how', { email: info.email_masked, days: info.link_days ?? '' }) : t('msg.how.noemail', { days: info.link_days ?? '' }),
    ].join('\n');
}

/**
 * wa.me with the text, to `waDigits` — the number the server already put in international form (its stored
 * country code, or the conference's default for an older national number; server/phone.js). Without one,
 * WhatsApp asks who to send it to.
 */
export function whatsappUrl(text: string, waDigits?: string | null): string {
    const digits = String(waDigits || '').replace(/\D/g, '');
    return `https://wa.me/${/^\d{8,15}$/.test(digits) ? digits : ''}?text=${encodeURIComponent(text)}`;
}

/**
 * Copy (2.36.8: the plugin's one helper, lib/clipboard — the Clipboard API, else the iOS-proof textarea copy).
 * false when nothing was copied: show the text to copy by hand.
 */
export { copyText } from './clipboard';

// «Copiar mensaje» in another language (2.33.4): the dialog starts in the conference's e-mail language, or in the
// last language this staff member chose on this device.
const COPY_LANG_KEY = 'cm-copy-lang';
export const COPY_LANGS = ['es', 'en', 'pt'] as const;
export function copyLangOf(defaultLang?: string | null): string {
    try { const s = localStorage.getItem(COPY_LANG_KEY); if (s && (COPY_LANGS as readonly string[]).includes(s)) return s; } catch { /* private mode */ }
    return (COPY_LANGS as readonly string[]).includes(String(defaultLang || '')) ? String(defaultLang) : 'es';
}
export function rememberCopyLang(lang: string): void {
    try { localStorage.setItem(COPY_LANG_KEY, lang); } catch { /* private mode: this visit only */ }
}

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
    link_days?: number; email_masked?: string; phone?: string;
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
        t('msg.how', { email: info.email_masked || '', days: info.link_days ?? '' }),
    ].join('\n');
}

/**
 * wa.me with the text. The phone goes in only when it carries its country code (written with «+», or 11 digits
 * and more); a local number would open the wrong chat, so then WhatsApp asks who to send it to.
 */
export function whatsappUrl(text: string, phone?: string | null): string {
    const raw = String(phone || '').trim();
    const digits = raw.replace(/\D/g, '');
    const withCountry = digits.length >= 8 && (raw.startsWith('+') || digits.length >= 11);
    return `https://wa.me/${withCountry ? digits : ''}?text=${encodeURIComponent(text)}`;
}

/** Copy with the Clipboard API. false when there is none or it refused: show the text to copy by hand. */
export async function copyText(text: string, nav: any = typeof navigator !== 'undefined' ? navigator : null): Promise<boolean> {
    try {
        if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') return false;
        await nav.clipboard.writeText(text);
        return true;
    } catch { return false; }
}

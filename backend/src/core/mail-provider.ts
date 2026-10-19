/**
 * WordJS - Email provider availability
 *
 * The core cannot send email itself. A mail-PROVIDER plugin registers a host-wide send function via
 * wordjs.provideMail() — which requires the admin-granted `email:provider` capability and sets
 * global.wordjs_send_mail (see core/plugin-api.ts; another site of a network: its own entry below). The host DELETES that global when the providing
 * plugin unloads, so the check below is a LIVE, fail-closed signal: TRUE only while a provider
 * capability is actually registered right now.
 *
 * With no provider registered, password recovery (routes/auth.ts) fails closed and silently — a fresh
 * install with no mail plugin has NO self-service password reset and nothing used to say so. This
 * helper is the single source of truth behind the admin `email_provider_available` settings flag
 * (routes/settings.ts), the boot-time warning (index.ts) and the install-wizard warning (routes/setup.ts).
 *
 * NOTE: this is deliberately NARROWER than routes/auth.ts `mailReady()`, which ALSO requires the
 * provider to have declared itself delivery-ready (mail_delivery_ready === '1'). "A provider is
 * registered" and "the provider can deliver externally" are different facts; this flag is the former.
 */
const siteContext = require('./site-context');

/**
 * MULTISITE: each site has its own provider — the mail plugin active on THAT site (its own worker, its
 * own grant of `email:provider`). Site 1 keeps the historical `global.wordjs_send_mail`, so a single
 * site, and every caller and test written against the global, behave as before; every other site's
 * provider lives here, keyed by site id, and is reached only from that site's context.
 */
const siteProviders = new Map<number, (msg: any) => any>();
// WHICH PLUGIN registered each site's provider (its folder), so core/account-mail can tell an allowed
// provider from any other: account mail (reset and verification links) only goes to a provider an
// administrator allowed by name.
const providerSlugs = new Map<number, string | null>();

function siteOf(): number {
    return siteContext.currentSiteIdOrNull() ?? siteContext.PRIMARY_SITE_ID;
}

/** The send function of the current site's provider, or undefined when it has none. */
function sendMailFn(): ((msg: any) => any) | undefined {
    const id = siteOf();
    const fn = id === siteContext.PRIMARY_SITE_ID ? (global as any).wordjs_send_mail : siteProviders.get(id);
    return typeof fn === 'function' ? fn : undefined;
}

/** Register `fn` as the current site's provider; `slug` is the plugin that registered it. */
function setMailProvider(fn: (msg: any) => any, slug?: string | null): void {
    const id = siteOf();
    if (id === siteContext.PRIMARY_SITE_ID) (global as any).wordjs_send_mail = fn;
    else siteProviders.set(id, fn);
    registeredFns.set(id, fn);
    providerSlugs.set(id, typeof slug === 'string' && slug ? slug : null);
}

// The function each site's slug belongs to: a slug is only reported while ITS function is the live one
// (a test or legacy code may set global.wordjs_send_mail directly, which no plugin vouches for).
const registeredFns = new Map<number, (msg: any) => any>();

/** The plugin folder whose provider is live on the current site, or null (none, or not registered by a plugin). */
function currentProviderSlug(): string | null {
    const id = siteOf();
    const fn = sendMailFn();
    if (!fn || registeredFns.get(id) !== fn) return null;
    return providerSlugs.get(id) || null;
}

/** Drop the current site's provider — only if it is still `fn` when given (another plugin may have replaced it). */
function clearMailProvider(fn?: (msg: any) => any): void {
    const id = siteOf();
    if (id === siteContext.PRIMARY_SITE_ID) {
        if (!fn || (global as any).wordjs_send_mail === fn) { try { delete (global as any).wordjs_send_mail; } catch { /* */ } }
    } else if (!fn || siteProviders.get(id) === fn) {
        siteProviders.delete(id);
    }
    if (!fn || registeredFns.get(id) === fn) { registeredFns.delete(id); providerSlugs.delete(id); }
}

function isEmailProviderAvailable(): boolean {
    return typeof sendMailFn() === 'function';
}

module.exports = { isEmailProviderAvailable, sendMailFn, setMailProvider, clearMailProvider, currentProviderSlug };

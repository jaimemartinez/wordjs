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

function siteOf(): number {
    return siteContext.currentSiteIdOrNull() ?? siteContext.PRIMARY_SITE_ID;
}

/** The send function of the current site's provider, or undefined when it has none. */
function sendMailFn(): ((msg: any) => any) | undefined {
    const id = siteOf();
    const fn = id === siteContext.PRIMARY_SITE_ID ? (global as any).wordjs_send_mail : siteProviders.get(id);
    return typeof fn === 'function' ? fn : undefined;
}

/** Register `fn` as the current site's provider. */
function setMailProvider(fn: (msg: any) => any): void {
    const id = siteOf();
    if (id === siteContext.PRIMARY_SITE_ID) (global as any).wordjs_send_mail = fn;
    else siteProviders.set(id, fn);
}

/** Drop the current site's provider — only if it is still `fn` when given (another plugin may have replaced it). */
function clearMailProvider(fn?: (msg: any) => any): void {
    const id = siteOf();
    if (id === siteContext.PRIMARY_SITE_ID) {
        if (!fn || (global as any).wordjs_send_mail === fn) { try { delete (global as any).wordjs_send_mail; } catch { /* */ } }
    } else if (!fn || siteProviders.get(id) === fn) {
        siteProviders.delete(id);
    }
}

function isEmailProviderAvailable(): boolean {
    return typeof sendMailFn() === 'function';
}

module.exports = { isEmailProviderAvailable, sendMailFn, setMailProvider, clearMailProvider };

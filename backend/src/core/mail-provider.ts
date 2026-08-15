/**
 * WordJS - Email provider availability
 *
 * The core cannot send email itself. A mail-PROVIDER plugin registers a host-wide send function via
 * wordjs.provideMail() — which requires the admin-granted `email:provider` capability and sets
 * global.wordjs_send_mail (see core/plugin-api.ts). The host DELETES that global when the providing
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
function isEmailProviderAvailable(): boolean {
    return typeof (global as any).wordjs_send_mail === 'function';
}

module.exports = { isEmailProviderAvailable };

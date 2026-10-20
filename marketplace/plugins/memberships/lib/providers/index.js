/**
 * Memberships — payment providers.
 *
 * Every provider implements the same interface, so the routes, the account block and the admin never
 * branch on which one is active (the admin chooses one in Ajustes):
 *
 *   id, label                       'stripe' | 'mercadopago' | 'wompi'
 *   credentials[]                   { key, setting, label, pattern, error } — write-only secrets stored in the
 *                                   plugin's own settings table, never echoed back (masked in the admin)
 *   webhookPath                     the route the provider calls (a core `{ webhook: true }` route)
 *   mode()                          'test' | 'test-user' | 'live' | '' (from the credentials)
 *   isReady()                       credentials present and test-mode
 *   currencies                      null (any the account supports) or the list it accepts
 *   manages(member)                 is this membership one of this provider's live subscriptions?
 *   allowsRepurchase?               paying again while a period runs prepays the next (Wompi)
 *   startCheckout({ userId, email, tier, member, backUrl, cfg }) → { url }       redirect the member there
 *   confirmReturn({ userId, query }) → { handled, applied }                       the return leg
 *   webhook(req) → { status, body }                                              verify, then apply once
 *   changeTier(member, tier, cfg) → { effective: 'now' | 'next-charge' | 'next-period' }
 *   setCancelAtPeriodEnd(member, flag)                                           member cancel / resume
 *   cancelNow(member)                                                            admin revoke
 *   renewDue?() → summary                                                        merchant-scheduled charges
 *   autoRenewStatus?(member), startNequi?(member, phone), stopAutoRenew?(member) (Wompi)
 *
 * Every provider writes memberships through ONE store function (ctx.upsertProviderMember), so the access
 * rules (memberHasAccess, grants) are the same whichever one took the money. Statuses are mapped to
 * active | past_due | incomplete | canceled | expired; provider ids go to provider_customer_id /
 * provider_subscription_id / provider_payment_source. Errors meant for the member carry `.status` and a
 * Spanish `.publicMessage` (ctx.providerError).
 */

const { createStripeProvider } = require('./stripe');
const { createMercadoPagoProvider } = require('./mercadopago');
const { createWompiProvider } = require('./wompi');

const PROVIDER_IDS = ['stripe', 'mercadopago', 'wompi'];

function createProviders(ctx) {
    const list = [createStripeProvider(ctx), createMercadoPagoProvider(ctx), createWompiProvider(ctx)];
    const byId = new Map(list.map((p) => [p.id, p]));
    return { list, get: (id) => byId.get(id) || null };
}

module.exports = { createProviders, PROVIDER_IDS };

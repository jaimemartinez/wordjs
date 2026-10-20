/**
 * WordJS — plugin WEBHOOK routes: the paths a plugin registered with `{ webhook: true }`.
 *
 * A webhook is a server-to-server POST from a third party (a payment provider, a forge, a chat app)
 * that proves who sent it by SIGNING THE RAW BODY. Two things the API stack does for browsers stood in
 * its way: the CSRF gate refuses a POST with no Origin/Referer (a provider sends neither), and
 * express.json consumes the body, so the exact bytes the signature covers were gone by the time the
 * plugin's handler ran.
 *
 * What a webhook route gets instead, decided host-side in plugin-isolate's register-route handler:
 *   · it is EXEMPT from the CSRF gate — and, so that exemption grants nothing, it carries NO ambient
 *     identity: no user is resolved, no cookies are forwarded, and `{ auth }`/`{ admin }` cannot be
 *     combined with it. The handler authenticates the SENDER, by its signature, or rejects;
 *   · `req.rawBody` — the request body exactly as received (UTF-8), captured by express.json's
 *     `verify` hook only for these paths, so every other request keeps today's memory profile;
 *   · the signature headers a provider sends (any header naming a signature, plus the Standard
 *     Webhooks id/timestamp pair).
 * The plugin verifies with `wordjs.crypto.hmac` + `wordjs.crypto.timingSafeEqual`.
 *
 * Only POST is ever registered as a webhook.
 */

const webhookPaths: Map<string, number> = new Map(); // full path → registrations (a reload re-registers)

/** Normalize to the pathname a request URL resolves to (no query, no trailing slash). */
function normalize(p: string): string {
    const path = String(p || '').split('?')[0];
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function registerWebhookPath(fullPath: string): void {
    const key = normalize(fullPath);
    webhookPaths.set(key, (webhookPaths.get(key) || 0) + 1);
}

function unregisterWebhookPath(fullPath: string): void {
    const key = normalize(fullPath);
    const n = (webhookPaths.get(key) || 0) - 1;
    if (n > 0) webhookPaths.set(key, n); else webhookPaths.delete(key);
}

/** Is this request a POST to a registered webhook path? (`originalUrl`, which no mount rewrites.) */
function isWebhookRequest(req: any): boolean {
    if (!req || req.method !== 'POST' || !webhookPaths.size) return false;
    return webhookPaths.has(normalize(req.originalUrl || req.url || ''));
}

/** The provider headers a webhook handler receives (signatures and Standard Webhooks metadata). */
function webhookHeaders(req: any): Record<string, string> {
    const out: Record<string, string> = {};
    const headers = (req && req.headers) || {};
    for (const [name, value] of Object.entries(headers)) {
        const lk = name.toLowerCase();
        if (!(lk.includes('signature') || lk === 'webhook-id' || lk === 'webhook-timestamp' || lk === 'content-type')) continue;
        if (typeof value === 'string') out[lk] = value.slice(0, 4096);
    }
    return out;
}

/** express.json's `verify` hook: keep the exact body of a webhook request as `req.rawBody` (UTF-8). */
function captureWebhookRawBody(req: any, _res: any, buf: Buffer): void {
    if (isWebhookRequest(req)) req.rawBody = buf.toString('utf8');
}

module.exports = { registerWebhookPath, unregisterWebhookPath, isWebhookRequest, webhookHeaders, captureWebhookRawBody };

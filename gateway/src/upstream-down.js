'use strict';
/**
 * WordJS gateway — what a visitor gets when the service behind a route cannot be reached.
 *
 * The edge answered every upstream failure with a JSON body, so a visitor whose browser asked for a page
 * while the frontend node was down (restarting, crashed, being upgraded) saw raw JSON in the browser's
 * JSON viewer, under a 502 whose message said "unavailable". Now:
 *   · a refused connection (the service is starting or down) is 503 with Retry-After, as RFC 9110 means
 *     it: temporary, try again shortly — so caches and crawlers do not take the page as gone;
 *   · a browser navigation (GET/HEAD that accepts text/html, outside /api) gets a small self-contained
 *     HTML page that says so and reloads itself; API clients keep the JSON body they parse.
 * Nothing about the upstream (address, error text) reaches the client; it stays in the gateway log.
 */

const RETRY_AFTER_SECONDS = 10;

/** Does this request come from a browser navigating to a page (rather than an API client)? */
function wantsHtmlPage(req) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    const url = String(req.url || '/');
    if (url === '/api' || url.startsWith('/api/') || url.startsWith('/_next/')) return false;
    const accept = String((req.headers && req.headers.accept) || '');
    return /\btext\/html\b/i.test(accept);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="${RETRY_AFTER_SECONDS * 2}">
<title>Back in a moment</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f8; --fg: #1d1d1f; --muted: #5f6368; --card: #ffffff; --line: #e3e3e6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111214; --fg: #f1f1f3; --muted: #a5a8ad; --card: #1b1c1f; --line: #2c2d31; } }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
  section { max-width: 28rem; width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 28px 24px; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 8px; }
  p { margin: 0 0 6px; color: var(--muted); }
  a { color: inherit; font-weight: 600; }
</style>
</head>
<body>
<main>
<section role="status">
<h1>This site is back in a moment</h1>
<p>It is restarting or being updated. This page tries again on its own.</p>
<p><a href="">Try again now</a></p>
</section>
</main>
</body>
</html>
`;

/**
 * Answer an upstream failure.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse & { status?: Function, json?: Function }} res
 * @param {'down' | 'error'} kind  'down' = the connection was refused (starting or down); 'error' = it failed mid-way
 */
function sendUpstreamFailure(req, res, kind) {
    if (res.headersSent) return;
    const down = kind === 'down';
    const status = down ? 503 : 502;
    res.statusCode = status;
    if (down) res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
    res.setHeader('Cache-Control', 'no-store');
    if (wantsHtmlPage(req)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(String(req.method).toUpperCase() === 'HEAD' ? undefined : PAGE);
        return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(down
        ? { error: 'Service Unavailable', message: 'The upstream service is starting or down.' }
        : { error: 'Upstream Error', message: 'The upstream service could not complete the request.' }));
}

module.exports = { sendUpstreamFailure, wantsHtmlPage, RETRY_AFTER_SECONDS };

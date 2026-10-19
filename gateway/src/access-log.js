/**
 * WordJS Gateway — access-log line format.
 *
 * morgan's `combined` format writes the full request URL and the Referer header. Both carry one-time
 * secrets on this platform: password-reset, e-mail verification and invitation links put their token in
 * the query string, and the page a visitor lands on from such a link sends that same URL as Referer on
 * every asset it loads. Access logs are retained for days and are read by people (and tools) that must
 * never hold a working reset link.
 *
 * The format below is `combined` with two changes:
 *   • the query string keeps its parameter NAMES but every VALUE is replaced with `[redacted]`
 *     (`/reset-password?token=[redacted]&email=[redacted]`), so a log still says which form of a route
 *     was hit without recording what was in it;
 *   • the Referer field is dropped (logged as `-`).
 */

const REDACTED = '[redacted]';

/** `url` with every query value replaced by `[redacted]`; the path and parameter names are kept. */
function redactUrl(url) {
    const s = String(url == null ? '' : url);
    const q = s.indexOf('?');
    if (q === -1) return s;
    const path = s.slice(0, q);
    const query = s.slice(q + 1);
    if (!query) return path;
    const parts = query.split('&').map((pair) => {
        if (!pair) return pair;
        const eq = pair.indexOf('=');
        const name = eq === -1 ? pair : pair.slice(0, eq);
        return `${name}=${REDACTED}`;
    });
    return `${path}?${parts.join('&')}`;
}

/** morgan format function: Apache combined, minus query values and Referer. */
function accessLogFormat(tokens, req, res) {
    const url = redactUrl(req.originalUrl || req.url);
    const status = tokens.status(req, res);
    const length = tokens.res(req, res, 'content-length');
    return [
        tokens['remote-addr'](req, res),
        '-',
        tokens['remote-user'](req, res) || '-',
        `[${tokens.date(req, res, 'clf')}]`,
        `"${tokens.method(req, res)} ${url} HTTP/${tokens['http-version'](req, res)}"`,
        status == null ? '-' : status,
        length == null ? '-' : length,
        '"-"',
        `"${tokens['user-agent'](req, res) || '-'}"`,
    ].join(' ');
}

module.exports = { accessLogFormat, redactUrl, REDACTED };

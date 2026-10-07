/**
 * WordJS — values that enter a log line.
 *
 * A request path, an Origin, a Host, a gateway's or a CA's error message: each can carry characters that
 * forge or split entries in the operator's log (a line break), or rewrite what a terminal shows (an ANSI
 * escape, a bidirectional override). logSafe() returns the value as ONE inert line.
 *
 * The first two replacements are single constants on purpose: the log-injection analysis recognises a
 * sanitizer syntactically and does not match an alternation (`/\n|\r/g`) or a class that merely contains
 * them, so they must stay first and stay in this shape (see core/plugins.ts logSafe). The third removes
 * every other control character (C0 except the two above, DEL, C1 — ESC included, so an ANSI sequence
 * loses its introducer), the Unicode line and paragraph separators, and the bidirectional controls.
 *
 * Interpolate the result into ONE string and pass no further console argument: a template literal
 * followed by more arguments becomes a console format string, where `%s`/`%d` in a value consume them.
 */

// eslint-disable-next-line no-control-regex
const OTHER_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function logSafe(v: unknown): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '').replace(OTHER_CONTROLS, '');
}

/**
 * What a log line should say about a caught value: an Error's message (and its `code`, when it has one),
 * anything else as itself. The stack is left out: it spans lines by construction.
 */
function logSafeError(e: any): string {
    if (e && typeof e === 'object' && typeof e.message === 'string') {
        return logSafe(e.code ? `${e.message} (${e.code})` : e.message);
    }
    return logSafe(e);
}

module.exports = { logSafe, logSafeError };

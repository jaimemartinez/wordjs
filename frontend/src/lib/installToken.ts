/**
 * WordJS — WHERE THE ONE-TIME INSTALL TOKEN TRAVELS IN THE URL.
 *
 * While an instance is not yet installed, the backend prints a clickable
 * `<siteUrl>/install#token=<tok>` URL (see backend/src/core/install-token.ts). That token authorizes
 * the otherwise-unauthenticated pre-install endpoints, so whoever holds it can take over a brand-new
 * instance — it is a bootstrap secret, and the transport matters:
 *
 *   - A QUERY STRING (`?token=…`) is sent to the server on every request for that URL. It therefore
 *     lands in the web server's / reverse proxy's access logs, in any upstream logging, AND in the
 *     `Referer` header of every sub-resource the page loads (a query string survives Referer under
 *     the default `strict-origin-when-cross-origin` policy for same-origin requests).
 *   - A FRAGMENT (`#token=…`) is never transmitted to any server, and the URL spec requires the
 *     fragment to be stripped when a Referer is generated.
 *
 * Both land in the browser's own history, which is why the page scrubs the address bar with
 * `history.replaceState` immediately after reading the token.
 *
 * The parsing lives here, pure and free of `window`, so it can be unit-tested. The page reads the
 * fragment FIRST and falls back to the query string ONLY so that a console printout from an older
 * build (or a bookmarked/pasted `?token=` URL) still works — that fallback is a compatibility ramp,
 * not a supported transport, and is scrubbed just as aggressively.
 */

/** The parameter name carrying the token, in either the fragment or the query string. */
const TOKEN_PARAM = 'token';

/**
 * Percent-decode one `application/x-www-form-urlencoded` component.
 *
 * `plusIsSpace` is NOT cosmetic. In a query string `+` means a space (form-urlencoded), which is
 * what `URLSearchParams` implements; in a FRAGMENT there is no such convention and `+` is a literal
 * plus. Operators may supply their own token via `WORDJS_INSTALL_TOKEN` (any string ≥ 16 chars), so
 * a token containing `+` must survive the fragment path verbatim — hence the hand-rolled decode
 * instead of `URLSearchParams` for both halves.
 *
 * A malformed escape (`%zz`) makes `decodeURIComponent` throw; we fall back to the raw text rather
 * than losing a token that merely contains a stray `%`.
 */
function decodeComponent(raw: string, plusIsSpace: boolean): string {
    const prepared = plusIsSpace ? raw.replace(/\+/g, ' ') : raw;
    try {
        return decodeURIComponent(prepared);
    } catch {
        return prepared;
    }
}

/** Read one parameter out of a bare `a=1&b=2` string (no leading `?` or `#`). */
function readParam(pairs: string, name: string, plusIsSpace: boolean): string | null {
    for (const pair of pairs.split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const rawKey = eq === -1 ? pair : pair.slice(0, eq);
        if (decodeComponent(rawKey, plusIsSpace) !== name) continue;
        const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
        return decodeComponent(rawValue, plusIsSpace);
    }
    return null;
}

/** Drop the leading `#` / `?` that `window.location.hash` / `.search` include when non-empty. */
function stripPrefix(value: string, prefix: string): string {
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * Extract the install token from a location's fragment and query string.
 *
 * The fragment WINS: it is the transport the server prints today, and if both are somehow present
 * we must not prefer the copy that already leaked into the logs.
 *
 * @param hash   `window.location.hash` (e.g. `#token=abc`), with or without the leading `#`.
 * @param search `window.location.search` (e.g. `?token=abc`), with or without the leading `?`.
 * @returns the trimmed token, or `null` when neither carries a non-empty one.
 */
export function parseInstallToken(hash: string, search: string): string | null {
    const fromHash = readParam(stripPrefix(hash || '', '#'), TOKEN_PARAM, false);
    const fromSearch = readParam(stripPrefix(search || '', '?'), TOKEN_PARAM, true);
    const token = (fromHash ?? fromSearch ?? '').trim();
    return token.length > 0 ? token : null;
}

/**
 * Build the URL to hand to `history.replaceState` so the token disappears from the address bar.
 *
 * Only the `token` parameter is removed — from BOTH the fragment and the query string, since the
 * compatibility fallback means either could be carrying it. Anything else the operator had in the
 * URL is preserved: silently discarding unrelated state is the kind of "helpful" side effect that
 * turns into a bug report the day someone adds a `?debug=1` to this page.
 */
export function scrubInstallTokenFromUrl(pathname: string, search: string, hash: string): string {
    const keep = (pairs: string, plusIsSpace: boolean): string =>
        pairs
            .split('&')
            .filter(pair => {
                if (!pair) return false;
                const eq = pair.indexOf('=');
                const rawKey = eq === -1 ? pair : pair.slice(0, eq);
                return decodeComponent(rawKey, plusIsSpace) !== TOKEN_PARAM;
            })
            .join('&');

    const restSearch = keep(stripPrefix(search || '', '?'), true);
    const restHash = keep(stripPrefix(hash || '', '#'), false);
    return `${pathname}${restSearch ? `?${restSearch}` : ''}${restHash ? `#${restHash}` : ''}`;
}

/**
 * WordJS — THE INSTALL TOKEN MUST NOT RIDE IN THE QUERY STRING.
 *
 * The one-time install token authorizes the pre-install setup endpoints of a brand-new instance:
 * whoever reads it owns the site. A `?token=` query string is transmitted to the server on every
 * request, so it is written into access/proxy logs and leaks through the `Referer` of any
 * sub-resource the install page loads. A `#token=` fragment is never sent anywhere.
 *
 * These tests pin the three properties that make the move to a fragment real rather than cosmetic:
 *
 *   1. The FRAGMENT WINS. If the fragment is only "preferred when the query is absent", any stale
 *      link keeps the leaky transport alive; the precedence has to be unconditional.
 *   2. The QUERY STILL PARSES — deliberately. It is a compatibility ramp for a console printout from
 *      an older build. Deleting the fallback would silently break those; this test is what stops a
 *      future cleanup from doing it by accident, and its comment says why it exists.
 *   3. BOTH ARE SCRUBBED from the address bar, and only the token — unrelated query/fragment state
 *      survives `history.replaceState`.
 *
 * If the implementation were reverted to `new URLSearchParams(window.location.search).get('token')`,
 * every fragment case below goes red.
 */
import { describe, expect, test } from 'vitest';
import { parseInstallToken, scrubInstallTokenFromUrl } from '../installToken';

describe('parseInstallToken', () => {
    test('reads the token from the fragment the server now prints', () => {
        expect(parseInstallToken('#token=abc123', '')).toBe('abc123');
    });

    test('accepts a hash/search that already had its leading # / ? stripped', () => {
        expect(parseInstallToken('token=abc123', '')).toBe('abc123');
        expect(parseInstallToken('', 'token=abc123')).toBe('abc123');
    });

    test('the fragment WINS over a query string carrying a different token', () => {
        // Unconditional precedence: never prefer the copy that already leaked into the access logs.
        expect(parseInstallToken('#token=fragment-wins', '?token=query-loses')).toBe('fragment-wins');
    });

    test('still reads ?token= when there is no fragment (older console printouts)', () => {
        // Compatibility ramp on purpose — see the file header before removing this.
        expect(parseInstallToken('', '?token=legacy123')).toBe('legacy123');
        expect(parseInstallToken('#', '?token=legacy123')).toBe('legacy123');
    });

    test('returns null when no token is present', () => {
        expect(parseInstallToken('', '')).toBeNull();
        expect(parseInstallToken('#', '?')).toBeNull();
        expect(parseInstallToken('#other=1', '?foo=bar')).toBeNull();
    });

    test('returns null for a present-but-empty or whitespace-only token', () => {
        // An empty prefill would put the wizard in a "token supplied" state with nothing in it.
        expect(parseInstallToken('#token=', '')).toBeNull();
        expect(parseInstallToken('#token', '')).toBeNull();
        expect(parseInstallToken('#token=%20%20', '')).toBeNull();
    });

    test('URL-decodes the value and trims surrounding whitespace', () => {
        expect(parseInstallToken('#token=a%2Bb%2Fc%3D', '')).toBe('a+b/c=');
        expect(parseInstallToken('#token=%20abc%20', '')).toBe('abc');
        expect(parseInstallToken('', '?token=a%2Bb')).toBe('a+b');
    });

    test('a literal + is a plus in the fragment but a space in the query string', () => {
        // WORDJS_INSTALL_TOKEN may be any operator-chosen string, so a `+` has to survive the
        // fragment verbatim; `+` = space is a form-urlencoding rule that applies to query strings.
        expect(parseInstallToken('#token=a+b', '')).toBe('a+b');
        expect(parseInstallToken('', '?token=a+b')).toBe('a b');
    });

    test('finds the token among other parameters, in any position', () => {
        expect(parseInstallToken('#foo=1&token=abc&bar=2', '')).toBe('abc');
        expect(parseInstallToken('', '?foo=1&token=abc')).toBe('abc');
    });

    test('does not match a parameter that merely ends in "token"', () => {
        expect(parseInstallToken('#install_token=abc', '?apitoken=def')).toBeNull();
    });

    test('survives a malformed percent escape instead of throwing', () => {
        // A caller-side throw here would abort the effect and lose the prefill entirely.
        expect(parseInstallToken('#token=100%dead', '')).toBe('100%dead');
    });
});

describe('scrubInstallTokenFromUrl', () => {
    test('removes a fragment token, leaving a bare path', () => {
        expect(scrubInstallTokenFromUrl('/install', '', '#token=abc123')).toBe('/install');
    });

    test('removes a query token too — the fallback transport is scrubbed just as hard', () => {
        expect(scrubInstallTokenFromUrl('/install', '?token=abc123', '')).toBe('/install');
    });

    test('removes the token from BOTH halves at once', () => {
        expect(scrubInstallTokenFromUrl('/install', '?token=q', '#token=f')).toBe('/install');
    });

    test('keeps unrelated query and fragment state', () => {
        expect(scrubInstallTokenFromUrl('/install', '?debug=1&token=abc', '#token=f&step=2'))
            .toBe('/install?debug=1#step=2');
    });

    test('is a no-op path when there is nothing to scrub', () => {
        expect(scrubInstallTokenFromUrl('/install', '', '')).toBe('/install');
        expect(scrubInstallTokenFromUrl('/install', '?debug=1', '#step=2')).toBe('/install?debug=1#step=2');
    });
});

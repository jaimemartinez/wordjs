import { describe, it, expect } from 'vitest';
import { isSessionEnded, SESSION_ENDED_EVENT } from '../api';

/**
 * The session-ended classifier decides whether a 401 means "you are signed out" or "that request
 * failed". Both ways of getting it wrong are bad and neither is loud:
 *   • too NARROW → a routine expiry is reported as an application error (the original bug: a background
 *     menu refresh logged "Token has expired." to the console);
 *   • too WIDE  → an unrelated 401 silently signs the user out, and a CSRF rejection — a security
 *     signal — disappears with it.
 * So pin the exact membership, and pin that it keys on the backend's stable CODE rather than on the
 * human-readable message, which is copy and gets translated.
 */

const err = (code?: string, message = 'boom') => Object.assign(new Error(message), code ? { code } : {});

describe('isSessionEnded', () => {
    it('accepts every code that means the session is over', () => {
        for (const code of [
            'rest_token_expired',    // jwt exp passed
            'rest_token_revoked',    // logout / password change stamped token_valid_after
            'rest_token_invalid',    // malformed or bad signature
            'rest_not_logged_in',    // no credential at all
            'rest_user_invalid',     // the token's user no longer exists
        ]) {
            expect(isSessionEnded(err(code)), code).toBe(true);
        }
    });

    it('does NOT swallow a CSRF rejection — that is a security signal, not an expiry', () => {
        expect(isSessionEnded(err('rest_csrf_invalid'))).toBe(false);
    });

    it('does not treat an API token scope problem as a dead browser session', () => {
        expect(isSessionEnded(err('rest_token_scope_insufficient'))).toBe(false);
    });

    it('ignores the message and keys on the code', () => {
        // The exact message from the reported bug, but with no code: it must NOT be classified by text.
        expect(isSessionEnded(err(undefined, 'Token has expired.'))).toBe(false);
        // ...and the code alone is enough, whatever the message says.
        expect(isSessionEnded(err('rest_token_expired', 'something else entirely'))).toBe(true);
    });

    it('is safe on anything that is not an api() error', () => {
        for (const value of [null, undefined, 'rest_token_expired', 42, {}, new Error('plain')]) {
            expect(isSessionEnded(value)).toBe(false);
        }
    });

    it('exposes a stable event name for the listener and the dispatcher to agree on', () => {
        expect(SESSION_ENDED_EVENT).toBe('wjs:session-ended');
    });
});

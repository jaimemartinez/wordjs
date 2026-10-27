import { describe, it, expect } from 'vitest';
import { userContentTarget } from '../UserContentAnchors';

// Author ids are rendered as `user-content-<id>` (lib/sanitize.ts); a link to `#intro` must still land
// on `user-content-intro`, while fragments the page itself owns are left to the browser.
const doc = (ids: string[]) => ({
    getElementById: (id: string) => (ids.includes(id) ? ({ id } as unknown as HTMLElement) : null),
}) as unknown as Document;

describe('userContentTarget', () => {
    const page = doc(['user-content-intro', 'pricing']);

    it('resolves #intro to user-content-intro', () => {
        expect(userContentTarget('#intro', page)?.id).toBe('user-content-intro');
        expect(userContentTarget('intro', page)?.id).toBe('user-content-intro');
    });

    it('leaves real ids, prefixed fragments, unknown and malformed fragments to the browser', () => {
        expect(userContentTarget('#pricing', page)).toBeNull();
        expect(userContentTarget('#user-content-intro', page)).toBeNull();
        expect(userContentTarget('#nowhere', page)).toBeNull();
        expect(userContentTarget('', page)).toBeNull();
        expect(userContentTarget('#%E0%A4%A', page)).toBeNull();
    });
});

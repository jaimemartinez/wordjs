import { describe, it, expect } from 'vitest';
import { widgetIdFromInstanceKey } from '../widgetInstanceKey';

describe('widgetIdFromInstanceKey', () => {
    const ids = ['categories', 'recent_posts', 'promo', 'promo-box'];
    const uuid = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

    it('resolves UUID keys and legacy base-36 keys', () => {
        expect(widgetIdFromInstanceKey(`categories-${uuid}`, ids)).toBe('categories');
        expect(widgetIdFromInstanceKey('recent_posts-lx3k9a', ids)).toBe('recent_posts');
    });

    it('keeps hyphenated widget ids whole, longest registered id first', () => {
        expect(widgetIdFromInstanceKey(`promo-box-${uuid}`, ids)).toBe('promo-box');
        expect(widgetIdFromInstanceKey('promo-lx3k9a', ids)).toBe('promo');
    });

    it('falls back to the first segment for an unregistered widget', () => {
        expect(widgetIdFromInstanceKey('gone-widget-lx3k9a', ids)).toBe('gone');
    });
});

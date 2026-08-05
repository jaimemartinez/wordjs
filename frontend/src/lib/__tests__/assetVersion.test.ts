import { describe, it, expect } from 'vitest';
import { ASSET_VERSION, themeStylesheetHref, uiFrameworkHref } from '../assetVersion';

// The href is rendered during SSR and again at hydration; any drift between the two is a React
// mismatch AND a second, duplicate stylesheet fetch. Nothing here may depend on the clock, the
// environment or anything the client recomputes — hence the same-input/same-output assertions.
describe('assetVersion', () => {
    it('ASSET_VERSION is the generated ui.css content hash (never the old hand-bumped string)', () => {
        expect(ASSET_VERSION).toMatch(/^[0-9a-f]{8,64}$/);
    });

    it('builds the versioned theme href from slug + theme version + asset version', () => {
        expect(themeStylesheetHref('apex-enterprise', '1.2.3'))
            .toBe(`/themes/apex-enterprise/style.css?v=apex-enterprise-1.2.3-${ASSET_VERSION}`);
    });

    it('drops a missing theme version instead of emitting an empty segment', () => {
        const expected = `/themes/default/style.css?v=default-${ASSET_VERSION}`;
        expect(themeStylesheetHref('default')).toBe(expected);
        expect(themeStylesheetHref('default', '')).toBe(expected);
        expect(themeStylesheetHref('default', null)).toBe(expected);
    });

    it('is deterministic — repeated calls with the same input give the identical URL', () => {
        expect(themeStylesheetHref('default', '2.0.0')).toBe(themeStylesheetHref('default', '2.0.0'));
        expect(uiFrameworkHref()).toBe(uiFrameworkHref());
        expect(uiFrameworkHref()).toBe(`/public/css/wordjs-ui.css?v=${ASSET_VERSION}`);
    });
});

/**
 * conference-manager meal scanner, text on a phone (live review, iPhone 13 / SE).
 *
 *   - A camera that cannot open showed the browser's own message, «Not supported», in English on the
 *     Spanish scanner. A getUserMedia failure is now mapped to a state and a translated message.
 *   - The service in the top bar was one line, cut to «Mar 10/11 · Almuerzo — Al…»: the custom label after
 *     the dash, which tells two services of the same meal apart, was the part cut. It now takes up to two
 *     lines before the ellipsis.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cameraFailure, SERVICE_NAME_STYLE } from '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';

const SRC = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner.tsx'), 'utf8');

describe('cameraFailure: never the browser\'s English message', () => {
    it('maps each getUserMedia error to a state and a translated message', () => {
        expect(cameraFailure({ name: 'NotAllowedError' })).toEqual({ cam: 'denied', key: null });
        expect(cameraFailure({ name: 'SecurityError' })).toEqual({ cam: 'denied', key: null });
        expect(cameraFailure({ name: 'NotSupportedError' })).toEqual({ cam: 'unsupported', key: null });
        expect(cameraFailure({ name: 'NotFoundError' })).toEqual({ cam: 'error', key: 'meals.camera.notfound' });
        expect(cameraFailure({ name: 'NotReadableError' })).toEqual({ cam: 'error', key: 'meals.camera.busy' });
        // Anything else: the generic translated message («No se pudo abrir la cámara.»), not e.message.
        expect(cameraFailure({ name: 'WeirdError' })).toEqual({ cam: 'error', key: null });
        expect(cameraFailure(null)).toEqual({ cam: 'error', key: null });
    });
    it('the scanner no longer shows e.message for a camera failure', () => {
        expect(SRC).not.toMatch(/setCamError\(e\?\.message/);
        expect(SRC).toMatch(/const failure = cameraFailure\(e\);/);
    });
    it('es/en/pt carry the new message', () => {
        for (const lang of ['es', 'en', 'pt'] as const) expect(translations[lang]['meals.camera.busy'], lang).toBeTruthy();
    });
});

describe('the service name in the scanner bar', () => {
    it('takes up to two lines before the ellipsis, and breaks a long word only where it must', () => {
        expect(SERVICE_NAME_STYLE).toMatchObject({ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', overflowWrap: 'anywhere' });
        expect(SERVICE_NAME_STYLE).not.toHaveProperty('whiteSpace');
        expect(SRC).toContain('style={SERVICE_NAME_STYLE} data-scanner-service-name=""');
    });
});

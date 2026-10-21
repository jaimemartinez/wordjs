/**
 * lib/gatewayServing.ts — Admin → Security shows what the gateway actually serves next to the switch
 * (QA X1-03), and offers a self-signed certificate only as an explicit button (FALLOS 114: opening the
 * screen used to generate one and switch the gateway to HTTPS).
 */
import { describe, expect, it } from 'vitest';
import { gatewayNeedsCertificate, gatewayServingNotice } from '../gatewayServing';

describe('gatewayServingNotice', () => {
    it('no notice when the switch and the workers agree', () => {
        expect(gatewayServingNotice({ sslEnabled: true, serving: 'https', certInfo: { type: 'custom' } })).toBeNull();
        expect(gatewayServingNotice({ sslEnabled: false, serving: 'http', certInfo: null })).toBeNull();
    });

    it('switch on, workers on HTTP: says so', () => {
        expect(gatewayServingNotice({ sslEnabled: true, serving: 'http', certInfo: { type: 'none' } })).toBe('security.gateway.servingMismatchOn');
    });

    it('switch off, workers still on HTTPS: says so', () => {
        expect(gatewayServingNotice({ sslEnabled: false, serving: 'https', certInfo: { type: 'custom' } })).toBe('security.gateway.servingMismatchOff');
    });

    it('an older gateway without `serving`: falls back to the certificate', () => {
        expect(gatewayServingNotice({ sslEnabled: true, serving: null, certInfo: { type: 'none' } })).toBe('security.gateway.noCertificateOn');
        expect(gatewayServingNotice({ sslEnabled: true, certInfo: { type: 'self-signed' } })).toBeNull();
    });

    it('the monolith manages its own TLS: never a notice', () => {
        expect(gatewayServingNotice({ source: 'monolith', sslEnabled: true, serving: 'http' })).toBeNull();
    });
});

describe('gatewayNeedsCertificate', () => {
    it('only with HTTPS on, nothing stored and HTTPS not served', () => {
        expect(gatewayNeedsCertificate({ sslEnabled: true, serving: 'http', certInfo: { type: 'none' } })).toBe(true);
        expect(gatewayNeedsCertificate({ sslEnabled: true, serving: 'http', certInfo: null })).toBe(true);
        // Serving the auto-generated pair: nothing to generate.
        expect(gatewayNeedsCertificate({ sslEnabled: true, serving: 'https', certInfo: { type: 'none' } })).toBe(false);
        // HTTPS off: never (this is the case the old screen got wrong).
        expect(gatewayNeedsCertificate({ sslEnabled: false, serving: 'http', certInfo: null })).toBe(false);
        expect(gatewayNeedsCertificate({ source: 'monolith', sslEnabled: true, certInfo: null })).toBe(false);
    });
});

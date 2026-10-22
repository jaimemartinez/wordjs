/**
 * Telling an administrator WHY an address-bound action is refused, instead of a misleading generic line.
 *
 *  · QA S4-02: a user save refused with rest_account_bound_session (the session was started at an address
 *    other than the main one) was shown as "Failed to save user"; it now names the main address to sign
 *    in at, and the way out when the browser cannot reach it.
 *  · QA X1-09: an administrator of a network site was told "Only administrators can manage the site
 *    address"; a site's address belongs to the network administrator, and the screen says so.
 */
import { describe, expect, it } from 'vitest';
import { accountBoundSessionAddress, userSaveErrorText } from '../api';
import { siteAddressRefusalKey } from '../siteAddress';
import { translations } from '../i18n';

const t = (key: string) => (translations as any).en[key] ?? key;

describe('accountBoundSessionAddress / userSaveErrorText', () => {
    const bound = Object.assign(new Error('Accounts ... main address.'), { code: 'rest_account_bound_session', data: { status: 403, mainAddress: 'http://192.0.2.192:3000' } });

    it('names the main address for a bound-session refusal', () => {
        expect(accountBoundSessionAddress(bound)).toBe('http://192.0.2.192:3000');
        const text = userSaveErrorText(bound, t);
        expect(text).toContain('http://192.0.2.192:3000');
        expect(text).toMatch(/main address/);
        expect(text).not.toMatch(/^Failed to save user$/);
    });

    it('still explains it when the server names no address', () => {
        const noUrl = Object.assign(new Error('x'), { code: 'rest_account_bound_session', data: { status: 403 } });
        expect(accountBoundSessionAddress(noUrl)).toBe('');
        expect(userSaveErrorText(noUrl, t)).toMatch(/Settings → Site address/);
    });

    it('any other error keeps the server message after the generic line', () => {
        expect(accountBoundSessionAddress(new Error('boom'))).toBeNull();
        expect(userSaveErrorText(new Error('Email taken'), t)).toBe('Failed to save user: Email taken');
        const badPw = Object.assign(new Error('Current password is incorrect.'), { code: 'rest_bad_current_password' });
        expect(userSaveErrorText(badPw, t)).toBe('Current password is incorrect.');
    });
});

describe('siteAddressRefusalKey', () => {
    it('an administrator of a network site is pointed at the network administrator', () => {
        expect(siteAddressRefusalKey({ role: 'administrator', network: { mainSite: false, networkAdmin: false } })).toBe('siteAddress.networkAdminOnlySite');
        expect(siteAddressRefusalKey({ role: 'administrator', network: { mainSite: true, networkAdmin: false } })).toBe('siteAddress.networkAdminOnlyMain');
    });

    it('anyone else keeps the plain message', () => {
        expect(siteAddressRefusalKey({ role: 'editor', network: { mainSite: false, networkAdmin: false } })).toBeNull();
        expect(siteAddressRefusalKey({ role: 'administrator' })).toBeNull();
        expect(siteAddressRefusalKey(null)).toBeNull();
    });

    it('every key the screens use exists in every language', () => {
        const keys = ['siteAddress.networkAdminOnlySite', 'siteAddress.networkAdminOnlyMain', 'user.edit.boundSession', 'user.edit.boundSessionNoUrl',
            'network.changeAddress', 'network.addressMain', 'network.addressOthers', 'network.addressChangeHint', 'network.addressSave', 'network.addressSaved',
            'network.addressFailed', 'network.otherAddresses', 'security.gateway.servingNow', 'security.gateway.servingReloading',
            'security.gateway.servingMismatchOn', 'security.gateway.servingMismatchOff', 'security.gateway.noCertificateOn',
            'security.gateway.generateSelfSigned', 'security.gateway.generateFailed', 'security.gateway.confirmTitle',
            'security.gateway.confirmTransportOn', 'security.gateway.confirmTransportOff',
            'cluster.forwardsTitle', 'cluster.forwardsHelp', 'cluster.forwardsNone', 'cluster.forwardsEdit', 'cluster.forwardPort', 'cluster.forwardTargetPort',
            'cluster.forwardProxy', 'cluster.forwardListening', 'cluster.forwardNotListening', 'cluster.forwardAdd', 'cluster.forwardRemove', 'cluster.forwardsSave',
            'cluster.forwardsSaved', 'cluster.forwardsSavedWithErrors', 'cluster.forwardsFailed'];
        for (const lang of ['en', 'es', 'pt']) {
            for (const key of keys) expect((translations as any)[lang][key], `${lang} ${key}`).toBeTruthy();
        }
    });
});

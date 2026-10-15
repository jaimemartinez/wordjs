/**
 * WordJS — the key every site signs its own tokens with (multisite).
 *
 * User ids repeat across a network (every site has a user 1), so a token minted by one site must be
 * worthless on every other one, even to a code path that forgot to compare a claim. Two independent
 * locks make it so:
 *
 *   1. THE KEY. Site 1 signs with `config.jwt.secret`, as every install always has, so sessions minted
 *      before multisite was enabled stay valid. Every other site signs with
 *      HMAC-SHA256(jwt.secret, "wordjs-site:<id>"): a token from site 2 fails the signature check on
 *      site 3 before a single claim is read.
 *   2. THE CLAIM. Tokens of sites other than 1 carry `sid`; verification refuses a token whose `sid`
 *      is not the site the request was addressed to, and a site-1 token carries none.
 *
 * The derived keys are never stored: they follow the one secret, and rotate with it.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/app');
import { PRIMARY_SITE_ID, currentSiteId } from './site-context';

/** The signing key of `siteId` (default: the current site). */
function siteSigningKey(siteId: number = currentSiteId()): string {
    const secret = String((config as any).jwt && (config as any).jwt.secret || '');
    if (siteId === PRIMARY_SITE_ID) return secret;
    return crypto.createHmac('sha256', secret).update(`wordjs-site:${siteId}`).digest('hex');
}

/** Sign `claims` for the current site: its key, and its `sid` when it is not site 1. */
function signForSite(claims: Record<string, unknown>, options: Record<string, unknown> = {}): string {
    const siteId = currentSiteId();
    const body = siteId === PRIMARY_SITE_ID ? claims : Object.assign({}, claims, { sid: siteId });
    return jwt.sign(body, siteSigningKey(siteId), options);
}

/**
 * Verify a token minted by the current site (HS256 only). Throws like `jwt.verify` on a bad signature
 * or an expired token, and with `site_mismatch` when the `sid` claim names another site.
 */
function verifyForSite(token: string): any {
    const siteId = currentSiteId();
    const decoded = jwt.verify(token, siteSigningKey(siteId), { algorithms: ['HS256'] });
    const sid = decoded && typeof decoded === 'object' ? (decoded as any).sid : undefined;
    const ok = siteId === PRIMARY_SITE_ID ? sid === undefined : sid === siteId;
    if (!ok) {
        const e = new Error('This token belongs to another site.') as Error & { code: string };
        e.code = 'site_mismatch';
        throw e;
    }
    return decoded;
}

module.exports = { siteSigningKey, signForSite, verifyForSite };

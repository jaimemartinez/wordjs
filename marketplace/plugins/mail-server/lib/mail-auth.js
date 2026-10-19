'use strict';
/**
 * Inbound message authentication: DKIM signature verification (RFC 6376, with the RFC 8301 algorithm
 * and key-size rules and RFC 8463 Ed25519) and DMARC evaluation (RFC 7489).
 *
 * Built on node:crypto and a TXT resolver the caller passes in (the plugin hands it the host DNS
 * bridge, the same one SPF uses — the sandbox denies the raw resolver). Nothing here touches the
 * network on its own, so the module runs unchanged inside the plugin isolate and in tests with a
 * fake resolver.
 *
 *   const auth = await authenticateMessage(rawBuffer, {
 *       resolveTxt, spfResult: 'pass', envelopeFrom: 'bounce@x.example', receiver: 'mail.example' });
 *   auth.dkim        → [{ result, domain, selector, reason }]
 *   auth.dmarc       → { result, domain, policy, disposition, reason }
 *   auth.header      → one Authentication-Results line (RFC 8601) to persist with the message
 */
const crypto = require('crypto');

const MAX_SIGNATURES = 5;         // a message carrying more is not checked past this many
const MIN_RSA_BITS = 1024;        // RFC 8301 §3.2: verifiers MUST NOT accept smaller keys

// --- message parsing -------------------------------------------------------------------------------

/** Raw message → { headers: [{ name, lname, raw }], body } with CRLF line endings, byte-exact (latin1). */
function splitMessage(raw) {
    let s = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw || '');
    // SMTP DATA is CRLF; a bare LF (some test tools, a few relays) is read as CRLF, never as content.
    s = s.replace(/\r?\n/g, '\r\n');
    let sep = s.indexOf('\r\n\r\n');
    let head, body;
    if (sep < 0) { head = s; body = ''; } else { head = s.slice(0, sep + 2); body = s.slice(sep + 4); }
    const headers = [];
    for (const line of head.split('\r\n')) {
        if (line === '') continue;
        if ((line[0] === ' ' || line[0] === '\t') && headers.length) {
            headers[headers.length - 1].raw += '\r\n' + line;
            continue;
        }
        const colon = line.indexOf(':');
        if (colon <= 0) continue; // not a header field; ignored for hashing as every verifier does
        const name = line.slice(0, colon);
        headers.push({ name, lname: name.trim().toLowerCase(), raw: line });
    }
    return { headers, body };
}

// --- canonicalization (RFC 6376 §3.4) --------------------------------------------------------------

function canonHeader(raw, mode) {
    if (mode === 'simple') return raw + '\r\n';
    const colon = raw.indexOf(':');
    const name = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).replace(/\r\n/g, '').replace(/[ \t]+/g, ' ').trim();
    return `${name}:${value}\r\n`;
}

function canonBody(body, mode) {
    if (mode === 'simple') {
        let b = body.replace(/(\r\n)*$/, '');
        return b + '\r\n';
    }
    const lines = body.split('\r\n').map(l => l.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
    let b = lines.join('\r\n').replace(/(\r\n)*$/, '');
    return b === '' ? '' : b + '\r\n';
}

// --- tag lists (RFC 6376 §3.2) ---------------------------------------------------------------------

function parseTags(value) {
    const tags = {};
    for (const part of String(value || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const k = part.slice(0, eq).replace(/\s+/g, '').toLowerCase();
        if (!k || Object.prototype.hasOwnProperty.call(tags, k)) {
            if (k) tags.__duplicate = true;
            continue;
        }
        tags[k] = part.slice(eq + 1).trim();
    }
    return tags;
}

const b64 = (v) => String(v || '').replace(/\s+/g, '');

/** The DKIM-Signature header with its b= value emptied (the form that was signed). */
function withoutSignature(raw) {
    const colon = raw.indexOf(':');
    const value = raw.slice(colon + 1);
    // b= is a tag at the start or after a ';' — never the tail of bh=.
    const stripped = value.replace(/(^|;)(\s*b\s*=)[^;]*/i, '$1$2');
    return raw.slice(0, colon + 1) + stripped;
}

// --- keys ------------------------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFrom(record) {
    const k = (record.k || 'rsa').toLowerCase();
    const der = Buffer.from(b64(record.p), 'base64');
    if (k === 'ed25519') {
        if (der.length !== 32) throw Object.assign(new Error('malformed ed25519 key'), { perm: true });
        return { type: 'ed25519', key: crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, der]), format: 'der', type: 'spki' }) };
    }
    if (k !== 'rsa') throw Object.assign(new Error(`unsupported key type ${k}`), { perm: true });
    let key;
    try { key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); }
    catch (e) {
        try { key = crypto.createPublicKey({ key: der, format: 'der', type: 'pkcs1' }); }
        catch (e2) { throw Object.assign(new Error('malformed rsa key'), { perm: true }); }
    }
    const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength;
    if (bits && bits < MIN_RSA_BITS) throw Object.assign(new Error(`rsa key too small (${bits} bits)`), { perm: true });
    return { type: 'rsa', key };
}

const isNoRecord = (e) => /ENOTFOUND|ENODATA|NXDOMAIN|NOTFOUND/i.test(String((e && (e.code || e.message)) || ''));

async function txtRecords(resolveTxt, name) {
    try {
        const rows = await resolveTxt(name);
        return { records: (rows || []).map(r => (Array.isArray(r) ? r.join('') : String(r))) };
    } catch (e) {
        return isNoRecord(e) ? { records: [] } : { error: e };
    }
}

// --- DKIM ------------------------------------------------------------------------------------------

const isSubdomainOf = (child, parent) => child === parent || child.endsWith('.' + parent);

async function verifyOne(sigHeader, msg, resolveTxt, now) {
    const tags = parseTags(sigHeader.raw.slice(sigHeader.raw.indexOf(':') + 1));
    const out = { result: 'permerror', domain: String(tags.d || '').toLowerCase(), selector: String(tags.s || '').toLowerCase(), reason: '' };
    const fail = (result, reason) => Object.assign(out, { result, reason });

    if (tags.__duplicate) return fail('permerror', 'duplicate tag');
    if (tags.v !== '1') return fail('permerror', 'unsupported version');
    for (const req of ['a', 'b', 'bh', 'd', 'h', 's']) if (!tags[req]) return fail('permerror', `missing ${req}=`);
    if (!/^[a-z0-9.-]+$/.test(out.domain) || !/^[a-z0-9._-]+$/.test(out.selector)) return fail('permerror', 'malformed d= or s=');

    const alg = tags.a.toLowerCase();
    if (alg === 'rsa-sha1') return fail('policy', 'rsa-sha1 is not accepted (RFC 8301)');
    if (alg !== 'rsa-sha256' && alg !== 'ed25519-sha256') return fail('permerror', `unsupported algorithm ${alg}`);

    const [hc, bc = 'simple'] = String(tags.c || 'simple/simple').toLowerCase().split('/');
    if (!['simple', 'relaxed'].includes(hc) || !['simple', 'relaxed'].includes(bc)) return fail('permerror', 'unsupported canonicalization');

    const signed = tags.h.split(':').map(h => h.trim().toLowerCase()).filter(Boolean);
    if (!signed.includes('from')) return fail('permerror', 'From is not signed');
    if (tags.i) {
        const at = tags.i.lastIndexOf('@');
        const idom = (at >= 0 ? tags.i.slice(at + 1) : '').toLowerCase();
        if (!idom || !isSubdomainOf(idom, out.domain)) return fail('permerror', 'i= is not within d=');
    }
    if (tags.x && /^\d+$/.test(tags.x) && Number(tags.x) < Math.floor(now / 1000)) return fail('fail', 'signature expired');

    // Body hash.
    let body = canonBody(msg.body, bc);
    let partial = false;
    if (tags.l !== undefined) {
        if (!/^\d+$/.test(tags.l)) return fail('permerror', 'malformed l=');
        const l = Number(tags.l);
        const size = Buffer.byteLength(body, 'latin1');
        if (l > size) return fail('fail', 'l= exceeds the body');
        // RFC 6376 §8.2: whatever follows the signed length can be anything. Such a signature still
        // verifies, but it is a "pass with unsigned content": it authenticates nobody (see fullPass).
        partial = l < size;
        body = Buffer.from(body, 'latin1').subarray(0, l).toString('latin1');
    }
    const bh = crypto.createHash('sha256').update(Buffer.from(body, 'latin1')).digest('base64');
    if (bh !== b64(tags.bh)) return fail('fail', 'body hash did not verify');

    // Header hash: each listed name takes the next instance from the BOTTOM (§5.4.2).
    const used = new Set();
    let data = '';
    for (const name of signed) {
        for (let i = msg.headers.length - 1; i >= 0; i--) {
            const h = msg.headers[i];
            if (used.has(i) || h.lname !== name || h === sigHeader) continue;
            used.add(i);
            data += canonHeader(h.raw, hc);
            break;
        }
    }
    data += canonHeader(withoutSignature(sigHeader.raw), hc).replace(/\r\n$/, '');

    // Key.
    const { records, error } = await txtRecords(resolveTxt, `${out.selector}._domainkey.${out.domain}`);
    if (error) return fail('temperror', 'key lookup failed');
    const keyRecs = records.map(parseTags).filter(r => r.p !== undefined && (!r.v || r.v === 'DKIM1'));
    if (keyRecs.length === 0) return fail('permerror', 'no key published');
    const rec = keyRecs[0];
    if (b64(rec.p) === '') return fail('fail', 'key revoked');
    if (rec.h && !rec.h.split(':').map(x => x.trim().toLowerCase()).includes('sha256')) return fail('permerror', 'key does not allow sha256');
    let pub;
    try { pub = publicKeyFrom(rec); } catch (e) { return fail(e.perm ? 'permerror' : 'temperror', e.message); }
    if ((alg === 'ed25519-sha256') !== (pub.type === 'ed25519')) return fail('permerror', 'key type does not match a=');

    const sig = Buffer.from(b64(tags.b), 'base64');
    let ok = false;
    try {
        const input = Buffer.from(data, 'latin1');
        ok = pub.type === 'ed25519'
            ? crypto.verify(null, crypto.createHash('sha256').update(input).digest(), pub.key, sig)
            : crypto.verify('sha256', input, pub.key, sig);
    } catch (e) { ok = false; }
    if (!ok) return fail('fail', 'signature did not verify');
    return Object.assign(out, partial
        ? { result: 'pass', partial: true, reason: 'unsigned-content-after-l=' }
        : { result: 'pass', reason: '' });
}

/** A DKIM result that authenticates its d= domain: a pass that covers the whole body. */
const fullPass = (s) => !!s && s.result === 'pass' && !s.partial;

/** Verify every DKIM-Signature on the message (up to MAX_SIGNATURES). [] = unsigned. */
async function verifyDkim(raw, { resolveTxt, now = Date.now() } = {}) {
    const msg = typeof raw === 'object' && raw && raw.headers && raw.body !== undefined ? raw : splitMessage(raw);
    const sigs = msg.headers.filter(h => h.lname === 'dkim-signature').slice(0, MAX_SIGNATURES);
    const out = [];
    for (const s of sigs) {
        try { out.push(await verifyOne(s, msg, resolveTxt, now)); }
        catch (e) { out.push({ result: 'permerror', domain: '', selector: '', reason: 'unverifiable signature' }); }
    }
    return out;
}

// --- DMARC -----------------------------------------------------------------------------------------

// Organizational domain (RFC 7489 §3.2) from the Public Suffix List, vendored as data in
// lib/public-suffix-list.js (regenerate it with backend/scripts/update-public-suffix-list.js): the
// registrable domain is the public suffix plus one label. A domain whose suffix the list does not know
// (only the implicit "*" rule matches) is marked `known: false`, and relaxed alignment then requires an
// exact match — guessing where an unknown suffix ends would align unrelated registrants under it.
const PSL = (() => {
    const rules = new Set(), exceptions = new Set(), wildcards = new Set();
    for (const r of require('./public-suffix-list').rules.split('\n')) {
        if (!r) continue;
        if (r[0] === '!') exceptions.add(r.slice(1));
        else if (r.startsWith('*.')) wildcards.add(r.slice(2));
        else rules.add(r);
    }
    return { rules, exceptions, wildcards };
})();

/** { suffix, org, known } for a domain, by the PSL algorithm (https://publicsuffix.org/list/). */
function publicSuffixOf(domain) {
    const labels = String(domain || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
    if (labels.length === 0) return { suffix: '', org: '', known: false };
    let suffixLen = 0;
    // An exception rule wins over every other match; the suffix is then the rule minus its first label.
    for (let i = 0; i < labels.length && !suffixLen; i++) {
        if (PSL.exceptions.has(labels.slice(i).join('.'))) suffixLen = labels.length - i - 1;
    }
    // Otherwise the longest matching rule, a wildcard "*.parent" matching any one label under parent.
    for (let i = 0; i < labels.length && !suffixLen; i++) {
        if (PSL.rules.has(labels.slice(i).join('.'))
            || (i + 1 < labels.length && PSL.wildcards.has(labels.slice(i + 1).join('.')))) suffixLen = labels.length - i;
    }
    const known = suffixLen > 0;
    if (!known) suffixLen = 1; // the implicit "*" rule
    return {
        suffix: labels.slice(-suffixLen).join('.'),
        org: labels.length > suffixLen ? labels.slice(-(suffixLen + 1)).join('.') : '',
        known,
    };
}

/** The organizational domain ('' when the domain is itself a public suffix). */
function organizationalDomain(domain) {
    return publicSuffixOf(domain).org;
}

const aligned = (a, b, mode) => {
    const x = String(a || '').toLowerCase().replace(/\.$/, ''), y = String(b || '').toLowerCase().replace(/\.$/, '');
    if (!x || !y) return false;
    if (x === y) return true;
    if (mode === 's') return false;
    // Relaxed: the same organizational domain, and only when the list KNOWS both suffixes.
    const px = publicSuffixOf(x), py = publicSuffixOf(y);
    return px.known && py.known && !!px.org && px.org === py.org;
};

function parseDmarc(txt) {
    if (!/^v\s*=\s*DMARC1\s*(;|$)/i.test(txt)) return null;
    const t = parseTags(txt);
    const pol = (v) => (['none', 'quarantine', 'reject'].includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);
    const p = pol(t.p);
    const pct = /^\d{1,3}$/.test(String(t.pct || '')) ? Math.min(Number(t.pct), 100) : 100;
    return {
        // §6.6.3: an invalid or missing p= with a valid rua is "none"; without one the record is ignored.
        p: p || (t.rua ? 'none' : null),
        sp: pol(t.sp),
        adkim: String(t.adkim || 'r').toLowerCase() === 's' ? 's' : 'r',
        aspf: String(t.aspf || 'r').toLowerCase() === 's' ? 's' : 'r',
        pct,
    };
}

async function findDmarcRecord(resolveTxt, fromDomain) {
    const org = organizationalDomain(fromDomain);
    for (const [name, atOrg] of [[fromDomain, false], ...(org && org !== fromDomain ? [[org, true]] : [])]) {
        const { records, error } = await txtRecords(resolveTxt, `_dmarc.${name}`);
        if (error) return { error };
        const parsed = records.map(parseDmarc).filter(Boolean);
        if (parsed.length > 1) return { record: null }; // §6.6.3: more than one record → none applies
        if (parsed.length === 1 && parsed[0].p) return { record: parsed[0], atOrg };
    }
    return { record: null };
}

const domainOf = (addr) => {
    const s = String(addr || '').trim().toLowerCase();
    const at = s.lastIndexOf('@');
    return at > 0 ? s.slice(at + 1).replace(/>$/, '') : '';
};

const MAX_FROM_DOMAINS = 10;
const DISPOSITION_RANK = { none: 0, quarantine: 1, reject: 2 };

/**
 * DMARC for one message. `fromDomains` is every domain in the header From. Returns
 * { result: pass|fail|none|temperror|permerror, domain, policy, disposition: none|quarantine|reject,
 *   reason, fromDomains? }.
 *
 * A From naming several domains (RFC 7489 §6.6.1) is evaluated against EACH of them and gets the
 * strictest outcome: any domain that fails decides the disposition (the strictest one wins), and a
 * message that fails none still never passes — no single domain speaks for the whole From, so the
 * result is permerror (accepted, but never shown as a verified sender). `fromFields` > 1 means the
 * message carried several From header FIELDS, which RFC 5322 forbids outright: refused.
 */
async function evaluateDmarc({ fromDomains, spfResult, envelopeFrom, dkim, resolveTxt, random = Math.random, fromFields = 1 }) {
    const domains = [...new Set((fromDomains || []).map(d => String(d || '').toLowerCase().replace(/\.$/, '')).filter(Boolean))];
    const base = { result: 'none', domain: domains[0] || '', policy: '', disposition: 'none', reason: '' };
    if (fromFields > 1) return Object.assign(base, { result: 'permerror', disposition: 'reject', reason: 'several From header fields' });
    if (domains.length === 0) return Object.assign(base, { result: 'permerror', reason: 'no From domain' });
    if (domains.length === 1) return evaluateDomain(domains[0], { spfResult, envelopeFrom, dkim, resolveTxt, random });
    if (domains.length > MAX_FROM_DOMAINS) {
        return Object.assign(base, { result: 'permerror', disposition: 'reject', reason: 'From names too many domains', fromDomains: domains.slice(0, MAX_FROM_DOMAINS) });
    }
    const each = [];
    for (const d of domains) each.push(await evaluateDomain(d, { spfResult, envelopeFrom, dkim, resolveTxt, random }));
    const failing = each.filter(r => r.result === 'fail')
        .sort((a, b) => DISPOSITION_RANK[b.disposition] - DISPOSITION_RANK[a.disposition]
            || DISPOSITION_RANK[b.policy || 'none'] - DISPOSITION_RANK[a.policy || 'none']);
    if (failing.length) {
        return Object.assign({}, failing[0], { reason: `From names several domains; ${failing[0].domain}: ${failing[0].reason}`, fromDomains: domains });
    }
    const temp = each.find(r => r.result === 'temperror');
    return Object.assign(base, {
        result: temp ? 'temperror' : 'permerror',
        reason: temp ? `From names several domains; ${temp.domain}: ${temp.reason}` : 'From names several domains',
        fromDomains: domains,
    });
}

async function evaluateDomain(fromDomain, { spfResult, envelopeFrom, dkim, resolveTxt, random }) {
    const out = { result: 'none', domain: fromDomain, policy: '', disposition: 'none', reason: '' };
    const found = await findDmarcRecord(resolveTxt, fromDomain);
    if (found.error) return Object.assign(out, { result: 'temperror', reason: 'record lookup failed' });
    if (!found.record) return out;
    const rec = found.record;
    const policy = found.atOrg && rec.sp ? rec.sp : rec.p;
    out.policy = policy;

    const envDomain = domainOf(envelopeFrom);
    const spfAligned = spfResult === 'pass' && aligned(envDomain, fromDomain, rec.aspf);
    const dkimAligned = (dkim || []).some(s => fullPass(s) && aligned(s.domain, fromDomain, rec.adkim));
    if (spfAligned || dkimAligned) {
        out.result = 'pass';
        out.reason = dkimAligned ? 'aligned DKIM' : 'aligned SPF';
        return out;
    }
    out.result = 'fail';
    out.reason = 'neither SPF nor DKIM is aligned with the From domain';
    let disposition = policy === 'reject' ? 'reject' : policy === 'quarantine' ? 'quarantine' : 'none';
    // §6.6.4: a message outside pct gets the next weaker treatment.
    if (disposition !== 'none' && rec.pct < 100 && random() * 100 >= rec.pct) {
        disposition = disposition === 'reject' ? 'quarantine' : 'none';
    }
    out.disposition = disposition;
    return out;
}

// --- one call for the inbound path -----------------------------------------------------------------

const clean = (v, max = 253) => String(v || '').replace(/[^\x21-\x7e]/g, '').replace(/[;()"\\]/g, '').slice(0, max);

/** RFC 8601 Authentication-Results value (without the field name). */
function buildAuthResults(receiver, { dkim, dmarc, spfResult, envelopeFrom }) {
    const parts = [clean(receiver) || 'wordjs'];
    if (!dkim || dkim.length === 0) parts.push('dkim=none');
    for (const s of dkim || []) {
        parts.push(`dkim=${s.result}${s.reason ? ` (${clean(s.reason.replace(/\s+/g, '-'), 60)})` : ''} header.d=${clean(s.domain)} header.s=${clean(s.selector, 63)}`);
    }
    if (spfResult) parts.push(`spf=${clean(spfResult, 12)} smtp.mailfrom=${clean(envelopeFrom, 320) || '<>'}`);
    if (dmarc) {
        const extra = dmarc.policy ? ` (p=${dmarc.policy} dis=${dmarc.disposition})` : '';
        // Every From domain when there were several, so a reader can tell the shown sender is one of them.
        const several = (dmarc.fromDomains || []).length > 1 ? ` (from=${dmarc.fromDomains.map(d => clean(d)).join(',')})` : '';
        parts.push(`dmarc=${dmarc.result}${extra}${several} header.from=${clean(dmarc.domain)}`);
    }
    return parts.join('; ').slice(0, 1000);
}

async function authenticateMessage(raw, { resolveTxt, spfResult = '', envelopeFrom = '', fromAddresses = null, receiver = '', now, random } = {}) {
    const msg = splitMessage(raw);
    const dkim = await verifyDkim(msg, { resolveTxt, now: now || Date.now() });
    // Counted on the raw message: a parser shows ONE of several From fields, and which one it picks is
    // not necessarily the one a DKIM signature (bottom-up) or another reader picks.
    const fromHeaders = msg.headers.filter(h => h.lname === 'from');
    const fromDomains = fromAddresses
        ? fromAddresses.map(domainOf)
        : fromHeaders.flatMap(h => (h.raw.slice(h.raw.indexOf(':') + 1).match(/[^\s<>,;:"@]+@[^\s<>,;:"]+/g) || []).map(domainOf));
    const dmarc = await evaluateDmarc({ fromDomains, spfResult, envelopeFrom, dkim, resolveTxt, random, fromFields: fromHeaders.length });
    return { dkim, dmarc, header: buildAuthResults(receiver, { dkim, dmarc, spfResult, envelopeFrom }) };
}

module.exports = {
    authenticateMessage, verifyDkim, evaluateDmarc, organizationalDomain, publicSuffixOf, splitMessage,
    canonHeader, canonBody, buildAuthResults, aligned, fullPass,
};

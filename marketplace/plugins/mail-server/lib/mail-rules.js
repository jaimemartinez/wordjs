/**
 * Per-user mail rules (server-side filters), blocked senders and templates — PURE functions.
 *
 * Everything here works on plain objects so it can run in the delivery path (inbound SMTP and
 * internal delivery) and be unit-tested without a database. The rules themselves live in the user's
 * prefs JSON (wjp_mail_server_user_prefs), written only through normalizePrefsPatch(), so whatever a
 * client posts is reduced to a bounded, typed shape before it is stored or evaluated.
 *
 * A rule never sends mail and never reaches another mailbox: its actions only set flags and labels
 * on the copy being delivered to its owner. Forwarding is a separate, explicit preference
 * (forwarding.address) so it can be rate-limited and shown to the user as such.
 */
'use strict';

const MAX_RULES = 50;
const MAX_CONDITIONS = 10;
const MAX_BLOCKED = 500;
const MAX_TEMPLATES = 30;

const FIELDS = ['from', 'to', 'subject', 'body', 'any'];
const OPS = ['contains', 'not_contains', 'equals', 'starts', 'ends'];

const str = (v, max) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const rid = () => Math.random().toString(36).slice(2, 10);

function normalizeCondition(c) {
    if (!c || typeof c !== 'object') return null;
    const field = FIELDS.includes(c.field) ? c.field : 'from';
    const op = OPS.includes(c.op) ? c.op : 'contains';
    const value = str(c.value, 200);
    if (!value) return null;
    return { field, op, value };
}

function normalizeRule(r) {
    if (!r || typeof r !== 'object') return null;
    const conditions = (Array.isArray(r.conditions) ? r.conditions : [])
        .slice(0, MAX_CONDITIONS).map(normalizeCondition).filter(Boolean);
    if (conditions.length === 0) return null;
    const a = (r.actions && typeof r.actions === 'object') ? r.actions : {};
    const labelId = parseInt(a.labelId, 10) || 0;
    const actions = {
        labelId: labelId > 0 ? labelId : 0,
        markRead: !!a.markRead,
        star: !!a.star,
        archive: !!a.archive,
        trash: !!a.trash,
        spam: !!a.spam,
        neverSpam: !!a.neverSpam,
        stop: !!a.stop,
    };
    // Contradictory pairs resolve to the safer one: never both spam and never-spam, never both
    // trash and archive (trash wins: it is the stronger, explicit choice).
    if (actions.spam && actions.neverSpam) actions.spam = false;
    if (actions.trash) actions.archive = false;
    return {
        id: str(r.id, 20) || rid(),
        name: str(r.name, 80) || conditions.map(c => c.value).join(', ').slice(0, 80),
        enabled: r.enabled !== false,
        match: r.match === 'any' ? 'any' : 'all',
        conditions,
        actions,
    };
}

function normalizeRules(list) {
    return (Array.isArray(list) ? list : []).slice(0, MAX_RULES).map(normalizeRule).filter(Boolean);
}

/** An address or a whole domain ("@example.com" / "example.com"), lower-cased; '' if neither. */
function normalizeSenderPattern(p) {
    let s = String(p == null ? '' : p).trim().toLowerCase();
    if (!s || s.length > 254 || /[\s,;<>"]/.test(s)) return '';
    if (s.includes('@')) {
        if (s.startsWith('@')) s = s.slice(1);
        else return /^[^@]+@[^@]+\.[^@]+$/.test(s) ? s : '';
    }
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? '@' + s : '';
}

function normalizeSenderList(list, max = MAX_BLOCKED) {
    const raw = Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/);
    const out = [];
    for (const p of raw) {
        const n = normalizeSenderPattern(p);
        if (n && !out.includes(n)) out.push(n);
        if (out.length >= max) break;
    }
    return out;
}

function senderMatches(address, patterns) {
    const a = String(address || '').trim().toLowerCase();
    if (!a || !Array.isArray(patterns) || patterns.length === 0) return false;
    const domain = a.slice(a.lastIndexOf('@') + 1);
    return patterns.some(p => p.startsWith('@')
        ? (domain === p.slice(1) || domain.endsWith('.' + p.slice(1)))
        : p === a);
}

function normalizeTemplates(list) {
    return (Array.isArray(list) ? list : []).slice(0, MAX_TEMPLATES).map(t => {
        if (!t || typeof t !== 'object') return null;
        const name = str(t.name, 80);
        const body = String(t.body == null ? '' : t.body).slice(0, 20000);
        if (!name || !body) return null;
        return { id: str(t.id, 20) || rid(), name, subject: str(t.subject, 200), body };
    }).filter(Boolean);
}

function normalizeForwarding(f) {
    const o = (f && typeof f === 'object') ? f : {};
    const address = String(o.address || '').trim().toLowerCase();
    const valid = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(address) && address.length <= 254;
    return {
        enabled: !!o.enabled && valid,
        address: valid ? address : '',
        keepCopy: o.keepCopy !== false,
    };
}

function fieldText(msg, field) {
    switch (field) {
        case 'from': return `${msg.fromName || ''} ${msg.from || ''}`;
        case 'to': return `${msg.to || ''} ${msg.cc || ''}`;
        case 'subject': return msg.subject || '';
        case 'body': return msg.text || '';
        default: return `${msg.fromName || ''} ${msg.from || ''} ${msg.to || ''} ${msg.cc || ''} ${msg.subject || ''} ${msg.text || ''}`;
    }
}

function conditionMatches(msg, c) {
    const hay = fieldText(msg, c.field).toLowerCase();
    const needle = c.value.toLowerCase();
    switch (c.op) {
        case 'not_contains': return !hay.includes(needle);
        case 'equals': return hay.trim() === needle || hay.split(/[\s,;<>]+/).includes(needle);
        case 'starts': return hay.trim().startsWith(needle);
        case 'ends': return hay.trim().endsWith(needle);
        default: return hay.includes(needle);
    }
}

function ruleMatches(msg, rule) {
    if (!rule || !rule.enabled) return false;
    const results = rule.conditions.map(c => conditionMatches(msg, c));
    return rule.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Decide how a copy delivered to ONE mailbox is filed.
 *
 * @param prefs  the owner's prefs ({rules, blockedSenders})
 * @param msg    {from, fromName, to, cc, subject, text, isSpam}
 * @param site   {blocked: [...patterns], allowed: [...patterns]} site-wide lists from the admin
 * @returns {{isRead, isStarred, isArchived, isTrash, isSpam, labelIds: number[], matched: string[], blocked: boolean}}
 */
function evaluateDelivery(prefs, msg, site = {}) {
    const out = {
        isRead: 0, isStarred: 0, isArchived: 0, isTrash: 0,
        isSpam: msg.isSpam ? 1 : 0, labelIds: [], matched: [], blocked: false,
    };
    // Site allowlist first: an admin-trusted sender is never filed as spam by the classifier.
    if (senderMatches(msg.from, site.allowed)) out.isSpam = 0;
    // The site blocklist is enforced at MAIL FROM for external senders; this catches the header From
    // (and internal mail), filing it as spam rather than dropping it.
    else if (senderMatches(msg.from, site.blocked)) {
        out.isSpam = 1;
        out.blocked = true;
        return out;
    }
    // A sender the USER blocked goes to their spam folder (reviewable, auto-purged after 30 days) —
    // the same behaviour as Gmail's "Block sender", and never a silent drop.
    if (senderMatches(msg.from, (prefs && prefs.blockedSenders) || [])) {
        out.isSpam = 1;
        out.blocked = true;
        return out;
    }
    for (const rule of normalizeRules(prefs && prefs.rules)) {
        if (!ruleMatches(msg, rule)) continue;
        out.matched.push(rule.id);
        const a = rule.actions;
        if (a.labelId && !out.labelIds.includes(a.labelId)) out.labelIds.push(a.labelId);
        if (a.markRead) out.isRead = 1;
        if (a.star) out.isStarred = 1;
        if (a.archive) out.isArchived = 1;
        if (a.trash) out.isTrash = 1;
        if (a.spam) out.isSpam = 1;
        if (a.neverSpam) out.isSpam = 0;
        if (a.stop) break;
    }
    return out;
}

module.exports = {
    MAX_RULES, MAX_BLOCKED, MAX_TEMPLATES,
    normalizeRules, normalizeRule, normalizeSenderList, normalizeSenderPattern, senderMatches,
    normalizeTemplates, normalizeForwarding, evaluateDelivery, ruleMatches,
};

#!/usr/bin/env node
/**
 * Re-record the InnerTube fixtures the youtube-videos listing tests replay (no network in CI).
 *
 *   node backend/src/tests/fixtures/youtube-videos/record.mjs [@handle-or-UC-id]
 *
 * It asks YouTube's web client API for: the handle's resolve_url answer, the first three pages of the
 * channel's Videos tab (the first page and two continuations) and the first page of its uploads
 * playlist. Each response keeps its real structure — renderer and view-model shapes, nesting,
 * continuation items — but is cut to a few videos and REDACTED: every video id, title, channel id,
 * channel name and continuation token is replaced by a synthetic value, and tracking/session fields
 * are dropped. Re-run it when YouTube changes its response shape and the tests should follow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const CHANNEL = process.argv[2] || '@GoogleDevelopers';
const KEEP = 4; // videos kept per page
const CLIENT = { clientName: 'WEB', clientVersion: '2.20251101.01.00', hl: 'en', gl: 'US' };
const FIXTURE_CHANNEL = 'UCrecordedFixtureChan01';
const DROP_KEYS = new Set(['responseContext', 'trackingParams', 'clickTrackingParams', 'loggingDirectives', 'frameworkUpdates', 'visitorData', 'serviceTrackingParams', 'mainAppWebResponseContext', 'webResponseContextExtensionData', 'microformat', 'sidebar', 'topbar', 'header', 'metadata_', 'onResponseReceivedCommands']);

async function innertube(endpoint, payload) {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context: { client: CLIENT }, ...payload }),
    });
    if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
    return res.json();
}

/** Keep the first KEEP video items of every item list (and the continuation item that ends it). */
function cut(node) {
    if (Array.isArray(node)) {
        const isItem = (x) => x && typeof x === 'object' && (x.richItemRenderer || x.lockupViewModel || x.playlistVideoRenderer);
        if (node.some(isItem)) {
            const items = node.filter(isItem).slice(0, KEEP);
            const cont = node.filter((x) => x && x.continuationItemRenderer);
            return [...items, ...cont].map(cut);
        }
        return node.map(cut);
    }
    if (node && typeof node === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(node)) if (!DROP_KEYS.has(k)) out[k] = cut(v);
        return out;
    }
    return node;
}

const ids = new Map();
const titles = new Map();
const tokens = new Map();
let channelName = '';

function remember(node) {
    if (Array.isArray(node)) return node.forEach(remember);
    if (!node || typeof node !== 'object') return;
    const lv = node.lockupViewModel;
    if (lv && lv.contentId) {
        if (!ids.has(lv.contentId)) ids.set(lv.contentId, `recVid${String(ids.size + 1).padStart(5, '0')}`);
        const t = lv.metadata?.lockupMetadataViewModel?.title?.content;
        if (t && !titles.has(t)) titles.set(t, `Recorded video ${titles.size + 1}`);
    }
    const tok = node.continuationCommand?.token;
    if (tok && !tokens.has(tok)) tokens.set(tok, `RECORDED_CONTINUATION_${tokens.size + 1}`);
    Object.values(node).forEach(remember);
}

function redact(obj, realChannelId) {
    let s = JSON.stringify(obj);
    const swap = (from, to) => { if (from) s = s.split(from).join(to); };
    for (const [from, to] of tokens) swap(from, to);
    for (const [from, to] of [...titles].sort((a, b) => b[0].length - a[0].length)) swap(JSON.stringify(from).slice(1, -1), to);
    for (const [from, to] of ids) swap(from, to);
    swap(realChannelId, FIXTURE_CHANNEL);
    swap(realChannelId.slice(2), FIXTURE_CHANNEL.slice(2));
    swap(channelName, 'Recorded Channel');
    return JSON.parse(s);
}

const resolved = CHANNEL.startsWith('UC') ? null : await innertube('navigation/resolve_url', { url: `https://www.youtube.com/${CHANNEL}` });
const channelId = CHANNEL.startsWith('UC') ? CHANNEL : resolved.endpoint.browseEndpoint.browseId;
const first = await innertube('browse', { browseId: channelId, params: 'EgZ2aWRlb3PyBgQKAjoA' });
channelName = first.metadata?.channelMetadataRenderer?.title || '';
/** The token of the last continuation item (the one that ends the video list). */
const tokenOf = (data) => {
    let token = '';
    const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== 'object') return;
        const t = n.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (t) token = t;
        Object.values(n).forEach(walk);
    };
    // Only the list itself: the opened tab, or a continuation's appended items.
    const tab = (data.contents?.twoColumnBrowseResultsRenderer?.tabs || []).map((t) => t.tabRenderer).find((t) => t?.selected);
    walk(data.onResponseReceivedActions || (tab && tab.content) || data);
    return token;
};
const second = await innertube('browse', { continuation: tokenOf(first) });
const third = await innertube('browse', { continuation: tokenOf(second) });
const uploads = await innertube('browse', { browseId: 'VLUU' + channelId.slice(2) });

const pages = {
    'resolve-url.json': resolved ? { endpoint: { browseEndpoint: resolved.endpoint.browseEndpoint } } : null,
    'videos-tab-1.json': cut(first),
    'videos-tab-2.json': cut(second),
    'videos-tab-3.json': cut(third),
    'uploads-playlist-1.json': cut(uploads),
};
// The last recorded page ends the list: its continuation item is removed.
const strip = (n) => (Array.isArray(n) ? n.filter((x) => !(x && x.continuationItemRenderer)).map(strip)
    : n && typeof n === 'object' ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, strip(v)])) : n);
pages['videos-tab-3.json'] = strip(pages['videos-tab-3.json']);
pages['uploads-playlist-1.json'] = strip(pages['uploads-playlist-1.json']);

/**
 * Last pass over every string: keep what the parser reads or what carries no identity (enum-like
 * values, durations, view counts, the synthetic values above, the "… ago" ages); anything else that
 * reads like free text (channel names, handles, descriptions, accessibility labels) is replaced.
 */
function scrub(node, key = '') {
    if (Array.isArray(node)) return node.map((x) => scrub(x, key));
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, scrub(v, k)]));
    if (typeof node !== 'string') return node;
    // Opaque base64 blobs encode real ids (share entities, entity keys, playlist context).
    if (/^serialized|EntityKey$|^entityKey$|^key$/.test(key)) return 'cmVkYWN0ZWQ=';
    if (/subscriber/i.test(node)) return 'Redacted text';
    let v = node.replace(/UC[0-9A-Za-z_-]{22}/g, (m) => (m === FIXTURE_CHANNEL ? m : 'UCredactedOtherChannel0'));
    v = v.replace(/https:\/\/yt3\.(?:ggpht|googleusercontent)\.com\/[^"\s]*/g, 'https://yt3.ggpht.com/redacted');
    v = v.replace(/@[A-Za-z0-9._-]+/g, '@recordedchannel');
    const keep = /^[A-Z0-9_]+$/.test(v) || /^recVid\d{5}$|^RECORDED_|^Recorded (video \d+|Channel)$/.test(v) || /\bago$/.test(v)
        || /^[\d:.,]+$/.test(v) || /^[\d.,]+[KMB]? views?$/i.test(v) || /^https?:\/\//.test(v) || /^\//.test(v)
        || ['contentId', 'contentType', 'token', 'browseId', 'params', 'apiUrl', 'iconName', 'imageName', 'targetId', 'style', 'type'].includes(key)
        || !/[a-z]{3,}\s+[a-z]/i.test(v);
    return keep ? v : 'Redacted text';
}

Object.values(pages).forEach(remember);
for (const [name, data] of Object.entries(pages)) {
    if (!data) continue;
    const { metadata, ...rest } = data; // the channel's own metadata (description, links): not needed
    const red = redact(rest, channelId);
    // Drop what the shape does not need and the redaction cannot vouch for (signed thumbnail URLs).
    const text = JSON.stringify(scrub(red)).replace(/"(https:\/\/i\.ytimg\.com\/vi\/[^"?]+)\?[^"]*"/g, '"$1"');
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(JSON.parse(text), null, 1) + '\n');
    console.log(name, text.length, 'bytes');
}
console.log('videos', ids.size, 'tokens', tokens.size);

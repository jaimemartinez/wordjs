/**
 * youtube-videos: the full channel listing (1.1.0).
 *
 * The plugin used to list a channel through its RSS feed, which only ever returns the latest 15
 * videos. It now pages the channel's Videos tab through YouTube's web client API (InnerTube browse +
 * continuation tokens), falls back to the uploads playlist and then to RSS, prefers the Data API when
 * a key is set, refreshes incrementally, and serves the list paginated.
 *
 * Every InnerTube answer below is a RECORDED response (fixtures/youtube-videos/, see record.mjs there):
 * real structure, redacted ids/titles/tokens. No test touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { bootPlugin, BootedPlugin } from './fixtures/marketplace-plugin-harness';

const FIX = path.join(__dirname, 'fixtures', 'youtube-videos');
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const CHANNEL = 'UCrecordedFixtureChan01';
const UPLOADS = 'VLUU' + CHANNEL.slice(2);
const VIDEOS_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';
const BROWSE = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';
const RESOLVE = 'https://www.youtube.com/youtubei/v1/navigation/resolve_url?prettyPrint=false';
const RSS = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`;
const API = 'https://www.googleapis.com/youtube/v3';
const tabIds = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `recVid${String(from + i).padStart(5, '0')}`);
const ALL_TAB = tabIds(1, 12);

const rssFeed = (ids: string[]) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">${
    ids.map((id, i) => `<entry><yt:videoId>${id}</yt:videoId><title>Recorded video ${parseInt(id.slice(6), 10)}</title><published>2026-0${1 + (i % 9)}-01T00:00:00+00:00</published></entry>`).join('')}</feed>`;

type Answer = { status?: number; body?: any; throws?: string } | undefined;
type Handler = (url: string, body: any) => Answer;

/** The recorded channel: resolve_url, three Videos-tab pages, the uploads playlist, and its feed. */
const recorded: Handler = (url, body) => {
    if (url === RESOLVE) return { body: load('resolve-url.json') };
    if (url === BROWSE) {
        if (body.browseId === CHANNEL && body.params === VIDEOS_PARAMS) return { body: load('videos-tab-1.json') };
        if (body.continuation === 'RECORDED_CONTINUATION_1') return { body: load('videos-tab-2.json') };
        if (body.continuation === 'RECORDED_CONTINUATION_2') return { body: load('videos-tab-3.json') };
        if (body.browseId === UPLOADS) return { body: load('uploads-playlist-1.json') };
    }
    if (url === RSS) return { body: rssFeed(['recVid00001', 'recVid00002']) };
    return undefined;
};

interface Call { url: string; body: any }

/** Replace global fetch: `handlers` answer in order (first defined answer wins), else 404. */
async function withFetch<T>(handlers: Handler[], fn: (calls: Call[]) => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    const calls: Call[] = [];
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
        const body = init && init.body ? JSON.parse(init.body) : null;
        calls.push({ url: String(url), body });
        let a: Answer;
        for (const h of handlers) { a = h(String(url), body); if (a) break; }
        if (a && a.throws) throw new TypeError(a.throws);
        const status = a ? (a.status || 200) : 404;
        const payload = a ? a.body : 'Not Found';
        return {
            ok: status >= 200 && status < 300, status,
            text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
            json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
        };
    };
    try { return await fn(calls); } finally { (globalThis as any).fetch = real; }
}

async function withYt(fn: (p: BootedPlugin) => Promise<void>) {
    const p = await bootPlugin('youtube-videos');
    try { await fn(p); } finally { p.close(); }
}

const admin = { id: 1, roles: ['administrator'] };
const save = (p: BootedPlugin, body: any) => p.call('post', '/settings', { body, user: admin }).then((r) => r.body);
const list = (p: BootedPlugin, query: any = {}) => p.call('get', '/', { query }).then((r) => r.body);
const idsOf = (l: any) => (l.videos || []).map((v: any) => v.id);
const browseCalls = (calls: Call[]) => calls.filter((c) => c.url === BROWSE);
const hosts = (calls: Call[]) => [...new Set(calls.map((c) => new URL(c.url).hostname))];

test('youtube-videos: without a key the whole Videos tab is listed, following every continuation', async () => {
    await withYt(async (p) => {
        await withFetch([recorded], async (calls) => {
            const s = await save(p, { channel: '@recordedchannel' });
            assert.strictEqual(s.error, null, String(s.error));
            assert.strictEqual(s.channelId, CHANNEL);
            assert.strictEqual(s.mode, 'full');
            assert.strictEqual(s.source, 'videos-tab');
            assert.strictEqual(s.videoCount, 12, 'all three recorded pages, not one');
            assert.strictEqual(s.partial, false);
            const l = await list(p, { limit: '50' });
            assert.deepStrictEqual(idsOf(l), ALL_TAB, 'newest first, in the order YouTube pages them');
            assert.strictEqual(l.videos[0].title, 'Recorded video 1');
            assert.match(l.videos[11].publishedText, /ago$/);
            assert.strictEqual(l.videos[0].thumb, 'https://i.ytimg.com/vi/recVid00001/maxresdefault.jpg');
            // The two newest take their exact dates from the feed; the rest keep YouTube's relative text.
            assert.ok(!Number.isNaN(Date.parse(l.videos[0].publishedAt)));
            assert.strictEqual(l.videos[5].publishedAt, '');
            // The pages were requested as continuations of each other, and nothing outside youtube.com.
            assert.deepStrictEqual(browseCalls(calls).map((c) => c.body.continuation || c.body.browseId),
                [CHANNEL, 'RECORDED_CONTINUATION_1', 'RECORDED_CONTINUATION_2']);
            assert.deepStrictEqual(hosts(calls), ['www.youtube.com']);
            assert.ok(calls.every((c) => !/\/videos$|\/@/.test(c.url)), 'read a channel HTML page');
        });
    });
});

test('youtube-videos: the public list is paginated with offset/limit and says where the next page starts', async () => {
    await withYt(async (p) => {
        await withFetch([recorded], async () => {
            await save(p, { channel: CHANNEL });
            const a = await list(p, { limit: '5' });
            assert.deepStrictEqual(idsOf(a), tabIds(1, 5));
            assert.strictEqual(a.total, 12);
            assert.strictEqual(a.nextOffset, 5);
            assert.strictEqual(a.hasMore, true);
            const b = await list(p, { limit: '5', offset: String(a.nextOffset) });
            assert.deepStrictEqual(idsOf(b), tabIds(6, 10));
            const c = await list(p, { limit: '5', offset: '10' });
            assert.deepStrictEqual(idsOf(c), tabIds(11, 12));
            assert.strictEqual(c.nextOffset, null);
            assert.strictEqual(c.hasMore, false);
            for (const bad of ['-3', 'x', '']) assert.deepStrictEqual(idsOf(await list(p, { limit: '2', offset: bad })), tabIds(1, 2), `offset=${bad}`);
            assert.strictEqual((await list(p, { limit: '9999' })).videos.length, 12, 'limit is capped, not refused');
        });
    });
});

test('youtube-videos: include / exclude filters (comma-separated, accent-insensitive) and order', async () => {
    await withYt(async (p) => {
        await withFetch([recorded], async () => {
            await save(p, { channel: CHANNEL });
            assert.deepStrictEqual(idsOf(await list(p, { q: 'video 1', limit: '50' })), ['recVid00001', 'recVid00010', 'recVid00011', 'recVid00012']);
            assert.deepStrictEqual(idsOf(await list(p, { q: 'vídeo 2, VIDEO 3', limit: '50' })), ['recVid00002', 'recVid00003']);
            assert.deepStrictEqual(idsOf(await list(p, { q: 'video 1', exclude: 'video 10,video 11', limit: '50' })), ['recVid00001', 'recVid00012']);
            const oldest = await list(p, { order: 'oldest', limit: '3' });
            assert.deepStrictEqual(idsOf(oldest), ['recVid00012', 'recVid00011', 'recVid00010']);
            const byTitle = await list(p, { order: 'title', limit: '3' });
            assert.deepStrictEqual(idsOf(byTitle), ['recVid00001', 'recVid00010', 'recVid00011']);
            assert.strictEqual((await list(p, { q: 'video 1', limit: '2' })).total, 4, 'total counts the filtered list');
        });
    });
});

test('youtube-videos: a refresh is incremental — one request, new videos on top, the rest kept', async () => {
    await withYt(async (p) => {
        await withFetch([recorded], async () => { await save(p, { channel: CHANNEL }); });
        // A new upload appears at the head of the first page.
        const page1 = load('videos-tab-1.json');
        // The first page now reads [new, 1, 2, 3]: every video moved one place down.
        let shifted = JSON.stringify(page1);
        for (const [from, to] of [['recVid00001', 'newUpload01'], ['recVid00002', 'recVid00001'], ['recVid00003', 'recVid00002'], ['recVid00004', 'recVid00003']]) shifted = shifted.split(from).join(to);
        const fresh = JSON.parse(shifted);
        const withNew: Handler = (url, body) => (url === BROWSE && body.browseId === CHANNEL ? { body: fresh } : undefined);
        await withFetch([withNew, recorded], async (calls) => {
            const s = (await p.call('post', '/refresh', { body: {}, user: admin })).body;
            assert.strictEqual(s.error, null, String(s.error));
            assert.strictEqual(browseCalls(calls).length, 1, 'paged past the first known video');
            const l = await list(p, { limit: '50' });
            assert.strictEqual(l.total, 13);
            assert.ok(idsOf(l).includes('newUpload01'));
            assert.deepStrictEqual(idsOf(l).slice(-8), tabIds(5, 12), 'older videos kept from the cache');
        });
        // { full: true } walks the whole channel again.
        await withFetch([recorded], async (calls) => {
            await p.call('post', '/refresh', { body: { full: true }, user: admin });
            assert.strictEqual(browseCalls(calls).length, 3);
            assert.deepStrictEqual(idsOf(await list(p, { limit: '50' })), ALL_TAB);
        });
    });
});

test('youtube-videos: the Videos tab failing falls back to the uploads playlist, then to RSS', async () => {
    const tabDown: Handler = (url, body) => (url === BROWSE && body.params === VIDEOS_PARAMS ? { status: 500, body: {} } : undefined);
    await withYt(async (p) => {
        await withFetch([tabDown, recorded], async () => {
            const s = await save(p, { channel: CHANNEL });
            assert.strictEqual(s.source, 'uploads-playlist');
            assert.strictEqual(s.mode, 'full');
            assert.deepStrictEqual(idsOf(await list(p, { limit: '50' })), ['recVid00001', 'recVid00013', 'recVid00002', 'recVid00003']);
            assert.match(String(s.error), /videos-tab: HTTP 500/, 'the admin sees why the first source was skipped');
        });
    });
    const innertubeDown: Handler = (url) => (url === BROWSE ? { status: 503, body: {} } : undefined);
    await withYt(async (p) => {
        await withFetch([innertubeDown, recorded], async () => {
            const s = await save(p, { channel: CHANNEL });
            assert.strictEqual(s.mode, 'rss');
            assert.deepStrictEqual(idsOf(await list(p)), ['recVid00001', 'recVid00002']);
        });
    });
});

test('youtube-videos: an answer without videos is not taken for an empty channel', async () => {
    const emptyTab: Handler = (url, body) => (url === BROWSE && body.params === VIDEOS_PARAMS
        ? { body: { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { richGridRenderer: { contents: [] } } } }] } } } }
        : undefined);
    await withYt(async (p) => {
        await withFetch([emptyTab, recorded], async () => {
            const s = await save(p, { channel: CHANNEL });
            assert.strictEqual(s.source, 'uploads-playlist');
            assert.strictEqual(s.videoCount, 4);
        });
    });
});

test('youtube-videos: with the keyless source switched off, only official sources are used', async () => {
    await withYt(async (p) => {
        await withFetch([recorded], async (calls) => {
            const s = await save(p, { channel: CHANNEL, keylessFull: false });
            assert.strictEqual(s.keylessFull, false);
            assert.strictEqual(s.mode, 'rss');
            assert.ok(!calls.some((c) => c.url.includes('/youtubei/')), 'called the web client API although it is off');
        });
    });
});

test('youtube-videos: a Data API key is preferred, and a failing key falls back to the keyless list', async () => {
    const uploads = 'UU' + CHANNEL.slice(2);
    const api: Handler = (url) => {
        if (url === `${API}/channels?part=contentDetails&id=${CHANNEL}&key=good-key`) return { body: { items: [{ contentDetails: { relatedPlaylists: { uploads } } }] } };
        if (url === `${API}/playlistItems?part=snippet&maxResults=50&playlistId=${uploads}&key=good-key`) {
            return { body: { nextPageToken: 'P2', items: [{ snippet: { resourceId: { videoId: 'apiVideo001' }, title: 'API 1', publishedAt: '2026-10-01T00:00:00Z', thumbnails: {} } }] } };
        }
        if (url === `${API}/playlistItems?part=snippet&maxResults=50&playlistId=${uploads}&pageToken=P2&key=good-key`) {
            return { body: { items: [{ snippet: { resourceId: { videoId: 'apiVideo002' }, title: 'API 2', publishedAt: '2026-09-01T00:00:00Z', thumbnails: {} } }] } };
        }
        if (url.startsWith(API) && url.includes('key=bad-key')) return { status: 403, body: { error: { message: 'The request cannot be completed because you have exceeded your quota.' } } };
        return undefined;
    };
    await withYt(async (p) => {
        await withFetch([api, recorded], async (calls) => {
            const s = await save(p, { channel: CHANNEL, apiKey: 'good-key' });
            assert.strictEqual(s.mode, 'api');
            assert.deepStrictEqual(idsOf(await list(p)), ['apiVideo001', 'apiVideo002']);
            assert.ok(!calls.some((c) => c.url.includes('/youtubei/')), 'used the web client API although a key works');
            assert.ok(!JSON.stringify(s).includes('good-key'), 'echoed the key');
        });
        await withFetch([api, recorded], async () => {
            const s = await save(p, { apiKey: 'bad-key' });
            assert.strictEqual(s.mode, 'full');
            assert.strictEqual(s.videoCount, 12);
            assert.match(String(s.error), /Data API: The request cannot be completed because you have exceeded your quota/);
        });
    });
});

test('youtube-videos: network errors keep the last good list and are reported, never thrown at visitors', async () => {
    await withYt(async (p) => {
        await withFetch([recorded], async () => { await save(p, { channel: CHANNEL }); });
        const down: Handler = () => ({ throws: 'getaddrinfo ENOTFOUND www.youtube.com' });
        await withFetch([down], async (calls) => {
            const s = (await p.call('post', '/refresh', { body: { full: true }, user: admin })).body;
            assert.match(String(s.error), /Network error reaching www\.youtube\.com: getaddrinfo ENOTFOUND/);
            assert.ok(calls.length > 1, 'retried');
        });
        // A full refresh drops the list first; a plain one keeps it through the outage.
        await withFetch([recorded], async () => { await p.call('post', '/refresh', { body: { full: true }, user: admin }); });
        await withFetch([() => ({ throws: 'socket hang up' })], async () => {
            const s = (await p.call('post', '/refresh', { body: {}, user: admin })).body;
            assert.ok(s.error, 'the failure is recorded');
            const r = await p.call('get', '/', { query: { limit: '50' } });
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(idsOf(r.body), ALL_TAB, 'the cached list is still served');
        });
    });
});

test('youtube-videos: a channel longer than one refresh may walk is continued at the next refresh', async () => {
    // An endless channel: every page holds four new videos and a continuation to the next.
    const pageTpl = JSON.stringify(load('videos-tab-2.json'));
    const endless: Handler = (url, body) => {
        if (url !== BROWSE) return undefined;
        const n = body.continuation ? parseInt(String(body.continuation).replace('PAGE_', ''), 10) : 0;
        if (!body.continuation && body.browseId !== CHANNEL) return undefined;
        let page = pageTpl.split('RECORDED_CONTINUATION_2').join(`PAGE_${n + 1}`);
        for (let i = 5; i <= 8; i++) page = page.split(`recVid0000${i}`).join(`e${String(n * 4 + i).padStart(10, '0')}`);
        return { body: JSON.parse(page) };
    };
    await withYt(async (p) => {
        await withFetch([endless, recorded], async (calls) => {
            const s = await save(p, { channel: CHANNEL });
            assert.strictEqual(browseCalls(calls).length, 200, 'stopped at the per-refresh page cap');
            assert.strictEqual(s.partial, true);
            assert.strictEqual(s.videoCount, 800);
            assert.match(String(s.error), /Page limit of one refresh reached/);
            calls.length = 0;
            const s2 = (await p.call('post', '/refresh', { body: {}, user: admin })).body;
            assert.strictEqual(browseCalls(calls)[1].body.continuation, 'PAGE_200', 'continued where the last refresh stopped');
            assert.ok(s2.videoCount > 800);
        });
    });
});

test('youtube-videos: every outbound request draws from one hourly budget', async () => {
    const pageTpl = JSON.stringify(load('videos-tab-2.json'));
    let served = 0;
    const endless: Handler = (url) => {
        if (url !== BROWSE) return undefined;
        served++;
        let page = pageTpl.split('RECORDED_CONTINUATION_2').join(`B_${served}`);
        for (let i = 5; i <= 8; i++) page = page.split(`recVid0000${i}`).join(`b${String(served * 4 + i).padStart(10, '0')}`);
        return { body: JSON.parse(page) };
    };
    await withYt(async (p) => {
        await withFetch([endless, recorded], async (calls) => {
            // Each full pass stops at the 200-page cap; the third one runs into the hourly budget.
            await save(p, { channel: CHANNEL });
            for (let i = 0; i < 2; i++) await p.call('post', '/refresh', { body: { full: true }, user: admin });
            const before = calls.length;
            assert.ok(before <= 600, `made ${before} requests in one hour`);
            const s = (await p.call('post', '/refresh', { body: { full: true }, user: admin })).body;
            assert.ok(calls.length <= 600, `made ${calls.length} requests in one hour`);
            assert.strictEqual(calls.length, before, 'kept calling YouTube after the budget ran out');
            assert.match(String(s.error), /request budget/i);
        });
    });
});

// ---- original titles -----------------------------------------------------------------------------
// YouTube lists a video under its title in the REQUESTED interface language when the creator added a
// translation (or YouTube auto-translates it). 1.1.0 always asked in English, so a Spanish channel
// with English translations showed English titles. The feed carries the originals; the plugin asks in
// the language whose titles match them, and keeps that language with the list.

/** The recorded channel, where every language but `original` gets translated titles. */
const translatedUnless = (original: string): Handler => (url, body) => {
    if (url !== BROWSE || !body) return undefined;
    const hl = body.context && body.context.client && body.context.client.hl;
    const a = recorded(url, body);
    if (!a || hl === original) return a;
    return { body: JSON.parse(JSON.stringify(a.body).replace(/Recorded video (\d+)/g, `Translated to ${hl} $1`)) };
};

test('youtube-videos: titles are the originals — the list is asked in the language that gives them', async () => {
    await withYt(async (p) => {
        await withFetch([translatedUnless('es'), recorded], async (calls) => {
            const s = await save(p, { channel: CHANNEL });
            assert.strictEqual(s.error, null, String(s.error));
            assert.strictEqual(s.titleLanguage, 'es');
            const l = await list(p, { limit: '50' });
            assert.deepStrictEqual(l.videos.map((v: any) => v.title), ALL_TAB.map((_, i) => `Recorded video ${i + 1}`),
                'a translated title reached the list');
            // en was tried and refused (its titles do not match the feed); every page after it is asked in es.
            const tab = browseCalls(calls);
            assert.deepStrictEqual(tab.map((c) => c.body.context.client.hl), ['en', 'es', 'es', 'es']);
        });
        // The language is remembered: an incremental refresh asks in es straight away, one request.
        await withFetch([translatedUnless('es'), recorded], async (calls) => {
            await p.call('post', '/refresh', { body: {}, user: admin });
            assert.deepStrictEqual(browseCalls(calls).map((c) => c.body.context.client.hl), ['es']);
        });
    });
});

test('youtube-videos: the site language is tried first, and the newest titles come from the feed whatever happens', async () => {
    await withYt(async (p) => {
        p.options.set('WPLANG', 'pt_BR');
        await withFetch([translatedUnless('pt'), recorded], async (calls) => {
            const s = await save(p, { channel: CHANNEL });
            assert.strictEqual(s.titleLanguage, 'pt');
            assert.strictEqual(browseCalls(calls).length, 3, 'a language probe beyond the site language');
        });
    });
    // No language gives the originals (titles changed after upload, say): the feed's titles still win
    // for the videos it lists.
    await withYt(async (p) => {
        await withFetch([translatedUnless('none'), recorded], async () => {
            await save(p, { channel: CHANNEL });
            const l = await list(p, { limit: '3' });
            assert.deepStrictEqual(l.videos.map((v: any) => v.title).slice(0, 2), ['Recorded video 1', 'Recorded video 2']);
        });
    });
});

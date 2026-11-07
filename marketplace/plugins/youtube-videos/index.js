/**
 * WordJS Plugin: YouTube Videos
 *
 * Fetches a channel's videos (id, title, link, thumbnail, date) and serves them from a cached list to
 * a public, paginated endpoint the Verso block and the admin page consume.
 *
 * Where the list comes from, first source that answers wins:
 *  1. Data API v3, when the admin saved a key: the channel's uploads playlist, 50 per page. It is
 *     YouTube's official interface, so a key always takes precedence.
 *  2. Without a key, YouTube's web client API (InnerTube, `youtubei/v1/browse`) — the JSON interface
 *     youtube.com's own pages page through: the channel's Videos tab, followed through its
 *     continuation tokens, so the WHOLE upload history is listed, not the latest 15. When the Videos
 *     tab answers nothing, the uploads playlist (VLUU…) is paged the same way. The admin can switch
 *     this source off in the panel (it is not a documented, public interface; see the README).
 *  3. The channel RSS feed (latest 15), only when everything above failed.
 * The channel's public HTML page is read only to resolve an @handle that the resolver endpoint could
 * not, never for the list: its markup is not an interface.
 *
 * Cost control: each refresh is INCREMENTAL — it pages from the newest video until it reaches one
 * already cached, so a routine refresh costs one request — with a full resync once a day (catches
 * deletions). Every outbound request draws from a per-plugin hourly budget and a per-refresh page cap;
 * a refresh that runs out keeps what it has, remembers where it stopped and continues next time.
 * Public requests on a stale list are answered from the cache while it refreshes in the background.
 *
 * Secret handling: the API key and the cached list live in the plugin's OWN wjp_ table, NOT in
 * options — options share one global namespace readable by any plugin holding settings:read, and the
 * host blocks secret-named option keys outright (PROTECTED_OPTION_RE). The channel and the cache TTL
 * are not secrets, so those live in options.
 */

exports.metadata = {
    name: 'YouTube Videos',
    version: '1.1.1',
    description: 'Full channel video list (links, thumbnails, titles) + Verso carousel block',
    author: 'WordJS',
};

const OPT_CHANNEL = 'youtube_videos_channel';
const OPT_CACHE_LEGACY = 'youtube_videos_cache'; // ≤ 1.0.5 kept the list in options; cleared at init
const OPT_CACHE_TTL = 'youtube_videos_cache_ttl';
const OPT_KEYLESS = 'youtube_videos_keyless_full'; // false = without a key, RSS only
const SETTINGS_TABLE = 'wjp_youtube_videos_settings';

const MAX_VIDEOS = 5000;               // the list never grows past this many videos
const MAX_PAGES_PER_REFRESH = 200;     // ~6000 videos at InnerTube's 30 per page, 10000 via the Data API
const REQUEST_BUDGET_PER_HOUR = 600;   // every outbound request of this plugin, sliding window
const FULL_RESYNC_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const REPLY_WITHIN_MS = 20000;         // admin routes answer by then; the refresh carries on behind them
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 200;

const YT = 'https://www.youtube.com';
const GAPI = 'https://www.googleapis.com/youtube/v3';
// The web client InnerTube expects. YouTube accepts older versions for a long time; when it refuses
// this one (HTTP 400), the version youtube.com currently serves is read from its home page once.
const WEB_CLIENT = { clientName: 'WEB', clientVersion: '2.20251101.01.00', hl: 'en', gl: 'US' };
// The browse "params" that open a channel's Videos tab (the protobuf youtube.com itself sends).
const VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';

// ---- channel page parsing ------------------------------------------------------------------------
// A channel page also embeds the ids of OTHER channels — featured channels, shelves, collaborators —
// as "channelId" and "browseId" values, and the first of them is often not the page's own channel.
// So only signals that describe the page itself are read, most authoritative first, and a page that
// carries none of them is refused rather than guessed at.
const UC_ID = 'UC[0-9A-Za-z_-]{20,}';
const UC_RE = new RegExp(`^${UC_ID}$`);

/** The ytInitialData object a youtube.com page embeds, or null. */
function readInitialData(html) {
    // The assignment ends its <script>. A lazy `\{[\s\S]*?\};` alone stops at the first `};`, which a
    // title or a description can contain.
    const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

/** The tab a browse response opened (Home, Videos…), or null. */
function selectedTab(data) {
    const r = data && data.contents && data.contents.twoColumnBrowseResultsRenderer;
    for (const t of (r && r.tabs) || []) {
        const tab = t && (t.tabRenderer || t.expandableTabRenderer);
        if (tab && tab.selected) return tab;
    }
    return null;
}

/** Every `<tag …>` whose attributes include name="value" (any order, either quote). */
function tagsWith(html, tag, name, value) {
    const attr = new RegExp(`\\b${name}\\s*=\\s*["']${value}["']`, 'i');
    return (html.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi')) || []).filter((t) => attr.test(t));
}

/** The page's OWN channel id, or '' — never the id of a channel the page merely links to. */
function ownChannelId(html, data) {
    // 1. <link rel="canonical" href="https://www.youtube.com/channel/UC…">
    for (const t of tagsWith(html, 'link', 'rel', 'canonical')) {
        const m = t.match(new RegExp(`\\bhref\\s*=\\s*["'][^"']*/channel/(${UC_ID})(?:[/?#][^"']*)?["']`, 'i'));
        if (m) return m[1];
    }
    // 2. The channel metadata's externalId: read from ytInitialData when it parses, else from the raw
    //    page as long as every "externalId" on it names the same channel.
    const meta = data && data.metadata && data.metadata.channelMetadataRenderer;
    if (meta && UC_RE.test(meta.externalId || '')) return meta.externalId;
    const external = new Set((html.match(new RegExp(`"externalId":"${UC_ID}"`, 'g')) || []).map((s) => s.slice(14, -1)));
    if (external.size === 1) return [...external][0];
    // 3. <meta itemprop="identifier" content="UC…"> (older pages: itemprop="channelId").
    for (const t of [...tagsWith(html, 'meta', 'itemprop', 'identifier'), ...tagsWith(html, 'meta', 'itemprop', 'channelId')]) {
        const m = t.match(new RegExp(`\\bcontent\\s*=\\s*["'](${UC_ID})["']`, 'i'));
        if (m) return m[1];
    }
    // 4. The channel header, and the browseId of the tab the page opened — both belong to the page's
    //    channel (the "browseId"s of featured channels and shelves sit elsewhere in the tree).
    const header = data && data.header && data.header.c4TabbedHeaderRenderer;
    if (header && UC_RE.test(header.channelId || '')) return header.channelId;
    const tab = selectedTab(data);
    const browseId = tab && tab.endpoint && tab.endpoint.browseEndpoint && tab.endpoint.browseEndpoint.browseId;
    if (UC_RE.test(browseId || '')) return browseId;
    return '';
}

// ---- InnerTube response parsing --------------------------------------------------------------------
const VIDEO_ID_RE = /^[0-9A-Za-z_-]{11}$/;
const textOf = (t) => {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t.content === 'string') return t.content;
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (Array.isArray(t.runs)) return t.runs.map((r) => (r && r.text) || '').join('');
    return '';
};
const thumbFor = (id) => `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
const watchUrl = (id) => `${YT}/watch?v=${id}`;

/**
 * The relative age of a lockup ("3 days ago", "hace 3 días"…; InnerTube gives no absolute date), or ''.
 * It is the last part of the last metadata row that has several parts ("views • age"): the text is in
 * the language the list was asked in, so it is found by position, not by an English word.
 */
function lockupAge(lockup) {
    const rows = (((lockup.metadata || {}).lockupMetadataViewModel || {}).metadata || {}).contentMetadataViewModel;
    const list = ((rows && rows.metadataRows) || []).slice().reverse();
    for (const row of list) {
        const parts = (row && row.metadataParts) || [];
        if (parts.length >= 2) return textOf(parts[parts.length - 1] && parts[parts.length - 1].text).trim();
    }
    return '';
}

/**
 * The videos and the continuation token in an InnerTube subtree, in document order. Reads both the
 * lockup shape youtube.com serves now and the older *VideoRenderer shapes; a video renderer is not
 * descended into, and only VIDEO lockups count (a playlist or a channel lockup is skipped).
 */
function collectVideos(node) {
    const videos = [];
    let next = '';
    const seen = new Set();
    const push = (id, title, publishedText) => {
        if (!VIDEO_ID_RE.test(id || '') || seen.has(id)) return;
        seen.add(id);
        videos.push({ id, title: title || '', url: watchUrl(id), thumb: thumbFor(id), publishedAt: '', publishedText: publishedText || '' });
    };
    const walk = (n, depth) => {
        if (!n || typeof n !== 'object' || depth > 40) return;
        if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
        for (const key of Object.keys(n)) {
            const v = n[key];
            if (!v || typeof v !== 'object') continue;
            if (key === 'lockupViewModel') {
                if (v.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
                    push(v.contentId, textOf((((v.metadata || {}).lockupMetadataViewModel) || {}).title), lockupAge(v));
                }
                continue;
            }
            if (key === 'videoRenderer' || key === 'gridVideoRenderer' || key === 'playlistVideoRenderer') {
                push(v.videoId, textOf(v.title), textOf(v.publishedTimeText));
                continue;
            }
            if (key === 'continuationItemRenderer') {
                const ep = v.continuationEndpoint || {};
                const cmd = ep.continuationCommand
                    || ((((ep.commandExecutorCommand || {}).commands) || []).map((c) => c && c.continuationCommand).find(Boolean));
                if (cmd && typeof cmd.token === 'string' && cmd.token) next = cmd.token;
                continue;
            }
            walk(v, depth + 1);
        }
    };
    walk(node, 0);
    return { videos, next };
}

/** The part of a browse response that holds the list: the opened tab, or a continuation's items. */
function listRoot(data) {
    if (!data || typeof data !== 'object') return null;
    const actions = [...(data.onResponseReceivedActions || []), ...(data.onResponseReceivedEndpoints || [])];
    const appended = actions.map((a) => a && (a.appendContinuationItemsAction || a.reloadContinuationItemsCommand)).filter(Boolean);
    if (appended.length) return appended.map((a) => a.continuationItems || []);
    const tab = selectedTab(data);
    if (tab) return tab.content || null;
    const tabs = (data.contents && data.contents.twoColumnBrowseResultsRenderer && data.contents.twoColumnBrowseResultsRenderer.tabs) || [];
    return tabs[0] && tabs[0].tabRenderer ? tabs[0].tabRenderer.content : null;
}

class BudgetExhausted extends Error {}
class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu } = wordjs;

    // ---- plugin-private storage (API key, cached list) --------------------------------------------
    await db.run(`CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (name TEXT PRIMARY KEY, value TEXT)`);
    const getSetting = async (name) => {
        const row = await db.get(`SELECT value FROM ${SETTINGS_TABLE} WHERE name = ?`, [name]);
        return row ? row.value : '';
    };
    // NOTE: `ON CONFLICT ... DO UPDATE SET` trips the host SQL guard (its table-attribution regex
    // reads the token after `UPDATE` as a table name), so the upsert is a guard-safe
    // UPDATE-then-INSERT. Admin/refresh path, serialized by the single-flight refresh.
    const setSetting = async (name, value) => {
        const v = String(value == null ? '' : value);
        const r = await db.run(`UPDATE ${SETTINGS_TABLE} SET value = ? WHERE name = ?`, [v, name]);
        if (!r || r.changes === 0) {
            await db.run(`INSERT INTO ${SETTINGS_TABLE} (name, value) VALUES (?, ?)`, [name, v]);
        }
    };

    // The list is read on every public request, so it is kept in memory and written through.
    let cacheMemo;
    const readCache = async () => {
        if (cacheMemo !== undefined) return cacheMemo;
        let c = {};
        try { c = JSON.parse((await getSetting('cache')) || '{}') || {}; } catch { c = {}; }
        cacheMemo = c && typeof c === 'object' ? c : {};
        return cacheMemo;
    };
    const writeCache = async (c) => {
        cacheMemo = c || {};
        await setSetting('cache', JSON.stringify(cacheMemo));
    };
    if ((await options.get(OPT_CACHE_LEGACY, null)) != null) await options.set(OPT_CACHE_LEGACY, null);

    const keylessFullEnabled = async () => {
        const v = await options.get(OPT_KEYLESS, true);
        return !(v === false || v === 0 || v === '0' || v === 'false');
    };

    // ---- outbound requests: budget, timeout, one retry --------------------------------------------
    const spent = []; // timestamps of this process' outbound requests in the last hour
    const takeBudget = () => {
        const now = Date.now();
        while (spent.length && now - spent[0] > 60 * 60 * 1000) spent.shift();
        if (spent.length >= REQUEST_BUDGET_PER_HOUR) throw new BudgetExhausted('Hourly request budget used up; the list continues at the next refresh');
        spent.push(now);
    };
    const budgetLeft = () => {
        const now = Date.now();
        return REQUEST_BUDGET_PER_HOUR - spent.filter((t) => now - t <= 60 * 60 * 1000).length;
    };

    const request = async (url, init = {}) => {
        let lastErr;
        for (let attempt = 0; attempt < 2; attempt++) {
            takeBudget();
            let res;
            try {
                const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
                res = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
            } catch (e) {
                // DNS, refused connection, timeout, egress denied: the message names the cause.
                lastErr = new Error(`Network error reaching ${new URL(url).hostname}: ${(e && e.message) || e}`);
                if (attempt === 0) { await new Promise((r) => setTimeout(r, 750)); continue; }
                throw lastErr;
            }
            if (res.ok) return res;
            lastErr = new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).hostname}`);
            lastErr.res = res;
            // Only a server-side or rate-limit failure is worth one retry; 4xx answers will not change.
            if ((res.status >= 500 || res.status === 429) && attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
            throw lastErr;
        }
        throw lastErr;
    };

    const decodeXml = (s) => String(s || '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

    const fetchText = async (url) => {
        const res = await request(url, { headers: { 'user-agent': 'Mozilla/5.0 (WordJS youtube-videos plugin)' } });
        return res.text();
    };
    const fetchJson = async (url) => {
        try {
            const res = await request(url);
            return await res.json();
        } catch (e) {
            if (e instanceof HttpError && e.res) {
                // Surface Google's error message (quota, invalid key…) — it is the actionable part.
                const body = await e.res.json().catch(() => ({}));
                if (body && body.error && body.error.message) throw new HttpError(e.status, body.error.message);
            }
            throw e;
        }
    };

    let clientVersion = WEB_CLIENT.clientVersion;
    let versionProbed = false;
    const innertube = async (endpoint, payload, hl = WEB_CLIENT.hl) => {
        const call = () => request(`${YT}/youtubei/v1/${endpoint}?prettyPrint=false`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-youtube-client-name': '1',
                'x-youtube-client-version': clientVersion,
                'user-agent': 'Mozilla/5.0 (WordJS youtube-videos plugin)',
            },
            body: JSON.stringify({ context: { client: { ...WEB_CLIENT, clientVersion, hl } }, ...payload }),
        }).then((r) => r.json());
        try {
            return await call();
        } catch (e) {
            if (!(e instanceof HttpError) || e.status !== 400 || versionProbed) throw e;
            versionProbed = true;
            const html = await fetchText(`${YT}/`).catch(() => '');
            const v = (html.match(/"INNERTUBE_CLIENT_VERSION":"([0-9.]+)"/) || [])[1];
            if (!v || v === clientVersion) throw e;
            clientVersion = v;
            return call();
        }
    };

    /**
     * Accepts a channel in any common shape — "UC…" id, "@handle", or a URL (youtube.com/channel/UC…,
     * /@handle, /c/name, /user/name) — and resolves it to the UC… channel id: through the Data API when
     * a key exists, else InnerTube's URL resolver, else the public channel page — its own id, never
     * the first "channelId" on it (see ownChannelId).
     */
    const resolveChannelId = async (input, apiKey, keyless) => {
        const raw = String(input || '').trim();
        if (!raw) throw new Error('No channel configured');
        const direct = raw.match(/\b(UC[0-9A-Za-z_-]{20,})\b/);
        if (direct) return direct[1];
        const handleMatch = raw.match(/@([\w.-]+)/) || (!raw.includes('/') ? [null, raw] : null);
        const legacyPath = !handleMatch && raw.match(/youtube\.com\/((?:c|user)\/[\w.-]+)/i);
        if (!handleMatch && !legacyPath) throw new Error(`Could not understand the channel "${raw}" — use a UC… id, @handle or channel URL`);
        const label = handleMatch ? `@${handleMatch[1]}` : legacyPath[1];
        const pageUrl = handleMatch ? `${YT}/@${encodeURIComponent(handleMatch[1])}` : `${YT}/${legacyPath[1]}`;
        if (apiKey && handleMatch) {
            try {
                const data = await fetchJson(`${GAPI}/channels?part=id&forHandle=${encodeURIComponent('@' + handleMatch[1])}&key=${encodeURIComponent(apiKey)}`);
                const id = data.items && data.items[0] && data.items[0].id;
                if (id) return id;
                throw new Error(`No channel found for @${handleMatch[1]}`);
            } catch (e) {
                if (!keyless || e instanceof BudgetExhausted) throw e;
            }
        }
        if (keyless) {
            try {
                const r = await innertube('navigation/resolve_url', { url: pageUrl });
                const id = r && r.endpoint && r.endpoint.browseEndpoint && r.endpoint.browseEndpoint.browseId;
                if (UC_RE.test(id || '')) return id;
            } catch (e) {
                if (e instanceof BudgetExhausted) throw e;
            }
        }
        const html = await fetchText(pageUrl);
        const id = ownChannelId(html, readInitialData(html));
        if (!id) throw new Error(`Could not find the channel id of ${label} on its YouTube page (add a Data API key, or configure the UC… channel id)`);
        return id;
    };

    // ---- sources: each one is a pager { first(), next(token) } → { videos, next } ------------------
    // `hl` is the interface language YouTube answers in. It matters for TITLES: a video whose creator
    // added translations (or that YouTube auto-translates) is listed under the title in `hl`, not under
    // its original one — so the list is asked in the channel's own language (see originalLanguage).
    const innertubeFirst = (browseId, params) => async (hl) => collectVideos(listRoot(await innertube('browse', params ? { browseId, params } : { browseId }, hl)));
    const innertubePager = (first, hl, prefetched = null) => {
        let pending = prefetched;
        return {
            hl,
            first: async () => { if (pending) { const p = pending; pending = null; return p; } return first(hl); },
            next: async (token) => collectVideos(listRoot(await innertube('browse', { continuation: token }, hl))),
        };
    };

    const sameTitle = (a, b) => String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();
    const LANGUAGE_CANDIDATES = ['en', 'es', 'pt', 'fr', 'de', 'it'];
    const MAX_LANGUAGE_TRIES = 4;
    /**
     * The interface language in which YouTube lists this channel under its ORIGINAL titles, and the
     * first page fetched in it. The RSS feed always carries the original titles, so the first page is
     * asked in candidate languages (the site's first) until its titles match the feed's for the videos
     * both show. Nothing to compare against (no feed): the first candidate. Nothing matches fully: the
     * best match. Costs one request per language tried; the answer is kept with the list.
     */
    const originalLanguage = async (fetchFirst, originals) => {
        const site = String((await options.get('WPLANG', '')) || '').slice(0, 2).toLowerCase();
        const candidates = [...new Set([site, ...LANGUAGE_CANDIDATES].filter((l) => /^[a-z]{2}$/.test(l)))].slice(0, MAX_LANGUAGE_TRIES);
        let best = null;
        for (const hl of candidates) {
            const page = await fetchFirst(hl);
            const shared = page.videos.filter((v) => originals.has(v.id));
            const score = shared.filter((v) => sameTitle(v.title, originals.get(v.id))).length;
            if (!shared.length || score === shared.length) return { hl, page };
            if (!best || score > best.score) best = { hl, page, score };
        }
        return best;
    };

    const apiPager = (uploads, apiKey) => {
        const page = async (token) => {
            const data = await fetchJson(`${GAPI}/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(uploads)}`
                + (token ? `&pageToken=${encodeURIComponent(token)}` : '') + `&key=${encodeURIComponent(apiKey)}`);
            const videos = [];
            for (const item of data.items || []) {
                const sn = item.snippet || {};
                const id = sn.resourceId && sn.resourceId.videoId;
                if (!id) continue;
                const t = sn.thumbnails || {};
                const thumb = (t.maxres || t.standard || t.high || t.medium || t.default || {}).url || thumbFor(id);
                videos.push({ id, title: sn.title || '', url: watchUrl(id), thumb, publishedAt: sn.publishedAt || '', publishedText: '' });
            }
            return { videos, next: data.nextPageToken || '' };
        };
        return { first: () => page(''), next: (token) => page(token) };
    };

    const fetchRss = async (channelId) => {
        const xml = await fetchText(`${YT}/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
        const videos = [];
        const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
        for (const entry of entries) {
            const id = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
            const title = decodeXml((entry.match(/<title>([^<]*)<\/title>/) || [])[1]);
            const rssThumb = (entry.match(/<media:thumbnail url="([^"]+)"/) || [])[1];
            const thumb = rssThumb ? rssThumb.replace('hqdefault.jpg', 'maxresdefault.jpg') : (id ? thumbFor(id) : '');
            const publishedAt = (entry.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
            if (id) videos.push({ id, title, url: watchUrl(id), thumb, publishedAt, publishedText: '' });
        }
        return videos;
    };

    /**
     * Page `pager` from the newest video. With `known` (the ids already cached) it stops at the first
     * known one; with `resume` it continues an earlier, interrupted pass from that token instead.
     * Returns what it collected even when a page fails or the budget runs out (`error` says why, and
     * `next` is where to continue).
     */
    const runPager = async (pager, { known = null, resume = '', onPage = null } = {}) => {
        const videos = [];
        const ids = new Set();
        let next = '';
        let pages = 0;
        let reachedKnown = false;
        try {
            let page = resume ? await pager.next(resume) : await pager.first();
            for (;;) {
                pages++;
                for (const v of page.videos) {
                    if (known && known.has(v.id)) { reachedKnown = true; break; }
                    if (!ids.has(v.id)) { ids.add(v.id); videos.push(v); }
                }
                next = page.next;
                if (onPage) await onPage(videos, next, pages);
                if (reachedKnown || !next || videos.length >= MAX_VIDEOS) break;
                if (pages >= MAX_PAGES_PER_REFRESH) throw new BudgetExhausted('Page limit of one refresh reached; the list continues at the next refresh');
                page = await pager.next(next);
            }
            return { videos, next: reachedKnown || videos.length >= MAX_VIDEOS ? '' : next, reachedKnown, error: null, pages };
        } catch (e) {
            if (!videos.length && !(e instanceof BudgetExhausted)) throw e;
            return { videos, next, reachedKnown, error: e, pages };
        }
    };

    const merge = (...lists) => {
        const out = [];
        const seen = new Set();
        for (const list of lists) for (const v of list || []) {
            if (!v || seen.has(v.id)) continue;
            seen.add(v.id);
            out.push(v);
            if (out.length >= MAX_VIDEOS) return out;
        }
        return out;
    };

    /**
     * Refresh `prev` from one paged source. Incremental when the cache holds the same channel from the
     * same source and the last full pass is under a day old; a pass that was interrupted is continued.
     */
    const refreshFrom = async (source, pager, channelId, prev) => {
        const sameList = prev.channelId === channelId && prev.source === source && Array.isArray(prev.videos) && prev.videos.length > 0;
        const incremental = sameList && ((prev.fullAt && (Date.now() - prev.fullAt) < FULL_RESYNC_MS) || prev.resume);
        if (!incremental) {
            // A first pass over a big channel takes longer than one request may (the host recycles a
            // plugin whose reply takes 30 s), so it runs in the background and checkpoints: the list
            // so far, and the token to continue from if the process stops before the end.
            const r = await runPager(pager, {
                onPage: async (videos, next, pages) => {
                    progress.videos = videos.length;
                    if (pages === 1 || pages % 10 === 0) {
                        await writeCache({ ...prev, videos: merge(videos, sameList ? prev.videos : []), channelId, source, mode: source === 'api' ? 'api' : 'full',
                            fetchedAt: prev.fetchedAt || Date.now(), fullAt: prev.fullAt || 0, resume: next || '', partial: !!next, error: null, hl: pager.hl || '' });
                    }
                },
            });
            if (!r.videos.length && !r.error) return null; // the source answered an empty list
            return {
                videos: r.error && sameList ? merge(r.videos, prev.videos) : r.videos,
                fullAt: r.next ? (prev.fullAt || 0) : Date.now(),
                resume: r.next || '',
                partial: !!r.next,
                note: r.error ? String(r.error.message || r.error) : null,
            };
        }
        const head = await runPager(pager, { known: new Set(prev.videos.map((v) => v.id)) });
        let videos = merge(head.videos, prev.videos);
        let resume = prev.resume || '';
        let note = head.error ? String(head.error.message || head.error) : null;
        if (!head.reachedKnown && !head.error && head.videos.length) {
            // More new videos than one pass reached without meeting a cached one: resync from scratch.
            return refreshFrom(source, pager, channelId, { ...prev, fullAt: 0, resume: '' });
        }
        if (resume && !note && budgetLeft() > 0) {
            // Continue the pass an earlier refresh could not finish.
            const tail = await runPager(pager, { resume, known: new Set(videos.map((v) => v.id)) }).catch((e) => ({ videos: [], next: resume, error: e }));
            videos = merge(videos, tail.videos);
            resume = tail.error ? (tail.next || resume) : (tail.next || '');
            if (tail.error) note = String(tail.error.message || tail.error);
        }
        return { videos, fullAt: resume ? prev.fullAt : (prev.fullAt || Date.now()), resume, partial: !!resume, note };
    };

    // Single-flight refresh: concurrent public requests on a stale cache must not stampede YouTube.
    let refreshing = null;
    const progress = { videos: 0 };
    /** The refresh's result, or — when it is still running after `ms` — the cache as it stands. */
    const refreshWithin = async (ms) => {
        const run = refreshVideos();
        let timer;
        const late = new Promise((r) => { timer = setTimeout(() => r(null), ms); });
        try {
            return (await Promise.race([run, late])) || (await readCache());
        } finally { clearTimeout(timer); }
    };
    const refreshVideos = () => {
        if (refreshing) return refreshing;
        progress.videos = 0;
        refreshing = (async () => {
            const channel = await options.get(OPT_CHANNEL, '');
            const apiKey = await getSetting('apiv3');
            const keyless = await keylessFullEnabled();
            const prev = await readCache();
            const errors = [];
            const done = async (source, mode, channelId, r) => {
                const cache = {
                    videos: r.videos, channelId, source, mode, fetchedAt: Date.now(),
                    fullAt: r.fullAt || 0, resume: r.resume || '', partial: !!r.partial,
                    error: r.note || (errors.length ? errors.join(' · ') : null),
                    hl: r.hl || '',
                };
                await writeCache(cache);
                return cache;
            };
            try {
                const channelId = await resolveChannelId(channel, apiKey, keyless);
                const base = prev.channelId === channelId ? prev : {};

                if (apiKey) {
                    try {
                        const ch = await fetchJson(`${GAPI}/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`);
                        const uploads = ch.items && ch.items[0] && ch.items[0].contentDetails
                            && ch.items[0].contentDetails.relatedPlaylists && ch.items[0].contentDetails.relatedPlaylists.uploads;
                        if (!uploads) throw new Error('Channel has no uploads playlist (wrong id?)');
                        const r = await refreshFrom('api', apiPager(uploads, apiKey), channelId, base);
                        if (r) return await done('api', 'api', channelId, r);
                    } catch (e) {
                        errors.push(`Data API: ${e.message || e}`);
                        if (e instanceof BudgetExhausted) throw e;
                    }
                }
                let feed = null; // the RSS feed, fetched once per refresh
                if (keyless) {
                    // The feed carries the newest videos' ORIGINAL titles and exact dates: the
                    // reference for the listing language, and what those videos finally show.
                    try { feed = await fetchRss(channelId); } catch (e) { if (e instanceof BudgetExhausted) throw e; /* optional here */ }
                    const originals = new Map((feed || []).map((v) => [v.id, v.title]));
                    const sources = [
                        ['videos-tab', innertubeFirst(channelId, VIDEOS_TAB_PARAMS)],
                        ['uploads-playlist', innertubeFirst('VLUU' + channelId.slice(2))],
                    ];
                    for (const [source, fetchFirst] of sources) {
                        try {
                            // A list kept from before its language was known (≤ 1.1.0 asked in
                            // English) holds translated titles: it is read again from scratch.
                            const known = base.hl && base.source === source ? base.hl : '';
                            const lang = known ? { hl: known, page: null } : await originalLanguage(fetchFirst, originals);
                            const from = known ? base : { ...base, videos: [], fullAt: 0, resume: '' };
                            const r = await refreshFrom(source, innertubePager(fetchFirst, lang.hl, lang.page), channelId, from);
                            if (!r) continue;
                            r.hl = lang.hl;
                            // InnerTube carries no absolute dates: keep the ones already known, and
                            // take the newest videos' exact dates (and original titles) from the feed.
                            const dated = new Map(((base.videos) || []).filter((v) => v.publishedAt).map((v) => [v.id, v.publishedAt]));
                            for (const v of feed || []) dated.set(v.id, v.publishedAt);
                            r.videos = r.videos.map((v) => {
                                const title = originals.has(v.id) ? originals.get(v.id) : v.title;
                                const publishedAt = v.publishedAt || dated.get(v.id) || '';
                                return title === v.title && publishedAt === v.publishedAt ? v : { ...v, title, publishedAt };
                            });
                            return await done(source, 'full', channelId, r);
                        } catch (e) {
                            errors.push(`${source}: ${e.message || e}`);
                            if (e instanceof BudgetExhausted) throw e;
                        }
                    }
                }
                const videos = feed || await fetchRss(channelId);
                // An RSS answer after a failed full source replaces nothing it does not know: the
                // previous full list stays, topped up with the newest videos.
                const keep = base.mode && base.mode !== 'rss' && errors.length ? base.videos || [] : [];
                return await done(keep.length ? base.source : 'rss', keep.length ? base.mode : 'rss', channelId,
                    { videos: merge(videos, keep), fullAt: keep.length ? base.fullAt : 0, resume: keep.length ? base.resume : '', partial: keep.length ? base.partial : false });
            } catch (e) {
                // Keep serving the previous list; record the error for the admin page.
                const msg = String(e.message || e);
                const cache = { ...prev, error: errors.length && !errors.includes(msg) ? [...errors, msg].join(' · ') : msg, fetchedAt: prev.fetchedAt || 0, failedAt: Date.now() };
                await writeCache(cache);
                return cache;
            } finally {
                refreshing = null;
            }
        })();
        return refreshing;
    };

    const ttlMs = async () => (parseInt(await options.get(OPT_CACHE_TTL, 30), 10) || 30) * 60 * 1000;
    const isStale = async (cache) => {
        const ttl = await ttlMs();
        if (cache.failedAt && Date.now() - cache.failedAt < Math.min(ttl, 5 * 60 * 1000)) return false; // back off after a failure
        return !cache.fetchedAt || (Date.now() - cache.fetchedAt) > ttl;
    };

    const statusPayload = async () => {
        const channel = await options.get(OPT_CHANNEL, '');
        const apiKey = await getSetting('apiv3');
        const cache = await readCache();
        const cacheTtl = await options.get(OPT_CACHE_TTL, 30);
        return {
            channel,
            channelId: cache.channelId || null,
            hasApiKey: !!apiKey, // never echo the key itself
            keylessFull: await keylessFullEnabled(),
            mode: cache.mode || (apiKey ? 'api' : 'full'),
            source: cache.source || null,
            videoCount: (cache.videos || []).length,
            partial: !!cache.partial,
            titleLanguage: cache.hl || null, // the language the keyless list was asked in (its original titles)
            refreshing: !!refreshing,
            progress: refreshing ? progress.videos : null,
            fetchedAt: cache.fetchedAt || null,
            error: cache.error || null,
            cacheTtl: parseInt(cacheTtl, 10) || 30,
        };
    };

    // Public callers never see an error's text: a driver's message names tables, columns and
    // constraints. The details go to the server log.
    const failQuietly = (res, e, what) => {
        console.error(`[youtube-videos] ${what} failed:`, e && e.message ? e.message : e);
        res.status(500).json({ error: 'No se pudo completar la operación. Inténtalo de nuevo.' });
    };
    // Public routes answer every failure themselves, through failQuietly: a public caller only ever
    // gets a reply this plugin wrote.
    const quietly = (what, handler) => async (req, res) => {
        try { await handler(req, res); } catch (e) { failQuietly(res, e, what); }
    };

    const intParam = (v, dflt, min, max) => {
        let n = parseInt(v == null ? '' : String(v), 10);
        if (!Number.isFinite(n) || n < min) n = dflt;
        return Math.min(n, max);
    };

    // ---- routes -----------------------------------------------------------------------------------
    // PUBLIC list — the Verso block calls this from the editor iframe AND the public site.
    // ?q= / ?exclude= title filters (case- and accent-insensitive), ?order=, ?limit= 1..200,
    // ?offset= ≥ 0 for "load more" and numbered pages.
    http.route('get', '/', quietly('video list', async (req, res) => {
        let cache = await readCache();
        if ((await isStale(cache)) && (await options.get(OPT_CHANNEL, ''))) {
            if (cache.videos && cache.videos.length) {
                // Stale-while-revalidate: this visitor gets the cached list now.
                refreshVideos().catch((e) => console.error('[youtube-videos] background refresh failed:', e && e.message ? e.message : e));
            } else {
                cache = await refreshWithin(8000); // nothing to serve yet: wait for the first page
            }
        }
        let videos = cache.videos || [];
        const query = req.query || {};
        const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        // ?q= and ?exclude= take one term, or several separated by commas (any of them matches).
        const terms = (s) => String(s || '').split(',').map((t) => fold(t).trim()).filter(Boolean).slice(0, 20);
        const include = terms(String(query.q || '').slice(0, 500));
        const exclude = terms(String(query.exclude || '').slice(0, 500));
        if (include.length || exclude.length) {
            videos = videos.filter((v) => {
                const t = fold(v.title);
                return (!include.length || include.some((w) => t.includes(w))) && !exclude.some((w) => t.includes(w));
            });
        }
        // ?order= newest (default, YouTube's order) | oldest | title
        if (query.order === 'oldest') videos = videos.slice().reverse();
        else if (query.order === 'title') videos = videos.slice().sort((a, b) => String(a.title).localeCompare(String(b.title)));
        const limit = intParam(req.query && req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
        const offset = intParam(req.query && req.query.offset, 0, 0, MAX_VIDEOS);
        const slice = videos.slice(offset, offset + limit);
        const nextOffset = offset + slice.length < videos.length ? offset + slice.length : null;
        res.json({
            videos: slice,
            total: videos.length,
            offset,
            nextOffset,
            hasMore: nextOffset !== null,
            mode: cache.mode || null,
            fetchedAt: cache.fetchedAt || null,
        });
    }));

    http.route('get', '/status', { auth: true, admin: true }, async (req, res) => {
        res.json(await statusPayload());
    });

    // Save settings. apiKey semantics: undefined/absent = keep current, '' = clear, value = replace.
    http.route('post', '/settings', { auth: true, admin: true }, async (req, res) => {
        const body = req.body || {};
        if (typeof body.channel === 'string') await options.set(OPT_CHANNEL, body.channel.trim());
        if (typeof body.apiKey === 'string') await setSetting('apiv3', body.apiKey.trim());
        if (typeof body.keylessFull === 'boolean') await options.set(OPT_KEYLESS, body.keylessFull);
        if (body.cacheTtl != null) {
            const val = Math.max(1, parseInt(body.cacheTtl, 10) || 30);
            await options.set(OPT_CACHE_TTL, val);
        }
        await writeCache({}); // config changed → cache is meaningless
        await refreshWithin(REPLY_WITHIN_MS);
        res.json(await statusPayload());
    });

    // Refresh now. Keeps the list (an incremental pass); { full: true } starts over from scratch.
    http.route('post', '/refresh', { auth: true, admin: true }, async (req, res) => {
        const prev = await readCache();
        if (req.body && req.body.full) await writeCache({});
        else await writeCache({ ...prev, failedAt: 0 });
        await refreshWithin(REPLY_WITHIN_MS);
        res.json(await statusPayload());
    });

    adminMenu.add({
        href: '/admin/plugin/youtube',
        label: 'YouTube Videos',
        // Shown in the admin's language (sidebar); `label` stays for cores without per-language labels.
        labels: { en: 'YouTube Videos', es: 'Videos de YouTube', pt: 'Vídeos do YouTube' },
        icon: 'fa-video',
        order: 56,
        cap: 'manage_options',
    });

    console.log('[youtube-videos] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down — refreshes are lazy, per-request.
};

// Exposed for the fixture tests (pure functions; no I/O).
exports._internals = { collectVideos, listRoot, ownChannelId, readInitialData };

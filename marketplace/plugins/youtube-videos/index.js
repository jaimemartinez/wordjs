/**
 * WordJS Plugin: YouTube Videos
 *
 * Fetches a channel's videos (id, title, link, thumbnail, publishedAt) and serves them from a
 * cached list to a public endpoint the Puck carousel block consumes.
 *
 * Two data modes:
 *  - RSS (no configuration beyond the channel): youtube.com/feeds/videos.xml — the latest 15 videos.
 *  - Data API v3 (admin adds an API key): the FULL upload history via the channel's uploads
 *    playlist, paginated 50 at a time (capped — see MAX_API_VIDEOS).
 * The channel's public pages are read only to resolve an @handle without a key, never for the
 * list: their markup is not an interface (a scraper of the Videos tab stopped finding any video when
 * YouTube changed it), and they give dates only as relative text such as "6 days ago".
 *
 * Secret handling: the API key is stored in the plugin's OWN wjp_ table, NOT in options — options
 * share one global namespace readable by any plugin holding settings:read, and the host blocks
 * secret-named option keys outright (PROTECTED_OPTION_RE). The channel id and the video cache are
 * not secrets, so those live in options.
 */

exports.metadata = {
    name: 'YouTube Videos',
    version: '1.0.3',
    description: 'Channel video list (links, thumbnails, titles) + Verso carousel block',
    author: 'WordJS',
};

const OPT_CHANNEL = 'youtube_videos_channel';
const OPT_CACHE = 'youtube_videos_cache';
const OPT_CACHE_TTL = 'youtube_videos_cache_ttl';
const SETTINGS_TABLE = 'wjp_youtube_videos_settings';
const MAX_API_VIDEOS = 500;            // pagination cap in API mode (10 pages x 50)
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 200;

// ---- channel page parsing ------------------------------------------------------------------------
// A channel page also embeds the ids of OTHER channels — featured channels, shelves, collaborators —
// as "channelId" and "browseId" values, and the first of them is often not the page's own channel.
// So only signals that describe the page itself are read, most authoritative first, and a page that
// carries none of them is refused rather than guessed at.
const UC_ID = 'UC[0-9A-Za-z_-]{20,}';

/** The ytInitialData object a youtube.com page embeds, or null. */
function readInitialData(html) {
    // The assignment ends its <script>. A lazy `\{[\s\S]*?\};` alone stops at the first `};`, which a
    // title or a description can contain.
    const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

/** The tab the page opened (Home, Videos…), or null. */
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
    if (meta && new RegExp(`^${UC_ID}$`).test(meta.externalId || '')) return meta.externalId;
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
    if (header && new RegExp(`^${UC_ID}$`).test(header.channelId || '')) return header.channelId;
    const tab = selectedTab(data);
    const browseId = tab && tab.endpoint && tab.endpoint.browseEndpoint && tab.endpoint.browseEndpoint.browseId;
    if (new RegExp(`^${UC_ID}$`).test(browseId || '')) return browseId;
    return '';
}

exports.init = async function (wordjs) {
    const { options, http, db, adminMenu } = wordjs;

    // ---- plugin-private settings (API key) ------------------------------------------------------
    await db.run(`CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (name TEXT PRIMARY KEY, value TEXT)`);
    const getSetting = async (name) => {
        const row = await db.get(`SELECT value FROM ${SETTINGS_TABLE} WHERE name = ?`, [name]);
        return row ? row.value : '';
    };
    // NOTE: `ON CONFLICT ... DO UPDATE SET` trips the host SQL guard (its table-attribution regex
    // reads the token after `UPDATE` as a table name), so the upsert is a guard-safe
    // UPDATE-then-INSERT. Admin-only path, not race-sensitive.
    const setSetting = async (name, value) => {
        const v = String(value == null ? '' : value);
        const r = await db.run(`UPDATE ${SETTINGS_TABLE} SET value = ? WHERE name = ?`, [v, name]);
        if (!r || r.changes === 0) {
            await db.run(`INSERT INTO ${SETTINGS_TABLE} (name, value) VALUES (?, ?)`, [name, v]);
        }
    };

    // ---- YouTube fetching ------------------------------------------------------------------------
    const decodeXml = (s) => String(s || '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");

    const fetchText = async (url) => {
        const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (WordJS youtube-videos plugin)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
        return res.text();
    };
    const fetchJson = async (url) => {
        const res = await fetch(url);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            // Surface Google's error message (quota, invalid key…) — it is the actionable part.
            const msg = body && body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
            throw new Error(msg);
        }
        return body;
    };

    /**
     * Accepts a channel in any common shape — "UC…" id, "@handle", or a full URL
     * (youtube.com/channel/UC…, youtube.com/@handle) — and resolves it to the UC… channel id.
     * A handle resolves via the Data API when a key exists, else by reading the public channel
     * page — its own id, never the first "channelId" on it (see ownChannelId).
     */
    const resolveChannelId = async (input, apiKey) => {
        const raw = String(input || '').trim();
        if (!raw) throw new Error('No channel configured');
        const direct = raw.match(/\b(UC[0-9A-Za-z_-]{20,})\b/);
        if (direct) return direct[1];
        const handleMatch = raw.match(/@([\w.-]+)/) || (!raw.includes('/') ? [null, raw] : null);
        if (!handleMatch) throw new Error(`Could not understand the channel "${raw}" — use a UC… id, @handle or channel URL`);
        const handle = handleMatch[1];
        if (apiKey) {
            const data = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent('@' + handle)}&key=${encodeURIComponent(apiKey)}`);
            const id = data.items && data.items[0] && data.items[0].id;
            if (!id) throw new Error(`No channel found for @${handle}`);
            return id;
        }
        const html = await fetchText(`https://www.youtube.com/@${encodeURIComponent(handle)}`);
        const id = ownChannelId(html, readInitialData(html));
        if (!id) throw new Error(`Could not find the channel id of @${handle} on its YouTube page (add a Data API key, or configure the UC… channel id)`);
        return id;
    };

    const fetchViaRss = async (channelId) => {
        const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
        const videos = [];
        const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
        for (const entry of entries) {
            const id = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
            const title = decodeXml((entry.match(/<title>([^<]*)<\/title>/) || [])[1]);
            const rssThumb = (entry.match(/<media:thumbnail url="([^"]+)"/) || [])[1];
            const thumb = rssThumb ? rssThumb.replace('hqdefault.jpg', 'maxresdefault.jpg') : (id ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` : '');
            const publishedAt = (entry.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
            if (id) videos.push({ id, title, url: `https://www.youtube.com/watch?v=${id}`, thumb, publishedAt });
        }
        return videos;
    };

    /** API mode: full history via the uploads playlist ("UU" + channel id tail), paginated. */
    const fetchViaApi = async (channelId, apiKey) => {
        const ch = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`);
        const uploads = ch.items && ch.items[0] && ch.items[0].contentDetails
            && ch.items[0].contentDetails.relatedPlaylists && ch.items[0].contentDetails.relatedPlaylists.uploads;
        if (!uploads) throw new Error('Channel has no uploads playlist (wrong id?)');
        const videos = [];
        let pageToken = '';
        while (videos.length < MAX_API_VIDEOS) {
            const page = await fetchJson(
                `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(uploads)}`
                + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '') + `&key=${encodeURIComponent(apiKey)}`);
            for (const item of page.items || []) {
                const sn = item.snippet || {};
                const id = sn.resourceId && sn.resourceId.videoId;
                if (!id) continue;
                const t = sn.thumbnails || {};
                const thumb = (t.maxres || t.standard || t.high || t.medium || t.default || {}).url || `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
                videos.push({ id, title: sn.title || '', url: `https://www.youtube.com/watch?v=${id}`, thumb, publishedAt: sn.publishedAt || '' });
            }
            pageToken = page.nextPageToken || '';
            if (!pageToken) break;
        }
        return videos;
    };

    // Single-flight refresh: concurrent public requests on a stale cache must not stampede YouTube.
    let refreshing = null;
    const refreshVideos = () => {
        if (refreshing) return refreshing;
        refreshing = (async () => {
            const channel = await options.get(OPT_CHANNEL, '');
            const apiKey = await getSetting('apiv3');
            const prev = (await options.get(OPT_CACHE, null)) || {};
            try {
                const channelId = await resolveChannelId(channel, apiKey);
                const mode = apiKey ? 'api' : 'rss';
                const videos = apiKey ? await fetchViaApi(channelId, apiKey) : await fetchViaRss(channelId);
                const cache = { videos, channelId, mode, fetchedAt: Date.now(), error: null };
                await options.set(OPT_CACHE, cache);
                return cache;
            } catch (e) {
                // Keep serving the previous list; record the error for the admin page.
                const cache = { ...prev, error: String(e.message || e), fetchedAt: prev.fetchedAt || 0 };
                await options.set(OPT_CACHE, cache);
                return cache;
            } finally {
                refreshing = null;
            }
        })();
        return refreshing;
    };

    const statusPayload = async () => {
        const channel = await options.get(OPT_CHANNEL, '');
        const apiKey = await getSetting('apiv3');
        const cache = (await options.get(OPT_CACHE, null)) || {};
        const cacheTtl = await options.get(OPT_CACHE_TTL, 30);
        return {
            channel,
            hasApiKey: !!apiKey, // never echo the key itself
            mode: cache.mode || (apiKey ? 'api' : 'rss'),
            videoCount: (cache.videos || []).length,
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

    // ---- routes -----------------------------------------------------------------------------------
    // PUBLIC list — the Puck block calls this from the editor iframe AND the public site.
    // ?q= title-contains filter (case/diacritic-insensitive-ish), ?limit= 1..200.
    http.route('get', '/', quietly('video list', async (req, res) => {
        let cache = (await options.get(OPT_CACHE, null)) || {};
        const ttlMin = await options.get(OPT_CACHE_TTL, 30);
        const cacheTtlMs = (parseInt(ttlMin, 10) || 30) * 60 * 1000;
        const stale = !cache.fetchedAt || (Date.now() - cache.fetchedAt) > cacheTtlMs;
        if (stale && (await options.get(OPT_CHANNEL, ''))) {
            cache = await refreshVideos(); // serves the old list on failure (error recorded)
        }
        let videos = cache.videos || [];
        const q = String((req.query && req.query.q) || '').trim().toLowerCase();
        if (q) videos = videos.filter((v) => String(v.title || '').toLowerCase().includes(q));
        let limit = parseInt((req.query && req.query.limit) || DEFAULT_LIMIT, 10);
        if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
        limit = Math.min(limit, MAX_LIMIT);
        res.json({
            videos: videos.slice(0, limit),
            total: videos.length,
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
        if (body.cacheTtl != null) {
            const val = Math.max(1, parseInt(body.cacheTtl, 10) || 30);
            await options.set(OPT_CACHE_TTL, val);
        }
        await options.set(OPT_CACHE, null); // config changed → cache is meaningless
        await refreshVideos();
        res.json(await statusPayload());
    });

    http.route('post', '/refresh', { auth: true, admin: true }, async (req, res) => {
        await options.set(OPT_CACHE, null);
        await refreshVideos();
        res.json(await statusPayload());
    });

    adminMenu.add({
        href: '/admin/plugin/youtube',
        label: 'YouTube Videos',
        icon: 'fa-video',
        order: 56,
        cap: 'manage_options',
    });

    console.log('[youtube-videos] plugin initialized');
};

exports.deactivate = function () {
    // No timers or servers to tear down — refreshes are lazy, per-request.
};

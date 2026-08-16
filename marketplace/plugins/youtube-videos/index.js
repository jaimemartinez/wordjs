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
 *
 * Secret handling: the API key is stored in the plugin's OWN wjp_ table, NOT in options — options
 * share one global namespace readable by any plugin holding settings:read, and the host blocks
 * secret-named option keys outright (PROTECTED_OPTION_RE). The channel id and the video cache are
 * not secrets, so those live in options.
 */

exports.metadata = {
    name: 'YouTube Videos',
    version: '1.0.0',
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
     * page (its HTML embeds "channelId":"UC…").
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
        const m = html.match(/"channelId":"(UC[0-9A-Za-z_-]{20,})"/) || html.match(/"externalId":"(UC[0-9A-Za-z_-]{20,})"/);
        if (!m) throw new Error(`Could not resolve @${handle} to a channel id (add a Data API key to resolve handles reliably)`);
        return m[1];
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

    /** Scraper mode: fetch public channel page and parse ytInitialData JSON for keyless high-res videos. */
    const fetchViaScraper = async (channelId, channelHandle) => {
        const targetUrl = channelHandle 
            ? `https://www.youtube.com/@${encodeURIComponent(channelHandle.replace('@', ''))}/videos`
            : `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/videos`;

        const html = await fetchText(targetUrl);
        const match = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});/);
        if (!match) {
            throw new Error("No se encontró ytInitialData en la página pública de YouTube");
        }
        const data = JSON.parse(match[1]);
        const list = [];
        const findVideos = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            if (obj.videoId && obj.title) {
                const titleText = obj.title.runs ? obj.title.runs[0].text : (obj.title.simpleText || '');
                const thumbnails = (obj.thumbnail && obj.thumbnail.thumbnails) || [];
                const thumbUrl = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : `https://i.ytimg.com/vi/${obj.videoId}/maxresdefault.jpg`;
                list.push({
                    id: obj.videoId,
                    title: titleText || 'YouTube Video',
                    url: `https://www.youtube.com/watch?v=${obj.videoId}`,
                    thumb: thumbUrl,
                    publishedAt: obj.publishedTimeText ? obj.publishedTimeText.simpleText : ''
                });
                return;
            }
            for (const key of Object.keys(obj)) {
                findVideos(obj[key]);
            }
        };
        findVideos(data);
        const videos = [];
        const seenIds = new Set();
        for (const v of list) {
            if (!seenIds.has(v.id)) {
                seenIds.add(v.id);
                videos.push(v);
            }
        }
        if (videos.length === 0) {
            throw new Error("No se encontraron videos en la página de YouTube");
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
                let videos;
                let mode = 'rss';
                if (apiKey) {
                    videos = await fetchViaApi(channelId, apiKey);
                    mode = 'api';
                } else {
                    try {
                        const handle = channel.includes('@') ? channel.match(/@([\w.-]+)/)?.[1] : null;
                        videos = await fetchViaScraper(channelId, handle);
                        mode = 'scraper';
                    } catch (scraperErr) {
                        console.warn(`Scraper failed, falling back to RSS: ${scraperErr.message}`);
                        videos = await fetchViaRss(channelId);
                        mode = 'rss';
                    }
                }
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

    // ---- routes -----------------------------------------------------------------------------------
    // PUBLIC list — the Puck block calls this from the editor iframe AND the public site.
    // ?q= title-contains filter (case/diacritic-insensitive-ish), ?limit= 1..200.
    http.route('get', '/', async (req, res) => {
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
    });

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

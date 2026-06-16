/**
 * Video Gallery Plugin for WordJS — ISOLATED.
 *
 * Runs in a worker (manifest.isolated) and uses ONLY the injected `wordjs` capability bridge —
 * no direct require of core modules. Routes are namespaced under /api/v1/plugin/video-gallery/* by the host.
 * Displays videos in a horizontal scrolling carousel. Supports multiple galleries.
 */

// Plugin metadata
exports.metadata = {
    name: 'Video Gallery',
    version: '2.0.0', // Major version bump
    description: 'A horizontal scrolling video carousel with YouTube integration and multi-gallery support',
    author: 'WordJS'
};

// Helper: Extract YouTube thumbnail (pure, kept as-is)
function extractThumbnail(youtubeUrl) {
    if (!youtubeUrl) return null;
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/
    ];
    for (const pattern of patterns) {
        const match = youtubeUrl.match(pattern);
        if (match && match[1]) {
            return `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg`; // Use mqdefault for lighter load, or maxresdefault for quality
        }
    }
    return null;
}

exports.init = function (wordjs) {
    const { options, http, shortcodes, adminMenu } = wordjs;

    console.log('🎬 Initializing Video Gallery plugin (v2, isolated)...');

    // tiny id generator (no uuid dependency needed inside the isolate)
    const newId = () => Math.random().toString(36).slice(2, 10);

    // Helpers to get/save gallery
    const getGallery = async (id) => await options.get(`vgallery_data_${id}`, null);
    const saveGallery = async (id, data) => await options.set(`vgallery_data_${id}`, data);

    // === MIGRATION logic ===
    async function migrateLegacyData() {
        const galleryList = await options.get('vgallery_galleries_list', null);

        // If galleries list exists, migration already done or new install
        if (galleryList !== null) return;

        console.log('Migrating legacy Video Gallery data to Multi-Gallery format...');

        const legacyVideoIds = await options.get('videos_list', []);
        const legacyVideos = [];

        // Collect all legacy videos
        for (const id of legacyVideoIds) {
            const video = await options.get(`video_${id}`, null);
            if (video) {
                legacyVideos.push({ id, ...video });
            }
        }

        // Create default gallery with these videos
        const defaultGallery = {
            id: 'default',
            name: 'Default Gallery',
            description: 'Migrated from legacy version',
            created_at: new Date().toISOString(),
            videos: legacyVideos
        };

        await options.set('vgallery_data_default', defaultGallery);
        await options.set('vgallery_galleries_list', ['default']);

        console.log(`Migration complete. Created 'default' gallery with ${legacyVideos.length} videos.`);
    }

    migrateLegacyData().catch(err => console.error('Migration failed:', err && err.message));

    // === API ROUTES (host namespaces them under /api/v1/plugin/video-gallery) ===

    // --- GALLERIES ---

    // GET /galleries - List all galleries
    http.route('get', '/galleries', async (req, res) => {
        const list = await options.get('vgallery_galleries_list', []);

        // Parallel fetch
        const galleries = await Promise.all(list.map(async id => {
            const g = await getGallery(id);
            if (!g) return null;
            return {
                id: g.id,
                name: g.name,
                description: g.description,
                videoCount: g.videos ? g.videos.length : 0
            };
        }));

        res.json(galleries.filter(Boolean));
    });

    // POST /galleries - Create new gallery (admin)
    http.route('post', '/galleries', { auth: true, admin: true }, async (req, res) => {
        const { name, description } = req.body || {};
        if (!name) return res.status(400).json({ error: 'Name is required' });

        const id = newId(); // Short ID
        const newGallery = {
            id,
            name,
            description: description || '',
            created_at: new Date().toISOString(),
            videos: []
        };

        const list = await options.get('vgallery_galleries_list', []);
        list.push(id);

        await saveGallery(id, newGallery);
        await options.set('vgallery_galleries_list', list);

        res.status(201).json(newGallery);
    });

    // GET /galleries/:id - Get specific gallery details
    http.route('get', '/galleries/:id', async (req, res) => {
        const gallery = await getGallery(req.params.id);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });
        res.json(gallery);
    });

    // PUT /galleries/:id - Update gallery metadata (admin)
    http.route('put', '/galleries/:id', { auth: true, admin: true }, async (req, res) => {
        const gallery = await getGallery(req.params.id);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

        const updated = { ...gallery, ...(req.body || {}), videos: gallery.videos }; // Protect videos from direct overwrite here
        await saveGallery(req.params.id, updated);
        res.json(updated);
    });

    // DELETE /galleries/:id - Delete gallery (admin)
    http.route('delete', '/galleries/:id', { auth: true, admin: true }, async (req, res) => {
        const id = req.params.id;
        const list = await options.get('vgallery_galleries_list', []);

        if (!list.includes(id)) return res.status(404).json({ error: 'Gallery not found' });

        const newList = list.filter(gid => gid !== id);
        await options.set('vgallery_galleries_list', newList);
        await options.set(`vgallery_data_${id}`, null);

        res.json({ success: true });
    });

    // --- VIDEOS within Gallery ---

    // POST /galleries/:id/videos - Add video (admin)
    http.route('post', '/galleries/:id/videos', { auth: true, admin: true }, async (req, res) => {
        const galleryId = req.params.id;
        const gallery = await getGallery(galleryId);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

        const { title, youtube_url, thumbnail, button_text, description, sort_order } = req.body || {};
        if (!title || !youtube_url) return res.status(400).json({ error: 'Title and YouTube URL required' });

        const videoId = newId();
        const newVideo = {
            id: videoId,
            title,
            youtube_url,
            thumbnail: thumbnail || extractThumbnail(youtube_url),
            button_text: button_text || 'VER EN YOUTUBE',
            description: description || '',
            sort_order: sort_order || gallery.videos.length,
            created_at: new Date().toISOString()
        };

        gallery.videos.push(newVideo);
        await saveGallery(galleryId, gallery);

        res.status(201).json(newVideo);
    });

    // PUT /galleries/:id/videos/:videoId - Update video (admin)
    http.route('put', '/galleries/:id/videos/:videoId', { auth: true, admin: true }, async (req, res) => {
        const galleryId = req.params.id;
        const videoId = req.params.videoId;
        const gallery = await getGallery(galleryId);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

        const videoIndex = gallery.videos.findIndex(v => String(v.id) === String(videoId));
        if (videoIndex === -1) return res.status(404).json({ error: 'Video not found' });

        const body = req.body || {};
        const updatedVideo = { ...gallery.videos[videoIndex], ...body };

        // Retain ID and created_at
        updatedVideo.id = videoId;

        if (body.youtube_url && !body.thumbnail) {
            updatedVideo.thumbnail = extractThumbnail(body.youtube_url);
        }

        gallery.videos[videoIndex] = updatedVideo;
        await saveGallery(galleryId, gallery);

        res.json(updatedVideo);
    });

    // DELETE /galleries/:id/videos/:videoId - Delete video (admin)
    http.route('delete', '/galleries/:id/videos/:videoId', { auth: true, admin: true }, async (req, res) => {
        const galleryId = req.params.id;
        const videoId = req.params.videoId;
        const gallery = await getGallery(galleryId);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

        gallery.videos = gallery.videos.filter(v => String(v.id) !== String(videoId));
        await saveGallery(galleryId, gallery);

        res.json({ success: true });
    });

    // PUT /galleries/:id/reorder - Reorder videos (admin)
    http.route('put', '/galleries/:id/reorder', { auth: true, admin: true }, async (req, res) => {
        const galleryId = req.params.id;
        const { videoIds } = req.body || {}; // Array of IDs in new order

        if (!Array.isArray(videoIds)) return res.status(400).json({ error: 'videoIds must be an array' });

        const gallery = await getGallery(galleryId);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

        // Map existing videos by ID for O(1) lookup
        const videoMap = new Map(gallery.videos.map(v => [String(v.id), v]));
        const newVideos = [];

        // Reconstruct video list in new order
        for (let i = 0; i < videoIds.length; i++) {
            const vid = videoMap.get(String(videoIds[i]));
            if (vid) {
                vid.sort_order = i; // Update sort index
                newVideos.push(vid);
            }
        }

        // Add any missing videos (if array was partial) to the end
        if (newVideos.length < gallery.videos.length) {
            const processedIds = new Set(newVideos.map(v => String(v.id)));
            for (const v of gallery.videos) {
                if (!processedIds.has(String(v.id))) {
                    v.sort_order = newVideos.length;
                    newVideos.push(v);
                }
            }
        }

        gallery.videos = newVideos;
        await saveGallery(galleryId, gallery);

        res.json({ success: true, videos: newVideos });
    });

    // --- LEGACY / HELPER ROUTES ---

    // GET / - Default legacy route (Returns default gallery videos, honoring ?gallery=)
    http.route('get', '/', async (req, res) => {
        // If 'gallery' query param is present, try to fetch that one
        const manualId = req.query.gallery;
        if (manualId) {
            const g = await getGallery(manualId);
            return g ? res.json(g.videos) : res.status(404).json({ error: 'Gallery not found' });
        }

        // Fallback to 'default' gallery
        const g = await getGallery('default');
        if (g) {
            res.json(g.videos);
        } else {
            // Fallback to first available gallery if default doesn't exist?
            const list = await options.get('vgallery_galleries_list', []);
            if (list.length > 0) {
                const first = await getGallery(list[0]);
                return res.json(first ? first.videos : []);
            }
            res.json([]);
        }
    });

    // === SHORTCODE ===
    shortcodes.add('vgallery', (attrs) => {
        // We can pass the gallery ID via attribute: [vgallery id="my-gallery-id"]
        const galleryId = attrs.id || 'default';
        return `[vgallery id="${galleryId}"]`;
    });

    // === ADMIN MENU ===
    adminMenu.add({
        href: '/admin/plugin/videos',
        label: 'Video Gallery',
        icon: 'fa-video',
        order: 35,
        cap: 'manage_videos'
    });

    console.log('   ✓ Video Gallery plugin initialized (isolated)');
};

exports.deactivate = function () {
    console.log('Video Gallery plugin deactivated');
};

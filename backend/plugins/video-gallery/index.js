/**
 * Video Gallery Plugin for WordJS
 * Displays videos in a horizontal scrolling carousel
 * Supports multiple galleries
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getApp } = require('../../src/core/appRegistry');
const { addShortcode } = require('../../src/core/shortcodes');
const { getOption, updateOption } = require('../../src/core/options');
const { authenticate } = require('../../src/middleware/auth');
const { isAdmin } = require('../../src/middleware/permissions');
const { registerAdminMenu } = require('../../src/core/adminMenu');

// Plugin metadata
exports.metadata = {
    name: 'Video Gallery',
    version: '2.0.0', // Major version bump
    description: 'A horizontal scrolling video carousel with YouTube integration and multi-gallery support',
    author: 'WordJS'
};

// === MIGRATION logic ===
function migrateLegacyData() {
    const galleryList = getOption('vgallery_galleries_list', null);

    // If galleries list exists, migration already done or new install
    if (galleryList !== null) return;

    console.log('Migrating legacy Video Gallery data to Multi-Gallery format...');

    const legacyVideoIds = getOption('videos_list', []);
    const legacyVideos = [];

    // Collect all legacy videos
    for (const id of legacyVideoIds) {
        const video = getOption(`video_${id}`, null);
        if (video) {
            legacyVideos.push({ id, ...video });
            // Clean up legacy individual option (optional, maybe keep for safety for now)
            // updateOption(`video_${id}`, null); 
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

    updateOption('vgallery_data_default', defaultGallery);
    updateOption('vgallery_galleries_list', ['default']);
    // updateOption('videos_list', null); // Mark legacy list as gone

    console.log(`Migration complete. Created 'default' gallery with ${legacyVideos.length} videos.`);
}

// === API ROUTES ===
function setupRoutes() {
    const app = getApp();
    const router = express.Router();

    // Helper to get gallery
    const getGallery = (id) => getOption(`vgallery_data_${id}`, null);
    const saveGallery = (id, data) => updateOption(`vgallery_data_${id}`, data);

    // --- GALLERIES ---

    // GET /api/v1/videos/galleries - List all galleries
    router.get('/galleries', (req, res) => {
        const list = getOption('vgallery_galleries_list', []);
        const galleries = list.map(id => {
            const g = getGallery(id);
            if (!g) return null;
            return {
                id: g.id,
                name: g.name,
                description: g.description,
                videoCount: g.videos ? g.videos.length : 0
            };
        }).filter(Boolean);
        res.json(galleries);
    });

    // POST /api/v1/videos/galleries - Create new gallery
    router.post('/galleries', authenticate, isAdmin, (req, res) => {
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });

        const id = uuidv4().split('-')[0]; // Short ID
        const newGallery = {
            id,
            name,
            description: description || '',
            created_at: new Date().toISOString(),
            videos: []
        };

        const list = getOption('vgallery_galleries_list', []);
        list.push(id);

        saveGallery(id, newGallery);
        updateOption('vgallery_galleries_list', list);

        res.status(201).json(newGallery);
    });

    // GET /api/v1/videos/galleries/:id - Get specific gallery details
    router.get('/galleries/:id', (req, res) => {
        const gallery = getGallery(req.params.id);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });
        res.json(gallery);
    });

    // PUT /api/v1/videos/galleries/:id - Update gallery metadata
    router.put('/galleries/:id', authenticate, isAdmin, (req, res) => {
        const gallery = getGallery(req.params.id);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

        const updated = { ...gallery, ...req.body, videos: gallery.videos }; // Protect videos from direct overwrite here
        saveGallery(req.params.id, updated);
        res.json(updated);
    });

    // DELETE /api/v1/videos/galleries/:id - Delete gallery
    router.delete('/galleries/:id', authenticate, isAdmin, (req, res) => {
        const id = req.params.id;
        const list = getOption('vgallery_galleries_list', []);

        if (!list.includes(id)) return res.status(404).json({ error: 'Gallery not found' });

        const newList = list.filter(gid => gid !== id);
        updateOption('vgallery_galleries_list', newList);
        updateOption(`vgallery_data_${id}`, null);

        res.json({ success: true });
    });

    // --- VIDEOS within Gallery ---

    // POST /api/v1/videos/galleries/:id/videos - Add video
    router.post('/galleries/:id/videos', authenticate, isAdmin, (req, res) => {
        const galleryId = req.params.id;
        const gallery = getGallery(galleryId);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

        const { title, youtube_url, thumbnail, button_text, description, sort_order } = req.body;
        if (!title || !youtube_url) return res.status(400).json({ error: 'Title and YouTube URL required' });

        const videoId = uuidv4().split('-')[0];
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
        saveGallery(galleryId, gallery);

        res.status(201).json(newVideo);
    });

    // PUT /api/v1/videos/galleries/:id/videos/:videoId - Update video
    router.put('/galleries/:id/videos/:videoId', authenticate, isAdmin, (req, res) => {
        const galleryId = req.params.id;
        const videoId = req.params.videoId;
        const gallery = getGallery(galleryId);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

        const videoIndex = gallery.videos.findIndex(v => String(v.id) === String(videoId));
        if (videoIndex === -1) return res.status(404).json({ error: 'Video not found' });

        const updatedVideo = { ...gallery.videos[videoIndex], ...req.body };

        // Retain ID and created_at
        updatedVideo.id = videoId;

        if (req.body.youtube_url && !req.body.thumbnail) {
            updatedVideo.thumbnail = extractThumbnail(req.body.youtube_url);
        }

        gallery.videos[videoIndex] = updatedVideo;
        saveGallery(galleryId, gallery);

        res.json(updatedVideo);
    });

    // DELETE /api/v1/videos/galleries/:id/videos/:videoId - Delete video
    router.delete('/galleries/:id/videos/:videoId', authenticate, isAdmin, (req, res) => {
        const galleryId = req.params.id;
        const videoId = req.params.videoId;
        const gallery = getGallery(galleryId);
        if (!gallery) return res.status(404).json({ error: 'Gallery not found' });

        gallery.videos = gallery.videos.filter(v => String(v.id) !== String(videoId));
        saveGallery(galleryId, gallery);

        res.json({ success: true });
    });

    // PUT /api/v1/videos/galleries/:id/reorder - Reorder videos
    router.put('/galleries/:id/reorder', authenticate, isAdmin, (req, res) => {
        const galleryId = req.params.id;
        const { videoIds } = req.body; // Array of IDs in new order

        if (!Array.isArray(videoIds)) return res.status(400).json({ error: 'videoIds must be an array' });

        const gallery = getGallery(galleryId);
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
        saveGallery(galleryId, gallery);

        res.json({ success: true, videos: newVideos });
    });


    // --- LEGACY / HELPER ROUTES ---

    // GET /api/v1/videos - Default legacy route (Returns default gallery videos)
    router.get('/', (req, res) => {
        // If 'gallery' query param is present, try to fetch that one
        const manualId = req.query.gallery;
        if (manualId) {
            const g = getGallery(manualId);
            return g ? res.json(g.videos) : res.status(404).json({ error: 'Gallery not found' });
        }

        // Fallback to 'default' gallery
        const g = getGallery('default');
        if (g) {
            res.json(g.videos);
        } else {
            // Fallback to first available gallery if default doesn't exist?
            const list = getOption('vgallery_galleries_list', []);
            if (list.length > 0) {
                const first = getGallery(list[0]);
                return res.json(first ? first.videos : []);
            }
            res.json([]);
        }
    });

    app.use('/api/v1/videos', router);
    console.log('   ✓ Video Gallery API routes registered (Multi-gallery support)');
}

// Helper: Extract YouTube thumbnail
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

// === SHORTCODE ===
function setupShortcode() {
    addShortcode('vgallery', (attrs) => {
        // We can pass the gallery ID via attribute: [vgallery id="my-gallery-id"]
        const galleryId = attrs.id || 'default';
        return `[vgallery id="${galleryId}"]`;
    });
}

// === INIT ===
exports.init = function () {
    console.log('🎬 Initializing Video Gallery plugin (v2)...');

    migrateLegacyData();
    setupRoutes();
    setupShortcode();

    registerAdminMenu('video-gallery', {
        href: '/admin/plugin/videos',
        label: 'Video Gallery',
        icon: 'fa-video',
        order: 35,
        cap: 'manage_videos'
    });

    console.log('   ✓ Video Gallery plugin initialized');
};

exports.deactivate = function () {
    console.log('Video Gallery plugin deactivated');
};

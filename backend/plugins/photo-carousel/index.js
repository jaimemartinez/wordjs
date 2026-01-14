/**
 * Photo Carousel Plugin for WordJS
 * Self-contained plugin with:
 * - Own API routes for CRUD operations
 * - Shortcode [carousel id="X"] for embedding
 * 
 * Usage: [carousel id="my-carousel"] or [carousel] for latest images
 */

const { v4: uuidv4 } = require('uuid');

exports.metadata = {
    name: 'Photo Carousel',
    version: '2.0.0',
    description: 'Create and manage image carousels with admin UI',
    author: 'WordJS'
};

// Store reference to registered routes for cleanup
let registeredRouter = null;

exports.init = function () {
    const { addShortcode } = require('../../src/core/shortcodes');
    const { getOption, updateOption } = require('../../src/core/options');
    const { addAction } = require('../../src/core/hooks');
    const express = require('express');

    // === API ROUTES ===
    const router = express.Router();
    const { authenticate } = require('../../src/middleware/auth');
    const { isAdmin } = require('../../src/middleware/permissions');

    // GET /api/v1/carousels - List all carousels
    router.get('/', (req, res) => {
        const list = getOption('carousels_list', []);
        const carousels = list.map(id => {
            const data = getOption(`carousel_${id}`, null);
            return data ? { id, ...data } : null;
        }).filter(Boolean);
        res.json(carousels);
    });

    // GET /api/v1/carousels/:id - Get single carousel
    router.get('/:id', (req, res) => {
        const data = getOption(`carousel_${req.params.id}`, null);
        if (!data) {
            return res.status(404).json({ error: 'Carousel not found' });
        }
        res.json({ id: req.params.id, ...data });
    });

    // GET /api/v1/carousels/location/:location - Get carousel by location (e.g. 'hero')
    router.get('/location/:location', (req, res) => {
        const list = getOption('carousels_list', []);

        // Find carousel with matching location
        // Since we don't have a direct index, we have to iterate
        // In a real DB this would be a query
        let found = null;
        let foundId = null;

        for (const id of list) {
            const data = getOption(`carousel_${id}`, null);
            if (data && data.location === req.params.location) {
                found = data;
                foundId = id;
                break;
            }
        }

        if (!found) {
            return res.status(404).json({ error: 'No carousel found for this location' });
        }
        res.json({ id: foundId, ...found });
    });

    // POST /api/v1/carousels - Create carousel (Admin only)
    router.post('/', authenticate, isAdmin, (req, res) => {
        const { name, images = [], autoplay = true, interval = 5000, location = '' } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const id = uuidv4().split('-')[0]; // Short ID
        const carousel = { name, images, autoplay, interval, location, createdAt: new Date().toISOString() };

        updateOption(`carousel_${id}`, carousel);

        // Update list
        const list = getOption('carousels_list', []);
        list.push(id);
        updateOption('carousels_list', list);

        res.json({ success: true, id, ...carousel });
    });

    // PUT /api/v1/carousels/:id - Update carousel (Admin only)
    router.put('/:id', authenticate, isAdmin, (req, res) => {
        const existing = getOption(`carousel_${req.params.id}`, null);
        if (!existing) {
            return res.status(404).json({ error: 'Carousel not found' });
        }

        const { name, images, autoplay, interval, location } = req.body;
        const updated = {
            ...existing,
            name: name !== undefined ? name : existing.name,
            images: images !== undefined ? images : existing.images,
            autoplay: autoplay !== undefined ? autoplay : existing.autoplay,
            interval: interval !== undefined ? interval : existing.interval,
            location: location !== undefined ? location : existing.location,
            updatedAt: new Date().toISOString()
        };

        updateOption(`carousel_${req.params.id}`, updated);
        res.json({ success: true, id: req.params.id, ...updated });
    });

    // DELETE /api/v1/carousels/:id - Delete carousel (Admin only)
    router.delete('/:id', authenticate, isAdmin, (req, res) => {
        const existing = getOption(`carousel_${req.params.id}`, null);
        if (!existing) {
            return res.status(404).json({ error: 'Carousel not found' });
        }

        updateOption(`carousel_${req.params.id}`, null);

        // Remove from list
        const list = getOption('carousels_list', []);
        const index = list.indexOf(req.params.id);
        if (index > -1) {
            list.splice(index, 1);
            updateOption('carousels_list', list);
        }

        res.json({ success: true });
    });

    // Register routes with Express app immediately
    const { getApp } = require('../../src/core/appRegistry');
    const app = getApp();

    if (app) {
        app.use('/api/v1/carousels', router);
        registeredRouter = router;
        console.log('   ✓ Carousel API routes registered');
    } else {
        console.warn('   ⚠ Could not register carousel routes - app not available');
    }

    // === SHORTCODE ===
    addShortcode('carousel', (attrs) => {
        // Require a carousel ID
        if (!attrs.id) {
            return ''; // No ID provided, render nothing
        }

        const carousel = getOption(`carousel_${attrs.id}`, null);
        if (!carousel) {
            return ''; // Carousel not found, render nothing
        }

        const images = carousel.images || [];
        if (images.length === 0) {
            return ''; // No images, render nothing
        }

        const settings = {
            autoplay: carousel.autoplay !== false,
            interval: carousel.interval || 5000
        };

        return renderCarousel(images, settings);
    });

    // === REGISTER ADMIN MENU ===
    const { registerAdminMenu } = require('../../src/core/adminMenu');
    registerAdminMenu('photo-carousel', {
        href: '/admin/plugin/carousels',
        label: 'Carousels',
        icon: 'fa-images',
        order: 50,
        cap: 'upload_files'
    });

    console.log('Photo Carousel plugin v2.0 initialized!');
};

exports.deactivate = function () {
    const { removeShortcode } = require('../../src/core/shortcodes');
    const { unregisterAdminMenu } = require('../../src/core/adminMenu');
    removeShortcode('carousel');
    unregisterAdminMenu('photo-carousel');
    console.log('Photo Carousel plugin deactivated');
};

// === CAROUSEL RENDERER ===
function renderCarousel(images, settings) {
    const uniqueId = 'carousel_' + Math.random().toString(36).substr(2, 9);
    const { autoplay, interval } = settings;

    let html = `
<style>
.photo-carousel {
    position: relative;
    width: 100%;
    max-width: 900px;
    margin: 2rem auto;
    overflow: hidden;
    border-radius: 16px;
    background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
}
.photo-carousel .slides {
    display: flex;
    transition: transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}
.photo-carousel .slide {
    min-width: 100%;
    aspect-ratio: 16/9;
    position: relative;
}
.photo-carousel .slide img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}
.photo-carousel .slide-caption {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 1.5rem;
    background: linear-gradient(transparent, rgba(0,0,0,0.8));
    color: white;
    font-size: 1rem;
}
.photo-carousel .nav-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    background: rgba(255,255,255,0.95);
    border: none;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 20px;
    color: #1e293b;
    box-shadow: 0 4px 15px rgba(0,0,0,0.2);
    z-index: 10;
    transition: all 0.3s ease;
}
.photo-carousel .nav-btn:hover {
    background: white;
    transform: translateY(-50%) scale(1.1);
}
.photo-carousel .nav-btn.prev { left: 16px; }
.photo-carousel .nav-btn.next { right: 16px; }
.photo-carousel .dots {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 10px;
    z-index: 10;
}
.photo-carousel .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: rgba(255,255,255,0.4);
    cursor: pointer;
    border: 2px solid transparent;
    transition: all 0.3s ease;
}
.photo-carousel .dot:hover { background: rgba(255,255,255,0.7); }
.photo-carousel .dot.active { background: white; transform: scale(1.2); }
.photo-carousel .counter {
    position: absolute;
    top: 16px;
    right: 16px;
    background: rgba(0,0,0,0.6);
    color: white;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 14px;
    font-weight: 500;
    z-index: 10;
}
</style>
<div class="photo-carousel" id="${uniqueId}" data-autoplay="${autoplay}" data-interval="${interval}">
    <div class="counter"><span class="current">1</span> / ${images.length}</div>
    <div class="slides">
`;
    images.forEach((img, i) => {
        const url = typeof img === 'string' ? img : img.url;
        html += `<div class="slide">
            <img src="${url}" alt="Slide ${i + 1}" loading="${i === 0 ? 'eager' : 'lazy'}">
        </div>`;
    });

    html += `
    </div>
    <button class="nav-btn prev" data-dir="-1">&#10094;</button>
    <button class="nav-btn next" data-dir="1">&#10095;</button>
    <div class="dots">
`;
    images.forEach((_, i) => {
        html += `<button class="dot${i === 0 ? ' active' : ''}" data-index="${i}"></button>`;
    });

    html += `
    </div>
</div>
`;
    return html;
}

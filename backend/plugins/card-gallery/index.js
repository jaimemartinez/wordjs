/**
 * Card Gallery Plugin for WordJS
 * Create and manage multiple card galleries.
 * 
 * Usage: [card-gallery id="gallery-id"]
 */

const { v4: uuidv4 } = require('uuid');

exports.metadata = {
    name: 'Card Gallery',
    version: '2.0.0',
    description: 'Manage multiple card galleries with promo cards',
    author: 'WordJS'
};

// Store reference for cleanup
let registeredRouter = null;

exports.init = function () {
    const { getOption, updateOption } = require('../../src/core/options');
    const express = require('express');

    // === MIGRATION: Convert old cards to default gallery ===
    (async () => {
        const oldCardsList = await getOption('cards_list', null);
        if (oldCardsList && Array.isArray(oldCardsList) && oldCardsList.length > 0) {
            console.log('   Migrating old cards to default gallery...');

            // Collect old cards
            const oldCards = await Promise.all(oldCardsList.map(async id => {
                const data = await getOption(`card_${id}`, null);
                return data ? { ...data } : null;
            }));
            const validCards = oldCards.filter(Boolean);

            if (validCards.length > 0) {
                // Create default gallery with migrated cards
                const defaultGalleryId = 'default';
                const defaultGallery = {
                    name: 'Default Gallery',
                    cards: validCards,
                    location: '',
                    createdAt: new Date().toISOString()
                };

                await updateOption(`card_gallery_${defaultGalleryId}`, defaultGallery);

                // Initialize galleries list
                const galleriesList = await getOption('card_galleries_list', []);
                if (!galleriesList.includes(defaultGalleryId)) {
                    galleriesList.push(defaultGalleryId);
                    await updateOption('card_galleries_list', galleriesList);
                }

                // Clean up old data
                for (const id of oldCardsList) {
                    await updateOption(`card_${id}`, null);
                }
                await updateOption('cards_list', null);

                console.log(`   ✓ Migrated ${validCards.length} cards to Default Gallery`);
            }
        }
    })().catch(err => console.error('Card Gallery migration failed:', err));

    // === API ROUTES ===
    const router = express.Router();
    const { authenticate, optionalAuth } = require('../../src/middleware/auth');
    const { isAdmin } = require('../../src/middleware/permissions');

    // GET /api/v1/card-galleries - List all galleries (Public)
    // GET /api/v1/card-galleries - List all galleries (Public)
    router.get('/', async (req, res) => {
        const list = await getOption('card_galleries_list', []);

        // Parallel fetch
        const galleries = await Promise.all(list.map(async id => {
            const data = await getOption(`card_gallery_${id}`, null);
            return data ? { id, ...data, cardCount: (data.cards || []).length } : null;
        }));

        res.json(galleries.filter(Boolean));
    });

    // GET /api/v1/card-galleries/:id - Get single gallery with cards
    // GET /api/v1/card-galleries/:id - Get single gallery with cards
    router.get('/:id', async (req, res) => {
        const data = await getOption(`card_gallery_${req.params.id}`, null);
        if (!data) return res.status(404).json({ error: 'Gallery not found' });
        res.json({ id: req.params.id, ...data });
    });

    // POST /api/v1/card-galleries - Create gallery (Admin only)
    // POST /api/v1/card-galleries - Create gallery (Admin only)
    router.post('/', authenticate, isAdmin, async (req, res) => {
        const { name, cards = [], location = '' } = req.body;

        if (!name) return res.status(400).json({ error: 'Name is required' });

        const id = uuidv4().split('-')[0];
        const gallery = {
            name,
            cards,
            location,
            createdAt: new Date().toISOString()
        };

        await updateOption(`card_gallery_${id}`, gallery);

        const list = await getOption('card_galleries_list', []);
        list.push(id);
        await updateOption('card_galleries_list', list);

        res.json({ success: true, id, ...gallery });
    });

    // PUT /api/v1/card-galleries/:id - Update gallery (Admin only)
    // PUT /api/v1/card-galleries/:id - Update gallery (Admin only)
    router.put('/:id', authenticate, isAdmin, async (req, res) => {
        const existing = await getOption(`card_gallery_${req.params.id}`, null);
        if (!existing) return res.status(404).json({ error: 'Gallery not found' });

        const updated = { ...existing, ...req.body, updatedAt: new Date().toISOString() };
        delete updated.id; // Don't store id inside the data

        await updateOption(`card_gallery_${req.params.id}`, updated);
        res.json({ success: true, id: req.params.id, ...updated });
    });

    // DELETE /api/v1/card-galleries/:id - Delete gallery (Admin only)
    // DELETE /api/v1/card-galleries/:id - Delete gallery (Admin only)
    router.delete('/:id', authenticate, isAdmin, async (req, res) => {
        await updateOption(`card_gallery_${req.params.id}`, null);

        const list = await getOption('card_galleries_list', []);
        const index = list.indexOf(req.params.id);
        if (index > -1) {
            list.splice(index, 1);
            await updateOption('card_galleries_list', list);
        }
        res.json({ success: true });
    });

    // Register Routes
    const { getApp } = require('../../src/core/appRegistry');
    const app = getApp();
    if (app) {
        app.use('/api/v1/card-galleries', router);
        registeredRouter = router;
        console.log('   ✓ Card Gallery API routes registered at /api/v1/card-galleries');
    }

    // === REGISTER ADMIN MENU ===
    const { registerAdminMenu } = require('../../src/core/adminMenu');
    registerAdminMenu('card-gallery', {
        href: '/admin/plugin/cards',
        label: 'Card Gallery',
        icon: 'fa-images',
        order: 55,
        cap: 'manage_cards'
    });

    console.log('Card Gallery plugin v2.0 initialized!');
};

exports.deactivate = function () {
    const { unregisterAdminMenu } = require('../../src/core/adminMenu');
    unregisterAdminMenu('card-gallery');
    console.log('Card Gallery plugin deactivated');
};

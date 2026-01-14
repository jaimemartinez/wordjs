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
    const oldCardsList = getOption('cards_list', null);
    if (oldCardsList && Array.isArray(oldCardsList) && oldCardsList.length > 0) {
        console.log('   Migrating old cards to default gallery...');

        // Collect old cards
        const oldCards = oldCardsList.map(id => {
            const data = getOption(`card_${id}`, null);
            return data ? { ...data } : null;
        }).filter(Boolean);

        if (oldCards.length > 0) {
            // Create default gallery with migrated cards
            const defaultGalleryId = 'default';
            const defaultGallery = {
                name: 'Default Gallery',
                cards: oldCards,
                location: '',
                createdAt: new Date().toISOString()
            };

            updateOption(`card_gallery_${defaultGalleryId}`, defaultGallery);

            // Initialize galleries list
            const galleriesList = getOption('card_galleries_list', []);
            if (!galleriesList.includes(defaultGalleryId)) {
                galleriesList.push(defaultGalleryId);
                updateOption('card_galleries_list', galleriesList);
            }

            // Clean up old data
            oldCardsList.forEach(id => {
                updateOption(`card_${id}`, null);
            });
            updateOption('cards_list', null);

            console.log(`   ✓ Migrated ${oldCards.length} cards to Default Gallery`);
        }
    }

    // === API ROUTES ===
    const router = express.Router();
    const { authenticate, optionalAuth } = require('../../src/middleware/auth');
    const { isAdmin } = require('../../src/middleware/permissions');

    // GET /api/v1/card-galleries - List all galleries (Public)
    router.get('/', (req, res) => {
        const list = getOption('card_galleries_list', []);
        const galleries = list.map(id => {
            const data = getOption(`card_gallery_${id}`, null);
            return data ? { id, ...data, cardCount: (data.cards || []).length } : null;
        }).filter(Boolean);
        res.json(galleries);
    });

    // GET /api/v1/card-galleries/:id - Get single gallery with cards
    router.get('/:id', (req, res) => {
        const data = getOption(`card_gallery_${req.params.id}`, null);
        if (!data) return res.status(404).json({ error: 'Gallery not found' });
        res.json({ id: req.params.id, ...data });
    });

    // POST /api/v1/card-galleries - Create gallery (Admin only)
    router.post('/', authenticate, isAdmin, (req, res) => {
        const { name, cards = [], location = '' } = req.body;

        if (!name) return res.status(400).json({ error: 'Name is required' });

        const id = uuidv4().split('-')[0];
        const gallery = {
            name,
            cards,
            location,
            createdAt: new Date().toISOString()
        };

        updateOption(`card_gallery_${id}`, gallery);

        const list = getOption('card_galleries_list', []);
        list.push(id);
        updateOption('card_galleries_list', list);

        res.json({ success: true, id, ...gallery });
    });

    // PUT /api/v1/card-galleries/:id - Update gallery (Admin only)
    router.put('/:id', authenticate, isAdmin, (req, res) => {
        const existing = getOption(`card_gallery_${req.params.id}`, null);
        if (!existing) return res.status(404).json({ error: 'Gallery not found' });

        const updated = { ...existing, ...req.body, updatedAt: new Date().toISOString() };
        delete updated.id; // Don't store id inside the data

        updateOption(`card_gallery_${req.params.id}`, updated);
        res.json({ success: true, id: req.params.id, ...updated });
    });

    // DELETE /api/v1/card-galleries/:id - Delete gallery (Admin only)
    router.delete('/:id', authenticate, isAdmin, (req, res) => {
        updateOption(`card_gallery_${req.params.id}`, null);

        const list = getOption('card_galleries_list', []);
        const index = list.indexOf(req.params.id);
        if (index > -1) {
            list.splice(index, 1);
            updateOption('card_galleries_list', list);
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
        order: 55
    });

    console.log('Card Gallery plugin v2.0 initialized!');
};

exports.deactivate = function () {
    const { unregisterAdminMenu } = require('../../src/core/adminMenu');
    unregisterAdminMenu('card-gallery');
    console.log('Card Gallery plugin deactivated');
};

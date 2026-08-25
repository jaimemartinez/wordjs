/**
 * Card Gallery Plugin for WordJS — ISOLATED reference.
 *
 * Runs in a worker (manifest.isolated) and uses ONLY the injected `wordjs` capability bridge —
 * no direct require of core modules. This is the contract third-party plugins follow.
 * Routes are namespaced under /api/v1/plugin/card-gallery/* by the host.
 */

// Documentation only — nothing in the host reads it (the isolate calls exports.init and nothing else).
// It is kept in step with manifest.json, which IS what the catalog, the installer and the admin plugin
// list read: two version numbers that disagree name two different builds of the same package.
exports.metadata = {
    name: 'Card Gallery',
    version: '1.0.0',
    description: 'Manage multiple card galleries with promo cards (isolated)',
    author: 'WordJS'
};

exports.init = function (wordjs) {
    const { options, http, adminMenu } = wordjs;

    // tiny id generator (no uuid dependency needed inside the isolate)
    const newId = () => Math.random().toString(36).slice(2, 10);

    // === MIGRATION: convert old single-list cards into a default gallery (one-time) ===
    (async () => {
        const oldCardsList = await options.get('cards_list', null);
        if (oldCardsList && Array.isArray(oldCardsList) && oldCardsList.length > 0) {
            const oldCards = await Promise.all(oldCardsList.map(async id => await options.get(`card_${id}`, null)));
            const validCards = oldCards.filter(Boolean);
            if (validCards.length > 0) {
                await options.set('card_gallery_default', {
                    name: 'Default Gallery', cards: validCards, location: '', createdAt: new Date().toISOString()
                });
                const list = await options.get('card_galleries_list', []);
                if (!list.includes('default')) { list.push('default'); await options.set('card_galleries_list', list); }
                for (const id of oldCardsList) await options.set(`card_${id}`, null);
                await options.set('cards_list', null);
                console.log(`   ✓ Card Gallery: migrated ${validCards.length} cards to Default Gallery`);
            }
        }
    })().catch(err => console.error('Card Gallery migration failed:', err && err.message));

    // === API ROUTES (host namespaces them under /api/v1/plugin/card-gallery) ===

    // GET / — list all galleries (public)
    http.route('get', '/', async (req, res) => {
        const list = await options.get('card_galleries_list', []);
        const galleries = await Promise.all(list.map(async id => {
            const data = await options.get(`card_gallery_${id}`, null);
            return data ? { id, ...data, cardCount: (data.cards || []).length } : null;
        }));
        res.json(galleries.filter(Boolean));
    });

    // GET /:id — single gallery (public)
    http.route('get', '/:id', async (req, res) => {
        const data = await options.get(`card_gallery_${req.params.id}`, null);
        if (!data) return res.status(404).json({ error: 'Gallery not found' });
        res.json({ id: req.params.id, ...data });
    });

    // POST / — create gallery (admin)
    http.route('post', '/', { auth: true, admin: true }, async (req, res) => {
        const { name, cards = [], location = '' } = req.body || {};
        if (!name) return res.status(400).json({ error: 'Name is required' });
        const id = newId();
        const gallery = { name, cards, location, createdAt: new Date().toISOString() };
        await options.set(`card_gallery_${id}`, gallery);
        const list = await options.get('card_galleries_list', []);
        list.push(id);
        await options.set('card_galleries_list', list);
        res.json({ success: true, id, ...gallery });
    });

    // PUT /:id — update gallery (admin)
    http.route('put', '/:id', { auth: true, admin: true }, async (req, res) => {
        const existing = await options.get(`card_gallery_${req.params.id}`, null);
        if (!existing) return res.status(404).json({ error: 'Gallery not found' });
        const body = req.body || {};
        // Whitelist updatable fields so arbitrary keys can't be injected and createdAt is preserved.
        const updated = { ...existing };
        if (body.name !== undefined) updated.name = body.name;
        if (body.cards !== undefined) updated.cards = body.cards;
        if (body.location !== undefined) updated.location = body.location;
        updated.createdAt = existing.createdAt;
        updated.updatedAt = new Date().toISOString();
        delete updated.id;
        await options.set(`card_gallery_${req.params.id}`, updated);
        res.json({ success: true, id: req.params.id, ...updated });
    });

    // DELETE /:id — delete gallery (admin)
    http.route('delete', '/:id', { auth: true, admin: true }, async (req, res) => {
        await options.set(`card_gallery_${req.params.id}`, null);
        const list = await options.get('card_galleries_list', []);
        const i = list.indexOf(req.params.id);
        if (i > -1) { list.splice(i, 1); await options.set('card_galleries_list', list); }
        res.json({ success: true });
    });

    // === ADMIN MENU ===
    adminMenu.add({
        href: '/admin/plugin/cards',
        label: 'Card Gallery',
        icon: 'fa-images',
        order: 55,
        cap: 'manage_cards'
    });

    console.log('Card Gallery plugin v3.0 initialized (isolated)!');
};

exports.deactivate = function () {
    console.log('Card Gallery plugin deactivated');
};

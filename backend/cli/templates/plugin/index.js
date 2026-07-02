/**
 * __NAME__ — an isolated WordJS plugin.
 *
 * Runs in its own OS process (`"isolated": true` in manifest.json — REQUIRED; activation is
 * rejected without it) and reaches core ONLY through the injected `wordjs` capability bridge.
 * Never require() core modules — the sandbox blocks that. The host namespaces your routes
 * under /api/v1/plugin/__SLUG__/*.
 *
 * Every bridge call is permission-checked against the `permissions` your manifest DECLARES
 * AND what the admin GRANTED (default-deny). See documentation/plugins.md §11–12.
 */

/** @typedef {import('../../types/wordjs-bridge').WordJS} WordJS */

exports.metadata = {
    name: '__NAME__',
    version: '0.1.0',
    description: 'A WordJS plugin scaffolded with `wordjs create plugin`.',
    author: 'Your Name'
};

/** @param {WordJS} wordjs */
exports.init = function (wordjs) {
    const { options, http, adminMenu } = wordjs;

    // Options are GLOBAL key/value pairs — always prefix yours with your slug so they can't
    // collide with core or other plugins (secret-named keys are blocked by the sandbox).
    const ITEMS_KEY = '__SLUG___items';

    // Tiny id generator (no uuid dependency needed inside the isolate).
    const newId = () => Math.random().toString(36).slice(2, 10);

    // === API ROUTES (the host mounts them under /api/v1/plugin/__SLUG__) ===

    // GET / — list items (public)
    http.route('get', '/', async (req, res) => {
        const items = await options.get(ITEMS_KEY, []);
        res.json(items);
    });

    // POST / — create an item (admin only: the host runs the REAL auth middleware first)
    http.route('post', '/', { auth: true, admin: true }, async (req, res) => {
        const { title } = req.body || {};
        if (!title) return res.status(400).json({ error: 'title is required' });
        const items = await options.get(ITEMS_KEY, []);
        const item = { id: newId(), title: String(title), createdAt: new Date().toISOString() };
        items.push(item);
        await options.set(ITEMS_KEY, items);
        res.json({ success: true, item });
    });

    // DELETE /:id — remove an item (admin)
    http.route('delete', '/:id', { auth: true, admin: true }, async (req, res) => {
        const items = await options.get(ITEMS_KEY, []);
        const next = items.filter((it) => it.id !== req.params.id);
        if (next.length === items.length) return res.status(404).json({ error: 'Item not found' });
        await options.set(ITEMS_KEY, next);
        res.json({ success: true });
    });

    // === ADMIN MENU (sidebar entry that opens client/admin/page.tsx) ===
    adminMenu.add({
        href: '/admin/plugin/__SLUG__',
        label: '__NAME__',
        icon: 'fa-puzzle-piece',
        order: 60
    });

    console.log('__NAME__ plugin initialized (isolated)!');
};

exports.deactivate = function () {
    console.log('__NAME__ plugin deactivated');
};

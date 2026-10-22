/**
 * Photo Carousel Plugin for WordJS — ISOLATED.
 *
 * Runs in a worker (manifest.isolated) and uses ONLY the injected `wordjs` capability bridge —
 * no direct require of core modules, express, or uuid.
 * Routes are namespaced under /api/v1/plugin/photo-carousel/* by the host.
 *
 * - CRUD API for carousels
 * - Shortcode [carousel id="X"] for embedding (async)
 *
 * Usage: [carousel id="my-carousel"]
 */

exports.metadata = {
    name: 'Photo Carousel',
    version: '2.1.2',
    description: 'Create and manage image carousels with admin UI',
    author: 'WordJS'
};

exports.init = function (wordjs) {
    const { options, http, shortcodes, adminMenu } = wordjs;

    // tiny id generator (no uuid dependency needed inside the isolate)
    const newId = () => Math.random().toString(36).slice(2, 10);

    // === API ROUTES (host namespaces them under /api/v1/plugin/photo-carousel) ===

    // Public callers never see an error's text: a driver's message names tables, columns and
    // constraints. The details go to the server log.
    const failQuietly = (res, e, what) => {
        console.error(`[photo-carousel] ${what} failed:`, e && e.message ? e.message : e);
        res.status(500).json({ error: 'No se pudo completar la operación. Inténtalo de nuevo.' });
    };
    // Public routes answer every failure themselves, through failQuietly: a public caller only ever
    // gets a reply this plugin wrote.
    const quietly = (what, handler) => async (req, res) => {
        try { await handler(req, res); } catch (e) { failQuietly(res, e, what); }
    };

    // GET / — list all carousels (public)
    http.route('get', '/', quietly('carousel list', async (req, res) => {
        const list = await options.get('carousels_list', []);

        // Parallel fetch of all items
        const carousels = await Promise.all(list.map(async id => {
            const data = await options.get(`carousel_${id}`, null);
            return data ? { id, ...data } : null;
        }));

        res.json(carousels.filter(Boolean));
    }));

    // GET /location/:location — get carousel by location (e.g. 'hero') (public)
    // NOTE: registered before /:id so it is not shadowed by the param route.
    http.route('get', '/location/:location', quietly('carousels by location', async (req, res) => {
        const list = await options.get('carousels_list', []);

        // Find carousel with matching location
        let found = null;
        let foundId = null;

        for (const id of list) {
            const data = await options.get(`carousel_${id}`, null);
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
    }));

    // GET /:id — get single carousel (public)
    http.route('get', '/:id', quietly('carousel', async (req, res) => {
        const data = await options.get(`carousel_${req.params.id}`, null);
        if (!data) {
            return res.status(404).json({ error: 'Carousel not found' });
        }
        res.json({ id: req.params.id, ...data });
    }));

    // POST / — create carousel (admin)
    http.route('post', '/', { auth: true, admin: true }, async (req, res) => {
        const { name, images = [], autoplay = true, interval = 5000, location = '' } = req.body || {};

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const id = newId(); // Short ID
        const carousel = { name, images, autoplay, interval, location, createdAt: new Date().toISOString() };

        await options.set(`carousel_${id}`, carousel);

        // Update list
        const list = await options.get('carousels_list', []);
        list.push(id);
        await options.set('carousels_list', list);

        res.json({ success: true, id, ...carousel });
    });

    // PUT /:id — update carousel (admin)
    http.route('put', '/:id', { auth: true, admin: true }, async (req, res) => {
        const existing = await options.get(`carousel_${req.params.id}`, null);
        if (!existing) {
            return res.status(404).json({ error: 'Carousel not found' });
        }

        const { name, images, autoplay, interval, location } = req.body || {};
        const updated = {
            ...existing,
            name: name !== undefined ? name : existing.name,
            images: images !== undefined ? images : existing.images,
            autoplay: autoplay !== undefined ? autoplay : existing.autoplay,
            interval: interval !== undefined ? interval : existing.interval,
            location: location !== undefined ? location : existing.location,
            updatedAt: new Date().toISOString()
        };

        await options.set(`carousel_${req.params.id}`, updated);
        res.json({ success: true, id: req.params.id, ...updated });
    });

    // DELETE /:id — delete carousel (admin)
    http.route('delete', '/:id', { auth: true, admin: true }, async (req, res) => {
        const existing = await options.get(`carousel_${req.params.id}`, null);
        if (!existing) {
            return res.status(404).json({ error: 'Carousel not found' });
        }

        await options.set(`carousel_${req.params.id}`, null);

        // Remove from list
        const list = await options.get('carousels_list', []);
        const index = list.indexOf(req.params.id);
        if (index > -1) {
            list.splice(index, 1);
            await options.set('carousels_list', list);
        }

        res.json({ success: true });
    });

    // === SHORTCODE (async — fixes the missing-await bug from the old code) ===
    shortcodes.add('carousel', async (attrs) => {
        // Require a carousel ID
        if (!attrs.id) {
            return ''; // No ID provided, render nothing
        }

        const carousel = await options.get(`carousel_${attrs.id}`, null);
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

    // === ADMIN MENU ===
    adminMenu.add({
        href: '/admin/plugin/carousels',
        label: 'Photo Carousel',
        // Shown in the admin's language (sidebar); `label` stays for cores without per-language labels.
        labels: { en: 'Photo Carousel', es: 'Carrusel de fotos', pt: 'Carrossel de fotos' },
        icon: 'fa-images',
        order: 50,
        cap: 'manage_carousels'
    });

    console.log('Photo Carousel plugin v2.0 initialized (isolated)!');
};

exports.deactivate = function () {
    console.log('Photo Carousel plugin deactivated');
};

// === CAROUSEL RENDERER ===
//
// The [carousel] output lands in SANITIZED post HTML: the host's sanitizer drops <style> blocks, layout
// inline styles and every script, so a carousel here can only be MARKUP that site CSS already styles. It
// uses the host's plugin-neutral `wjs-snap-strip` primitive (backend/public/css/wordjs-ui.css): a
// swipeable, scroll-snapping row that needs no JavaScript. (Until 2.1.0 this emitted its own <style> and
// buttons and relied on an initialiser inside the host's frontend; the sanitizer had always stripped the
// styles, and the host no longer carries plugin-specific code.) Autoplay is not offered on this path;
// the Verso block and the hero component keep their own behaviour.
const escAttr = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderCarousel(images, _settings) {
    const total = images.length;
    let html = `<div class="wjs-snap-strip wjs-snap-strip--16x9 photo-carousel" role="region" aria-roledescription="carousel" aria-label="Photo carousel (${total} images)" tabindex="0">`;
    images.forEach((img, i) => {
        const url = typeof img === 'string' ? img : (img && img.url);
        if (!url) return;
        const caption = img && typeof img === 'object' ? (img.caption || img.title || '') : '';
        const alt = (img && typeof img === 'object' && img.alt) || caption || `Slide ${i + 1} of ${total}`;
        html += `<figure class="wjs-snap-strip__item" aria-roledescription="slide" aria-label="${i + 1} / ${total}">`
            + `<img src="${escAttr(url)}" alt="${escAttr(alt)}" loading="${i === 0 ? 'eager' : 'lazy'}">`
            + (caption ? `<figcaption class="wjs-snap-strip__caption">${escText(caption)}</figcaption>` : '')
            + `</figure>`;
    });
    html += `</div>`;
    return html;
}

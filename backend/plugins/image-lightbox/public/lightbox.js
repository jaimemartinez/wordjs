/*
 * Image Lightbox — WordJS plugin public script.
 * Plain-browser IIFE: no template literals, direct calls only, everything defensive.
 * Fetches its config from the plugin's public endpoint; does nothing when disabled.
 */
(function () {
    try {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        if (window.__wjsImageLightboxLoaded) return; // idempotent across double injection
        window.__wjsImageLightboxLoaded = true;

        var CONFIG_URL = '/api/v1/plugin/image-lightbox/public/config';
        var IMG_HREF_RE = /\.(jpg|jpeg|png|webp|gif|avif)([?#].*)?$/i;
        // Never lightbox chrome/admin imagery, nor the lightbox's own <img>.
        var EXCLUDE_SEL = 'header, nav, footer, .wjs-ilb-overlay, [class*="admin-bar"], [id*="admin-bar"]';
        var MIN_WIDTH = 100;

        var scopeSel = '.wjs-content'; // overwritten by config; comma-separated lists allowed
        var showCaptions = true;

        var overlay = null;
        var figEl = null;
        var imgEl = null;
        var captionEl = null;
        var counterEl = null;
        var items = [];        // [{src, caption}] — the page's lightboxable images
        var current = 0;
        var savedOverflow = null; // body overflow remembered while the overlay is open

        function isImageHref(href) {
            try { return IMG_HREF_RE.test(String(href || '')); } catch (e) { return false; }
        }

        function safeClosest(el, sel) {
            try { return el && el.closest ? el.closest(sel) : null; } catch (e) { return null; }
        }

        /**
         * The scope container the image belongs to, or null. When the configured selector
         * matches nothing on the whole page, fall back to 'main'.
         */
        function scopeRootFor(el) {
            var hit = safeClosest(el, scopeSel);
            if (hit) return hit;
            var anywhere = null;
            try { anywhere = document.querySelector(scopeSel); } catch (e) { anywhere = null; }
            if (!anywhere) return safeClosest(el, 'main');
            return null;
        }

        function renderedWidth(img) {
            try {
                var r = img.getBoundingClientRect();
                return r.width || img.clientWidth || 0;
            } catch (e) { return 0; }
        }

        /** Decide whether this <img> is lightboxable; returns {src, caption} or null. */
        function itemFor(img) {
            try {
                if (!img || img.tagName !== 'IMG') return null;
                if (safeClosest(img, EXCLUDE_SEL)) return null;
                if (!scopeRootFor(img)) return null;
                if (renderedWidth(img) < MIN_WIDTH) return null; // icons, avatars, spacers
                var src = img.currentSrc || img.src || '';
                var link = safeClosest(img, 'a');
                if (link) {
                    var href = link.getAttribute('href') || '';
                    // Thumbnail linking to the full-size image → open THAT; any other link → hands off.
                    if (!isImageHref(href)) return null;
                    src = link.href || href;
                }
                if (!src) return null;
                return { src: src, caption: String(img.getAttribute('alt') || '') };
            } catch (e) { return null; }
        }

        /** All lightboxable images on the page, in document order (the prev/next cycle). */
        function collectItems() {
            var out = [];
            var imgs;
            try { imgs = document.getElementsByTagName('img'); } catch (e) { return out; }
            for (var i = 0; i < imgs.length; i++) {
                var it = itemFor(imgs[i]);
                if (it) out.push(it);
            }
            return out;
        }

        function preloadNeighbors(idx) {
            try {
                if (items.length < 2) return;
                var next = new Image();
                next.src = items[(idx + 1) % items.length].src;
                var prev = new Image();
                prev.src = items[(idx - 1 + items.length) % items.length].src;
            } catch (e) {}
        }

        function show(idx) {
            try {
                if (!items.length || !imgEl) return;
                current = ((idx % items.length) + items.length) % items.length;
                var it = items[current];
                imgEl.src = it.src;
                if (showCaptions && it.caption) {
                    captionEl.textContent = it.caption;
                    captionEl.style.display = '';
                } else {
                    captionEl.textContent = '';
                    captionEl.style.display = 'none';
                }
                counterEl.textContent = (current + 1) + ' / ' + items.length;
                preloadNeighbors(current);
            } catch (e) {}
        }

        function step(delta) { show(current + delta); }

        function onKeyDown(ev) {
            try {
                if (ev.key === 'Escape') { ev.preventDefault(); closeLightbox(); }
                else if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
                else if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
            } catch (e) {}
        }

        function buildOverlay() {
            if (overlay) return;
            overlay = document.createElement('div');
            overlay.className = 'wjs-ilb-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-label', 'Visor de imagen');

            figEl = document.createElement('figure');
            figEl.className = 'wjs-ilb-figure';

            imgEl = document.createElement('img');
            imgEl.className = 'wjs-ilb-img';
            imgEl.setAttribute('decoding', 'async');
            imgEl.alt = '';

            captionEl = document.createElement('figcaption');
            captionEl.className = 'wjs-ilb-caption';

            counterEl = document.createElement('div');
            counterEl.className = 'wjs-ilb-counter';

            var prevBtn = document.createElement('button');
            prevBtn.type = 'button';
            prevBtn.className = 'wjs-ilb-btn wjs-ilb-prev';
            prevBtn.setAttribute('aria-label', 'Imagen anterior');
            prevBtn.textContent = '‹';
            prevBtn.addEventListener('click', function (ev) {
                try { ev.stopPropagation(); step(-1); } catch (e) {}
            });

            var nextBtn = document.createElement('button');
            nextBtn.type = 'button';
            nextBtn.className = 'wjs-ilb-btn wjs-ilb-next';
            nextBtn.setAttribute('aria-label', 'Imagen siguiente');
            nextBtn.textContent = '›';
            nextBtn.addEventListener('click', function (ev) {
                try { ev.stopPropagation(); step(1); } catch (e) {}
            });

            var closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'wjs-ilb-btn wjs-ilb-close';
            closeBtn.setAttribute('aria-label', 'Cerrar');
            closeBtn.textContent = '×';
            closeBtn.addEventListener('click', function (ev) {
                try { ev.stopPropagation(); closeLightbox(); } catch (e) {}
            });

            figEl.appendChild(imgEl);
            figEl.appendChild(captionEl);
            overlay.appendChild(figEl);
            overlay.appendChild(prevBtn);
            overlay.appendChild(nextBtn);
            overlay.appendChild(closeBtn);
            overlay.appendChild(counterEl);

            // Clicking the dark backdrop (overlay or bare figure padding) closes.
            overlay.addEventListener('click', function (ev) {
                try { if (ev.target === overlay || ev.target === figEl) closeLightbox(); } catch (e) {}
            });

            document.body.appendChild(overlay);
        }

        function openLightbox(startItem) {
            try {
                buildOverlay();
                items = collectItems();
                if (!items.length) items = [startItem];
                current = 0;
                for (var i = 0; i < items.length; i++) {
                    if (items[i].src === startItem.src) { current = i; break; }
                }
                overlay.className = items.length < 2 ? 'wjs-ilb-overlay wjs-ilb-single' : 'wjs-ilb-overlay';
                savedOverflow = document.body.style.overflow; // remember + restore on close
                document.body.style.overflow = 'hidden';
                document.addEventListener('keydown', onKeyDown, true);
                show(current);
                overlay.style.display = 'flex';
                window.setTimeout(function () {
                    try { overlay.classList.add('wjs-ilb-open'); } catch (e) {}
                }, 0);
            } catch (e) {}
        }

        function closeLightbox() {
            try {
                if (!overlay) return;
                overlay.classList.remove('wjs-ilb-open');
                overlay.style.display = 'none';
                if (imgEl) imgEl.removeAttribute('src');
                document.removeEventListener('keydown', onKeyDown, true);
                if (savedOverflow !== null) {
                    document.body.style.overflow = savedOverflow;
                    savedOverflow = null;
                }
            } catch (e) {}
        }

        function onDocClick(ev) {
            try {
                if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; // keep native modified clicks
                var target = ev.target;
                var img = (target && target.tagName === 'IMG') ? target : safeClosest(target, 'img');
                if (!img) return;
                var it = itemFor(img);
                if (!it) return;
                ev.preventDefault();
                ev.stopPropagation();
                openLightbox(it);
            } catch (e) {}
        }

        // Cursor affordance: mark qualifying images with a zoom-in cursor class on hover.
        function onDocOver(ev) {
            try {
                var t = ev.target;
                if (!t || t.tagName !== 'IMG' || !t.classList) return;
                if (itemFor(t)) t.classList.add('wjs-ilb-zoomable');
                else t.classList.remove('wjs-ilb-zoomable');
            } catch (e) {}
        }

        function bind() {
            document.addEventListener('click', onDocClick, true);
            document.addEventListener('mouseover', onDocOver, true);
        }

        function start() {
            fetch(CONFIG_URL, { credentials: 'same-origin' })
                .then(function (r) { return r && r.ok ? r.json() : null; })
                .then(function (cfg) {
                    try {
                        if (!cfg || cfg.enabled === false) return; // disabled (or plugin inactive) → inert
                        showCaptions = cfg.captions !== false;
                        if (typeof cfg.scope === 'string' && cfg.scope.trim() && cfg.scope.indexOf('<') === -1) {
                            scopeSel = cfg.scope.trim();
                        }
                        bind();
                    } catch (e) {}
                })
                .catch(function () {});
        }

        start();
    } catch (e) {}
})();

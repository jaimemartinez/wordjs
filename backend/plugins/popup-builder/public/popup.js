/**
 * Popup Builder — public runtime (plain browser IIFE, AST-safe: no template literals,
 * no computed calls, string concatenation only).
 *
 * Fetches the active popup, applies the frequency cap and the trigger, renders the overlay,
 * and reports view/click events. Storage key: 'wjpb_' + id + '_' + version — bumping the
 * popup version server-side makes every visitor eligible again.
 */
(function () {
    try {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;

        var API_BASE = '/api/v1/plugin/popup-builder';
        var DAY_MS = 24 * 60 * 60 * 1000;
        var shown = false;

        function postEvent(popupId, eventName) {
            try {
                // keepalive: the CTA click navigates immediately — without it the in-flight POST
                // is aborted on unload and click stats undercount.
                fetch(API_BASE + '/public/event', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ popup_id: popupId, event: eventName }),
                    keepalive: true
                }).catch(function () {});
            } catch (e) {}
        }

        function storageKey(popup) {
            return 'wjpb_' + popup.id + '_' + popup.version;
        }

        /* Frequency gate. 'always' never blocks. If storage is unavailable, show. */
        function alreadySeen(popup) {
            try {
                var key = storageKey(popup);
                if (popup.frequency === 'always') return false;
                if (popup.frequency === 'session') {
                    return sessionStorage.getItem(key) === '1';
                }
                if (popup.frequency === 'visitor') {
                    return localStorage.getItem(key) !== null;
                }
                if (popup.frequency === 'daily') {
                    var raw = localStorage.getItem(key);
                    if (!raw) return false;
                    var ts = parseInt(raw, 10);
                    if (!ts || isNaN(ts)) return false;
                    return (Date.now() - ts) < DAY_MS;
                }
            } catch (e) {}
            return false;
        }

        /* Record the frequency key so the popup does not come back before it should. */
        function markSeen(popup) {
            try {
                var key = storageKey(popup);
                if (popup.frequency === 'session') {
                    sessionStorage.setItem(key, '1');
                } else if (popup.frequency === 'visitor') {
                    localStorage.setItem(key, '1');
                } else if (popup.frequency === 'daily') {
                    localStorage.setItem(key, String(Date.now()));
                }
            } catch (e) {}
        }

        /* Only http(s) or site-relative CTA URLs get rendered (defense in depth; the server validates too). */
        function safeUrl(u) {
            var s = String(u || '');
            if (s.indexOf('/') === 0) return s;
            if (s.indexOf('http://') === 0 || s.indexOf('https://') === 0) return s;
            return '';
        }

        function render(popup) {
            try {
                var overlay = document.createElement('div');
                overlay.className = 'wjpb-overlay';

                var card = document.createElement('div');
                card.className = 'wjpb-card';
                card.setAttribute('role', 'dialog');
                card.setAttribute('aria-modal', 'true');

                var closeBtn = document.createElement('button');
                closeBtn.type = 'button';
                closeBtn.className = 'wjpb-close';
                closeBtn.setAttribute('aria-label', 'Cerrar');
                closeBtn.textContent = '×';
                card.appendChild(closeBtn);

                if (popup.image_url) {
                    var img = document.createElement('img');
                    img.className = 'wjpb-img';
                    img.decoding = 'async';
                    img.alt = popup.title || '';
                    img.src = popup.image_url;
                    card.appendChild(img);
                }

                var title = document.createElement('h3');
                title.className = 'wjpb-title';
                title.textContent = popup.title || '';
                card.appendChild(title);

                if (popup.body) {
                    var body = document.createElement('p');
                    body.className = 'wjpb-body';
                    body.textContent = popup.body;
                    card.appendChild(body);
                }

                var ctaUrl = safeUrl(popup.button_url);
                if (popup.button_label && ctaUrl) {
                    var cta = document.createElement('a');
                    cta.className = 'wjpb-btn';
                    cta.href = ctaUrl;
                    cta.textContent = popup.button_label;
                    cta.addEventListener('click', function () {
                        markSeen(popup);
                        postEvent(popup.id, 'click');
                    });
                    card.appendChild(cta);
                }

                var onKey = function (e) {
                    if (e.key === 'Escape') closeNow();
                };
                function closeNow() {
                    markSeen(popup);
                    document.removeEventListener('keydown', onKey);
                    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                }

                closeBtn.addEventListener('click', closeNow);
                overlay.addEventListener('click', function (e) {
                    if (e.target === overlay) closeNow();
                });
                document.addEventListener('keydown', onKey);

                overlay.appendChild(card);
                document.body.appendChild(overlay);
                postEvent(popup.id, 'view');
            } catch (e) {}
        }

        function showOnce(popup) {
            if (shown) return;
            if (alreadySeen(popup)) return; /* re-check: another tab may have closed it meanwhile */
            shown = true;
            render(popup);
        }

        function armTrigger(popup) {
            var type = popup.trigger_type || 'delay';
            var value = parseInt(popup.trigger_value, 10);
            if (isNaN(value) || value < 0) value = 3;

            if (type === 'scroll') {
                var onScroll = function () {
                    try {
                        var doc = document.documentElement;
                        var scrollTop = window.pageYOffset || doc.scrollTop || 0;
                        var range = (doc.scrollHeight || 0) - window.innerHeight;
                        var pct = range > 0 ? (scrollTop / range) * 100 : 100;
                        if (pct >= value) {
                            window.removeEventListener('scroll', onScroll);
                            showOnce(popup);
                        }
                    } catch (e) {}
                };
                window.addEventListener('scroll', onScroll, { passive: true });
                onScroll(); /* a short page may already satisfy the threshold */
                return;
            }

            if (type === 'exit') {
                var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
                if (isTouch) {
                    /* No exit intent on touch devices — fall back to a 15 s delay. */
                    setTimeout(function () { showOnce(popup); }, 15000);
                    return;
                }
                var onOut = function (e) {
                    /* Cursor left through the top of the viewport (toward the URL bar / tabs). */
                    if (e.clientY <= 0 && !e.relatedTarget) {
                        document.removeEventListener('mouseout', onOut);
                        showOnce(popup);
                    }
                };
                document.addEventListener('mouseout', onOut);
                return;
            }

            /* default: 'delay' (seconds) */
            setTimeout(function () { showOnce(popup); }, value * 1000);
        }

        function start() {
            try {
                fetch(API_BASE + '/public/active')
                    .then(function (res) { return res.ok ? res.json() : null; })
                    .then(function (popup) {
                        if (!popup || !popup.id) return;
                        if (alreadySeen(popup)) return;
                        armTrigger(popup);
                    })
                    .catch(function () {});
            } catch (e) {}
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            start();
        }
    } catch (e) {}
})();

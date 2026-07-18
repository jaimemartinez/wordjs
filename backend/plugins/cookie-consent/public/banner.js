/*
 * WordJS cookie-consent public banner. Plain browser JS — no imports, no build step.
 * Enqueued site-wide via the assets bridge while the plugin is active.
 *
 * Flow: fetch the public config -> if disabled, do nothing -> if a stored consent exists for the
 * current (or a newer) config version, just expose it (window.wjsCookieConsent + 'wjs-consent'
 * document event) -> otherwise render the banner and record the visitor's choice.
 *
 * NOTE: this file is scanned by the plugin AST validator — plain direct calls and string
 * concatenation only (no template literals, no dynamic/computed calls).
 */
(function () {
    try {
        var STORAGE_KEY = 'wjs_cookie_consent';
        var API_BASE = '/api/v1/plugin/cookie-consent';
        var FADE_MS = 350;

        // Guard against a double inclusion of the script.
        if (window.wjccBannerLoaded) return;
        window.wjccBannerLoaded = true;

        /* Expose the choice to the page: a window property plus a document event other scripts
         * can listen to (e.g. to load analytics only after 'accepted'). */
        function applyChoice(choice) {
            window.wjsCookieConsent = choice;
            try {
                document.dispatchEvent(new CustomEvent('wjs-consent', { detail: { choice: choice } }));
            } catch (e) { /* CustomEvent unsupported — the window property is still set */ }
        }

        /* Read the stored consent: { choice, version, ts } or null when absent/corrupt. */
        function readStored() {
            try {
                var raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return null;
                var parsed = JSON.parse(raw);
                if (!parsed) return null;
                if (parsed.choice !== 'accepted' && parsed.choice !== 'rejected') return null;
                return parsed;
            } catch (e) {
                return null;
            }
        }

        function saveChoice(choice, version) {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({ choice: choice, version: version, ts: Date.now() }));
            } catch (e) { /* storage full/blocked — the banner will simply re-ask next visit */ }
        }

        /* Fire-and-forget anonymous log; stats are best-effort and must never break the page. */
        function logChoice(choice) {
            try {
                fetch(API_BASE + '/public/log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ choice: choice })
                }).catch(function () {});
            } catch (e) { /* ignore */ }
        }

        /* Build the banner DOM. Admin-authored texts go through textContent (never innerHTML). */
        function buildBanner(cfg) {
            var position = cfg.position === 'corner' ? 'corner' : 'bottom';
            var theme = cfg.theme === 'light' ? 'light' : 'dark';

            var banner = document.createElement('div');
            banner.className = 'wjcc-banner wjcc-' + position + ' wjcc-' + theme;
            banner.setAttribute('role', 'dialog');
            banner.setAttribute('aria-live', 'polite');
            banner.setAttribute('aria-label', 'Consentimiento de cookies');

            var msg = document.createElement('p');
            msg.className = 'wjcc-message';
            msg.textContent = String(cfg.message || '');
            banner.appendChild(msg);

            if (cfg.policyUrl) {
                var link = document.createElement('a');
                link.className = 'wjcc-policy';
                link.textContent = 'Política de cookies';
                link.href = String(cfg.policyUrl);
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                banner.appendChild(link);
            }

            var actions = document.createElement('div');
            actions.className = 'wjcc-actions';

            var version = typeof cfg.version === 'number' ? cfg.version : 1;

            function choose(choice) {
                saveChoice(choice, version);
                applyChoice(choice);
                logChoice(choice);
                banner.className = banner.className + ' wjcc-hide';
                window.setTimeout(function () {
                    if (banner.parentNode) banner.parentNode.removeChild(banner);
                }, FADE_MS);
            }

            var reject = document.createElement('button');
            reject.type = 'button';
            reject.className = 'wjcc-btn wjcc-reject';
            reject.textContent = String(cfg.rejectLabel || 'Rechazar');
            reject.addEventListener('click', function () { choose('rejected'); });
            actions.appendChild(reject);

            var accept = document.createElement('button');
            accept.type = 'button';
            accept.className = 'wjcc-btn wjcc-accept';
            accept.textContent = String(cfg.acceptLabel || 'Aceptar');
            accept.addEventListener('click', function () { choose('accepted'); });
            actions.appendChild(accept);

            banner.appendChild(actions);
            return banner;
        }

        function mount(banner) {
            if (document.body) {
                document.body.appendChild(banner);
            } else {
                document.addEventListener('DOMContentLoaded', function () {
                    if (document.body) document.body.appendChild(banner);
                });
            }
        }

        function start(cfg) {
            if (!cfg || cfg.enabled !== true) return;
            var version = typeof cfg.version === 'number' ? cfg.version : 1;
            var stored = readStored();
            if (stored && typeof stored.version === 'number' && stored.version >= version) {
                // Valid consent for this config version — expose it and never show the banner.
                applyChoice(stored.choice);
                return;
            }
            mount(buildBanner(cfg));
        }

        fetch(API_BASE + '/public/config')
            .then(function (res) {
                if (!res.ok) return null;
                return res.json();
            })
            .then(function (cfg) {
                try { start(cfg); } catch (e) { /* never break the host page */ }
            })
            .catch(function () {});
    } catch (e) { /* never break the host page */ }
})();

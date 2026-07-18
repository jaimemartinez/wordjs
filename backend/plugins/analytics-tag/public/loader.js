/**
 * WordJS Analytics Tag — public loader (enqueued site-wide via the assets bridge).
 *
 * Fetches the plugin config and injects the configured analytics tag (GA4 / Plausible /
 * Matomo). When "respectConsent" is on it waits for the cookie-consent plugin's verdict
 * (window.wjsCookieConsent plus the 'wjs-consent' CustomEvent on document) and degrades
 * to immediate injection when no consent manager is installed.
 *
 * Written as a plain browser IIFE with string concatenation only (no template literals,
 * no computed calls) so the plugin source validator accepts it.
 */
(function () {
    try {
        // Injection guard: whatever path leads here (consent event firing twice, timeout
        // racing the event), the tag is only ever injected once.
        var started = false;

        function injectGa4(id) {
            var s = document.createElement('script');
            s.async = true;
            s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
            document.head.appendChild(s);
            window.dataLayer = window.dataLayer || [];
            // Canonical gtag(): push the Arguments object itself. gtag.js only executes
            // command entries that pass its isArguments check — a real Array is routed to
            // the legacy GTM path and 'js'/'config' silently no-op (zero measurement).
            // The plugin validator only blocks `arguments.<prop>` reads and aliasing of
            // OTHER globals; a bare `arguments` as a call argument passes the AST scan.
            window.gtag = function () { window.dataLayer.push(arguments); };
            window.gtag('js', new Date());
            window.gtag('config', id);
        }

        function injectPlausible(domain) {
            var s = document.createElement('script');
            s.defer = true;
            s.src = 'https://plausible.io/js/script.js';
            s.setAttribute('data-domain', domain);
            document.head.appendChild(s);
        }

        function injectMatomo(url, siteId) {
            var base = url;
            while (base.length > 0 && base.charAt(base.length - 1) === '/') {
                base = base.slice(0, base.length - 1);
            }
            window._paq = window._paq || [];
            window._paq.push(['trackPageView']);
            window._paq.push(['enableLinkTracking']);
            window._paq.push(['setTrackerUrl', base + '/matomo.php']);
            window._paq.push(['setSiteId', siteId]);
            var s = document.createElement('script');
            s.async = true;
            s.src = base + '/matomo.js';
            document.head.appendChild(s);
        }

        function startTracking(cfg) {
            if (started) { return; }
            started = true;
            if (cfg.provider === 'ga4') {
                injectGa4(cfg.ga4Id);
            } else if (cfg.provider === 'plausible') {
                injectPlausible(cfg.plausibleDomain);
            } else if (cfg.provider === 'matomo') {
                injectMatomo(cfg.matomoUrl, cfg.matomoSiteId);
            }
        }

        // Enabled AND the active provider has everything it needs.
        function isConfigured(cfg) {
            if (!cfg || !cfg.enabled) { return false; }
            if (cfg.provider === 'ga4') { return !!cfg.ga4Id; }
            if (cfg.provider === 'plausible') { return !!cfg.plausibleDomain; }
            if (cfg.provider === 'matomo') { return !!(cfg.matomoUrl && cfg.matomoSiteId); }
            return false;
        }

        function gateOnConsent(cfg) {
            if (!cfg.respectConsent) {
                startTracking(cfg);
                return;
            }
            if (window.wjsCookieConsent === 'accepted') {
                startTracking(cfg);
                return;
            }
            if (window.wjsCookieConsent === 'rejected') {
                return;
            }
            // Verdict not decided yet: either the banner is still on screen, or the
            // cookie-consent plugin is not installed at all.
            document.addEventListener('wjs-consent', function (ev) {
                var choice = ev && ev.detail ? ev.detail.choice : null;
                if (choice === 'accepted') { startTracking(cfg); }
            });
            // If after 3s nothing has claimed the consent slot AND no consent manager is
            // present, track without gating. The cookie-consent plugin sets
            // window.wjccBannerLoaded = true synchronously at parse time (before any
            // verdict exists), so an undecided visitor with the banner still on screen
            // keeps the tag blocked until they actually accept ('wjs-consent' listener
            // above) instead of being tracked after an arbitrary timeout.
            setTimeout(function () {
                if (typeof window.wjsCookieConsent === 'undefined' && !window.wjccBannerLoaded) {
                    startTracking(cfg);
                }
            }, 3000);
        }

        fetch('/api/v1/plugin/analytics-tag/public/config')
            .then(function (res) {
                if (!res.ok) { return null; }
                return res.json();
            })
            .then(function (cfg) {
                if (isConfigured(cfg)) { gateOnConsent(cfg); }
            })
            .catch(function () { /* plugin inactive or network hiccup — never break the page */ });
    } catch (e) { /* never break the host page */ }
})();

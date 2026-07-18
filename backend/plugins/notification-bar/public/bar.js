/*
 * WordJS notification-bar — public site script (plain browser IIFE).
 * Fetches the bar config, applies the enabled/schedule/dismissal checks and renders a fixed
 * bar at the top or bottom of the page. Dismissals persist in localStorage keyed by config
 * version, so bumping the version server-side re-shows the bar to everyone.
 * NOTE: this file is scanned by the plugin AST validator — no template literals, direct
 * calls only, plain string concatenation.
 */
(function () {
    try {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;

        var STORAGE_KEY = 'wjnb_dismissed';
        var BAR_ID = 'wjnb-bar';
        var CONFIG_URL = '/api/v1/plugin/notification-bar/public/config';

        function readDismissed() {
            try {
                var raw = window.localStorage.getItem(STORAGE_KEY);
                if (!raw) return null;
                var parsed = JSON.parse(raw);
                if (parsed && typeof parsed.version === 'number') return parsed;
                return null;
            } catch (e) {
                return null;
            }
        }

        function saveDismissed(version) {
            try {
                window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: version }));
            } catch (e) { /* private mode / quota — dismissal just won't persist */ }
        }

        function withinWindow(cfg, now) {
            try {
                if (cfg.starts_at) {
                    var s = Date.parse(cfg.starts_at);
                    if (!isNaN(s) && now < s) return false;
                }
                if (cfg.ends_at) {
                    var e = Date.parse(cfg.ends_at);
                    if (!isNaN(e) && now > e) return false;
                }
                return true;
            } catch (err) {
                return true;
            }
        }

        function render(cfg) {
            try {
                if (document.getElementById(BAR_ID)) return; // already rendered
                if (!document.body) return;

                var isBottom = cfg.position === 'bottom';

                var bar = document.createElement('div');
                bar.id = BAR_ID;
                bar.className = 'wjnb-bar ' + (isBottom ? 'wjnb-bottom' : 'wjnb-top');
                bar.style.backgroundColor = cfg.bgColor;
                bar.style.color = cfg.textColor;
                bar.setAttribute('role', 'region');
                bar.setAttribute('aria-label', 'Aviso del sitio');

                var inner = document.createElement('div');
                inner.className = 'wjnb-inner';

                var msg = document.createElement('span');
                msg.className = 'wjnb-message';
                msg.textContent = cfg.message; // textContent — never HTML
                inner.appendChild(msg);

                // Defense-in-depth: only http(s) or clean origin-relative hrefs, even if the
                // stored config was tampered with (javascript: / '//' / '/\' are all rejected).
                var safeHref = '';
                if (typeof cfg.linkUrl === 'string') {
                    var u = cfg.linkUrl;
                    if (/^https?:\/\//i.test(u)) safeHref = u;
                    else if (u.charAt(0) === '/' && u.charAt(1) !== '/' && u.charAt(1) !== '\\') safeHref = u;
                }
                if (safeHref && cfg.linkLabel) {
                    var cta = document.createElement('a');
                    cta.className = 'wjnb-cta';
                    cta.href = safeHref;
                    cta.textContent = cfg.linkLabel;
                    cta.style.color = cfg.textColor;
                    inner.appendChild(cta);
                }

                bar.appendChild(inner);

                var prevMarginTop = '';

                function close() {
                    try {
                        saveDismissed(cfg.version);
                        if (!isBottom) document.body.style.marginTop = prevMarginTop;
                        if (bar.parentNode) bar.parentNode.removeChild(bar);
                    } catch (e) { /* never break the host page */ }
                }

                if (cfg.dismissible) {
                    var btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'wjnb-close';
                    btn.setAttribute('aria-label', 'Cerrar aviso');
                    btn.textContent = '×';
                    btn.style.color = cfg.textColor;
                    btn.addEventListener('click', close);
                    bar.appendChild(btn);
                }

                document.body.appendChild(bar);

                // Top bar: push the page down by the measured bar height (restored on close).
                // A bottom bar overlays, no offset needed.
                if (!isBottom) {
                    prevMarginTop = document.body.style.marginTop || '';
                    var h = bar.offsetHeight;
                    if (h > 0) document.body.style.marginTop = h + 'px';
                }
            } catch (e) { /* never break the host page */ }
        }

        function maybeRender(cfg) {
            try {
                if (!cfg || cfg.enabled !== true) return;
                if (!cfg.message || !String(cfg.message).trim()) return;
                if (!withinWindow(cfg, Date.now())) return;

                var version = typeof cfg.version === 'number' ? cfg.version : 1;
                cfg.version = version;
                var dismissed = readDismissed();
                if (dismissed && dismissed.version >= version) return;

                if (document.body) {
                    render(cfg);
                } else {
                    document.addEventListener('DOMContentLoaded', function () { render(cfg); });
                }
            } catch (e) { /* never break the host page */ }
        }

        fetch(CONFIG_URL)
            .then(function (res) {
                if (!res.ok) return null;
                return res.json();
            })
            .then(maybeRender)
            .catch(function () { /* backend down / plugin inactive — show nothing */ });
    } catch (e) { /* never break the host page */ }
})();

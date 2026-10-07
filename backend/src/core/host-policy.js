'use strict';
/**
 * WordJS — host policy: which address a request was sent to, and whether this site answers there.
 *
 * WHY ONE MODULE. Before this file, five places each derived "the host of this request" their own way
 * (the migration guard, CORS, CSRF, the collab stream, /setup) and every one of them honoured
 * X-Forwarded-Host from ANY peer. A DNS-rebinding page that reaches 127.0.0.1:4000 sends
 * `Host: rebind.attacker:4000`, but it could also add `X-Forwarded-Host: <the real site>` and be
 * treated as the site itself. Here there is ONE strict parser, ONE rule for which header names the host
 * (`requestAuthority`), ONE classifier, and ONE gate built from them, so the answers cannot drift.
 *
 * WHY PLAIN JAVASCRIPT WITH NO DEPENDENCIES. The gateway runs the same decision at the edge, and a
 * parser differential between the edge and the backend is itself an attack surface. So the gateway
 * carries a BYTE-IDENTICAL copy at gateway/src/host-policy.js, and gateway/test/host-policy-parity.test.js
 * fails on any difference. That only works if this file needs nothing but Node built-ins: no backend
 * config, no logger, no Express. Everything environmental (the config object, the environment, the
 * network interfaces, the clock, the logger) is injected by the caller. Types: host-policy.d.ts.
 *
 * THE INVARIANT. An accepted host grants nothing. `req.siteHost` says which address the request used;
 * no authorisation decision may read it. Links, cookies' Domain and allow-lists never come from it.
 */
const net = require('net');
const os = require('os');

// ─── Parsing ────────────────────────────────────────────────────────────────────────────────────────

// '[' + 39-char IPv6 + ']' + ':65535' is far below this; a 253-char name + ':65535' is 259. Anything
// longer is not a host, and refusing it early bounds the work done on hostile input.
const MAX_HOST_LENGTH = 261;
// Characters that never belong to an authority. Each one is an established parser-differential lever:
// '@' (userinfo: `localhost:1@evil.example` is evil.example to WHATWG but localhost to a naive split),
// ',' (a joined list of two Host values), '/', '\\', '?', '#' (path, query, fragment), '%' (escapes
// WHATWG would decode), quotes and angle brackets (markup), and all whitespace and control bytes.
const FORBIDDEN_HOST_CHARS = /[\s\x00-\x1f\x7f,@/\\?#%"'<>{}|^`]/;
const NON_ASCII = /[^\x00-\x7f]/;
// LDH plus underscore: docker-compose service names and nginx upstream names carry '_', and refusing
// them at the parser would turn the actionable "forward Host" refusal into an opaque 400.
const DNS_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
// A strict decimal octet: no leading zeros, because `01.2.3.4` is octal to some resolvers and decimal
// to others — exactly the ambiguity a host check must not inherit.
const DEC_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const ALL_DIGITS = /^\d+$/;
const PORT = /^[1-9]\d{0,4}$/;
// ::ffff:127.0.0.0/104, as WHATWG prints it ([::ffff:7f00:1] for [::ffff:127.0.0.1]).
const MAPPED_LOOPBACK_V6 = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;
const LINK_LOCAL_V6 = /^\[fe[89ab][0-9a-f]:/;

/**
 * Strict Host-header grammar. Returns `{ hostname, port, kind }` or `null` (the caller answers 400).
 *
 * `hostname` is lower-case, without the port, without ONE trailing dot (`example.com.` is the same
 * name), and for IPv6 in WHATWG's bracketed, compressed form (`[::1]`). `kind` is 'dns', 'ipv4' or
 * 'ipv6'. Every numeric spelling other than a strict dotted quad (`127.1`, `0x7f.0.0.1`, `2130706433`,
 * `01.2.3.4`) is refused: browsers, resolvers and WHATWG disagree about them, and a host check that
 * reads a different address from the one the connection used is a bypass.
 *
 * The last step is a tripwire: WHATWG must read back the very hostname we produced. If the two parsers
 * ever disagree on an input this grammar let through, the input is refused rather than trusted.
 */
function parseHost(raw) {
    if (typeof raw !== 'string' || raw === '' || raw.length > MAX_HOST_LENGTH) return null;
    if (FORBIDDEN_HOST_CHARS.test(raw) || NON_ASCII.test(raw)) return null;
    const s = raw.toLowerCase();

    let name;
    let portText = null;
    let kind;
    if (s[0] === '[') {
        const close = s.indexOf(']');
        if (close === -1) return null;
        const inner = s.slice(1, close);
        const rest = s.slice(close + 1);
        if (rest !== '') {
            if (rest[0] !== ':') return null;
            portText = rest.slice(1);
        }
        // '%' was already refused above, so a zone id (`fe80::1%eth0`) cannot get here.
        if (!net.isIPv6(inner)) return null;
        name = '[' + inner + ']';
        kind = 'ipv6';
    } else {
        const colon = s.indexOf(':');
        name = colon === -1 ? s : s.slice(0, colon);
        if (colon !== -1) portText = s.slice(colon + 1);
        if (name.endsWith('.')) name = name.slice(0, -1);
        if (name === '' || name.length > 253) return null;
        const labels = name.split('.');
        if (labels.every((label) => ALL_DIGITS.test(label))) {
            if (labels.length !== 4 || !labels.every((label) => DEC_OCTET.test(label))) return null;
            kind = 'ipv4';
        } else {
            if (!labels.every((label) => DNS_LABEL.test(label))) return null;
            // A numeric last label makes WHATWG treat the whole name as an IPv4 number.
            if (ALL_DIGITS.test(labels[labels.length - 1])) return null;
            kind = 'dns';
        }
    }

    let port = null;
    if (portText !== null) {
        if (!PORT.test(portText)) return null;
        port = Number(portText);
        if (port > 65535) return null;
    }

    let hostname = name;
    try {
        // IPv6 takes WHATWG's canonical spelling; everything else must already BE that spelling, which
        // the tripwire below checks by reading our result back through WHATWG.
        if (kind === 'ipv6') hostname = new URL('http://' + name + '/').hostname;
        if (new URL('http://' + serialize({ hostname, port }) + '/').hostname !== hostname) return null;
    } catch {
        return null;
    }
    return { hostname, port, kind };
}

/** `hostname[:port]` — the inverse of parseHost, and the form every same-origin comparison uses. */
function serialize(p) {
    return p.hostname + (p.port ? ':' + p.port : '');
}

/**
 * An operator-supplied site address (admin UI, CLI, install wizard, config): `http(s)://host[:port]`
 * with nothing else. Returns `{ origin, scheme, hostname, port, kind }` or `null`.
 *
 * Refused outright rather than "cleaned up": userinfo (even an empty `https://@host`), any path other
 * than '/', a query or fragment (even an empty `?`), percent-escapes and backslashes (WHATWG would
 * silently rewrite them, so what was typed would not be what is stored), wildcards, and anything that
 * is not http or https — `https,https://x` (the old /migrate corruption) included. The default port is
 * dropped and a trailing dot removed, so one site has one origin spelling.
 *
 * The authority AS TYPED must pass parseHost and name the same host WHATWG read: otherwise
 * `https://127.1` or `https://2130706433` would be "normalised" to 127.0.0.1 and stored as something
 * nobody typed. Non-ASCII input is accepted only when it is a genuine internationalised name (WHATWG
 * produces punycode `xn--` labels); full-width look-alikes of ASCII letters or digits, which WHATWG folds
 * into plain ASCII names or even IP addresses, are refused. Punycode is what gets stored and displayed
 * (homograph safety).
 */
function parseSiteUrl(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim();
    if (s === '' || s.length > 2048) return null;
    if (/[\s\x00-\x1f\x7f@\\?#%]/.test(s)) return null;
    if (!/^https?:\/\/[^/]/i.test(s)) return null;
    let u;
    try {
        u = new URL(s);
    } catch {
        return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return null;
    if (u.pathname !== '/') return null;
    const p = parseHost(u.host);
    if (!p) return null;
    const typed = s.slice(s.indexOf('//') + 2).split('/')[0];
    if (NON_ASCII.test(typed)) {
        if (p.kind !== 'dns' || !p.hostname.split('.').some((label) => label.startsWith('xn--'))) return null;
    } else {
        const asTyped = parseHost(typed);
        if (!asTyped || asTyped.hostname !== p.hostname) return null;
    }
    const scheme = u.protocol.slice(0, -1);
    const port = u.port ? Number(u.port) : null;
    return { origin: scheme + '://' + serialize({ hostname: p.hostname, port }), scheme, hostname: p.hostname, port, kind: p.kind };
}

/** localhost, 127.0.0.0/8, [::1] and [::ffff:127.x.y.z]: names the browser itself resolves to this machine. */
function isLoopbackAuthority(p) {
    if (!p || typeof p.hostname !== 'string') return false;
    if (p.hostname === 'localhost') return true;
    if (p.kind === 'ipv4') return p.hostname.startsWith('127.');
    if (p.kind === 'ipv6') return p.hostname === '[::1]' || MAPPED_LOOPBACK_V6.test(p.hostname);
    return false;
}

/** A socket peer address on loopback, including the IPv4-mapped spelling a dual-stack listener reports. */
function isLoopbackIp(addr) {
    if (typeof addr !== 'string') return false;
    if (net.isIPv4(addr)) return addr.startsWith('127.');
    if (!net.isIPv6(addr)) return false;
    try {
        // WHATWG folds every IPv6 spelling (`::ffff:127.0.0.1`, `0:0:0:0:0:0:0:1`) into one form.
        const hostname = new URL('http://[' + addr + ']/').hostname;
        return hostname === '[::1]' || MAPPED_LOOPBACK_V6.test(hostname);
    } catch {
        return false;
    }
}

// ─── This machine's addresses ───────────────────────────────────────────────────────────────────────

/** Non-internal, non-link-local addresses from an `os.networkInterfaces()`-shaped map, as hostnames. */
function addressesFromInterfaces(interfaces) {
    const out = new Set();
    for (const entries of Object.values(interfaces || {})) {
        for (const entry of entries || []) {
            if (!entry || entry.internal || typeof entry.address !== 'string') continue;
            // Node 18.0-18.3 reported the family as the number 4 or 6.
            const family = entry.family === 'IPv4' || entry.family === 4 ? 4 : entry.family === 'IPv6' || entry.family === 6 ? 6 : 0;
            if (family === 4) {
                const p = parseHost(entry.address);
                if (p && p.kind === 'ipv4' && !p.hostname.startsWith('169.254.')) out.add(p.hostname);
            } else if (family === 6) {
                const p = parseHost('[' + entry.address.split('%')[0] + ']');
                if (p && p.kind === 'ipv6' && !LINK_LOCAL_V6.test(p.hostname) && !isLoopbackAuthority(p)) out.add(p.hostname);
            }
        }
    }
    return out;
}

/**
 * A cached reader of this machine's own addresses. Cached because `own` mode consults it per request
 * and enumerating interfaces is a syscall; only for 5 s, so a DHCP renewal or a new VPN address is
 * picked up without a restart. Each call returns a fresh Set, so no caller can corrupt the cache.
 */
function createOwnAddresses(opts) {
    const o = opts || {};
    const list = typeof o.networkInterfaces === 'function' ? o.networkInterfaces : () => os.networkInterfaces();
    const ttlMs = typeof o.ttlMs === 'number' ? o.ttlMs : 5000;
    const now = typeof o.now === 'function' ? o.now : Date.now;
    let cached = null;
    let cachedAt = 0;
    return function ownAddresses() {
        const t = now();
        if (!cached || t - cachedAt >= ttlMs) {
            let interfaces = {};
            try {
                interfaces = list();
            } catch {
                // Some sandboxes refuse interface enumeration; "no own addresses" is the safe reading.
            }
            cached = addressesFromInterfaces(interfaces);
            cachedAt = t;
        }
        return new Set(cached);
    };
}

const ownAddresses = createOwnAddresses();

// ─── Which header names the host ────────────────────────────────────────────────────────────────────

const GATEWAY_CNS = new Set(['gateway', 'gateway-internal']);
// Headers a proxy adds and a browser talking to us directly never sends.
const PROXY_MARKER_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'via'];

const NAMED_TRUST_RANGES = {
    loopback: [['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']],
    linklocal: [['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']],
    uniquelocal: [['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['fc00::', 7, 'ipv6']],
};

/**
 * Compile an operator's `trustProxy` / WORDJS_TRUST_PROXY into "is this peer my proxy?", or `null`.
 *
 * Only ADDRESS-BASED settings compile: an IP, a CIDR, 'loopback' / 'linklocal' / 'uniquelocal', or a
 * list of them. A hop count (`1`, `'1'`) or a boolean is refused. Express reads `1` as "trust the
 * nearest hop", which is true for EVERY peer at i=0 — honouring X-Forwarded-Host on that basis would
 * let any client on the internet name the host. Such settings still drive `req.ip` for the limiters;
 * they just never make a forwarded Host trustworthy. Any invalid element voids the whole setting, so
 * a typo fails closed instead of trusting a partial list.
 */
function compileTrustProxy(setting) {
    let items;
    if (typeof setting === 'string') items = setting.split(',');
    else if (Array.isArray(setting)) items = setting.map((x) => (typeof x === 'string' ? x : null));
    else return null;
    if (items.includes(null)) return null;
    const tokens = items.map((x) => x.trim().toLowerCase()).filter((x) => x !== '');
    if (tokens.length === 0) return null;
    const list = new net.BlockList();
    try {
        for (const token of tokens) {
            if (Object.prototype.hasOwnProperty.call(NAMED_TRUST_RANGES, token)) {
                for (const [address, bits, family] of NAMED_TRUST_RANGES[token]) list.addSubnet(address, bits, family);
                continue;
            }
            const slash = token.indexOf('/');
            const address = slash === -1 ? token : token.slice(0, slash);
            const family = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
            if (!family) return null;
            if (slash === -1) {
                list.addAddress(address, family);
                continue;
            }
            const bits = token.slice(slash + 1);
            if (!/^\d{1,3}$/.test(bits) || Number(bits) > (family === 'ipv4' ? 32 : 128)) return null;
            list.addSubnet(address, Number(bits), family);
        }
    } catch {
        return null;
    }
    // BlockList matches an IPv4-mapped peer (::ffff:a.b.c.d, as a dual-stack listener reports it)
    // against the IPv4 rules itself; the vectors pin that.
    return function isTrustedPeer(peer) {
        if (typeof peer !== 'string') return false;
        const family = net.isIPv4(peer) ? 'ipv4' : net.isIPv6(peer) ? 'ipv6' : null;
        return family !== null && list.check(peer, family);
    };
}

// One process has one trust setting; remember the last compilation instead of redoing it per request.
let trustCacheKey = null;
let trustCacheValue = null;
function trustedPeerTest(setting) {
    if (setting === undefined || setting === null || setting === '') return null;
    const key = JSON.stringify(setting);
    if (key !== trustCacheKey) {
        trustCacheValue = compileTrustProxy(setting);
        trustCacheKey = key;
    }
    return trustCacheValue;
}

function socketOf(req) {
    return (req && (req.socket || req.connection)) || null;
}

function peerCN(socket) {
    try {
        const cert = socket && typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : null;
        const cn = cert && cert.subject ? cert.subject.CN : undefined;
        return typeof cn === 'string' ? cn : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Which trusted hop, if any, delivered this request: 'gateway' (mTLS, CN gateway or gateway-internal),
 * 'local' (a loopback peer that addressed a loopback authority: the pre-certs gateway with
 * changeOrigin, the monolith's SSR listener, a local nginx), or 'operator' (a peer inside the
 * operator's address-based trustProxy). `null` for everything else.
 *
 * The 'local' rule needs BOTH halves. A loopback peer alone is not enough: a DNS-rebinding page that
 * reaches 127.0.0.1:4000 is a loopback peer too, but the browser sends `Host: rebind.attacker:4000`
 * (Host is a forbidden header), so its forged X-Forwarded-Host is ignored. Every legitimate hop that
 * rewrites Host rewrites it to the loopback address it dialled.
 *
 * The 'operator' rule is about the PEER only, so it vouches for the hop's X-Forwarded-Proto but not, on
 * its own, for its X-Forwarded-Host: see operatorMayForwardHost.
 */
function trustedHop(req, opts) {
    const sock = socketOf(req);
    if (!sock) return null;
    if (sock.authorized === true && GATEWAY_CNS.has(peerCN(sock))) return 'gateway';
    const peer = sock.remoteAddress;
    const headers = (req && req.headers) || {};
    if (isLoopbackIp(peer) && isLoopbackAuthority(parseHost(headers.host))) return 'local';
    const isTrustedPeer = trustedPeerTest(opts && opts.trustProxy);
    if (isTrustedPeer && isTrustedPeer(peer)) return 'operator';
    return null;
}

/**
 * Does the request carry headers only a proxy adds? X-Forwarded-Host counts only when it differs from
 * Host: a copy of Host says nothing about a proxy.
 */
function hasProxyMarkers(req) {
    const headers = (req && req.headers) || {};
    for (const name of PROXY_MARKER_HEADERS) if (headers[name] !== undefined) return true;
    const xfh = headers['x-forwarded-host'];
    return xfh !== undefined && xfh !== headers.host;
}

function firstListValue(value) {
    return typeof value === 'string' ? value.split(',')[0].trim() : '';
}

/**
 * May an 'operator' hop's X-Forwarded-Host name the host? Only when the Host it sent could not have come
 * from a browser that DNS rebinding steered there: an IP literal, a loopback authority, or a single-label
 * upstream name (a docker-compose service, an nginx upstream).
 *
 * trustProxy names PEERS, and a peer is not a proxy just because of its address. With 'loopback' (or a LAN
 * subnet the backend listens on), a rebinding page in a browser on that machine (or that LAN) IS such a
 * peer: it may send any X-Forwarded-Host it likes, yet its Host is always its own dotted name
 * (`rebind.attacker:4000`, a forbidden header). A browser sends an IP-literal or loopback Host only to a
 * page served by this very listener, and cannot be made to send a single-label one by a remote page.
 * Nothing legitimate is lost: a proxy that keeps the browser's Host needs no X-Forwarded-Host, and one
 * that dials WordJS by a dotted DNS name is told to forward Host instead (see forwardingAdvice).
 * Underscores earn no exemption: `wordjs_backend.internal` is still a dotted name.
 */
function operatorMayForwardHost(hostHeader) {
    const p = parseHost(hostHeader);
    return p !== null && (p.kind !== 'dns' || isLoopbackAuthority(p) || !p.hostname.includes('.'));
}

/**
 * THE ADDRESS THIS REQUEST WAS SENT TO — the one derivation for the gate, CORS, CSRF, collab and /setup.
 *
 * X-Forwarded-Host (first value) is honoured only from a trusted hop (see trustedHop) — and from an
 * 'operator' hop only when its Host passes operatorMayForwardHost; everyone else is judged by `Host`,
 * which a browser cannot forge. From a trusted hop, a PRESENT but empty XFH means the client sent no Host
 * (the gateway pins `Host || ''`), so it is reported absent instead of falling back to the hop's own
 * loopback Host — also when a loopback client relays the empty value itself; the gateway forwards it
 * empty, past http-proxy's xfwd, so the backend judges it host-less too (host-edge.js
 * pinForwardedHeaders, reviews NEW-V1 and R3S-1).
 *
 * `proxied` is R4: the authority came from Host, yet the request carries proxy headers from a peer
 * nobody declared trusted. That is the signature of a reverse proxy that rewrote Host (nginx's default
 * `Host $proxy_host`), so an IP literal in that position names the upstream, not the address the
 * browser used — `classify` refuses it instead of letting it switch the named-host gate off.
 *
 * Returns `{ parsed, absent, raw, hop, viaTrustedHop, source, proxied }`; `parsed` is null when the value
 * is present but malformed (answer 400). `raw` is the value that was judged, as received ('' when
 * absent): what a listener that relays this request must forward as X-Forwarded-Host, so the next hop
 * judges the same address (host-edge.js).
 */
function requestAuthority(req, opts) {
    const headers = (req && req.headers) || {};
    const hop = trustedHop(req, opts);
    const xfh = headers['x-forwarded-host'];
    const host = typeof headers.host === 'string' ? headers.host : '';
    const fromForwarded = typeof xfh === 'string' && hop !== null && (hop !== 'operator' || operatorMayForwardHost(host));
    const raw = fromForwarded ? firstListValue(xfh) : host;
    const base = {
        raw,
        hop,
        viaTrustedHop: hop !== null,
        source: fromForwarded ? 'x-forwarded-host' : 'host',
        proxied: hop === null && hasProxyMarkers(req),
    };
    if (raw === '') return Object.assign({ parsed: null, absent: true }, base);
    return Object.assign({ parsed: parseHost(raw), absent: false }, base);
}

/** `serialize(requestAuthority(...).parsed)`, or undefined when the host is absent or malformed. */
function requestHost(req, opts) {
    const authority = requestAuthority(req, opts);
    return authority.parsed ? serialize(authority.parsed) : undefined;
}

/**
 * The scheme the client used: the first X-Forwarded-Proto value from a trusted hop when it is exactly
 * http or https (`https,http` from a TLS proxy in front of http-proxy reads as https), otherwise the
 * listener's own transport. An untrusted peer's X-Forwarded-Proto is never read.
 */
function trustedScheme(req, opts) {
    return schemeVia(req, trustedHop(req, opts));
}

function schemeVia(req, hop) {
    if (hop !== null) {
        const v = firstListValue(((req && req.headers) || {})['x-forwarded-proto']).toLowerCase();
        if (v === 'http' || v === 'https') return v;
    }
    const sock = socketOf(req);
    return sock && sock.encrypted ? 'https' : 'http';
}

// ─── Classification ─────────────────────────────────────────────────────────────────────────────────

const IP_LITERAL_MODES = ['any', 'own', 'none'];
// Hostnames handed out by tunnel services. A name is released when the tunnel restarts and the next
// customer may receive it, so these default to a short expiry and to no sign-in (REDTEAM R2).
const TUNNEL_SUFFIXES = Object.freeze([
    'ngrok-free.app', 'ngrok-free.dev', 'ngrok.app', 'ngrok.dev', 'ngrok.io',
    'trycloudflare.com', 'loca.lt', 'localhost.run', 'lhr.life', 'serveo.net',
]);
const DECLARED_CLASSES = new Set(['canonical', 'alias', 'env']);

function isTunnelHost(hostname) {
    return typeof hostname === 'string' && TUNNEL_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith('.' + suffix));
}

/** mDNS names: anyone on the LAN can answer for them. */
function isLanName(hostname) {
    return typeof hostname === 'string' && (hostname === 'local' || hostname.endsWith('.local'));
}

/** Why a declared address must not mint sessions by default, or null. */
function addressRisk(p) {
    if (p.kind !== 'dns') return 'ip';
    if (isTunnelHost(p.hostname)) return 'tunnel';
    if (isLanName(p.hostname)) return 'local';
    return null;
}

/**
 * Which kind of address this is for the site. Returns `{ cls, reason, entry }`:
 *
 *   canonical  the main address (hostname match; the port is ignored, as it always was)
 *   alias      an operator-declared address that has not expired (entry = the alias)
 *   env        a WORDJS_ALLOWED_HOSTS entry (entry = that entry)
 *   loopback   localhost, 127/8, [::1]; in development also *.localhost
 *   ip         an IP literal allowed by hostPolicy.ipLiterals (any | own)
 *   dev        a WORDJS_DEV_ORIGINS name, in development only
 *   unknown    everything else — the caller answers 421
 *
 * Declared addresses are matched before the IP rule, so an operator who lists an IP is answered
 * there even through a proxy. The R4 refusal (`ctx.proxied`) applies only to the IP-literal RULE.
 * `ctx.now` (ms) decides alias expiry; it defaults to the clock.
 */
function classify(p, pol, ctx) {
    if (!p || !pol) return { cls: 'unknown', reason: 'invalid', entry: null };
    const c = ctx || {};
    const now = typeof c.now === 'number' ? c.now : Date.now();
    const h = p.hostname;

    if (pol.canonical && pol.canonical.hostname === h) return { cls: 'canonical', reason: 'canonical', entry: pol.canonical };
    const alias = pol.aliases && pol.aliases.get(h);
    const aliasExpired = Boolean(alias && alias.expiresAt !== null && now >= alias.expiresAt);
    if (alias && !aliasExpired) return { cls: 'alias', reason: 'alias', entry: alias };
    const envEntry = pol.envHosts && pol.envHosts.get(h);
    if (envEntry) return { cls: 'env', reason: 'env', entry: envEntry };
    if (isLoopbackAuthority(p)) return { cls: 'loopback', reason: 'loopback', entry: null };
    if (pol.dev && p.kind === 'dns' && h.endsWith('.localhost')) return { cls: 'loopback', reason: 'localhost-subdomain', entry: null };
    if (p.kind !== 'dns') {
        if (c.proxied) return { cls: 'unknown', reason: 'proxied-ip', entry: null };
        if (pol.ipLiterals === 'any') return { cls: 'ip', reason: 'ip-any', entry: null };
        if (pol.ipLiterals === 'own') {
            const own = typeof pol.ownAddresses === 'function' ? pol.ownAddresses() : new Set();
            if (own.has(h)) return { cls: 'ip', reason: 'ip-own', entry: null };
            return { cls: 'unknown', reason: 'ip-not-own', entry: null };
        }
        return { cls: 'unknown', reason: 'ip-literals-none', entry: null };
    }
    if (pol.dev && pol.devOrigins && pol.devOrigins.has(h)) return { cls: 'dev', reason: 'dev-origin', entry: null };
    return { cls: 'unknown', reason: aliasExpired ? 'expired-alias' : 'undeclared', entry: null };
}

const REFUSAL_HINTS = Object.freeze({
    'forward-host': 'a reverse proxy in front of WordJS is probably not forwarding the browser\'s Host (nginx: proxy_set_header Host $host)',
    tunnel: 'this looks like a tunnel address; add it as a temporary address (npm run site -- add https://<host> --expires 7d)',
    'www-apex': 'this is the www/apex twin of the main address; add it as an address if both should work',
    local: '.local names can be claimed by anyone on your LAN; add it only if you accept that',
});

/** A hint code for the operator about a refused host (keys of REFUSAL_HINTS), or null. */
function refusalHint(p, pol, reason) {
    if (reason === 'proxied-ip') return 'forward-host';
    if (!p || p.kind !== 'dns') return null;
    const h = p.hostname;
    if (!h.includes('.') || h.includes('_')) return 'forward-host';
    if (isTunnelHost(h)) return 'tunnel';
    if (isLanName(h)) return 'local';
    const canonical = pol && pol.canonical ? pol.canonical.hostname : null;
    if (canonical && (h === 'www.' + canonical || canonical === 'www.' + h)) return 'www-apex';
    return null;
}

// ─── Policy ─────────────────────────────────────────────────────────────────────────────────────────

function quote(value) {
    let text;
    try {
        text = JSON.stringify(value);
    } catch {
        text = String(value);
    }
    text = String(text);
    return text.length > 120 ? text.slice(0, 117) + '...' : text;
}

/**
 * The default for "may this address mint a session?". An explicit boolean always wins. Otherwise no
 * for IP literals, tunnel names and .local names whatever their scheme (R2: the session outlives the
 * name, and the next holder of the name receives the cookie), and no for a plain-http address on an
 * https site (the cookie would cross the wire in clear text). The sign-in rule itself also checks the
 * real transport (R9); this is only the declared intent.
 */
function defaultSignIn(explicit, risk, scheme, canonical) {
    if (typeof explicit === 'boolean') return explicit;
    if (risk) return false;
    if (scheme === 'http' && canonical && canonical.scheme === 'https') return false;
    return true;
}

/** A WORDJS_ALLOWED_HOSTS / WORDJS_DEV_ORIGINS element: a bare host[:port] or a site URL. */
function parseHostOrUrl(text) {
    if (text.includes('://')) {
        const site = parseSiteUrl(text);
        return site ? { hostname: site.hostname, port: site.port, kind: site.kind, scheme: site.scheme, origin: site.origin } : null;
    }
    const p = parseHost(text);
    return p ? { hostname: p.hostname, port: p.port, kind: p.kind, scheme: null, origin: null } : null;
}

function splitList(value) {
    return typeof value === 'string' ? value.split(',').map((x) => x.trim()).filter((x) => x !== '') : [];
}

function readAliases(list, canonical, warnings) {
    const aliases = new Map();
    if (list === undefined || list === null) return aliases;
    if (!Array.isArray(list)) {
        warnings.push('siteAliases is not a list; no extra addresses are answered.');
        return aliases;
    }
    list.forEach((item, i) => {
        const raw = typeof item === 'string' ? { url: item } : item;
        if (!raw || typeof raw !== 'object') {
            warnings.push(`siteAliases[${i}] is not an address entry; ignored.`);
            return;
        }
        const site = parseSiteUrl(raw.url);
        if (!site) {
            warnings.push(`siteAliases[${i}]: ${quote(raw.url)} is not a valid site address (http(s)://host[:port]); ignored.`);
            return;
        }
        if (canonical && site.hostname === canonical.hostname) {
            warnings.push(`siteAliases[${i}]: ${site.hostname} is the main address already; ignored.`);
            return;
        }
        if (aliases.has(site.hostname)) {
            warnings.push(`siteAliases[${i}]: ${site.hostname} is listed twice; the first entry is used.`);
            return;
        }
        let expiresAt = null;
        if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
            expiresAt = typeof raw.expiresAt === 'string' ? Date.parse(raw.expiresAt) : NaN;
            if (Number.isNaN(expiresAt)) {
                // Fail closed: an address whose lifetime cannot be read is not answered at all.
                warnings.push(`siteAliases[${i}]: ${site.hostname} has an unreadable expiresAt; ignored.`);
                return;
            }
        }
        let mode = 'serve';
        if (raw.mode !== undefined && raw.mode !== 'serve' && raw.mode !== 'redirect') {
            warnings.push(`siteAliases[${i}]: unknown mode ${quote(raw.mode)} for ${site.hostname}; it is served.`);
        } else if (raw.mode === 'redirect') {
            mode = 'redirect';
        }
        const risk = addressRisk(site);
        aliases.set(site.hostname, Object.freeze(Object.assign({}, site, {
            mode,
            signIn: defaultSignIn(raw.signIn, risk, site.scheme, canonical),
            signInExplicit: typeof raw.signIn === 'boolean',
            risk,
            expiresAt,
            label: typeof raw.label === 'string' ? raw.label.slice(0, 100) : null,
            source: typeof raw.source === 'string' ? raw.source.slice(0, 20) : 'config',
        })));
    });
    return aliases;
}

function readEnvHosts(value, canonical, warnings) {
    const hosts = new Map();
    for (const text of splitList(value)) {
        const parsed = parseHostOrUrl(text);
        if (!parsed) {
            warnings.push(`WORDJS_ALLOWED_HOSTS: ${quote(text)} is not a host or site address; ignored.`);
            continue;
        }
        if (hosts.has(parsed.hostname)) continue;
        const risk = addressRisk(parsed);
        // A URL entry carries its scheme (REDTEAM R12): `https://host` behind a TLS ingress can then
        // sign in on an https site even though the listener behind the ingress speaks plain http.
        hosts.set(parsed.hostname, Object.freeze(Object.assign({}, parsed, {
            signIn: defaultSignIn(undefined, risk, parsed.scheme, canonical),
            risk,
            source: 'env',
        })));
    }
    return hosts;
}

function readDevOrigins(value, warnings) {
    const origins = new Set();
    for (const text of splitList(value)) {
        const parsed = parseHostOrUrl(text);
        if (!parsed) {
            warnings.push(`WORDJS_DEV_ORIGINS: ${quote(text)} is not a host name (wildcards are not supported); ignored.`);
            continue;
        }
        if (isLanName(parsed.hostname)) {
            warnings.push(`WORDJS_DEV_ORIGINS: ${parsed.hostname} is a .local name; anyone on your LAN can claim it.`);
        }
        origins.add(parsed.hostname);
    }
    return origins;
}

function readIpLiterals(hostPolicy, env, warnings) {
    let mode = 'any';
    let source = 'default';
    const configured = hostPolicy.ipLiterals;
    if (configured !== undefined && configured !== null) {
        if (IP_LITERAL_MODES.includes(configured)) {
            mode = configured;
            source = 'config';
        } else {
            warnings.push(`hostPolicy.ipLiterals ${quote(configured)} is not one of any, own, none; using "any".`);
        }
    }
    const fromEnv = typeof env.WORDJS_IP_HOSTS === 'string' ? env.WORDJS_IP_HOSTS.trim().toLowerCase() : '';
    if (fromEnv !== '') {
        if (IP_LITERAL_MODES.includes(fromEnv)) {
            mode = fromEnv;
            source = 'env';
        } else {
            warnings.push(`WORDJS_IP_HOSTS ${quote(fromEnv)} is not one of any, own, none; ignored.`);
        }
    }
    return { mode, source };
}

/**
 * Build the policy from wordjs-config.json (already parsed), the environment and the mode. Pure: the
 * same inputs give the same policy, and nothing here touches the network or the file system.
 *
 * Reads `siteUrl` (the canonical), `siteAliases`, `hostPolicy.{ipLiterals,ipSignIn}` and `trustProxy`
 * from the config, and WORDJS_ALLOWED_HOSTS, WORDJS_IP_HOSTS, WORDJS_DEV_ORIGINS and WORDJS_TRUST_PROXY
 * from the environment (the config's trustProxy wins, as in core/client-ip). Problems never throw:
 * they become `warnings`, and a bad entry is left out rather than guessed at.
 */
function buildPolicy(input) {
    const i = input || {};
    const cfg = i.config && typeof i.config === 'object' ? i.config : {};
    const env = i.env || {};
    const warnings = [];

    let canonical = null;
    let canonicalError = null;
    if (cfg.siteUrl === undefined || cfg.siteUrl === null || cfg.siteUrl === '') {
        canonicalError = 'missing';
    } else {
        canonical = parseSiteUrl(cfg.siteUrl);
        if (canonical) canonical = Object.freeze(canonical);
        else {
            canonicalError = 'invalid';
            warnings.push(`siteUrl ${quote(cfg.siteUrl)} is not a valid site address (http(s)://host[:port]).`);
        }
    }

    const hostPolicy = cfg.hostPolicy && typeof cfg.hostPolicy === 'object' ? cfg.hostPolicy : {};
    const ipLiterals = readIpLiterals(hostPolicy, env, warnings);

    let trustProxy = cfg.trustProxy;
    if (trustProxy === undefined || trustProxy === null || trustProxy === '') trustProxy = env.WORDJS_TRUST_PROXY;
    if (trustProxy === undefined || trustProxy === '') trustProxy = null;
    // `false` / `0` are the explicit "trust nothing" settings, not a mistake worth a warning.
    const trustsNothing = trustProxy === false || trustProxy === 0 || (typeof trustProxy === 'string' && /^(?:false|0)$/i.test(trustProxy.trim()));
    if (trustProxy !== null && !trustsNothing && compileTrustProxy(trustProxy) === null) {
        warnings.push(`trustProxy ${quote(trustProxy)} is not address-based (an IP, a subnet or loopback); forwarded Host headers are not honoured from it.`);
    }

    return Object.freeze({
        canonical,
        canonicalError,
        aliases: readAliases(cfg.siteAliases, canonical, warnings),
        envHosts: readEnvHosts(env.WORDJS_ALLOWED_HOSTS, canonical, warnings),
        ipLiterals: ipLiterals.mode,
        ipLiteralsSource: ipLiterals.source,
        ipSignIn: hostPolicy.ipSignIn === true,
        dev: i.nodeEnv === 'development',
        devOrigins: readDevOrigins(env.WORDJS_DEV_ORIGINS, warnings),
        trustProxy,
        ownAddresses: typeof i.ownAddresses === 'function' ? i.ownAddresses : ownAddresses,
        warnings: Object.freeze(warnings),
    });
}

const POLICY_ENV_KEYS = ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY'];

/**
 * A memoised policy. `getConfig()` is the backend's configManager.getConfig: it returns the SAME
 * object until the file's mtime changes (its own 2 s revalidation), so object identity is the mtime
 * memo, and the environment values are the rest of the key.
 *
 * REDTEAM R10: `getConfig()` answers null while the file is unparseable (a CLI or OneDrive write in
 * progress). Rebuilding from that would drop the canonical, and the gate lets every host through when
 * there is no canonical. So once a policy exists, a null config keeps the last good one.
 */
function createPolicyProvider(opts) {
    if (!opts || typeof opts.getConfig !== 'function') throw new TypeError('createPolicyProvider: getConfig() is required');
    const env = opts.env || process.env;
    const logger = opts.logger || console;
    const logged = new Set();
    let last = null;
    let lastConfig;
    let lastKey = null;

    function get() {
        const nodeEnv = typeof opts.nodeEnv === 'function' ? opts.nodeEnv() : opts.nodeEnv;
        let config = null;
        try {
            config = opts.getConfig();
        } catch {
            config = null;
        }
        if (config === null && last) return last;
        const key = [nodeEnv].concat(POLICY_ENV_KEYS.map((name) => env[name])).map((v) => (v === undefined ? '\u0001' : String(v))).join('\u0000');
        if (last && config === lastConfig && key === lastKey) return last;
        last = buildPolicy({ config, env, nodeEnv, ownAddresses: opts.ownAddresses });
        lastConfig = config;
        lastKey = key;
        for (const warning of last.warnings) {
            if (logged.has(warning) || logged.size >= 200) continue;
            logged.add(warning);
            logger.warn('[host-policy] ' + warning);
        }
        return last;
    }

    return {
        get,
        /** Forget the memo so the next get() rebuilds (a committed address change). */
        invalidate() {
            lastConfig = undefined;
        },
    };
}

// ─── Bounded observations (REDTEAM R7) ──────────────────────────────────────────────────────────────

/**
 * Who refused a host, for "Recently refused": 'edge' (a public listener's edge check — the gateway worker,
 * or the monolith's listener — before the request reached the backend), 'gate' (the backend's own gate),
 * or 'both' (each refused it at least once).
 */
const REFUSAL_SOURCES = Object.freeze(['edge', 'gate', 'both']);

/** The source two observations of one host add up to (null = not known). */
function combineRefusalSources(a, b) {
    if (!a) return b || null;
    if (!b || a === b) return a;
    return 'both';
}

/**
 * Recently refused hosts, for the admin page, and the gate's log throttle. Bounded twice, because it is
 * fed by anonymous requests that arrive before any rate limiter: at most `max` hosts (LRU), and at most
 * one log line per host per minute AND `logsPerMinute` lines per minute overall. `record`'s `source` is
 * 'edge' or 'gate' (who refused it); one tracker can be fed by both (the monolith's edge records into the
 * backend's), and each entry says which did (REFUSAL_SOURCES).
 */
function createRefusedHosts(opts) {
    const o = opts || {};
    const max = o.max || 32;
    const logsPerMinute = o.logsPerMinute || 10;
    const now = typeof o.now === 'function' ? o.now : Date.now;
    const entries = new Map();
    let windowStart = 0;
    let windowCount = 0;
    return {
        /** Count a refusal; true when the caller should write a log line for it. */
        record(hostname, hint, source) {
            const t = now();
            let entry = entries.get(hostname);
            if (entry) entries.delete(hostname);
            else entry = { host: hostname, count: 0, firstSeen: t, lastSeen: t, hint: null, source: null, lastLoggedAt: -Infinity };
            entry.count += 1;
            entry.lastSeen = t;
            entry.hint = hint || null;
            if (source === 'edge' || source === 'gate') entry.source = combineRefusalSources(entry.source, source);
            entries.set(hostname, entry);
            while (entries.size > max) entries.delete(entries.keys().next().value);
            if (t - entry.lastLoggedAt < 60000) return false;
            if (t - windowStart >= 60000) {
                windowStart = t;
                windowCount = 0;
            }
            if (windowCount >= logsPerMinute) return false;
            windowCount += 1;
            entry.lastLoggedAt = t;
            return true;
        },
        /** Most recent first. */
        list() {
            return [...entries.values()].reverse().map((e) => ({ host: e.host, count: e.count, firstSeen: e.firstSeen, lastSeen: e.lastSeen, hint: e.hint, source: e.source }));
        },
        /** Forget every refusal, and the log throttle with them: the next refusal is logged again. */
        clear() {
            entries.clear();
            windowStart = 0;
            windowCount = 0;
        },
    };
}

/**
 * When each DECLARED address (canonical, alias, environment) was last used. Only declared hosts are
 * recorded, so anonymous requests for random IP literals cannot grow it; it is also capped.
 *
 * Two timestamps, because they answer different questions. `seenAt` is any request (the "last seen"
 * column). `authenticatedAt` is a request that carried a valid session (set by noteAuthenticatedUse
 * from the auth middleware): the remove-address interlock must count only that one, otherwise an
 * anonymous client could keep an old address "in use" forever just by requesting it — and trusted hops
 * (the SSR loopback listener, the gateway) relay anonymous browser traffic, so a hop proves nothing.
 */
function createLastSeen(opts) {
    const o = opts || {};
    const max = o.max || 64;
    const now = typeof o.now === 'function' ? o.now : Date.now;
    const entries = new Map();
    const copy = (e) => ({ hostname: e.hostname, seenAt: e.seenAt, authenticatedAt: e.authenticatedAt });
    return {
        touch(hostname, options) {
            const t = now();
            let entry = entries.get(hostname);
            if (entry) entries.delete(hostname);
            else entry = { hostname, seenAt: t, authenticatedAt: null };
            entry.seenAt = t;
            if (options && options.authenticated) entry.authenticatedAt = t;
            entries.set(hostname, entry);
            while (entries.size > max) entries.delete(entries.keys().next().value);
        },
        get(hostname) {
            const entry = entries.get(hostname);
            return entry ? copy(entry) : null;
        },
        list() {
            return [...entries.values()].map(copy);
        },
        clear() {
            entries.clear();
        },
    };
}

/**
 * Several refusal lists as one, for "Recently refused": the backend's own and its gateway's edge, the
 * gateway's workers. One entry per host (counts added, the earliest firstSeen, the latest lastSeen and
 * the hint seen with it, and who refused it: 'edge', 'gate', or 'both' when the lists disagree), most
 * recent first, at most `max`. These lists cross process and machine boundaries, so every entry is
 * checked like wire input and dropped, never repaired, unless its host is a hostname this parser produces
 * (canonical form, no port), its count a positive integer, its times numbers, its hint one of
 * REFUSAL_HINTS and its source, when present, one of REFUSAL_SOURCES (an entry with none says nothing
 * about who refused it, and the result's source is null only when no entry for that host said).
 */
function mergeRefusedHosts(lists, opts) {
    const max = (opts && opts.max) || 32;
    const merged = new Map();
    for (const list of Array.isArray(lists) ? lists : []) {
        if (!Array.isArray(list)) continue;
        for (const e of list.slice(0, 256)) {
            if (!e || typeof e !== 'object') continue;
            const host = typeof e.host === 'string' && e.host.length <= 300 ? e.host : null;
            const parsed = host ? parseHost(host) : null;
            if (!parsed || parsed.hostname !== host) continue;
            if (!Number.isSafeInteger(e.count) || e.count < 1) continue;
            if (!Number.isFinite(e.firstSeen) || !Number.isFinite(e.lastSeen)) continue;
            const hint = e.hint === null || e.hint === undefined ? null : e.hint;
            if (hint !== null && !Object.prototype.hasOwnProperty.call(REFUSAL_HINTS, hint)) continue;
            const source = e.source === null || e.source === undefined ? null : e.source;
            if (source !== null && !REFUSAL_SOURCES.includes(source)) continue;
            const prev = merged.get(host);
            if (!prev) {
                merged.set(host, { host, count: e.count, firstSeen: e.firstSeen, lastSeen: e.lastSeen, hint, source });
                continue;
            }
            prev.count = Math.min(prev.count + e.count, Number.MAX_SAFE_INTEGER);
            prev.firstSeen = Math.min(prev.firstSeen, e.firstSeen);
            prev.source = combineRefusalSources(prev.source, source);
            if (e.lastSeen >= prev.lastSeen) {
                prev.lastSeen = e.lastSeen;
                prev.hint = hint;
            }
        }
    }
    return [...merged.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, max);
}

const refusedHosts = createRefusedHosts();
const lastSeen = createLastSeen();

/** Record that an authenticated request used its (declared) address. Call after authentication succeeds. */
function noteAuthenticatedUse(req, tracker) {
    const siteHost = req && req.siteHost;
    if (siteHost && DECLARED_CLASSES.has(siteHost.cls)) (tracker || lastSeen).touch(siteHost.hostname, { authenticated: true });
}

// ─── The gate ───────────────────────────────────────────────────────────────────────────────────────

// Exactly what the old guard never saw (static trees, ACME, probes): answering them on any host is
// today's behaviour, and probes are often addressed by pod or container IP. Matched by segment, and
// never for an ambiguous path (isAmbiguousPath): those are classified like any other request.
const EXEMPT_PATHS = Object.freeze(['/uploads', '/themes', '/plugins', '/.well-known', '/public', '/health', '/healthz', '/readyz', '/metrics', '/favicon.ico']);

function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.end(JSON.stringify(body));
}

/**
 * 421 Misdirected Request: this server does not answer for that address. No `redirect` and no
 * `details` (the old 409 disclosed the configured host and drove the browser to /migration).
 */
function sendHostNotAllowed(res) {
    sendJson(res, 421, { code: 'rest_host_not_allowed', error: 'host_not_allowed', message: 'This address is not configured for this site.', data: { status: 421 } });
}

function sendInvalidHost(res) {
    sendJson(res, 400, { code: 'rest_invalid_host', error: 'invalid_host', message: 'The Host header is malformed or repeated.', data: { status: 400 } });
}

function requestPath(req) {
    if (typeof req.path === 'string') return req.path;
    return String(req.url || '/').split('?')[0];
}

/**
 * A path a URL parser rewrites into another path: a dot segment ('.' or '..' in any mix of literal and
 * percent-encoded dots, also before a ';' parameter) or a raw backslash. The WHATWG parser Next.js uses
 * resolves both (a backslash is a slash in an http URL), while the gateway and the monolith route on the
 * raw path — so `/x/../api/v1/settings` went to Next, which fetched /api/v1/settings through its own
 * rewrite. Browsers resolve these before sending and never send them.
 */
function hasDotSegments(path) {
    if (path.includes('\\')) return true;
    return path.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment.split(';')[0]));
}

/**
 * A path that some later parser could read as ANOTHER path: hasDotSegments, an encoded slash or
 * backslash, or an encoded '%' (a second decode away from any of those). Express matches routes on the
 * raw path, but Next.js and the proxies in front of WordJS resolve dot segments first, so a prefix test
 * on the raw path exempted `/healthz/../api/v1/settings` while the next hop served the API.
 */
function isAmbiguousPath(path) {
    return /%2f|%5c|%25/i.test(path) || hasDotSegments(path);
}

/** Exempt by segment (`/uploads` covers `/uploads/x`, not `/uploadsX`), and never an ambiguous path. */
function isExemptPath(path, prefixes) {
    if (isAmbiguousPath(path)) return false;
    return prefixes.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}

/** Node keeps the FIRST of two Host headers and drops the second; rawHeaders still has both. */
function countHostHeaders(req) {
    const raw = req.rawHeaders;
    if (!Array.isArray(raw)) return req.headers && req.headers.host !== undefined ? 1 : 0;
    let count = 0;
    for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === 'host') count += 1;
    return count;
}

/** The X-Forwarded-For chain, oldest first; each relaying proxy appends the peer it received from. */
function forwardedForChain(headers) {
    return typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'].split(',').map((x) => x.trim()).filter((x) => x !== '') : [];
}

/**
 * Every address a proxy reported for the client (X-Forwarded-For, X-Real-IP, Forwarded for=). `chain`
 * replaces the X-Forwarded-For part (looksLikeProxyCollapse leaves out the relaying hop's own peer).
 */
function forwardedAddresses(req, chain) {
    const headers = req.headers || {};
    const out = (chain || forwardedForChain(headers)).slice();
    if (typeof headers['x-real-ip'] === 'string') out.push(headers['x-real-ip'].trim());
    if (typeof headers.forwarded === 'string') for (const address of forwardedForValues(headers.forwarded)) out.push(address);
    return out.filter((x) => x !== '');
}

/** A character a `for=` value may hold (RFC 7239 node, read leniently): anything but `]`, `"`, `;` and `,`. */
function isForwardedValueChar(c) {
    return c !== undefined && c !== ']' && c !== '"' && c !== ';' && c !== ',';
}

/** Index just past the run of value characters that starts at `from`. */
function forwardedValueRunEnd(value, from) {
    let end = from;
    while (isForwardedValueChar(value[end])) end += 1;
    return end;
}

/** Index just past the ASCII digits that start at `from`. */
function digitRunEnd(value, from) {
    let end = from;
    while (end < value.length && value.charCodeAt(end) >= 48 && value.charCodeAt(end) <= 57) end += 1;
    return end;
}

/**
 * The `for=` values of a Forwarded header (RFC 7239), oldest first: `for=203.0.113.9`,
 * `for="[2001:db8::1]:443"`, `For=unknown`, anywhere in the header, without the brackets or the port of a
 * bracketed IPv6 node. A quoted value with no closing quote yields nothing, and the `for=` occurrences
 * inside it are still read.
 *
 * ONE LEFT-TO-RIGHT PASS on purpose. This used to be `/for=("?)\[?([^\]";,]+)\]?(?::\d+)?\1/gi`, whose
 * value class also matches the `:` and digits of the optional port: a value that fails its closing quote
 * can be retried at every split point, so the pattern's cost on a header any client sends rests on the
 * regex engine's optimisations rather than on its shape. Here each character is read a bounded number of
 * times, and the result is the one that pattern gave for every input (backend/src/tests/host-policy.test.ts
 * compares the two).
 */
function forwardedForValues(value) {
    const out = [];
    const marker = /for=/gi;
    let match;
    while ((match = marker.exec(value)) !== null) {
        const at = match.index + 4;
        const quoted = value[at] === '"';
        const open = quoted ? at + 1 : at;
        // `[` opens a bracketed node only when something follows it; otherwise it is the value itself.
        const start = value[open] === '[' && forwardedValueRunEnd(value, open + 1) > open + 1 ? open + 1 : open;
        const end = forwardedValueRunEnd(value, start);
        if (end === start) {
            marker.lastIndex = match.index + 1;
            continue;
        }
        // After the value: an optional `]`, an optional `:port`, and the closing quote of a quoted value.
        let next = end;
        if (value[next] === ']') next += 1;
        if (value[next] === ':' && digitRunEnd(value, next + 1) > next + 1) {
            const afterPort = digitRunEnd(value, next + 1);
            if (!quoted || value[afterPort] === '"') next = afterPort;
        }
        if (quoted) {
            if (value[next] !== '"') {
                marker.lastIndex = match.index + 1;
                continue;
            }
            next += 1;
        }
        out.push(value.slice(start, end));
        marker.lastIndex = next;
    }
    return out;
}

/**
 * A remote client arrived on a loopback Host that a proxy on this machine put there: it rewrote Host to
 * the address it dialled (nginx's default `Host $proxy_host`), so every name it serves looks like
 * localhost here and the named-host gate cannot see it. Behaviour is unchanged (loopback was always
 * answered); the operator is told once. Called only for an accepted loopback authority.
 *
 * The question is who SENT the loopback name, and that depends on where the authority came from:
 *
 *   · from Host: the socket peer sent it. A loopback peer (a proxy on this machine) with a non-loopback
 *     client in the forwarded headers is the collapse.
 *   · from X-Forwarded-Host: a trusted hop RELAYED the Host it received, and a relaying proxy appends
 *     the address of the peer that sent it that Host as the LAST X-Forwarded-For element (http-proxy's
 *     xfwd in the gateway, nginx's $proxy_add_x_forwarded_for). The gateway is always such a hop, and in
 *     split mode it is also a loopback peer that sends a loopback Host of its own (its upstream), so
 *     judging it by its socket would flag every remote client that typed `Host: localhost`. Only hops
 *     known to append are read this way: the mTLS gateway and a loopback hop; an operator hop on another
 *     machine (a frontend replica copies X-Forwarded-For verbatim) proves nothing.
 *
 * The monolith never relays its own pin: it forwards X-Forwarded-Host only when it judged a trusted
 * hop's (monolith.js), so a Host its peer sent arrives here as Host.
 */
function looksLikeProxyCollapse(req, pol, authority) {
    if (!pol.canonical || isLoopbackAuthority(pol.canonical)) return false;
    if (authority.source === 'host') {
        const sock = socketOf(req);
        if (!sock || !isLoopbackIp(sock.remoteAddress)) return false;
        return forwardedAddresses(req).some((address) => !isLoopbackIp(address));
    }
    if (authority.hop !== 'gateway' && authority.hop !== 'local') return false;
    const chain = forwardedForChain(req.headers || {});
    if (chain.length === 0 || !isLoopbackIp(chain[chain.length - 1])) return false;
    return forwardedAddresses(req, chain.slice(0, -1)).some((address) => !isLoopbackIp(address));
}

/** A socket peer as an operator would write it in trustProxy (IPv4-mapped IPv6 unwrapped), or null. */
function peerForTrust(sock) {
    const address = sock && sock.remoteAddress;
    if (typeof address !== 'string' || net.isIP(address) === 0) return null;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    return mapped && net.isIPv4(mapped[1]) ? mapped[1] : address;
}

/**
 * Advice for a refusal that is a proxy-topology mistake rather than a foreign name, or null.
 *
 * The signature: the peer relayed an X-Forwarded-Host, different from its Host, that names an address
 * this site answers — so the request would have been served had that header been read. Two reasons it
 * was not, each with its own remedy:
 *
 *   · the peer is not trusted, but would be honoured if it were (its Host passes operatorMayForwardHost):
 *     a frontend replica pinned with WORDJS_BACKEND_URL=http://<backend IP>:4000, or a proxy on another
 *     machine. Trusting it is the fix. A loopback peer is left to the generic "forward Host" hint: a
 *     proxy on this machine should forward Host, not be trusted wholesale.
 *   · the peer IS in trustProxy, but addressed WordJS by a dotted DNS name, so its X-Forwarded-Host is
 *     never read (operatorMayForwardHost). The fix is to forward the browser's Host, or dial by IP.
 *
 * The forwarded value must name an accepted address: otherwise trusting the peer would change nothing,
 * and a stranger's arbitrary header would only produce misleading advice. The only request-derived values
 * printed went through parseHost; the peer is the socket's own address, printed only when it is an IP.
 */
function forwardingAdvice(req, authority, pol, now) {
    const headers = req.headers || {};
    if (typeof headers['x-forwarded-host'] !== 'string') return null;
    const forwarded = parseHost(firstListValue(headers['x-forwarded-host']));
    const sent = parseHost(headers.host);
    if (!forwarded || !sent || serialize(forwarded) === serialize(sent)) return null;
    if (classify(forwarded, pol, { now }).cls === 'unknown') return null;
    const sock = socketOf(req);
    const peer = peerForTrust(sock);
    if (!peer) return null;
    if (authority.hop === null && !isLoopbackIp(sock.remoteAddress) && operatorMayForwardHost(headers.host)) {
        return `${peer} forwards X-Forwarded-Host but is not in trustProxy; if it is your frontend replica or proxy, set WORDJS_TRUST_PROXY=${peer} (or add it to trustProxy in wordjs-config.json, which takes precedence)`;
    }
    if (authority.hop === 'operator' && authority.source === 'host') {
        return `${peer} is in trustProxy but addresses WordJS as ${serialize(sent)}, a DNS name, so its X-Forwarded-Host is not read (a DNS-rebinding page sends such names too); have it forward the browser's Host (nginx: proxy_set_header Host $host) or connect to WordJS by IP address`;
    }
    return null;
}

/**
 * The Express/connect middleware that answers only this site's addresses (SPEC §2.3).
 *
 *   1 exempt path, not ambiguous            → next()
 *   2 more than one Host header             → 400 rest_invalid_host
 *   3 no host at all (HTTP/1.0)             → next()   (CSRF and CORS already fail closed on it)
 *   4 malformed host                        → 400 rest_invalid_host
 *   5 not installed yet                     → next()   (the install funnel answers later)
 *   6 no valid canonical in the config      → next() + one ERROR log + onNotice('missing-canonical')
 *   7 unknown address                       → 421 rest_host_not_allowed (recorded, throttled log)
 *   8 otherwise                             → req.siteHost = {...}; next()
 *
 * Options: `getPolicy()` (createPolicyProvider().get), `isInstalled()`, and optionally `logger`,
 * `onNotice(kind, detail)` for admin banners, `refused` / `lastSeen` trackers (the module's shared
 * ones by default, which GET /site-address reads), `exemptPaths`, `now`. Uses only the raw Node
 * response API, so the monolith and the gateway can mount it outside Express too.
 */
function hostGateFactory(opts) {
    if (!opts || typeof opts.getPolicy !== 'function' || typeof opts.isInstalled !== 'function') {
        throw new TypeError('hostGateFactory: getPolicy() and isInstalled() are required');
    }
    const logger = opts.logger || console;
    const onNotice = typeof opts.onNotice === 'function' ? opts.onNotice : null;
    const refused = opts.refused || refusedHosts;
    const seen = opts.lastSeen || lastSeen;
    const exempt = opts.exemptPaths || EXEMPT_PATHS;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    let missingCanonicalReported = false;
    let proxyCollapseReported = false;

    const notify = (kind, detail) => {
        if (!onNotice) return;
        try {
            onNotice(kind, detail);
        } catch (e) {
            logger.warn('[host-gate] notice callback failed: ' + (e && e.message));
        }
    };

    return function hostGate(req, res, next) {
        if (isExemptPath(requestPath(req), exempt)) return next();
        if (countHostHeaders(req) > 1) return sendInvalidHost(res);

        const pol = opts.getPolicy();
        const authority = requestAuthority(req, pol);
        if (authority.absent) return next();
        if (!authority.parsed) return sendInvalidHost(res);
        if (!opts.isInstalled()) return next();

        if (!pol.canonical) {
            if (!missingCanonicalReported) {
                missingCanonicalReported = true;
                logger.error(`[host-gate] siteUrl in wordjs-config.json is ${pol.canonicalError || 'missing'}; every address is answered until it is fixed (Settings > Site address, or npm run site -- canonical <url>).`);
                notify('missing-canonical', { error: pol.canonicalError || 'missing' });
            }
            return next();
        }
        missingCanonicalReported = false;

        const parsed = authority.parsed;
        const t = now();
        const verdict = classify(parsed, pol, { proxied: authority.proxied, now: t });
        if (verdict.cls === 'unknown') {
            // A proxy-topology mistake is recorded as 'forward-host' for the admin page (whose hint codes
            // are a closed set): adding the address it names would be the wrong fix. The log line, which
            // can name the peer, carries the specific remedy.
            const advice = forwardingAdvice(req, authority, pol, t);
            const hint = advice ? 'forward-host' : refusalHint(parsed, pol, verdict.reason);
            if (refused.record(parsed.hostname, hint, 'gate')) {
                const why = advice || (hint ? REFUSAL_HINTS[hint] : null);
                logger.warn(`[host-gate] 421 for ${serialize(parsed)} (${verdict.reason})` + (why ? ': ' + why : '; add it in Settings > Site address if it should work.'));
            }
            return sendHostNotAllowed(res);
        }

        if (verdict.cls === 'loopback' && !pol.dev && !proxyCollapseReported && looksLikeProxyCollapse(req, pol, authority)) {
            proxyCollapseReported = true;
            logger.warn('[host-gate] remote clients reach WordJS with a loopback Host: a local reverse proxy is rewriting Host, so the address check cannot see which name they used. ' + REFUSAL_HINTS['forward-host'] + '.');
            notify('proxy-collapse', { host: serialize(parsed) });
        }

        req.siteHost = {
            hostname: parsed.hostname,
            port: parsed.port,
            kind: parsed.kind,
            host: serialize(parsed),
            cls: verdict.cls,
            reason: verdict.reason,
            entry: verdict.entry,
            hop: authority.hop,
            viaTrustedHop: authority.viaTrustedHop,
            scheme: schemeVia(req, authority.hop),
        };
        if (DECLARED_CLASSES.has(verdict.cls)) seen.touch(parsed.hostname);
        return next();
    };
}

module.exports = {
    // parsing
    parseHost,
    serialize,
    parseSiteUrl,
    isLoopbackAuthority,
    isLoopbackIp,
    // this machine
    ownAddresses,
    createOwnAddresses,
    addressesFromInterfaces,
    // request derivation
    compileTrustProxy,
    trustedHop,
    hasProxyMarkers,
    requestAuthority,
    requestHost,
    trustedScheme,
    forwardedForValues,
    // classification and policy
    classify,
    refusalHint,
    REFUSAL_HINTS,
    TUNNEL_SUFFIXES,
    isTunnelHost,
    isLanName,
    buildPolicy,
    createPolicyProvider,
    // observations
    REFUSAL_SOURCES,
    createRefusedHosts,
    mergeRefusedHosts,
    createLastSeen,
    refusedHosts,
    lastSeen,
    noteAuthenticatedUse,
    // gate
    EXEMPT_PATHS,
    hasDotSegments,
    isAmbiguousPath,
    hostGateFactory,
    sendHostNotAllowed,
    sendInvalidHost,
};

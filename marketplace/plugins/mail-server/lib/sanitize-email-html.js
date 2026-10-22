/**
 * WordJS Mail Server — vendored strict-allowlist HTML sanitizer (WRITE SIDE / durable control).
 *
 * WHY VENDORED: this plugin runs in a child_process ISOLATE. The platform's node sanitizer
 * (`sanitize-html`) is not resolvable from the plugin's require path and the sandbox denies pulling
 * in arbitrary host modules; DOMPurify needs a DOM the isolate does not have. So the durable,
 * at-rest control is a small self-contained sanitizer with NO dependencies.
 *
 * THREAT MODEL: inbound email HTML is ATTACKER-CONTROLLED (anyone on the internet can send mail; a
 * catch-all lands unrouted mail in the ADMIN's mailbox). It is hostile by definition, so this is a
 * DEFAULT-DENY ALLOWLIST, not a blocklist strip.
 *
 * WHY THIS IS SAFE (and not the classic "incomplete multi-character sanitization" trap): we do NOT
 * find-and-remove substrings from the input (which can splice `<<script>script>` into a live tag).
 * We TOKENIZE the input and REBUILD the output from scratch:
 *   - every emitted tag name comes from a fixed ALLOWLIST (unknown/dangerous tags are dropped);
 *   - text nodes are HTML-escaped, so no attacker string is ever emitted in tag position;
 *   - only a tiny per-tag attribute allowlist survives (href on <a>, src/alt/width/height on <img>,
 *     presentational table/cell attributes with a plain value alphabet), every other attribute —
 *     class, id, and ALL on* handlers — is dropped by default-deny;
 *   - `style` is REBUILT, never copied: it is parsed into declarations and only allowlisted layout/
 *     typography properties whose values use a plain alphabet survive. No url(), no expression(), no
 *     CSS escapes, comments, at-rules or entities — a value that needs any of those drops the whole
 *     attribute — so the old exfil/script shapes cannot be expressed (newsletters keep their look);
 *   - href/src values are entity-decoded then scheme-checked (javascript:/vbscript:/data:/file:/
 *     about:/blob: rejected), so `<a href="&#106;avascript:...">` cannot smuggle a scheme past us;
 *   - raw-text elements (script/style/etc.) have BOTH the tag and their contents dropped.
 * The output alphabet is therefore {allowlisted tags, escaped text, scheme-checked+escaped attrs},
 * none of which can carry executable script. Proven by the regression suite in
 * lib/sanitize-email-html.test.js (mutating away any rule makes a payload survive → test fails).
 */

'use strict';

// Inline formatting + structure + tables + links/images. Deliberately NO: script, style, iframe,
// object, embed, form, input, button, svg, math, noscript, template, base, link, meta, frame.
const ALLOWED_TAGS = new Set([
    'a', 'b', 'i', 'u', 'em', 'strong', 'mark', 's', 'del', 'ins', 'sub', 'sup', 'small',
    'p', 'br', 'hr', 'span', 'div', 'blockquote', 'pre', 'code',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
    'figure', 'figcaption', 'img',
]);

// Void (self-closing) elements — never emit a closing tag for these.
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col']);

// Raw-text / dangerous containers: drop the OPENING tag AND everything up to the matching close.
// (For raw-text elements like <script>/<style>, the browser would treat the inner text as script/CSS,
// so it must never reach the output — dropping the tag alone is not enough.)
const DROP_WITH_CONTENT = new Set([
    'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed',
    'svg', 'math', 'head', 'title', 'frame', 'frameset', 'applet', 'xmp', 'noembed',
]);

// Per-tag surviving attributes. Everything not listed here (class, id, on*, srcset, formaction, …) is
// dropped by DEFAULT-DENY. `style` is allowed on every tag but goes through sanitizeStyle below.
const TABLE_ATTRS = ['width', 'height', 'align', 'valign', 'bgcolor'];
const ALLOWED_ATTR = {
    a: new Set(['href']),
    img: new Set(['src', 'alt', 'width', 'height', 'align']),
    table: new Set([...TABLE_ATTRS, 'border', 'cellpadding', 'cellspacing']),
    tr: new Set(TABLE_ATTRS),
    td: new Set([...TABLE_ATTRS, 'colspan', 'rowspan']),
    th: new Set([...TABLE_ATTRS, 'colspan', 'rowspan']),
    col: new Set(['width', 'span']),
    p: new Set(['align']),
    div: new Set(['align']),
    h1: new Set(['align']), h2: new Set(['align']), h3: new Set(['align']),
};
// Presentational attribute values: words, numbers, %, # colours. Nothing that can open a scheme or a
// function.
const PLAIN_ATTR_VALUE = /^[a-zA-Z0-9#%. -]{0,40}$/;

// Inline CSS: properties a message needs to look like its sender meant, and nothing that positions it
// out of its box or loads anything.
const STYLE_PROPS = new Set([
    'color', 'background-color', 'background',
    'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'line-height',
    'letter-spacing', 'word-spacing', 'text-align', 'text-decoration', 'text-transform', 'text-indent',
    'white-space', 'vertical-align', 'direction',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style',
    'border-width', 'border-radius', 'border-collapse', 'border-spacing',
    'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height',
    'display', 'table-layout', 'list-style-type', 'overflow', 'box-sizing',
]);
const DISPLAY_VALUES = new Set(['block', 'inline', 'inline-block', 'table', 'table-row', 'table-cell', 'none', 'list-item']);
// Value alphabet: words, numbers, units, %, #hex, commas, spaces, and only the colour functions.
const STYLE_VALUE = /^[a-zA-Z0-9#%.,\s()!-]{1,200}$/;
const STYLE_FUNCS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);

function sanitizeStyle(raw) {
    const css = String(raw == null ? '' : raw);
    // The attribute value reaches the CSS parser AFTER entity decoding, and CSS has its own escapes and
    // comments: any of those could rebuild a name we refuse (u\72l(, ur/**/l(, &#117;rl( …). Refuse the
    // whole attribute rather than decode and hope.
    if (/[&\\<>@]|\/\*/.test(css)) return '';
    const out = [];
    for (const decl of css.split(';')) {
        const i = decl.indexOf(':');
        if (i === -1) continue;
        const prop = decl.slice(0, i).trim().toLowerCase();
        let value = decl.slice(i + 1).trim();
        // Font names are commonly quoted; unquoted names are valid CSS, so drop the quotes.
        if (prop === 'font-family' || prop === 'font') value = value.replace(/["']/g, '');
        if (!STYLE_PROPS.has(prop) || !STYLE_VALUE.test(value)) continue;
        const funcs = value.toLowerCase().match(/[a-z-]+(?=\s*\()/g) || [];
        if (funcs.some(f => !STYLE_FUNCS.has(f))) continue;
        if (/\(\s*\(|\)\s*\(/.test(value) || (value.match(/\(/g) || []).length !== funcs.length) continue;
        if ((value.match(/\(/g) || []).length !== (value.match(/\)/g) || []).length) continue;
        if (prop === 'display' && !DISPLAY_VALUES.has(value.toLowerCase())) continue;
        // A negative margin pulls the content over what surrounds it.
        if (prop.startsWith('margin') && /(^|[\s,(])-/.test(value)) continue;
        out.push(prop + ':' + value.replace(/\s+/g, ' '));
    }
    return out.join(';');
}

// The input is HTML SOURCE, so its '&' already introduces character references ('&amp;', '&#38;',
// '&lt;'). Escaping those again turned every '&amp;' of an incoming message into a literal "&amp;" on
// screen — and into '&amp;amp;' inside an href, which broke every link with a query string (a password
// reset link lost its token). A bare '&' is still escaped; a well-formed reference is kept as written,
// and it decodes inside the same text or attribute it came from, so it cannot open a tag or end a value.
const BARE_AMP = /&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});)/g;

function escapeText(s) {
    return String(s)
        .replace(BARE_AMP, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
    return String(s)
        .replace(BARE_AMP, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Decode the entity encodings an attacker could use to HIDE a dangerous scheme (numeric refs and the
// handful of named refs that matter for scheme smuggling), strip control/whitespace, then check.
function isSafeUrl(raw) {
    let t = String(raw == null ? '' : raw)
        .replace(/&#x([0-9a-f]+);?/gi, (_, h) => {
            const n = parseInt(h, 16);
            return Number.isFinite(n) ? String.fromCharCode(n) : '';
        })
        .replace(/&#(\d+);?/g, (_, d) => {
            const n = parseInt(d, 10);
            return Number.isFinite(n) ? String.fromCharCode(n) : '';
        })
        .replace(/&colon;/gi, ':')
        .replace(/&Tab;|&NewLine;/gi, '');
    // Remove ALL whitespace/control chars (NUL, tab, newline, DEL, and the C1 range up to A0), which
    // browsers strip before resolving a URL scheme — `java\tscript:` would otherwise slip through.
    t = t.replace(/[ - - ]/g, '').toLowerCase();
    if (t === '') return true; // empty stays inert
    // Any explicitly dangerous scheme → reject.
    if (/^(?:javascript|vbscript|data|file|about|blob):/.test(t)) return false;
    // Scheme-relative or absolute with a scheme: only allow a known-safe set.
    const m = /^([a-z][a-z0-9.+-]*):/.exec(t);
    if (!m) return true; // relative path, query, or fragment — inert
    return m[1] === 'http' || m[1] === 'https' || m[1] === 'mailto' || m[1] === 'tel';
}

// Find the index of the '>' that closes the tag starting at `lt`, skipping quoted attribute regions
// so `<a title=">">` does not end early. Returns -1 if the tag is never terminated.
function findTagEnd(src, lt) {
    let q = null;
    for (let k = lt + 1; k < src.length; k++) {
        const c = src[k];
        if (q) {
            if (c === q) q = null;
        } else if (c === '"' || c === "'") {
            q = c;
        } else if (c === '>') {
            return k;
        }
    }
    return -1;
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

function parseAttrs(rawTag) {
    // Strip leading `<name` and trailing `>` / `/>`.
    const inner = rawTag
        .replace(/^<\s*\/?[a-zA-Z][a-zA-Z0-9:-]*/, '')
        .replace(/\/?\s*>?$/, '');
    const out = [];
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(inner))) {
        let val = m[2] || '';
        if (val && (val[0] === '"' || val[0] === "'")) val = val.slice(1, -1);
        out.push([m[1].toLowerCase(), val]);
    }
    return out;
}

const TAG_START_RE = /^<\s*(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/;

/**
 * Sanitize hostile HTML down to a safe, basic-formatting allowlist. Returns a string.
 */
function sanitizeEmailHtml(input) {
    const src = String(input == null ? '' : input);
    const n = src.length;
    let out = '';
    let i = 0;
    let skipUntil = null; // when inside a DROP_WITH_CONTENT element, the tag name we wait to close.

    while (i < n) {
        const lt = src.indexOf('<', i);
        if (lt === -1) {
            if (!skipUntil) out += escapeText(src.slice(i));
            break;
        }
        if (lt > i && !skipUntil) out += escapeText(src.slice(i, lt));

        // Comments and CDATA/declarations/PIs: drop entirely (they can hide markup / conditional-comment
        // script). Advance past them.
        if (src.startsWith('<!--', lt)) {
            const end = src.indexOf('-->', lt + 4);
            i = end === -1 ? n : end + 3;
            continue;
        }
        if (src[lt + 1] === '!' || src[lt + 1] === '?') {
            const end = src.indexOf('>', lt + 1);
            i = end === -1 ? n : end + 1;
            continue;
        }

        const m = TAG_START_RE.exec(src.slice(lt, lt + 64));
        if (!m) {
            // A bare '<' that does not start a tag → emit as escaped text (unless we're dropping).
            if (!skipUntil) out += '&lt;';
            i = lt + 1;
            continue;
        }

        const tagEnd = findTagEnd(src, lt);
        const rawTag = tagEnd === -1 ? src.slice(lt) : src.slice(lt, tagEnd + 1);
        i = tagEnd === -1 ? n : tagEnd + 1;

        const isClose = m[1] === '/';
        const name = m[2].toLowerCase();

        if (skipUntil) {
            // Inside a dropped raw-text/dangerous container: emit nothing, only watch for its close.
            if (isClose && name === skipUntil) skipUntil = null;
            continue;
        }

        if (DROP_WITH_CONTENT.has(name)) {
            const selfClosed = /\/\s*>$/.test(rawTag);
            if (!isClose && !selfClosed) skipUntil = name;
            continue; // drop the tag itself either way
        }

        if (!ALLOWED_TAGS.has(name)) continue; // unknown tag → drop tag, keep surrounding text

        if (isClose) {
            if (!VOID_TAGS.has(name)) out += '</' + name + '>';
            continue;
        }

        // Opening (or self-closing) allowlisted tag: rebuild with only allowlisted, scheme-checked attrs.
        let rebuilt = '<' + name;
        const allow = ALLOWED_ATTR[name];
        const seen = new Set();
        for (const [an, av] of parseAttrs(rawTag)) {
            if (seen.has(an)) continue; // the browser keeps the FIRST of duplicate attributes — so do we
            seen.add(an);
            if (an === 'style') {
                const style = sanitizeStyle(av);
                if (style) rebuilt += ' style="' + escapeAttr(style) + '"';
                continue;
            }
            if (!allow || !allow.has(an)) continue;
            if (an === 'href' || an === 'src') {
                if (!isSafeUrl(av)) continue;
            } else if (!PLAIN_ATTR_VALUE.test(av)) continue;
            rebuilt += ' ' + an + '="' + escapeAttr(av) + '"';
        }
        rebuilt += VOID_TAGS.has(name) ? '/>' : '>';
        out += rebuilt;
    }

    return out;
}

module.exports = { sanitizeEmailHtml, sanitizeStyle };

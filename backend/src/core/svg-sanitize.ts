/**
 * WordJS — the SVG sanitizer: one allowlist for every path that stores an SVG.
 *
 * An SVG is XML a browser executes: <script>, on* event ATTRIBUTES (onload/onerror — never tag names, which
 * is how an older denylist let them through as stored XSS), javascript:/data:text URLs and foreign objects.
 * So it is sanitized via an explicit ALLOWLIST: every unlisted tag and attribute is dropped. Used by the
 * upload route (routes/media.ts) and by the WordPress importer (core/wxr-media.ts), so an imported SVG is
 * stored exactly as an uploaded one would be.
 */

const sanitizeHtml = require('sanitize-html');

/** A plain CSS value (keywords, numbers, units, colours, lists) — no parentheses, so no url()/expression(). */
const PLAIN_VALUE = /^[-#\w.,%\s]+$/;
/** A colour function with numeric arguments only. */
const COLOR_FN = /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.,%\s/]+\)$/i;
/** A reference to an element of the same document (a gradient, clip path, mask or filter). */
const LOCAL_REF = /^url\(\s*["']?#[\w-]+["']?\s*\)$/i;
const PAINT = [PLAIN_VALUE, COLOR_FN, LOCAL_REF];
const PLAIN = [PLAIN_VALUE];
const ALLOWED_STYLES: Record<string, RegExp[]> = {
    fill: PAINT, stroke: PAINT, color: [PLAIN_VALUE, COLOR_FN], 'stop-color': [PLAIN_VALUE, COLOR_FN],
    'clip-path': [LOCAL_REF, PLAIN_VALUE], mask: [LOCAL_REF, PLAIN_VALUE], filter: [LOCAL_REF, PLAIN_VALUE],
    'fill-opacity': PLAIN, 'stroke-opacity': PLAIN, 'stop-opacity': PLAIN, opacity: PLAIN,
    'fill-rule': PLAIN, 'clip-rule': PLAIN, 'stroke-width': PLAIN, 'stroke-linecap': PLAIN,
    'stroke-linejoin': PLAIN, 'stroke-dasharray': PLAIN, 'stroke-dashoffset': PLAIN, 'stroke-miterlimit': PLAIN,
    'font-size': PLAIN, 'font-family': [/^[-\w.,\s"']+$/], 'font-weight': PLAIN, 'font-style': PLAIN,
    'text-anchor': PLAIN, 'dominant-baseline': PLAIN, 'letter-spacing': PLAIN,
    display: PLAIN, visibility: PLAIN,
};

/** The SVG markup with everything outside the allowlist removed. */
function sanitizeSvg(raw: string): string {
    return sanitizeHtml(String(raw), {
        allowedTags: [
            'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
            'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath',
            'mask', 'pattern', 'use', 'symbol', 'title', 'desc', 'marker', 'filter',
            'feGaussianBlur', 'feOffset', 'feBlend', 'feMerge', 'feMergeNode', 'feColorMatrix', 'image'
        ],
        allowedAttributes: {
            '*': [
                'id', 'class', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
                'stroke-dasharray', 'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy',
                'r', 'rx', 'ry', 'width', 'height', 'viewBox', 'xmlns', 'xmlns:xlink', 'version',
                'transform', 'opacity', 'fill-opacity', 'stroke-opacity', 'offset', 'stop-color',
                'stop-opacity', 'gradientUnits', 'gradientTransform', 'patternUnits', 'clip-path',
                'mask', 'filter', 'font-size', 'font-family', 'text-anchor', 'preserveAspectRatio',
                'xlink:href', 'href', 'style',
                // Plain-value attributes of the camelCase elements above (filters, markers, gradients,
                // clip paths), which the parser now keeps: none of them takes a URL.
                'stdDeviation', 'dx', 'dy', 'in', 'in2', 'result', 'mode', 'values', 'type',
                'fx', 'fy', 'spreadMethod', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient',
                'clipPathUnits', 'maskUnits', 'maskContentUnits', 'patternContentUnits',
                'fill-rule', 'clip-rule', 'stroke-miterlimit', 'stroke-dashoffset', 'font-weight', 'font-style'
            ]
        },
        // Block javascript:/data: in every URL attribute; allow only safe schemes (fragment refs like
        // #id carry no scheme and are permitted). The checked attributes are named here rather than
        // inherited from the library's defaults, so `xlink:href` is checked whatever version is
        // installed. An <image> loads http(s) only — a data: URL can carry a whole document of its own.
        // on* attributes are absent from the allowlist → dropped.
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesByTag: { image: ['http', 'https'] },
        allowedSchemesAppliedToAttributes: ['href', 'xlink:href', 'src'],
        // `style` keeps only presentation properties, with plain values or a reference to an element of
        // this same document (`url(#id)`): no external url(), no other CSS.
        allowedStyles: { '*': ALLOWED_STYLES },
        // SVG is case-sensitive: lower-casing would turn linearGradient into lineargradient, which the
        // allowlist (and the browser) does not know, and the element would be dropped.
        parser: { lowerCaseTags: false, lowerCaseAttributeNames: false }
    });
}

module.exports = { sanitizeSvg };

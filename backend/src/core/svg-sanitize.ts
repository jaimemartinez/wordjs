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
                'xlink:href', 'href', 'style'
            ]
        },
        // Block javascript:/data:text in href; allow only safe schemes (fragment refs like #id
        // carry no scheme and are permitted). on* attributes are absent from the allowlist → dropped.
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesByTag: { image: ['http', 'https', 'data'] },
        parser: { lowerCaseAttributeNames: false }
    });
}

module.exports = { sanitizeSvg };

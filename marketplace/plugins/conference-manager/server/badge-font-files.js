/**
 * The shipped badge faces (conference-manager 2.29.0): each one a module (fonts/<face>.js, the TrueType file in
 * base64), loaded on first use by a LITERAL require — the plugin reads no file, so it needs no filesystem
 * permission — and kept parsed for the layout and as bytes for the PDF.
 */
'use strict';

const { parseTtf } = require('./badge-font');

const LOADERS = {
    'montserrat-400': () => require('../fonts/montserrat-400.js'),
    'montserrat-700': () => require('../fonts/montserrat-700.js'),
    'poppins-400': () => require('../fonts/poppins-400.js'),
    'poppins-700': () => require('../fonts/poppins-700.js'),
    'lato-400': () => require('../fonts/lato-400.js'),
    'lato-700': () => require('../fonts/lato-700.js'),
    'raleway-400': () => require('../fonts/raleway-400.js'),
    'raleway-700': () => require('../fonts/raleway-700.js'),
    'opensans-400': () => require('../fonts/opensans-400.js'),
    'opensans-700': () => require('../fonts/opensans-700.js'),
    'roboto-400': () => require('../fonts/roboto-400.js'),
    'roboto-700': () => require('../fonts/roboto-700.js'),
    'nunito-400': () => require('../fonts/nunito-400.js'),
    'nunito-700': () => require('../fonts/nunito-700.js'),
    'oswald-400': () => require('../fonts/oswald-400.js'),
    'oswald-700': () => require('../fonts/oswald-700.js'),
    'bebas-400': () => require('../fonts/bebas-400.js'),
    'playfair-400': () => require('../fonts/playfair-400.js'),
    'playfair-700': () => require('../fonts/playfair-700.js'),
    'merriweather-400': () => require('../fonts/merriweather-400.js'),
    'merriweather-700': () => require('../fonts/merriweather-700.js'),
    'lora-400': () => require('../fonts/lora-400.js'),
    'lora-700': () => require('../fonts/lora-700.js'),
    'dancing-400': () => require('../fonts/dancing-400.js'),
    'dancing-700': () => require('../fonts/dancing-700.js'),
};
const bytesCache = new Map();
const parsedCache = new Map();

/** The face's TrueType bytes (Buffer), or null for an unknown face. */
function faceBytes(face) {
    if (bytesCache.has(face)) return bytesCache.get(face);
    const load = Object.prototype.hasOwnProperty.call(LOADERS, face) ? LOADERS[face] : null;
    if (!load) return null;
    const bytes = Buffer.from(load(), 'base64');
    bytesCache.set(face, bytes);
    return bytes;
}
/** The face's TrueType file as base64 (what the browser fetches), or null. */
function faceBase64(face) {
    const load = Object.prototype.hasOwnProperty.call(LOADERS, face) ? LOADERS[face] : null;
    return load ? load() : null;
}
/** parseTtf of the face, cached; null for an unknown face. */
function faceParsed(face) {
    if (parsedCache.has(face)) return parsedCache.get(face);
    const bytes = faceBytes(face);
    const parsed = bytes ? parseTtf(bytes) : null;
    parsedCache.set(face, parsed);
    return parsed;
}

module.exports = { faceBytes, faceBase64, faceParsed, FACES: Object.keys(LOADERS) };

/**
 * The product version (e.g. 2.6.0), read from the release manifest. Shared by the OpenAPI document
 * (config/swagger) and the API index (GET /api/v1/), so neither can announce a stale literal.
 */
const path = require('path');
const log = require('../core/module-logger').moduleLogger('config/product-version');

// THE PUBLISHED API VERSION WAS A CONSTANT, AND CONSTANTS GO STALE SILENTLY.
//
// `version` here was hardcoded '1.0.0' while the product shipped 2.1.0 — so /api-docs, the spec
// every integrator reads and every generated client stamps into its own metadata, had been
// announcing a version that stopped being true at the first release. Nothing could catch it: a
// literal cannot drift, it is simply wrong, and no test compared it to anything.
//
// Derive it instead. The root package.json is the manifest the release tag bumps (backend's is
// bumped in lockstep), and both sit at a FIXED depth from this module in either tier — `src/config`
// and `dist/config` are both two levels under `backend/`, so `../../../package.json` is the repo (or
// extracted bundle) root from either.
//
// Never throw. This module is required by the docs router at request time; a missing or unreadable
// manifest must degrade the version string, not take the API documentation endpoint down with it —
// which is exactly what an uncaught require() of an absent file would do.
const resolveProductVersion = (): string => {
    const candidates = [
        path.resolve(__dirname, '../../../package.json'), // repo / extracted-bundle root: the release manifest
        path.resolve(__dirname, '../../package.json'), // backend/package.json: bumped in lockstep
    ];
    for (const manifest of candidates) {
        try {
            const version = require(manifest).version;
            if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) {
                return version;
            }
        } catch {
            // Unreadable or absent — try the next candidate.
        }
    }
    log.warn(`[product-version] could not read a product version from ${candidates.join(' or ')} — ` +
            `serving 0.0.0.`);
    return '0.0.0';
};

module.exports = { resolveProductVersion };

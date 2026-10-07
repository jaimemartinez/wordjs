/**
 * WordJS — THE HERMETIC RELEASE BUILD. What `next build` may read when it is producing a release.
 *
 * `npm run bundle-release` (scripts/make-release.js) builds the frontend on whatever machine runs it,
 * and `next build` PRERENDERS: it renders the public pages once, at build time, and ships the HTML.
 * Every server-side read during that render goes to the backend `src/lib/server-api.ts` resolves —
 * the developer's own `wordjs-config.json` when there is one, and `http://localhost:4000` when there
 * is not. CI builds from a clean checkout with nothing listening, so every one of those reads fails
 * and the pages render the defaults. A developer machine usually HAS a dev backend on :4000, and a
 * release packaged there came out with private content from that running dev backend baked into its
 * prerendered pages — the site title on /register, /login, /_not-found…, its posts prerendered as
 * static paths — plus an API rewrite pointing wherever that machine's config said.
 *
 * With `WORDJS_HERMETIC_BUILD=1` the build reads none of that:
 *   · src/lib/server-api.ts and src/lib/api.ts use HERMETIC_BACKEND_BASE as the backend, ignoring
 *     wordjs-config.json, INTERNAL_API_URL and WORDJS_MODE, and forward no configured public host;
 *   · next.config.ts bakes the compiled-in default API rewrite, ignoring wordjs-config.json's
 *     gatewayPort, WORDJS_BACKEND_URL and WORDJS_MODE;
 *   · the prebuild plugin-registry generators list only the plugins git tracks and ask no backend
 *     which are active (scripts/hermetic-plugins.js).
 *
 * WHY A BASE THAT FAILS, NOT "SKIP THE FETCH". Next learns a page's ISR window from the fetches made
 * while prerendering it: the revalidate of each fetch is recorded BEFORE the request goes out, so a
 * fetch that fails still turns /register into "static, revalidate 60s", and the first visit after a
 * minute re-renders it with the real site's data. A build that skipped the fetch would mark the same
 * pages static FOREVER, shipping the placeholder title for good. The fetch therefore still happens —
 * it just cannot succeed, which is exactly the clean-CI situation.
 *
 * WHY PORT 1. It is on the WHATWG Fetch standard's "bad port" list, so `fetch()` refuses it before any
 * DNS lookup or connect (undici answers `TypeError: fetch failed`, cause "bad port", in ~0 ms). Unlike
 * "an unused port", no process on the build machine can make a fetch() to it succeed. That guarantee
 * is fetch()'s, not the port's: Windows lets any user bind port 1, so a read made with http.request
 * would connect. Build-time reads must therefore go through fetch(), as every one in server-api.ts and
 * api.ts does, and scripts/release-hermetic-check.js checks the output regardless.
 *
 * Release-build only. Nothing sets this at runtime; a deployed frontend never sees it.
 *
 * CommonJS for the same reason as backend-proxy-target.js: next.config.ts and scripts/make-release.js
 * cannot import TypeScript, and src/ reads the same constants rather than a copy of them.
 */

/** The environment variable scripts/make-release.js sets for the release `next build`. */
const HERMETIC_BUILD_ENV = 'WORDJS_HERMETIC_BUILD';

/** The backend a hermetic build "talks to": loopback on a Fetch-standard bad port — never answers. */
const HERMETIC_BACKEND_BASE = 'http://127.0.0.1:1/api/v1';

/**
 * Is this process the hermetic release build? Exactly '1' — the build sets it, nobody else should, and
 * a stray `false`/`0` in someone's shell must not switch the frontend's backend off.
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function isHermeticBuild(env) {
    return (env || process.env)[HERMETIC_BUILD_ENV] === '1';
}

module.exports = { HERMETIC_BUILD_ENV, HERMETIC_BACKEND_BASE, isHermeticBuild };

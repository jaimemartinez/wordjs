/**
 * WordJS — THE HOSTS A VIDEO EMBED MAY COME FROM. One list, two readers, no drift.
 *
 * WHY THIS FILE EXISTS AT ALL. The list used to live only in `src/lib/sanitize.ts`, and
 * `next.config.ts` wrote the CSP `frame-src` hosts out BY HAND next to a comment claiming it covered
 * "the sanitizer's permitted youtube/vimeo embeds". It did not: `www.youtube-nocookie.com` — exactly
 * what YouTube hands you when you tick "Enable privacy-enhanced mode" under Share → Embed — was
 * accepted by `resolveVideoEmbedUrl` and BLOCKED by the CSP. The block therefore resolved the embed,
 * rendered a real <iframe>, and the browser refused the frame: an empty hole with no "Unsupported
 * video URL" marker, because as far as the code was concerned nothing had gone wrong. The same header
 * is served on /admin, so the author saw the hole the moment they pasted the URL.
 *
 * `next.config.ts` is transpiled and executed by Next itself; its imports are resolved by Node at
 * runtime, so it cannot read a `.ts` module. That is the whole reason this is a plain `.js` file at
 * the frontend root — the same arrangement as `backend-proxy-target.js`, which `next.config.ts` and
 * `server.js` both have to agree with.
 *
 * READERS:
 *   · src/lib/sanitize.ts — ALLOWED_IFRAME_HOSTS (what survives HTML sanitizing) and
 *     ALLOWED_EMBED_HOSTS (what the VideoEmbed block may build an iframe src for);
 *   · next.config.ts — the CSP `frame-src` directive, DERIVED from ALLOWED_EMBED_HOSTS.
 *   · backend/src/core/sanitize-meta.ts consumes its own generated artifact from the same contract.
 *
 * ADDING A PROVIDER: change contracts/visual-contract.v1.json and regenerate. The test
 * `src/lib/__tests__/embedHostsCsp.test.ts` fails if `frame-src` and this list ever disagree.
 */

/**
 * Hosts an <iframe> may point at after HTML sanitizing. Kept narrow on purpose: this is the list
 * sanitize-html/DOMPurify enforce on raw pasted markup.
 * @type {string[]}
 */
const { security } = require('../contracts/visual-contract.v1.json');
const ALLOWED_IFRAME_HOSTS = [...security.html.iframeHosts];

/**
 * Hosts the VideoEmbed block may CANONICALISE a pasted URL to. ALLOWED_IFRAME_HOSTS plus YouTube's
 * cookie-less mirror of the same player, which the block has always honoured when an author pasted
 * one — and which the CSP has to permit for that to be visible.
 * @type {string[]}
 */
const ALLOWED_EMBED_HOSTS = [...security.html.iframeHosts];

module.exports = { ALLOWED_IFRAME_HOSTS, ALLOWED_EMBED_HOSTS };

# Turnaround batch — deferred findings backlog (2026-09-04)

Two adversarial reviews ran over the turnaround batch before its pull request: a first pass over the whole batch (95 findings; the 18 judged must-fix were closed in the same PR, see the Security and Fixed entries under `[Unreleased]` in CHANGELOG.md) and a second pass over those fixes (11 confirmed must-fix, closed; 41 non-blocking). Everything below is what was NOT closed, kept verbatim from the reviewers so the next triage does not start from zero. Items may overlap, may already be fixed by a neighbouring change, or may be wrong: each needs a two-minute check against the current tree before it becomes work. Severity is the reviewer's, not a commitment.

## Second pass — non-blocking (post-fix re-check, run wf_5903b566)

- [medium] [F1-frontend-archives-media] backend/src/models/Post.ts:312 — An all-digit user_nicename does not round-trip: the author archive 404s (or shows a different author's posts) and the feed prints a self URL that 404s
  scenario: An account's display name is a number — "2024", "1984", "42", "007" (a magazine, a year, a handle). User.generateUniqueNicename runs sanitizeTitle (slugify strict) which preserves digits, so user id 7 gets user_nicename = '2024'. Post.toJSON then serialises author.slug = '2024'. The frontend author route reads it back: parseAuthorId('2024') matches /^[1-9][0-9]{0,9}$/, so the selector is sent as a
  hint: Refuse an all-digit nicename at the writer (User.generateUniqueNicename and migration 0015: if the slugified base is all digits, prefix it or fall back to '' so the id fallback is used), which is cheaper than teaching three shape-splitters to disambiguate.
- [medium] [F1-frontend-archives-media] frontend/src/lib/public/archives.ts:92 — The new multi-page walks paginate over an ORDER BY with no unique tiebreaker, so a post can appear twice and another vanish
  scenario: A category holds 250 posts imported from WXR where many share the same post_date (a bulk import that stamped one timestamp, or a batch publish). walkPublishedPosts issues `per_page=100&page=1`, then `page=2`, `page=3`. The backend runs `ORDER BY p.post_date DESC LIMIT 100 OFFSET 100` with no id tiebreaker; on Postgres/MySQL the row order among equal post_date values is not stable between two separ
  hint: Append `, p.id DESC` (or the id in the requested direction) to the ORDER BY in Post.findAll/findAllWithRelations so LIMIT/OFFSET paging is total-ordered; belt-and-braces, de-duplicate by id in walkPublishedPosts.
- [medium] [F1-frontend-archives-media] frontend/src/lib/public/archives.ts:460 — /taxonomy/{tax}/{term}/page/N canonicalises to page 1 of the dedicated archive, contradicting the module's own "page 2+ must not claim page 1's address" rule
  scenario: A category with 3 pages is reachable at /taxonomy/category/news/page/2. buildArchiveMetadata takes `canonicalPath ?? pageHref(basePath, page)`, and the taxonomy route sets canonicalPath to the page-1 dedicated path unconditionally, so /taxonomy/category/news/page/2 and /page/3 both emit `<link rel="canonical" href="/category/news">` — page 1. A crawler is told two pages of different posts are the 
  hint: Make canonicalPath the alias TARGET'S base path and run it through pageHref(canonicalBase, page), i.e. `const canonical = pageHref(canonicalPath ?? basePath, page)`.
- [medium] [F1-frontend-archives-media] frontend/src/lib/public/archives.ts:99 — walkPublishedPosts swallows a mid-walk backend failure and publishes the truncated result as the archive's authoritative total
  scenario: A category has 250 published posts. Page 1 of the walk succeeds (100 rows); page 2's fetch fails (backend restart, timeout) and serverFetch returns null. `if (!Array.isArray(batch) || batch.length === 0) break;` treats that identically to "the archive ended here", so the route renders with 100 posts. ArchiveContent then prints "100 posts" as fact, paginate() computes totalPages = 10 instead of 25,
  hint: Separate the two: `if (batch === null) → throw (or mark the walk incomplete and skip the ISR write)`, `if (batch.length === 0) → break`. At minimum do not 404 pages past a total derived from an incomplete walk.
- [low] [F1-frontend-archives-media] frontend/src/app/(public)/author/[slug]/feed.xml/route.ts:5 — Stale comment: the author feed route still says the archive above it takes only a numeric id
  scenario: A maintainer reading this handler is told the two sibling routes disagree about the author identity, and that documentation/frontend.md records that mismatch. Both halves are now false — the archive accepts nicename OR id (that is the point of this batch's author route) and frontend.md's new archive table documents `/author/{nicename|id}`. The next person to 'fix' the mismatch will change working 
  hint: Rewrite the header to say both spellings reach both routes and the backend decides which exists.
- [low] [F1-frontend-archives-media] backend/src/routes/seo.ts:607 — Stale comment: the author feed says nothing populates user_nicename, which this same batch changed
  scenario: The comment justifies accepting user_login as an author identity on the grounds that the nicename column is never written. As of this batch User.create derives it (models/User.ts generateUniqueNicename) and migration 0015 backfills every pre-existing row, so the stated premise is gone while the code below it correctly implements the newer, narrower rule (login accepted only for a nicename-less row
  hint: Replace the first sentence with the current rule (nicename is written at creation and backfilled by 0015; login survives only for rows whose display name slugified to nothing).
- [medium] [F2-wxr-import] backend/src/core/wxr-media.ts:720 — The SVG refusal (and the whole magic-byte gate) keys off the DECLARED MIME, which the WXR also controls — `.svg` declared `text/plain` is stored unsanitized
  scenario: resolveStoredPath resolves the stored MIME as `declared && Media.isAllowedMimeType(declared) ? declared : byExtension`, and both REFUSED_IMPORT_MIMES and requiresSignature then test that resolved value — while express.static picks the served Content-Type from the EXTENSION. A WXR item with `_wp_attached_file = 2025/01/payload.svg` and `wp:post_mime_type = text/plain` therefore resolves to text/pla
  hint: Refuse when the declared MIME contradicts the extension's own mapping (byExtension), and apply REFUSED_IMPORT_MIMES/requiresSignature to `byExtension` as well as to the resolved value.
- [medium] [F2-wxr-import] backend/src/core/wxr-media.ts:585 — The rename map is populated whenever the URL's path differs from `_wp_attached_file`, not only when a file MOVED — so it rewrites unrelated in-content URLs
  scenario: `urlRelative` is derived from the attachment URL (its `/wp-content/uploads/` tail, else its BASENAME), while `relativePath` comes from `_wp_attached_file`. They differ routinely with no collision at all: an export whose files are served from a CDN or a custom upload dir gives urlRelative = `photo.jpg` and relativePath = `2025/01/photo.jpg`, so renames gets `photo.jpg -> 2025/01/photo.jpg` and rewr
  hint: Record a rename only when claimRelativePath actually disambiguated (compare against the path it was asked for), not against the URL-derived one; keep the URL-derived value out of the rewrite map entirely.
- [medium] [F2-wxr-import] backend/src/core/wxr-media.ts:665 — claimRelativePath -> renameSync is a TOCTOU across concurrent import runs: the second run overwrites the first's bytes
  scenario: claimedPaths is per-MediaImporter (in-memory) and the disk check is a bare existsSync at PLAN time, minutes before the download completes. Two import runs (two admins, or the same admin retrying a long import in a second tab) both call prepare()/planPlacements() before either has written a row or a file, so both find `2025/01/photo.jpg` free, both claim it, and both renameSync onto it. Node's rena
  hint: Publish with an exclusive create — write the temp file then `fs.linkSync(temp, dest)` (or open dest with 'wx') and treat EEXIST as "taken, re-disambiguate" — rather than an unconditional rename; or take a single-run import lock in routes/import.ts.
- [low] [F2-wxr-import] backend/src/core/wxr-import.ts:15 — Three comments/doc claims are now false: dedupe "then by slug", the budget counting "redirect hops", and _wp_attachment_metadata being what the WordJS exporter emits
  scenario: (a) wxr-import.ts:15 and documentation/wordpress-import.md:260 both say attachments are matched "by SOURCE URL, then by slug". There is no slug fallback anywhere in importAttachment — dedupe is `if (url) { existingIdFor(url) }` only, so a link-mode item whose WXR carries no `wp:attachment_url` creates a duplicate row on every re-run, and an operator reading the doc will believe re-runs are safe wh
  hint: Either add the slug fallback the header and the doc promise, or delete the claim from both; drop "redirect hops" from the budget comment (or count them); correct the safeAttachmentMetadata rationale.
- [medium] [F3-encode-budget-author-identity] backend/src/routes/media.ts:129 — The budget's 'step aside instead of draining' rationale preserves output that the only consumer discards, and a skipped upload is silently and permanently derivative-less
  scenario: Two contributors upload at once. Upload A holds both slots. Upload B's worker gets a slot as A's first encode finishes, produces `medium.webp`, loops, finds the budget full again and returns (media.ts:129). B commits with `sizes.medium.sources = { 'image/webp': ... }` and nothing else. buildSrcSet then sees a webp map whose widest entry (300) is below `fullWidth` and drops the format entirely — so
  hint: Either record a `modernPending`/`modernSkipped` marker on the attachment and add a regeneration path, or make the skip all-or-nothing per upload so the partial case cannot arise; at minimum correct the media.ts:117-127 rationale.
- [medium] [F3-encode-budget-author-identity] backend/src/routes/seo.ts:644 — The author RSS feed still falls back to user_login for the channel name, eight lines under a comment declaring that it never does
  scenario: A `users` row with `display_name = ''` (the column is `TEXT NOT NULL DEFAULT ''` in config/database.ts:362, so a plugin db-bridge write, a restored dump, or any direct insert produces one) and a nicename that migration 0015 could not derive. `GET /api/v1/seo/author/<id>/feed.xml` then emits `<title>` / channel name = `user.user_login` — the exact string the sign-in form takes — on an anonymous end
  hint: Drop `user.user_login` from the fallback chain at seo.ts:644 (use `display_name || canonical`, matching Post.getAuthorsForIds), and refresh the stale premise at seo.ts:607-608.
- [medium] [F3-encode-budget-author-identity] backend/src/core/schema-migrations.ts:790 — Migration 0015 swallows every error and is then recorded as applied, and no other code path in the product can write user_nicename — a failed backfill is unrecoverable
  scenario: An upgraded install boots while the DB is under contention (a lock timeout, a transient connection reset, a read-only replica). The `catch` at schema-migrations.ts:790 logs a warning and RESOLVES, so the runner at schema-migrations.ts:822-831 records '0015_backfill_user_nicename' in schema_migrations. The migration never runs again. Every pre-existing account keeps `user_nicename = ''` forever, so
  hint: Either make 0015 idempotent-and-retryable (record it only when it completed, or add a follow-up migration id), or add a nicename write path (User.update + PUT /users/:id with validation and a uniqueness check) so an operator can repair it. Also correct the 0015 comment block to state that a swallowe
- [medium] [F3-encode-budget-author-identity] backend/src/core/schema-migrations.ts:779 — Migration 0015 reads every users row into memory and issues one un-batched, un-transacted UPDATE per row, blocking boot
  scenario: A 100k-user install (a membership site, or any install that has run self-registration for a while) upgrades. `SELECT id, display_name, user_nicename FROM users ORDER BY id` with no LIMIT loads all 100k rows, then the loop issues up to 100k sequential `UPDATE users SET user_nicename = ? WHERE id = ?` round-trips — each its own implicit transaction on Postgres/MySQL, i.e. 100k commits with 100k fsyn
  hint: Page the SELECT with a keyset cursor (`WHERE user_nicename = '' AND id > ? ORDER BY id LIMIT 1000`) and wrap each page in one transaction; the deterministic taken-set can be rebuilt per page from a targeted `SELECT user_nicename WHERE user_nicename LIKE base||'%'`.
- [low] [F3-encode-budget-author-identity] backend/src/models/User.ts:68 — Two claims in the generateUniqueNicename doc block are false: nothing can change the column, and the WXR importer never passes a nicename
  scenario: A maintainer reads User.ts:68 ("now a real, separate column an admin can change instead of an invisible fallback nobody could") and User.ts:201 ("An explicit `nicename` wins (the WXR importer has one in hand, and an admin form could offer it)") and assumes an author can be re-slugged through the admin UI or that a WXR round-trip preserves source slugs. Neither is true, so a bad or numeric slug (se
  hint: Either add the write path the comment promises (User.update + PUT /users/:id with sanitizeTitle + a uniqueness check), or reword both comments to say the column is derive-only today.
- [low] [F3-encode-budget-author-identity] backend/scripts/generate-f2-contracts.ts:178 — The generated content contract documents the author slug as falling back to user_login — the one fallback this batch exists to remove
  scenario: A maintainer implementing a new client against ContentRecord reads the contract's own comment and concludes that `author.slug` may legitimately carry a login, and that re-introducing `OR user_login` in a reader is contract-compliant — which is precisely the enumeration Post.ts:286-294 and _authorCondition were rewritten to close. The comment is the authoritative one: it is the source that emits ba
  hint: Replace 'falling back to user_login' with 'falling back to the numeric user id' in both places.
- [medium] [F4-openapi-feeds-seo] backend/src/routes/seo.ts:644 — The author feed is an unauthenticated account-existence and display-name oracle for users with no posts
  scenario: GET /api/v1/seo/author/3/feed.xml with no credentials. The lookup at :617 resolves ANY users row - a subscriber, a moderator, an administrator who has never published - and :644 puts `user.display_name` into the channel title, so the response is a 200 carrying `<title>Sitio — Jane Roe</title>` with zero items. A non-existent id is a 404. Walking 1..N therefore yields the account count and the real
  hint: Answer feedNotFound when the resolved author has no published posts, mirroring the frontend archive's own rule - move the Post.findAll above the 404 decision and return 404 on an empty result.
- [medium] [F4-openapi-feeds-seo] backend/src/tests/seo.test.ts:515 — Both new robots.txt tests pass with the generateRobotsTxt fix fully reverted
  scenario: Revert seo-helper.ts:210 to `function generateRobotsTxt(siteUrl = '')` with `Sitemap: ${siteUrl}/sitemap.xml` (dropping the sitemapUrl parameter entirely). The extra argument at the call sites is then silently ignored by JS, and every assertion still passes: publicSeoUrl('https://example.test','sitemap.xml') returns exactly 'https://example.test/sitemap.xml', which is byte-identical to the old har
  hint: Make the assertion falsifiable: call generateRobotsTxt with a sitemapUrl that differs from `${siteUrl}/sitemap.xml` (e.g. the chunk-rewritten form, or a stub URL) and assert the emitted line is the supplied one, so a caller that ignores the argument goes red.
- [low] [F4-openapi-feeds-seo] backend/src/core/feeds.ts:392 — feeds.ts asserts 'there is no longer a straggler' - the straggler is one require() away
  scenario: A reader of feeds.ts:387-392 concludes that every generator printing an item URL escapes it and stops looking. The generator actually served for /sitemap.xml on a normal-sized site (seo-helper.ts generateSitemap) does not, as proved above. The mirrored claim in seo-helper.ts:276-278 ('generateSitemapUrlset escapes <loc> ... there is no straggler') is false in the same way and sits fifteen lines ab
  hint: Fix seo-helper.ts:161/:188 (finding 1) so the comments become true, rather than softening the comments.
- [low] [F4-openapi-feeds-seo] backend/src/routes/seo.ts:608 — 'nothing in WordJS populates that column yet' was made false by this same batch
  scenario: The comment is the stated justification for accepting user_login at all ('nothing in WordJS populates that column yet, so user_login is accepted as the same identity'). This batch adds models/User.ts generateUniqueNicename (called by User.create) and core/schema-migrations.ts migration 0015_backfill_user_nicename, both of which populate user_nicename for new and pre-existing accounts. The premise 
  hint: Restate the reason for the login fallback as what it now is - a compatibility path for a row whose display name slugifies to nothing, or a legacy row the migration could not fill - and drop the 'nothing populates it yet' premise.
- [low] [F4-openapi-feeds-seo] backend/src/routes/seo.ts:644 — 'The login is never an output' is contradicted by the line seven lines below it
  scenario: A users row whose display_name is empty (the column is `TEXT NOT NULL DEFAULT ''`, config/database.ts:363, and rows written by a plugin, a restored dump or a direct INSERT can leave it so - User.update at models/User.ts:346 uses a truthy guard and cannot blank it, but nothing enforces non-empty at the schema) makes the channel title fall through to `user.user_login`, publishing the account's sign-
  hint: Drop `user.user_login` from the fallback chain (`display_name || canonical`) so the comment and the code agree, or stop selecting user_login in the numeric branch at all.
- [low] [F4-openapi-feeds-seo] backend/src/core/seo-helper.ts:258 — The RSS channel-level <link> and atom:link href defaults are still unescaped while both sibling generators escape the same values
  scenario: generateRssFeed escapes options.link/options.selfUrl but deliberately leaves the DEFAULTS raw. /seo/feed.xml (routes/seo.ts:381) passes selfUrl but NOT link, so the site channel's `<link>` is always the unescaped `${siteUrl}/`. On a pre-install request the siteUrl falls back to `${req.protocol}://${req.get('host')}` (seo.ts:359), i.e. the Host header. The identical values in the twin generators ar
  hint: Escape the defaults too (escapeHtml is idempotent-safe for ordinary URLs) so the three RSS channels share one rule, and pass `link` from routes/seo.ts:381 for the site feed.
- [medium] [F5-plugin-review-trust] backend/scripts/marketplace-review.js:130 — reviewedContentSha256 excludes `dist/` on an invariant that does not hold: the packer ships `dist/` verbatim and the builder does not always regenerate it
  scenario: A reviewed outside plugin declares a Verso block (`manifest.frontend.versoComponents`) whose sources import no CSS, so esbuild never emits `dist/component.bundle.css`. The author force-adds one (`git add -f marketplace/plugins/<slug>/dist/component.bundle.css` — the path is gitignored by `**/dist/`, so it is tracked only because of `-f`). build-marketplace's `walk()` packs it into the zip; `plugin
  hint: Either hash `dist/` too after asserting it is reproducible (rebuild, then compare), or — cheaper and consistent with the header's reasoning — make the exclusion conditional: refuse any file under `dist/` that `build-plugin.js` did not just emit (it already knows the outfile list), so nothing unrepro
- [low] [F5-plugin-review-trust] backend/src/routes/marketplace.ts:167 — isOfficialSource treats percent-encoded traversal as part of the official path, so its negative control is narrower than the comment and test claim
  scenario: `isOfficialSource('https://github.com/jaimemartinez/wordjs/releases/..%2f..%2fsomeone/evil', false)` returns true (verified against the real exported function). The WHATWG URL parser collapses literal `..` and `%2e%2e` dot segments — which is what the test's traversal case exercises — but leaves `%2f` untouched, so the normalised pathname still begins with `/jaimemartinez/wordjs/releases/` and the
  hint: Reject a pathname containing `%2f`/`%5c` (case-insensitively) and reject a non-empty `u.search`/`u.hash` before the prefix test, and add both to the negative-control list in marketplace-catalog.test.ts alongside the existing `..` case.
- [low] [F5-plugin-review-trust] .github/CODEOWNERS:38 — CODEOWNERS omits the two files that implement the runtime and UI locks of the same badge, contradicting the criterion the file states for itself
  scenario: The header says the owned set is 'the code that decides what a ledger record MEANS ... A change here can hollow out the ledger without touching it.' Two files meet that criterion exactly and are not listed: backend/src/routes/marketplace.ts, whose `isOfficialSource` + `review: official ? e.review : { status: 'unreviewed' }` is the only thing stopping an arbitrary configured catalog from publishing
  hint: Add `/backend/src/routes/marketplace.ts`, `/frontend/src/app/admin/plugins/MarketplaceTab.tsx`, `/backend/scripts/build-marketplace.js` and the two test files that pin them to the owned list.
- [medium] [F6a-ci-docker-helm] docker-compose.yml:38 — `docker compose up -d -V` does not recreate NAMED volumes — the remedy the new comment prints is inert for the volumes the same commit just named
  scenario: An operator edits `WORDJS_DB_HOST` (or the jwtSecret, or a siteUrl) in `x-app-env`, reads the new warning directly above it, and runs `docker compose up -d -V` as instructed. `-V` / `--renew-anon-volumes` recreates ANONYMOUS volumes only; `app-data` and `app2-data` are now named volumes and Compose never recreates those on `up`. The container comes back around the same `/app/backend/data/wordjs-co
  hint: Drop the `-V` option from the note (or replace it with `docker compose down -v`, or `docker volume rm wordjs_app-data wordjs_app2-data`), and fix the parenthetical, which describes `-V` as recreating "anonymous/attached" volumes.
- [medium] [F6a-ci-docker-helm] backend/src/tests/f6-performance-budget.test.ts:246 — The twin of the cache.ts flake was left behind and made load-bearing: perf-calibrate depends on an async `process.stdout.write` from inside a node:test child's `before` hook
  scenario: cache.ts:117-136 (this batch) establishes the rule with measurements: "An asynchronous write into the same stream can land INSIDE a frame" and "The same reasoning applies to any future ASYNCHRONOUS log in this module." The new perf job then does exactly that, on purpose: `perf-calibrate.mjs` spawns the harness with `WORDJS_F6_PERF_PRINT: '1'`, whose only effect is a `process.stdout.write(JSON.stri
  hint: Emit the measurement on a channel that is not the runner's report pipe — stderr (mirroring the cache.ts fix) or a file path passed in via an env var — and have `extractRun` read that instead of the TAP stdout; or, at minimum, make the measure-mode arm exit 0 on a lost measurement and say so, so the 
- [low] [F6a-ci-docker-helm] docker/entrypoint.sh:62 — The `[ -L "$CONFIG" ]` assertion added after `ln -s` is unreachable — it cannot fail for either way `ln -s` misbehaves
  scenario: The comment says the assertion exists because "`ln -s` into anything unexpected would have exited 0 above". But the only documented such case — `$CONFIG` being a directory, so `ln -s TARGET DIR` silently creates `DIR/wordjs-config.json` — is already caught eight lines earlier by the `if [ -d "$CONFIG" ]` arm, which exits 1 before this branch is reachable. Every other way `ln -s` can go wrong (targ
  hint: Either drop the assertion, or make it earn its place by covering the case `set -e` hides badly: trap the `ln -s` failure explicitly (`ln -s … || { echo "[entrypoint] FATAL: cannot create $CONFIG (is /app/backend writable by uid 1001?)" >&2; exit 1; }`) so a permission failure produces a diagnosable 
- [medium] [F6b-logging-secrets] backend/src/core/logger.ts:5 — An isolated plugin's forwarded stdout bypasses the bridge entirely, breaking the one-JSON-object-per-line contract the file header asserts
  scenario: Install any isolated plugin that prints. Its output is relayed by attachLogLimiter with `out.write(TAG + line)` straight onto process.stdout/process.stderr, so the stdout stream an operator ships to Loki/ELK is JSON objects interleaved with raw `[plugin foo] ...` text lines. A strict JSON-per-line parser drops or quarantines them; they carry no level, no timestamp, no requestId, and — the part tha
  hint: Either route the relay through `getRequestLogger().info({ plugin: slug, legacy: true }, line)` (which also gets it scrubbed and gives operators a `plugin` label), or correct the header comment and add a note to observability.md saying plugin stdout is passed through raw.
- [medium] [F6b-logging-secrets] backend/src/index.ts:1588 — The admin-password print gate — including its fail-open branch — has zero test coverage; reverting it breaks nothing
  scenario: Change `const showPassword = !pwFileWritten || require('./core/install-token').shouldPrintBootstrapSecret();` back to `const showPassword = true;` and the whole suite still goes green: the generated bootstrap administrator password is printed on every headless boot again, which is precisely the finding this batch claims to close, and CI cannot tell. The `!pwFileWritten` fail-open path (print the p
  hint: Extract the banner text into a small pure function (e.g. `bootstrapAdminBanner({ password, pwFile, pwFileWritten, env, stream })`) in core/install-token.ts and assert both branches, including that a failed file write still prints. That is the same refactor that made the install banner testable two f
- [medium] [F6b-logging-secrets] backend/src/middleware/request-context.ts:95 — trustProxyConfigured() is a coarse boolean and does not gate X-Request-Id the way Express gates X-Forwarded-For; the shipped default trusts it in every non-embedded deployment
  scenario: Two concrete cases. (a) An operator sets `trustProxy: "10.0.0.0/8"` for their edge. Express uses that list to decide WHICH hop's X-Forwarded-For it believes; request-context only asks 'is anything trusted at all' and then honours a client-chosen X-Request-Id from ANY peer, including one outside 10.0.0.0/8. (b) Split/separate mode: `resolveTrustProxy()` returns 1 whenever WORDJS_EMBEDDED !== '1' (c
  hint: Honour the incoming id only when Express itself believed the hop — i.e. gate on `req.ip !== req.socket.remoteAddress` (a proxy was actually resolved) rather than on the coarse boolean — or document that the id is only as trustworthy as the edge and require the edge to overwrite it (add `proxy_set_he
- [medium] [F6b-logging-secrets] backend/src/core/logger.ts:206 — nodeEnv === 'test' silently discards every pino line, including in a production process where NODE_ENV=test is a misconfiguration rather than a test run
  scenario: A deployment that exports NODE_ENV=test (common enough — staging environments, a stray value in a systemd unit or Helm values). config.nodeEnv is `process.env.NODE_ENV || fileConfig.nodeEnv || 'production'` (config/app.ts:336), so `underTestRunner()` is true, `baseStream` becomes `{ write(): void {} }`, and every line the logger produces is dropped on the floor forever — the access line above all,
  hint: Gate the destination on NODE_TEST_CONTEXT alone (the comment at index.ts:26-28 already says that is the check that actually fires), or keep the NODE_ENV check but emit one warn line to fd 2 at boot saying the log destination is silenced.
- [medium] [F6b-logging-secrets] backend/src/core/logger.ts:143 — Bounded quantifiers are not the same as cheap: scrubSecrets costs ~5 microseconds per character, so a 1 MB console line blocks the event loop for ~5 seconds
  scenario: Any bridged console line that grows large — a WXR import dumping a parse tree, an error whose `message` carries a payload, a future migration that logs a diff. Measured on this machine with the real pattern: 1 MB of 'csrf' -> 5751 ms, 1 MB of 'token' -> 5025 ms, 1 MB of 'secret' -> 3858 ms, 1 MB of 'a' (no credential word at all) -> 407 ms, 64 KB of 'password' -> 199 ms. Those are synchronous, on 
  hint: Cap the input: `if (text.length > 16384) return scrubSecrets(text.slice(0, 16384)) + '…[truncated]'`, or scrub line by line with an early `indexOf` prefilter for the credential words before running the regex at all. Then correct the comment to say what the bound actually buys.
- [low] [F6b-logging-secrets] backend/src/core/logger.ts:181 — pino-pretty is not a dependency anywhere, so the development pretty-print path is dead code and the comment that describes it is false
  scenario: A developer runs the backend with NODE_ENV=development. `require.resolve('pino-pretty')` throws, prettyStream() returns undefined, baseStream falls through to pino.destination, and every existing console.log in the codebase now prints as a raw JSON object instead of the readable text it printed before this change. The comment tells the next reader the package is a declared devDependency that `npm 
  hint: Reword the comment to match observability.md (it is not a dependency at all, install it yourself), or add it to devDependencies so the claim becomes true.
- [low] [F6b-logging-secrets] backend/src/core/logger.ts:208 — console.error and console.warn now write to fd 1, not fd 2
  scenario: An operator running `node dist/index.js > app.log 2> app.err`, or a systemd unit with `StandardOutput=journal` / `StandardError=file:...`, or any CI step that surfaces stderr as an annotation. After this change `app.err` is empty: the crash line from index.ts:1821 ('Uncaught Exception'), the SIGTERM line, and every console.warn/error in the backend go to the single pino destination on fd 1. Nothin
  hint: One sentence in the console-bridge section of observability.md: warn/error no longer go to fd 2, everything is on stdout and the `level` field carries the severity.
- [medium] [F7-comments-audit-notices] backend/src/routes/comments.ts:269 — The discard memory is per-process while its honest twin is DB-backed, so the 201/201-vs-201/409 oracle is fully restored on any multi-replica deployment
  scenario: Two backend replicas behind a load balancer (the shape this repo already ships a docker-compose and a shared-Redis limiter store for). A bot posts the same body twice with `_hp` filled and the two requests land on different replicas: replica A remembers the discard in its own Map, replica B has never seen it, isDuplicateComment finds no row because nothing was ever stored, and the second request a
  hint: Store the discard marker in the shared limiter store (a SETEX of the sha256 key with DUPLICATE_WINDOW_MS) and fall back to the in-process Map when no client is configured — the same degrade-to-local pattern login-throttle.ts already uses.
- [medium] [F7-comments-audit-notices] backend/src/core/audit.ts:121 — sanitizeDetail's new 'small' guarantee still permits roughly half a megabyte per audit row, and the test only proves it for a benign input
  scenario: A future call site (the bounds are explicitly sold as holding 'for a call site that does not exist yet', audit.ts:104-107) passes detail = 32 keys, each an array of 64 strings of 100 kB. Every filter passes: boundString cuts each string to 512 chars plus a marker (~527), boundArray keeps 32 elements plus a marker (33), and the key cap allows 32 keys. Stored blob = 32 x 33 x 527 characters, about 5
  hint: Add a total-serialized-length cap (truncate keys until JSON.stringify(out).length fits, with the same _truncated marker) and make the test assert it against a worst-case fixture — 32 keys x 32 long strings — instead of a benign one.
- [low] [F7-comments-audit-notices] backend/src/core/audit.ts:159 — The _truncated marker shares the caller's key namespace, so a real key of that name is silently overwritten or a fake marker is stored verbatim
  scenario: Two directions, both wrong. (a) A caller passes detail = {_truncated: 'the rollback was truncated', ...34 other keys}: '_truncated' does not match SECRET_KEY_RE, so it is stored at audit.ts:157, and then audit.ts:159 overwrites it with '2 more key(s) dropped'. The caller's field is gone from the security log with no trace that it ever existed. (b) A caller passes detail = {_truncated: '9 more key(
  hint: Reserve the name: skip any incoming key equal to TRUNCATED_KEYS_MARKER inside the loop (counting it as dropped), so the marker can only ever be written by sanitizeDetail itself.
- [medium] [F7-comments-audit-notices] backend/src/routes/auth.ts:740 — A password typed into the username box is still persisted verbatim, in the login-throttle keys the same handler builds three lines above the digest
  scenario: The finding this fix closes is 'a credential in the wrong box must not be persisted where an administrator can read it'. The audit row is now a digest — but the very same request writes the raw string into the throttle key space: lockBucket('login', username) returns `login:<raw identifier>` when the identifier names no account, and that key is used verbatim as a Redis key by core/login-throttle.t
  hint: Key the throttle on attemptDigest(identifier) for the unknown-account case (the bucket only needs to be stable and distinct, never reversible), or at minimum bound the subject the way auditText bounds the detail.
- [low] [F7-comments-audit-notices] backend/src/routes/notices.ts:90 — The 503's promise that the dismissal 'is queued' is false: the pending queue is drained only once, at database init
  scenario: An administrator gets the new 503 on DELETE /notices/:id. The swagger the same commit adds says 'The dismissal is queued and the request is safe to repeat.' The first half is untrue: clearAdminNotice -> applyOp stored the op in the module-level `pending` Map (admin-notices.ts:207), and the only production caller of flushPendingAdminNotices() is config/database.ts:610, which ran at boot and will no
  hint: Either drop the word 'queued' from the 503 description, or have applyOp skip the pending queue for request-driven ops (pass a flag) so an admin-triggered clear is not retained at all.
- [low] [F7-comments-audit-notices] backend/src/routes/auth.ts:63 — attemptDigest keys on a secret that is regenerated per process when none is configured, so the enumeration signal the digest exists for can be lost
  scenario: On an install with no configured jwtSecret, config/app.ts:239-241 mints EPHEMERAL_JWT_SECRET with crypto.randomBytes per process and config/app.ts:345 uses it as config.jwt.secret. Every restart, and every replica of a multi-node install, then produces a DIFFERENT digest for the same attempted identifier — so the row cannot answer 'is the same unknown identifier being tried a thousand times?', whi
  hint: Derive the digest key from a dedicated, persisted salt option (created once and stored) rather than from jwt.secret, or state the ephemeral-secret caveat in the comment.

## First pass — full list as reported (run wf_16daf408; the must-fix subset is already closed)

- [high] [archives-feeds-seo] frontend/src/lib/public/archives.ts:35 — 
  scenario: 
  hint: Stop fetching-then-narrowing now that the filter is real (see the next finding). Replace getAllPublishedPosts+filterPostsByTerm/ByAuthor with one paged request per archive: `/posts?categories=<slug>&status=publish&per_page=<postsPerPage>&page=<n>&orderby=date&order=desc` (and `?author=<slug|id>` for
- [high] [archives-feeds-seo] frontend/src/lib/public/archives.ts:10 — 
  scenario: 
  hint: Delete the claim and its three copies, and rewrite the header to describe what the module now does. Update taxonomy/[taxonomy]/[term]/[[...paged]]/page.tsx:32-36: gap (2) 'NO POST->TERM RELATION' is now only about SERIALIZED_TAXONOMIES, not about the filter — `?categories=` is no longer 'the answer 
- [high] [archives-feeds-seo] frontend/src/app/(public)/author/[slug]/[[...paged]]/page.tsx:14 — 
  scenario: 
  hint: Accept both spellings in resolveRoute: keep parseAuthorId for the all-digits case, and for a non-numeric segment match `postAuthorSlug(post) === slug` against the fetched posts (or, with the previous finding applied, pass the segment straight through as `?author=<slug>`, which posts.ts already split
- [medium] [archives-feeds-seo] frontend/src/app/(public)/__tests__/archiveRoutes.test.tsx:29 — 
  scenario: 
  hint: Change the POSTS fixture to the shape the model now emits, e.g. `author: { id: 3, displayName: 'Jane Roe', slug: 'jane-roe' }`, keep ONE post with a bare number to pin the back-compat branch of postAuthorId (archives.ts:222-232), and update the title assertion at line 263 to the display name. Correc
- [medium] [archives-feeds-seo] frontend/src/app/(public)/author/[slug]/[[...paged]]/page.tsx:61 — 
  scenario: 
  hint: Set `feedPath: `/author/${authorId}/feed.xml`` in the returned spec (or the slug spelling once the previous finding is applied). Add an assertion alongside the existing category one that the author archive's metadata advertises a feed URL the author feed route can answer, the same shape as the test 
- [medium] [archives-feeds-seo] backend/src/core/seo-helper.ts:273 — 
  scenario: 
  hint: Wrap both: `<link>${escapeHtml(url)}</link>` and `<guid isPermaLink="true">${escapeHtml(url)}</guid>` in seo-helper.ts:273-274. escapeHtml is already imported in scope. Add a case to backend/src/tests/seo.test.ts with a slug containing '&' and assert the RSS body parses, mirroring whatever asserts t
- [low] [archives-feeds-seo] frontend/src/app/(public)/category/[slug]/[[...paged]]/page.tsx:68 — 
  scenario: 
  hint: Replace the two lines with a pointer to the route that serves it, e.g. 'The scoped RSS channel, served at this public URL by category/[slug]/feed.xml/route.ts — see taxonomyFeedPath.'
- [low] [archives-feeds-seo] frontend/src/lib/public/archives.ts:234 — 
  scenario: 
  hint: Update all three comments to say the API now sends the object and that the number branch is retained for cached/legacy payloads and imported rows. Keep the dual-shape reading in postAuthorId — it is correct defensive code, only its rationale is out of date.
- [low] [archives-feeds-seo] backend/src/routes/seo.ts:485 — 
  scenario: 
  hint: Use the resolved values: in sendTermFeed pass `link: `${channel.siteUrl}/${prefix}/${term.slug}`` and `selfPath: `/${prefix}/${term.slug}/feed.xml``; in the author route use `user.user_nicename || user.user_login` in place of the raw `slug` at lines 591-592.
- [low] [archives-feeds-seo] frontend/src/components/public/ArchiveContent.tsx:158 — 
  scenario: 
  hint: Either format from the date string the way postYearMonth does, or reuse the existing LocalizedDate client island (listed in documentation/frontend.md among the hydrating islands) which renders the visitor's locale on the client. If the copy-the-blog-roll constraint wins, say so in a comment here so 
- [high] [posts-filters-author-contract] frontend/src/lib/server-api.ts:545 — 
  scenario: 
  hint: Use a CONSTANT page size for the whole walk and trim at the end: `const size = Math.min(API_MAX_PER_PAGE, wanted);` hoisted out of the loop, keep `page` incrementing, and `return out.slice(0, wanted);` at line 556. (This is exactly what getAllPublishedPosts in frontend/src/lib/public/archives.ts:76-
- [high] [posts-filters-author-contract] frontend/src/app/(public)/__tests__/homePageResolvedBlocks.test.tsx:171 — 
  scenario: 
  hint: Assert the RESULT, not the URLs: `const posts = await actual.getPosts('post','publish'); expect(posts.map(p=>p.id)).toEqual(Array.from({length:150},(_,i)=>i+1));` and `expect(new Set(posts.map(p=>p.id)).size).toBe(150);`. Keep a URL assertion only for the per_page=25 single-page case.
- [high] [posts-filters-author-contract] backend/src/models/Post.ts:304 — 
  scenario: 
  hint: Stop falling back to `user_login` for a PUBLIC identity. Populate `user_nicename` at user creation (slugify display_name, de-duplicated) in User.create (backend/src/models/User.ts:160-162) and in the WXR importer, then emit `slug: nicename` and `displayName: row.display_name` only, with `slug: Strin
- [high] [posts-filters-author-contract] documentation/frontend.md:91 — 
  scenario: 
  hint: Rewrite documentation/frontend.md:91 and the archives.ts header (line 9-18) to state that the backend filters, and change getAllPublishedPosts/filterPostsByTerm callers to issue `GET /posts?categories=<slug>&per_page=<n>&page=<n>` (and `?tags=`, `?author=`) and read X-WP-Total for the page count, in
- [medium] [posts-filters-author-contract] frontend/src/app/(public)/author/[slug]/[[...paged]]/page.tsx:14 — 
  scenario: 
  hint: Accept both spellings in resolveRoute: keep parseAuthorId for the all-digits case and otherwise narrow on `postAuthorSlug(post) === slug` (add a `postAuthorSlug` reader beside postAuthorId in archives.ts), or fetch `GET /posts?author=<segment>` directly now that the backend resolves it. Then delete 
- [medium] [posts-filters-author-contract] frontend/src/lib/public/archives.ts:216 — 
  scenario: 
  hint: Update both doc blocks to say the API sends `{ id, displayName, slug }` (Post.ts:388-397) and that the number branch is retained only for responses cached before the change; drop the hard line references or point them at the function name.
- [low] [posts-filters-author-contract] backend/src/models/Post.ts:293 — 
  scenario: 
  hint: Wrap getAuthorsForIds' misses in the same `cache` helper the row uses (`author:id:<n>`, short TTL, invalidated alongside the user write paths in models/User.ts update/delete), so a warm single-post read costs no SQL again. The list path is already batched and unaffected.
- [high] [plugin-review-programme] .github/workflows/plugin-review.yml:31 — 
  scenario: 
  hint: Two changes. (1) Add `.github/CODEOWNERS` with `/marketplace/reviews.json @<maintainers-team>` and require code-owner review on the protected branch. (2) Add a step to plugin-review.yml, before the checks, that refuses the combination outright: `if git diff --name-only "$BASE_SHA" "$HEAD_SHA" -- mar
- [high] [plugin-review-programme] backend/scripts/scan-plugin.mjs:211 — 
  scenario: 
  hint: In verify-marketplace.js verifyReview(), add the symmetric check next to the reviewed one: `if (got.status === 'first-party' && !isFirstPartyAuthor(meta.author)) fail(`${label}: marketplace/reviews.json records "first-party" but manifest author is "${meta.author}" — first-party means authored by the
- [high] [plugin-review-programme] frontend/src/app/admin/plugins/MarketplaceTab.tsx:36 — 
  scenario: 
  hint: Downgrade the claim to the official catalog. Backend: in routes/marketplace.ts, when `s.url !== DEFAULT_REMOTE` and the source is not the repo-local dist, strip or rewrite the field — `merged.push({ ...e, review: isOfficial ? e.review : { status: 'unreviewed' }, source: s.url })`. Frontend: belt-and
- [medium] [plugin-review-programme] .github/workflows/plugin-review.yml:109 — 
  scenario: 
  hint: Widen the slug set to cover ledger edits: after computing `slugs` from the plugins diff, if `git diff --name-only "$BASE_SHA" "$HEAD_SHA" -- marketplace/reviews.json` is non-empty, union in the slugs whose ledger record changed (or simply `ls marketplace/plugins` when the ledger moved at all), so in
- [medium] [plugin-review-programme] backend/scripts/scan-plugin.mjs:58 — 
  scenario: 
  hint: Tighten both alternatives. Hosts: require a real hostname shape and exclude file extensions — e.g. `/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|co|edu|gov|[a-z]{2})\b/i` with a negative list for `md|js|json|ts|tsx|txt|zip`. Runtime destinations: match a PHRASE, not a bare adjectiv
- [medium] [plugin-review-programme] marketplace/reviews.json:1 — 
  scenario: 
  hint: Add a required `reviewedVersion` to a `reviewed` record: validate it as semver in marketplace-review.js readLedger() alongside `date`, and in verify-marketplace.js verifyReview() fail when `major(meta.version) !== major(record.reviewedVersion)` with the same wording as the permission failure. Publis
- [medium] [plugin-review-programme] frontend/src/app/admin/plugins/MarketplaceTab.tsx:41 — 
  scenario: 
  hint: Set `label: "Reviewed"` (the tooltip already carries reviewer and date). If "sandboxed" is worth showing, show it as a separate pill on EVERY entry, which is what the policy actually claims. The frontend test's expected string in plugins.test.ts needs the same edit.
- [medium] [plugin-review-programme] marketplace/REVIEW.md:87 — 
  scenario: 
  hint: Either make the claim true — add a step to plugin-review.yml (or a matrix job) that installs the submitted package and calls `loadIsolatedPlugin` on Linux/macOS/Windows, asserting it loads confined — or rewrite §3.3 to what is actually enforced: "the sandbox this plugin will run inside is certified 
- [low] [plugin-review-programme] marketplace/REVIEW.md:271 — 
  scenario: 
  hint: Drop the clause in all three places and give the full URL instead: `https://github.com/<org>/wordjs/compare?template=plugin-submission.md`. Optionally link that URL from CONTRIBUTING.md and from the default PR template so it is one click.
- [low] [plugin-review-programme] backend/scripts/marketplace-review.js:148 — 
  scenario: 
  hint: Emit them only where they mean something: `if (record.status === 'reviewed') { if (record.reviewer) out.reviewer = …; if (record.date) out.date = …; }`, leaving `notes` unconditional. Or reject them in readLedger for a non-reviewed record. Either way the catalog then cannot carry a review attribute 
- [high] [ci-docker-deploy-dependabot] .github/workflows/ci.yml:1185 — 
  scenario: 
  hint: On push/pull_request run the harness in measure-only mode and upload the artifact — drop `--enforce` from line 1185 (the script already prints the table and writes perf-calibration.json without it). Re-add `--enforce` in the same commit that lands the Linux `performanceBudget` block, and only then m
- [high] [ci-docker-deploy-dependabot] .github/workflows/release.yml:251 — 
  scenario: 
  hint: Resolve both SHAs before merge — `gh api repos/anchore/sbom-action/git/ref/tags/v0.24.0` and `gh api repos/softprops/action-gh-release/git/ref/tags/v3.0.2` — and correct whichever label is wrong. If the anchore SHA moved because the upstream v0.24.0 tag was repointed, say so in the comment rather th
- [high] [ci-docker-deploy-dependabot] .github/workflows/plugin-review.yml:120 — 
  scenario: 
  hint: Split the trigger from the scope. Compute a second output, e.g. `ledger_changed`, from `git diff --name-only "$BASE_SHA" "$HEAD_SHA" -- marketplace/reviews.json`, and gate the install/build/`verify-marketplace` steps on `steps.changed.outputs.slugs != '' || steps.changed.outputs.ledger_changed == 't
- [medium] [ci-docker-deploy-dependabot] .github/workflows/ci.yml:998 — 
  scenario: 
  hint: Use `cache-to: type=gha,mode=max` so intermediate stages are exported, or delete the cache-from/cache-to pair and the claims about it and budget the job honestly as always-cold. If `mode=min` is kept deliberately (GHA cache is 10 GB per repo and this image is ~2.6 GB), say so on that line and correc
- [medium] [ci-docker-deploy-dependabot] docker/entrypoint.sh:42 — 
  scenario: 
  hint: Add an explicit directory arm before the symlink is created: `elif [ -d "$CONFIG" ]; then echo "[entrypoint] FATAL: $CONFIG is a directory — a bind mount was pointed at a host path that does not exist. Remove the mount or create the file first." >&2; exit 1`. Alternatively use `ln -sfn` and test the
- [medium] [ci-docker-deploy-dependabot] docker-compose.yml:33 — 
  scenario: 
  hint: Give both services a named data volume (`- app-data:/app/backend/data`, `- app2-data:/app/backend/data`) so the state is visible and removable, and add one line to this file and to docker/README.md: after changing any `x-app-env` value, re-up with `docker compose up -d -V` (or `down -v`) or the old 
- [medium] [ci-docker-deploy-dependabot] deploy/helm/wordjs/Chart.yaml:8 — 
  scenario: 
  hint: Set `appVersion: "2.1.0"` and update the two `2.0.0` occurrences in the documentation/deployment.md Kubernetes example. Then add the default-tag path to the CI assertion list so it cannot rot again: render once WITHOUT `--set image.tag` and `grep -qF "image: \"example/wordjs:$(grep '^appVersion:' de
- [medium] [ci-docker-deploy-dependabot] backend/scripts/perf-calibrate.mjs:96 — 
  scenario: 
  hint: Resolve on `'close'` instead of `'exit'` and capture the code from it: `child.on('close', (code) => resolve({ run: extractRun(stdout), harnessOk: code === 0, stdout, stderr }))`. Keep the `'error'` handler as it is.
- [medium] [ci-docker-deploy-dependabot] .github/workflows/dependency-audit.yml:135 — 
  scenario: 
  hint: Pin the pair to the same major (`download-artifact@v7` alongside `upload-artifact@v7`) unless the v8 release notes explicitly document reading v7 artifacts. Independently, make the silence detectable: after the download step, if `steps.<id>.outcome == 'failure'`, put "the marker download itself fail
- [medium] [ci-docker-deploy-dependabot] .github/workflows/ci.yml:974 — 
  scenario: 
  hint: Add `'kind: Secret'` and `'name: wordjs-install-token'` to the `for want in …` list at lines 968-976. Better still, assert the pairing rather than the parts: render once with `installToken.value` set and confirm the `secretKeyRef.name` in the Deployment appears as a `metadata.name` on a Secret in th
- [low] [ci-docker-deploy-dependabot] frontend/vitest.config.mts:39 — 
  scenario: 
  hint: Scope the include to source: `include: ['src/**/*.{ts,tsx}']`. The existing `exclude` list stays as-is; re-measure once and, if the number moves, re-record it in the threshold comment at line 70 rather than leaving a stale measurement beside a new denominator.
- [low] [ci-docker-deploy-dependabot] .github/workflows/ci.yml:1117 — 
  scenario: 
  hint: Use `docker rm -fv wordjs-ci`. For the trigger, either add a `paths:` filter to the job's inputs (Dockerfile, docker/**, deploy/**, backend/**, frontend/**, gateway/**, scripts/**) via a `dorny/paths-filter`-style gate job, or state on the job why it must run unconditionally so the choice is visible
- [low] [ci-docker-deploy-dependabot] documentation/deployment.md:277 — 
  scenario: 
  hint: Add one line to the Volumes row and to deploy/compose/README.md: bind mounts must be pre-created and chowned to 1001:1001 on the host (`mkdir -p wordjs-data && sudo chown 1001:1001 wordjs-data`), or use named volumes, which the image seeds with the right ownership automatically.
- [low] [ci-docker-deploy-dependabot] .github/workflows/codeql.yml:41 — 
  scenario: 
  hint: Before merge, run the CodeQL workflow once on this branch and diff the alert count and rule ids against the last v3 run; if `security-and-quality` or the filter syntax moved in v4, fix the config in this batch rather than discovering it as a quiet gap. Record the check in the CHANGELOG entry for the
- [high] [media-wxr] backend/src/core/wxr-media.ts:337 — 
  scenario: 
  hint: Add `'_wxr_source_url'` and `'_wxr_menu_item_id'` to `PROTECTED_POST_META` in backend/src/core/protected-meta.ts (they are core-owned writes, so wxr-media/wxr-menus keep writing them directly — same exemption `_wp_attached_file` already has via ATTACHMENT_OWNED_META), and add both to the importer's 
- [high] [media-wxr] backend/src/core/wxr-media.ts:485 — 
  scenario: 
  hint: Before writing, refuse or de-duplicate a path that already exists: in `resolveStoredPath`, if `fs.existsSync(absolutePath)` and no `_wxr_source_url` row already owns it, append a disambiguating suffix to the stem (`name-1.jpg`, `name-2.jpg`, as WordPress itself does) and use the new relative path fo
- [high] [media-wxr] frontend/src/app/admin/import/page.tsx:155 — 
  scenario: 
  hint: Update frontend/src/app/admin/import/page.tsx: rename the toggle to 'Import media', change the hint to say the files ARE downloaded from the old site (with the size caps), and render `summary.media` (downloaded/failed/bytes + the `failures` list) and `summary.menus` in the results panel. Then make d
- [high] [media-wxr] frontend/src/lib/imageSrcset.ts:172 — 
  scenario: 
  hint: In `ImageBlock` (blocks.tsx:923), only emit a `<source>` for a format whose widest candidate is >= the widest candidate of the original-format `srcSet`; otherwise drop that format. Equivalently, have `buildSrcSet` omit a `modern[type]` whose max width is below `max(byWidth.keys())`, or append the or
- [high] [media-wxr] backend/src/routes/media.ts:63 — 
  scenario: 
  hint: Hoist the budget to module scope in routes/media.ts: a module-level `let activeModernEncodes = 0` (or reuse a small shared semaphore module with image-negotiation) checked and incremented inside `encodeModernDerivatives`'s worker loop, so the cap is global. Over budget, skip the encode and let the u
- [high] [media-wxr] documentation/wordpress-import.md:166 — 
  scenario: 
  hint: Either make link mode work — store the remote URL under a dedicated meta key and have `formatAttachment` prefer it (only normalizing an absolute guid whose host matches `config.site.url`) — or, if link mode is not to be supported, remove it from the `media` option and from the documentation table ra
- [medium] [media-wxr] backend/src/core/wxr-media.ts:466 — 
  scenario: 
  hint: Count every byte read, not just stored ones: add the running total to the `res.on('data')` handler's own check (`if (this.stats.bytes + total > settings.maxTotalBytes) { res.destroy(); reject(...) }`) and increment `stats.bytes` by `body.length` as soon as the download completes, before the verifica
- [medium] [media-wxr] backend/src/core/wxr-media.ts:490 — 
  scenario: 
  hint: Wrap the write so a failed `createRecord` unlinks what it wrote: capture whether the file existed before `writeFileSync`, and in the `if (typeof created === 'string')` branch `try { if (!preexisting) fs.unlinkSync(placed.absolutePath); } catch {}` before returning `this.fail(...)`. (Or write to a te
- [low] [media-wxr] backend/src/core/wxr-import.ts:664 — 
  scenario: 
  hint: Apply the rewrite inside `sanitizeImportedMeta` for `_puck_data` (walk the parsed tree's string leaves through `rewriteUploadUrls` before re-stringifying — the walker is already there for sanitization), or at minimum state the exclusion in documentation/wordpress-import.md's 'URL rewriting' section 
- [low] [media-wxr] frontend/src/lib/__tests__/imageSrcset.test.ts:175 — 
  scenario: 
  hint: Either drop the vacuous comparison, or make it meaningful by pinning the expected markup as a literal string snapshot captured from the pre-change renderer, so a future change to the `<img>` branch actually breaks the test.
- [low] [media-wxr] CHANGELOG.md:42 — 
  scenario: 
  hint: Narrow the CHANGELOG entry to match frontend.md: '…every JPEG/PNG/still-GIF upload gets WebP (and AVIF where sharp can encode it) derivatives beside the size ladder, and the Image block renders `<picture>` with them.'
- [high] [observability] backend/src/core/logger.ts:204 — 
  scenario: 
  hint: Two parts. (a) Stop the leak at the source: change install-token.ts:132/:134 to print the install URL only (or gate the bare token behind `process.env.WORDJS_PRINT_INSTALL_TOKEN`), drop the value at index.ts:1576, and reduce cert-manager.ts:195 to the order id. (b) Stop overclaiming and add a messag
- [high] [observability] backend/src/middleware/request-context.ts:63 — 
  scenario: 
  hint: Gate the honour on the trust-proxy posture, not just the grammar. In request-context.ts add `const { clientIp, trustProxyConfigured } = require('../core/client-ip');` and change line 63 to `const requestId = (trustProxyConfigured() && REQUEST_ID_PATTERN.test(incoming)) ? incoming : randomUUID();`. U
- [medium] [observability] backend/src/middleware/request-context.ts:73 — 
  scenario: 
  hint: Record on whichever of the two fires first. In request-context.ts wrap the body of the finish handler in a `let logged = false; const emit = () => { if (logged) return; logged = true; … }`, register it on both `res.on('finish', emit)` and `res.on('close', emit)`, and add `aborted: !res.writableFinis
- [medium] [observability] backend/src/core/logger.ts:68 — 
  scenario: 
  hint: Replace the exact-name entries with pino's censor-by-shape and widen the list: add `'*.jwtSecret','*.dbPassword','*.accessToken','*.refreshToken','*.apiKey','*.privateKey','*.password_hash','*.secret_enc','*.totpSecret'` and their bare forms, add `'headers["x-csrf-token"]'` and `'headers["x-install-
- [medium] [observability] backend/src/middleware/request-context.ts:48 — 
  scenario: 
  hint: Cap it the way metrics.ts already does: in `pathOf`, `return (cut === -1 ? raw : raw.slice(0, cut)).slice(0, 512);` and add a `pathTruncated: true` field when the slice bit, so an operator can tell a truncated path from a real one. Consider also mounting a cheap root-level limiter for the unmatched 
- [low] [observability] backend/src/config/app.ts:385 — 
  scenario: 
  hint: Make the config field agree with the documented and implemented order: `level: String(process.env.LOG_LEVEL || fileConfig.logging?.level || 'info')` at config/app.ts:385, and drop the now-redundant env read from logger.ts's `resolveLevel` (or keep it, it becomes a no-op) so there is one precedence r
- [low] [observability] backend/src/core/logger.ts:219 — 
  scenario: 
  hint: Make the comment true rather than deleting the function: add `consoleBridge: require('../core/logger').consoleBridgeInstalled()` to the admin health report in routes/health.ts's `withDegradationFields` (alongside `database.degraded` and `sandbox.cpu`, which exist for the same reason), and assert it 
- [low] [observability] backend/src/core/logger.ts:116 — 
  scenario: 
  hint: Forward the two methods: add `flush(cb){ return baseStream.flush ? baseStream.flush(cb) : (cb && cb()); }, flushSync(){ return baseStream.flushSync && baseStream.flushSync(); }` to the teeStream object at logger.ts:116, and note in the file header that the destination is asynchronous and `logger.flu
- [low] [observability] documentation/observability.md:231 — 
  scenario: 
  hint: Correct the sentence to say `unmatched` covers every response that never reached a route handler — static files, proxied requests, guard and limiter rejections, and 404s — and add a note that per-endpoint drill-down should filter `route!="unmatched"`. Optionally distinguish them in metrics.ts's fini
- [low] [observability] backend/src/core/logger.ts:108 — 
  scenario: 
  hint: Silence the destination under the test runner alongside the bridge: at logger.ts:108, `const underTest = process.env.NODE_TEST_CONTEXT || config.nodeEnv === 'test'; const baseStream = underTest ? { write(){} } : (prettyStream() || pino.destination({ dest: 1, sync: false }));`. The sink tee at logger
- [low] [observability] README.md:239 — 
  scenario: 
  hint: Add a cell to the table, e.g. alongside Deployment and Multi-Node Ops on README.md:243: `| 📈 [Observability](documentation/observability.md) |`, and cross-link it from documentation/deployment.md and documentation/multi-node.md (observability.md:268 already links back to multi-node.md).
- [high] [comments-audit-mfa-health] backend/src/routes/comments.ts:203 — 
  scenario: 
  hint: Give the discarded payload a plausible id instead of 0: in `discardedComment`, take one indexed PK read — `SELECT MAX(comment_id) AS m FROM comments` — and emit `m + 1` (make `discardedComment` async and await it at both call sites, lines 686 and 713). Then move the duplicate check ABOVE the honeypo
- [medium] [comments-audit-mfa-health] backend/src/routes/comments.ts:102 — 
  scenario: 
  hint: Move COMMENT_RATE_WINDOW_MS / COMMENT_RATE_MAX_ANON / COMMENT_RATE_MAX_AUTH into config/app.ts alongside `config.api.rateLimit` (with the same clamping so a typo cannot disable the limiter), read them inside `createCommentLimiter`, and raise the anonymous default to something a real thread survives 
- [medium] [comments-audit-mfa-health] backend/src/core/audit.ts:287 — 
  scenario: 
  hint: In routes/health.ts `withDegradationFields()`, add `report.retention = { audit: require('../core/audit').auditRetentionState(), analytics: require('../core/analytics-retention').retentionState() }` inside the existing try/catch, and document the `behind` field in the /health/details Swagger block ne
- [low] [comments-audit-mfa-health] backend/src/core/audit.ts:212 — 
  scenario: 
  hint: Expose `audit_retention_days` in the Settings → Security panel next to the MFA policy form (a number input, 0 = keep for ever), or at minimum log the effective retention once at the FIRST prune of a process, not only when rows were actually removed (core/audit.ts runAuditRetention, line ~300, curren
- [low] [comments-audit-mfa-health] backend/src/core/audit.ts:104 — 
  scenario: 
  hint: In `sanitizeDetail`, truncate every string value to a bound (e.g. 256 chars), cap array length (e.g. 20 elements), and cap the number of retained keys (e.g. 20) — dropping the overflow. That makes the module's own contract true regardless of what a future call site passes.
- [low] [comments-audit-mfa-health] backend/src/routes/auth.ts:781 — 
  scenario: 
  hint: Not a reason to stop recording the attempted account, but state the hazard next to the comment and shrink the blast radius: record the raw attempt only when it resolves to an existing user (`resolveLockIdentifier` already ran at line 694), and for a non-existent account record a stable non-reversibl
- [low] [comments-audit-mfa-health] documentation/security.md:288 — 
  scenario: 
  hint: Amend the sentence to the accurate residual: "an unrecognised `wjt_` string falls through to the route's own 401; a valid token whose owner is non-compliant answers 403, so the two responses differ — a distinction reachable only by presenting a genuine token, not by guessing one."
- [low] [comments-audit-mfa-health] backend/src/routes/comments.ts:189 — 
  scenario: 
  hint: Build the default eagerly at module scope — `let commentLimiterImpl: any = createCommentLimiter(undefined);` — and let `useCommentLimiterStore()` replace it. The shim then never constructs anything inside a handler, and the store-arrives-late contract is unchanged.
- [low] [comments-audit-mfa-health] backend/src/routes/comments.ts:115 — 
  scenario: 
  hint: Either scope the read to the author — pass `userId: draft.userId` to `Comment.findAll` for the logged-in case, and for guests add a `authorIp` filter to the model — or correct the comment to say the guard is best-effort over the post's 25 most recent comments and fails open on a busy thread.
- [low] [comments-audit-mfa-health] backend/src/routes/notices.ts:90 — 
  scenario: 
  hint: Wrap the DELETE handler's read-modify-write in the same lock the writers use: `const lock = await acquireBlocking('wordjs:admin-notices', { ttlMs: 15000, timeoutMs: 15000 })` around lines 81–90, releasing in a finally — or better, add a `clearAdminNotice(id)`-shaped helper to core/admin-notices and 
- [high] [openapi-truthfulness] backend/src/routes/seo.ts:226 — 
  scenario: 
  hint: Add `*     security: []` to each of the seven new blocks (immediately after `tags:`), and to the three pre-existing ones at seo.ts:195 (/seo/sitemap.xml), 273 (/seo/robots.txt) and 301 (/seo/feed.xml) which have the same defect.
- [high] [openapi-truthfulness] CHANGELOG.md:69 — 
  scenario: 
  hint: Either fix the remaining operations (add `security: []` to the anonymous ones, `- bearerAuth: []` + `- {}` to the optionalAuth ones) or reword the entry to say which four were fixed and that the rest of the class is outstanding — and stop the bleeding by fixing the seven new seo blocks in the same c
- [medium] [openapi-truthfulness] backend/src/routes/media.ts:401 — 
  scenario: 
  hint: Replace `security: []` with the two-alternative form used by GET /posts/{id}:
 *     security:
 *       - bearerAuth: []
 *       - {}
at media.ts:401, comments.ts:313, comments.ts:416 and fonts.ts:113.
- [medium] [openapi-truthfulness] backend/src/routes/webhooks.ts:207 — 
  scenario: 
  hint: Add to each of the eight blocks:
 *       401:
 *         description: Not logged in (rest_not_logged_in)
matching the wording already used at webhooks.ts:152.
- [medium] [openapi-truthfulness] backend/src/routes/collab.ts:551 — 
  scenario: 
  hint: Extend the 400 description at collab.ts:551 to "…, or a malformed frame / an op whose siteId does not match the connection (collab_bad_frame)", and the 429 description at collab.ts:753 to name `collab_read_budget` alongside `collab_rate_limit`.
- [medium] [openapi-truthfulness] backend/src/routes/collab.ts:657 — 
  scenario: 
  hint: Delete 413 from the presence, resync and leave blocks; delete 429 and the collab_closed/collab_epoch wording from the leave block (leave keeps only 400/401/403/404/409 collab_no_session); and add `collab_no_room` to the 409 description of the presence block at collab.ts:655.
- [low] [openapi-truthfulness] backend/src/config/swagger.ts:72 — 
  scenario: 
  hint: Add a second scheme, e.g. `sessionCookie: {type: apiKey, in: cookie, name: <session cookie name>}`, and list it alongside bearerAuth on the cookie-capable operations; on the sessionOnly routes (/auth/tokens*, /auth/mfa/{setup,enable,disable,backup-codes}, /webhooks mutations) say in the description 
- [low] [openapi-truthfulness] backend/src/tests/swagger-spec.test.ts:118 — 
  scenario: 
  hint: Export the resolved glob list from config/swagger.ts (e.g. `module.exports.__apis = options.apis`) and have the test read it, instead of restating it.
- [low] [openapi-truthfulness] backend/scripts/verify-f0-baseline.ts:181 — 
  scenario: 
  hint: Either document the root `/health` in index.ts with its own `servers: [{url: '/'}]` block (as the other four root routes already have), or state in the coverageRatio comment that path collisions across servers are counted as covered. Optionally exclude routes/frontend.ts from the denominator while i
- [low] [openapi-truthfulness] backend/src/routes/posts.ts:932 — 
  scenario: 
  hint: Delete the `requestBody` from both @swagger blocks and replace it with a one-line description pointing at ContentCreateInput/ContentUpdateInput, or drop the override in config/swagger.ts and `$ref` the generated schemas from the blocks directly.
- [low] [openapi-truthfulness] backend/src/routes/auth.ts:1512 — 
  scenario: 
  hint: Replace the allOf with an inline object listing the seven fields the handler actually sends, or add `lastUsedAt`/`revoked`/`createdAt` to the response (they are known at creation time).
- [low] [openapi-truthfulness] backend/src/routes/auth.ts:460 — 
  scenario: 
  hint: Re-indent the twelve lines to ` *`, matching the rest of their blocks.
- [high] [coverage-perf-scripts] backend/scripts/perf-calibrate.mjs:235 — 
  scenario: 
  hint: In mintBudget, mirror the p95 branch for the ratio: after computing the ceiling, `const minted = round3(worstRatio * factor); if (minted > Number(committed.maximumRatioToReference)) warnings.push(`${id}: minted ratio ceiling ${minted}x is LOOSER than the committed ${committed.maximumRatioToReference
- [high] [coverage-perf-scripts] .github/workflows/ci.yml:1120 — 
  scenario: 
  hint: Rewrite ci.yml:1120-1129 and documentation/development.md:307 to say what is actually new: the harness already runs and enforces on the Linux runner inside the Backend job, but it has never PRINTED its observations next to the ceilings and has no multi-round calibration mode — that is what this job 
- [medium] [coverage-perf-scripts] .github/workflows/ci.yml:362 — 
  scenario: 
  hint: Measure it before merging — one `workflow_dispatch` run of the Backend job is enough, and the step already prints its own timing. If the measured step is over ~8 minutes, either raise `timeout-minutes` to 45 with the observed number written into the comment (the convention the perf-budgets job at li
- [medium] [coverage-perf-scripts] documentation/development.md:134 — 
  scenario: 
  hint: Pick one and make the two suites agree: either add `--exclude "src/generated/**"` to both backend scripts and rewrite line 134 as two sentences, one per suite, naming `backend/scripts/**` as deliberately out of scope; or drop the `--src src` scoping and cover scripts too. Whichever way, the phrase "
- [medium] [coverage-perf-scripts] .dockerignore:58 — 
  scenario: 
  hint: Add to .dockerignore, next to the graphify-out entry: `# Coverage output (backend/coverage/tmp reaches ~1.1 GB and c8 cleans it BEFORE a run, not after)` then `coverage/` and `**/coverage/`. Correct documentation/development.md:138 to say the tmp tree survives the run and is only cleared by the next
- [low] [coverage-perf-scripts] .github/workflows/ci.yml:770 — 
  scenario: 
  hint: Add `reportOnFailure: true` to the `coverage` block in frontend/vitest.config.mts (beside `reporter`), so the `if: always()` upload actually has something to upload on the runs where it matters.
- [low] [coverage-perf-scripts] backend/scripts/perf-calibrate.mjs:216 — 
  scenario: 
  hint: In main(), before `if (calibrate)`, add: `if (calibrate && failures.length) { for (const f of failures) console.error(`::error::${f}`); console.error('\nrefusing to mint a budget from rounds that do not line up with the committed operations.'); process.exit(1); }` — or, minimally, guard lines 216-21
- [low] [coverage-perf-scripts] .github/workflows/ci.yml:1119 — 
  scenario: 
  hint: Add `backend/scripts/perf-calibrate.mjs` to the REQUIRED_GATES heredoc alongside the verify-f* rows, and add backend/src/tests/perf-calibrate.test.ts covering the three branches that decide a verdict: extractRun against a TAP line with a reporter prefix before the `{` (and against two lines, asserti
- [low] [coverage-perf-scripts] documentation/development.md:136 — 
  scenario: 
  hint: Replace the 8.4% quotation with the failure the committed command actually emits, e.g. a one-file `npm run test:coverage:check` run, or the no-op-child run above — something a reader can re-execute verbatim from backend/package.json:15.
- [low] [coverage-perf-scripts] backend/package.json:14 — 
  scenario: 
  hint: Make the coverage scripts wrap the canonical one instead of copying it: `"test:coverage": "c8 <reporters and excludes> npm test"` and likewise for test:coverage:check. c8 works by exporting NODE_V8_COVERAGE, which the npm -> node -> node --test -> per-file child chain inherits — the same two-level i

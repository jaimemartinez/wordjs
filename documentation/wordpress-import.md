# Migrating from WordPress

WordJS ships a built-in importer for the WordPress **WXR** (WordPress eXtended RSS) export format. Point it at the `.xml` file WordPress produces and it recreates your authors, taxonomy, posts, pages, comments, **media library** and **navigation menus** as native WordJS content.

> **Admin-only and idempotent.** The importer is restricted to the **administrator** role (the `isAdmin` middleware) and is safe to re-run: existing users, terms and posts are *matched, not duplicated*. If an import is interrupted, just run it again — already-imported content is skipped.

The implementation lives in `backend/src/core/wxr-import.ts` (`parseWxr` / `analyzeWxr` / `importWxr`), with the attachment half in `backend/src/core/wxr-media.ts` and the menu half in `backend/src/core/wxr-menus.ts`. The HTTP layer is `backend/src/routes/import.ts` and the admin UI is at `frontend/src/app/admin/import/page.tsx`.

## 1. Export your content from WordPress

In your existing WordPress admin:

1.  Go to **Tools → Export**.
2.  Choose **All content** (this produces a complete WXR export — posts, pages, comments, custom fields, terms, navigation menus and the authors).
3.  Click **Download Export File**. You'll get a single `.xml` file (sometimes named `*.wxr`).

That file is everything the importer needs. WXR exports up to **100 MB** are accepted.

> WXR is a manifest, not a backup: it contains your text content and **URLs** to media, not the media binaries. The importer therefore **downloads** each attachment from the URL the export carries — see [Media](#media-attachments) for the guard rails on that fetch, and [What is *not* imported](#what-is-not-imported) for what still stays behind.

## 2. Import via the Admin Panel

The friendliest path is the bundled wizard.

1.  In the WordJS admin, open **Import** in the sidebar (route: `/admin/import`).
2.  Drag your `.xml` / `.wxr` file onto the dropzone, or click to browse.
3.  The file is **analyzed first** (a dry run — nothing is written yet). You'll see a preview of what was found: posts, pages, categories, tags, authors, comments, attachments and menu items, plus the WXR version.
4.  Choose your options (see below), then click **Start import**.
5.  When it finishes you get a summary — how many of each entity were **created** vs **skipped/matched** — and an expandable list of any per-item issues (the import keeps going past individual failures rather than aborting).

### Import options

| Option | Default | Effect |
| --- | --- | --- |
| **Import comments** | On | Bring over comments, with threading preserved. Approved and pending (`hold`/unapproved) comments keep their state, and spam-flagged comments are imported with status `spam`. Pingbacks, trackbacks and trashed comments are skipped (see below). |
| **Import media** | **Download the files** | Three choices, because a WXR carries URLs and not binaries: **Download the files** (the server fetches every attachment from the old site — https only, 50 MB per file, 1 GB per run — and rewrites in-content URLs to this install), **Link to the old site** (create the records, download nothing, keep loading from the old host), or **Skip attachments**. See [Media](#media-attachments). |
| **Allow `http://` sources** | Off | Shown only for *Download the files*. Lets the fetch accept a non-https source, for an old site that never got a certificate. It does **not** weaken the SSRF guard: private, loopback and metadata addresses stay refused whatever the scheme. |

Posts whose original WordPress author cannot be matched are assigned to a **default author**. In the UI this defaults to **you** (the importing admin).

## 3. Import via the API

The same two operations are exposed as admin-only, multipart endpoints under `/api/v1/import`. In both cases the file goes in the multipart field named **`file`**, and you must be authenticated as an admin.

### Analyze (dry run)

`POST /api/v1/import/wordpress/analyze`

Parses the WXR and returns entity counts **without writing anything**. Use this to preview an import.

```bash
curl -X POST https://localhost:3000/api/v1/import/wordpress/analyze \
  -H "Authorization: Bearer <admin-token>" \
  -F "file=@wordpress-export.xml"
```

Response:

```json
{
  "success": true,
  "analysis": {
    "wxrVersion": "1.2",
    "site": { "title": "...", "link": "...", "description": "...", "baseUrl": "..." },
    "counts": {
      "authors": 3, "categories": 8, "tags": 24, "customTerms": 0,
      "posts": 142, "pages": 6, "attachments": 88, "navItems": 5, "other": 0,
      "comments": 510
    }
  }
}
```

### Run the import

`POST /api/v1/import/wordpress`

Runs the idempotent import and returns a summary. Options are sent as multipart form fields alongside the file:

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `defaultAuthorId` | integer | the calling admin's id | Fallback author for items whose WordPress author couldn't be imported. |
| `importComments` | `1` / `0` | `1` (any value other than `"0"`) | Import comments. |
| `media` | `download` / `link` / `skip` | falls back to `importAttachments` | What to do with attachment items. See [Media](#media-attachments). |
| `allowHttp` | `1` / `0` | `0` | Allow `http://` attachment sources. Does not weaken the resolved-IP checks. |
| `importAttachments` | `1` / `0` | `0` (only `"1"` enables it) | **Legacy**, and used only when `media` is absent: `1` means `media=download`, anything else `media=skip`. A caller that has always sent this field keeps exactly the behaviour it had. |

```bash
curl -X POST https://localhost:3000/api/v1/import/wordpress \
  -H "Authorization: Bearer <admin-token>" \
  -F "file=@wordpress-export.xml" \
  -F "importComments=1" \
  -F "media=download"
```

> **Note the two different defaults, on purpose.** The admin wizard preselects **Download the files** and always sends an explicit `media`, because that is the migration most people want and the screen says in full what it will do. The raw endpoint keeps defaulting to `skip` when *neither* field is sent, so an existing script cannot start making host-side downloads because it was upgraded.

The remaining media knobs (`maxFileBytes`, `maxTotalBytes`, `timeoutMs`, `rewriteUrls`) are options of `importWxr()` itself and are documented under [Media](#media-attachments); a caller that needs them calls `core/wxr-import`'s `importWxr()` directly (a CLI or a migration script).

Response (`summary`):

```json
{
  "success": true,
  "summary": {
    "site": { "title": "...", "link": "..." },
    "authors": { "created": 2, "matched": 1 },
    "terms": { "categories": 8, "tags": 24, "custom": 0 },
    "posts": { "created": 140, "skipped": 2 },
    "pages": { "created": 6, "skipped": 0 },
    "attachments": { "created": 86, "skipped": 2 },
    "comments": { "created": 470, "skipped": 40 },
    "navItems": { "skipped": 1 },
    "media": {
      "mode": "download",
      "downloaded": 86,
      "linked": 0,
      "skipped": 1,
      "failed": 1,
      "bytes": 41234567,
      "fetchedBytes": 41240000,
      "failures": [
        { "url": "https://old.example/wp-content/uploads/2019/07/gone.png", "reason": "HTTP 404" }
      ]
    },
    "menus": {
      "created": 2,
      "matched": 0,
      "items": { "created": 4, "skipped": 1 },
      "locations": { "assigned": 0, "unassigned": 2, "reason": "the WXR carried no readable nav_menu_locations option" }
    },
    "errors": []
  }
}
```

A malformed file (not a `<rss><channel>` WXR document) returns **HTTP 400** with `code: "invalid_wxr"`; a missing upload returns **400** with `code: "no_file"`. Up to the first 100 per-item problems are collected in `summary.errors` — the import continues past them rather than failing the whole run.

## What gets mapped

WordJS maps WordPress entities onto its own models:

| WordPress (WXR) | WordJS | Notes |
| --- | --- | --- |
| `wp:author` | **Users** (role `author`) | Matched by login, then by email. New users get a **random password** (see below). |
| `wp:category` | **Terms** (taxonomy `category`) | Parent/child hierarchy is reconstructed (WXR stores the parent as a slug, resolved in a second pass). |
| `wp:tag` | **Terms** (taxonomy `post_tag`) | |
| `wp:term` | **Terms** (custom taxonomies) | Best-effort; `category`/`post_tag` here are skipped because they're handled above. |
| `item` (post/page) | **Posts / Pages** | Plus post meta, category/tag relationships and comments. |
| `wp:postmeta` | **Post meta** | Custom fields are preserved, minus the server-owned keys the shared list in `core/protected-meta.ts` refuses (`_wp_attached_file`, `_wp_attachment_metadata`, `_wp_trash_meta_status`, `_wp_trash_meta_time`, `_edit_lock`, `_edit_last`, the importer's own `_wxr_source_url` / `_wxr_menu_item_id` / `_wxr_remote_url`, and the revision-snapshot envelope) and minus malformed keys (empty, over the column's bound, or a prototype name such as `__proto__`). One deliberate exception: on an **attachment** item the two path keys `_wp_attached_file` / `_wp_attachment_metadata` *are* written, validated by **shape** rather than refused by name — without them a migrated attachment would have no file path at all. |
| `wp:comment` | **Comments** | Threading is preserved; comment author/email/body are required. |
| `item` (attachment) | **Media library** | The file is downloaded and stored under `uploads/`, and the row is created by the same `Media.create()` the upload route uses. See [Media](#media-attachments). |
| `wp:term` (`nav_menu`) | **Menus** | A menu is a `nav_menu` term, exactly as in WordPress. Counted under `menus`, not under `terms.custom`. |
| `item` (nav_menu_item) | **Menu items** | Written through `models/Menu`'s `MenuItem.create()`, never through the generic item loop. See [Menus](#menus). |

Additional fidelity details:

*   **Publish dates are preserved.** `Post.create` would otherwise stamp "now"; the importer backfills the real `post_date` / `post_modified` (and GMT variants) from the WXR.
*   **Hierarchies are reconstructed in a second pass.** Category parents, hierarchical page parents (`wp:post_parent`), and threaded comment parents (`wp:comment_parent`) are all wired up after every entity exists, so order in the file doesn't matter.
*   **Classic content gets a light `wpautop`.** Classic-editor posts are stored as plain text with blank-line paragraph breaks; the importer wraps them in `<p>` tags. Gutenberg/block HTML is detected and left untouched.
*   **Imported block-builder data is sanitized on the way in — same as on save.** The importer doesn't trust meta values from the WXR. The `_puck_data` postmeta (the visual editor’s block tree — the meta key keeps its historical name) is run through the exact same value-based sanitizer the editor's write path uses: the JSON string is parsed, every string leaf is sanitized (HTML-bearing fields through the post-body sanitizer; every other string leaf through a scheme allow-list that blanks `javascript:` / `data:` / `vbscript:` / `file:` URLs, including control-char-obfuscated variants), then re-stringified. So a crafted WXR can't smuggle stored XSS through the page builder. Other (non-`_puck_data`) custom fields are stored verbatim.

## Media (attachments)

A WXR names your uploads by URL. The importer **fetches them**, stores them under the install's `uploads/` directory and creates a media-library row through the very same `Media.create()` the upload route calls — so an imported attachment is indistinguishable from an uploaded one.

### The `media` option

| Value | Effect |
| --- | --- |
| `download` *(default)* | Fetch `wp:attachment_url` and store the bytes. In-content URLs are rewritten to `/uploads/…`. |
| `link` | Create the record, fetch nothing, and keep the **remote** URL — in `guid` *and* in a `_wxr_remote_url` postmeta, which is what `sourceUrl` and `guid` are rendered from (see below). In-content URLs are left pointing at the old site. |
| `skip` | Do not bring attachments over at all. |

The legacy `importAttachments` boolean still works and is mapped onto this: `true` → `download`, an explicit `false` → `skip`.

> **Why `link` mode needs a meta key of its own.** `Media.formatAttachment` normalises *any* absolute `guid` containing `/uploads/` down to a local relative path — that is what makes an ordinary attachment survive a domain move. A stock WordPress URL (`https://old.example/wp-content/uploads/2025/01/a.jpg`) contains exactly that substring, so a linked attachment used to render as `/uploads/2025/01/a.jpg`: a 404 for every file on the standard layout, counted as a `linked` success. `_wxr_remote_url` is written by core, is in `core/protected-meta.ts`'s protected list (no client and no WXR can author it), and **wins** over the guid, so a linked attachment resolves to where its bytes actually are.

### How the download is guarded

The fetch runs in the **host** process against a URL a third party wrote, so it reuses the SSRF discipline `core/webhooks.ts` and `routes/marketplace.ts` already share — `core/egress-guard.ts`'s `assertUrlAllowed` + `validatingLookup`, not a second, weaker copy:

*   **https only.** An `http://` source is refused unless `allowHttp: true` is passed. There is no production exception; the loopback allowance exists only so the test suite can serve its own fixtures, and it additionally requires a non-production `nodeEnv`.
*   **Resolved-IP checks, fail-closed.** Loopback, private (RFC1918), CGNAT, ULA, link-local (including the `169.254.169.254` cloud-metadata address) and every IPv6 spelling of them are refused. A hostname is resolved, every returned address is checked, and the validated address is then **pinned** at connect time so it cannot rebind between the check and the socket. A resolution error is a refusal, not a pass.
*   **Redirects are followed manually**, re-running the *full* guard on every hop (max 5) — a public https URL cannot `302` into a private range.
*   **Size caps.** `maxFileBytes` bounds each file (default **50 MB**) and `maxTotalBytes` bounds the whole run (default **1 GB**); the stream is aborted the moment either is exceeded. Both are counted on the bytes that **arrive**, refused and failed items included — `summary.media.fetchedBytes` is that running total, while `summary.media.bytes` is only what was stored. (Counting stored bytes alone would have bounded nothing: a WXR whose files all fail the content check would download without limit.) `timeoutMs` bounds each request (default **30 s**).
*   **Extension and content checks.** The stored extension must be on `models/Media`'s own upload allowlist, so `.html` / `.js` / `.php` / `.xml` are refused — `uploads/` is served statically. The path must prove containment under the uploads root (`core/safe-path`'s `resolveWithin`), and a bounded magic-byte check must not contradict the declared MIME type.
*   **The path is claimed, not just contained.** An upload can never collide (the upload route appends a uuid slice to every stored name); an import that *preserves* the WXR's own path can, and containment does not stop it. So before anything is written the path is claimed against the media library, the disk and the rest of this run, and a taken one is disambiguated the way WordPress does it — `photo.jpg` → `photo-1.jpg` — with the in-content URL following the file. A segment beginning with `.` is refused outright, because `uploads/.derivatives/` is the image-negotiation cache and is served as `immutable`.
*   **The file is published atomically, and never outlives a failed row.** The bytes are written under a temporary dot-name and renamed into place, so `express.static` can never serve a half-written file; if the media-library row then fails to commit, the file is unlinked — a row is the only thing that can ever delete a file (`Media._deletableFiles` walks rows), so an orphan under `uploads/` would be public and unreachable forever.

### What is stored

| WXR field | WordJS |
| --- | --- |
| `wp:attachment_url` | The URL fetched, and the value stamped into `_wxr_source_url` (the re-run dedupe key). In `link` mode it is also stamped into `_wxr_remote_url`. |
| `_wp_attached_file` | The relative path under `uploads/`, **preserved verbatim** when its shape is valid *and free* — that is what makes the in-content URL rewrite a pure prefix swap. Falls back to the URL's own `…/wp-content/uploads/` tail, then to its basename; and to a `-1`, `-2`, … stem when something already holds the path. A value with a `.`-leading segment, an absolute path, a `..`, a NUL, a drive letter or more than six segments is dropped, never repaired. |
| `wp:post_mime_type` | The attachment's MIME type, when it is on the upload allowlist; otherwise it is derived from the extension. |
| `title` / `content:encoded` / `excerpt:encoded` | Title / description / caption. |
| `_wp_attachment_image_alt` | Alt text. |
| `wp:post_parent` | The post the attachment is attached to, mapped through the importer's id map. |
| `wp:post_date` | The original upload date (back-filled after `Media.create` stamps "now"). |
| — | Intrinsic `width`/`height` are read from the downloaded bytes with sharp (EXIF-orientation aware). |

In `download` mode the two path keys are owned by the importer: the WXR's own `_wp_attached_file` / `_wp_attachment_metadata` are **not** copied over the values `Media.create()` wrote, because those describe where the bytes actually are. In `link` mode they are the only record there is, so they *are* copied — after passing the same shape gate (no `..`, no absolute path, no separator tricks, no NUL, bounded depth and length). A value that does not resolve is **dropped**, never repaired, and never stored as an empty one.

**A linked attachment owns no local bytes, so deleting it never unlinks any.** The shape gate is containment, not uniqueness: `link` mode downloads nothing, so it claims nothing, and the path it copies is free to be one this install already holds — `2025/01/photo.jpg` is the same string on every WordPress site, and a `download`-mode import preserves the source path verbatim too. Two rows then name one file, and removing the imported one used to `unlink()` the *other* one's bytes (`_wp_attachment_metadata` widened that from one file to the whole subtree beside it): the genuine attachment survived pointing at a file that was gone, with no warning. So `models/Media`'s delete asks whether the row owns its file before it resolves a single unlink target, and a row carrying `_wxr_remote_url` — the server-owned key `link` mode stamps, which no route and no `wp:postmeta` can author — does not. The row goes; the bytes stay. If you *did* copy `wp-content/uploads` across by hand for a linked import, deleting the attachment leaves the file behind for you to remove.

### URL rewriting

In `download` mode, every `…/wp-content/uploads/…` prefix the export used — taken from the attachment URLs themselves and from `wp:base_site_url`, in both protocols and the protocol-relative form — is replaced with this install's `/uploads`. Pass `rewriteUrls: false` to turn it off, or `rewriteUrls: true` in `skip` mode if you are copying `wp-content/uploads` across by hand.

**Where the rewrite applies.** The post **body** and **excerpt**, and the string leaves of the `_puck_data` postmeta — the block-builder tree, which is where a Verso page's image `src` values live. Without that last one a migrated site came out half-rewritten: classic bodies local, builder pages still hotlinking the old domain and breaking the day it goes away. Other custom fields are stored verbatim, so a theme or plugin that keeps image URLs in its own meta key still needs a look after the import.

**When a file had to move.** The placement of every attachment is decided *before* the first body is written, because a WXR routinely lists a post before the attachment it embeds. If a path had to be disambiguated, the rewrite maps the URL's own path onto the stored one (`/uploads/2025/01/photo.jpg` → `/uploads/2025/01/photo-1.jpg`) on top of the prefix swap, so the `<img src>` points at the file that is really there rather than at the one that was already.

That map is applied in **one pass**, and it has to be: its values come from the same namespace as its keys, because a disambiguated name (`photo-1.jpg`) is exactly the name WordPress itself gives the next upload. A source site carrying both `photo.jpg` and `photo-1.jpg` — an ordinary export — plans `photo.jpg → photo-1.jpg` *and* `photo-1.jpg → photo-1-1.jpg`, so applying the entries one after another over the same body re-swapped the first one's output and every reference to the first attachment came out on the second one's file: the wrong image on a live page, not a 404 anyone would notice. Each `/uploads/…` reference is therefore matched once and resolved against the map, and it is matched as a *reference* rather than as a substring — the path run after `/uploads/` must be the whole of a key (so `photo.jpg.bak` and a `-1024x768` derivative are left alone, and the longest key always wins), and the marker must not be the tail of a longer path (so a body still hotlinking `https://other.example/wp-content/uploads/…`, a host whose files this install never moved, keeps pointing where it pointed).

Rewriting follows the **mode**, not each file's success: a body is rewritten even if that particular download failed. That is deliberate and is what makes a run resumable — the URL already points where the file belongs, and re-running the import retries exactly the files that failed (a failure records nothing, so nothing dedupes it away) until they land.

### Failures

A per-file failure is **recorded, never thrown**. `summary.media.failures` lists up to 100 `{ url, reason }` pairs, and the counters (`downloaded` / `linked` / `skipped` / `failed` / `bytes`) give the shape of the run. Typical reasons: `HTTP 404`, `download timed out`, `file exceeds the … per-file cap`, `refused: http:// source (enable the http opt-in to allow it)`, and the egress guard's own `network egress to … is blocked`.

## Menus

WordPress and WordJS model menus the same way — a menu is a `nav_menu` **term**, an item is a `nav_menu_item` **post** joined to that term, and the item's fields live in `_menu_item_*` post meta — so the mapping is a rename, not a translation.

Menu items are deliberately **not** created by the generic item loop: `nav_menu_item` is an internal (`showInRest: false`) post type, and the importer's refusal to create an internal type from a third party's `wp:post_type` is what stops a crafted WXR fabricating `revision` rows. They are collected and written by `core/wxr-menus.ts` through `models/Menu`'s own `MenuItem.create()`.

| WXR | WordJS | Notes |
| --- | --- | --- |
| `wp:term` with `wp:term_taxonomy = nav_menu` | A **menu** | Matched by slug, created via `Menu.create()`. A menu an item references but the export never declared is created too. |
| `<category domain="nav_menu" nicename="…">` on an item | Which menu the item belongs to | An item with no such reference cannot be placed, and is counted under `navItems.skipped`. |
| `_menu_item_type` | `type` | `post_type` / `taxonomy` / `custom`; anything else becomes `custom`. |
| `_menu_item_object` | `_menu_item_object` | The *object* (`page`, `post`, `category`, `post_tag`, …), kept distinct from the type. |
| `_menu_item_object_id` | `objectId` | Mapped through the importer's id maps — WP post id to new post id, WP term id to new term id. |
| `_menu_item_url` | `url` | Used for `custom` items, and as the fallback for an object that could not be mapped. Sanitized with the same scheme allow-list the menus route applies (`javascript:` / `data:` / `vbscript:` become `#`). |
| `_menu_item_menu_item_parent` | `post_parent` **and** the meta | Resolved in a second pass, once every item id exists; both are written because both are read. |
| `_menu_item_target` | `target` | `_blank` or `_self`. |
| `_menu_item_classes` | `classes` | Unpacked from WordPress's PHP-serialized array; only class-name-shaped tokens are kept. |
| `_menu_item_xfn` | `_menu_item_xfn` | Copied verbatim (bounded to 255 characters). |
| `wp:menu_order` | `order` | |
| `title` | `title` | An **empty** title is a reference, not a blank label: it falls back to the linked post's title or the linked term's name, exactly as WordPress renders it. |

**Resolved URLs.** An object reference carries no URL in the export (WordPress resolves it at render time), so the importer resolves it against *this* install's public routes: `/{slug}` for a post or page, and `/category/{slug}`, `/tag/{slug}` or `/taxonomy/{taxonomy}/{term}` for a taxonomy archive. An object that could not be mapped keeps whatever `_menu_item_url` the export carried, and otherwise gets an empty url — which renders as `#`, i.e. visibly unresolved rather than silently wrong.

**Theme locations.** WXR 1.2 has no options section, so a stock WordPress export carries no `nav_menu_locations` and every menu is imported **unassigned** — `summary.menus.locations.reason` says exactly that. Assign them under **Appearance → Menus**. If the export *was* widened with a `<wp:option>` named `nav_menu_locations` whose value is JSON, it is honoured (values may be the menu's WXR term id or its slug); a PHP-serialized value is deliberately not parsed.

## What is *not* imported

*   **Derivative image sizes.** An uploaded image gets a full ladder of resized variants plus WebP/AVIF derivatives; an **imported** one gets only the original file. That work lives inside multer's callbacks and the sharp pipeline in `backend/src/routes/media.ts` and is not callable from outside that route — extracting it into a core `storeUploadedFile()` that both the route and the importer call is the follow-up. Until then, imported images are served at their original size (the `Accept`-driven negotiation middleware still transcodes them on demand).
*   **SVG attachments.** SVG can carry script, and the sanitizer that makes an uploaded one safe is inlined in `routes/media.ts`. Rather than store an unsanitized one, the importer refuses `image/svg+xml` and reports it per file. Lifting that `sanitize-html` allow-list into a core module would close this too.
*   **Files whose extension is not on the upload allowlist,** and any file whose bytes contradict its declared type — refused, and reported in `summary.media.failures`.
*   **Internal post types.** `revision`, plus any post type this install has registered with `showInRest: false`. (`nav_menu_item` is internal too, and is still never created by the item loop — it is imported by the dedicated menu pass instead; see [Menus](#menus).) An *unregistered* type is not an internal one and still imports: a WXR carrying a custom type this install has never heard of is most of what a migration is.
*   **Trashed posts** (`status` = `trash`), and comments that are **pingbacks, trackbacks, trashed/post-trashed**, or missing an author/email/body — these are skipped (and counted under `skipped`). Spam-flagged comments are *not* skipped; they are imported with status `spam`.
*   **Passwords.** WordPress never exports password hashes. Imported users are created with a **random password** and must use the password-reset flow before they can log in.

## Re-running is safe

The importer is **idempotent**. On a re-run:

*   **Users** are matched by login, then email — not re-created.
*   **Terms** are matched by slug + taxonomy.
*   **Attachments** are matched by their **source URL** (stamped into `_wxr_source_url` on import), then by slug — checked *before* any network call, so a re-run does not re-download a single byte of what it already has. A file that **failed** records nothing, so the next run retries exactly those: that is what makes a 10,000-file migration resumable rather than all-or-nothing.
*   **Menus** are matched by slug; **menu items** by the WXR's own item id, stamped into `_wxr_menu_item_id`.
*   **The dedupe keys are server-owned.** `_wxr_source_url`, `_wxr_menu_item_id` and `_wxr_remote_url` are in `core/protected-meta.ts`'s protected list, so neither the routes' generic meta bag nor a third party's `wp:postmeta` can author one, and both lookups are scoped to the right `post_type`. They are the keys the *next* run indexes: a writable one is a way to make the importer report a real attachment as already imported (pointing every `wp:post_parent` / `_thumbnail_id` reference at the row that claimed its URL) or to make real menu items vanish as `skipped`. Core still writes them directly — "protected" is a rule about the write *surface*, not about the bytes.
*   **Posts/pages** are matched by slug + type, and an already-present post is skipped **along with its comments** — comments have no dedupe key, so the importer never re-attaches comments to a post it did not create in the same run (doing so would duplicate them). The post's id is still remembered so `wp:post_parent` references pointing at it (hierarchical pages) resolve correctly; threaded-comment parents are resolved only among comments created in the same run.

    One consequence for an interrupted run: a post whose row committed but whose comments had not all been attached yet keeps only the comments that made it in — the next run skips that post and does not retry its remaining comments.

This means you can analyze, do a partial import, fix something, and run again without producing duplicates. The import is deliberately **not** wrapped in a single transaction — a bulk import is treated as an incremental, resumable operation, so a failure partway through leaves the already-imported content in place for the next run to skip over. Each item is still atomic on its own: the post row, its date backfill, its meta and its term links go through `runContentMutation`, so they commit together or not at all. Comments are attached after that commit, and a comment that fails only counts as `skipped`.

## After importing

*   **Reset author passwords.** Tell imported authors to use the password-reset flow (their accounts exist but have unknown random passwords).
*   **Check `summary.media.failures`** and re-run the import for anything that failed (a retry costs nothing for the files that already landed). If a handful of files are simply gone from the old host, copy them into `uploads/` at the path the summary names.
*   **Assign your menus to theme locations** under **Appearance → Menus** — a stock WXR carries no `nav_menu_locations`, so the menus and their items are imported but not yet placed.
*   **Spot-check content**, especially classic-editor posts (paragraph wrapping) and any custom fields your theme/plugins rely on.

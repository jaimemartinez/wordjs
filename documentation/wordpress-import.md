# Migrating from WordPress

WordJS ships a built-in importer for the WordPress **WXR** (WordPress eXtended RSS) export format. Point it at the `.xml` file WordPress produces and it recreates your authors, taxonomy, posts, pages and comments as native WordJS content.

> **Admin-only and idempotent.** The importer is restricted to the **administrator** role (the `isAdmin` middleware) and is safe to re-run: existing users, terms and posts are *matched, not duplicated*. If an import is interrupted, just run it again — already-imported content is skipped.

The implementation lives in `backend/src/core/wxr-import.ts` (`parseWxr` / `analyzeWxr` / `importWxr`) with the HTTP layer in `backend/src/routes/import.ts` and the admin UI at `frontend/src/app/admin/import/page.tsx`.

## 1. Export your content from WordPress

In your existing WordPress admin:

1.  Go to **Tools → Export**.
2.  Choose **All content** (this produces a complete WXR export — posts, pages, comments, custom fields, terms, navigation menus and the authors).
3.  Click **Download Export File**. You'll get a single `.xml` file (sometimes named `*.wxr`).

That file is everything the importer needs. WXR exports up to **100 MB** are accepted.

> WXR is a manifest, not a backup. It contains your text content and **URLs** to media — not the media binaries themselves. See [What is *not* imported](#what-is-not-imported).

## 2. Import via the Admin Panel

The friendliest path is the bundled wizard.

1.  In the WordJS admin, open **Import** in the sidebar (route: `/admin/import`).
2.  Drag your `.xml` / `.wxr` file onto the dropzone, or click to browse.
3.  The file is **analyzed first** (a dry run — nothing is written yet). You'll see a preview of what was found: posts, pages, categories, tags, authors, comments, plus the WXR version and the counts of attachments / menu items that will be skipped.
4.  Choose your options (see below), then click **Start import**.
5.  When it finishes you get a summary — how many of each entity were **created** vs **skipped/matched** — and an expandable list of any per-item issues (the import keeps going past individual failures rather than aborting).

### Import options

| Option | Default | Effect |
| --- | --- | --- |
| **Import comments** | On | Bring over comments, with threading preserved. Approved and pending (`hold`/unapproved) comments keep their state, and spam-flagged comments are imported with status `spam`. Pingbacks, trackbacks and trashed comments are skipped (see below). |
| **Create attachment records** | Off | Create post records of type `attachment` (metadata only). **Media files are never downloaded** — only the original URLs are recorded. |

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
| `importAttachments` | `1` / `0` | `0` (only `"1"` enables it) | Create attachment post records (no file download). |

```bash
curl -X POST https://localhost:3000/api/v1/import/wordpress \
  -H "Authorization: Bearer <admin-token>" \
  -F "file=@wordpress-export.xml" \
  -F "importComments=1" \
  -F "importAttachments=0"
```

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
    "attachments": { "created": 0, "skipped": 88 },
    "comments": { "created": 470, "skipped": 40 },
    "navItems": { "skipped": 5 },
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
| `wp:postmeta` | **Post meta** | Custom fields are preserved, minus the server-owned keys the shared list in `core/protected-meta.ts` refuses (`_wp_attached_file`, `_wp_attachment_metadata`, `_wp_trash_meta_status`, `_wp_trash_meta_time`, `_edit_lock`, `_edit_last`, and the revision-snapshot envelope) and minus malformed keys (empty, over the column's bound, or a prototype name such as `__proto__`). One deliberate exception: on an **attachment** item the two path keys `_wp_attached_file` / `_wp_attachment_metadata` *are* written, validated by **shape** rather than refused by name — without them a migrated attachment would have no file path at all. |
| `wp:comment` | **Comments** | Threading is preserved; comment author/email/body are required. |

Additional fidelity details:

*   **Publish dates are preserved.** `Post.create` would otherwise stamp "now"; the importer backfills the real `post_date` / `post_modified` (and GMT variants) from the WXR.
*   **Hierarchies are reconstructed in a second pass.** Category parents, hierarchical page parents (`wp:post_parent`), and threaded comment parents (`wp:comment_parent`) are all wired up after every entity exists, so order in the file doesn't matter.
*   **Classic content gets a light `wpautop`.** Classic-editor posts are stored as plain text with blank-line paragraph breaks; the importer wraps them in `<p>` tags. Gutenberg/block HTML is detected and left untouched.
*   **Imported block-builder data is sanitized on the way in — same as on save.** The importer doesn't trust meta values from the WXR. The `_puck_data` postmeta (the visual editor’s block tree — the meta key keeps its historical name) is run through the exact same value-based sanitizer the editor's write path uses: the JSON string is parsed, every string leaf is sanitized (HTML-bearing fields through the post-body sanitizer; every other string leaf through a scheme allow-list that blanks `javascript:` / `data:` / `vbscript:` / `file:` URLs, including control-char-obfuscated variants), then re-stringified. So a crafted WXR can't smuggle stored XSS through the page builder. Other (non-`_puck_data`) custom fields are stored verbatim.

## What is *not* imported

*   **Media files (attachments).** A WXR contains only the **URLs** of your images and uploads, not the binaries. By default attachment items are skipped entirely. Enabling "Create attachment records" only stores the metadata/URL — **no files are downloaded** from your old site. Plan to migrate your `wp-content/uploads` separately.
*   **Internal post types.** `nav_menu_item` (WordJS menus differ enough — rebuild them in the admin) and `revision`, plus any post type this install has registered with `showInRest: false`. An *unregistered* type is not an internal one and still imports: a WXR carrying a custom type this install has never heard of is most of what a migration is.
*   **Trashed posts** (`status` = `trash`), and comments that are **pingbacks, trackbacks, trashed/post-trashed**, or missing an author/email/body — these are skipped (and counted under `skipped`). Spam-flagged comments are *not* skipped; they are imported with status `spam`.
*   **Passwords.** WordPress never exports password hashes. Imported users are created with a **random password** and must use the password-reset flow before they can log in.

## Re-running is safe

The importer is **idempotent**. On a re-run:

*   **Users** are matched by login, then email — not re-created.
*   **Terms** are matched by slug + taxonomy.
*   **Posts/pages** are matched by slug + type, and an already-present post is skipped **along with its comments** — comments have no dedupe key, so the importer never re-attaches comments to a post it did not create in the same run (doing so would duplicate them). The post's id is still remembered so `wp:post_parent` references pointing at it (hierarchical pages) resolve correctly; threaded-comment parents are resolved only among comments created in the same run.

    One consequence for an interrupted run: a post whose row committed but whose comments had not all been attached yet keeps only the comments that made it in — the next run skips that post and does not retry its remaining comments.

This means you can analyze, do a partial import, fix something, and run again without producing duplicates. The import is deliberately **not** wrapped in a single transaction — a bulk import is treated as an incremental, resumable operation, so a failure partway through leaves the already-imported content in place for the next run to skip over. Each item is still atomic on its own: the post row, its date backfill, its meta and its term links go through `runContentMutation`, so they commit together or not at all. Comments are attached after that commit, and a comment that fails only counts as `skipped`.

## After importing

*   **Reset author passwords.** Tell imported authors to use the password-reset flow (their accounts exist but have unknown random passwords).
*   **Migrate media.** Copy your old uploads across and fix in-content URLs as needed — the importer didn't fetch any files.
*   **Rebuild menus** under the admin's menu editor.
*   **Spot-check content**, especially classic-editor posts (paragraph wrapping) and any custom fields your theme/plugins rely on.

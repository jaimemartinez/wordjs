# Tutorial 6 — Move a WordPress site to WordJS

In this tutorial you take a WordPress export file (WXR) and bring its posts, pages,
categories, tags, authors, comments, images and menus into a WordJS site from the admin, then check the
result on the public site.

**Time:** about 10 minutes.
**You need:** a WordJS site and an administrator account. A WordPress export is optional: the tutorial
ships a small one, [`files/sample-wordpress-export.xml`](files/sample-wordpress-export.xml) ("Corner
Roasters": two posts, a page, a category, a tag, an author, a comment, an image and a header menu).

## 1. Export from WordPress

In your WordPress admin, open **Tools → Export**, choose **All content** and click **Download Export
File**. You get one `.xml` file. To follow along without a WordPress site, download the sample file
above instead.

A WordPress export lists your uploads **by URL**, not as files. WordJS fetches them from the old site
during the import, so keep the old site online until the import is done.

## 2. Analyze the file

In WordJS open **Admin → Import** and drop the file onto the upload area (or click it to browse). WordJS
reads the file and shows what it found before changing anything. For the sample:

| Posts | Pages | Categories | Tags | Authors | Comments | Attachments | Menu items |
|---|---|---|---|---|---|---|---|
| 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |

## 3. Choose the options

- **Import comments** — on by default. Approved and pending comments come over, threading preserved.
- **Import media:**
  - **Download the files** (default) — the server fetches every attachment from the old site and stores
    it here (https only, up to 50 MB per file and 1 GB per run). Image URLs inside the content that point
    at the old site's `/wp-content/uploads/` are rewritten to this site's `/uploads/`.
  - **Link to the old site** — creates the media entries but keeps loading the files from the old
    site, so they break if it goes away.
  - **Skip attachments** — imports no media, for when you copy `wp-content/uploads` across by hand.
- **Allow http:// sources** — only if the old site has no HTTPS.
- **Allow downloads from this site's private address** (with **Download the files**) — for a WordPress on
  your local network, an intranet or a staging server. Only the site the file was exported from is
  allowed; every other private, loopback or cloud-metadata address stays refused.

Posts whose WordPress author is not found are assigned to the administrator running the import.

Click **Start import**.

## 4. Read the summary

When it finishes, the summary lists what was created, matched and skipped. For the sample: 2 posts, 1
page, 1 category, 1 tag, 1 author and 1 comment created; **Media (download)** shows 1 file downloaded;
**Menus** shows 1 menu with 1 item, and **Unassigned 1**.

The menu is created but **not placed**: a WordPress export does not carry the theme's menu locations.
Assign it under **Admin → Menus**.

Running the same file again is safe: posts, terms, users, media and menu items that already exist are
matched, not duplicated, and an attachment that already downloaded is never fetched twice.

## 5. Check the site

| URL | What you should see |
|---|---|
| `/how-we-brew-a-pour-over` | The post, its original date (*March 2, 2024*) and author (María), the image served from `/uploads/2024/03/beans.png`, and the imported comment with its own date (*March 3, 2024*) |
| `/friday-roast-schedule` | The second post |
| `/wholesale` | The page |
| `/category/brewing`, `/tag/pour-over` | The archives, listing the imported posts |
| `/author/user-<id>` | María's author archive. WordJS never puts a sign-in name in a public address, so the archive uses her account number instead. |

## Good to know

- **The same import from the command line or a script:** `POST /api/v1/import/wordpress` (multipart,
  fields `file`, `media`, `importComments`, `allowHttp`, `allowPrivateSource`). See [wordpress-import.md](../wordpress-import.md),
  which also documents the limits, the idempotency rules and every field of the summary.
- **Large sites:** the upload limit is 100 MB per file. Split a bigger export in WordPress (export by
  post type or date range) and import the parts one after another.

---
*Tested on 2026-10-17 with a WordJS 2.7.0 release build on a fresh install (Debian 12), in a browser,
with the sample file:

- the analysis counts in step 2;
- the import with the default options and the summary in step 4;
- the public URLs in step 5: the image downloaded and served locally, the post's featured image set to
  the imported attachment, and the post and comment dates kept from the export.

Walked again on 2026-10-23 with WordJS 2.9 and the sample file: the same counts, summary and URLs, plus the
private-address option and the author archive address.*

# Media storage: local disk or an S3-compatible bucket + CDN

By default WordJS writes uploads under `backend/uploads/` (`config.uploads.dir`) and serves them from
`/uploads/...`. Nothing about that changes unless you turn on **media offload**: public media — the
original file **and every stored derivative** (the thumbnail/medium/large sizes, the `w640…w1920` width
ladder and their WebP/AVIF siblings) — is then written to an **S3-compatible bucket** (AWS S3,
Cloudflare R2, Backblaze B2, a self-hosted Garage, SeaweedFS or MinIO, …) and served from a **public
base URL** (the bucket itself or a CDN in front of it).

> **Self-hosted S3.** Any server that speaks the S3 API with path-style requests works. MinIO is still
> compatible, but its project no longer publishes ready-made server binaries; for a new self-hosted
> bucket, [Garage](https://garagehq.deuxfleurs.fr/) and [SeaweedFS](https://github.com/seaweedfs/seaweedfs)
> (its S3 gateway) are maintained alternatives that ship binaries and container images.

Code: `backend/src/core/media-storage.ts` (config, adapters, URLs), `backend/src/core/media-storage-migrate.ts`
(offload / restore of an existing library), `backend/src/routes/media-storage.ts` (admin API), the
SigV4 signer shared with the backup offload in `backend/src/core/s3-offload.ts`, and on the frontend
`frontend/media-csp.js` (CSP) and `frontend/src/lib/mediaDelivery.ts` (SSR URLs).

## What is stored where

| | Local storage (default) | S3 offload |
|---|---|---|
| New public uploads | `uploads/<yyyy>/<mm>/…` | the bucket, under `<prefix>/<yyyy>/<mm>/…` (prefix `uploads` by default); removed from local disk after a verified write unless `keepLocalCopy` |
| Private media (`visibility: private`) | `data/private-uploads/` | **unchanged** — private media is never offloaded; making an offloaded item private brings its files back to the private root first and deletes its objects |
| Fonts (`uploads/fonts/`), the AVIF/WebP negotiation cache (`uploads/.derivatives/`) | local | local |
| Database | `guid = /uploads/<rel>`, `_wp_attached_file = <rel>` | **identical** — plus the marker `_wjs_media_storage = s3` |

**The database never holds a bucket or CDN URL.** Media references stay relative (`/uploads/…`), the
rule described in [deployment.md → Media URLs](deployment.md#media-urls-important): a site can change
bucket, CDN host or domain — or roll the offload back — without rewriting a single row. The API keeps
`sourceUrl` relative (that is what editors persist into content) and adds:

- `deliveryUrl` — where a client should fetch the file: the CDN URL for an offloaded item, the same
  relative path otherwise;
- `storage` — `s3` or `local`.

## How pages reach the CDN

1. **Redirect (always on with s3).** `GET /uploads/<rel>` for a file this node does not hold on disk
   answers `302` to `<publicBase>/<rel>` (`Cache-Control: public, max-age=300`). Every reference ever
   written — post HTML, persisted `srcset`s, theme settings, the site logo — keeps working on any node.
   A file that IS on disk (local storage, `keepLocalCopy`, after a restore) is served locally as before.
   `302`, not `301`, because a restore makes the local file authoritative again. In a multisite
   network the other sites redirect the same way: each serves `/uploads` from its own directory first,
   and a file it does not hold goes to the bucket (their uploads go there too) before it is a 404.
2. **SSR rewrite (once the library is fully offloaded).** When the library state is `offloaded` the
   public settings carry `media_public_base`, and the public SSR (`withResolvedBlocks`) rewrites
   `/uploads/` URLs in the page's block data and HTML body to it, so browsers fetch the CDN directly.
   Fonts (`/uploads/fonts/`) and URLs that are already absolute are left alone. This is a render-time
   copy; nothing is written back.

## Content Security Policy

The configured media origin — **one origin, nothing else** — is added to the page CSP's `img-src` and
`media-src` (`media-src 'self' <origin>` is created when the build set none). `next.config.ts` bakes the
header at build time, so the custom servers (`frontend/server.js`, `monolith.js`) amend it per response
(`frontend/media-csp.js`). The origin comes from, in order: the `WORDJS_MEDIA_CDN_ORIGIN` env var on the
frontend, the `media_cdn_origin` public setting the frontend last read from the backend, then the
`mediaStorage` block of the nearest
`wordjs-config.json`. Saving the media storage settings purges the frontend's `settings` cache, and
the purge handler (`/api/revalidate`) re-reads `media_cdn_origin` from the backend at once, so the new
origin is in the header within a couple of seconds of the save (the purge is debounced) — not after the
60 s settings cache. With offload off the header is byte-for-byte what it was. The backend's own CSP
(helmet) adds the same origin to `media-src`.

Use a CDN/bucket host that is **not** the site's own origin (a separate, cookie-less domain): objects are
served by the bucket with the type they were stored with, and document types that could execute
(`.html`, `.js`, `.xml`, …) are stored as `application/octet-stream` + `Content-Disposition: attachment`,
mirroring the `/uploads` denylist.

## Configuration

**Settings → Media storage** (administrators) edits the `mediaStorage` block of
`backend/wordjs-config.json` through the same atomic writer as every other credential the backend holds
(the backup offload's `s3` block, the database password). The secret access key and session token are
**write-only**: the API answers only whether they are set and their last four characters (the access key
id likewise as a hint); leaving the field empty keeps the stored value. Every save and every migration is
recorded in the audit log (`media.storage.update`, `media.storage.migrate`) without credentials.

| Field | Env override | Notes |
|---|---|---|
| `driver` | `WORDJS_MEDIA_STORAGE` | `local` (default) or `s3` |
| `bucket` | `WORDJS_MEDIA_S3_BUCKET` | AWS bucket-naming rules |
| `region` | `WORDJS_MEDIA_S3_REGION` | default `us-east-1`; R2 uses `auto`; B2 e.g. `us-west-004` |
| `endpoint` | `WORDJS_MEDIA_S3_ENDPOINT` | S3-compatible origin (path style), e.g. `https://<account>.r2.cloudflarestorage.com`, `https://s3.us-west-004.backblazeb2.com`, `http://garage.lan:3900`, `http://seaweedfs.lan:8333`, `http://minio.lan:9000`. Empty = AWS virtual-hosted |
| `accessKeyId` / `secretAccessKey` | `WORDJS_MEDIA_S3_ACCESS_KEY_ID` / `WORDJS_MEDIA_S3_SECRET_ACCESS_KEY` | write-only in the UI |
| `sessionToken` | `WORDJS_MEDIA_S3_SESSION_TOKEN` | optional, temporary credentials |
| `prefix` | `WORDJS_MEDIA_S3_PREFIX` | key prefix, default `uploads` |
| `publicUrl` | `WORDJS_MEDIA_PUBLIC_URL` | the URL that maps to the **bucket root** (a CDN domain). Empty = the bucket's own URL (`https://<bucket>.s3.<region>.amazonaws.com` or `<endpoint>/<bucket>`) |
| `keepLocalCopy` | `WORDJS_MEDIA_KEEP_LOCAL_COPY` | also keep each new upload on local disk |

The public URL of an object is `<publicUrl>/<prefix>/<rel>`. Objects must be **publicly readable** there
(a public bucket or a CDN with read access to it); the bucket itself needs no public write. A partial
configuration (a bucket without keys, an unusable public URL, a prefix with `..`) counts as **not
configured**: the effective driver stays `local` and the screen says which fields are missing.

**The public URL is the bucket ROOT; WordJS adds the prefix.** With the default prefix `uploads`, a public
URL of `https://cdn.example.com/uploads` makes every media URL `https://cdn.example.com/uploads/uploads/…`.
The server cannot fetch the public URL (see below), but it does flag the mistakes it can see: the
answers of `GET`/`PUT /media-storage` and `POST /media-storage/test` carry `warnings`, each
`{ field, code, message }`:

| `code` | Meaning |
|---|---|
| `media_public_url_doubled_prefix` | the public URL already ends with `/<prefix>` |
| `media_public_url_missing_bucket` | the public URL is the path-style endpoint without `/<bucket>` |
| `media_public_url_mixed_content` | plain `http://` public URL on an `https://` site (browsers block or downgrade it) |

Warnings never block a save or a test: they name likely mistakes, not certain ones.

**Test connection** has the server write a small PNG probe object and read it back (using the unsaved
values on screen merged over the stored ones); then **your browser** loads the probe from the public URL
— from the viewer's network, exactly as visitors will fetch media — and the server deletes it, reporting
each step. The server never fetches the operator-typed public URL itself. (A plain-`http://` CDN that is
not saved yet is not in the admin page's CSP, so save first and test again.) `npm run media -- test`
does the server half: write, read, delete. The CLI's output is its stdout and only that — backend log
lines go to stderr — so `npm run media -- status | jq .state` works.

## Moving an existing library

Switching the driver to `s3` sends **new** uploads to the bucket immediately; files already on disk keep
working through the redirect only on the node that has them. Move them with the screen's buttons or the
CLI:

```bash
npm run media -- status
npm run media -- test                     # write, read and delete a probe object
npm run media -- offload                  # copy every public attachment's files to the bucket
npm run media -- offload --delete-local   # …and delete each local copy once its object verified
npm run media -- restore                  # copy them back to local disk (nothing is deleted from the bucket)
```

Both directions are **idempotent** (an item already where it belongs is skipped; an object already in
the bucket with the same size is not uploaded again) and **resumable** (progress — the last attachment
finished, counters, failures — is the `media_storage_migration` option; an interrupted run continues from
its cursor, `--restart` walks from the start; `--limit N` processes N items and stops). One run at a time
across the cluster (`core/dist-lock` on Postgres/MySQL, a process flag on SQLite). A running migration
refreshes its progress record at least every 30 s, so every node — not only the one running it — answers
`409 rest_media_storage_busy` to a second start and reports `running: true`; a `running` record nobody
has refreshed for two minutes is shown as `interrupted` (and resumes on the next start). Attachments imported
in WXR **link** mode (bytes on the old site) are skipped.

The library **state** (`media_storage_state`): `local` → `migrating` → `offloaded` (only after a complete
run with no failures — this is what turns on the SSR rewrite) → `restoring` → `local`. A restore flips the
state back FIRST, so no page is rendered against a bucket being drained. Switching the driver back to
`local` is refused (409 `rest_media_storage_in_use`) while any attachment still has its files in the
bucket.

## Multi-node and the three deploy modes

With offload on, backend nodes **do not need a shared `uploads/` directory for media**: every node writes
new uploads to the bucket, reads the marker from the shared database, and redirects any `/uploads` path
it does not hold to the CDN. (Fonts, themes, plugins, backups and certificates still live on disk — see
[multi-node.md](multi-node.md).) The `mediaStorage` block is per node like the rest of
`wordjs-config.json`: share the file or set the `WORDJS_MEDIA_*` env vars identically on every backend. In
split and separate mode a frontend replica that cannot read the backend's config learns the CSP origin
from the settings it renders with; set `WORDJS_MEDIA_CDN_ORIGIN` on it to have it from the first
response.

Monolith, split and separate mode use the same code paths (the backend writes and redirects; the frontend
server amends the CSP and the SSR rewrites URLs). Verify all three on a staging deployment before
switching a production site.

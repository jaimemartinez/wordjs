/**
 * WordJS - Private media
 *
 * WHY THIS EXISTS. Every attachment used to be public by construction: its bytes were written under
 * `config.uploads.dir`, which index.ts publishes at /uploads with no authentication (and with a one-year
 * `immutable` cache header), and its row was listed by the anonymous GET /api/v1/media. A plugin selling
 * files (digital-downloads) protected its products only by "never listing" a media-library URL — but the
 * core media API listed it for anyone, so every paid product was one anonymous request away, and once a
 * buyer learned the URL the link's expiry and use limit meant nothing.
 *
 * WHAT "PRIVATE" MEANS. A private attachment is an `attachment` row with post_status = 'private' (instead
 * of the usual 'inherit') whose files live under `config.uploads.privateDir`, a directory NO static
 * handler mounts. Because every public media query is pinned to status 'inherit', a private row drops out
 * of the anonymous list, of GET /media/:id, of /posts (anonymous callers only ever see 'publish'), of
 * sitemaps, feeds and search, with no per-surface filter to forget. Its bytes leave the server only
 * through two host-mediated paths, both of which stream from disk with download-only headers:
 *
 *   - GET /api/v1/media/:id/file — for a logged-in user who may edit the item (the admin media UI);
 *   - a plugin route that replies with `res.sendPrivateMedia(id)` — only when the administrator granted
 *     that plugin the default-deny `media:private_read` permission (core/plugin-isolate.ts). The plugin
 *     decides WHO gets the file (e.g. a paid, unexpired, not-exhausted download token); the host decides
 *     HOW it is delivered, so the plugin never learns, or leaks, a permanent URL.
 */

import type { Response } from 'express';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config/app');
const { resolveWithin } = require('./safe-path');

/** The post_status that marks an attachment as private. */
const PRIVATE_ATTACHMENT_STATUS = 'private';
/** The post_status every ordinary (public) attachment carries. */
const PUBLIC_ATTACHMENT_STATUS = 'inherit';

/**
 * Hard ceiling on what a host-mediated download will stream. Uploads are already bounded by
 * config.uploads.maxFileSize at write time; this bounds what a file planted or grown on disk by other
 * means can make the host stream through one request.
 */
const PRIVATE_STREAM_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** The absolute root private media is stored under. Read at call time so tests can repoint it. */
function privateUploadsRoot(): string {
    return path.resolve(config.uploads.privateDir || './data/private-uploads');
}

/** The absolute root public media is stored under (the tree index.ts serves at /uploads). */
function publicUploadsRoot(): string {
    return path.resolve(config.uploads.dir);
}

/** Root for one visibility. */
function uploadsRootFor(isPrivate: boolean): string {
    return isPrivate ? privateUploadsRoot() : publicUploadsRoot();
}

/** True when a raw post row / Post instance / formatted media object is a private attachment. */
function isPrivateAttachment(item: any): boolean {
    if (!item) return false;
    if (item.visibility) return item.visibility === 'private';
    const status = item.postStatus !== undefined ? item.postStatus : item.post_status;
    const type = item.postType !== undefined ? item.postType : item.post_type;
    return status === PRIVATE_ATTACHMENT_STATUS && (type === undefined || type === 'attachment');
}

/**
 * The URL the admin UI uses for a private item. It is an AUTHENTICATED API route, never a static path,
 * so publishing it (e.g. by inserting it into a page) does not publish the bytes.
 */
function privateFileUrl(id: number): string {
    const prefix = (config.api && config.api.prefix) || '/api/v1';
    return `${prefix}/media/${Number(id)}/file`;
}

/**
 * May this user read this private item's bytes and metadata? Same ownership rule as PUT /media/:id:
 * the uploader needs upload_files, anybody else needs the cross-user edit_others_posts.
 */
function canAccessPrivateMedia(user: any, media: any): boolean {
    if (!user || !media) return false;
    const authorId = media.author !== undefined ? media.author : media.authorId;
    return authorId === user.id ? !!user.can('upload_files') : !!user.can('edit_others_posts');
}

/** Resolve the stored relative path of an attachment under `root`, proving containment. */
function resolveStoredFile(root: string, storedFile: unknown): string | null {
    if (typeof storedFile !== 'string' || !storedFile) return null;
    const segments = storedFile.split(/[/\\]+/).filter((s: string) => s.length > 0);
    if (!segments.length) return null;
    return resolveWithin(root, ...segments);
}

/**
 * Remove any AVIF/WebP derivative middleware/image-negotiation cached for a file that is about to stop
 * being public. The cache is unreachable once the source leaves /uploads (the middleware stats the
 * source first), but private bytes should not linger in the public tree in any form.
 */
function purgeNegotiationCache(relativeFiles: string[]): void {
    const cacheRoot = path.join(publicUploadsRoot(), '.derivatives');
    for (const rel of relativeFiles) {
        const normalized = path.posix.normalize(String(rel).replace(/\\/g, '/')).replace(/^\/+/, '');
        for (const fmt of ['avif', 'webp']) {
            const key = crypto.createHash('sha256').update(normalized + '|' + fmt).digest('hex');
            const target = path.join(cacheRoot, key.slice(0, 2), key + '.' + fmt);
            try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch { /* best effort */ }
        }
    }
}

/** Move one file, falling back to copy+unlink across devices (data/ and uploads/ may be two volumes). */
function moveFile(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.renameSync(from, to);
    } catch (e: any) {
        if (e && e.code === 'EXDEV') {
            fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
            fs.unlinkSync(from);
        } else {
            throw e;
        }
    }
}

/**
 * Move every file of an attachment between the two roots. `pairs` are [from, to] absolute paths, already
 * proven to be inside their roots. All-or-nothing: on any failure the files already moved go back.
 */
function moveAttachmentFiles(pairs: Array<[string, string]>): void {
    const moved: Array<[string, string]> = [];
    try {
        for (const [from, to] of pairs) {
            if (!fs.existsSync(from)) continue; // a size that was never written (or already gone)
            if (fs.existsSync(to)) throw new Error(`Refusing to overwrite an existing file while changing media visibility: ${to}`);
            moveFile(from, to);
            moved.push([from, to]);
        }
    } catch (e) {
        for (const [from, to] of moved.reverse()) {
            try { moveFile(to, from); } catch (err: any) { console.error(`[private-media] rollback failed for ${to}: ${err?.message || err}`); }
        }
        throw e;
    }
}

/** A Content-Type that can never be rendered as an active document. */
function downloadContentType(mimeType: unknown): string {
    const mime = String(mimeType || '').toLowerCase();
    const Media = require('../models/Media');
    if (!mime || !Media.isAllowedMimeType(mime) || mime === 'image/svg+xml' || /html|xml|javascript/.test(mime)) {
        return 'application/octet-stream';
    }
    return mime;
}

/** A download file name: plain characters only, and always the stored file's own extension. */
function downloadFileName(requested: unknown, storedFile: string): string {
    const storedExt = path.extname(storedFile).toLowerCase();
    const fallback = path.basename(storedFile);
    let name = typeof requested === 'string' ? requested : '';
    name = name.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/[^A-Za-z0-9._ -]/g, '-').replace(/\s+/g, ' ').trim();
    name = name.replace(/^\.+/, '').slice(0, 120);
    if (!name) return fallback;
    if (path.extname(name).toLowerCase() !== storedExt) name = `${name}${storedExt}`;
    return name;
}

/** Public, path-free description of a private attachment (what a plugin may learn about it). */
async function describePrivateMedia(id: unknown): Promise<null | { id: number; title: string; mimeType: string; filesize: number; filename: string }> {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    const Media = require('../models/Media');
    const media = await Media.findById(n);
    if (!media || media.visibility !== 'private') return null;
    const stored = String(media.mediaDetails?.file || '');
    const file = resolveStoredFile(privateUploadsRoot(), stored);
    if (!file) return null;
    let size: number;
    try {
        const st = fs.statSync(file);
        if (!st.isFile()) return null;
        size = st.size;
    } catch { return null; }
    return {
        id: media.id,
        title: String(media.title || ''),
        mimeType: String(media.mimeType || ''),
        filesize: size,
        filename: path.basename(stored),
    };
}

/**
 * Stream a PRIVATE attachment's bytes as the response. Never serves a public attachment (those already
 * have a URL) and never reveals where the file lives. Answers a JSON 404 for anything it will not serve.
 *
 * Headers: Content-Disposition: attachment (never rendered in this origin), nosniff, a sandbox CSP,
 * `Cache-Control: no-store` (a token-gated download must not be replayed from a shared cache), noindex.
 */
async function streamPrivateMedia(res: Response, id: unknown, opts: { filename?: unknown } = {}): Promise<void> {
    const notFound = () => {
        if (!res.headersSent) res.status(404).json({ code: 'rest_media_unavailable', message: 'File not available.', data: { status: 404 } });
    };
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n < 1) return notFound();
    const Media = require('../models/Media');
    const media = await Media.findById(n);
    if (!media || media.visibility !== 'private') return notFound();
    const stored = String(media.mediaDetails?.file || '');
    const file = resolveStoredFile(privateUploadsRoot(), stored);
    if (!file) return notFound();

    let fd: number;
    let size: number;
    try {
        // Open once and serve THAT descriptor, so the file checked is the file streamed.
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile()) { fs.closeSync(fd); return notFound(); }
        size = st.size;
    } catch { return notFound(); }
    if (size > PRIVATE_STREAM_MAX_BYTES) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        res.status(413).json({ code: 'rest_media_too_large', message: 'File too large to deliver.', data: { status: 413 } });
        return;
    }

    const name = downloadFileName(opts.filename, stored);
    res.status(200);
    res.attachment(name); // RFC 6266 Content-Disposition with a safe filename* fallback
    res.setHeader('Content-Type', downloadContentType(media.mimeType));
    res.setHeader('Content-Length', String(size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    for (const h of ['ETag', 'Last-Modified', 'Content-Encoding', 'Content-Range']) res.removeHeader(h);

    await new Promise<void>((resolve) => {
        const stream = fs.createReadStream('', { fd, autoClose: true });
        const done = () => resolve();
        stream.on('error', () => { res.destroy(); done(); });
        res.on('close', () => { stream.destroy(); done(); });
        res.on('finish', done);
        stream.pipe(res);
    });
}

module.exports = {
    PRIVATE_ATTACHMENT_STATUS,
    PUBLIC_ATTACHMENT_STATUS,
    PRIVATE_STREAM_MAX_BYTES,
    privateUploadsRoot,
    publicUploadsRoot,
    uploadsRootFor,
    isPrivateAttachment,
    privateFileUrl,
    canAccessPrivateMedia,
    resolveStoredFile,
    purgeNegotiationCache,
    moveAttachmentFiles,
    downloadContentType,
    downloadFileName,
    describePrivateMedia,
    streamPrivateMedia,
};

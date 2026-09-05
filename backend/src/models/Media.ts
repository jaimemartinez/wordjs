/**
 * WordJS - Media Model
 * For handling file uploads and media library
 */

const database = require('../config/database');
const { db, dbAsync } = database;
const Post = require('./Post');
const config = require('../config/app');
const path = require('path');
const fs = require('fs');
// The ONE place a stored name becomes a path. This file used to build its unlink() targets with
// path.join() on a value read straight out of post_meta — see Media._deletableFiles below.
const { resolveWithin } = require('../core/safe-path');
const { runContentMutation, isContentMutationActive } = require('../core/content-outbox');

/**
 * Where a `link`-mode WXR import records that an attachment's bytes live on ANOTHER host.
 *
 * The literal is duplicated from core/wxr-media's REMOTE_URL_META_KEY deliberately, and only here: that
 * module requires THIS one, so requiring it back would be the io-guard cycle again. The key is
 * server-owned (core/protected-meta's PROTECTED_POST_META), so no route's generic meta bag and no third
 * party's `wp:postmeta` can author one — which is what makes it usable as an ownership marker rather
 * than as a hint. wxr-import.test.ts pins the two spellings against each other end to end.
 */
const REMOTE_SOURCE_META_KEY = '_wxr_remote_url';

class Media {
    /**
     * Create a media attachment
     * This creates a post of type 'attachment'
     */
    static async create(data: any) {
        if (!isContentMutationActive()) return await runContentMutation(() => Media.create(data));
        const {
            authorId,
            title,
            filename,
            mimeType,
            filePath,
            fileSize,
            width,
            height,
            sizes = {},
            // Modern-format derivatives of the FULL-SIZE original, keyed by MIME type
            // (`{'image/webp': {file, width, height, mimeType, filesize}, …}`). Per-size derivatives
            // ride inside their own `sizes[<name>].sources`. Both are ADDITIVE: an attachment written
            // before this feature simply has neither key and every reader falls back to the original
            // format, which is what it already did.
            sources = {},
            description = '',
            caption = '',
            alt = ''
        } = data;

        // Create attachment post
        const attachment = await Post.create({
            authorId,
            title: title || filename,
            content: description,
            excerpt: caption,
            status: 'inherit',
            type: 'attachment',
            mimeType
        });

        // Update GUID to relative path (portable across domains)
        const relativePath = `/uploads/${filename}`;
        await dbAsync.run('UPDATE posts SET guid = ? WHERE id = ?', [relativePath, attachment.id]);

        // Store attachment metadata
        const metadata = {
            file: filePath,
            width: width || 0,
            height: height || 0,
            filesize: fileSize,
            sizes: sizes || {},
            sources: sources || {}
        };

        await Post.updateMeta(attachment.id, '_wp_attachment_metadata', metadata);
        await Post.updateMeta(attachment.id, '_wp_attached_file', filename);

        if (alt) {
            await Post.updateMeta(attachment.id, '_wp_attachment_image_alt', alt);
        }

        return await Media.findById(attachment.id);
    }

    /**
     * Find media by ID
     */
    static async findById(id: number) {
        const post = await Post.findById(id);
        if (!post || post.postType !== 'attachment') return null;
        return await Media.formatAttachment(post);
    }

    /**
     * Get all media
     */
    static async findAll(options = {}) {
        const posts = await Post.findAll({
            ...options,
            type: 'attachment',
            status: 'inherit'
        });

        // Bulk-hydrate all post meta in ONE query, then format from each bucket
        // (avoids 3 getMeta queries per attachment).
        const metaById = await Post.getAllMetaForIds(posts.map((p: any) => p.id));
        return await Promise.all(posts.map((post: any) => Media.formatAttachment(post, metaById[post.id] || {})));
    }

    /**
     * Format attachment post to media object
     */
    static async formatAttachment(post: any, meta = null) {
        // Read all three keys from ONE meta bucket. For list paths the caller passes
        // a pre-hydrated bucket (Post.getAllMetaForIds); for single lookups we fetch
        // all of this post's meta once instead of three sequential getMeta() queries.
        const allMeta = meta || (await Post.getAllMeta(post.id));
        const metadata = allMeta['_wp_attachment_metadata'] || {};
        const attachedFile = allMeta['_wp_attached_file'] || '';
        const alt = allMeta['_wp_attachment_image_alt'] || '';

        // AN ATTACHMENT WHOSE BYTES ARE SOMEWHERE ELSE. The WXR importer's `link` mode creates the row
        // and deliberately downloads nothing, so the file lives on the OLD site. Its guid holds the
        // remote URL, but the normalization below rewrites ANY absolute guid containing '/uploads/' into
        // a local path — and a stock WordPress URL (https://old/wp-content/uploads/...) contains exactly
        // that, so every linked attachment resolved to a local file that was never fetched: a 404 on the
        // standard layout, counted as a successful import. core/wxr-media therefore stamps the remote URL
        // under a key of its own, and it WINS here. Only that key is trusted (it is server-owned, in
        // core/protected-meta's PROTECTED_POST_META); the guid normalization below is untouched, because
        // it is what makes an ordinary attachment portable when the site moves domain.
        const remoteSource = allMeta[REMOTE_SOURCE_META_KEY];
        const remoteUrl = typeof remoteSource === 'string' && /^https?:\/\//i.test(remoteSource)
            ? remoteSource
            : '';

        // DYNAMIC URL RESOLUTION:
        // The 'guid' field stores a relative path (e.g., /uploads/image.jpg)
        // We construct the full URL dynamically using current site config.
        // This makes the system fully portable across domains.
        let relativePath = post.guid || '';

        if (remoteUrl) {
            relativePath = remoteUrl;
        } else if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
            // Handle legacy absolute URLs by extracting relative path
            const urlMatch = relativePath.match(/\/uploads\/.+$/);
            relativePath = urlMatch ? urlMatch[0] : `/uploads/${attachedFile}`;
        } else if (attachedFile && !relativePath.startsWith('/uploads')) {
            // Fallback: construct from attached file
            const safePath = attachedFile.replace(/\\/g, '/');
            relativePath = `/uploads/${safePath}`;
        }

        // Build absolute URL for API response (a linked attachment is already absolute, and elsewhere)
        const absoluteUrl = remoteUrl || `${config.site.url}${relativePath}`;

        return {
            id: post.id,
            date: post.postDate,
            dateGmt: post.postDateGmt,
            modified: post.postModified,
            modifiedGmt: post.postModifiedGmt,
            slug: post.postName,
            title: post.postTitle,
            description: post.postContent,
            caption: post.postExcerpt,
            alt,
            author: post.authorId,
            // Parent post this attachment is attached to (0 = unattached). Attachments carry
            // post_status='inherit', so their visibility is derived from this parent — the media
            // route uses it to hide draft/private-parented attachments from non-owners.
            parent: post.postParent || 0,
            mimeType: post.postMimeType,
            guid: absoluteUrl,      // RSS requires absolute URLs (globally unique)
            sourceUrl: relativePath, // Use relative path (e.g. /uploads/file.jpg) for internal app flexibility
            relativePath,           // Explicit relative path
            mediaDetails: {
                width: metadata.width || 0,
                height: metadata.height || 0,
                file: attachedFile || metadata.file || '',
                filesize: metadata.filesize || 0,
                sizes: metadata.sizes || {},
                // Modern-format derivatives of the full-size original (`{}` for anything uploaded
                // before the feature, or on a host whose sharp cannot write them).
                sources: metadata.sources || {}
            }
        };
    }

    /**
     * Update media
     */
    static async update(id: number, data: any) {
        if (!isContentMutationActive()) return await runContentMutation(() => Media.update(id, data));
        const media = await Media.findById(id);
        if (!media) throw new Error('Media not found');

        const updates: any = {};

        if (data.title !== undefined) updates.title = data.title;
        if (data.description !== undefined) updates.content = data.description;
        if (data.caption !== undefined) updates.excerpt = data.caption;

        if (Object.keys(updates).length > 0) {
            await Post.update(id, updates);
        }

        if (data.alt !== undefined) {
            await Post.updateMeta(id, '_wp_attachment_image_alt', data.alt);
        }

        return await Media.findById(id);
    }

    /**
     * Resolve the absolute files a delete may unlink, PROVING every one of them lives under the
     * uploads directory. Returns [] when nothing may be touched.
     *
     * WHAT THE OLD CODE DID WRONG. Media.delete() built its targets as
     * `path.join(config.uploads.dir, media.mediaDetails.file)` and then
     * `path.join(path.dirname(thatPath), size.file)`. `mediaDetails.file` is the `_wp_attached_file`
     * post_meta value — and post_meta is writable through the generic post-meta routes by anyone who
     * may edit the attachment, i.e. the uploader themselves. `path.join()` HAPPILY normalizes `..`, so
     * a stored `../data/wordjs.db` produced a real path outside uploads and fs.unlinkSync() deleted it;
     * the fs.existsSync() guard in front turned the route into a file-existence oracle instead of an
     * error. The size loop was strictly worse: it based itself on path.dirname(mainPath), so ONE
     * poisoned main value moved the base for EVERY size entry — N arbitrary deletions per request.
     *
     * WHY THIS SHAPE IS CORRECT. Segments are validated as FORM (isPlainSegment, inside resolveWithin)
     * and containment is proved on the RESOLVED value against path.resolve(uploads.dir) — the two
     * halves core/safe-path exists to keep together, and which themes/certs/plugins already use. Every
     * size resolves against the uploads root plus the main file's ALREADY-PROVEN directory segments,
     * never against a dirname derived from an unvalidated string, so a size can no longer inherit an
     * escape. Failure is closed: if the main name does not resolve we return [] and delete NOTHING
     * (the DB row still goes, so a poisoned value cannot make an attachment undeletable); a single bad
     * size entry drops only itself, because each surviving path carries its own containment proof.
     */
    static _deletableFiles(storedFile: unknown, sizes: any, sources: any = null): string[] {
        if (typeof storedFile !== 'string' || storedFile.length === 0) return [];
        const uploadDir = path.resolve(config.uploads.dir);

        // Split on BOTH separators, not just '/': a legacy row written on Win32 can carry backslashes,
        // and splitting on them is safe precisely because each resulting segment must still pass
        // isPlainSegment (so `a\..\b` becomes ['a','..','b'] and is refused on the '..').
        const segments = storedFile.split(/[/\\]+/).filter((s: string) => s.length > 0);
        const mainPath = segments.length > 0 ? resolveWithin(uploadDir, ...segments) : null;
        if (!mainPath) {
            console.warn(`Media.delete: refusing to unlink an attachment path that escapes the uploads directory: ${JSON.stringify(storedFile)}`);
            return [];
        }

        const targets = [mainPath];
        // The main file's directory, as VALIDATED segments (e.g. ['2026','08']) — not as a dirname
        // string, which is how the escape used to propagate.
        const dirSegments = segments.slice(0, -1);

        // Every sibling file is resolved through THIS one helper, so a derivative can no more escape
        // than a size can: same uploads root, same already-proven directory segments, same per-path
        // containment proof, same drop-only-itself failure mode. The WebP/AVIF derivatives added in
        // 2026 are just more entries flowing through it — a new file kind must never grow a second,
        // weaker resolver.
        const pushSibling = (file: unknown, kind: string): void => {
            if (typeof file !== 'string' || file.length === 0) return;
            const fileSegments = file.split(/[/\\]+/).filter((s: string) => s.length > 0);
            const resolved = fileSegments.length > 0
                ? resolveWithin(uploadDir, ...dirSegments, ...fileSegments)
                : null;
            if (!resolved) {
                console.warn(`Media.delete: refusing to unlink a ${kind} path that escapes the uploads directory: ${JSON.stringify(file)}`);
                return;
            }
            targets.push(resolved);
        };

        /** The modern-format derivatives hanging off one metadata node (`{'image/webp': {file}, …}`). */
        const pushSources = (map: any): void => {
            for (const source of Object.values(map || {})) pushSibling((source as any)?.file, 'derivative');
        };

        for (const size of Object.values(sizes || {})) {
            pushSibling((size as any)?.file, 'size');
            pushSources((size as any)?.sources);
        }
        // …and the derivatives of the full-size original, which hang off the metadata root.
        pushSources(sources);
        return targets;
    }

    /**
     * Does this attachment's row OWN the file its `_wp_attached_file` names, or merely point at it?
     *
     * A row owns a file when something wrote one for it — an upload, or a `download`-mode WXR import,
     * which claims its path against the media library, the disk and the rest of its run before writing
     * a byte (core/wxr-media's claimRelativePath). `link` mode does none of that: it is the mode whose
     * whole point is that the bytes stay on the OLD host, so it creates the row, stamps the remote URL
     * here, and copies the WXR's own `_wp_attached_file` verbatim — an UNCLAIMED path, which a third
     * party's export is free to spell as `2025/01/photo.jpg` under the same YYYY/MM layout every
     * WordPress uses. That aliases whatever this install already keeps there, and deleting the imported
     * row then unlinked a REAL upload's bytes: the genuine attachment survived pointing at a file that
     * was gone, site-wide broken image, no warning. `_wp_attachment_metadata` widened it from one file
     * to a whole subtree, since every `sizes[*].file` resolves beside the main one.
     *
     * WHY THE MARKER AND NOT A CLAIM. Claiming the path in `link` mode would rename the row away from
     * the file it describes — and that path is the ONLY thing an operator copying `wp-content/uploads`
     * across by hand has to go on, which is the entire reason the mode exists. It would also protect
     * nothing already in the database. Ownership is created by WRITING a file, and this row never wrote
     * one, so the honest rule is the narrow one: the row goes, the bytes stay. The failure mode that
     * remains is a leaked file rather than a destroyed one, and it is the same one an operator who
     * never copied the uploads across already has.
     */
    static async _isRemotelyLinked(id: number): Promise<boolean> {
        const remote = await Post.getMeta(id, REMOTE_SOURCE_META_KEY);
        return typeof remote === 'string' && /^https?:\/\//i.test(remote);
    }

    /**
     * Delete media
     */
    static async delete(id: number, deleteFile = true) {
        if (!isContentMutationActive()) return await runContentMutation(() => Media.delete(id, deleteFile));
        const media = await Media.findById(id);
        if (!media) return false;

        // A LINKED ATTACHMENT OWNS NO LOCAL BYTES, so it may not unlink any — see _isRemotelyLinked.
        // Asked last, so a row with no path (or a caller that keeps the file) costs no extra query.
        const mayUnlink = deleteFile && !!media.mediaDetails.file && !(await Media._isRemotelyLinked(id));

        // Resolve targets while metadata still exists, but unlink only AFTER the database commits.
        // A rollback must never leave a live attachment row pointing at a file we already removed.
        if (mayUnlink) {
            const targets = Media._deletableFiles(media.mediaDetails.file, media.mediaDetails.sizes, media.mediaDetails.sources);
            database.afterCommit(() => {
                for (const target of targets) {
                    try { if (fs.existsSync(target)) fs.unlinkSync(target); }
                    catch (error: any) { console.warn(`Media.delete: post-commit unlink failed for ${target}: ${error?.message || error}`); }
                }
            });
        }

        // Delete the post
        return await Post.delete(id, true);
    }

    /**
     * Get media by post (attached to)
     */
    static async getByPost(postId: number) {
        const posts = await Post.findAll({
            type: 'attachment',
            parent: postId,
            status: 'inherit'
        });

        // Bulk-hydrate all post meta in ONE query, then format from each bucket
        // (avoids 3 getMeta queries per attachment).
        const metaById = await Post.getAllMetaForIds(posts.map((p: any) => p.id));
        return await Promise.all(posts.map((post: any) => Media.formatAttachment(post, metaById[post.id] || {})));
    }

    /**
     * Count media
     */
    static async count(options = {}) {
        // Mirror Media.findAll's WHERE exactly (it forces status: 'inherit' AFTER the
        // spread) so the pager total matches the listed rows. Without this, Post.count
        // defaults status to 'publish' and undercounts inherit-status attachments.
        return await Post.count({
            ...options,
            type: 'attachment',
            status: 'inherit'
        });
    }

    /**
     * Get allowed MIME types
     */
    static getAllowedMimeTypes() {
        return {
            // Images
            'jpg|jpeg|jpe': 'image/jpeg',
            'gif': 'image/gif',
            'png': 'image/png',
            'webp': 'image/webp',
            'ico': 'image/x-icon',
            'svg': 'image/svg+xml',

            // Documents
            'pdf': 'application/pdf',
            'doc': 'application/msword',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'xls': 'application/vnd.ms-excel',
            'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'ppt': 'application/vnd.ms-powerpoint',
            'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

            // Text
            'txt': 'text/plain',
            'csv': 'text/csv',
            'json': 'application/json',

            // Audio
            'mp3': 'audio/mpeg',
            'ogg': 'audio/ogg',
            'wav': 'audio/wav',

            // Video
            'mp4': 'video/mp4',
            'webm': 'video/webm',
            'ogv': 'video/ogg',

            // Archives
            'zip': 'application/zip',
            'rar': 'application/x-rar-compressed'
        };
    }

    /**
     * Check if MIME type is allowed
     */
    static isAllowedMimeType(mimeType: string) {
        const allowed = Object.values(Media.getAllowedMimeTypes());
        return allowed.includes(mimeType);
    }

    /**
     * Resolve the canonical, SAFE stored file extension for a given MIME type.
     *
     * SECURITY: The stored extension MUST be derived from the validated MIME type (the
     * allowlist below is the single source of truth) rather than from the client-supplied
     * filename — otherwise a "foo.php"/"foo.html" originalname could be persisted verbatim
     * and later served as executable/active content. Returns null when the MIME has no
     * mapped extension (caller must reject the upload) or when the resolved extension is on
     * the dangerous list.
     *
     * @param {string} mimeType
     * @returns {string|null} extension WITHOUT a leading dot (e.g. 'jpg'), or null
     */
    static getExtensionForMime(mimeType: string) {
        const map = Media.getAllowedMimeTypes();
        for (const [extKey, mime] of Object.entries(map)) {
            if (mime === mimeType) {
                // Keys may be alternation groups like 'jpg|jpeg|jpe' — take the first form.
                const ext = extKey.split('|')[0].toLowerCase();
                if (Media.isDangerousExtension(ext)) return null;
                return ext;
            }
        }
        return null;
    }

    /**
     * Extensions that must NEVER be persisted/served regardless of the declared MIME type
     * (active/executable content or XML that browsers may render in a dangerous context).
     * Note: 'svg' is intentionally NOT here — SVGs follow the admin-only + sanitization path
     * in the upload route; blocking them outright would break that allowed flow.
     *
     * @param {string} ext extension with or without a leading dot
     * @returns {boolean}
     */
    static isDangerousExtension(ext: string) {
        if (!ext) return false;
        const clean = String(ext).replace(/^\./, '').toLowerCase();
        const blocked = new Set([
            'html', 'htm', 'xhtml', 'shtml', 'shtm',
            'js', 'mjs', 'cjs',
            'xml',
            'php', 'phtml', 'php3', 'php4', 'php5', 'phar',
            'htaccess'
        ]);
        return blocked.has(clean);
    }
}

module.exports = Media;

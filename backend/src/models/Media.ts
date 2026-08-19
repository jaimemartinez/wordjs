/**
 * WordJS - Media Model
 * For handling file uploads and media library
 */

const { db, dbAsync } = require('../config/database');
const Post = require('./Post');
const config = require('../config/app');
const path = require('path');
const fs = require('fs');
// The ONE place a stored name becomes a path. This file used to build its unlink() targets with
// path.join() on a value read straight out of post_meta — see Media._deletableFiles below.
const { resolveWithin } = require('../core/safe-path');

class Media {
    /**
     * Create a media attachment
     * This creates a post of type 'attachment'
     */
    static async create(data: any) {
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
            sizes: sizes || {}
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

        // DYNAMIC URL RESOLUTION:
        // The 'guid' field stores a relative path (e.g., /uploads/image.jpg)
        // We construct the full URL dynamically using current site config.
        // This makes the system fully portable across domains.
        let relativePath = post.guid || '';

        // Handle legacy absolute URLs by extracting relative path
        if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
            const urlMatch = relativePath.match(/\/uploads\/.+$/);
            relativePath = urlMatch ? urlMatch[0] : `/uploads/${attachedFile}`;
        } else if (attachedFile && !relativePath.startsWith('/uploads')) {
            // Fallback: construct from attached file
            const safePath = attachedFile.replace(/\\/g, '/');
            relativePath = `/uploads/${safePath}`;
        }

        // Build absolute URL for API response
        const absoluteUrl = `${config.site.url}${relativePath}`;

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
                sizes: metadata.sizes || {}
            }
        };
    }

    /**
     * Update media
     */
    static async update(id: number, data: any) {
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
    static _deletableFiles(storedFile: unknown, sizes: any): string[] {
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
        for (const size of Object.values(sizes || {})) {
            const file = (size as any)?.file;
            if (typeof file !== 'string' || file.length === 0) continue;
            const sizeSegments = file.split(/[/\\]+/).filter((s: string) => s.length > 0);
            const sizePath = sizeSegments.length > 0
                ? resolveWithin(uploadDir, ...dirSegments, ...sizeSegments)
                : null;
            if (!sizePath) {
                console.warn(`Media.delete: refusing to unlink a size path that escapes the uploads directory: ${JSON.stringify(file)}`);
                continue;
            }
            targets.push(sizePath);
        }
        return targets;
    }

    /**
     * Delete media
     */
    static async delete(id: number, deleteFile = true) {
        const media = await Media.findById(id);
        if (!media) return false;

        // Delete the actual file and its sizes — every target proven to live under uploads/ first.
        if (deleteFile && media.mediaDetails.file) {
            for (const target of Media._deletableFiles(media.mediaDetails.file, media.mediaDetails.sizes)) {
                if (fs.existsSync(target)) {
                    fs.unlinkSync(target);
                }
            }
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

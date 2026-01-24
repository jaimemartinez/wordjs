/**
 * WordJS - Media Model
 * For handling file uploads and media library
 */

const { db, dbAsync } = require('../config/database');
const Post = require('./Post');
const config = require('../config/app');
const path = require('path');
const fs = require('fs');

class Media {
    /**
     * Create a media attachment
     * This creates a post of type 'attachment'
     */
    static async create(data) {
        const {
            authorId,
            title,
            filename,
            mimeType,
            filePath,
            fileSize,
            width,
            height,
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
            sizes: {}
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
    static async findById(id) {
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

        // Parallel format
        return await Promise.all(posts.map(post => Media.formatAttachment(post)));
    }

    /**
     * Format attachment post to media object
     */
    static async formatAttachment(post) {
        // Parallel meta fetch if possible, but getMeta is simple
        const metadata = (await Post.getMeta(post.id, '_wp_attachment_metadata')) || {};
        const attachedFile = (await Post.getMeta(post.id, '_wp_attached_file')) || '';
        const alt = (await Post.getMeta(post.id, '_wp_attachment_image_alt')) || '';

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
    static async update(id, data) {
        const media = await Media.findById(id);
        if (!media) throw new Error('Media not found');

        const updates = {};

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
     * Delete media
     */
    static async delete(id, deleteFile = true) {
        const media = await Media.findById(id);
        if (!media) return false;

        // Delete the actual file
        if (deleteFile && media.mediaDetails.file) {
            const filePath = path.join(config.uploads.dir, media.mediaDetails.file);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        // Delete the post
        return await Post.delete(id, true);
    }

    /**
     * Get media by post (attached to)
     */
    static async getByPost(postId) {
        const posts = await Post.findAll({
            type: 'attachment',
            parent: postId,
            status: 'inherit'
        });

        return await Promise.all(posts.map(post => Media.formatAttachment(post)));
    }

    /**
     * Count media
     */
    static async count(options = {}) {
        return await Post.count({
            ...options,
            type: 'attachment'
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
    static isAllowedMimeType(mimeType) {
        const allowed = Object.values(Media.getAllowedMimeTypes());
        return allowed.includes(mimeType);
    }
}

module.exports = Media;

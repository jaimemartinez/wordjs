/**
 * WordJS - SEO Routes
 * Endpoints for sitemap.xml, robots.txt, and SEO-related endpoints
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const { getOption } = require('../core/options');
const { generateSitemap, generateRobotsTxt, generateRssFeed } = require('../core/seo-helper');
const { toLanguageTag } = require('../core/language-tag');
const { authenticate } = require('../middleware/auth');
const { can } = require('../middleware/permissions');

/**
 * @swagger
 * tags:
 *   name: SEO
 *   description: Search Engine Optimization endpoints
 */

/**
 * Is this RAW `post_meta.meta_value` the author's "hide from search engines" flag?
 *
 * The value arrives straight from SQL (no model layer, so no JSON.parse): the editor stores a
 * boolean, which Post.updateMeta String()s to `'true'` / `'false'`, while imported and legacy
 * content uses `1` / `'yes'` / `'on'`. Everything else — an absent row, `'false'`, `'0'`, junk —
 * means indexable. Deliberately fail-OPEN: reading "hidden" out of a value nobody recognises would
 * silently pull a live page out of the sitemap.
 */
function isNoindexMeta(value: any): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    // A value written through JSON.stringify arrives quoted (`"true"`) — unwrap before comparing.
    const normalized = value.trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase();
    return ['true', '1', 'yes', 'on'].includes(normalized);
}

/**
 * @swagger
 * /seo/sitemap.xml:
 *   get:
 *     summary: Get dynamic XML sitemap
 *     tags: [SEO]
 *     responses:
 *       200:
 *         description: XML sitemap
 *         content:
 *           application/xml:
 *             schema:
 *               type: string
 */
router.get('/sitemap.xml', async (req: Request, res: Response) => {
    try {
        // Get site URL
        const siteUrl = await getOption('siteurl', `${req.protocol}://${req.get('host')}`);

        // Only the columns the sitemap prints — findAll dragged up to 10 000 FULL rows
        // (post_content included) through the model layer to emit slug + lastmod.
        //
        // Plus the ONE meta the sitemap has to obey: `noindex`. A post the author hid from search
        // engines must not be SUBMITTED to them either — generateSitemap has always skipped
        // `post.noindex`, but nothing ever selected it, so the flag was permanently undefined.
        // A correlated scalar subquery, not a JOIN: post_meta has no UNIQUE (post_id, meta_key)
        // on legacy installs, and a duplicate row would print the same <url> twice.
        const { dbAsync } = require('../config/database');
        const rows = await dbAsync.all(
            "SELECT p.post_name, p.post_type, p.post_status, p.post_modified, p.post_date, " +
            "(SELECT pm.meta_value FROM post_meta pm WHERE pm.post_id = p.id AND pm.meta_key = 'noindex' LIMIT 1) AS noindex_meta " +
            "FROM posts p " +
            "WHERE p.post_type IN ('post', 'page') AND p.post_status = 'publish' " +
            "ORDER BY p.post_date DESC LIMIT 10000"
        );
        const posts = rows.map((r: any) => ({
            postName: r.post_name, postType: r.post_type, postStatus: r.post_status,
            postModified: r.post_modified, postDate: r.post_date,
            noindex: isNoindexMeta(r.noindex_meta),
        }));

        const xml = await generateSitemap(posts, { siteUrl });

        res.set('Content-Type', 'application/xml');
        res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        res.send(xml);
    } catch (error) {
        console.error('Sitemap error:', error);
        res.status(500).send('Error generating sitemap');
    }
});

/**
 * @swagger
 * /seo/robots.txt:
 *   get:
 *     summary: Get dynamic robots.txt
 *     tags: [SEO]
 *     responses:
 *       200:
 *         description: robots.txt content
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
router.get('/robots.txt', async (req: Request, res: Response) => {
    try {
        const siteUrl = await getOption('siteurl', `${req.protocol}://${req.get('host')}`);
        const robotsTxt = generateRobotsTxt(siteUrl);

        res.set('Content-Type', 'text/plain');
        res.set('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
        res.send(robotsTxt);
    } catch (error) {
        console.error('Robots.txt error:', error);
        res.status(500).send('Error generating robots.txt');
    }
});

/**
 * @swagger
 * /seo/feed.xml:
 *   get:
 *     summary: RSS 2.0 feed of the latest published posts
 *     tags: [SEO]
 *     responses:
 *       200:
 *         description: RSS feed
 *         content:
 *           application/rss+xml:
 *             schema:
 *               type: string
 */
router.get('/feed.xml', async (req: Request, res: Response) => {
    try {
        const siteUrl = await getOption('siteurl', `${req.protocol}://${req.get('host')}`);
        const title = await getOption('blogname', 'WordJS Site');
        const description = await getOption('blogdescription', '');
        // WPLANG holds a LOCALE (`en_US` — locale files are named by that exact
        // spelling); RSS <language> wants a BCP 47 TAG, whose subtag separator is a hyphen. Convert
        // here, at the boundary, instead of storing a second spelling that could drift from the first.
        const language = toLanguageTag(await getOption('WPLANG', 'en'));

        const posts = await Post.findAll({ type: 'post', status: 'publish', limit: 20 });
        const xml = generateRssFeed(posts, { siteUrl, title, description, language });

        res.set('Content-Type', 'application/rss+xml; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=900'); // 15 min
        res.send(xml);
    } catch (error) {
        console.error('RSS feed error:', error);
        res.status(500).send('Error generating feed');
    }
});

/**
 * @swagger
 * /seo/meta/{postId}:
 *   get:
 *     summary: Get SEO metadata for a post (Admin Preview)
 *     tags: [SEO]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: postId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: SEO metadata
 */
router.get('/meta/:postId', authenticate, can('edit_posts'), async (req: any, res: Response) => {
    try {
        const postId = parseInt(req.params.postId, 10);
        if (!postId) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const post = await Post.findById(postId);

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        // SECURITY: this is an admin-preview contract (security: bearerAuth in the swagger). It was
        // registered with NO middleware, leaking unpublished title/excerpt/keywords to anyone. Require
        // auth + edit_posts above; additionally hide non-published posts authored by others from a
        // non-privileged editor.
        if (post.postStatus !== 'publish') {
            const isOwner = post.authorId === req.user.id;
            if (!isOwner && !req.user.can('edit_others_posts')) {
                return res.status(404).json({ error: 'Post not found' });
            }
        }

        res.json({
            title: post.seo_title || post.postTitle || post.title,
            description: post.seo_description || post.postExcerpt || post.excerpt || '',
            keywords: post.seo_keywords || '',
            og_image: post.og_image || post.featured_image || '',
            noindex: post.noindex || false,
            canonical: `/${post.postName || post.slug}` // live canonical is /<slug> for posts AND pages
        });
    } catch (error) {
        console.error('SEO meta error:', error);
        res.status(500).json({ error: 'Error fetching SEO data' });
    }
});

module.exports = router;

/**
 * WordJS - SEO Routes
 * Endpoints for sitemap.xml, robots.txt, and SEO-related endpoints
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const { getOption } = require('../core/options');
const { generateSitemap, generateRobotsTxt } = require('../core/seo-helper');
const { authenticate } = require('../middleware/auth');
const { can } = require('../middleware/permissions');

/**
 * @swagger
 * tags:
 *   name: SEO
 *   description: Search Engine Optimization endpoints
 */

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

        // Get all published posts and pages
        const posts = await Post.findAll({
            type: ['post', 'page'],
            status: 'publish',
            limit: 10000 // Get all reasonably
        });

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
            canonical: `/${(post.postType || post.type) === 'page' ? '' : 'blog/'}${post.postName || post.slug}`
        });
    } catch (error) {
        console.error('SEO meta error:', error);
        res.status(500).json({ error: 'Error fetching SEO data' });
    }
});

module.exports = router;

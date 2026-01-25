/**
 * WordJS - SEO Routes
 * Endpoints for sitemap.xml, robots.txt, and SEO-related endpoints
 */

const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const { getOption } = require('../core/options');
const { generateSitemap, generateRobotsTxt } = require('../core/seo-helper');

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
router.get('/sitemap.xml', async (req, res) => {
    try {
        // Get site URL
        const siteUrl = await getOption('siteurl', `${req.protocol}://${req.get('host')}`);

        // Get all published posts and pages
        const posts = await Post.findAll({
            status: 'publish',
            per_page: 10000 // Get all
        });

        const xml = await generateSitemap(posts.posts, { siteUrl });

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
router.get('/robots.txt', async (req, res) => {
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
router.get('/meta/:postId', async (req, res) => {
    try {
        const post = await Post.findById(req.params.postId);

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        res.json({
            title: post.seo_title || post.title,
            description: post.seo_description || post.excerpt || '',
            keywords: post.seo_keywords || '',
            og_image: post.og_image || post.featured_image || '',
            noindex: post.noindex || false,
            canonical: `/${post.type === 'page' ? '' : 'blog/'}${post.slug}`
        });
    } catch (error) {
        console.error('SEO meta error:', error);
        res.status(500).json({ error: 'Error fetching SEO data' });
    }
});

module.exports = router;

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
 * GET /sitemap.xml
 * Generate dynamic XML sitemap
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
 * GET /robots.txt
 * Generate dynamic robots.txt
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
 * GET /api/v1/seo/meta/:postId
 * Get SEO meta data for a post (for admin preview)
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

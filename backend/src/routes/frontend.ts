/**
 * WordJS - Frontend Router
 * Handles all public web requests and renders them using the active theme.
 */

const express = require('express');
const router = express.Router();
const themeEngine = require('../core/theme-engine');
const Post = require('../models/Post');
const Term = require('../models/Term');
const { getOption } = require('../core/options');

/**
 * Catch-all route for public site
 */
router.get(['/', '/:slug', '/category/:slug', '/tag/:slug'], async (req, res, next) => {
    // Skip if it's an API request or static file (should be handled by other routers)
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.indexOf('.') !== -1) {
        return next();
    }

    try {
        const { slug } = req.params;
        const currentPath = req.path;

        let template = 'index';
        let data = {};

        // 1. Handle Home Page
        if (currentPath === '/' || !slug) {
            const posts = await Post.findAll({ status: 'publish', type: 'post' });
            data = {
                posts: posts.map(p => ({
                    title: p.post_title,
                    slug: p.post_name,
                    excerpt: p.post_excerpt || p.post_content.substring(0, 200) + '...',
                    author: p.author_name,
                    date: p.post_date
                })),
                isHome: true
            };
            template = 'index';
        }
        // 2. Handle Category/Tag
        else if (currentPath.startsWith('/category/') || currentPath.startsWith('/tag/')) {
            const taxonomy = currentPath.startsWith('/category/') ? 'category' : 'post_tag';
            const term = await Term.findOne({ slug, taxonomy });

            if (!term) return res.status(404).send('Not Found');

            const posts = await Post.findByTerm(term.id);
            data = {
                term,
                posts,
                isArchive: true
            };
            template = 'archive';
        }
        // 3. Handle Single Post/Page
        else {
            const post = await Post.findBySlug(slug);

            if (!post) {
                // Check if it's a special route or redirect?
                return next();
            }

            // Hydrate meta
            const meta = await Post.getAllMeta(post.id);

            data = {
                title: post.post_title,
                content: post.post_content,
                author: post.author_name,
                date: post.post_date,
                post: {
                    ...post,
                    meta: meta
                }
            };
            template = post.post_type === 'page' ? 'page' : 'single';
        }

        const html = await themeEngine.render(template, data);
        res.send(html);

    } catch (e) {
        console.error('❌ Frontend Render Error:', e.message);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;

/**
 * WordJS - Import/Export System
 * Equivalent to wp-admin/export.php and wp-admin/import.php
 */

const fs = require('fs');
const path = require('path');
const Post = require('../models/Post');
const User = require('../models/User');
const Term = require('../models/Term');
const { Menu, MenuItem } = require('../models/Menu');
const { getOption, updateOption, addOption } = require('./options');

/**
 * Export all site content
 */
/**
 * Export all site content (Async)
 */
async function exportSite(options = {}) {
    const {
        includeMedia = true,
        includePosts = true,
        includePages = true,
        includeUsers = false,
        includeSettings = true,
        includeMenus = true
    } = options;

    const exportData = {
        version: '1.0',
        generator: 'WordJS',
        exportDate: new Date().toISOString(),
        site: {
            name: getOption('blogname', 'WordJS'),
            url: getOption('siteurl', ''),
            description: getOption('blogdescription', '')
        },
        content: {}
    };

    // Export posts
    if (includePosts) {
        const posts = await Post.findAll({ type: 'post', status: 'any', limit: 10000 });
        exportData.content.posts = await Promise.all(posts.map(async p => ({
            id: p.id,
            title: p.postTitle,
            slug: p.postName,
            content: p.postContent,
            excerpt: p.postExcerpt,
            status: p.postStatus,
            date: p.postDate,
            modified: p.postModified,
            authorId: p.authorId,
            categories: (await Post.getTerms(p.id, 'category')).map(t => t.name),
            tags: (await Post.getTerms(p.id, 'post_tag')).map(t => t.name),
            meta: await Post.getAllMeta(p.id)
        })));
    }

    // Export pages
    if (includePages) {
        const pages = await Post.findAll({ type: 'page', status: 'any', limit: 10000 });
        exportData.content.pages = await Promise.all(pages.map(async p => ({
            id: p.id,
            title: p.postTitle,
            slug: p.postName,
            content: p.postContent,
            status: p.postStatus,
            date: p.postDate,
            parentId: p.postParent,
            menuOrder: p.menuOrder,
            meta: await Post.getAllMeta(p.id)
        })));
    }

    // Export categories
    const categories = await Term.getCategories();
    exportData.content.categories = categories.map(c => ({
        id: c.termId,
        name: c.name,
        slug: c.slug,
        description: c.description,
        parent: c.parent
    }));

    // Export tags
    const tags = await Term.getTags();
    exportData.content.tags = tags.map(t => ({
        id: t.termId,
        name: t.name,
        slug: t.slug,
        description: t.description
    }));

    // Export menus
    if (includeMenus) {
        const menus = await Menu.findAll();
        exportData.content.menus = await Promise.all(menus.map(async m => ({
            id: m.id,
            name: m.name,
            slug: m.slug,
            items: await m.getItemsTree()
        })));
        exportData.content.menuLocations = await Menu.getLocations();
    }

    // Export users (only basic info, not passwords)
    if (includeUsers) {
        const users = await User.findAll({ limit: 10000 });
        exportData.content.users = users.map(u => ({
            id: u.id,
            username: u.userLogin,
            email: u.userEmail,
            displayName: u.displayName,
            role: u.getRole()
        }));
    }

    // Export settings (Option access is sync in memory usually, but good to check if db needed)
    // Options are loaded into memory on startup usually, but let's assume getOption is sync as per require.
    if (includeSettings) {
        exportData.settings = {
            blogname: getOption('blogname'),
            blogdescription: getOption('blogdescription'),
            posts_per_page: getOption('posts_per_page'),
            date_format: getOption('date_format'),
            time_format: getOption('time_format'),
            timezone_string: getOption('timezone_string'),
            show_on_front: getOption('show_on_front'),
            page_on_front: getOption('page_on_front'),
            page_for_posts: getOption('page_for_posts')
        };
    }

    return exportData;
}

/**
 * Export to JSON file (Async)
 */
async function exportToFile(filepath, options = {}) {
    const data = await exportSite(options);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    return filepath;
}

/**
 * SECURITY: Validate import data to prevent prototype pollution and injection
 */
function validateImportData(data) {
    const dangerousKeys = ['__proto__', 'constructor', 'prototype'];

    function checkObject(obj, path = '') {
        if (obj === null || typeof obj !== 'object') return;

        for (const key of Object.keys(obj)) {
            // Block dangerous prototype pollution keys
            if (dangerousKeys.includes(key)) {
                throw new Error(`Security: Dangerous key '${key}' found at ${path}`);
            }

            // Block overly long keys or values (potential DoS)
            if (key.length > 100) {
                throw new Error(`Security: Key too long at ${path}`);
            }

            // Recursively check nested objects
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                checkObject(obj[key], `${path}.${key}`);
            }
        }
    }

    checkObject(data, 'root');
    return true;
}

/**
 * Import site content (Async)
 */
async function importSite(data, options = {}) {
    // SECURITY: Validate import data structure
    validateImportData(data);

    const {
        updateExisting = false,
        importUsers = false
    } = options;

    const results = {
        posts: { created: 0, updated: 0, skipped: 0 },
        pages: { created: 0, updated: 0, skipped: 0 },
        categories: { created: 0, skipped: 0 },
        tags: { created: 0, skipped: 0 },
        menus: { created: 0, skipped: 0 },
        users: { created: 0, skipped: 0 },
        errors: []
    };

    const idMap = {
        posts: {},
        pages: {},
        categories: {},
        tags: {},
        users: {}
    };

    // Import categories first
    if (data.content?.categories) {
        for (const cat of data.content.categories) {
            try {
                const existing = await Term.findBySlug(cat.slug, 'category');
                if (existing) {
                    idMap.categories[cat.id] = existing.termId;
                    results.categories.skipped++;
                } else {
                    const newCat = await Term.create({
                        name: cat.name,
                        slug: cat.slug,
                        taxonomy: 'category',
                        description: cat.description
                    });
                    idMap.categories[cat.id] = newCat.termId;
                    results.categories.created++;
                }
            } catch (e) {
                results.errors.push(`Category ${cat.name}: ${e.message}`);
            }
        }
    }

    // Import tags
    if (data.content?.tags) {
        for (const tag of data.content.tags) {
            try {
                const existing = await Term.findBySlug(tag.slug, 'post_tag');
                if (existing) {
                    idMap.tags[tag.id] = existing.termId;
                    results.tags.skipped++;
                } else {
                    const newTag = await Term.create({
                        name: tag.name,
                        slug: tag.slug,
                        taxonomy: 'post_tag',
                        description: tag.description
                    });
                    idMap.tags[tag.id] = newTag.termId;
                    results.tags.created++;
                }
            } catch (e) {
                results.errors.push(`Tag ${tag.name}: ${e.message}`);
            }
        }
    }

    // Import posts
    if (data.content?.posts) {
        for (const post of data.content.posts) {
            try {
                const existing = await Post.findBySlug(post.slug);
                if (existing && !updateExisting) {
                    idMap.posts[post.id] = existing.id;
                    results.posts.skipped++;
                } else if (existing && updateExisting) {
                    await Post.update(existing.id, {
                        title: post.title,
                        content: post.content,
                        excerpt: post.excerpt,
                        status: post.status
                    });
                    idMap.posts[post.id] = existing.id;
                    results.posts.updated++;
                } else {
                    const newPost = await Post.create({
                        title: post.title,
                        content: post.content,
                        excerpt: post.excerpt,
                        status: post.status,
                        slug: post.slug,
                        type: 'post',
                        authorId: 1
                    });
                    idMap.posts[post.id] = newPost.id;
                    results.posts.created++;
                }
            } catch (e) {
                results.errors.push(`Post ${post.title}: ${e.message}`);
            }
        }
    }

    // Import pages
    if (data.content?.pages) {
        for (const page of data.content.pages) {
            try {
                const existing = await Post.findBySlug(page.slug);
                if (existing && !updateExisting) {
                    idMap.pages[page.id] = existing.id;
                    results.pages.skipped++;
                } else if (existing && updateExisting) {
                    await Post.update(existing.id, {
                        title: page.title,
                        content: page.content,
                        status: page.status
                    });
                    idMap.pages[page.id] = existing.id;
                    results.pages.updated++;
                } else {
                    const newPage = await Post.create({
                        title: page.title,
                        content: page.content,
                        status: page.status,
                        slug: page.slug,
                        type: 'page',
                        authorId: 1
                    });
                    idMap.pages[page.id] = newPage.id;
                    results.pages.created++;
                }
            } catch (e) {
                results.errors.push(`Page ${page.title}: ${e.message}`);
            }
        }
    }

    // Import settings
    if (data.settings) {
        for (const [key, value] of Object.entries(data.settings)) {
            if (value !== null && value !== undefined) {
                updateOption(key, value);
            }
        }
    }

    return results;
}

/**
 * Import from JSON file (Async)
 */
async function importFromFile(filepath, options = {}) {
    const content = fs.readFileSync(filepath, 'utf8');
    const data = JSON.parse(content);
    return await importSite(data, options);
}


/**
 * Generate WordPress-compatible WXR export (Async)
 */
async function exportToWXR() {
    const data = await exportSite();

    let wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>${escapeXml(data.site.name)}</title>
  <link>${escapeXml(data.site.url)}</link>
  <description>${escapeXml(data.site.description)}</description>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>${escapeXml(data.site.url)}</wp:base_site_url>
  <wp:base_blog_url>${escapeXml(data.site.url)}</wp:base_blog_url>
  <generator>WordJS</generator>
`;

    // Add categories
    for (const cat of data.content.categories || []) {
        wxr += `
  <wp:category>
    <wp:term_id>${cat.id}</wp:term_id>
    <wp:category_nicename>${escapeXml(cat.slug)}</wp:category_nicename>
    <wp:category_parent>${cat.parent || ''}</wp:category_parent>
    <wp:cat_name><![CDATA[${cat.name}]]></wp:cat_name>
  </wp:category>`;
    }

    // Add posts
    for (const post of data.content.posts || []) {
        wxr += `
  <item>
    <title>${escapeXml(post.title)}</title>
    <link>${data.site.url}/${post.slug}</link>
    <pubDate>${new Date(post.date).toUTCString()}</pubDate>
    <dc:creator><![CDATA[admin]]></dc:creator>
    <content:encoded><![CDATA[${post.content}]]></content:encoded>
    <excerpt:encoded><![CDATA[${post.excerpt || ''}]]></excerpt:encoded>
    <wp:post_id>${post.id}</wp:post_id>
    <wp:post_date>${post.date}</wp:post_date>
    <wp:post_name>${escapeXml(post.slug)}</wp:post_name>
    <wp:status>${post.status}</wp:status>
    <wp:post_type>post</wp:post_type>
  </item>`;
    }

    wxr += `
</channel>
</rss>`;

    return wxr;
}

function escapeXml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

module.exports = {
    exportSite,
    exportToFile,
    importSite,
    importFromFile,
    exportToWXR
};

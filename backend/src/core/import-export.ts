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
async function exportSite(options: Record<string, any> = {}) {
    const {
        includeMedia = true,
        includePosts = true,
        includePages = true,
        includeUsers = false,
        includeSettings = true,
        includeMenus = true
    } = options;

    const exportData: Record<string, any> = {
        version: '1.0',
        generator: 'WordJS',
        exportDate: new Date().toISOString(),
        site: {
            name: await getOption('blogname', 'WordJS'),
            url: await getOption('siteurl', ''),
            description: await getOption('blogdescription', '')
        },
        content: {} as Record<string, any>
    };

    // Export posts
    if (includePosts) {
        const posts = await Post.findAll({ type: 'post', status: 'any', limit: 10000 });
        exportData.content.posts = await Promise.all(posts.map(async (p: any) => ({
            id: p.id,
            title: p.postTitle,
            slug: p.postName,
            content: p.postContent,
            excerpt: p.postExcerpt,
            status: p.postStatus,
            date: p.postDate,
            modified: p.postModified,
            authorId: p.authorId,
            categories: (await p.getTerms('category')).map((t: any) => t.name),
            tags: (await p.getTerms('post_tag')).map((t: any) => t.name),
            meta: await Post.getAllMeta(p.id)
        })));
    }

    // Export pages
    if (includePages) {
        const pages = await Post.findAll({ type: 'page', status: 'any', limit: 10000 });
        exportData.content.pages = await Promise.all(pages.map(async (p: any) => ({
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
    exportData.content.categories = categories.map((c: any) => ({
        id: c.termId,
        name: c.name,
        slug: c.slug,
        description: c.description,
        parent: c.parent
    }));

    // Export tags
    const tags = await Term.getTags();
    exportData.content.tags = tags.map((t: any) => ({
        id: t.termId,
        name: t.name,
        slug: t.slug,
        description: t.description
    }));

    // Export menus
    if (includeMenus) {
        const menus = await Menu.findAll();
        exportData.content.menus = await Promise.all(menus.map(async (m: any) => ({
            id: m.id,
            name: m.name,
            slug: m.slug,
            items: await m.getItemsTree()
        })));
        exportData.content.menuLocations = await Menu.getLocations();
    }

    // Export users
    if (includeUsers) {
        const users = await User.findAll({ limit: 10000 });
        exportData.content.users = users.map((u: any) => ({
            id: u.id,
            username: u.userLogin,
            password: u.userPass, // Include hashed password
            email: u.userEmail,
            displayName: u.displayName,
            registered: u.userRegistered,
            status: u.userStatus,
            role: u.getRole()
        }));
    }

    // Export settings (Option access is sync in memory usually, but good to check if db needed)
    // Options are loaded into memory on startup usually, but let's assume getOption is sync as per require.
    if (includeSettings) {
        // These getOption reads are independent — run them concurrently instead of sequentially.
        const [
            blogname, blogdescription, posts_per_page, date_format, time_format,
            timezone_string, show_on_front, page_on_front, page_for_posts
        ] = await Promise.all([
            getOption('blogname'),
            getOption('blogdescription'),
            getOption('posts_per_page'),
            getOption('date_format'),
            getOption('time_format'),
            getOption('timezone_string'),
            getOption('show_on_front'),
            getOption('page_on_front'),
            getOption('page_for_posts')
        ]);
        exportData.settings = {
            blogname, blogdescription, posts_per_page, date_format, time_format,
            timezone_string, show_on_front, page_on_front, page_for_posts
        };
    }

    // Export Custom Tables (Universal Schema Discovery)
    const { getDbAsync, getDbType } = require('./../config/database');
    const db = getDbAsync();

    // Core tables to exclude from manual custom dump
    const CORE_TABLES = [
        'posts', 'post_meta',
        'users', 'user_meta',
        'comments', 'comment_meta',
        'terms', 'term_taxonomy', 'term_relationships',
        'options', 'links', 'notifications',
        'schema_migrations', 'api_tokens', 'audit_log', 'webhooks', 'webhook_deliveries',
        'form_submissions', 'collab_docs', 'collab_members', 'collab_ops', 'content_outbox',
        'sqlite_sequence', 'migrations' // exclusions
    ];

    if (db && db.getTables) {
        try {
            const allTables = await db.getTables();
            exportData.content.custom_tables = [];

            for (const table of allTables) {
                if (CORE_TABLES.includes(table)) continue;

                // 1. Get Schema
                const schema = await db.getTableSchema(table);

                // 2. Get Data
                const rows = await db.all(`SELECT * FROM ${table}`);

                exportData.content.custom_tables.push({
                    name: table,
                    schema: schema,
                    rows: rows
                });
            }
        } catch (e) {
            console.warn('⚠️ Failed to export custom tables:', e.message);
        }
    }

    return exportData;
}

/**
 * Export to JSON file (Async)
 */
async function exportToFile(filepath: any, options = {}) {
    const data = await exportSite(options);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    return filepath;
}

/**
 * SECURITY: Validate import data to prevent prototype pollution and injection
 */
function validateImportData(data: any) {
    const dangerousKeys = ['__proto__', 'constructor', 'prototype'];

    // DoS guards: a deeply nested or enormous payload could blow the stack or pin the CPU.
    const MAX_DEPTH = 32;
    const MAX_NODES = 1_000_000;
    const MAX_ARRAY_LENGTH = 1_000_000;
    let visited = 0;

    function checkObject(obj: any, path = '', depth = 0) {
        if (obj === null || typeof obj !== 'object') return;

        if (depth > MAX_DEPTH) {
            throw new Error(`Security: Import data nested too deeply (>${MAX_DEPTH}) at ${path}`);
        }
        if (++visited > MAX_NODES) {
            throw new Error('Security: Import data has too many nodes (possible DoS)');
        }
        if (Array.isArray(obj) && obj.length > MAX_ARRAY_LENGTH) {
            throw new Error(`Security: Array too large at ${path}`);
        }

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
                checkObject(obj[key], `${path}.${key}`, depth + 1);
            }
        }
    }

    checkObject(data, 'root', 0);
    return true;
}

/**
 * Import site content (Async)
 */
async function importSite(data: any, options: Record<string, any> = {}) {
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
        users: { created: 0, skipped: 0, updated: 0 },
        custom_tables: { created: 0, rows: 0 },
        settings: { imported: 0, skipped: [] as string[] },
        errors: [] as string[]
    };

    const idMap: Record<string, Record<string, any>> = {
        posts: {},
        pages: {},
        categories: {},
        tags: {},
        users: {}
    };

    // Import users
    if (importUsers && data.content?.users) {
        for (const user of data.content.users) {
            try {
                // Check by username OR email
                let existing = await User.findByLogin(user.username);
                if (!existing && user.email) {
                    existing = await User.findByEmail(user.email);
                }

                if (existing && !updateExisting) {
                    idMap.users[user.id] = existing.id;
                    results.users.skipped++;
                } else if (existing && updateExisting) {
                    // Update user.
                    // SECURITY: NEVER apply an attacker-supplied password (or hash) from import input —
                    // a crafted export could otherwise overwrite an existing account's credentials with
                    // a known value. Update profile fields only; leave the password untouched.
                    await User.update(existing.id, {
                        email: user.email,
                        displayName: user.displayName
                    });
                    // Set role if capability (User.update validates the role allow-list)
                    if (user.role) {
                        await User.update(existing.id, { role: user.role });
                    }

                    idMap.users[user.id] = existing.id;
                    results.users.updated++;
                } else {
                    // Create User.
                    // SECURITY: do NOT trust user.password from the import (pre-hashed credentials in a
                    // crafted export become a working login). Mirror the WXR importer: assign a random
                    // password so imported accounts must go through password reset to log in. We also do
                    // NOT write user_pass from the import at all.
                    const crypto = require('crypto');
                    const newUser = await User.create({
                        username: user.username,
                        email: user.email,
                        password: crypto.randomBytes(24).toString('hex'),
                        displayName: user.displayName,
                        role: user.role // User.create validates the role allow-list + handles role meta
                    });

                    // Restore non-credential metadata only (registration date / status). user_pass is
                    // intentionally left as the freshly-hashed random password set by User.create.
                    // Note: We need to use the same db connection as User context, which is global dbAsync.
                    const { dbAsync } = require('../config/database');
                    await dbAsync.run(
                        'UPDATE users SET user_registered = ?, user_status = ? WHERE id = ?',
                        [user.registered || new Date().toISOString(), user.status || 0, newUser.id]
                    );

                    // Refetch to ensure minimal consistency if needed, but we have id
                    idMap.users[user.id] = newUser.id;
                    results.users.created++;
                }
            } catch (e) {
                results.errors.push(`User ${user.username}: ${e.message}`);
            }
        }
    }

    // Import categories first (rest of function continues...)
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
                // The type is part of the IDENTITY, so it must be part of the LOOKUP — the same type the
                // create branch below writes. Without it, findBySlug matched any post_type (Post.ts only
                // adds `AND post_type = ?` when it receives one), so a bundle holding both a post and a
                // page named 'about' — a legal combination — made the pages loop below find the post this
                // loop had just created and overwrite it, reporting `pages.updated++`. That is the
                // restoreBackup path (clearDatabase + importSite), so such a site did not round-trip.
                const existing = await Post.findBySlug(post.slug, 'post');
                if (existing && existing.postType !== 'post') {
                    // Belt and braces: refuse rather than write through a record of another type. An
                    // import that says "I updated 1 post" having clobbered an attachment is worse than
                    // one that declines.
                    results.errors.push(`Post ${post.title}: slug '${post.slug}' already belongs to a '${existing.postType}' — refusing to overwrite`);
                    continue;
                }
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
                // Same as the posts loop above: look the record up by the identity the create branch
                // writes (slug + type), never by slug alone. core/wxr-import.ts:325 is the sibling that
                // always did this correctly.
                const existing = await Post.findBySlug(page.slug, 'page');
                if (existing && existing.postType !== 'page') {
                    results.errors.push(`Page ${page.title}: slug '${page.slug}' already belongs to a '${existing.postType}' — refusing to overwrite`);
                    continue;
                }
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

    // Import Custom Tables
    if (data.content?.custom_tables) {
        const { getDbAsync, createPluginTable } = require('./../config/database');
        const db = getDbAsync();

        // SECURITY (SQLI-01): table.name and column keys come verbatim from the (admin-supplied but
        // potentially attacker-crafted) import bundle and are interpolated into CREATE/INSERT SQL. Without
        // validation an import could write arbitrary rows into a core table (e.g. a backdoor admin in
        // `users`) or inject SQL fragments through identifier names. Restrict to simple, unqualified
        // identifiers and forbid the core tables — symmetric with the export, which never dumps core tables
        // (CORE_TABLES) and only ever emits simple non-core table names, so legit round-trips are preserved.
        // Identifier authority: core/safe-sql (the SAME module createPluginTable validates with, so the
        // two ends of this path cannot drift). safeIdent returns the CANONICAL identifier rebuilt from a
        // constant alphabet, or null — and it is that RETURNED value that is interpolated below, never
        // `table.name` / the raw column key.
        const { safeIdent } = require('./safe-sql');
        const CORE_TABLES = [
            'posts', 'post_meta',
            'users', 'user_meta',
            'comments', 'comment_meta',
            'terms', 'term_taxonomy', 'term_relationships',
            'options', 'links', 'notifications',
            'schema_migrations', 'api_tokens', 'audit_log', 'webhooks', 'webhook_deliveries',
            'form_submissions', 'collab_docs', 'collab_members', 'collab_ops', 'content_outbox',
            'sqlite_sequence', 'migrations'
        ];

        for (const table of data.content.custom_tables) {
            try {
                // Reject anything that is not a plain identifier (blocks dotted/schema-qualified names,
                // SQL fragments, comments) or that targets a protected core table.
                const tableName = safeIdent(table?.name);
                if (tableName === null) {
                    throw new Error(`invalid table name (must be a simple identifier)`);
                }
                if (CORE_TABLES.includes(tableName.toLowerCase())) {
                    throw new Error(`refusing to import into core table '${table.name}'`);
                }
                // Defense-in-depth: also refuse SQLite's reserved internal tables (sqlite_master,
                // sqlite_sequence, sqlite_stat*, …). These pass the simple-identifier shape but are
                // engine-internal; SQLite already rejects writes to them, so blocking here just turns a
                // confusing per-table error into a clear refusal (and forbids accidental schema probing).
                if (tableName.toLowerCase().startsWith('sqlite_')) {
                    throw new Error(`refusing to import into reserved table '${table.name}'`);
                }

                // 1. Reconstruct Schema (Create Table). createPluginTable re-validates both the name and
                //    every column DEFINITION through core/safe-sql — this is not the only gate.
                if (table.schema && table.schema.columns) {
                    await createPluginTable(tableName, table.schema.columns);
                    results.custom_tables.created++;
                }

                // 2. Insert Data
                if (table.rows && table.rows.length > 0) {
                    for (const row of table.rows) {
                        // Every column identifier is canonicalized before it is interpolated, and it is the
                        // CANONICAL value that goes into the statement (the raw key is never concatenated).
                        const cols: string[] = [];
                        for (const col of Object.keys(row)) {
                            const safeCol = safeIdent(col);
                            if (safeCol === null) {
                                throw new Error(`invalid column name '${col}' (must be a simple identifier)`);
                            }
                            cols.push(safeCol);
                        }
                        const vals = Object.values(row);
                        const placeholders = cols.map(() => '?').join(',');
                        const sql = `INSERT INTO ${tableName} (${cols.join(',')}) VALUES (${placeholders})`;

                        // Try insert (ignore duplicate key errors if simple backup)
                        try {
                            await db.run(sql, vals);
                            results.custom_tables.rows++;
                        } catch (err) {
                            // Ignore constraint violations (duplicates)
                            if (!err.message.includes('UNIQUE constraint') && !err.message.includes('duplicate key')) {
                                throw err;
                            }
                        }
                    }
                }
            } catch (e) {
                results.errors.push(`Custom Table ${table.name}: ${e.message}`);
            }
        }
    }

    // Import settings.
    // SECURITY: this loop used to write ANY key the bundle named, making an import a second, unguarded
    // door onto options whose real write path validates or does far more than store a value —
    // 'site_chrome_header'/'site_chrome_footer' (chrome-validate is the write authority, reachable only
    // through PUT /api/v1/chrome/:part) and 'template'/'stylesheet' (switching a theme is switchTheme(),
    // not an option write). Same discipline as the generic settings writers, which refuse exactly those
    // (DEDICATED_WRITE_API in routes/settings.ts) — but gated on plugin-api's isProtectedOption, the one
    // list of security-critical option NAMES and a superset of that set, so there is no second copy to
    // drift. Required lazily: plugin-api is a heavy leaf nothing else on this path needs. Skipped keys are
    // REPORTED, not silently dropped: an import that looks like it applied a theme but did not is worse
    // than a visible refusal. exportSite() only emits unprotected keys, so its bundles round-trip intact.
    // The shape guard matters too: Object.entries() on a string/array yields index keys, so a malformed
    // `"settings": "x"` used to create option rows named '0', '1', … — writes nobody ever asked for.
    if (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)) {
        const { isProtectedOption } = require('./plugin-api');
        for (const [key, value] of Object.entries(data.settings)) {
            if (value === null || value === undefined) continue;
            if (isProtectedOption(key)) {
                results.settings.skipped.push(key);
                continue;
            }
            await updateOption(key, value);
            results.settings.imported++;
        }
    }

    return results;
}

/**
 * Import from JSON file (Async)
 */
async function importFromFile(filepath: any, options = {}) {
    const content = fs.readFileSync(filepath, 'utf8');
    const data = JSON.parse(content);
    return await importSite(data, options);
}


/**
 * Post meta that must NOT travel in an export.
 *
 * IN LOCKSTEP WITH THE READ SIDE BY CONSTRUCTION, not by hand. This set used to be the literal
 * `{_edit_lock, _edit_last}` and the WXR importer kept its own copy of the same two names, with a
 * comment in each promising they matched. When the importer moved to core/protected-meta (the list of
 * keys only backend code may write) the promise quietly broke: an export kept emitting
 * `_wp_attached_file`, `_wp_attachment_metadata` and `_wp_trash_meta_status`, which the importer at
 * the other end now refuses — so the file advertised state that could never be restored, and made
 * every export a carrier for the exact bytes core/protected-meta exists to keep out of post_meta.
 * Deriving the set removes the possibility of drift instead of documenting it.
 *
 * These are all SERVER-OWNED, install-local values: volatile editor bookkeeping (who holds the lock,
 * when — also a needless leak of an editor's user id), the attachment's on-disk path, and the
 * trash-restore status. Everything else — crucially `_puck_data`, the page tree — ships verbatim.
 */
const { PROTECTED_POST_META } = require('./protected-meta');
const NON_PORTABLE_META: Set<string> = new Set(PROTECTED_POST_META);

/**
 * CDATA payload that cannot break out of its own section.
 *
 * A literal `]]>` inside post content or a meta value would terminate the CDATA early and produce
 * malformed XML (or, worse, let content escape into markup). WordPress splits the sequence across two
 * sections; do exactly the same.
 */
function cdata(value: any) {
    if (value === null || value === undefined) return '<![CDATA[]]>';
    return `<![CDATA[${String(value).split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

/**
 * Generate WordPress-compatible WXR export (Async)
 *
 * FIDELITY CONTRACT: every content item exported by exportSite() becomes an <item> carrying its REAL
 * wp:post_type and its wp:postmeta. This used to walk `data.content.posts` only, hard-code
 * `<wp:post_type>post</wp:post_type>` and emit not one <wp:postmeta> — so pages were absent entirely
 * and `_puck_data` (i.e. the whole visual layout of every page on the site) never left the install:
 * re-importing a WordJS export produced zero documents (F7/H2). The importer already reads
 * wp:postmeta, so the gap was purely on this side.
 */
async function exportToWXR() {
    const data = await exportSite();

    // Meta is read RAW (never JSON.parse -> stringify) so _puck_data ships byte-identical to what the
    // editor stored; exportSite()'s `meta` map is parsed for API readability and is lossy for this.
    const collections = [
        { items: data.content.posts || [], defaultType: 'post' },
        { items: data.content.pages || [], defaultType: 'page' }
    ];
    const allIds = collections.flatMap((c) => c.items.map((p: any) => p.id)).filter((id: any) => id != null);
    const metaById = await Post.getAllMetaRawForIds(allIds);

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
    <wp:cat_name>${cdata(cat.name)}</wp:cat_name>
  </wp:category>`;
    }

    // Add every content item (posts AND pages — and anything exportSite gains later), each with its
    // real post_type and its portable postmeta.
    for (const { items, defaultType } of collections) {
        for (const post of items) {
            const type = post.type || defaultType;
            const pubDate = post.date ? new Date(post.date) : null;
            wxr += `
  <item>
    <title>${escapeXml(post.title)}</title>
    <link>${escapeXml(`${data.site.url}/${post.slug || ''}`)}</link>
    <pubDate>${pubDate && !isNaN(pubDate.getTime()) ? pubDate.toUTCString() : ''}</pubDate>
    <dc:creator>${cdata('admin')}</dc:creator>
    <content:encoded>${cdata(post.content || '')}</content:encoded>
    <excerpt:encoded>${cdata(post.excerpt || '')}</excerpt:encoded>
    <wp:post_id>${escapeXml(post.id)}</wp:post_id>
    <wp:post_date>${escapeXml(post.date)}</wp:post_date>
    <wp:post_name>${escapeXml(post.slug)}</wp:post_name>
    <wp:status>${escapeXml(post.status)}</wp:status>
    <wp:post_parent>${escapeXml(post.parentId || 0)}</wp:post_parent>
    <wp:menu_order>${escapeXml(post.menuOrder || 0)}</wp:menu_order>
    <wp:post_type>${escapeXml(type)}</wp:post_type>`;

            for (const { key, value } of metaById[post.id] || []) {
                if (NON_PORTABLE_META.has(key)) continue;
                wxr += `
    <wp:postmeta>
      <wp:meta_key>${cdata(key)}</wp:meta_key>
      <wp:meta_value>${cdata(value)}</wp:meta_value>
    </wp:postmeta>`;
            }

            wxr += `
  </item>`;
        }
    }

    wxr += `
</channel>
</rss>`;

    return wxr;
}

function escapeXml(str: any) {
    // NOTE: `if (!str) return ''` was wrong for numerics — it turned a legitimate 0 (wp:post_parent,
    // wp:menu_order) into an empty element, and any non-string argument crashed on .replace().
    if (str === null || str === undefined) return '';
    return String(str)
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

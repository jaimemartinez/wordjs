/**
 * WordJS — Starter content seeded by the install wizard (opt-in checkbox, default on).
 *
 * A fresh install used to land on "No posts found. Go to Admin to create one!" — the selling
 * points (Puck visual editor, token themes) stayed invisible until the user did homework. This
 * seeds the 30-second wow instead: a designed Puck home page (set as the static front page),
 * a welcome post pointing at the admin surfaces, an About page, and a header menu.
 *
 * Design constraints:
 *  - Idempotent: each item is looked up by slug first (safe to call twice, e.g. a re-run wizard).
 *  - Best-effort: a failure here must NEVER fail the install — callers get a boolean per item.
 *  - Uses the same raw insert pattern as backend/cli/create-demo-page.js (proven to render),
 *    and only core blocks confirmed in frontend/src/components/versoConfig.tsx
 *    (Heading, Text, Divider, Card, Spacer, Button).
 */

const { dbAsync } = require('../config/database');
const { updateOption } = require('./options');

async function upsertContent(opts: {
    title: string; slug: string; type: 'post' | 'page'; html: string;
    authorId: number; excerpt?: string; puckData?: any;
}): Promise<number | null> {
    const { title, slug, type, html, authorId, excerpt = '', puckData } = opts;
    const existing = await dbAsync.get('SELECT id FROM posts WHERE post_name = ? AND post_type = ?', [slug, type]);
    let postId: number;
    if (existing) {
        postId = existing.id;
    } else {
        const result = await dbAsync.run(
            "INSERT INTO posts (author_id, post_date, post_date_gmt, post_content, post_title, post_status, post_name, post_type, comment_status, post_excerpt) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 'publish', ?, ?, 'open', ?)",
            [authorId, html, title, slug, type, excerpt]
        );
        postId = result.lastID;
    }
    if (puckData && postId) {
        await dbAsync.run('DELETE FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, '_puck_data']);
        await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [postId, '_puck_data', JSON.stringify(puckData)]);
    }
    return postId || null;
}

/** The Puck-built home page — composed only of core blocks. */
function homePuckData(siteName: string) {
    return {
        content: [
            { type: 'Heading', props: { title: `Welcome to ${siteName}`, level: 'h1', id: 'starter-heading-1' } },
            {
                type: 'Text', props: {
                    id: 'starter-text-1',
                    content: '<p>This page was built with the <strong>visual editor</strong> — every block on it can be reshaped, reordered, or deleted without touching code. Open it in <em>Pages → Edit</em> and try.</p>'
                }
            },
            { type: 'Divider', props: { type: 'gradient', id: 'starter-divider-1' } },
            {
                type: 'Card', props: {
                    id: 'starter-card-1', icon: 'fa-wand-magic-sparkles', theme: 'accent',
                    title: 'Edit visually',
                    description: 'Drag blocks, edit text in place, and see the result exactly as your visitors will — the editor renders your real theme.'
                }
            },
            {
                type: 'Card', props: {
                    id: 'starter-card-2', icon: 'fa-palette', theme: 'accent',
                    title: 'Switch themes, keep your content',
                    description: 'Thirteen themes styled by design tokens. Change one and every block on this page re-dresses itself — try the live customizer.'
                }
            },
            {
                type: 'Card', props: {
                    id: 'starter-card-3', icon: 'fa-shield-halved', theme: 'accent',
                    title: 'Plugins that can\'t take over',
                    description: 'Every plugin runs in its own OS-isolated process and only gets the permissions you grant it. Extend without fear.'
                }
            },
            { type: 'Spacer', props: { css: { height: '32px' }, id: 'starter-spacer-1' } },
            { type: 'Button', props: { id: 'starter-button-1', label: 'Open your admin', href: '/admin', variant: 'primary', align: 'center' } }
        ],
        root: { props: { title: `Welcome to ${siteName}`, slug: 'home' } }
    };
}

// Plain-HTML fallback for the home page (shown by feeds/search/scrapers or if Puck data is absent).
const HOME_HTML = `
<h1>Welcome to your new WordJS site</h1>
<p>This page was built with the visual editor. Open it in <strong>Pages</strong> to reshape it — no code needed.</p>
`;

const WELCOME_POST_HTML = `
<p>If you can read this, your WordJS install works. Here's a two-minute tour of what to do next:</p>
<ul>
<li><strong>Write:</strong> head to <a href="/admin/posts">Posts</a> and replace this post with your first real one.</li>
<li><strong>Make it yours:</strong> the <a href="/admin/themes/customize">theme customizer</a> changes colors, fonts and spacing live — thirteen themes ship in the box.</li>
<li><strong>Build pages visually:</strong> your home page is a drag-and-drop composition — edit it under <a href="/admin/pages">Pages</a>.</li>
<li><strong>Extend safely:</strong> browse <a href="/admin/plugins">Plugins</a>. Each one runs sandboxed in its own process and only gets the permissions you grant.</li>
</ul>
<p>When you're done exploring, just delete this post. Enjoy!</p>
`;

const ABOUT_HTML = `
<h2>About this site</h2>
<p>Tell your visitors who you are and what this site is for. Edit this page under <strong>Pages → About</strong> — or rebuild it visually with the block editor.</p>
`;

/**
 * Seed the starter content. Returns a summary of what was created; never throws.
 * @param authorId the admin user's id (posts must have a real author)
 * @param siteName used in the home page headline
 */
async function seedStarterContent(authorId: number, siteName: string): Promise<{ homeId: number | null; postId: number | null; aboutId: number | null; menu: boolean }> {
    const out: { homeId: number | null; postId: number | null; aboutId: number | null; menu: boolean } = { homeId: null, postId: null, aboutId: null, menu: false };
    const safeName = String(siteName || 'your new site').slice(0, 80);

    try {
        out.homeId = await upsertContent({
            title: `Welcome to ${safeName}`, slug: 'home', type: 'page', authorId,
            html: HOME_HTML, puckData: homePuckData(safeName)
        });
        if (out.homeId) await updateOption('homepage_id', String(out.homeId));
    } catch (e: any) { console.warn('[starter-content] home page failed:', e && e.message); }

    try {
        out.postId = await upsertContent({
            title: 'Welcome to WordJS 👋', slug: 'welcome-to-wordjs', type: 'post', authorId,
            html: WELCOME_POST_HTML,
            excerpt: 'Your install works — here is a two-minute tour of what to do next.'
        });
    } catch (e: any) { console.warn('[starter-content] welcome post failed:', e && e.message); }

    try {
        out.aboutId = await upsertContent({ title: 'About', slug: 'about', type: 'page', authorId, html: ABOUT_HTML });
    } catch (e: any) { console.warn('[starter-content] about page failed:', e && e.message); }

    try {
        const { Menu, MenuItem } = require('../models/Menu');
        // Idempotency: reuse an existing "Main Menu" term if the seed ran before.
        const existing = await dbAsync.get(
            "SELECT t.term_id AS id FROM terms t JOIN term_taxonomy tt ON tt.term_id = t.term_id WHERE tt.taxonomy = 'nav_menu' AND t.slug = ?",
            ['main-menu']
        );
        let menuId = existing ? existing.id : null;
        if (!menuId) {
            const menu = await Menu.create({ name: 'Main Menu', slug: 'main-menu', description: 'Seeded by the install wizard' });
            menuId = menu && menu.id;
            if (menuId) {
                await MenuItem.create({ menuId, title: 'Home', url: '/', order: 1 });
                await MenuItem.create({ menuId, title: 'About', url: '/about', order: 2 });
            }
        }
        if (menuId) {
            await Menu.setLocation('header', menuId);
            out.menu = true;
        }
    } catch (e: any) { console.warn('[starter-content] menu failed:', e && e.message); }

    return out;
}

module.exports = { seedStarterContent };

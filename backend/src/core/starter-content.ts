/**
 * WordJS — Starter content seeded by the install wizard (opt-in checkbox, default on).
 *
 * A fresh install used to land on "No posts found. Go to Admin to create one!" — the selling
 * points (Puck visual editor, token themes) stayed invisible until the user did homework. This
 * seeds the 30-second wow instead: a showcase home page built with the visual editor (set as the
 * static front page — see starter-showcase.ts), a welcome post pointing at the admin surfaces, two
 * sample posts so the home page's "latest posts" block has something to show, an About page, and a
 * header menu.
 *
 * Design constraints:
 *  - Idempotent: each item is looked up by slug first (safe to call twice, e.g. a re-run wizard).
 *  - Best-effort: a failure here must NEVER fail the install — callers get a boolean per item.
 *  - Uses the same raw insert pattern as backend/cli/create-demo-page.js (proven to render),
 *    and only core blocks registered in frontend/src/components/versoConfig.tsx.
 */

const { dbAsync } = require('../config/database');
const { updateOption } = require('./options');
const log = require('./module-logger').moduleLogger('core/starter-content');

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
        // The site's wall clock and UTC (core/site-time), as Post.create stores them.
        const stamp = await require('./site-time').siteDatePair();
        const result = await dbAsync.run(
            "INSERT INTO posts (author_id, post_date, post_date_gmt, post_content, post_title, post_status, post_name, post_type, comment_status, post_excerpt) VALUES (?, ?, ?, ?, ?, 'publish', ?, ?, 'open', ?)",
            [authorId, stamp.local, stamp.gmt, html, title, slug, type, excerpt]
        );
        postId = result.lastID;
    }
    if (puckData && postId) {
        await dbAsync.run('DELETE FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, '_puck_data']);
        await dbAsync.run('INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [postId, '_puck_data', JSON.stringify(puckData)]);
        // Same rule as every other page-tree write that is not a collaboration save (core/collab-rooms).
        require('./collab-rooms').contentChangedOutside(Number(postId));
    }
    return postId || null;
}

const { showcaseHomeData } = require('./starter-showcase');

// Plain-HTML fallback for the home page (shown by feeds/search/scrapers or if Puck data is absent).
const HOME_HTML = `
<h1>Welcome to your new WordJS site</h1>
<p>This page was built with the visual editor — animations, a pinned scroll scene, a carousel, tabs, a pricing table, an FAQ and a working contact form, all without code. Open it in <strong>Pages</strong> to reshape it.</p>
`;

const WELCOME_POST_HTML = `
<p>If you can read this, your WordJS install works. Here's a two-minute tour of what to do next:</p>
<ul>
<li><strong>Write:</strong> head to <a href="/admin/posts">Posts</a> and replace this post with your first real one.</li>
<li><strong>Make it yours:</strong> the <a href="/admin/themes/customize">theme customizer</a> changes colors, fonts and spacing live, and you can switch to another theme in one click.</li>
<li><strong>Build pages visually:</strong> your home page is a drag-and-drop composition — edit it under <a href="/admin/pages">Pages</a>. Every animation on it is a block setting: select a block and open its motion panel.</li>
<li><strong>Extend safely:</strong> browse <a href="/admin/plugins">Plugins</a>. Each one runs sandboxed in its own process and only gets the permissions you grant.</li>
</ul>
<p>When you're done exploring, just delete this post. Enjoy!</p>
`;

/** Two sample posts — real reading content, so the home page's "latest posts" grid is not a lone card. */
const SAMPLE_POSTS: Array<{ title: string; slug: string; excerpt: string; html: string }> = [
    {
        title: 'Five things to try in your first ten minutes',
        slug: 'five-things-to-try',
        excerpt: 'Change a headline, swap the theme, add a motion effect, build a form and install a plugin.',
        html: `
<p>Your new site already has a home page, a blog and a menu. Here is the quickest way to find out what WordJS can do.</p>
<h2>1. Change the headline</h2>
<p>Open <a href="/admin/pages">Pages</a>, edit <em>Home</em> and click the big headline. Type over it — that is the whole workflow.</p>
<h2>2. Swap the theme</h2>
<p>Go to <a href="/admin/themes">Themes</a> and activate another one. Every block on every page re-dresses itself; your content stays exactly where it was.</p>
<h2>3. Make something move</h2>
<p>Select any block and open its motion panel. Pick an entrance, a scroll effect or a hover, and preview it right in the editor.</p>
<h2>4. Collect messages</h2>
<p>Drop a <strong>Form</strong> block on a page, choose its fields and publish. Submissions land under <strong>Forms</strong> in the admin.</p>
<h2>5. Add a plugin</h2>
<p>Browse <a href="/admin/plugins">Plugins</a> for a store, a booking calendar, a newsletter or a restaurant menu. Each one asks for permissions before it runs.</p>
<blockquote><p>Tip: nothing here is permanent. Every page keeps revisions, so you can always go back.</p></blockquote>
`,
    },
    {
        title: 'How the home page was built — without code',
        slug: 'how-the-home-page-was-built',
        excerpt: 'Sections, grids, a pinned scroll scene and a carousel: a quick look at the blocks behind the demo.',
        html: `
<p>The home page of this site is a tour of the visual editor. Everything on it is an ordinary block that you can select, change or delete.</p>
<h2>Sections and grids</h2>
<p>Each band of the page is a <strong>Section</strong> with its own width, padding and background. Cards sit in a <strong>Grid</strong> that switches from four columns to two on tablets and one on phones.</p>
<h2>Motion</h2>
<ul>
<li><strong>Words that rise</strong> — the headline animates word by word when the page loads.</li>
<li><strong>Cards that flip in</strong> — an entrance plays once as each card scrolls into view.</li>
<li><strong>A pinned scene</strong> — the dark "How it works" section holds still while you scroll, and each line lights up on its own stretch.</li>
<li><strong>A tilt</strong> — the plugin card leans towards your pointer.</li>
</ul>
<h2>Theme effects</h2>
<p>A few touches come from the default theme: give a heading an ID that starts with <code>gradient</code> and it is filled with the brand gradient; a grid whose first card holds an ID starting with <code>carousel</code> becomes a swipeable carousel.</p>
<p>Visitors who prefer reduced motion get the same page, calmly — every effect respects that setting.</p>
`,
    },
];

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
            html: HOME_HTML, puckData: showcaseHomeData(safeName)
        });
        if (out.homeId) await updateOption('homepage_id', String(out.homeId));
    } catch (e: any) { log.warn({ err: e }, '[starter-content] home page failed'); }

    try {
        out.postId = await upsertContent({
            title: 'Welcome to WordJS 👋', slug: 'welcome-to-wordjs', type: 'post', authorId,
            html: WELCOME_POST_HTML,
            excerpt: 'Your install works — here is a two-minute tour of what to do next.'
        });
    } catch (e: any) { log.warn({ err: e }, '[starter-content] welcome post failed'); }

    for (const sample of SAMPLE_POSTS) {
        try {
            await upsertContent({ title: sample.title, slug: sample.slug, type: 'post', authorId, html: sample.html, excerpt: sample.excerpt });
        } catch (e: any) { log.warn({ slug: sample.slug, err: e }, `[starter-content] sample post ${sample.slug} failed`); }
    }

    try {
        out.aboutId = await upsertContent({ title: 'About', slug: 'about', type: 'page', authorId, html: ABOUT_HTML });
    } catch (e: any) { log.warn({ err: e }, '[starter-content] about page failed'); }

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
                await MenuItem.create({ menuId, title: 'Features', url: '/#features', order: 2 });
                await MenuItem.create({ menuId, title: 'Showcase', url: '/#showcase', order: 3 });
                await MenuItem.create({ menuId, title: 'About', url: '/about', order: 4 });
            }
        }
        if (menuId) {
            await Menu.setLocation('header', menuId);
            await Menu.setLocation('footer', menuId);
            out.menu = true;
        }
    } catch (e: any) { log.warn({ err: e }, '[starter-content] menu failed'); }

    return out;
}

module.exports = { seedStarterContent };

/**
 * WordJS — the showcase home page seeded by the install wizard (starter-content.ts).
 *
 * A fresh install is the first thing anyone sees of WordJS, so this page is a tour of what the
 * visual editor can do, built ONLY from core Verso blocks and the interaction engine — no plugin,
 * no custom code. Every section is ordinary content: open it under Pages → Edit and every heading,
 * card, animation and pinned scene can be changed or deleted.
 *
 * What it demonstrates, top to bottom: word-by-word reveals, an animated gradient + particle field,
 * a hero that recedes as you scroll, marquee ribbons, stats, a feature grid that flips in, a pinned
 * scroll scene, a swipeable carousel, a card that tilts with the pointer, tabs, a pricing table, the
 * latest posts, an FAQ, a real form, a call-to-action and social links.
 *
 * Constraints learned the hard way (measured in the browser, not deduced):
 *  - Verso emits at most 30 DISTINCT interactions per page (IX_MAX_UNITS_PER_PAGE); the rest render
 *    without CSS. Identical bodies share one unit, so the helpers below are reused with the same
 *    arguments on purpose (the staggered delays come from a fixed set of four).
 *  - A pinned Section must clip with `overflow: clip`, never `hidden` (hidden becomes the scroll
 *    container and breaks the sticky stage).
 *  - A nested Section with no `bg` inherits the scene's surface and paints an opaque rectangle; nested
 *    Sections that sit on a coloured parent set `bg: "transparent"`.
 *  - Text and Heading take their size from `size` (clamp() passes the sanitizer), not `look.fontSize`.
 *
 * The decorative hooks (gradient text, marquee, hollow text, the carousel) live in the default theme's
 * style.css and key off element IDs (`gradient-*`, `marquee-*`, `outline-*`, a Grid holding
 * `carousel-*`). Under another theme they degrade to plain text and an ordinary grid — never broken.
 */

/* ── Palette: the default theme's indigo → violet, plus two accents for gradients ────────────────── */
const C = {
    ink: '#0b1120',
    text: '#1e293b',
    muted: '#64748b',
    indigo: '#4f46e5',
    violet: '#7c3aed',
    purple: '#a855f7',
    pink: '#ec4899',
    cyan: '#06b6d4',
    soft: '#f1f2fb',
    line: '#e6e8f4',
    night: '#0b1120',
    nightText: '#f8f9ff',
    nightMuted: '#a5b4fc',
};

/* ── Motion (Verso interaction engine) ────────────────────────────────────────────────────────────── */
const EXPO = [0.16, 1, 0.3, 1];

/** Words rise, un-blur and straighten one after another on page load. */
const ixWordsLoad = (delay: number, each: number) => ({
    v: 1,
    trigger: { on: 'load', delay },
    tracks: [{
        target: { kind: 'words' },
        dur: 1200,
        stagger: { each },
        origin: 'bottom',
        steps: [
            { at: 0, set: { opacity: 0, y: 70, rotateX: -65, blur: 10 }, bez: EXPO },
            { at: 100, set: { opacity: 1, y: 0, rotateX: 0, blur: 0 } },
        ],
    }],
});

/** Words fade up as the heading enters the screen (once). */
const ixWordsView = () => ({
    v: 1,
    trigger: { on: 'view', once: true },
    tracks: [{
        target: { kind: 'words' },
        dur: 900,
        stagger: { each: 60 },
        steps: [
            { at: 0, set: { opacity: 0, y: 28, blur: 8 }, bez: EXPO },
            { at: 100, set: { opacity: 1, y: 0, blur: 0 } },
        ],
    }],
});

/** Rises and comes into focus on load. */
const ixUpLoad = (delay: number) => ({
    v: 1,
    trigger: { on: 'load', delay },
    tracks: [{
        target: { kind: 'self' },
        dur: 1000,
        steps: [
            { at: 0, set: { opacity: 0, y: 26, blur: 6 }, bez: EXPO },
            { at: 100, set: { opacity: 1, y: 0, blur: 0 } },
        ],
    }],
});

/** Rises as it enters the screen. Only delays 0 / 120 / 240 are used, so siblings share units. */
const ixUpView = (delay: 0 | 120 | 240) => ({
    v: 1,
    trigger: { on: 'view', once: true },
    tracks: [{
        target: { kind: 'self' },
        dur: 1000,
        delay,
        steps: [
            { at: 0, set: { opacity: 0, y: 40, blur: 4 }, bez: EXPO },
            { at: 100, set: { opacity: 1, y: 0, blur: 0 } },
        ],
    }],
});

/** A card flips up in 3D as it enters. Four delays → four shared units for any grid. */
const FLIP_DELAYS = [0, 120, 240, 360];
const ixFlipView = (i: number) => ({
    v: 1,
    trigger: { on: 'view', once: true },
    tracks: [{
        target: { kind: 'self' },
        dur: 1100,
        delay: FLIP_DELAYS[i % FLIP_DELAYS.length],
        origin: 'bottom',
        persp: 1200,
        steps: [
            { at: 0, set: { opacity: 0, y: 60, rotateX: 28, scale: 0.94 }, bez: EXPO },
            { at: 100, set: { opacity: 1, y: 0, rotateX: 0, scale: 1 } },
        ],
    }],
});

/** Curtain reveal upwards. */
const ixCurtainView = {
    v: 1,
    trigger: { on: 'view', once: true },
    tracks: [{
        target: { kind: 'self' },
        dur: 1200,
        clipDir: 'up',
        steps: [
            { at: 0, set: { clip: 0, y: 30 }, bez: EXPO },
            { at: 100, set: { clip: 100, y: 0 } },
        ],
    }],
};

/** The hero content recedes (shrinks, lifts, blurs) while the hero scrolls away. */
const ixHeroExit = {
    v: 1,
    trigger: { on: 'scrub', range: { from: { at: 'exit', pct: 0 }, to: { at: 'exit', pct: 100 } } },
    tracks: [{
        target: { kind: 'self' },
        steps: [
            { at: 0, set: { opacity: 1, y: 0, scale: 1, blur: 0 } },
            { at: 100, set: { opacity: 0.1, y: -90, scale: 0.92, blur: 8 } },
        ],
    }],
};

/** A tilted ribbon that also slides sideways with the scroll (both ribbons share the tilt, so they
 *  run parallel instead of crossing over each other's text). */
const ixRibbon = (dir: 1 | -1) => ({
    v: 1,
    trigger: { on: 'scrub' },
    tracks: [{
        target: { kind: 'self' },
        steps: [
            { at: 0, set: { x: -140 * dir, rotate: -2.2 } },
            { at: 100, set: { x: 140 * dir, rotate: -2.2 } },
        ],
    }],
});

/** A line of the pinned scene lights up during its stretch of the scene. */
const ixSceneLine = (from: number, to: number) => ({
    v: 1,
    trigger: { on: 'scrub', src: 'scene', range: { from: { at: 'contain', pct: from }, to: { at: 'contain', pct: to } } },
    tracks: [{
        target: { kind: 'self' },
        steps: [
            { at: 0, set: { opacity: 0.12, y: 26, blur: 6 } },
            { at: 100, set: { opacity: 1, y: 0, blur: 0 } },
        ],
    }],
});

/** The glowing orb grows and turns for the whole pinned scene. */
const ixSceneOrb = {
    v: 1,
    trigger: { on: 'scrub', src: 'scene' },
    tracks: [{
        target: { kind: 'self' },
        steps: [
            { at: 0, set: { scale: 0.45, opacity: 0.35, rotate: 0 } },
            { at: 100, set: { scale: 1.45, opacity: 1, rotate: 160 } },
        ],
    }],
};

/** 3D tilt that follows the pointer (rests flat on touch screens). */
const ixTilt = {
    v: 1,
    trigger: { on: 'pointer', smooth: 180 },
    tracks: [
        { target: { kind: 'self' }, steps: [{ at: 0, set: { rotateY: -7 } }, { at: 100, set: { rotateY: 7 } }] },
        { target: { kind: 'children' }, axis: 'y', steps: [{ at: 0, set: { rotateX: 6 } }, { at: 100, set: { rotateX: -6 } }] },
    ],
};

/** Gentle perpetual float (the page offers the WCAG 2.2.2 pause control on its own). */
const ixFloat = {
    v: 1,
    trigger: { on: 'load', delay: 0 },
    tracks: [{
        target: { kind: 'self' },
        dur: 5200,
        repeat: 'inf',
        alt: true,
        steps: [
            { at: 0, set: { y: -10, rotate: -1.5 }, ease: 'in-out' },
            { at: 100, set: { y: 10, rotate: 1.5 } },
        ],
    }],
};

/* ── Block helpers ────────────────────────────────────────────────────────────────────────────────── */
type Block = { type: string; props: Record<string, any> };
const B = (type: string, key: string, props: Record<string, any>): Block =>
    ({ type, props: { id: `showcase-${type}-${key}`, anim: {}, hide: {}, look: {}, ...props } });
const p = (html: string) => `<p>${html}</p>`;
const icon = (name: string) => `<i class="fa-solid ${name}" aria-hidden="true"></i>`;

const eyebrow = (key: string, text: string, opts: { color?: string; align?: string; ix?: any } = {}) =>
    B('Text', key, {
        content: p(`<strong>${text}</strong>`),
        color: opts.color || C.indigo,
        size: '13',
        look: { align: opts.align || 'center', letterSpacing: 3, transform: 'uppercase', mb: 14 },
        ...(opts.ix ? { ix: opts.ix } : {}),
    });

const sectionTitle = (key: string, title: string, opts: { align?: string; anchor?: string; mb?: number } = {}) =>
    B('Heading', key, {
        title,
        level: 'h2',
        ...(opts.anchor ? { elementId: opts.anchor } : {}),
        size: 'clamp(32px, 4.4vw, 56px)',
        tracking: '-1.5',
        look: { align: opts.align || 'center', lineHeight: 1.08, mb: opts.mb ?? 16 },
        ix: ixWordsView(),
    });

const lead = (key: string, html: string, opts: { align?: string; mb?: number; delay?: 0 | 120 | 240 } = {}) =>
    B('Text', key, {
        content: p(html),
        color: C.muted,
        size: 'clamp(17px, 1.5vw, 19px)',
        leading: '1.7',
        measure: '640',
        css: opts.align === 'left' ? {} : { margin: '0 auto' },
        look: { align: opts.align || 'center', mb: opts.mb ?? 48 },
        ix: ixUpView(opts.delay ?? 120),
    });

const chip = (key: string, html: string) => B('Text', key, {
    content: p(html),
    color: C.muted,
    size: '14',
    look: { bg: 'color', bgColor: 'rgba(255,255,255,.75)', radius: 999, padY: 8, padX: 16, borderWidth: 1, borderStyle: 'solid', borderColor: C.line },
});

/* ── 1 · HERO ─────────────────────────────────────────────────────────────────────────────────────── */
function hero(siteName: string): Block {
    return B('Section', 'hero', {
        maxWidth: '100%',
        pad: '0',
        look: { bg: 'gradient', gradFrom: '#f8f9ff', gradVia: '#ffffff', gradTo: '#ede9fe', gradAngle: 160, gradAnimate: true },
        css: { minHeight: 'calc(100svh - 80px)', display: 'flex', alignItems: 'center', overflow: 'hidden' },
        children: [
            { type: 'ParticleField', props: { id: 'showcase-ParticleField-hero', count: 50, color: C.purple, speed: 'slow', linkLines: 'true', linkDistance: 120, pointer: 'true', css: {} } },
            B('Section', 'hero-inner', {
                maxWidth: '1100px',
                pad: 'clamp(72px, 10vw, 130px) 20px clamp(64px, 8vw, 100px)',
                bg: 'transparent',
                look: { align: 'center' },
                ix: ixHeroExit,
                children: [
                    eyebrow('hero-eyebrow', `Welcome to ${siteName}`, { ix: ixUpLoad(0) }),
                    B('Heading', 'hero-title', {
                        title: 'Build anything.',
                        level: 'h1',
                        size: 'clamp(46px, 8vw, 112px)',
                        weight: '700',
                        tracking: '-3',
                        look: { lineHeight: 0.98, mb: 0 },
                        ix: ixWordsLoad(150, 110),
                    }),
                    B('Heading', 'hero-title-2', {
                        title: 'Make it move.',
                        level: 'h2',
                        elementId: 'gradient-hero',
                        size: 'clamp(46px, 8vw, 112px)',
                        weight: '700',
                        tracking: '-3',
                        look: { lineHeight: 1.04, mb: 28 },
                        ix: ixWordsLoad(520, 120),
                    }),
                    B('Text', 'hero-lead', {
                        content: p('This whole page was built in the <strong>WordJS visual editor</strong> — without a single line of code. Every heading, card, animation and scroll effect you see is a block you can open, change or delete.'),
                        color: C.muted,
                        size: 'clamp(17px, 1.6vw, 20px)',
                        leading: '1.6',
                        measure: '660',
                        css: { margin: '0 auto' },
                        ix: ixUpLoad(1100),
                    }),
                    B('FlexRow', 'hero-actions', {
                        justify: 'center', align: 'center', gap: '14px', wrap: 'wrap', direction: 'row',
                        look: { mt: 36 },
                        ix: ixUpLoad(1100),
                        children: [
                            B('Button', 'hero-cta', { label: 'Edit this page  →', href: '/admin/pages', variant: 'primary', align: 'center', size: '16', padY: '17', padX: '30', look: { hover: 'shine', hoverColor: 'rgba(255,255,255,.45)' } }),
                            B('Button', 'hero-cta-2', { label: 'See what’s inside', href: '#features', variant: 'outline', align: 'center', size: '16', padY: '17', padX: '30' }),
                        ],
                    }),
                    B('FlexRow', 'hero-meta', {
                        justify: 'center', align: 'center', gap: '10px', wrap: 'wrap', direction: 'row',
                        look: { mt: 40 },
                        ix: ixUpLoad(1100),
                        children: [
                            chip('hero-chip-editor', `${icon('fa-wand-magic-sparkles')}&nbsp; Visual editor`),
                            chip('hero-chip-motion', `${icon('fa-film')}&nbsp; Scroll-driven motion`),
                            chip('hero-chip-sandbox', `${icon('fa-shield-halved')}&nbsp; Sandboxed plugins`),
                        ],
                    }),
                ],
            }),
        ],
    });
}

/* ── 2 · RIBBONS ──────────────────────────────────────────────────────────────────────────────────── */
/* Each ribbon is two identical halves (the theme slides it -50% in a loop); each half must be wider
 * than 1.5 screens plus the scroll sway, or a gap shows — hence the repeats. */
const RIBBON_FEATURES = 'Visual editor ✦ Scroll interactions ✦ Design tokens ✦ Sandboxed plugins ✦ Forms ✦ SEO ✦ Multilingual ✦ REST API ✦ ';
const RIBBON_STACK = 'SQLite ✦ PostgreSQL ✦ MySQL ✦ Docker ✦ Your own server ✦ Open source ✦ ';
const ribbons = B('Section', 'ribbons', {
    maxWidth: '100%',
    pad: '56px 0',
    css: { overflow: 'hidden' },
    children: [
        B('Section', 'ribbon-1', {
            maxWidth: '100%',
            pad: '18px 0',
            bg: C.night,
            css: { width: '200%', marginLeft: '-50%' },
            ix: ixRibbon(1),
            children: [
                B('Text', 'ribbon-1-text', {
                    elementId: 'marquee-features',
                    content: p(RIBBON_FEATURES.repeat(6)),
                    color: C.nightText,
                    size: 'clamp(26px, 3.2vw, 44px)',
                    leading: '1.1',
                    look: { fontFamily: 'var(--wjs-font-family-heading)' },
                }),
            ],
        }),
        B('Section', 'ribbon-2', {
            maxWidth: '100%',
            pad: '14px 0',
            look: { bg: 'gradient', gradFrom: C.indigo, gradVia: C.violet, gradTo: C.pink, gradAngle: 90 },
            css: { width: '200%', marginLeft: '-50%' },
            ix: ixRibbon(-1),
            children: [
                B('Text', 'ribbon-2-text', {
                    elementId: 'marquee-reverse-stack',
                    content: p(RIBBON_STACK.repeat(12)),
                    color: '#ffffff',
                    size: 'clamp(18px, 1.9vw, 26px)',
                    leading: '1.1',
                    look: { fontFamily: 'var(--wjs-font-family-heading)' },
                }),
            ],
        }),
    ],
});

/* ── 3 · STATS ────────────────────────────────────────────────────────────────────────────────────── */
const stats = B('Section', 'stats', {
    maxWidth: '1100px',
    pad: '8px 20px clamp(56px, 7vw, 96px)',
    children: [
        B('Stats', 'stats-row', {
            items: [
                { value: '0', label: 'Lines of code' },
                { value: '39', label: 'Built-in blocks' },
                { value: '30+', label: 'Plugins to add' },
                { value: '3', label: 'Databases' },
            ],
            valueSize: 'clamp(40px, 5vw, 64px)',
            ix: ixUpView(0),
        }),
    ],
});

/* ── 4 · FEATURES ─────────────────────────────────────────────────────────────────────────────────── */
const card = (key: string, i: number, iconName: string, title: string, text: string, accent = false) => B('Section', key, {
    maxWidth: '100%',
    pad: 'clamp(26px, 3vw, 34px) clamp(22px, 2.6vw, 30px)',
    look: {
        bg: accent ? 'gradient' : 'color',
        bgColor: '#ffffff',
        gradFrom: C.indigo,
        gradVia: C.violet,
        gradTo: C.purple,
        gradAngle: 145,
        gradAnimate: accent,
        radius: 26,
        borderWidth: accent ? 0 : 1,
        borderStyle: 'solid',
        borderColor: C.line,
        shadow: accent ? 'lg' : 'soft',
        hover: 'lift',
        hoverAmount: 6,
        color: accent ? '#ffffff' : C.text,
    },
    ix: ixFlipView(i),
    children: [
        B('Text', `${key}-icon`, {
            content: p(icon(iconName)),
            color: accent ? '#ffffff' : C.indigo,
            size: '22',
            leading: '1',
            css: { width: '52px', height: '52px', borderRadius: '16px', backgroundColor: accent ? 'rgba(255,255,255,.18)' : C.soft, display: 'flex', alignItems: 'center', justifyContent: 'center' },
            look: { mb: 20 },
        }),
        B('Heading', `${key}-title`, { title, level: 'h3', size: '21', color: accent ? '#ffffff' : '', look: { mb: 10 } }),
        B('Text', `${key}-text`, { content: p(text), color: accent ? 'rgba(255,255,255,.9)' : C.muted, size: '16', leading: '1.65' }),
    ],
});

const FEATURES: Array<[string, string, string]> = [
    ['fa-wand-magic-sparkles', 'Visual editor', 'Drag blocks, type straight onto the page and see exactly what your visitors will see.'],
    ['fa-film', 'Motion & interactions', 'Word reveals, 3D flips, pinned scenes and scroll-scrubbed effects — set from a panel, no JavaScript.'],
    ['fa-palette', 'Themes & design tokens', 'Switch the whole look in one click, then fine-tune colors and fonts live in the customizer.'],
    ['fa-shield-halved', 'Sandboxed plugins', 'Each plugin runs in its own isolated process and only gets the permissions you grant it.'],
    ['fa-envelope-open-text', 'Forms that work', 'Contact, sign-up or request forms. Every submission is stored safely in your admin.'],
    ['fa-language', 'Multilingual', 'Translate your content and let visitors switch language with one block.'],
    ['fa-gauge-high', 'SEO & speed', 'Server-rendered pages, clean URLs, sitemaps and meta tags out of the box.'],
    ['fa-code', 'Open REST API', 'Everything is an API: build apps on top, automate, or import a WordPress site.'],
];
const features = B('Section', 'features', {
    maxWidth: '100%',
    pad: 'clamp(72px, 9vw, 120px) 20px',
    bg: '#ffffff',
    children: [
        B('Section', 'features-inner', {
            maxWidth: '1240px',
            pad: '0',
            bg: 'transparent',
            children: [
                eyebrow('features-eyebrow', 'Everything in the box', { ix: ixUpView(0) }),
                sectionTitle('features-title', 'One platform. Every kind of site.', { anchor: 'features' }),
                lead('features-lead', 'Pages, posts, media, menus, users, forms, themes and plugins — managed from one admin, rendered fast on your own server.'),
                B('Grid', 'features-grid', {
                    columns: '4',
                    columnsTablet: '2',
                    columnsMobile: '1',
                    gap: '22px',
                    children: FEATURES.map(([ic, title, text], i) => card(`feature-${i + 1}`, i, ic, title, text, i === 1)),
                }),
            ],
        }),
    ],
});

/* ── 5 · PINNED SCENE ─────────────────────────────────────────────────────────────────────────────── */
const sceneLine = (key: string, text: string, from: number, to: number, elementId?: string) => B('Text', key, {
    ...(elementId ? { elementId } : {}),
    content: p(text),
    color: C.nightText,
    size: 'clamp(30px, min(6vw, 9svh), 84px)',
    leading: '1.08',
    look: { fontFamily: 'var(--wjs-font-family-heading)', align: 'center', mb: 6 },
    ix: ixSceneLine(from, to),
});
const scene = B('Section', 'scene', {
    maxWidth: '100%',
    stick: '3',
    pad: 'clamp(14px, 8svh, 72px) 20px',
    bg: C.night,
    css: { overflow: 'clip' },
    children: [
        B('Section', 'scene-orb', {
            maxWidth: '100%',
            pad: '0',
            bg: 'transparent',
            css: { height: '0' },
            children: [
                // A soft glow behind the lines. It hangs from a zero-height wrapper so it takes no room
                // in the flow; the lines that follow paint over it.
                B('Text', 'scene-orb-shape', {
                    content: '',
                    css: {
                        width: 'min(84vw, 70svh)',
                        height: 'min(84vw, 70svh)',
                        margin: '0 auto',
                        borderRadius: '999px',
                        backgroundImage: 'radial-gradient(circle at 35% 35%, rgba(168,85,247,.55), rgba(79,70,229,.35) 38%, rgba(236,72,153,.18) 58%, transparent 70%)',
                    },
                    ix: ixSceneOrb,
                }),
            ],
        }),
        eyebrow('scene-eyebrow', 'How it works · keep scrolling', { color: C.nightMuted }),
        sceneLine('scene-1', 'Drop in a block.', 0, 22),
        sceneLine('scene-2', 'Type your words.', 20, 44),
        sceneLine('scene-3', 'Make it move.', 42, 68),
        sceneLine('scene-4', 'Publish.', 66, 92, 'gradient-publish'),
        B('Text', 'scene-note', {
            content: p('This section is a <strong>pinned scene</strong>: it holds still while you scroll and each line lights up on its own stretch. Set it with one dropdown.'),
            color: C.nightMuted,
            size: '15',
            leading: '1.6',
            measure: '520',
            css: { margin: '0 auto' },
            look: { align: 'center', mt: 34 },
        }),
    ],
});

/* ── 6 · SHOWCASE CAROUSEL ────────────────────────────────────────────────────────────────────────── */
const USE_CASES: Array<[string, string, string, string]> = [
    ['fa-church', 'Churches & communities', 'Meeting times, what you believe, a pinned Scripture scene, prayer requests and events.', 'Forms · Events calendar · Pinned scenes'],
    ['fa-utensils', 'Restaurants & cafés', 'A menu with prices and photos, opening hours and table reservations.', 'Restaurant menu · Bookings'],
    ['fa-bag-shopping', 'Online stores', 'Products, cart, checkout and orders — or sell downloads and tickets.', 'Online store · Digital downloads'],
    ['fa-ticket', 'Conferences & events', 'Registration, tickets, lodging, meals and printed badges.', 'Conference manager · Event tickets'],
    ['fa-camera-retro', 'Portfolios', 'Full-bleed galleries, lightboxes and case studies that move.', 'Photo carousel · Image lightbox'],
    ['fa-newspaper', 'Magazines & blogs', 'Posts, categories, related reading and a newsletter.', 'Newsletter · Related posts'],
    ['fa-graduation-cap', 'Schools & courses', 'Calendars, FAQs, polls and a place for every announcement.', 'Events calendar · FAQ · Polls'],
    ['fa-hand-holding-heart', 'Nonprofits', 'Tell your story, take donations and keep supporters informed.', 'Donations · Newsletter'],
];
const slide = (n: number, [ic, title, text, uses]: [string, string, string, string]) => B('Section', `slide-${n}`, {
    maxWidth: '100%',
    pad: 'clamp(26px, 2.8vw, 34px) clamp(22px, 2.4vw, 28px)',
    look: { bg: 'color', bgColor: '#ffffff', radius: 26, borderWidth: 1, borderStyle: 'solid', borderColor: C.line, shadow: 'soft', hover: 'lift', hoverAmount: 6 },
    ix: ixFlipView(n - 1),
    children: [
        B('Text', `slide-${n}-icon`, {
            elementId: `carousel-${n}`,
            content: p(icon(ic)),
            color: '#ffffff',
            size: '24',
            leading: '1',
            css: { width: '58px', height: '58px', borderRadius: '999px', backgroundImage: `linear-gradient(135deg, ${C.indigo}, ${C.pink})`, display: 'flex', alignItems: 'center', justifyContent: 'center' },
            look: { mb: 20 },
        }),
        B('Heading', `slide-${n}-title`, { title, level: 'h3', size: '22', look: { mb: 10 } }),
        B('Text', `slide-${n}-text`, { content: p(text), color: C.muted, size: '16', leading: '1.65', look: { mb: 16 } }),
        B('Text', `slide-${n}-uses`, { content: p(`<strong>${uses}</strong>`), color: C.violet, size: '13', leading: '1.5' }),
    ],
});
const showcase = B('Section', 'showcase', {
    maxWidth: '100%',
    pad: 'clamp(80px, 9vw, 130px) 20px',
    bg: C.soft,
    children: [
        B('Section', 'showcase-inner', {
            maxWidth: '1240px',
            pad: '0',
            bg: 'transparent',
            children: [
                eyebrow('showcase-eyebrow', 'Made for every kind of site', { ix: ixUpView(0) }),
                sectionTitle('showcase-title', 'From churches to online stores.', { anchor: 'showcase' }),
                lead('showcase-lead', 'Start from the same blocks, add the plugins you need, and make it yours. Swipe through a few ideas.'),
                B('Grid', 'showcase-carousel', {
                    columns: '4',
                    columnsTablet: '2',
                    columnsMobile: '1',
                    gap: '22px',
                    children: USE_CASES.map((u, i) => slide(i + 1, u)),
                }),
                B('Text', 'showcase-swipe', {
                    content: p('Swipe to see more &nbsp;→'),
                    color: C.muted,
                    size: '14',
                    hide: { desktop: true },
                    look: { align: 'center', mt: 6 },
                }),
            ],
        }),
    ],
});

/* ── 7 · SANDBOXED PLUGINS (tilt card) ────────────────────────────────────────────────────────────── */
const permission = (key: string, ok: boolean, text: string) => B('Text', key, {
    content: p(`<span style="color:${ok ? '#34d399' : '#fb7185'}">${icon(ok ? 'fa-circle-check' : 'fa-circle-xmark')}</span>&nbsp; ${text}`),
    color: C.nightText,
    size: '15',
    leading: '1.5',
    look: { mb: 10, fontFamily: 'var(--wjs-font-family-mono)' },
});
const plugins = B('Section', 'plugins', {
    maxWidth: '1200px',
    pad: 'clamp(80px, 9vw, 130px) 20px',
    children: [
        B('Columns', 'plugins-cols', {
            distribution: { columnCount: 2, widths: [52, 42] },
            gap: '64',
            'col-0': [
                eyebrow('plugins-eyebrow', 'Extend without fear', { align: 'left', ix: ixUpView(0) }),
                sectionTitle('plugins-title', 'Plugins that can’t take over your site.', { align: 'left', anchor: 'plugins', mb: 24 }),
                lead('plugins-lead', 'In most CMSs a plugin can read every file and every password. In WordJS each plugin runs in its <strong>own sandboxed process</strong> and asks for permissions — like an app on your phone. You decide what it gets.', { align: 'left', mb: 30 }),
                B('FlexRow', 'plugins-actions', {
                    justify: 'flex-start', gap: '12px', wrap: 'wrap', direction: 'row',
                    ix: ixUpView(240),
                    children: [
                        B('Button', 'plugins-browse', { label: 'Browse plugins', href: '/admin/plugins', variant: 'primary' }),
                        B('Button', 'plugins-themes', { label: 'Try another theme', href: '/admin/themes', variant: 'outline' }),
                    ],
                }),
            ],
            'col-1': [
                B('Section', 'plugins-card', {
                    maxWidth: '100%',
                    pad: 'clamp(30px, 3.6vw, 44px) clamp(24px, 3vw, 36px)',
                    look: { bg: 'gradient', gradFrom: '#111827', gradVia: '#1e1b4b', gradTo: '#312e81', gradAngle: 150, radius: 30, shadow: 'lg' },
                    ix: ixTilt,
                    children: [
                        B('Text', 'plugins-card-icon', {
                            content: p(icon('fa-puzzle-piece')),
                            color: '#c4b5fd',
                            size: '38',
                            look: { mb: 16 },
                            ix: ixFloat,
                        }),
                        B('Text', 'plugins-card-name', {
                            content: p('<strong>online-store</strong> wants to:'),
                            color: '#ffffff',
                            size: '18',
                            look: { mb: 18, fontFamily: 'var(--wjs-font-family-mono)' },
                        }),
                        permission('plugins-perm-1', true, 'store its own tables'),
                        permission('plugins-perm-2', true, 'add pages and blocks'),
                        permission('plugins-perm-3', true, 'send order e-mails'),
                        permission('plugins-perm-4', false, 'read your users’ passwords'),
                        permission('plugins-perm-5', false, 'touch other plugins’ files'),
                    ],
                }),
            ],
        }),
    ],
});

/* ── 8 · TABS ─────────────────────────────────────────────────────────────────────────────────────── */
const tabs = B('Section', 'tabs', {
    maxWidth: '1000px',
    pad: '0 20px clamp(80px, 9vw, 130px)',
    children: [
        eyebrow('tabs-eyebrow', 'Under the hood', { ix: ixUpView(0) }),
        sectionTitle('tabs-title', 'Simple on the outside. Serious inside.', { mb: 40 }),
        B('Tabs', 'tabs-block', {
            tabs: [
                { label: 'For editors', content: 'Write and design in the same place. Undo anything, keep revisions, schedule posts, reuse sections as synced symbols, and preview on desktop, tablet and phone before you publish.' },
                { label: 'For designers', content: 'Themes are design tokens: four seed colours generate a full palette. Interactions, pinned scenes, gradients and hover effects are block settings — and every theme can restyle every block.' },
                { label: 'For developers', content: 'TypeScript from end to end, a documented REST API, page templates in JSON, and plugins that declare permissions and run sandboxed in their own process.' },
                { label: 'For owners', content: 'Run it on your own server or with Docker, on SQLite, PostgreSQL or MySQL. Backups, roles, two-factor sign-in and a WordPress importer come included.' },
            ],
            panelPad: '28',
            panelRadius: '20',
            ix: ixUpView(120),
        }),
    ],
});

/* ── 9 · PRICING ──────────────────────────────────────────────────────────────────────────────────── */
const pricing = B('Section', 'pricing', {
    maxWidth: '100%',
    pad: 'clamp(80px, 9vw, 130px) 20px',
    bg: C.soft,
    children: [
        B('Section', 'pricing-inner', {
            maxWidth: '1140px',
            pad: '0',
            bg: 'transparent',
            children: [
                eyebrow('pricing-eyebrow', 'Ready to sell', { ix: ixUpView(0) }),
                sectionTitle('pricing-title', 'A pricing table in one block.'),
                lead('pricing-lead', 'Sample plans — rename them, change the prices or highlight another one in the side panel.'),
                B('PricingTable', 'pricing-table', {
                    plans: [
                        { name: 'Starter', price: '$0', period: '/month', features: 'One website\nAll core blocks\nCommunity support', highlighted: 'false', buttonText: 'Start free', buttonLink: '#contact' },
                        { name: 'Studio', price: '$29', period: '/month', features: 'Unlimited pages\nPremium themes\nForms & newsletter\nPriority support', highlighted: 'true', buttonText: 'Try 14 days', buttonLink: '#contact' },
                        { name: 'Business', price: '$99', period: '/month', features: 'Online store\nTeam roles\nDaily backups\nDedicated support', highlighted: 'false', buttonText: 'Talk to us', buttonLink: '#contact' },
                    ],
                    ix: ixUpView(120),
                }),
            ],
        }),
    ],
});

/* ── 10 · LATEST POSTS ────────────────────────────────────────────────────────────────────────────── */
const blog = B('Section', 'blog', {
    maxWidth: '1240px',
    pad: 'clamp(80px, 9vw, 130px) 20px clamp(40px, 5vw, 64px)',
    children: [
        eyebrow('blog-eyebrow', 'From the blog', { ix: ixUpView(0) }),
        sectionTitle('blog-title', 'Your latest posts, always up to date.', { mb: 44 }),
        B('PostsGrid', 'blog-grid', { count: 3, columns: '3', ix: ixUpView(120) }),
    ],
});

/* ── 11 · FAQ + CONTACT FORM ──────────────────────────────────────────────────────────────────────── */
const contact = B('Section', 'contact', {
    maxWidth: '1200px',
    pad: 'clamp(56px, 7vw, 100px) 20px',
    children: [
        B('Columns', 'contact-cols', {
            distribution: { columnCount: 2, widths: [48, 46] },
            gap: '56',
            'col-0': [
                eyebrow('faq-eyebrow', 'Questions', { align: 'left', ix: ixUpView(0) }),
                sectionTitle('faq-title', 'Good to know.', { align: 'left', anchor: 'faq', mb: 28 }),
                B('Accordion', 'faq', {
                    items: [
                        { title: 'Do I need to know how to code?', content: 'No. Everything on this page was made by clicking and typing in the visual editor. Developers can go further with themes, templates and plugins.' },
                        { title: 'Is WordJS free?', content: 'Yes. WordJS is open source and runs on your own server or with Docker.' },
                        { title: 'Can I move my WordPress site?', content: 'Yes. The importer reads a WordPress export file and brings in your posts, pages, categories and media.' },
                        { title: 'Will it work on phones?', content: 'Every block is responsive, and you can hide or restyle any block on desktop, tablet or phone.' },
                        { title: 'How do I change this page?', content: 'Sign in, open Pages → Home and click any block. To start from a blank page, select a section and press Delete.' },
                    ],
                    ix: ixUpView(120),
                }),
            ],
            'col-1': [
                B('Section', 'contact-card', {
                    maxWidth: '100%',
                    pad: 'clamp(28px, 3.4vw, 40px)',
                    look: { bg: 'color', bgColor: '#ffffff', radius: 28, borderWidth: 1, borderStyle: 'solid', borderColor: C.line, shadow: 'lg' },
                    ix: ixFlipView(1),
                    children: [
                        B('Heading', 'contact-title', { title: 'Get in touch', level: 'h3', elementId: 'contact', size: '28', look: { mb: 8 } }),
                        B('Text', 'contact-text', { content: p('A real form: submissions arrive in <strong>Admin → Forms</strong>.'), color: C.muted, size: '15', look: { mb: 22 } }),
                        B('Form', 'contact-form', {
                            formName: 'Contact',
                            fields: [
                                { type: 'text', label: 'Name', required: true, options: '', placeholder: 'Your name' },
                                { type: 'email', label: 'Email', required: true, options: '', placeholder: 'you@example.com' },
                                { type: 'select', label: 'I am building', required: false, options: 'A business site, An online store, A church or community site, A blog, Something else', placeholder: '' },
                                { type: 'textarea', label: 'Message', required: false, options: '', placeholder: 'Tell us about your project' },
                            ],
                            submitLabel: 'Send message',
                            successMessage: 'Thank you! Your message has been received.',
                            errorMessage: 'The form could not be sent. Please try again.',
                        }),
                    ],
                }),
            ],
        }),
    ],
});

/* ── 12 · FINAL CALL ──────────────────────────────────────────────────────────────────────────────── */
const final = B('Section', 'final', {
    maxWidth: '1240px',
    pad: 'clamp(40px, 6vw, 80px) 20px clamp(80px, 9vw, 130px)',
    children: [
        B('CTABanner', 'final-cta', {
            title: 'Now make it yours.',
            subtitle: 'Change a word, swap the theme or start from a blank page — this demo is yours to take apart.',
            buttonText: 'Open the editor',
            buttonLink: '/admin/pages',
            variant: 'gradient',
            bg: `linear-gradient(120deg, ${C.indigo}, ${C.violet} 50%, ${C.pink})`,
            color: '#ffffff',
            pad: 'clamp(52px, 7vw, 88px) clamp(22px, 5vw, 48px)',
            radius: '40',
            titleSize: 'clamp(32px, 4.2vw, 54px)',
            buttonBg: '#ffffff',
            buttonColor: C.violet,
            look: { shadow: 'xl' },
            ix: ixCurtainView,
        }),
        B('SocialLinks', 'final-social', {
            items: [
                { network: 'github', url: 'https://github.com' },
                { network: 'x', url: 'https://x.com' },
                { network: 'youtube', url: 'https://youtube.com' },
                { network: 'instagram', url: 'https://instagram.com' },
            ],
            align: 'center',
            size: '50',
            bg: C.soft,
            color: C.indigo,
            hoverBg: '#e0e7ff',
            gap: '14',
            look: { mt: 40 },
            ix: ixUpView(240),
        }),
        { type: 'BackToTop', props: { id: 'showcase-BackToTop' } },
    ],
});

/** The seeded home page document (`_puck_data`). */
function showcaseHomeData(siteName: string) {
    return {
        root: { props: { title: `Welcome to ${siteName}` } },
        content: [hero(siteName), ribbons, stats, features, scene, showcase, plugins, tabs, pricing, blog, contact, final],
        zones: {},
    };
}

module.exports = { showcaseHomeData };

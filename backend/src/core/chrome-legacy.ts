/**
 * WordJS - Legacy chrome → composable chrome
 *
 * Before the composable editor (/admin/chrome) the site chrome had two other sources:
 *
 *   FOOTER  the /admin/footer page wrote three SITE options — `footer_text` (HTML), `footer_copyright`
 *           (HTML) and `footer_socials` (JSON list) — that the built-in Footer.tsx renders in the
 *           active theme's layout v2 variant (`columns` with 1–4 columns, or `minimal`), plus the
 *           `footer-1` widget area and the footer menu location.
 *   HEADER  no site options at all: Header.tsx renders the theme.json `layout.header` variant
 *           (`classic` / `centered` / `minimal`) with its `sticky` / `transparent` flags, bound to the
 *           site logo, the site title and the header menu location.
 *
 * This module turns both into compositions of the same chrome contract the editor writes, so a site
 * keeps exactly what it had once the legacy page is gone:
 *
 *   legacyChromeComposition(part)  → the composition that reproduces what the built-in chrome renders
 *                                    today. The editor opens it as the starting point when neither the
 *                                    site nor the theme has a composition (source "legacy").
 *   migrateLegacyChrome()          → the one-shot conversion. LOSSLESS: the legacy options are never
 *                                    modified or deleted (deleting the composition puts the site back on
 *                                    the built-in footer, byte-for-byte). IDEMPOTENT: it only ever
 *                                    writes when no site composition exists, so a second run — or a run
 *                                    after the admin edited the result — changes nothing.
 *
 * It only migrates a footer that is ACTUALLY RENDERING. When the active theme ships its own
 * chrome/footer.json, that file — not Footer.tsx — is what visitors see, and the legacy text was never
 * on the page; writing a site composition would REPLACE the theme's footer, a visible change nobody
 * asked for. Those sites are reported (`theme-composition`) and the editor offers the legacy text as
 * blocks to insert by hand. Every value goes through validateChromeData before it is stored, like any
 * other write.
 */

const fs = require('fs');
const path = require('path');
const { getOption, updateOption } = require('./options');
const { validateChromeData } = require('./chrome-validate');

type Part = 'header' | 'footer';
type Block = { type: string; props: Record<string, any> };
type Composition = { root: { props: Record<string, any> }; content: Block[] };

/** Footer.tsx's literal column headings — kept verbatim so the converted footer reads the same. */
const LEGACY_FOOTER_MENU_TITLE = 'Quick Links';
const LEGACY_FOOTER_SOCIAL_TITLE = 'Connect';
/** The widget area Footer.tsx renders above its columns. */
const LEGACY_FOOTER_WIDGET_AREA = 'footer-1';

function asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function parseJsonOption(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
}

/** Same normalization as frontend/src/lib/themeLayout.ts parseThemeLayout — absent ≡ today's chrome. */
function normalizeLayout(raw: unknown) {
    const layout = asRecord(parseJsonOption(raw));
    const header = asRecord(layout.header);
    const footer = asRecord(layout.footer);
    const variant = ['classic', 'centered', 'minimal'].includes(header.variant) ? header.variant : 'classic';
    const footerVariant = ['columns', 'minimal'].includes(footer.variant) ? footer.variant : 'columns';
    const columns = [1, 2, 3, 4].includes(footer.columns) ? footer.columns : 4;
    return {
        header: { variant: variant as 'classic' | 'centered' | 'minimal', sticky: header.sticky !== false, transparent: header.transparent === true },
        footer: { variant: footerVariant as 'columns' | 'minimal', columns: columns as 1 | 2 | 3 | 4 },
    };
}

export interface LegacySettings {
    footer_text?: unknown;
    footer_copyright?: unknown;
    active_theme_layout?: unknown;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * The header Header.tsx renders for a layout v2 header config, as a composition. Pure.
 *   classic   logo left, nav right (hamburger below md)
 *   centered  logo centred on its own row, nav centred on the row below
 *   minimal   logo left, hamburger only — the nav lives in the drawer at every width
 * sticky/transparent carry over as root props, which the composed header honours the same way.
 */
function buildLegacyHeader(settings: LegacySettings): Composition {
    const { header } = normalizeLayout(settings.active_theme_layout);
    const root = { props: { sticky: header.sticky, transparent: header.transparent } };
    const logo: Block = { type: 'ChromeLogo', props: { size: 'md' } };
    if (header.variant === 'centered') {
        return {
            root,
            content: [
                { type: 'ChromeRow', props: { align: 'center', gap: 'md', items: [logo] } },
                { type: 'ChromeRow', props: { align: 'center', gap: 'md', items: [{ type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal' } }] } },
            ],
        };
    }
    const nav: Block = header.variant === 'minimal'
        ? { type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal', collapse: 'always' } }
        : { type: 'ChromeNav', props: { location: 'header', orientation: 'horizontal' } };
    return { root, content: [{ type: 'ChromeRow', props: { align: 'between', gap: 'md', items: [logo, nav] } }] };
}

/**
 * The footer Footer.tsx renders for the legacy options + layout v2 footer config, as a composition.
 * Pure. Empty legacy fields produce no block, exactly as Footer.tsx renders nothing for them; the menu
 * and socials columns carry their headings as block titles, which (like Footer.tsx) only show when
 * the column has something to list.
 */
function buildLegacyFooter(settings: LegacySettings): Composition {
    const { footer } = normalizeLayout(settings.active_theme_layout);
    const footerText = text(settings.footer_text);
    const copyright = text(settings.footer_copyright);
    const widgets: Block = { type: 'ChromeWidgets', props: { area: LEGACY_FOOTER_WIDGET_AREA } };
    const socials: Block = { type: 'ChromeSocials', props: { source: 'settings' } };
    const copyrightBlock: Block | null = copyright ? { type: 'ChromeRichText', props: { html: copyright } } : null;

    if (footer.variant === 'minimal') {
        // minimal: one row — copyright left, socials right.
        const items = [copyrightBlock, socials].filter(Boolean) as Block[];
        return {
            root: { props: {} },
            content: [widgets, { type: 'ChromeRow', props: { align: 'between', gap: 'md', wrap: true, stack: 'mobile', items } }],
        };
    }

    const brandItems: Block[] = [{ type: 'ChromeLogo', props: { size: 'sm', showTitle: true } }];
    if (footerText) brandItems.push({ type: 'ChromeRichText', props: { html: footerText } });
    const column = (items: Block[]): Block => ({ type: 'ChromeRow', props: { direction: 'column', align: 'start', gap: 'md', items } });
    const cells: Block[] = [
        column(brandItems),
        column([{ type: 'ChromeNav', props: { location: 'footer', orientation: 'vertical', title: LEGACY_FOOTER_MENU_TITLE } }]),
        column([{ ...socials, props: { ...socials.props, title: LEGACY_FOOTER_SOCIAL_TITLE } }]),
    ];
    // Footer.tsx's 1-column grid stacks everything; ChromeColumns starts at 2, so one column is a
    // vertical row of the same three cells.
    const grid: Block = footer.columns === 1
        ? { type: 'ChromeRow', props: { direction: 'column', align: 'start', gap: 'lg', items: cells } }
        : { type: 'ChromeColumns', props: { columns: String(footer.columns), gap: 'lg', items: cells } };
    const content: Block[] = [widgets, grid];
    if (copyrightBlock) content.push({ type: 'ChromeRow', props: { align: 'center', gap: 'sm', items: [copyrightBlock] } });
    return { root: { props: {} }, content };
}

async function readLegacySettings(): Promise<LegacySettings> {
    const [footerText, footerCopyright, layout] = await Promise.all([
        getOption('footer_text', ''),
        getOption('footer_copyright', ''),
        getOption('active_theme_layout', ''),
    ]);
    return { footer_text: footerText, footer_copyright: footerCopyright, active_theme_layout: layout };
}

/** The converted composition for one part, from the live options. Always contract-valid. */
async function legacyChromeComposition(part: Part): Promise<Composition> {
    const settings = await readLegacySettings();
    return part === 'header' ? buildLegacyHeader(settings) : buildLegacyFooter(settings);
}

/** Does the active theme ship a VALID composition for this part? (An invalid one falls through to the built-in chrome.) */
async function themeHasComposition(part: Part): Promise<boolean> {
    const { THEMES_DIR } = require('./themes');
    const slug = String(await getOption('template', 'default') || 'default');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(slug)) return false;
    const file = path.join(THEMES_DIR, slug, 'chrome', `${part}.json`);
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return false; }
    return validateChromeData(raw, { part }).ok;
}

export type MigrationOutcome =
    | 'migrated'           // a site composition was written from the legacy settings
    | 'site-composition'   // the site already has its own composition — nothing to do (idempotent re-run)
    | 'theme-composition'  // the active theme's chrome file is what renders; the legacy footer is not on the page
    | 'nothing-to-migrate'; // no legacy content (and the built-in chrome needs no conversion to stay editable)

/**
 * Convert the legacy FOOTER into the site footer composition. The header has no legacy SITE settings
 * (its look is the theme's layout v2 config, which keeps working), so it is never written here — the
 * editor still opens it from the converted composition so the first save keeps today's look.
 */
async function migrateLegacyChrome(): Promise<{ footer: MigrationOutcome; header: MigrationOutcome }> {
    const header: MigrationOutcome = 'nothing-to-migrate';
    // The option may come back as a string or as an already-parsed object; either non-empty form means
    // the site has its own footer.
    const stored: unknown = await getOption('site_chrome_footer', '');
    const hasSiteFooter = typeof stored === 'string' ? stored.trim() !== '' : stored != null;
    if (hasSiteFooter) return { footer: 'site-composition', header };
    const settings = await readLegacySettings();
    if (!text(settings.footer_text) && !text(settings.footer_copyright)) return { footer: 'nothing-to-migrate', header };
    if (await themeHasComposition('footer')) return { footer: 'theme-composition', header };
    const composition = buildLegacyFooter(settings);
    const result = validateChromeData(composition, { part: 'footer' });
    if (!result.ok) {
        // Cannot happen with a builder that only emits contract blocks — but a write that would fail
        // the write authority must never be stored, so refuse loudly instead.
        throw new Error(`legacy footer conversion produced an invalid composition: ${JSON.stringify(result.errors)}`);
    }
    await updateOption('site_chrome_footer', JSON.stringify(composition));
    return { footer: 'migrated', header };
}

module.exports = {
    buildLegacyHeader,
    buildLegacyFooter,
    legacyChromeComposition,
    migrateLegacyChrome,
    themeHasComposition,
    LEGACY_FOOTER_WIDGET_AREA,
};

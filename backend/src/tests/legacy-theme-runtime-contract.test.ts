const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The COMMITTED catalogue, not backend/themes. backend/themes is the runtime INSTALL dir — it holds
// only whatever this machine happens to have installed (and boot rewrites it), so a theme named here
// may simply not exist there, which is how this suite failed to even load. marketplace/themes is the
// source of truth for the shipped themes and is stable in every checkout.
const THEMES_ROOT = path.resolve(__dirname, '../../../marketplace/themes');
const PUCK_CONFIG = path.resolve(__dirname, '../../../frontend/src/components/puckConfig.tsx');

function read(relativePath: string): string {
    return fs.readFileSync(relativePath, 'utf8');
}

const atelierCss = read(path.join(THEMES_ROOT, 'atelier-noir/style.css'));
const luxeCss = read(path.join(THEMES_ROOT, 'luxe-boutique/style.css'));
const puckConfig = read(PUCK_CONFIG);

const runtimeHooks = [
    'wp-block-hero-title',
    'wp-block-hero-action',
    'wp-block-card-title',
    'wp-block-accordion-trigger',
    'wp-block-tabs-tab',
    'wp-block-pricing-plan',
    'wp-block-testimonial-quote',
    'wp-block-posts-grid-item',
    'wp-block-cta-banner-action',
    'wp-block-search-input',
    'wp-block-table-element',
];

describe('legacy themes target the current Puck DOM', () => {
    it('keeps every compatibility selector backed by a runtime class', () => {
        for (const hook of runtimeHooks) {
            assert.match(
                puckConfig,
                new RegExp(`className=[^\\n]*${hook}`),
                `${hook} is missing from Puck runtime`,
            );
        }
    });

    it('bridges Atelier Noir tokens and obsolete hero hooks without V3 resets', () => {
        for (const hook of runtimeHooks) {
            assert.match(
                atelierCss,
                new RegExp(`\\.${hook}(?:[^a-zA-Z0-9_-]|$)`),
                `Atelier does not style .${hook}`,
            );
        }
        assert.match(atelierCss, /--puck-card-bg:\s*var\(--wjs-card-bg\)/);
        assert.match(atelierCss, /--puck-accordion-bg:\s*var\(--wjs-accordion-bg\)/);
        assert.match(atelierCss, /\.wp-block-hero__title,\s*\n\.wp-block-hero-title/);
        assert.match(atelierCss, /\.wp-block-hero__button,\s*\n\.wp-block-hero-action/);
        assert.doesNotMatch(atelierCss, /wjs-theme-contract-v3|all:\s*revert/);
        assert.doesNotMatch(atelierCss, /^\s*header\s*\{/m);
        assert.doesNotMatch(atelierCss, /^\s*footer\s*\{/m);
    });

    it('maps Luxe Boutique demo classes to canonical hooks and scopes page typography', () => {
        for (const hook of runtimeHooks) {
            assert.match(
                luxeCss,
                new RegExp(`\\.${hook}(?:[^a-zA-Z0-9_-]|$)`),
                `Luxe does not style .${hook}`,
            );
        }
        assert.match(luxeCss, /\.wp-block-grid:has\(> \.wp-block-grid-items > \.wp-block-card\)/);
        assert.match(luxeCss, /wjs-public-site\.wjs-theme-contract-legacy/);
        assert.doesNotMatch(luxeCss, /wjs-theme-contract-v3|all:\s*revert/);
        assert.doesNotMatch(luxeCss, /^\s*body\s*\{/m);
        assert.doesNotMatch(luxeCss, /^\s*h1,\s*h2,\s*h3\s*\{/m);
    });

    it('loads the Luxe font import before every CSS declaration', () => {
        const importIndex = luxeCss.indexOf('@import url(');
        const firstDeclarationIndex = luxeCss.indexOf(':root');
        assert.ok(importIndex >= 0, 'Luxe font import is missing');
        assert.ok(
            importIndex < firstDeclarationIndex,
            'Luxe font import appears after declarations and would be ignored',
        );
        assert.equal(luxeCss.match(/@import url\(/g)?.length, 1);
    });
});

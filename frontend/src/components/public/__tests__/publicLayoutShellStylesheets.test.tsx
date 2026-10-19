import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Verso canvas linked the active theme's stylesheet three times. Its iframe document
 * (app/admin/canvas-frame) owns the framework and theme <link>s and swaps the theme one by id, and the
 * site chrome it renders inside (PublicLayoutShell) added a second copy through ThemeLoader, so the
 * swap compared against the wrong <link> and inserted another. The editor renders the shell with
 * `stylesheets={false}`: no <link> of its own.
 *
 * MUTATION PROOF: render ThemeLoader unconditionally in the shell and the second case fails; drop the
 * prop from VersoEditor and the third does.
 */
vi.mock('@/components/public/Header', () => ({ default: () => null }));
vi.mock('@/components/public/Footer', () => ({ default: () => null }));
vi.mock('@/lib/useActivePlugins', () => ({ ActivePluginsProvider: ({ children }: any) => children }));

import PublicLayoutShell from '../PublicLayoutShell';

const themeLinks = (html: string) => [...html.matchAll(/<link[^>]*href="([^"]*\/themes\/[^"]*)"/g)].map((m) => m[1]);

describe('PublicLayoutShell — stylesheets', () => {
    it('links the active theme on the public site', () => {
        const html = renderToStaticMarkup(<PublicLayoutShell themeSlug="default" themeVersion="2.1.0"><p>x</p></PublicLayoutShell>);
        expect(themeLinks(html)).toHaveLength(1);
    });

    it('links nothing with stylesheets={false}', () => {
        const html = renderToStaticMarkup(<PublicLayoutShell stylesheets={false}><p>x</p></PublicLayoutShell>);
        expect(themeLinks(html)).toEqual([]);
        expect(html).not.toContain('wordjs-ui.css');
        expect(html).toContain('<p>x</p>');
    });

    it('the Verso canvas renders the shell without its stylesheets', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../verso/editor/VersoEditor.tsx'), 'utf8');
        expect(src).toMatch(/<PublicLayoutShell stylesheets=\{false\}>/);
        expect(src).not.toMatch(/<PublicLayoutShell>/);
    });
});

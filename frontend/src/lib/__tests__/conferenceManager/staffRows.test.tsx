/**
 * conference-manager «Equipo y permisos» on a phone: who a person is (name, «@login · email», WordJS role
 * chip) next to a badge or buttons.
 *
 * Live finding (iPhone SE, the «Añadir una persona al equipo» results): @ana's «YA ESTÁ EN EL EQUIPO»
 * badge overlapped the top-right of her «ROL EN WORDJS: EQUIPO DE CONFERENCIA» chip, squeezed into four
 * lines; on an iPhone 13 her email broke mid-word, «ana@ex / ample.test». In the row
 * (`flex flex-wrap items-center gap-3`) the identity column was `min-w-0 flex-1`: flex-basis 0 and no
 * minimum, so the badge never wrapped to its own line — the column shrank to ~80 px instead, and the
 * chip's unbreakable uppercase words overflowed it, under the badge. The email line was `break-all`.
 *
 * Pinned (server-rendered markup, node environment): the identity column keeps a 12rem minimum (so the
 * badge wraps), the chip can never be wider than its column and wraps between words, and the account line
 * breaks only where it must. The team member row below the search shares the same column and line.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('react-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-dom')>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { I18nProvider } from '@/contexts/I18nContext';
import { ToastProvider } from '@/contexts/ToastContext';
import { UserResultRow, IDENTITY_COLUMN_CLASS, ACCOUNT_LINE_CLASS, ROLE_CHIP_CLASS } from '../../../../../marketplace/plugins/conference-manager/client/admin/StaffPage';
import { AA, contrastOf } from '../helpers/tailwindContrast';

const STAFF = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/StaffPage.tsx'), 'utf8');
const ANA = { id: 7, login: 'ana', name: 'ana', email: 'ana@example.test', role: 'conference_manager_team' } as any;

const render = (node: React.ReactElement) => renderToStaticMarkup(<I18nProvider><ToastProvider>{node}</ToastProvider></I18nProvider>);
const classOf = (html: string, attr: string) => {
    const m = new RegExp(`class="([^"]*)"[^>]*${attr}`).exec(html);
    expect(m, attr).toBeTruthy();
    return m![1].split(/\s+/);
};

describe('a search result next to «Ya está en el equipo»', () => {
    const html = render(<UserResultRow u={ANA} already block={null as any} roleName="Cocina" adding={null} canAdd onAdd={() => {}} />);

    it('the identity column keeps a minimum width, so the badge wraps under it instead of squeezing it', () => {
        const cls = classOf(html, 'data-user-identity');
        expect(cls).toContain('flex-1');
        expect(cls).toContain('min-w-[12rem]');
        expect(cls).not.toContain('min-w-0');
        expect(classOf(html, 'data-user-id')).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
        expect(html).toContain('data-user-badge="already"');
    });
    it('the role chip is never wider than its column and wraps between words', () => {
        const cls = classOf(html, 'data-user-wprole');
        expect(cls).toEqual(expect.arrayContaining(['inline-block', 'max-w-full', 'break-words']));
    });
    it('the email breaks only where it must, not mid-word wherever the line ends', () => {
        expect(ACCOUNT_LINE_CLASS.split(' ')).toContain('[overflow-wrap:anywhere]');
        expect(ACCOUNT_LINE_CLASS.split(' ')).not.toContain('break-all');
        expect(html).toContain('@ana · ana@example.test');
    });
    it('the badge and a blocked chip meet WCAG AA on their grey background', () => {
        expect(contrastOf('text-gray-600', 'white', 'bg-gray-100')).toBeGreaterThanOrEqual(AA);
        const blocked = render(<UserResultRow u={ANA} already={false} block={'not_team_role' as any} roleName="" adding={null} canAdd onAdd={() => {}} />);
        expect(classOf(blocked, 'data-user-wprole')).toContain('text-gray-600');
    });
});

describe('the «Personas del equipo» member row (same column, same account line)', () => {
    it('uses the shared identity column and account line', () => {
        expect(STAFF).toContain('<div className={IDENTITY_COLUMN_CLASS} data-member-identity="">');
        expect(STAFF).toContain('<div className={ACCOUNT_LINE_CLASS} data-member-account="">');
        // No identity text in the staff screens breaks mid-word any more.
        expect(STAFF).not.toMatch(/\bbreak-all\b/);
    });
    it('the shared classes are what the fix needs', () => {
        expect(IDENTITY_COLUMN_CLASS).toBe('min-w-[12rem] flex-1');
        expect(ROLE_CHIP_CLASS.split(' ')).toEqual(expect.arrayContaining(['max-w-full', 'break-words']));
    });
});

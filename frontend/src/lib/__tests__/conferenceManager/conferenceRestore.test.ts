/**
 * conference-manager: after a reload the plugin reopens the conference the user was working on.
 *
 * Live finding: ConferenceContext.refreshConferences picked "the first active conference" on load and
 * wrote it over the saved `conference-manager:current` BEFORE the restore effect read it, so a reload
 * reopened the newest conference. One rule now picks the conference (pickConference) — the saved one
 * while it exists — and refreshConferences uses it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pickConference, CURRENT_KEY } from '../../../../../marketplace/plugins/conference-manager/client/contexts/ConferenceContext';

const SRC = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/contexts/ConferenceContext.tsx'), 'utf8');
const LIST = [
    { id: 9, name: 'Congreso Norte 2026', status: 'active' },
    { id: 4, name: 'Encuentro Sur 2026', status: 'active' },
    { id: 2, name: 'Borrador', status: 'draft' },
] as any[];

describe('pickConference', () => {
    it('the saved conference while it exists, even when it is not the first active one', () => {
        expect(pickConference(LIST, '4')?.id).toBe(4);
        expect(pickConference(LIST, '2')?.id).toBe(2);
    });
    it('otherwise the first active one, otherwise the first', () => {
        expect(pickConference(LIST, '77')?.id).toBe(9);
        expect(pickConference(LIST, null)?.id).toBe(9);
        expect(pickConference([{ id: 3, status: 'draft' }, { id: 5, status: 'completed' }] as any[], null)?.id).toBe(3);
        expect(pickConference([], '4')).toBeNull();
    });
    it('refreshConferences reads the saved id through it instead of overwriting it with the first active one', () => {
        expect(CURRENT_KEY).toBe('conference-manager:current');
        expect(SRC).toMatch(/const pick = pickConference\(data, readSaved\(\)\);/);
        expect(SRC).not.toMatch(/data\.find\(c => c\.status === 'active'\) \|\| data\[0\]/);
    });
});

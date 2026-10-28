/**
 * THE CAMERA AND THE MICROPHONE ARE ALLOWED FOR THE SITE ITSELF, AND ONLY FOR IT.
 *
 * The Permissions-Policy header used to say `camera=()`. Chromium enforces it: on Android Chrome and on
 * desktop Chrome/Edge getUserMedia was refused before any prompt, so the conference-manager meal scanner
 * (an admin plugin screen) could never open the camera and told the operator to grant a permission that
 * no browser setting could grant. Safari ignores the header, which is why an iPhone still showed a
 * picture and the bug went unnoticed. `microphone=()` did the same to calls answered or placed from a
 * plugin's admin page or portal app: getUserMedia({ audio }) was refused, so a call had no audio.
 *
 * The test reads the header string the browser enforces, from the real `nextConfig.headers()`:
 *   - the camera and microphone allowlists are exactly `self` (never `*`: embedded third-party frames stay out);
 *   - the other denials of audit F-09 are untouched;
 *   - one value covers every route: a document keeps the policy it was loaded with, and the admin is
 *     reached by a client-side navigation from /login, so an /admin-only override would not apply.
 */
import { describe, expect, it } from 'vitest';
import nextConfig from '../../../next.config';

type HeaderGroup = { source: string; headers: Array<{ key: string; value: string }> };

async function policyGroups(): Promise<Array<{ source: string; value: string }>> {
    const groups = (await (nextConfig.headers as () => Promise<HeaderGroup[]>)()) || [];
    return groups.flatMap((g) => g.headers
        .filter((h) => h.key.toLowerCase() === 'permissions-policy')
        .map((h) => ({ source: g.source, value: h.value })));
}

function parse(value: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const part of value.split(',')) {
        const m = /^\s*([a-z-]+)=\(([^)]*)\)\s*$/.exec(part);
        expect(m, `malformed directive: ${part}`).toBeTruthy();
        out.set(m![1], m![2].split(/\s+/).filter(Boolean));
    }
    return out;
}

describe('Permissions-Policy', () => {
    it('allows the camera and the microphone to the site\'s own pages only (=(self))', async () => {
        const groups = await policyGroups();
        expect(groups).toHaveLength(1);
        expect(groups[0].source).toBe('/:path*');
        const d = parse(groups[0].value);
        expect(d.get('camera')).toEqual(['self']);
        expect(d.get('microphone')).toEqual(['self']);
    });

    it('keeps denying geolocation and the Topics API', async () => {
        const [{ value }] = await policyGroups();
        const d = parse(value);
        expect(d.get('geolocation')).toEqual([]);
        expect(d.get('browsing-topics')).toEqual([]);
        expect([...d.keys()].sort()).toEqual(['browsing-topics', 'camera', 'geolocation', 'microphone']);
    });
});

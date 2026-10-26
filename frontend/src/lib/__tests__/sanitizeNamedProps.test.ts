import { describe, it, expect } from 'vitest';
import { sanitizeHTML } from '../sanitize';

// The SSR path (sanitize-html; this file runs in the node environment): author ids are namespaced
// under `user-content-` so they cannot clobber a property the page uses (`__next_f` drives hydration),
// `name` survives only on form controls, and an embed's sandbox/allow are the site's, not the author's.
// The DOMPurify (browser) path applies the same rules with SANITIZE_NAMED_PROPS and its hooks.
describe('sanitizeHTML — named properties and embeds (server path)', () => {
    it('namespaces every author id, once', () => {
        const out = sanitizeHTML('<div id="__next_f">x</div><h2 id="intro">Intro</h2><p id="user-content-done">y</p>');
        expect(out).toContain('id="user-content-__next_f"');
        expect(out).toContain('id="user-content-intro"');
        expect(out).toContain('id="user-content-done"');
        expect(out).not.toContain('user-content-user-content-');
        expect(out).not.toMatch(/id="__next_f"/);
    });

    it('keeps name only on form controls, namespaced', () => {
        const out = sanitizeHTML('<img name="getElementById" src="https://cdn.example/a.png"><a name="cookie" href="#x">a</a><input name="q"><button name="go">b</button>');
        expect(out).not.toMatch(/name="getElementById"|name="cookie"/);
        expect(out).toContain('<input name="user-content-q"');
        expect(out).toContain('name="user-content-go"');
    });

    it('forces the site sandbox and permission list on every embed', () => {
        const out = sanitizeHTML('<iframe src="https://www.youtube.com/embed/aqz-KE-bpKQ" sandbox="allow-scripts allow-same-origin allow-top-navigation allow-popups allow-forms" allow="camera; microphone; geolocation"></iframe>');
        expect(out).toContain('sandbox="allow-scripts allow-same-origin allow-presentation"');
        expect(out).toContain('allow="autoplay; encrypted-media; fullscreen; picture-in-picture"');
        expect(out).not.toMatch(/top-navigation|allow-popups|camera|microphone|geolocation/);
    });
});

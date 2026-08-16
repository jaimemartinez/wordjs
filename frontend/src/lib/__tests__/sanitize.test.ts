import { describe, it, expect } from 'vitest';
import { sanitizeHTML, stripHTML, hasDangerousContent, resolveVideoEmbedUrl, ALLOWED_EMBED_HOSTS } from '../sanitize';

// Security-property tests for the XSS sanitizer. Assertions hold on BOTH the sanitize-html SSR path
// and the fail-closed regex fallback, so they don't depend on optional deps being resolvable.
describe('sanitize (XSS prevention)', () => {
  it('sanitizeHTML drops <script> and inline event handlers', () => {
    const clean = sanitizeHTML('<p onclick="steal()">hi</p><script>alert(1)</script>');
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).toContain('hi');
  });

  it('stripHTML removes tags and resists the nested-tag bypass', () => {
    expect(stripHTML('<b>alpha</b>')).toBe('alpha');
    expect(stripHTML('<scr<script>ipt>alert(1)</script>')).not.toMatch(/<script/i);
  });

  it('hasDangerousContent flags scripts, javascript: URIs and on* handlers', () => {
    expect(hasDangerousContent('<script>x</script>')).toBe(true);
    expect(hasDangerousContent('<a href="javascript:alert(1)">x</a>')).toBe(true);
    expect(hasDangerousContent('<img src=x onerror=alert(1)>')).toBe(true);
    expect(hasDangerousContent('<p>perfectly safe</p>')).toBe(false);
    expect(hasDangerousContent('')).toBe(false);
  });

  it('empty / falsy input is handled safely', () => {
    expect(sanitizeHTML('')).toBe('');
    expect(stripHTML('')).toBe('');
  });
});

/**
 * The provider table behind the video-embed block. The rule under test is that a provider is
 * decided by the PARSED host, compared whole — never by `url.includes("youtube.com")`, which any
 * host an attacker can register (`youtube.com.evil.test`) or any path they can serve
 * (`evil.test/youtube.com/watch`) satisfies.
 */
describe('resolveVideoEmbedUrl (embed host allowlist)', () => {
  it('accepts the real providers and canonicalizes them onto an allowlisted host', () => {
    const cases: Array<[string, string]> = [
      ['https://www.youtube.com/watch?v=abc123', 'https://www.youtube.com/embed/abc123?rel=0&modestbranding=1'],
      ['https://m.youtube.com/watch?v=abc123', 'https://www.youtube.com/embed/abc123?rel=0&modestbranding=1'],
      ['http://youtube.com/watch?v=abc123', 'https://www.youtube.com/embed/abc123?rel=0&modestbranding=1'],
      ['https://youtu.be/abc123?t=10', 'https://www.youtube.com/embed/abc123?rel=0&modestbranding=1'],
      ['https://www.youtube.com/shorts/abc123', 'https://www.youtube.com/embed/abc123?rel=0&modestbranding=1'],
      ['https://www.youtube.com/embed/abc123', 'https://www.youtube.com/embed/abc123?rel=0&modestbranding=1'],
      ['https://www.youtube.com/embed/abc123?start=30', 'https://www.youtube.com/embed/abc123?start=30'],
      ['https://www.youtube-nocookie.com/embed/abc123', 'https://www.youtube-nocookie.com/embed/abc123?rel=0&modestbranding=1'],
      ['https://vimeo.com/123456', 'https://player.vimeo.com/video/123456'],
      ['https://vimeo.com/123456/9ab8c7', 'https://player.vimeo.com/video/123456/9ab8c7'],
      ['https://player.vimeo.com/video/123456', 'https://player.vimeo.com/video/123456'],
      // Unlisted videos: the hash must survive or the player refuses to play.
      ['https://player.vimeo.com/video/123456?h=9ab8c7&autoplay=1', 'https://player.vimeo.com/video/123456?h=9ab8c7'],
      ['https://vimeo.com/channels/staffpicks/123456', 'https://player.vimeo.com/video/123456'],
    ];
    for (const [input, expected] of cases) expect(resolveVideoEmbedUrl(input)).toBe(expected);
  });

  it('every resolved URL lands on an allowlisted host over https', () => {
    for (const input of ['https://www.youtube.com/watch?v=abc123', 'https://youtu.be/abc123', 'https://vimeo.com/1']) {
      const u = new URL(resolveVideoEmbedUrl(input)!);
      expect(u.protocol).toBe('https:');
      expect(ALLOWED_EMBED_HOSTS).toContain(u.hostname);
    }
  });

  // Each of these passed the old substring classifier and produced a real <iframe>.
  it('refuses look-alike hosts and provider names that live in the PATH', () => {
    const hostile = [
      'https://evil.test/youtube.com/watch?v=abc123',   // provider name in the path
      'https://evil.test/youtu.be/abc123',
      'https://vimeo.com.evil.test/x/vimeo.com/123456', // suffix look-alike + path
      'https://youtube.com.evil.test/watch?v=abc123',   // suffix look-alike
      'https://notyoutube.com/watch?v=abc123',          // prefix look-alike
      'https://player.vimeo.com.evil.test/video/123456',
      'https://www.youtube.com.evil.test/embed/abc123',
    ];
    for (const url of hostile) expect(resolveVideoEmbedUrl(url)).toBeNull();
  });

  it('refuses non-http schemes, relative input and ids that are not ids', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '/media/clip.mp4',
      'https://www.youtube.com/embed/<script>',
      'https://www.youtube.com/watch?v=',
      'https://www.youtube.com/',
      'https://vimeo.com/notanid',
      '',
      '   ',
      null,
      undefined,
      42,
    ]) {
      expect(resolveVideoEmbedUrl(url)).toBeNull();
    }
  });
});

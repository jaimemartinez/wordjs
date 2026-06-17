import { describe, it, expect } from 'vitest';
import { sanitizeHTML, stripHTML, hasDangerousContent } from '../sanitize';

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

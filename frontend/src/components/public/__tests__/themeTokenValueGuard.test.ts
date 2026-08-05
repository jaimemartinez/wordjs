import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The theme-token value guard is intentionally duplicated: the SSR overlay is a server component and
// the admin customizer is a "use client" page, so they can't share a module without new plumbing.
// These tests (1) pin the two copies byte-identical and (2) exercise the SHIPPED expressions —
// extracted from source and evaluated, not re-typed here — against accept/reject cases.

function load(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const overlaySrc = load('../ThemeTokenOverlay.tsx');
const customizeSrc = load('../../../app/admin/themes/customize/page.tsx');

const GUARD_RE = /function isForbiddenTokenValue\(value: string\): boolean \{\n {4}return (.+);\n\}/;

function extractGuard(src: string, label: string): { text: string; test: (v: string) => boolean } {
  const m = src.match(GUARD_RE);
  if (!m) throw new Error(`isForbiddenTokenValue not found in ${label}`);
  return { text: m[0], test: new Function('value', `return (${m[1]});`) as (v: string) => boolean };
}

const overlay = extractGuard(overlaySrc, 'ThemeTokenOverlay.tsx');
const customize = extractGuard(customizeSrc, 'admin/themes/customize/page.tsx');

// The overlay's charset allowlist, likewise pulled from the shipped source.
const valueReMatch = overlaySrc.match(/const VALUE_RE = (\/.+\/);\n/);
if (!valueReMatch) throw new Error('VALUE_RE not found in ThemeTokenOverlay.tsx');
const VALUE_RE = new Function(`return ${valueReMatch[1]};`)() as RegExp;

// Every legitimate shape the customizer produces: hex colors, gradients, font stacks, lengths,
// shorthand borders, rgba(). All must pass the charset AND clear the guard.
const LEGIT = [
  '#4f46e5',
  'linear-gradient(120deg, #4f46e5 0%, #a855f7 100%)',
  "'Inter', sans-serif",
  '0.95rem',
  '1px solid #ccc',
  'rgba(255, 255, 255, 0.06)',
];

// Exfiltration beacons: `url(//host/x)` is a protocol-relative URL — it needs no `:`, so the
// `;{}:<>` denylist and the charset both let it through. The guard must reject each of these.
const FORBIDDEN = [
  'url(//x.example/p)',
  'url (//x)', // whitespace before the paren still parses as url()
  'URL(//x)', // CSS is case-insensitive
  "url('x')", // any url() at all, even without //
  'a//b', // bare protocol-relative smuggle inside a longer value
  '\\75rl(//x)', // \75 is the CSS escape for "u"
  '\\2f\\2f', // CSS escapes for "//" — backslash ban closes the encoding hole
];

describe('theme token value guard — mirror parity', () => {
  it('isForbiddenTokenValue is byte-identical in ThemeTokenOverlay and the customizer', () => {
    expect(overlay.text).toBe(customize.text);
  });
});

describe('theme token value guard — cases (both shipped copies)', () => {
  for (const [label, guard] of [
    ['overlay', overlay.test],
    ['customizer', customize.test],
  ] as const) {
    it(`${label}: legitimate CSS values pass charset + guard`, () => {
      for (const v of LEGIT) {
        expect(VALUE_RE.test(v), `charset should accept ${v}`).toBe(true);
        expect(guard(v), `guard should clear ${v}`).toBe(false);
      }
    });

    it(`${label}: url() / protocol-relative / backslash values are rejected`, () => {
      for (const v of FORBIDDEN) {
        expect(guard(v), `guard should reject ${v}`).toBe(true);
      }
    });
  }
});

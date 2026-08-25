import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEME_CONTRACT } from '@/generated/visual-contract.generated';
import {
  isForbiddenThemeTokenValue,
  isValidThemeMod,
  sanitizeThemeMods,
  THEME_TOKEN_MAX_VALUE_LENGTH,
  THEME_TOKEN_MOD_NAME,
  THEME_TOKEN_VALUE,
} from '@/lib/themeTokenPolicy';

function load(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const overlaySrc = load('../ThemeTokenOverlay.tsx');
const customizeSrc = load('../../../app/admin/themes/customize/page.tsx');

const LEGIT = [
  '#4f46e5',
  'linear-gradient(120deg, #4f46e5 0%, #a855f7 100%)',
  "'Inter', sans-serif",
  '0.95rem',
  '1px solid #ccc',
  'rgba(255, 255, 255, 0.06)',
];

const FORBIDDEN = [
  'url(//x.example/p)',
  'url (//x)',
  'URL(//x)',
  "url('x')",
  'a//b',
  '\\75rl(//x)',
  '\\2f\\2f',
];

describe('theme token policy — generated single source', () => {
  it('projects every key/value bound from the generated visual contract', () => {
    expect(THEME_TOKEN_MOD_NAME.source).toBe(THEME_CONTRACT.tokens.modNamePattern);
    expect(THEME_TOKEN_VALUE.source).toBe(THEME_CONTRACT.tokens.valuePattern);
    expect(THEME_TOKEN_MAX_VALUE_LENGTH).toBe(THEME_CONTRACT.tokens.maxValueLength);
  });

  it('both CSS emitters consume the helper and carry no local policy copy', () => {
    expect(overlaySrc).toContain('isValidThemeMod');
    expect(customizeSrc).toContain('sanitizeThemeMods');
    for (const source of [overlaySrc, customizeSrc]) {
      expect(source).not.toMatch(/const\s+(?:KEY_RE|VALUE_RE|MAX_VALUE_LEN|FORBIDDEN_FUNCTION)\b/);
      expect(source).not.toContain('function isForbiddenTokenValue');
    }
  });
});

describe('theme token policy — security cases', () => {
  it('accepts legitimate CSS values for a valid theme key', () => {
    for (const value of LEGIT) {
      expect(THEME_TOKEN_VALUE.test(value), `charset should accept ${value}`).toBe(true);
      expect(isForbiddenThemeTokenValue(value), `guard should clear ${value}`).toBe(false);
      expect(isValidThemeMod('--wjs-test-token', value), value).toBe(true);
    }
  });

  it('rejects url(), protocol-relative and CSS-escape spellings', () => {
    for (const value of FORBIDDEN) {
      expect(isForbiddenThemeTokenValue(value), value).toBe(true);
      expect(isValidThemeMod('--wjs-test-token', value), value).toBe(false);
    }
  });

  it('drops bad names, oversized values and non-string values entry by entry', () => {
    expect(sanitizeThemeMods({
      '--wjs-good': '#fff',
      '--WJS-UPPER': '#000',
      '--wjs-too-long': 'a'.repeat(THEME_TOKEN_MAX_VALUE_LENGTH + 1),
      '--wjs-object': { color: 'red' },
    })).toEqual({ '--wjs-good': '#fff' });
  });
});

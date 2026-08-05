/**
 * The default theme's stylesheet exists TWICE: as the shipped themes/default/style.css and as the
 * literal core/themes.ts writes when the file is missing or the admin restores the theme.
 *
 * They had drifted — the literal was an old, token-less version — so "restore default theme"
 * replaced the curated 75-token palette with 17 tokens and no error anywhere. Nothing in the type
 * system or the suites could see it, because both copies are just strings that parse fine.
 *
 * This pins them together: edit one and this fails, naming the fix.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const REPO_BACKEND = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(REPO_BACKEND, 'src', 'core', 'themes.ts');
const SHIPPED = path.join(REPO_BACKEND, 'themes', 'default', 'style.css');

/** Extract the `const styleCss = \`…\`;` literal and undo its escaping. */
function embeddedStylesheet(): string {
    const lines = fs.readFileSync(SOURCE, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.includes('const styleCss = `'));
    assert.notStrictEqual(start, -1, 'the embedded styleCss literal is gone from core/themes.ts');
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim() === '`;') { end = i; break; }
    }
    assert.notStrictEqual(end, -1, 'the embedded styleCss literal is not closed');
    const body = [lines[start].slice(lines[start].indexOf('`') + 1), ...lines.slice(start + 1, end)].join('\n');
    return body.replace(/\\`/g, '`').replace(/\\\$\{/g, '${').replace(/\\\\/g, '\\');
}

const normalize = (css: string): string => css.replace(/\r\n/g, '\n').trim();
const tokensOf = (css: string): Set<string> => new Set(css.match(/--wjs-[a-z0-9-]+(?=\s*:)/g) || []);

describe('default theme: shipped stylesheet vs the copy the restore path writes', () => {
    it('declares the same tokens in both copies', () => {
        const shipped = tokensOf(fs.readFileSync(SHIPPED, 'utf8'));
        const embedded = tokensOf(embeddedStylesheet());
        const missing = [...shipped].filter((t) => !embedded.has(t));
        assert.deepStrictEqual(missing, [], `restoring the default theme would drop ${missing.length} token(s): ${missing.slice(0, 8).join(', ')}`);
    });

    it('is byte-identical to the shipped stylesheet', () => {
        assert.strictEqual(
            normalize(embeddedStylesheet()),
            normalize(fs.readFileSync(SHIPPED, 'utf8')),
            'core/themes.ts styleCss drifted from themes/default/style.css — regenerate the literal from the file',
        );
    });
});

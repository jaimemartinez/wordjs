/**
 * #24 FOLLOW-UP — A CUSTOM PROPERTY IS A WAY TO REACH A DECLARATION THE ALLOWLIST FORBIDS.
 *
 * The remediation closed `props.css` by property NAME, then reopened it by pattern: any `--wjs-*`
 * was accepted. But a custom property is not a declaration, it is a value that `wordjs-ui.css` later
 * expands INTO one — including declarations `AUTHOR_CSS_PROPS` excludes on purpose. The live example
 * is the button:
 *
 *     .wjs-block-button__link:hover { transform: var(--wjs-button-hover-transform, scale(1.03)) }
 *
 * and `ButtonBlock` spreads `safeCss(css)` onto that very `<a>`, so
 * `css = { "--wjs-button-hover-transform": "scale(200)" }` — no `;{}<>\@`, no `url(`, nothing the
 * value criterion can object to — made the anchor swallow the viewport on hover, with the whole
 * surface clickable to the author's chosen href. Same damage as the audit's overlay, built out of a
 * value instead of a declaration.
 *
 * WHAT IS PINNED HERE, and through the REAL producers:
 *  1. EMISSION — `renderToStaticMarkup` of the real `ButtonBlock`, so the assertion is about the
 *     `style` ATTRIBUTE the browser receives, not about an intermediate object.
 *  2. THE STYLESHEET — the invariant that makes the closed list checkable is read off the REAL
 *     `backend/public/css/wordjs-ui.css`: every name in `AUTHOR_CSS_VARS` is consumed only inside
 *     declarations whose property is itself author-allowed. The same scan proves the attack's premise
 *     (that `--wjs-button-hover-transform` really does land in `transform:`), so this test fails if
 *     the fix is reverted AND fails if the stylesheet later makes an allowed name dangerous.
 *  3. THE SHELL CHANNEL — `appearanceToStyle` builds its own `--wjs-*` names from literals and must
 *     keep emitting them; closing the author channel must not close ours.
 *  4. THE HABITUAL `;` — a free-text CSS field ending in a semicolon is normalised, not eaten.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ButtonBlock, TextBlock } from '@/components/content/blocks';
import { appearanceToStyle, type Appearance } from '@/components/blocks/blockShell';
import { blockVars, safeCss } from '@/components/blocks/blockVars';
import {
    AUTHOR_CSS_PROPS,
    AUTHOR_CSS_VARS,
    SHELL_CSS_PROPS,
    safeCssValue,
    safeStyleObject,
} from '@/components/blocks/safeStyle';

const HOSTILE_VAR = '--wjs-button-hover-transform';

describe('#24 props.css cannot name a custom property the stylesheet expands into a forbidden declaration', () => {
    it('the hostile variable never reaches the button the stylesheet targets', () => {
        const html = renderToStaticMarkup(
            <ButtonBlock
                label="Click"
                href="https://attacker.example/"
                css={{ [HOSTILE_VAR]: 'scale(200)', '--wjs-button-bg': '#ffffff' }}
            />,
        );
        expect(html).not.toContain('scale(200)');
        expect(html).not.toContain(HOSTILE_VAR);
        // The block still renders — a rejected declaration is dropped, not blanked.
        expect(html).toContain('href="https://attacker.example/"');
    });

    it('safeCss admits the closed list and nothing else', () => {
        expect(safeCss({ [HOSTILE_VAR]: 'scale(200)' })).toEqual({});
        expect(safeCss({ '--wjs-anything-at-all': '1' })).toEqual({});
        expect(safeCss({ '--evil': 'x' })).toEqual({});
        expect(safeCss({ '--wjs-text-color': '#111', color: '#222' })).toEqual({
            '--wjs-text-color': '#111',
            color: '#222',
        });
    });

    it('the block a listed name belongs to still honours it end to end', () => {
        const html = renderToStaticMarkup(<TextBlock content="hi" css={{ '--wjs-text-color': '#111' }} />);
        expect(html).toContain('--wjs-text-color:#111');
    });
});

describe('#24 the SHELL keeps naming its own variables — the two channels are separate', () => {
    it('appearanceToStyle still emits the variables it builds from literals', () => {
        const style = appearanceToStyle({ hover: 'lift', hoverAmount: 9, hoverSpeed: 200, hoverColor: '#f00' } as Appearance).style;
        expect(style).toEqual({ '--wjs-hover-amt': '9', '--wjs-hover-speed': '200ms', '--wjs-hover-color': '#f00' });
    });

    it('the shell policy opens the NAME, never the value: a narrowed variable is clamped in both channels', () => {
        const payload = { [HOSTILE_VAR]: 'scale(200)' };
        // The shell may NAME any `--wjs-*` because the name comes from our own literals. The VALUE is
        // still author text, so it goes through the same narrowed grammar: scale is clamped to
        // [SCALE_MIN, SCALE_MAX]. Letting it through here would reopen the exact attack this file
        // documents, because ButtonBlock feeds this variable through the shell channel.
        expect(safeStyleObject(payload, SHELL_CSS_PROPS)).toEqual({ [HOSTILE_VAR]: 'scale(1.5)' });
        expect(safeStyleObject(payload, AUTHOR_CSS_PROPS)).toEqual({});     // author names: not even named
        // A COPY of the shell set is not the shell set: unknown callers get the strict policy.
        expect(safeStyleObject(payload, new Set(SHELL_CSS_PROPS))).toEqual({});
    });

    it('blockVars names from the call site and clamps the author value', () => {
        // The name is ours (`button` + `hover-transform`); the value came from a text field, so the
        // magnitude is bounded rather than trusted.
        expect(blockVars('button', { 'hover-transform': 'scale(200)' })).toEqual({
            '--wjs-button-hover-transform': 'scale(1.5)',
        });
        // A value the grammar cannot parse at all is dropped, so the stylesheet's own default applies.
        expect(blockVars('button', { 'hover-transform': 'matrix(2,0,0,2,0,0)' })).toEqual({});
        expect(blockVars('text', { color: 'red;position:fixed;inset:0' })).toEqual({});
    });
});

/**
 * THE INVARIANT BEHIND THE LIST, read off the shipped stylesheet rather than asserted from memory.
 * `wordjs-ui.css` is the file the public site loads, and it is what decides which declaration a
 * variable ends up in.
 */
describe('#24 every author-nameable variable is only ever expanded into an author-allowed declaration', () => {
    const CSS_PATH = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../../backend/public/css/wordjs-ui.css',
    );
    const css = readFileSync(CSS_PATH, 'utf8');

    /** property name → the `--wjs-*` variables its declarations read, over the whole stylesheet. */
    const consumers = (): Map<string, Set<string>> => {
        const byVar = new Map<string, Set<string>>();
        const decl = /([-a-zA-Z]+)\s*:\s*([^;{}]*var\([^;{}]*)/g;
        for (let m = decl.exec(css); m !== null; m = decl.exec(css)) {
            const [, property, value] = m;
            const uses = /var\(\s*(--wjs-[A-Za-z0-9_-]+)/g;
            for (let v = uses.exec(value); v !== null; v = uses.exec(value)) {
                if (!byVar.has(v[1])) byVar.set(v[1], new Set());
                byVar.get(v[1])!.add(property);
            }
        }
        return byVar;
    };

    /** `AUTHOR_CSS_PROPS` is camelCase (React style objects); a stylesheet is kebab-case. */
    const authorProperties = new Set(
        [...AUTHOR_CSS_PROPS].map((p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
    );

    it('the stylesheet is still what makes the attack possible — premise check', () => {
        // If this ever fails, the button no longer expands that variable and the case above needs a
        // new example — not a weaker list.
        expect([...(consumers().get(HOSTILE_VAR) ?? [])]).toContain('transform');
        expect(authorProperties.has('transform')).toBe(false);
        expect(AUTHOR_CSS_VARS.has(HOSTILE_VAR)).toBe(false);
    });

    it.each([...AUTHOR_CSS_VARS])('%s lands only in declarations the author could write directly', (name) => {
        const used = consumers().get(name);
        expect(used, `${name} is not used by wordjs-ui.css at all — remove it from AUTHOR_CSS_VARS`).toBeDefined();
        expect([...used!].filter((p) => !authorProperties.has(p))).toEqual([]);
    });
});

describe('#24-C a trailing semicolon is normalised, not silently eaten', () => {
    it('the habitual `;` no longer erases a hand-typed declaration', () => {
        expect(safeCssValue('boxShadow', '0 2px 8px rgb(0 0 0 / .2);')).toBe('0 2px 8px rgb(0 0 0 / .2)');
        expect(safeCssValue('width', '50% ; ')).toBe('50%');
        expect(blockVars('card', { shadow: '0 1px 2px #0003;' })).toEqual({ '--wjs-card-shadow': '0 1px 2px #0003' });
        expect(safeCss({ boxShadow: '0 2px 8px rgb(0 0 0 / .2);' })).toEqual({
            boxShadow: '0 2px 8px rgb(0 0 0 / .2)',
        });
    });

    it('an INTERIOR semicolon is still a second declaration and still refused', () => {
        expect(safeCssValue('color', 'red;position:fixed;')).toBeNull();
        expect(safeCssValue('color', 'red;position:fixed')).toBeNull();
        expect(safeCss({ color: 'red;position:fixed;inset:0;' })).toEqual({});
        expect(safeCssValue('color', ';')).toBeNull();
    });
});

/**
 * Declarative @keyframes (theme.json `animations`) + the preference breakpoints.
 *
 * The contract: an animation NAME is one ident (never a selector), emitted under the wjs-a- prefix so
 * a theme cannot clobber a framework @keyframes; every frame declaration goes through the SAME
 * validateDeclaration path as styles; a styles value referencing an undeclared wjs-a-* ident is an
 * ERROR; a declared-but-unused animation is a WARNING; an animation running outside `motionOk` with no
 * `reducedMotion` override on the same selector is a WARNING — reduced motion honoured by
 * construction, not by memory.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { compileTheme } = require('../core/theme-compile');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-anim-'));
const compile = (tj: any) => {
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: 'P', version: '1.0.0', ...tj }));
    return compileTheme(dir, { dryRun: true });
};
const codes = (r: any, level: string) => r.diagnostics.filter((d: any) => d.level === level).map((d: any) => d.code);

test('keyframes compile, prefixed, with preference media queries emitted', () => {
    const r = compile({
        animations: { shimmer: { from: { opacity: '0.55' }, to: { opacity: '1' } } },
        styles: {
            card: { motionOk: { animation: 'wjs-a-shimmer 2.4s ease-in-out infinite alternate' } },
            heading: { dark: { color: '#e2e8f0' } },
        },
    });
    assert.strictEqual(codes(r, 'error').length, 0, JSON.stringify(r.diagnostics));
    assert.ok(r.css.includes('@keyframes wjs-a-shimmer {'), r.css);
    assert.ok(r.css.includes('@media (prefers-reduced-motion: no-preference)'));
    assert.ok(r.css.includes('@media (prefers-color-scheme: dark)'));
    assert.strictEqual(codes(r, 'warning').length, 0, JSON.stringify(r.diagnostics));
});

test('an undeclared reference is an ERROR with a suggestion; dead animations WARN', () => {
    const r = compile({
        animations: { pulse: { from: { opacity: '1' }, to: { opacity: '0.4' } } },
        styles: { card: { animation: 'wjs-a-pulze 2s infinite' } },
    });
    assert.ok(codes(r, 'error').includes('ANIMATION_UNKNOWN'), JSON.stringify(r.diagnostics));
    assert.ok(codes(r, 'warning').includes('ANIMATION_UNUSED'));
});

test('hostile names, junk frames and junk values are refused and NOTHING is emitted', () => {
    const r = compile({
        animations: {
            'Bad.Name}body{background:red': { from: { opacity: '0' } },
            esc: { '150%': { opacity: '0' } },
            raro: { from: { opacity: 'expression(alert(1))' } },
        },
    });
    const errs = codes(r, 'error');
    assert.ok(errs.includes('ANIMATION_NAME_INVALID'), JSON.stringify(errs));
    assert.ok(errs.includes('ANIMATION_FRAME_INVALID'));
    assert.ok(!r.css.includes('@keyframes'), 'a refused animation must not half-emit');
});

test('budgets: more than 16 animations or 12 frames is refused', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 17; i++) many[`a${i}`] = { from: { opacity: '0' } };
    assert.ok(codes(compile({ animations: many }), 'error').includes('ANIMATIONS_BUDGET'));
    const frames: Record<string, unknown> = {};
    for (let i = 0; i < 13; i++) frames[`${i}%`] = { opacity: '0' };
    assert.ok(codes(compile({ animations: { x: frames } }), 'error').includes('ANIMATION_BUDGET'));
});

test('the reduced-motion nudge: fires unguarded, cancelled by an override on the same selector', () => {
    const anim = { girar: { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } } };
    const bare = compile({ animations: anim, styles: { card: { animation: 'wjs-a-girar 3s linear infinite' } } });
    assert.ok(codes(bare, 'warning').includes('ANIMATION_UNGUARDED'), JSON.stringify(bare.diagnostics));
    const guarded = compile({
        animations: anim,
        styles: { card: { animation: 'wjs-a-girar 3s linear infinite', reducedMotion: { animation: 'none' } } },
    });
    assert.ok(!codes(guarded, 'warning').includes('ANIMATION_UNGUARDED'), JSON.stringify(guarded.diagnostics));
});

/** F5: one declarative visual contract, separate generated consumers, backend security authority. */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const source = require('../../../contracts/visual-contract.v1.json');
const generated = require('../generated/visual-contract.generated');
const template = require('../core/template-validate');
const chrome = require('../core/chrome-validate');
const themeMods = require('../core/theme-mods');
const { sanitize } = require('../core/sanitize-meta');

describe('F5 generated visual contract', () => {
    test('the backend projection is byte-equivalent data to the canonical definition', () => {
        assert.strictEqual(generated.VISUAL_CONTRACT_VERSION, source.version);
        assert.deepStrictEqual(generated.TEMPLATE_CONTRACT, source.formats.template);
        assert.deepStrictEqual(generated.CHROME_CONTRACT, source.formats.chrome);
        assert.deepStrictEqual(generated.THEME_CONTRACT, source.formats.theme);
        assert.deepStrictEqual(generated.PROPERTY_SANITIZERS, source.security.propertySanitizers);
        assert.deepStrictEqual(generated.HTML_SANITIZATION, source.security.html);
        assert.deepStrictEqual(generated.URL_SANITIZATION, source.security.url);
        assert.deepStrictEqual(generated.STYLE_SECURITY, source.security.style);
        assert.strictEqual(Object.isFrozen(generated.TEMPLATE_CONTRACT), true);
        assert.strictEqual(Object.isFrozen(generated.TEMPLATE_CONTRACT.blocks.Section.props), true);
        assert.strictEqual(Object.isFrozen(generated.HTML_SANITIZATION.iframeHosts), true);
    });

    test('authoritative validators expose exactly the generated types, limits and version', () => {
        assert.strictEqual(template.VISUAL_CONTRACT_VERSION, source.version);
        assert.strictEqual(chrome.VISUAL_CONTRACT_VERSION, source.version);
        assert.deepStrictEqual(template.TEMPLATE_BLOCKS, Object.keys(source.formats.template.blocks));
        assert.deepStrictEqual(chrome.CHROME_BLOCK_TYPES, Object.keys(source.formats.chrome.blocks));
        assert.deepStrictEqual(template.TEMPLATE_LIMITS, {
            MAX_BYTES: source.formats.template.limits.maxBytes,
            MAX_BLOCKS: source.formats.template.limits.maxBlocks,
            MAX_DEPTH: source.formats.template.limits.maxDepth,
        });
        assert.strictEqual(chrome.CHROME_MAX_BYTES, source.formats.chrome.limits.maxBytes);
        assert.strictEqual(chrome.CHROME_MAX_BLOCKS, source.formats.chrome.limits.maxBlocks);
        assert.strictEqual(chrome.CHROME_MAX_DEPTH, source.formats.chrome.limits.maxDepth);
    });

    test('the backend remains fail-closed for unknown template and chrome blocks', () => {
        const slot = { type: source.formats.template.contentSlot, props: {} };
        assert.strictEqual(template.validateTemplate({ content: [slot] }).ok, true);
        assert.strictEqual(template.validateTemplate({ content: [slot, { type: 'FutureBlock', props: {} }] }).ok, false);

        const validChrome = { root: { props: {} }, content: [{ type: 'ChromeText', props: { text: 'safe' } }] };
        assert.strictEqual(chrome.validateChromeData(validChrome).ok, true);
        assert.strictEqual(chrome.validateChromeData({ ...validChrome, content: [{ type: 'FutureChrome', props: {} }] }).ok, false);
    });

    test('theme-token and HTML security policy is enforced by backend code', () => {
        assert.strictEqual(themeMods.validateThemeMods({ '--wjs-color': '#fff' }).ok, true);
        for (const value of ['url(//attacker.invalid/p)', 'a//b', '\\75rl(//x)']) {
            assert.strictEqual(themeMods.validateThemeMods({ '--wjs-color': value }).ok, false, value);
        }

        const allowedHost = source.security.html.iframeHosts[0];
        const clean = sanitize(
            `<script>alert(1)</script><iframe src="https://${allowedHost}/embed/abc"></iframe>`
            + '<iframe src="https://attacker.invalid/embed/abc"></iframe><p style="position:fixed;color:#fff">x</p>',
        );
        assert.doesNotMatch(clean, /<script|attacker\.invalid|position\s*:/i);
        assert.match(clean, new RegExp(`https://${allowedHost.replace(/\./g, '\\.')}/embed/abc`));
        assert.match(clean, /sandbox=/);
        assert.match(clean, /color\s*:\s*#fff/);
    });
});

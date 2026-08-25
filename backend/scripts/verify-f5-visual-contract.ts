/** CI gate for F5: one source, generated projections, exhaustive render/registry seams and authority. */

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`F5 verification failed: ${message}`);
};

/**
 * Does this file CONSUME the generated contract — by any spelling?
 *
 * This used to be three separate greps for the literal `require('../generated/visual-contract.generated')`,
 * and it reported F5 as failing when `core/sanitize-meta.ts` was converted to an ESM `import` while still
 * importing exactly the same module. The gate was asserting a SPELLING, not the property it exists to
 * protect, so an ordinary refactor read as a broken contract — and, worse, the failure threw before the
 * ten assertions below it ever ran, hiding whatever they would have said.
 *
 * The property is "this authority reads the generated artefact instead of restating it", and both
 * `require(...)` and `import ... from '...'` satisfy it. A file that stops importing it fails, which is
 * the regression this is here to catch.
 */
const consumesGenerated = (source: string, specifier: string) =>
    new RegExp(String.raw`(?:require\(\s*['"]${specifier}['"]\s*\)|from\s+['"]${specifier}['"])`).test(source);

const source = require(path.join(ROOT, 'contracts/visual-contract.v1.json'));
const generated = require('../src/generated/visual-contract.generated');
const generator = read('scripts/generate-visual-contract.mjs');
const backendTemplate = read('backend/src/core/template-validate.ts');
const backendChrome = read('backend/src/core/chrome-validate.ts');
const backendSanitizer = read('backend/src/core/sanitize-meta.ts');
const frontendTemplate = read('frontend/src/lib/templateData.ts');
const frontendChrome = read('frontend/src/lib/chromeData.ts');
const frontendSanitizer = read('frontend/src/lib/sanitize.ts');
const contentRenderer = read('frontend/src/components/content/ContentRenderer.tsx');
const chromeRenderer = read('frontend/src/components/chrome/ChromeRenderer.tsx');
const templateRenderer = read('frontend/src/components/content/TemplateRenderer.tsx');
const verso = read('frontend/src/lib/verso/coreBlocks.tsx');
const tests = read('backend/src/tests/f5-visual-contract.test.ts');
const adr = read('documentation/adr/0006-f5-unified-visual-contract.md');

assert.strictEqual(source.contract, 'wordjs.visual');
assert.strictEqual(generated.VISUAL_CONTRACT_VERSION, source.version);
assert.deepStrictEqual(generated.TEMPLATE_CONTRACT, source.formats.template);
assert.deepStrictEqual(generated.CHROME_CONTRACT, source.formats.chrome);
assert.deepStrictEqual(generated.THEME_CONTRACT, source.formats.theme);
assert.deepStrictEqual(generated.PROPERTY_SANITIZERS, source.security.propertySanitizers);
assert.deepStrictEqual(generated.HTML_SANITIZATION, source.security.html);
assert.deepStrictEqual(generated.URL_SANITIZATION, source.security.url);
assert.deepStrictEqual(generated.STYLE_SECURITY, source.security.style);

check(generator.includes('Run with --check in CI to reject drift'), 'generator has no stale-artifact mode');
check(consumesGenerated(backendTemplate, '../generated/visual-contract.generated'), 'template authority does not consume generated data');
check(consumesGenerated(backendChrome, '../generated/visual-contract.generated'), 'chrome authority does not consume generated data');
check(consumesGenerated(backendSanitizer, '../generated/visual-contract.generated'), 'backend sanitizer does not consume generated security policy');
check(consumesGenerated(frontendTemplate, '@/generated/visual-contract.generated'), 'frontend template parser does not consume its generated projection');
check(consumesGenerated(frontendChrome, '@/generated/visual-contract.generated'), 'frontend chrome parser does not consume its generated projection');
check(consumesGenerated(frontendSanitizer, '@/generated/visual-contract.generated'), 'frontend sanitizer does not consume its generated projection');
check(!/from\s+['"][^'"]*backend\//.test(frontendTemplate + frontendChrome + frontendSanitizer), 'frontend imports backend implementation code');

check(contentRenderer.includes('satisfies Record<CoreBlockType, CoreRenderer>'), 'core renderer is not exhaustive over generated types');
check(chromeRenderer.includes('satisfies Record<ChromeBlockType, ChromeBlockRenderer>'), 'chrome renderer is not exhaustive over generated types');
check(templateRenderer.includes('satisfies Record<TemplateBlockType, TemplateBlockRenderer>'), 'template renderer is not exhaustive over generated types');
check(verso.includes('GENERATED_CORE_BLOCK_REGISTRY'), 'Verso does not consume the generated registry');
check(verso.includes('slots drifted from generated visual contract'), 'Verso slot drift is not rejected');
check(verso.includes('category drifted from generated visual contract'), 'Verso category drift is not rejected');
check(tests.includes('backend remains fail-closed'), 'authoritative validator conformance test is absent');
check(tests.includes('theme-token and HTML security policy'), 'generated security-policy conformance test is absent');

for (let invariant = 1; invariant <= 10; invariant++) {
    check(adr.includes(`F5-INV-${String(invariant).padStart(2, '0')}`), `ADR missing F5 invariant ${invariant}`);
}

console.log('F5 visual contract verified: canonical source, current projections, backend authority, exhaustive renderers and generated Verso registry.');

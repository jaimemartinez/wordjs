/**
 * THE `class` ATTRIBUTE, EVERY CHANNEL THAT EMITS ONE, BOTH BOUNDARIES.
 *
 * The style channel was closed by bounding `props.css`/`props.look`; the block channel was closed by
 * bounding `className` at the sink. Neither touched the attribute NEXT DOOR in the sibling sink —
 * `class` inside RICH HTML, the thing every `dangerouslySetInnerHTML` in the tree paints:
 *
 *     <div class="fixed inset-0 z-50 w-full h-full bg-white"><a href="https://evil/login">…</a></div>
 *
 * Every one of those six utilities ships in the Tailwind bundle that `app/layout.tsx` imports on EVERY
 * route (and the admin loads it too), so that markup is a viewport-covering, opaque, attacker-linked
 * overlay served from the victim's own origin. Two writers reached it and both were live:
 *
 *   · a post body / Puck HTML field / widget / expanded shortcode — any account that can publish;
 *   · an ANONYMOUS COMMENT. `POST /comments` is optionalAuth, `Comment.create` sanitizes through
 *     `core/formatting.ts`, and `admin/comments/page.tsx` paints the moderation queue with
 *     dangerouslySetInnerHTML. The writer needs no account; the reader is the administrator, i.e.
 *     exactly the session whose capabilities are worth phishing.
 *
 * WHAT THIS FILE PINS, and why in this shape:
 *
 *  1. THE POPULATION IS DERIVED, NOT LISTED. Every source file in both packages is scanned for a
 *     sanitizer configuration that ADMITS a `class` attribute, and each one found must route through
 *     the shared bound or carry a written review. A new sanitizer that admits `class` and forgets the
 *     bound turns this red without anyone editing a list — which is the only property that makes the
 *     answer to "did we get them all?" survive the next person.
 *  2. ONE CRITERION, NOT FOUR AGREEING ONES. `isSafeClassToken` in
 *     components/blocks/safeStyle.ts and its mirror in backend/src/core/sanitize-meta.ts are driven
 *     over ONE corpus, constants included, so the two packages cannot drift.
 *  2b. AND THE REFUSED VOCABULARY IS DERIVED TOO, from what CONSUMES a class: every stylesheet that
 *     ships here is parsed for the classes it takes out of normal flow, and the frontend's own
 *     `className` literals are read for the Tailwind spellings the on-demand bundle therefore
 *     contains. Naming five keywords was naming ONE stylesheet's spelling of them — it admitted
 *     `.position-fixed` (the framework sheet's own longhand) and `focus:absolute` (the skip link's).
 *  3. THE REAL FUNCTIONS. Every assertion below runs the actual sanitizer a write path or a render
 *     path calls, over a payload corpus DERIVED from the refused vocabulary itself.
 *  4. NO REGRESSION. The classes real content carries — a WordPress import, a theme hook, a widget —
 *     come through byte-identical.
 *
 * WHAT IS **NOT** COVERED, said out loud:
 *   · The DOMPurify (browser) path of lib/sanitize.ts cannot execute here: this suite runs in the node
 *     environment and the frontend has no DOM implementation installed. It is covered structurally
 *     instead — the file has TWO sanitizer paths and the scan below requires the bound in BOTH, which
 *     is precisely the failure shape being guarded against (one path bounded, its twin not).
 *   · `backend/src/core/formatting.ts` — the write boundary for post_content and for COMMENTS — is
 *     covered here only by the source scan, and BEHAVIOURALLY by its twin,
 *     `backend/src/tests/class-attribute-channel.test.ts`. It cannot be executed from this suite:
 *     vitest hands the module to Node's own `require`, which cannot resolve its `./sanitize-meta`
 *     sibling without a `.ts` extension (ts-node, i.e. the backend suite, can). Both halves derive
 *     their payload corpus from CSS_POSITION_KEYWORDS, so the refused vocabulary has one source.
 *   · Hand-built HTML strings that interpolate a value into a `class="…"` attribute (core/shortcodes.ts,
 *     lib/verso/contentFallback.ts) are a DIFFERENT emitter population and are not judged here. Their
 *     output is painted through `sanitizeHTML`, i.e. through the read boundary this file does pin, so
 *     the overlay is refused — but the interpolations themselves are unreviewed and are reported as an
 *     open class rather than quietly claimed.
 *   · Nothing here enumerates the Tailwind bundle. A future utility that escapes normal flow WITHOUT
 *     the `position` property would not be caught by the criterion, and no test in this repo can
 *     derive that set (Tailwind v4 emits on demand at build time; the compiled bundle is not in git).
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    CSS_POSITION_KEYWORDS,
    MAX_CLASS_ATTR_TOKEN,
    MAX_EXTRA_CLASS_TOKENS,
    POSITION_BINDING_CLASSES,
    isSafeClassToken,
    safeClassAttribute,
    safeExtraClassList,
} from '@/components/blocks/safeStyle';
import { sanitizeHTML } from '@/lib/sanitize';
import { HTML_SANITIZATION } from '@/generated/visual-contract.generated';
// The backend modules are CommonJS with no `export` statement, so tsc classifies them as scripts
// rather than modules. Resolution and execution are fine — the suppression is the price of driving
// the REAL write-boundary functions instead of a copy of them, the same arrangement
// blockStyleInjection.test.tsx uses for the style channel.
// @ts-expect-error -- CommonJS module, no ESM export statement
import backendMeta from '../../../../../backend/src/core/sanitize-meta';

const be = backendMeta as unknown as {
    sanitize: (html: string) => string;
    sanitizeMetaValue: (key: string, value: unknown) => any;
    isSafeClassToken: (token: unknown) => boolean;
    safeClassAttribute: (value: unknown) => string;
    safeExtraClassList: (value: unknown) => string | undefined;
    withClassBound: (config: any) => any;
    CSS_POSITION_KEYWORDS: ReadonlySet<string>;
    POSITION_BINDING_CLASSES: ReadonlySet<string>;
    MAX_CLASS_ATTR_TOKEN: number;
    MAX_EXTRA_CLASS_TOKENS: number;
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 1. THE EMITTER POPULATION, DERIVED
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** The two packages that render THIS site, plus the marketplace plugins that render into its admin. */
const SCAN_ROOTS = ['backend/src', 'frontend/src', 'marketplace/plugins'];

/**
 * The keys under which an HTML sanitizer declares which attributes survive. Every sanitizer in the
 * tree is sanitize-html or DOMPurify, and these are the four spellings the two libraries offer.
 */
const ATTR_ALLOWLIST_KEYS = /\b(allowedAttributes|ALLOWED_ATTR|allowedClasses|ADD_ATTR)\b/g;

/**
 * The markers that mean "this configuration is bound". All three resolve to the SAME predicate — the
 * point of the shared definition is that there is nothing else to accept.
 */
const BOUND_MARKERS = ['withClassBound(', 'classAttributeTransform(', 'safeClassAttribute('];

/**
 * Comments are prose, not configuration. Round 4 caught an exemption in another gate that a COMMENT
 * satisfied for ever, so the scan reads code only: block comments are removed and any line that is
 * a `//` line or the continuation of a doc block is dropped before anything is matched.
 */
function codeOnly(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n')
        .filter((l) => {
            const t = l.trim();
            return !t.startsWith('//') && !t.startsWith('*');
        })
        .join('\n');
}

/**
 * The balanced `{…}` / `[…]` region that follows an allowlist key — quote-aware, so a bracket inside
 * a string does not end it. Reading the REGION rather than the line is what makes a config wrapped at
 * 120 columns, or spread over twenty lines, count exactly like a one-liner.
 */
function balancedRegion(src: string, from: number): string {
    const rel = src.slice(from).search(/[[{]/);
    if (rel < 0) return '';
    let depth = 0;
    let quote: string | null = null;
    for (let i = from + rel; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0) return src.slice(from, i + 1);
        }
    }
    return src.slice(from);
}

/**
 * Every non-test source file under a root, discovered — a file added tomorrow is scanned. There is no
 * try/catch here on purpose: a root that cannot be read must THROW, because a scan that silently
 * returns nothing is the failure mode that makes a derived gate green while covering nothing.
 */
function sourceFiles(root: string, out: string[] = []): string[] {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const abs = path.join(root, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'tests' || entry.name === 'generated') continue;
            if (entry.name.startsWith('.')) continue;
            sourceFiles(abs, out);
        } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
            out.push(abs);
        }
    }
    return out;
}

/** Does this source declare a sanitizer configuration in which the `class` attribute survives? */
function admitsClassAttribute(code: string): boolean {
    // F5 moved the attribute names into the generated contract. A sanitizer that spreads this field
    // still admits `class`; the generated module itself is data, not an emitter, and is skipped above.
    if ((HTML_SANITIZATION.allowedAttributes as readonly string[]).includes('class')
        && code.includes('HTML_SANITIZATION.allowedAttributes')) return true;
    ATTR_ALLOWLIST_KEYS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR_ALLOWLIST_KEYS.exec(code))) {
        if (/(['"])class\1/.test(balancedRegion(code, m.index))) return true;
    }
    return false;
}

interface Emitter { file: string; code: string }

function deriveEmitters(): Emitter[] {
    const found: Emitter[] = [];
    for (const root of SCAN_ROOTS) {
        const abs = path.join(REPO, root);
        expect(statSync(abs).isDirectory(), `scan root missing: ${root}`).toBe(true);
        for (const file of sourceFiles(abs)) {
            let raw: string;
            try { raw = readFileSync(file, 'utf8'); } catch { continue; }
            const code = codeOnly(raw);
            if (admitsClassAttribute(code)) {
                found.push({ file: path.relative(REPO, file).replace(/\\/g, '/'), code });
            }
        }
    }
    return found;
}

/**
 * An emitter that is deliberately NOT bound, with the reason. One row today.
 *
 * A row is self-invalidating in the direction that matters: if the file stops admitting `class` the
 * row is asserted stale and this suite fails, so a reviewed exception cannot outlive the thing it
 * excuses. It is keyed by FILE because the review below is about the whole configuration in it; a
 * second, different sanitizer added to the same file would need this reason to be re-read, and the
 * marker pins the exact configuration the reason was written about.
 */
const REVIEWED_EMITTERS: Array<{ file: string; marker: string; reason: string }> = [
    {
        file: 'backend/src/routes/media.ts',
        // RE-PINNED after the request/response boundary was typed (f95f139f). `req.file` is
        // `Express.Multer.File | undefined` once the handler is typed, so the route now narrows it once
        // into a local `uploaded` and reads that. The marker moved with it.
        //
        // The review below was re-done rather than re-pinned: the sanitizer config at that site still
        // admits `class` and still keeps `style` OUT of allowedTags, and the file is still written back
        // and served as its own image/svg+xml document. Both halves of the reason hold unchanged.
        marker: "uploaded.mimetype === 'image/svg+xml'",
        reason:
            'An UPLOADED SVG, sanitized and written back to disk as its own file. It is served as a ' +
            'separate document (image/svg+xml), so a class inside it can only match rules inside that ' +
            'same document — no site stylesheet, and no Tailwind bundle, is ever loaded there. The ' +
            'config also keeps <style> out of allowedTags, so the document carries no rules of its ' +
            'own either. The overlay this channel exists to refuse needs a stylesheet that defines ' +
            'the utility; here there is none.',
    },
];

describe('THE CLASS CHANNEL — every sanitizer that emits a class attribute is bound', () => {
    const emitters = deriveEmitters();

    it('the scan finds a real population and reads code, not prose', () => {
        // A control on the scanner itself, both directions. Without it, a scanner that silently
        // returned nothing would leave every assertion below vacuously green.
        expect(admitsClassAttribute(`allowedAttributes: { '*': ['class', 'id'] }`)).toBe(true);
        expect(admitsClassAttribute(`ALLOWED_ATTR: [\n  'id',\n  'class',\n]`)).toBe(true); // wrapped
        expect(admitsClassAttribute(`allowedAttributes: { a: ['href'] }`)).toBe(false);
        expect(admitsClassAttribute(codeOnly(`// allowedAttributes: { '*': ['class'] }`))).toBe(false);
        expect(admitsClassAttribute(codeOnly(`/* allowedAttributes: { '*': ['class'] } */`))).toBe(false);
        // And the population is not empty: the three sanitizers this fix bounded are all in it.
        const files = emitters.map((e) => e.file);
        expect(files).toContain('frontend/src/lib/sanitize.ts');
        expect(files).toContain('backend/src/core/sanitize-meta.ts');
        expect(files).toContain('backend/src/core/formatting.ts');
    });

    it('every emitter is either bound by the shared criterion or reviewed with a reason', () => {
        const reviewed = new Map(REVIEWED_EMITTERS.map((r) => [r.file, r]));
        const unaccounted: string[] = [];
        for (const emitter of emitters) {
            if (BOUND_MARKERS.some((marker) => emitter.code.includes(marker))) continue;
            const row = reviewed.get(emitter.file);
            if (row && emitter.code.includes(row.marker)) continue;
            unaccounted.push(emitter.file);
        }
        expect(
            unaccounted,
            'A sanitizer configuration admits the `class` attribute without bounding it. Either apply ' +
            'the shared criterion (withClassBound in backend/src/core/sanitize-meta.ts, or ' +
            'safeClassAttribute from components/blocks/safeStyle.ts on the frontend), or add a row to ' +
            'REVIEWED_EMITTERS saying why this particular sink cannot host the overlay.',
        ).toEqual([]);
    });

    it('no reviewed row outlives the emitter it excuses', () => {
        const byFile = new Map(emitters.map((e) => [e.file, e]));
        for (const row of REVIEWED_EMITTERS) {
            const emitter = byFile.get(row.file);
            expect(emitter, `${row.file} no longer admits a class attribute — delete its row`).toBeTruthy();
            expect(
                emitter!.code.includes(row.marker),
                `${row.file} no longer contains the configuration the review was written about ` +
                `(${row.marker}) — re-read the reason before keeping the row`,
            ).toBe(true);
        }
    });

    /**
     * lib/sanitize.ts carries TWO sanitizers for the same content — sanitize-html during SSR and
     * DOMPurify in the browser — and the defect being closed is exactly "one of a pair is bounded and
     * its twin is not" (`style` was filtered on both paths; `class` on neither). The browser path
     * cannot be executed in this environment, so it is pinned structurally: each of the two path
     * definitions must name the bound.
     */
    it('BOTH paths of lib/sanitize.ts are bounded, not just the one this suite can execute', () => {
        const code = codeOnly(readFileSync(path.join(REPO, 'frontend/src/lib/sanitize.ts'), 'utf8'));
        const serverConfig = balancedRegion(code, code.indexOf('const SERVER_SANITIZE_OPTIONS'));
        const clientHooks = balancedRegion(code, code.indexOf('function ensureDomPurifyHooks'));
        expect(serverConfig, 'SERVER_SANITIZE_OPTIONS not found — the scan is reading the wrong file').not.toBe('');
        expect(clientHooks, 'ensureDomPurifyHooks not found — the scan is reading the wrong file').not.toBe('');
        expect(serverConfig).toContain('safeClassAttribute(');
        expect(clientHooks).toContain('safeClassAttribute(');
    });
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 2. ONE CRITERION, TWO PACKAGES
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The corpus is DERIVED from the refused vocabulary: every keyword produces its own overlay payload,
 * so adding a sixth keyword to the criterion automatically adds a case here instead of waiting for
 * someone to think of it.
 */
const OVERLAY_UTILITIES = 'inset-0 z-50 w-full h-full bg-white';
const OVERLAY_CLASS_LISTS = [...CSS_POSITION_KEYWORDS].map((kw) => `${kw} ${OVERLAY_UTILITIES}`);

/** What real content carries. These must survive every boundary byte-identically. */
const LEGITIMATE_CLASS_LISTS = [
    'wp-block-image',                                  // a WordPress import
    'wp-block-image alignwide size-large wp-image-42', // …with everything the importer brings
    'gallery gallery-columns-3',                       // an expanded [gallery] shortcode
    'wp-caption alignleft',                            // an expanded [caption] shortcode
    'widget widget-title',                             // a widget wrapper
    'has-large-font-size',                             // a WordPress typography class
    'wjs-block-heading wp-block-heading',              // bc(): our own identity plus its alias
    'hero-scanline glow-panel celda-ancha',            // the theme hooks that ship today
    'md:flex w-1/2',                                   // a utility spelling that is NOT a bare word
];

describe('the frontend criterion and the backend mirror are ONE rule', () => {
    it('the constants are identical (so the two copies cannot drift by a keyword)', () => {
        expect([...be.CSS_POSITION_KEYWORDS].sort()).toEqual([...CSS_POSITION_KEYWORDS].sort());
        expect([...be.POSITION_BINDING_CLASSES].sort()).toEqual([...POSITION_BINDING_CLASSES].sort());
        expect(be.MAX_CLASS_ATTR_TOKEN).toBe(MAX_CLASS_ATTR_TOKEN);
        expect(be.MAX_EXTRA_CLASS_TOKENS).toBe(MAX_EXTRA_CLASS_TOKENS);
    });

    it('both copies answer identically over one corpus', () => {
        const corpus: unknown[] = [
            ...OVERLAY_CLASS_LISTS,
            ...LEGITIMATE_CLASS_LISTS,
            ...[...CSS_POSITION_KEYWORDS],
            ...[...CSS_POSITION_KEYWORDS].map((k) => k.toUpperCase()),
            '', ' ', '  fixed  ', 'a\tfixed', 'a\nfixed', 'x'.repeat(MAX_CLASS_ATTR_TOKEN + 1),
            null, undefined, 42, {}, ['fixed'],
        ];
        for (const value of corpus) {
            expect(be.safeClassAttribute(value), `safeClassAttribute(${JSON.stringify(value)})`)
                .toEqual(safeClassAttribute(value));
            expect(be.isSafeClassToken(value), `isSafeClassToken(${JSON.stringify(value)})`)
                .toEqual(isSafeClassToken(value));
            expect(be.safeExtraClassList(value), `safeExtraClassList(${JSON.stringify(value)})`)
                .toEqual(safeExtraClassList(value));
        }
    });

    it('the criterion refuses the closed vocabulary and NOTHING of the tidy shape it used to demand', () => {
        for (const kw of CSS_POSITION_KEYWORDS) {
            expect(isSafeClassToken(kw)).toBe(false);
            expect(isSafeClassToken(kw.toUpperCase())).toBe(false); // quirks mode matches either way
        }
        // Not a shape check: rich text legitimately carries tokens no tidy grammar would admit, and
        // deleting them would be a silent content regression, not a defence.
        for (const token of ['md:flex', 'w-1/2', 'wp-image-42', 'has-large-font-size', 'fa-solid']) {
            expect(isSafeClassToken(token)).toBe(true);
        }
        // A whole attribute value is not a token — the predicate refuses to be handed one.
        expect(isSafeClassToken('a b')).toBe(false);
        // Bounded, so a class attribute cannot become a megabyte of one token.
        expect(isSafeClassToken('x'.repeat(MAX_CLASS_ATTR_TOKEN))).toBe(true);
        expect(isSafeClassToken('x'.repeat(MAX_CLASS_ATTR_TOKEN + 1))).toBe(false);
    });

    it('a rejected token is dropped and its siblings survive', () => {
        expect(safeClassAttribute('wp-block-image fixed alignwide')).toBe('wp-block-image alignwide');
        expect(safeClassAttribute('fixed')).toBe('');
        expect(safeClassAttribute(OVERLAY_CLASS_LISTS[0])).toBe(OVERLAY_UTILITIES);
    });

    /**
     * The two boundaries are applied one after the other to the SAME value — the write boundary stores
     * it, the read boundary paints it. If the second pass changed what the first produced, the stored
     * value and the rendered one would disagree and every "clean on disk" claim would be about a
     * different string than the one the visitor sees.
     */
    it('the READ boundary re-applied to what the WRITE boundary stored is a no-op', () => {
        for (const classList of [...OVERLAY_CLASS_LISTS, ...LEGITIMATE_CLASS_LISTS]) {
            const written = safeClassAttribute(classList);
            expect(safeClassAttribute(written), `not idempotent for "${classList}"`).toBe(written);
            const stored = be.sanitize(`<div class="${classList}">x</div>`);
            expect(sanitizeHTML(stored), `read boundary altered a stored value for "${classList}"`)
                .toBe(stored);
        }
    });
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 3. THE REFUSED VOCABULARY IS DERIVED FROM THE CONSUMERS
 *
 * A criterion that names five keywords is a criterion about ONE stylesheet's spelling. What decides
 * whether a token escapes normal flow is what the sheets on the page DO with it, so both halves of
 * the refused set are re-derived here from the things that actually consume a class:
 *
 *   · every stylesheet that ships in this repository — parsed, and every class named in any rule that
 *     sets `position: fixed|absolute|sticky` collected. This is what caught `.position-fixed`, which
 *     is not a keyword under any normalisation and rebuilt the overlay verbatim;
 *   · the frontend's own `className` literals — because Tailwind emits ON DEMAND, so the utilities in
 *     the compiled bundle are exactly the spellings this source uses. This is what caught
 *     `focus:absolute` and `lg:sticky`, which a whole-token comparison waves through.
 *
 * The second derivation is deliberately written with its OWN normalisation rather than by calling the
 * production one: if someone simplifies the criterion back to a whole-token comparison, this test
 * still finds `focus:absolute` in the source and still demands that it be refused.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** Every stylesheet the product ships — the sheets a public page or the admin can actually load. */
function shippedStylesheets(): string[] {
    // The sheets a public page or an admin page can load: the framework sheet, the themes that ship,
    // the app's own CSS, and the marketplace plugins (whose admin sheets load in /admin, which is
    // where the moderation queue lives).
    const roots = ['backend/public/css', 'backend/themes', 'frontend/src', 'marketplace/plugins'];
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') continue;
                walk(abs);
            } else if (entry.name.endsWith('.css')) out.push(abs);
        }
    };
    for (const root of roots) {
        const abs = path.join(REPO, root);
        // Not a try/catch: a root that has been renamed must FAIL, not silently shrink the population.
        expect(statSync(abs).isDirectory(), `stylesheet root missing: ${root}`).toBe(true);
        walk(abs);
    }
    return out;
}

/** Every class named in a rule that takes an element out of normal flow. */
function classesBoundToPosition(): Set<string> {
    const found = new Set<string>();
    for (const file of shippedStylesheets()) {
        const css = readFileSync(file, 'utf8');
        for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            if (!/(^|[^-\w])position\s*:\s*(fixed|absolute|sticky)\b/i.test(rule[2])) continue;
            // Every class in the selector, not only the rightmost: the author writes the WHOLE
            // attribute and can supply both halves of `.modal.show`, and both ends of a descendant
            // pair on two nested elements.
            for (const cls of rule[1].matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) found.add(cls[1]);
        }
    }
    return found;
}

/**
 * Class-like tokens production source hands to Tailwind.
 *
 * Some responsive class lists live in constants (OffCanvasClient's size table) and are later selected
 * into className. A regex that only sees the final JSX attribute misses those strings. Walking every
 * production string/template literal is a safe over-approximation: false positives merely demand that
 * the shared sanitizer reject an additional spelling of a position utility, while tests and comments
 * are excluded so this gate cannot satisfy its own controls.
 */
function classTokensInFrontendSource(): Set<string> {
    const tokens = new Set<string>();
    for (const file of sourceFiles(path.join(REPO, 'frontend/src'))) {
        if (!/\.tsx?$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`)) continue;
        const src = readFileSync(file, 'utf8');
        const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
            file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const collect = (value: string) => {
            for (const token of value.split(/\s+/)) if (token && !token.includes('$')) tokens.add(token);
        };
        const visit = (node: ts.Node): void => {
            if (ts.isStringLiteralLike(node)) collect(node.text);
            if (ts.isTemplateExpression(node)) {
                collect(node.head.text);
                for (const span of node.templateSpans) collect(span.literal.text);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return tokens;
}

/** This test's OWN normalisation — a second implementation, so the gate cannot be weakened silently. */
function looksLikeAPositionUtility(token: string): boolean {
    const lower = token.toLowerCase();
    const utility = lower.split(':').pop()!.replace(/^!+/, '').replace(/!+$/, '');
    return CSS_POSITION_KEYWORDS.has(utility);
}

describe('the refused vocabulary is derived from what consumes a class, not from one spelling', () => {
    it('every class a shipped stylesheet takes out of flow is refused', () => {
        const derived = classesBoundToPosition();
        // A control on the parser: the framework sheet's longhand utilities must be in the derivation.
        for (const known of ['position-fixed', 'position-absolute', 'position-sticky', 'modal']) {
            expect([...derived], `the stylesheet parser missed .${known}`).toContain(known);
        }
        const missing = [...derived].filter((name) => !POSITION_BINDING_CLASSES.has(name));
        expect(
            missing.sort(),
            'A stylesheet in this repository binds `position` to a class the criterion still admits. ' +
            'Add each name to POSITION_BINDING_CLASSES in components/blocks/safeStyle.ts AND to its ' +
            'mirror in backend/src/core/sanitize-meta.ts — an author can write it into a comment.',
        ).toEqual([]);
        // …and every one of them is actually refused, through the predicate itself.
        for (const name of derived) expect(isSafeClassToken(name), `admitted .${name}`).toBe(false);
    });

    it('every position utility THIS source hands to Tailwind is refused, variants included', () => {
        const used = [...classTokensInFrontendSource()].filter(looksLikeAPositionUtility);
        // A control on the extractor: these variant spellings are in the tree today, and each of them
        // is a token a whole-word comparison would have admitted.
        for (const known of ['focus:absolute', 'lg:sticky', 'md:static']) {
            expect(used, `the className extractor missed ${known}`).toContain(known);
        }
        for (const token of used) expect(isSafeClassToken(token), `admitted ${token}`).toBe(false);
    });

    it('the arbitrary-property spelling is refused, and lookalikes are not', () => {
        expect(isSafeClassToken('[position:fixed]')).toBe(false);
        expect(isSafeClassToken('md:[position:sticky]')).toBe(false);
        // Neither of these sets `position`, and both are ordinary content classes.
        expect(isSafeClassToken('bg-fixed')).toBe(true);       // background-attachment
        expect(isSafeClassToken('is-fixed')).toBe(true);
        expect(isSafeClassToken('wp-block-fixed')).toBe(true);
        expect(isSafeClassToken('position-relative-ish')).toBe(true);
    });
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 4. THE REAL SINKS
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** Every class token an HTML string actually carries, however it is spelled. */
function classTokensOf(html: string): string[] {
    const out: string[] = [];
    for (const m of html.matchAll(/\bclass="([^"]*)"/g)) out.push(...m[1].split(/\s+/).filter(Boolean));
    return out;
}

/**
 * The boundaries, by the function a real path calls. Named so a failure says WHICH one let it through.
 *   · sanitizeHTML          — the READ boundary: every dangerouslySetInnerHTML on the public site and
 *                             in the admin (post bodies, HTML embeds, headings, footer, sidebar,
 *                             comments, and the moderation queue).
 *   · sanitize-meta         — the WRITE boundary for the rich fields of `_puck_data`.
 * The third boundary, `formatting.sanitizeContent` (post_content and comments), is driven by the
 * backend half of this gate — see the header for why it cannot run here.
 */
const BOUNDARIES: Array<{ name: string; run: (html: string) => string }> = [
    { name: 'sanitizeHTML (read boundary, SSR path)', run: (h) => sanitizeHTML(h) },
    { name: 'sanitize-meta.sanitize (write boundary, _puck_data)', run: (h) => be.sanitize(h) },
];

describe('the overlay is refused at every boundary, by the real function', () => {
    for (const boundary of BOUNDARIES) {
        it(`${boundary.name} strips the position keyword and keeps the rest of the document`, () => {
            for (const classList of OVERLAY_CLASS_LISTS) {
                const payload = `<div class="${classList}"><a href="https://evil.test/login">Session expired</a></div>`;
                const out = boundary.run(payload);
                for (const kw of CSS_POSITION_KEYWORDS) {
                    expect(classTokensOf(out), `${boundary.name} kept "${kw}" from "${classList}"`).not.toContain(kw);
                }
                // The element and its link are NOT destroyed — refusing the channel must not delete
                // the author's content, exactly as a rejected style declaration does not.
                expect(out).toContain('Session expired');
            }
        });

        it(`${boundary.name} leaves real content's classes byte-identical`, () => {
            for (const classList of LEGITIMATE_CLASS_LISTS) {
                const out = boundary.run(`<div class="${classList}">body</div>`);
                expect(classTokensOf(out), `${boundary.name} altered "${classList}"`)
                    .toEqual(classList.split(' '));
            }
        });
    }

    it('the moderation queue refuses it even if a dirty comment is already on disk', () => {
        // The write half (Comment.create → formatting.sanitizeContent) is pinned in the backend half
        // of this gate. THIS is the read half: admin/comments/page.tsx paints the stored value with
        // sanitizeHTML, and a comment written before the write boundary existed is exactly the case
        // where only this end can save the administrator.
        const stored = '<div class="fixed inset-0 z-50 w-full h-full bg-white">' +
            '<a href="https://evil.test/login">Your session has expired — sign in again</a></div>';
        const painted = sanitizeHTML(stored);
        expect(classTokensOf(painted)).not.toContain('fixed');
        expect(painted).toContain('https://evil.test/login'); // the link survives; the overlay does not
    });

    it('the structural className prop is bounded on the way IN, not only on the way out', () => {
        const tree = {
            content: [
                { type: 'Section', props: { className: 'fixed inset-0 z-50' } },
                { type: 'Grid', props: { className: 'celda-ancha glow-panel' } },
            ],
        };
        const stored = be.sanitizeMetaValue('_puck_data', tree);
        // Stored clean, because `_puck_data` is read by more than the render that already refuses it:
        // the exporter, the REST API, a plugin renderer, a theme with its own painter.
        expect(stored.content[0].props.className).toBe('');
        expect(stored.content[1].props.className).toBe('celda-ancha glow-panel');
        // …and the sink agrees, which is what "two boundaries saying the same thing" means.
        expect(safeExtraClassList('fixed inset-0 z-50')).toBeUndefined();
        expect(safeExtraClassList('celda-ancha glow-panel')).toBe('celda-ancha glow-panel');
    });

    it('withClassBound keeps the transforms a config already declares', () => {
        // The iframe sandbox and the rel="noopener" transforms live in exactly such a config; a bound
        // that clobbered them would trade one hole for another.
        let sawTag = '';
        const config = be.withClassBound({
            allowedTags: ['div'],
            allowedAttributes: { '*': ['class', 'data-seen'] },
            transformTags: {
                '*': (tagName: string, attribs: Record<string, string>) => {
                    sawTag = tagName;
                    return { tagName, attribs: { ...attribs, 'data-seen': 'yes' } };
                },
            },
        });
        const sanitizeHtml = require('sanitize-html');
        const out = sanitizeHtml('<div class="fixed alignwide">x</div>', config);
        expect(sawTag).toBe('div');
        expect(out).toContain('data-seen="yes"');
        expect(classTokensOf(out)).toEqual(['alignwide']);
    });
});

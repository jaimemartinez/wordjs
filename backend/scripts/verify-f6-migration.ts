/**
 * CI gate for ADR-0007 and the F6 migration/certification criteria.
 *
 * Three rules shaped this file, and every one of them is a scar from a gate this repository already
 * had to fix:
 *
 * 1. A CHECK MAY NOT DEPEND ON HOW SOMETHING IS WRITTEN WHEN IT CAN DEPEND ON WHAT IT DOES.
 *    `verify-f5-visual-contract.ts` shipped with three greps for the literal `require('...')` and
 *    reported the whole phase broken the moment a file moved to an ESM `import` of the same module.
 *    Here, "is this handler typed?" is answered from the TypeScript AST (does the `req` parameter carry
 *    a type annotation, and is that annotation `any`?), never from the spelling of a type name; "is this
 *    a database driver?" is answered by loading the module and asking whether its export implements the
 *    driver interface, never from the file name.
 *
 * 2. A FAILING CHECK MUST NOT HIDE THE ONES BEHIND IT.
 *    The same F5 gate threw on its first failure, so the ten assertions after it never ran and nobody
 *    learned what else was broken. Every check below runs inside its own try/catch, contributes failure
 *    STRINGS to a list, and the process exits once at the end with all of them printed. A check that
 *    throws is reported as that check failing — it does not stop the run.
 *
 * 3. A GATE IS ONLY REAL IF ADDING A MEMBER TURNS IT RED.
 *    No check enumerates a hand-written table of the things it is supposed to police. The members come
 *    from the tree: route files on disk, fields the F1 mapper produces, platforms the sandbox claims to
 *    confine, drivers that implement the driver interface, plugins that ship in the marketplace,
 *    measurements the F0 bench emits. Two things ARE written down here on purpose and both are labelled:
 *    the ratchet numbers (a ratchet has to remember where it was) and the certification matrix (that
 *    table is F6's own CLAIM; the check is that each claim has running evidence behind it).
 *
 * Run from backend/:  npm run verify:f6
 * Print the measured numbers without failing (use when tightening a ratchet):
 *   node -r ts-node/register scripts/verify-f6-migration.ts --print
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const ts = require('typescript');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

// ── RATCHETS ─────────────────────────────────────────────────────────────────────────────────────
// F6 is a MIGRATION. A gate that demanded an instant zero would be switched off within a day, and a
// gate that has been switched off protects nothing. These numbers are the measurement taken when F6
// opened; the gate fails when the debt RISES past them. Lowering them is the migration making progress
// and is the only edit this block should ever receive — `--print` reports the current values so the
// person who paid down debt can see exactly what to write here.
//
// Raising a number is how this gate gets neutered, so raising one is a decision that belongs in a
// review, not in a commit that is trying to go green.

/** `req: any` occurrences under src/routes + src/middleware, counted exactly as verify-f0 counts them. */
const MAX_REQUEST_ANY_OCCURRENCES = 0;
/** `(req as any)` casts at the boundary — the escape hatch that satisfies the count above while undoing it. */
const MAX_REQUEST_AS_ANY_CASTS = 0;
/** `res: any` — the same debt on the response parameter, which nothing counted until it could absorb the pressure. */
const MAX_RESPONSE_ANY_OCCURRENCES = 0;
/** Boundary files that still contain at least one `req: any`. A brand-new untyped route file raises it. */
const MAX_UNTYPED_BOUNDARY_FILES = 0;
/** Boundary files that are FULLY migrated: at least one typed `req` and not one `req: any` left. */
const MIN_FULLY_TYPED_BOUNDARY_FILES = 44;
/**
 * Does this workflow actually HAND `needle` to a runner, inside a `run:` step?
 *
 * The check here used to be `read(workflow).includes(basename)` — substring presence anywhere in the
 * YAML. Both F6 engine-suite basenames already appear in an unrelated job, inside
 * `files="backend/src/tests/f6-outbox-idempotence.test.ts backend/src/tests/f6-crash-consistency.test.ts"`,
 * a shell variable the matrix-integrity gate reads to compare two lists. So deleting the steps that
 * genuinely execute those suites left the gate printing "15 certification legs, each with evidence".
 *
 * Two things are required now: the mention must be inside a `run:` scalar (block or inline), and the
 * line must invoke a runner (`node`, `npx`, `npm`). That is what separates "passed to something that
 * executes it" from "named in a list". It is a heuristic, not a YAML parse — but it is a heuristic
 * about EXECUTION rather than about spelling, and the negative case above is exactly what it rejects.
 */
function executedByRunStep(workflow: string, needle: string): boolean {
    const lines = workflow.split('\n');
    const invokesRunner = (line: string) => /(?:^|[\s;&|(`])(?:node|npx|npm)(?:\s|$)/.test(line);
    let blockIndent = -1;

    for (const line of lines) {
        const indent = line.search(/\S/);
        if (blockIndent >= 0) {
            if (!line.trim()) continue;
            if (indent > blockIndent) {
                if (line.includes(needle) && invokesRunner(line)) return true;
                continue;
            }
            blockIndent = -1;
        }
        const step = line.match(/^\s*(?:-\s+)?run:\s*(.*)$/);
        if (!step) continue;
        const rest = step[1].trim();
        if (!rest || rest.startsWith('|') || rest.startsWith('>')) {
            blockIndent = indent;              // folded/literal block: its body is more-indented
        } else if (line.includes(needle) && invokesRunner(line)) {
            return true;                        // inline `run: node --test …`
        }
    }
    return false;
}

/**
 * Marketplace plugins with real compatibility coverage — the legacy-compatibility floor.
 *
 * THE HISTORY OF THIS NUMBER IS THE POINT OF THE COMMENT.
 *
 * It read 9/22 while the search included comments; five of those nine were slugs appearing only in prose
 * or in a packaging path. Stripping comments brought it to an honest 4/27 — but honest about the WRONG
 * QUESTION, because "a test file contains this slug" is not evidence that anything about the plugin is
 * exercised. `assert.ok(true)` beside the word `online-store` scored exactly as high as loading it.
 *
 * Coverage is now measured by RUNNING backend/src/tests/f6-plugin-compatibility.test.ts, which derives
 * its population from marketplace/plugins/ and gives every plugin a top-level test named for its slug.
 * A plugin counts as covered when that run reports its test PASSED: the manifest parsed and matched its
 * directory, the declared frontend entries exist, the shipping install-time validator accepted it, the
 * entry loaded, `init()` completed against a bridge that refuses undeclared capabilities, and everything
 * init() registered satisfies the host's own acceptance rules. Nothing here can be satisfied by adding
 * a string to a file.
 *
 * These stay ratchet bounds: the floor may only rise, the ceiling may only fall, and neither can be
 * satisfied by editing a list in this file.
 */
const MIN_COVERED_MARKETPLACE_PLUGINS = 31;
/** Marketplace plugins the compatibility suite does not exercise. Adding a plugin without one raises it. */
const MAX_UNCOVERED_MARKETPLACE_PLUGINS = 0;

/** The suite whose RUN defines the covered set (relative to backend/). */
const PLUGIN_COMPATIBILITY_SUITE = path.join('src', 'tests', 'f6-plugin-compatibility.test.ts');

/**
 * Built-in F1 fields whose `kind: 'column'` storage binding does NOT resolve to a real posts column.
 *
 * This is debt, recorded so the check that would otherwise be red can still have teeth against NEW
 * drift. `fieldsForFeatures()` binds the `authorId` field of every author-bearing type to a column
 * named `post_author`, but `createTable('posts', ...)` in src/config/database.ts declares `author_id`
 * and `models/Post.ts` reads and writes `author_id`. The declaration is WordPress's column name; the
 * table is WordJS's. Nothing breaks today because no code resolves a post through the F1 binding yet —
 * which is exactly why it survived F1 through F5 unnoticed, and exactly what F6 exists to stop.
 *
 * The set is compared for EQUALITY, so this exception retires itself: fix the binding and the gate goes
 * red asking for this entry to be deleted. It cannot rot into a permanent excuse.
 */
const UNRESOLVED_BUILTIN_COLUMN_BINDINGS = [
    'attachment.authorId -> post_author',
    'page.authorId -> post_author',
    'post.authorId -> post_author',
];

/**
 * The certification matrix F6 claims, and the file that proves each leg.
 *
 * This table is deliberately explicit and it is NOT the thing being enumerated: it is the phase's
 * claim. The CHECK is that every claim is backed by a tracked file that a suite or a workflow actually
 * runs — a leg whose evidence is deleted, renamed or never written turns the gate red instead of
 * remaining a sentence in an ADR. Legs proved by other phases point at those phases' evidence on
 * purpose: F6 certifies, it does not restate.
 */
type MatrixRunner = 'backend-suite' | 'workflow' | { script: string } | { workflow: string };
const CERTIFICATION_MATRIX: Array<{ leg: string; evidence: string; runBy: MatrixRunner }> = [
    { leg: 'three SQL engines', evidence: 'backend/src/tests/driver-conformance.test.ts', runBy: 'backend-suite' },
    { leg: 'SQL dialect parity across engines', evidence: 'backend/src/tests/driver-parity.test.ts', runBy: 'backend-suite' },
    { leg: 'Redis connected', evidence: 'backend/src/tests/cache-cluster-bus.test.ts', runBy: 'backend-suite' },
    { leg: 'Redis degraded / absent', evidence: 'backend/src/tests/redis-cache-setting.test.ts', runBy: 'backend-suite' },
    { leg: 'Linux/Windows/macOS confinement on real runners', evidence: '.github/workflows/sandbox-parity.yml', runBy: 'workflow' },
    { leg: 'confinement decision contract on every host', evidence: 'backend/src/tests/sandbox-platform-fallback.test.ts', runBy: 'backend-suite' },
    { leg: 'process failure during a content mutation', evidence: 'backend/src/tests/f0-content-mutation-failures.test.ts', runBy: 'backend-suite' },
    { leg: 'outbox retries and duplicate delivery', evidence: 'backend/src/tests/f3-content-outbox.test.ts', runBy: 'backend-suite' },
    { leg: 'outbox duplicates and a degraded cache, on every certified engine', evidence: 'backend/src/tests/f6-outbox-idempotence.test.ts', runBy: { workflow: '.github/workflows/f6-certification.yml' } },
    { leg: 'process failure mid-transaction, on every certified engine', evidence: 'backend/src/tests/f6-crash-consistency.test.ts', runBy: { workflow: '.github/workflows/f6-certification.yml' } },
    { leg: 'concurrent and multi-node load', evidence: 'backend/src/tests-integration/multinode-coherence.integration.ts', runBy: { script: 'test:multinode' } },
    { leg: 'cross-node coherence under a shared store', evidence: 'backend/src/tests-integration/coherence.integration.test.ts', runBy: { script: 'test:integration' } },
    { leg: 'migration, backup and restore', evidence: 'backend/src/tests/backup-restore-reporting.test.ts', runBy: 'backend-suite' },
    { leg: 'schema migration replay', evidence: 'backend/src/tests/migration-mysql-text-rule.test.ts', runBy: 'backend-suite' },
    { leg: 'performance regression inside the F0 budget', evidence: 'backend/f0-performance-budgets.json', runBy: { script: 'perf:f0' } },
];

// ── small helpers ────────────────────────────────────────────────────────────────────────────────

function read(relative: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

function exists(relative: string): boolean {
    return fs.existsSync(path.join(REPO_ROOT, relative));
}

function walk(dir: string, accept: (file: string) => boolean): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full, accept));
        else if (accept(full)) out.push(full);
    }
    return out.sort();
}

function relative(file: string): string {
    return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function parse(relativePath: string): any {
    const full = path.join(REPO_ROOT, relativePath);
    return ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function findNode(root: any, predicate: (node: any) => boolean): any {
    let found: any = null;
    const visit = (node: any): void => {
        if (found) return;
        if (predicate(node)) { found = node; return; }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
}

/** Literal text of a string or template node, or null when the value is computed. */
function literalText(node: any): string | null {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text;
    return null;
}

/** Members of a string-literal union type alias, e.g. `type X = 'a' | 'b'` -> ['a','b']. */
function unionMembers(source: any, typeName: string): string[] {
    const alias = findNode(source, (node: any) => ts.isTypeAliasDeclaration(node) && node.name.text === typeName);
    if (!alias || !alias.type || !ts.isUnionTypeNode(alias.type)) return [];
    return alias.type.types
        .map((member: any) => (ts.isLiteralTypeNode(member) ? literalText(member.literal) : null))
        .filter((value: string | null): value is string => typeof value === 'string');
}

/** Keys and string values of an object-literal `const NAME = { ... }` declaration. */
function objectLiteralEntries(source: any, constName: string): Array<{ key: string; value: string | null }> {
    const declaration = findNode(source, (node: any) => ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name) && node.name.text === constName);
    const initializer = declaration && declaration.initializer;
    if (!initializer || !ts.isObjectLiteralExpression(initializer)) return [];
    return initializer.properties
        .filter((property: any) => ts.isPropertyAssignment(property))
        .map((property: any) => ({
            key: ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '<computed>',
            value: literalText(property.initializer),
        }));
}

// ── the checks ───────────────────────────────────────────────────────────────────────────────────

interface CheckOutcome { failures: string[]; notes?: string[] }
interface Check { id: string; title: string; run: () => CheckOutcome }

/**
 * Classify every request-boundary file.
 *
 * `anyOccurrences` uses the SAME regex verify-f0 uses, so the two gates can never disagree about how
 * big the debt is. The typed/untyped classification is AST-based: a handler counts as typed when its
 * first parameter is called `req`/`request` and carries an explicit annotation that is not `any`. That
 * is a property of the code, not of a type NAME — `posts.ts` declares its own local
 * `AuthenticatedRequest` alias and a later file is free to import a shared one instead without this
 * check noticing or caring.
 */
function classifyBoundarySource(text: string, fileName = 'boundary.ts'): { anyOccurrences: number; typedHandlers: number } {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let typedHandlers = 0;
    const visit = (node: any): void => {
        const isFunctionLike = ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
        if (isFunctionLike && node.parameters.length) {
            const first = node.parameters[0];
            if (ts.isIdentifier(first.name) && /^(?:req|request)$/.test(first.name.text)
                && first.type && first.type.kind !== ts.SyntaxKind.AnyKeyword) {
                typedHandlers++;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { anyOccurrences: (text.match(/\breq\s*:\s*any\b/g) || []).length, typedHandlers };
}

function boundaryFiles(): Array<{ file: string; anyOccurrences: number; typedHandlers: number }> {
    const files = [
        ...walk(path.join(BACKEND_ROOT, 'src', 'routes'), (f) => f.endsWith('.ts')),
        ...walk(path.join(BACKEND_ROOT, 'src', 'middleware'), (f) => f.endsWith('.ts')),
    ];
    return files.map((file) => ({
        file: relative(file),
        ...classifyBoundarySource(fs.readFileSync(file, 'utf8'), file),
    }));
}

function checkRequestTypingRatchet(): CheckOutcome {
    const failures: string[] = [];
    const notes: string[] = [];
    const files = boundaryFiles();
    const occurrences = files.reduce((total, entry) => total + entry.anyOccurrences, 0);
    const untypedFiles = files.filter((entry) => entry.anyOccurrences > 0);

    if (occurrences > MAX_REQUEST_ANY_OCCURRENCES) {
        failures.push(`\`req: any\` rose to ${occurrences} (ceiling ${MAX_REQUEST_ANY_OCCURRENCES}). `
            + 'F6 pays this debt down; it does not take on more.');
    } else if (occurrences < MAX_REQUEST_ANY_OCCURRENCES) {
        notes.push(`\`req: any\` is down to ${occurrences}; tighten MAX_REQUEST_ANY_OCCURRENCES to ${occurrences}.`);
    }

    if (untypedFiles.length > MAX_UNTYPED_BOUNDARY_FILES) {
        failures.push(`${untypedFiles.length} boundary files still contain \`req: any\` (ceiling ${MAX_UNTYPED_BOUNDARY_FILES}). `
            + 'A new route file must be born typed.');
    } else if (untypedFiles.length < MAX_UNTYPED_BOUNDARY_FILES) {
        notes.push(`${untypedFiles.length} boundary files carry \`req: any\`; tighten MAX_UNTYPED_BOUNDARY_FILES.`);
    }

    // THE ESCAPE HATCHES, RATCHETED TOO — otherwise paying the debt down is a search-and-replace.
    //
    // `anyOccurrences` counts the text `req: any`. Rewriting a handler as `(req: Request)` and then
    // reaching for `(req as any).whatever` at every use satisfies that counter exactly while changing
    // nothing about what is known: the annotation moved, the checking did not. `res: any` is the same
    // debt on the other parameter and was never counted at all, so it could absorb the pressure.
    //
    // Both are ceilings that may fall and may not rise, like the two above. They are deliberately NOT
    // zero: four casts and twenty-seven untyped responses exist today, and a gate that demanded zero on
    // the day it was written is a gate someone deletes on the day it goes red.
    // The MEMBER too, not just the parameter. The first version of this matched `req as any` only, and
    // an adversarial pass immediately found the two shapes it could not see: `(req.query as any).page`
    // in routes/audit.ts, and routes/categories.ts declaring `req: Request` on all five handlers and
    // then widening every USE — `parseInt(per_page as any, 10)`. The gate certified that file as FULLY
    // TYPED. Widening the container is the same act as widening the parameter, one level down.
    const castRe = /\breq(?:\.[A-Za-z_$][\w$]*)*\s+as\s+any\b|<any>\s*req\b/g;
    const resAnyRe = /\bres\s*:\s*any\b/g;
    let casts = 0;
    let responseAny = 0;
    for (const entry of files) {
        const text = read(entry.file);
        casts += (text.match(castRe) || []).length;
        responseAny += (text.match(resAnyRe) || []).length;
    }

    if (casts > MAX_REQUEST_AS_ANY_CASTS) {
        failures.push(`\`req as any\` rose to ${casts} (ceiling ${MAX_REQUEST_AS_ANY_CASTS}). `
            + 'Casting the parameter back to any re-opens exactly what typing it closed, and it is invisible to the `req: any` count.');
    } else if (casts < MAX_REQUEST_AS_ANY_CASTS) {
        notes.push(`\`req as any\` is down to ${casts}; tighten MAX_REQUEST_AS_ANY_CASTS to ${casts}.`);
    }

    if (responseAny > MAX_RESPONSE_ANY_OCCURRENCES) {
        failures.push(`\`res: any\` rose to ${responseAny} (ceiling ${MAX_RESPONSE_ANY_OCCURRENCES}). `
            + 'The response parameter is the same debt as the request one.');
    } else if (responseAny < MAX_RESPONSE_ANY_OCCURRENCES) {
        notes.push(`\`res: any\` is down to ${responseAny}; tighten MAX_RESPONSE_ANY_OCCURRENCES to ${responseAny}.`);
    }

    // The F0 baseline records the same number from the same regex. If the two disagree, one of the two
    // gates is measuring something the other is not, and the honest report is "we no longer know".
    const baseline = JSON.parse(read('backend/f0-baseline.json'));
    const baselineOccurrences = baseline?.snapshot?.typingDebt?.requestAny?.occurrences;
    if (baselineOccurrences !== occurrences) {
        failures.push(`F0 baseline records ${baselineOccurrences} \`req: any\` occurrences, this gate measures ${occurrences}; `
            + 'run verify:f0 and reconcile before trusting either number.');
    }
    return { failures, notes };
}

function checkMigratedHandlersAreFullyTyped(): CheckOutcome {
    const failures: string[] = [];
    const notes: string[] = [];
    const files = boundaryFiles();
    const fullyTyped = files.filter((entry) => entry.typedHandlers > 0 && entry.anyOccurrences === 0);
    const partial = files.filter((entry) => entry.typedHandlers > 0 && entry.anyOccurrences > 0);

    if (fullyTyped.length < MIN_FULLY_TYPED_BOUNDARY_FILES) {
        failures.push(`only ${fullyTyped.length} boundary files are fully typed (floor ${MIN_FULLY_TYPED_BOUNDARY_FILES}). `
            + 'A migrated handler that goes back to `req: any` un-migrates its file, and that is the regression '
            + `this floor exists to catch. Currently fully typed: ${fullyTyped.map((entry) => entry.file).join(', ')}`);
    } else if (fullyTyped.length > MIN_FULLY_TYPED_BOUNDARY_FILES) {
        notes.push(`${fullyTyped.length} boundary files are fully typed; raise MIN_FULLY_TYPED_BOUNDARY_FILES to ${fullyTyped.length}.`);
    }
    if (partial.length) {
        notes.push(`${partial.length} files are half migrated (typed handlers beside \`req: any\`): `
            + partial.map((entry) => `${entry.file}(${entry.anyOccurrences})`).join(', '));
    }
    return { failures, notes };
}

/**
 * Built-in content types must declare 100% of their fields, and every declaration must MEAN something.
 *
 * Three properties, none of which reads a list of field names:
 *   a) the declared field set is exactly what the F1 feature mapper produces for the declared features,
 *      so no built-in can hand-edit a field in or out behind the mapper's back;
 *   b) every field a built-in declares as revisioned appears in its revision projection (F4 reads that
 *      projection, so a field that drops out of it silently stops being versioned);
 *   c) every `kind: 'column'` binding resolves to a column that the posts table actually has, and every
 *      `kind: 'meta'` binding carries a non-empty key.
 */
function checkBuiltinFieldCompleteness(): CheckOutcome {
    const failures: string[] = [];
    const notes: string[] = [];
    const { fieldsForFeatures } = require('../src/core/content-schema');
    const { getBuiltinContentSchemas } = require('../src/core/content-schemas-builtins');

    // Columns the posts table really has: the createTable('posts', [...]) literal plus any ALTER that
    // adds one. Reading the DDL beats hard-coding the column list — a column renamed in the DDL and
    // nowhere else immediately breaks the bindings that point at it.
    const databaseSource = parse('backend/src/config/database.ts');
    const createPosts = findNode(databaseSource, (node: any) => ts.isCallExpression(node)
        && ts.isIdentifier(node.expression) && node.expression.text === 'createTable'
        && literalText(node.arguments[0]) === 'posts');
    if (!createPosts || !createPosts.arguments[1] || !ts.isArrayLiteralExpression(createPosts.arguments[1])) {
        return { failures: ['could not read the posts table definition from src/config/database.ts'], notes };
    }
    const columns = new Set<string>(
        createPosts.arguments[1].elements
            .map((element: any) => literalText(element))
            .filter((text: string | null): text is string => typeof text === 'string')
            .map((text: string) => text.trim().split(/\s+/)[0]),
    );
    for (const file of walk(path.join(BACKEND_ROOT, 'src'), (f) => f.endsWith('.ts'))) {
        const alters = fs.readFileSync(file, 'utf8')
            .matchAll(/ALTER\s+TABLE\s+posts\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi);
        for (const alter of alters) columns.add(alter[1]);
    }
    if (columns.size < 5) failures.push(`only ${columns.size} posts columns were recovered from the DDL; the reader is broken`);

    const unresolved: string[] = [];
    for (const schema of getBuiltinContentSchemas()) {
        const expected = Object.keys(fieldsForFeatures(schema.features)).sort();
        const declared = Object.keys(schema.fields).sort();
        if (expected.join('|') !== declared.join('|')) {
            failures.push(`${schema.name}: declared fields [${declared.join(', ')}] are not what the F1 feature mapper `
                + `produces for features [${schema.features.join(', ')}] ([${expected.join(', ')}])`);
        }
        for (const [name, field] of Object.entries<any>(schema.fields)) {
            const storage = field && field.storage;
            if (!storage || typeof storage.kind !== 'string') {
                failures.push(`${schema.name}.${name}: no storage binding — the declaration cannot be honoured`);
                continue;
            }
            if (storage.kind === 'meta' && !storage.key) failures.push(`${schema.name}.${name}: meta binding without a key`);
            if (storage.kind === 'column') {
                if (!storage.column) failures.push(`${schema.name}.${name}: column binding without a column`);
                else if (!columns.has(storage.column)) unresolved.push(`${schema.name}.${name} -> ${storage.column}`);
            }
            if (field.revisioned && !schema.revisions.fields.includes(name)) {
                failures.push(`${schema.name}.${name} is revisioned but missing from revisions.fields — F4 would stop versioning it`);
            }
        }
    }

    const expectedUnresolved = [...UNRESOLVED_BUILTIN_COLUMN_BINDINGS].sort().join('|');
    const actualUnresolved = [...new Set(unresolved)].sort().join('|');
    if (expectedUnresolved !== actualUnresolved) {
        failures.push('built-in column bindings that do not resolve to a real posts column changed. '
            + `Expected [${expectedUnresolved || 'none'}], found [${actualUnresolved || 'none'}]. `
            + 'A new entry is new drift; a missing entry means the debt was paid — delete it from '
            + 'UNRESOLVED_BUILTIN_COLUMN_BINDINGS so the exception cannot outlive the defect.');
    }
    if (actualUnresolved) notes.push(`${unresolved.length} built-in column bindings are still unresolved (recorded debt)`);
    return { failures, notes };
}

/**
 * Visual-contract divergence: CONSUME F5's verifier, do not restate its assertions.
 *
 * The generator's --check mode is what proves the committed projections match the canonical JSON, and
 * verify-f5 is what proves the consumers still read them. Re-implementing either here would create the
 * third copy F5 exists to abolish. Both run inside this check's try/catch, so an F5 regression is
 * reported as one F6 failure line and the checks after it still run.
 */
function checkVisualContractHasNoDivergence(): CheckOutcome {
    const failures: string[] = [];
    const generator = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'generate-visual-contract.mjs'), '--check'], {
        cwd: REPO_ROOT, encoding: 'utf8',
    });
    if (generator.status !== 0) {
        failures.push('the F5 generator reports drift between contracts/visual-contract.v1.json and the committed '
            + `artefacts: ${(generator.stderr || generator.stdout || '').trim().split('\n').slice(-3).join(' / ')}`);
    }
    try {
        require('./verify-f5-visual-contract');
    } catch (error: any) {
        failures.push(`the F5 gate itself fails, so F6 cannot certify zero visual divergence: ${error && error.message ? error.message : error}`);
    }
    return { failures };
}

/**
 * Legacy plugins must be covered by compatibility tests — and "covered" must mean EXERCISED.
 *
 * The population is every plugin that actually ships in the marketplace, read off disk. Coverage is
 * decided by RUNNING backend/src/tests/f6-plugin-compatibility.test.ts under the TAP reporter and
 * reading which per-plugin tests reported `ok`. That is the whole design: the covered set comes out of
 * an execution, so it cannot be inflated by adding a slug to a comment, to a fixture name, or to a
 * skipped test — the three ways the previous mention-counting version could be fooled.
 *
 * Adding a plugin directory without adding it to the suite's population is impossible (the suite derives
 * the population the same way this does), so the way this goes red is the way it should: a plugin that
 * FAILS its compatibility test stops being counted, and the ratchet floor catches it.
 */
function checkLegacyPluginCompatibilityCoverage(): CheckOutcome {
    const failures: string[] = [];
    const notes: string[] = [];
    const pluginsRoot = path.join(REPO_ROOT, 'marketplace', 'plugins');
    if (!fs.existsSync(pluginsRoot)) return { failures: ['marketplace/plugins is missing'], notes };
    const slugs = fs.readdirSync(pluginsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

    const suitePath = path.join(BACKEND_ROOT, PLUGIN_COMPATIBILITY_SUITE);
    if (!fs.existsSync(suitePath)) {
        return {
            failures: [`${PLUGIN_COMPATIBILITY_SUITE} is missing, so no plugin has compatibility evidence at all`],
            notes,
        };
    }

    // `--test-force-exit` for the same reason backend's own `npm test` uses it: a plugin's init() may
    // leave a timer behind, and this gate must not wait on one. The TAP reporter is chosen (rather than
    // the default spec output) because its `ok N - <name>` lines are a stable machine format.
    //
    // NODE_TEST_* is stripped from the child's environment on purpose. f6-final-criteria.test.ts calls
    // verify() from INSIDE a test-runner process, so those variables would be inherited and the child
    // would believe it is a nested test child of that run — the reporter it selects, and therefore the
    // format parsed below, would depend on who called this gate. Stripping them makes the child's
    // behaviour identical whether the gate is run from the CLI or from a test.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) if (key.startsWith('NODE_TEST_')) delete childEnv[key];
    // THE FLAKE-RETRY POLICY LIVES IN EXACTLY ONE PLACE, AND THIS GATE USES THAT ONE.
    //
    // This check used to carry a second, local copy of the retry, and the copy was INERT from the day it
    // was written. It retried only when `failed.size === 0` — "the run produced no `not ok` line at all" —
    // because the force-exit deserialize flake was believed to drop the run's tail subtests silently. It
    // does not. When the runner cannot deserialize a child's IPC frame it FAILS THE FILE, and the TAP
    // stream carries a column-0 line whose NAME is the file path rather than a plugin slug:
    //
    //     not ok 1 - src/tests/f6-plugin-compatibility.test.ts
    //       error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
    //
    // The parser below adds that to `failed`, so `failed.size` was 1 in precisely the case the retry
    // existed for, `incompleteFlake` was false every time, and the retry never ran once. Measured on the
    // CI platform (linux, node 22, Redis reachable, this suite): the flake hits ~1 run in 4, and 4 of 10
    // runs of this check failed WITHOUT EMITTING A SINGLE RETRY NOTE. With the delegation below, 1 of 12.
    //
    // The flake ITSELF is fixed at its source in core/cache.ts, and the mechanism was not what the
    // surrounding comments say. It is not force-exit killing a child mid-write — it reproduces at the
    // same rate with `--test-force-exit` removed (7/20 runs). It tracks REACHABLE REDIS: 0/20 failures
    // with the cache off, ~30% with it connected, because core/cache logged '⚡ Redis Object Cache
    // Connected' to STDOUT from an async 'connect' callback, and node:test children report results over
    // stdout as V8 frames. That write landed inside a frame. Moving it to stderr: 0/20. Which is also
    // why only the "Redis connected" leg went red and why nobody reproduced it on Windows.
    //
    // This delegation stays regardless, because the gate must not depend on one module never logging
    // asynchronously again, and because the local copy of the retry was measurably dead.
    //
    // So the retry is delegated to scripts/test-with-flake-retry.mjs — the same wrapper the F6 workflow
    // already runs every one of these suites through, and the one whose predicate is honest about the
    // shape: retry only when EVERY `not ok` in the run is explained, inside its own TAP YAML block, by
    // the deserialize error. A plugin that genuinely fails is a `not ok` whose block says something else,
    // and it is never retried. One policy, in one file, instead of two that disagree about the bug.
    //
    // `--test` is NOT passed here: the wrapper prepends it.
    const run = spawnSync(process.execPath, [
        path.join(REPO_ROOT, 'scripts', 'test-with-flake-retry.mjs'),
        '--test-force-exit', '--test-concurrency=1', '--test-reporter=tap',
        '-r', 'ts-node/register', PLUGIN_COMPATIBILITY_SUITE,
    ], { cwd: BACKEND_ROOT, encoding: 'utf8', env: childEnv, maxBuffer: 64 * 1024 * 1024 });
    const output = `${run.stdout || ''}${run.stderr || ''}`;

    // Which per-plugin tests PASSED, read off the run. A `not ok` line is deliberately not counted:
    // a plugin whose compatibility test fails has no compatibility evidence, whatever the file says.
    // A SKIPPED TEST IS NOT A PASSING TEST, AND TAP SAYS SO IN THE DIRECTIVE.
    //
    // This read `/^ok\s+\d+\s+-\s+(.+?)\s*(?:#.*)?$/`, and that trailing `(?:#.*)?` swallowed the very
    // thing that distinguishes the two outcomes. node:test emits `ok 1 - contact-forms # SKIP` for a
    // skipped test and exits 0, so a one-token edit — `test(slug, { skip: true }, ...)` — marked all 31
    // plugins covered while running none of them. The ratchet would then have been satisfied by exactly
    // what it was written to replace.
    //
    // The directive is now captured and inspected: SKIP and TODO are recorded as neither passed nor
    // failed, and named, so a suite that stops executing is loud instead of flattering.
    //
    // The wrapper echoes every attempt it makes, so these sets are the UNION over attempts. That is the
    // right reading and it cannot launder a failure: the wrapper only ever makes a second attempt when
    // the first one's every `not ok` was the runner flake, so a plugin that actually failed ends the run
    // there and stays out of `passed`. A run the wrapper could not settle still exits non-zero and is
    // still reported as a failure below.
    const passed = new Set<string>();
    const failed = new Set<string>();
    const skipped = new Set<string>();
    for (const line of output.split(/\r?\n/)) {
        const ok = /^ok\s+\d+\s+-\s+(.+?)(?:\s+#\s*(.*))?$/.exec(line);
        if (ok) {
            const directive = (ok[2] || '').trim();
            if (/^(?:SKIP|TODO)\b/i.test(directive)) skipped.add(ok[1].trim());
            else passed.add(ok[1].trim());
            continue;
        }
        const notOk = /^not ok\s+\d+\s+-\s+(.+?)(?:\s+#\s*(.*))?$/.exec(line);
        if (notOk) failed.add(notOk[1].trim());
    }

    const skippedPlugins = slugs.filter((slug) => skipped.has(slug));
    if (skippedPlugins.length) {
        failures.push(`${PLUGIN_COMPATIBILITY_SUITE} SKIPPED ${skippedPlugins.length} plugin test(s) — a skipped test is not `
            + `compatibility evidence, and node:test still exits 0 for it: ${skippedPlugins.join(', ')}`);
    }

    const covered = slugs.filter((slug) => passed.has(slug));
    const uncovered = slugs.filter((slug) => !passed.has(slug));

    if (run.status !== 0) {
        const named = slugs.filter((slug) => failed.has(slug));
        failures.push(`${PLUGIN_COMPATIBILITY_SUITE} exits ${run.status}`
            + (named.length ? `; failing plugins: ${named.join(', ')}` : '')
            + `. ${(output.trim().split('\n').slice(-4).join(' / ')).slice(0, 400)}`);
    }
    // ENUMERATION IS CHECKED AS A PROPERTY, NOT BY THE NAME OF A TEST.
    //
    // This used to be `[...passed].some((name) => name.includes('population is non-empty'))` — a
    // substring match on a test's NAME, which is the exact thing this file's own rules forbid: renaming
    // that test silently disarms the guard, and the guard could itself be skipped (see the directive
    // handling above) and still read as present.
    //
    // The property is "the run produced a verdict for every plugin that exists on disk". A run that
    // enumerated nothing reports no slugs at all and fails here; a run that enumerated a stale subset
    // names exactly which plugins it never mentioned.
    const unreported = slugs.filter((slug) => !passed.has(slug) && !failed.has(slug) && !skipped.has(slug));
    if (unreported.length) {
        failures.push(`${PLUGIN_COMPATIBILITY_SUITE} produced no verdict at all for ${unreported.length} of ${slugs.length} `
            + `plugin(s) on disk, so its enumeration is not reading marketplace/plugins: ${unreported.slice(0, 8).join(', ')}`
            + (unreported.length > 8 ? ', …' : ''));
    }

    if (covered.length < MIN_COVERED_MARKETPLACE_PLUGINS) {
        failures.push(`only ${covered.length} of ${slugs.length} marketplace plugins pass their compatibility test `
            + `(floor ${MIN_COVERED_MARKETPLACE_PLUGINS}); a plugin lost its compatibility coverage. `
            + `Uncovered: ${uncovered.join(', ') || 'none'}`);
    } else if (covered.length > MIN_COVERED_MARKETPLACE_PLUGINS) {
        notes.push(`${covered.length} plugins are covered; raise MIN_COVERED_MARKETPLACE_PLUGINS to ${covered.length}.`);
    }
    if (uncovered.length > MAX_UNCOVERED_MARKETPLACE_PLUGINS) {
        failures.push(`${uncovered.length} marketplace plugins are not exercised by ${PLUGIN_COMPATIBILITY_SUITE} `
            + `(ceiling ${MAX_UNCOVERED_MARKETPLACE_PLUGINS}). A plugin may not ship without compatibility evidence. `
            + `Uncovered: ${uncovered.join(', ')}`);
    } else if (uncovered.length < MAX_UNCOVERED_MARKETPLACE_PLUGINS) {
        notes.push(`${uncovered.length} plugins remain uncovered; tighten MAX_UNCOVERED_MARKETPLACE_PLUGINS to ${uncovered.length}.`);
    }
    return { failures, notes };
}

/**
 * The sandbox must fail closed when its required boundary is unavailable — on every platform it claims.
 *
 * `.github/workflows/sandbox-parity.yml` already proves Landlock+seccomp, AppContainer and Seatbelt on
 * real runners, control-vs-confined, including the fail-closed case. F6 consumes that instead of
 * rebuilding it, and adds the one thing the workflow cannot assert about itself: that the set of
 * platforms the PRODUCT claims to confine is exactly the set the workflow certifies. The platform list
 * and the state list are both read out of plugin-isolate.ts, and each extracted platform is confirmed
 * against the exported pure function, so the extraction cannot silently drift from the runtime.
 *
 * Add `freebsd: 'capsicum'` to the mechanism map and this goes red, because no runner certifies it.
 */
function checkSandboxFailsClosed(): CheckOutcome {
    const failures: string[] = [];
    const notes: string[] = [];
    const isolate = require('../src/core/plugin-isolate');
    const source = parse('backend/src/core/plugin-isolate.ts');
    const declared = objectLiteralEntries(source, 'KERNEL_MECHANISM_BY_PLATFORM');
    const states = unionMembers(source, 'ConfinementState');

    if (!declared.length) return { failures: ['could not read KERNEL_MECHANISM_BY_PLATFORM from plugin-isolate.ts'], notes };
    if (!states.includes('active') || !states.includes('degraded')) {
        failures.push(`ConfinementState no longer contains both 'active' and 'degraded': [${states.join(', ')}]`);
    }

    const runnerFamilyForPlatform: Record<string, RegExp> = { linux: /^ubuntu-/, win32: /^windows-/, darwin: /^macos-/ };
    const workflow = read('.github/workflows/sandbox-parity.yml');
    const runners = [...workflow.matchAll(/^\s*-\s*os:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    if (!runners.length) failures.push('no `- os:` runners found in sandbox-parity.yml; the OS certification is not running');

    for (const { key: platform, value: mechanism } of declared) {
        if (isolate.platformKernelMechanism(platform) !== mechanism) {
            failures.push(`the mechanism map says ${platform} -> ${mechanism} but platformKernelMechanism() says `
                + `${isolate.platformKernelMechanism(platform)}; this gate is reading a stale declaration`);
            continue;
        }
        if (mechanism === 'none') continue;

        for (const state of states.filter((value) => value !== 'active')) {
            for (const netGranted of [false, true]) {
                const decision = isolate.__platformLaunchDecision({ platform, state, netGranted, tsNode: false });
                if (decision.use !== false) {
                    failures.push(`${platform}: launch decision uses ${mechanism} while the boundary state is '${state}' `
                        + `(network=${netGranted ? 'granted' : 'denied'}) — that is failing OPEN`);
                }
            }
        }
        if (isolate.__nativeSandboxRequired({ configured: true, platform, tsNode: false }) !== true) {
            failures.push(`${platform}: compiled production does not require native confinement, so an unavailable `
                + 'boundary would launch a plugin unconfined');
        }
        const family = runnerFamilyForPlatform[platform];
        if (!family) {
            failures.push(`${platform} claims ${mechanism} confinement but this gate knows no CI runner family for it; `
                + 'add the runner to sandbox-parity.yml and the mapping here before shipping the platform');
        } else if (!runners.some((runner) => family.test(runner))) {
            failures.push(`${platform} claims ${mechanism} confinement but no sandbox-parity runner matches ${family}; `
                + `runners are [${runners.join(', ')}]`);
        }
    }

    if (isolate.__linuxFloorDecision({ platform: 'linux', zeroConf: 'degraded', netGranted: false }).layer !== 'none') {
        failures.push('a failed Linux probe is still reported as a floor in force');
    }
    notes.push(`certified platforms: ${declared.filter((entry) => entry.value !== 'none').map((entry) => entry.key).join(', ')} `
        + `across runners [${runners.join(', ')}]`);
    return { failures, notes };
}

/**
 * Every database engine WordJS can actually run on must have conformance evidence.
 *
 * A driver is identified by BEHAVIOUR — its export implements every method of the driver interface —
 * not by living in src/drivers/ and not by its file name. `interface.ts` and `mysql-text-rule.ts` are
 * in that directory and are correctly not drivers. Drop in a driver for a fourth engine and this goes
 * red until driver-conformance.test.ts exercises it.
 */
function checkEveryDriverIsCertified(): CheckOutcome {
    const failures: string[] = [];
    const notes: string[] = [];
    const DriverInterface = require('../src/drivers/interface');
    const contract = Object.getOwnPropertyNames(DriverInterface.prototype).filter((name) => name !== 'constructor');
    if (contract.length < 5) return { failures: [`the driver interface exposes only ${contract.length} methods; the reader is broken`], notes };

    const conformance = read('backend/src/tests/driver-conformance.test.ts');
    const drivers: string[] = [];
    for (const file of walk(path.join(BACKEND_ROOT, 'src', 'drivers'), (f) => f.endsWith('.ts'))) {
        const name = path.basename(file, '.ts');
        let module_: any;
        try {
            module_ = require(file);
        } catch (error: any) {
            failures.push(`src/drivers/${name}.ts cannot be loaded, so nothing can certify it: ${error && error.message ? error.message : error}`);
            continue;
        }
        const implementsContract = module_ && contract.every((method) => typeof module_[method] === 'function');
        if (!implementsContract) continue;
        drivers.push(name);
        if (!new RegExp(String.raw`(?<![A-Za-z0-9-])${name}(?![A-Za-z0-9-])`).test(conformance)) {
            failures.push(`driver '${name}' implements the driver interface but driver-conformance.test.ts never names it`);
        }
    }
    if (drivers.length < 3) failures.push(`only ${drivers.length} drivers implement the interface; F6 certifies three SQL engines`);
    notes.push(`drivers implementing the interface: ${drivers.join(', ')}`);

    // WORDJS_CI_DB=1 is what turns the postgres/mysql blocks from graceful skips into hard failures. A
    // conformance suite that self-skips and counts as PASS is the failure mode this programme has
    // already shipped twice; the flag must survive in CI or the three-engine leg is decorative.
    const ci = read('.github/workflows/ci.yml');
    if (!/WORDJS_CI_DB:\s*'?1'?/.test(ci)) {
        failures.push('ci.yml no longer sets WORDJS_CI_DB=1, so the postgres and mysql conformance blocks would skip and still be green');
    }
    return { failures, notes };
}

/**
 * The F0 performance budget must cover 100% of what the F0 bench measures.
 *
 * "No performance regression, within the budget defined in F0" is only enforceable if every measurement
 * has a ceiling. The bench builds one `raw` record of measurements and reports each as `<name>P95`; the
 * budget file lists ceilings under `contentMilliseconds`. The two key sets must match exactly, in both
 * directions: a measurement with no ceiling is unenforced, and a ceiling with no measurement is a
 * ceiling that can never be exceeded. Add a sixth measurement to the bench and this goes red.
 */
/** Both directions of budget coverage, as a pure function so the evidence test can exercise it. */
function budgetCoverageFailures(measured: string[], ceilings: string[]): string[] {
    const failures: string[] = [];
    for (const metric of measured) {
        if (!ceilings.includes(metric)) failures.push(`the F0 bench measures ${metric} but no budget bounds it`);
    }
    for (const ceiling of ceilings) {
        if (!measured.includes(ceiling)) failures.push(`f0-performance-budgets.json bounds ${ceiling}, which the bench never measures`);
    }
    return failures;
}

function checkPerformanceBudgetIsComplete(): CheckOutcome {
    const failures: string[] = [];
    const notes: string[] = [];
    const source = parse('backend/scripts/f0-content-bench.ts');
    const raw = findNode(source, (node: any) => ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name) && node.name.text === 'raw');
    if (!raw || !raw.initializer || !ts.isObjectLiteralExpression(raw.initializer)) {
        return { failures: ['could not read the measurement record from scripts/f0-content-bench.ts'], notes };
    }
    const measured = raw.initializer.properties
        .map((property: any) => (property.name && property.name.text ? `${property.name.text}P95` : '<computed>'))
        .sort();
    const budgets = JSON.parse(read('backend/f0-performance-budgets.json'));
    const ceilings = Object.keys(budgets.contentMilliseconds || {}).sort();

    failures.push(...budgetCoverageFailures(measured, ceilings));
    for (const ceiling of ceilings) {
        if (measured.includes(ceiling) && !Number.isFinite(Number(budgets.contentMilliseconds[ceiling]))) {
            failures.push(`budget ${ceiling} is not a number, so nothing can exceed it`);
        }
    }
    for (const section of ['httpSteadyState', 'versoEditorMilliseconds']) {
        // A key starting with `_` is an annotation, not a ceiling — `_note` records why a ceiling carries
        // the name it does, and Number(prose) is NaN, which would report a broken budget where there is
        // none. Every key that is NOT an annotation is a ceiling and must be a number: a NaN ceiling is
        // one nothing can ever exceed, which is a budget that has quietly stopped existing.
        const ceilingEntries = Object.entries(budgets[section] || {}).filter(([name]) => !name.startsWith('_'));
        if (!ceilingEntries.length) failures.push(`f0-performance-budgets.json has no ${section} ceilings`);
        for (const [name, value] of ceilingEntries) {
            if (!Number.isFinite(Number(value))) {
                failures.push(`${section}.${name} is not a number, so nothing can exceed it`);
            }
        }
    }

    // GIVE `versoEditorMilliseconds` A CONSUMER — AND MAKE THE CONSUMER UNABLE TO OUTVOTE IT.
    //
    // It was a committed budget nobody read: the same three numbers lived a second time as literals in
    // frontend/e2e/verso/perf.spec.ts, and only those literals decided anything. The first repair PINNED
    // the two spellings to each other by regex, which proved they were equal but left the hole open one
    // level down — the spec's env levers. `VERSO_PERF_TTI_MS: 9000` in a job would have been obeyed in
    // silence while the reviewed file still read 2500.
    //
    // There is one copy now: frontend/e2e/verso/perf-budget.ts reads this JSON and the spec enforces
    // what it returns, with the levers able to TIGHTEN only. So the property checked below is no longer
    // "the two spellings agree" (there is only one) but the one that actually protects the budget:
    // THE SPEC CANNOT ENFORCE A THRESHOLD LOOSER THAN THE COMMITTED ONE.
    failures.push(...versoEditorBudgetFailures(budgets.versoEditorMilliseconds || {}));

    // F6 adds a host-relative budget beside F0's absolute one, and each of its operations may inherit an
    // absolute ceiling from F0 by key. A key that names nothing is an inheritance that silently does not
    // happen, so the seam between the two files is checked here rather than trusted.
    const baseline = JSON.parse(read('backend/f0-baseline.json'));
    const relative_ = baseline.performanceBudget;
    if (!relative_) {
        notes.push('f0-baseline.json carries no host-relative performanceBudget yet; only the absolute F0 ceilings are checked');
    } else {
        for (const [name, operation] of Object.entries<any>(relative_.operations || {})) {
            // Declared, not merely valid-when-present: an absent key used to skip this operation here
            // and in both other gates that enforce "F6 may not loosen an F0 ceiling", so removing the
            // line disabled the rule everywhere while every gate stayed green.
            if (!operation || !Object.prototype.hasOwnProperty.call(operation, 'f0BudgetKey')) {
                failures.push(`performanceBudget.operations.${name} declares no f0BudgetKey — name the F0 ceiling it inherits, or null with a note saying why none exists`);
                continue;
            }
            const key = operation.f0BudgetKey;
            if (key === null) {
                if (!(typeof operation.note === 'string' && operation.note.trim())) {
                    failures.push(`performanceBudget.operations.${name}: f0BudgetKey is null with no note explaining why there is no F0 ceiling to inherit`);
                }
                continue;
            }
            if (!ceilings.includes(key)) {
                failures.push(`performanceBudget.operations.${name} inherits F0 ceiling '${key}', which f0-performance-budgets.json does not define`);
            }
        }
    }
    notes.push(`budgeted measurements: ${ceilings.join(', ')}`);
    return { failures, notes };
}

/**
 * F6-C08's editor half: `versoEditorMilliseconds` is the only place those ceilings are written, and
 * nothing downstream can enforce a looser one.
 *
 * Checked in the two directions a budget can be neutered:
 *
 *  - THE RESOLVER IS RUN, NOT READ (rule 1). frontend/e2e/verso/perf-budget.ts imports nothing from
 *    Playwright precisely so this gate can load it and ask it what it does: with an empty environment
 *    it must return exactly the committed numbers (a default that is not the committed budget means the
 *    JSON is decorative again); a lever one millisecond LOOSER than the committed ceiling must throw;
 *    a stricter one must still apply (ci.yml plans to calibrate downward on the real runner, and an
 *    inert lever would send it back to editing literals); and a non-numeric one must be refused, since
 *    Number('later') is NaN and a NaN ceiling reports configuration rather than performance.
 *
 *  - THE SPEC IS TRACED AS DATA FLOW. Running it needs a browser and a served site, so its half is read
 *    from the AST — but by following where each ceiling COMES FROM, not by matching a spelling: every
 *    argument handed to toBeLessThan()/toBeLessThanOrEqual() must trace back to a property of the object
 *    resolveVersoPerfBudget() returned. A numeric literal there is exactly the regression this replaces.
 *
 * Both member lists come from the tree (rule 3): the levers are enumerated from the module and compared
 * for EQUALITY against the keys in the JSON, and every committed key must be consumed by some assertion.
 * Add a fourth ceiling to versoEditorMilliseconds and this check goes red until something enforces it.
 */
function versoEditorBudgetFailures(editorBudget: Record<string, unknown>): string[] {
    const failures: string[] = [];
    const specPath = 'frontend/e2e/verso/perf.spec.ts';
    const resolverPath = 'frontend/e2e/verso/perf-budget.ts';
    for (const file of [specPath, resolverPath]) {
        if (!exists(file)) {
            return [`${file} is missing, so nothing reads f0-performance-budgets.json#versoEditorMilliseconds `
                + 'and the committed editor budget enforces nothing'];
        }
    }

    // ── the resolver, EXECUTED ───────────────────────────────────────────────────────────────────
    let resolver: any;
    try {
        resolver = require(path.join(REPO_ROOT, resolverPath));   // a .ts module: ts-node compiles it here
    } catch (error: any) {
        return [`${resolverPath} could not be loaded (${(error && error.message) || error}), so what the `
            + 'spec enforces cannot be observed'];
    }
    const levers: any[] = Array.isArray(resolver.PERF_LEVERS) ? resolver.PERF_LEVERS : [];
    if (typeof resolver.resolveVersoPerfBudget !== 'function' || !levers.length) {
        return [`${resolverPath} must export resolveVersoPerfBudget() and a non-empty PERF_LEVERS table; `
            + 'without both, this check would pass by having nothing to check'];
    }

    const committedKeys = Object.keys(editorBudget).filter((key) => !key.startsWith('_')).sort();
    const leverKeys = levers.map((lever: any) => String(lever.key)).sort();
    for (const key of committedKeys) {
        if (!leverKeys.includes(key)) {
            failures.push(`versoEditorMilliseconds.${key} is committed but ${resolverPath} declares no lever `
                + 'for it, so nothing resolves it and no spec can enforce it');
        }
    }
    for (const key of leverKeys) {
        if (!committedKeys.includes(key)) {
            failures.push(`${resolverPath} declares a lever for '${key}', which `
                + 'f0-performance-budgets.json#versoEditorMilliseconds does not define — it resolves to NaN');
        }
    }

    const resolve = (env: Record<string, string>): { budget?: any; error?: string } => {
        try {
            return { budget: resolver.resolveVersoPerfBudget(env) };
        } catch (error: any) {
            return { error: (error && error.message) || String(error) };
        }
    };

    const defaults = resolve({});
    if (defaults.error) {
        failures.push(`with no override at all, resolveVersoPerfBudget() threw on the committed budget `
            + `itself: ${defaults.error}`);
    } else {
        for (const key of committedKeys) {
            const committed = Number((editorBudget as any)[key]);
            const resolved = Number(defaults.budget[key]);
            if (resolved !== committed) {
                failures.push(`with no override the spec enforces ${key}=${resolved}ms while `
                    + `f0-performance-budgets.json commits ${committed}ms — the default is not the committed budget`);
            }
        }
    }

    for (const lever of levers) {
        const key = String(lever.key);
        const env = String(lever.env);
        const committed = Number((editorBudget as any)[key]);
        if (!Number.isFinite(committed) || committed <= 0) continue;   // already reported as a non-numeric ceiling

        const looser = resolve({ [env]: String(committed + 1) });
        if (!looser.error) {
            failures.push(`${env}=${committed + 1}ms is looser than the committed ${key}=${committed}ms and was `
                + `ACCEPTED (the spec would enforce ${Number(looser.budget[key])}ms). A job variable must not be `
                + 'able to retire the committed budget: raise it in f0-performance-budgets.json, where it is reviewed');
        }

        const tighter = committed / 2;
        const tightened = resolve({ [env]: String(tighter) });
        if (tightened.error) {
            failures.push(`${env}=${tighter}ms is STRICTER than the committed ${key}=${committed}ms and was `
                + `refused (${tightened.error}); calibrating downward on a runner is the lever's whole purpose`);
        } else if (Number(tightened.budget[key]) !== tighter) {
            failures.push(`${env}=${tighter}ms did not tighten ${key}: the spec would still enforce `
                + `${Number(tightened.budget[key])}ms, so the lever ci.yml plans to use is inert`);
        }

        const garbage = resolve({ [env]: 'later' });
        if (!garbage.error) {
            failures.push(`${env}='later' was accepted as ${key}=${Number(garbage.budget[key])}; Number('later') `
                + 'is NaN, and a NaN ceiling makes every run report configuration instead of performance');
        }
    }

    // ci.yml is checked as well as the runtime refusal, not instead of it. The refusal is what makes a
    // loose lever impossible; this makes the mistake visible in review, with a message naming the file to
    // edit, instead of surfacing as a red E2E job that reads like a performance regression.
    const ciWorkflow = exists('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : '';
    for (const lever of levers) {
        const key = String(lever.key);
        const committed = Number((editorBudget as any)[key]);
        const inWorkflow = new RegExp(String.raw`${lever.env}\s*:\s*['"]?(\d+(?:\.\d+)?)`).exec(ciWorkflow);
        if (inWorkflow && Number(inWorkflow[1]) > committed) {
            failures.push(`ci.yml sets ${lever.env}=${inWorkflow[1]}ms, looser than the committed `
                + `${key}=${committed}ms. Raise the budget in f0-performance-budgets.json where it is reviewed, `
                + 'not in a job variable — the spec would refuse to collect with that value anyway');
        }
    }

    // ── the spec, as the resolver's CONSUMER ─────────────────────────────────────────────────────
    const source = ts.createSourceFile(specPath, read(specPath), ts.ScriptTarget.Latest, true);
    const CEILING_MATCHERS = ['toBeLessThan', 'toBeLessThanOrEqual'];
    const initializers = new Map<string, any>();     // any `const X = <init>`
    const budgetObjects = new Set<string>();         // names bound to the object resolveVersoPerfBudget() returned
    const destructured = new Map<string, string>();  // `const { inputP95: x } = resolveVersoPerfBudget()`
    const ceilings: any[] = [];
    let importsResolver = false;

    const isResolverCall = (node: any): boolean => Boolean(node) && ts.isCallExpression(node)
        && ((ts.isIdentifier(node.expression) && node.expression.text === 'resolveVersoPerfBudget')
            || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolveVersoPerfBudget'));

    const visit = (node: any): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
            && /(^|[./])perf-budget(\.[jt]s)?$/.test(node.moduleSpecifier.text)) {
            importsResolver = true;
        }
        if (ts.isVariableDeclaration(node) && node.initializer) {
            if (ts.isIdentifier(node.name)) {
                // First declaration wins: the walk is in source order, so a later inner binding that
                // happens to reuse the name cannot mask an outer `const TTI_MS = 2500` from the trace.
                if (!initializers.has(node.name.text)) initializers.set(node.name.text, node.initializer);
                if (isResolverCall(node.initializer)) budgetObjects.add(node.name.text);
            } else if (ts.isObjectBindingPattern(node.name) && isResolverCall(node.initializer)) {
                for (const element of node.name.elements) {
                    if (!ts.isIdentifier(element.name)) continue;
                    const property = element.propertyName && ts.isIdentifier(element.propertyName)
                        ? element.propertyName.text
                        : element.name.text;
                    destructured.set(element.name.text, property);
                }
            }
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && CEILING_MATCHERS.includes(node.expression.name.text) && node.arguments.length === 1) {
            ceilings.push(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);

    /** Where does this ceiling come from: a budget key, a hardcoded number, or somewhere untraceable? */
    const originOf = (node: any, depth = 0): { key?: string; literal?: number } => {
        if (!node || depth > 4) return {};
        if (ts.isNumericLiteral(node)) return { literal: Number(node.text) };
        if (ts.isIdentifier(node)) {
            const property = destructured.get(node.text);
            if (property) return { key: property };
            return originOf(initializers.get(node.text), depth + 1);
        }
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
            && budgetObjects.has(node.expression.text)) {
            return { key: node.name.text };
        }
        return {};
    };

    if (!importsResolver) {
        failures.push(`${specPath} does not import ${resolverPath}; its ceilings would be its own numbers again`);
    }
    if (!ceilings.length) {
        failures.push(`${specPath} hands no ceiling to ${CEILING_MATCHERS.join('()/')}(), so it asserts no `
            + 'performance budget at all');
    }
    const consumed = new Set<string>();
    for (const ceiling of ceilings) {
        const spelled = ceiling.getText(source);
        const origin = originOf(ceiling);
        if (origin.literal !== undefined) {
            failures.push(`${specPath} gates on the hardcoded ceiling ${origin.literal} (written as `
                + `'${spelled}'); the number belongs in f0-performance-budgets.json#versoEditorMilliseconds, `
                + 'which resolveVersoPerfBudget() reads');
        } else if (!origin.key) {
            failures.push(`${specPath} gates on '${spelled}', which cannot be traced back to the budget `
                + 'resolveVersoPerfBudget() returned — a ceiling nobody can trace is a ceiling nobody reviews');
        } else if (!committedKeys.includes(origin.key)) {
            failures.push(`${specPath} gates on budget key '${origin.key}', which `
                + 'f0-performance-budgets.json#versoEditorMilliseconds does not define');
        } else {
            consumed.add(origin.key);
        }
    }
    for (const key of committedKeys) {
        if (!consumed.has(key)) {
            failures.push(`versoEditorMilliseconds.${key} is committed but no assertion in ${specPath} gates on `
                + 'it — a budget line nothing enforces');
        }
    }

    const specText = read(specPath);

    // ── The four ways an adversarial pass defeated everything above, each closed here ──────────────
    //
    // Tracing an assertion back to the budget proves PROVENANCE. It does not prove the assertion runs,
    // that the spec is collected at all, that the value was not overwritten between resolution and use,
    // or that the resolver reads only the levers it declares. Every one of those was demonstrated
    // green-while-broken before these checks existed.

    // 1. THE SPEC MUST STILL BE COLLECTED. `testMatch` in playwright.config.ts decides which files run;
    //    narrowing it to exclude perf.spec.ts left every check above satisfied and the spec simply
    //    absent from the run. The config's own pattern is applied to the spec's path here.
    const playwrightConfigPath = 'frontend/playwright.config.ts';
    if (!exists(playwrightConfigPath)) {
        failures.push(`${playwrightConfigPath} is missing, so nothing decides whether ${specPath} is collected`);
    } else {
        // EVERY project's testMatch is considered, not the first one found. The config declares several
        // projects (a `setup` that matches only global.setup.ts, then the suites), so keying on the first
        // literal made this gate fail against the setup project's pattern while saying nothing about the
        // one that actually collects the spec. The property is "SOME project collects it".
        const configSource = read(playwrightConfigPath);
        const patterns = [...configSource.matchAll(/testMatch\s*:\s*\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)/g)];
        if (!patterns.length) {
            failures.push(`${playwrightConfigPath} has no literal testMatch regex, so this gate cannot prove ${specPath} is collected`);
        } else {
            const collected = patterns.some((pattern) => {
                try { return new RegExp(pattern[1], pattern[2]).test('e2e/verso/perf.spec.ts'); }
                catch { return false; }
            });
            if (!collected) {
                failures.push(`no testMatch in ${playwrightConfigPath} selects ${specPath} (patterns: `
                    + `${patterns.map((pattern) => `/${pattern[1]}/`).join(', ')}), so the editor budget is enforced `
                    + 'by a file Playwright never runs');
            }
        }
    }

    // 2. THE ASSERTIONS MUST NOT BE SKIPPED. `test.skip()` as the first statement of the body leaves
    //    every assertion textually present and executes none of them.
    const skipCall = /\b(?:test|it)\s*\.\s*(?:skip|fixme)\b|\b(?:test|it)\s*\(\s*[^,]*,\s*\{[^}]*\bskip\s*:/.test(specText);
    if (skipCall) {
        failures.push(`${specPath} skips one of its own tests (test.skip / fixme / { skip }), so the ceilings it `
            + 'traces to the committed budget are never actually asserted');
    }

    // 3. THE RESOLVED BUDGET MUST NOT BE REWRITTEN. `BUDGET.timeToInteractive = 99999` after the call
    //    keeps provenance intact — the identifier still traces to a resolver result — while the value
    //    enforced is whatever was assigned.
    const budgetBinding = /const\s+([A-Za-z_$][\w$]*)\s*=\s*resolveVersoPerfBudget\s*\(/.exec(specText);
    if (budgetBinding) {
        const reassigned = new RegExp(String.raw`\b${budgetBinding[1]}\s*(?:\.\s*[\w$]+|\[[^\]]*\])\s*=[^=]`).test(specText);
        if (reassigned) {
            failures.push(`${specPath} assigns to a property of '${budgetBinding[1]}' after resolveVersoPerfBudget() `
                + 'returned it — the ceilings would trace to the committed budget and enforce something else');
        }
    }

    // 4. EVERY ENVIRONMENT READ MUST BE A DECLARED LEVER. The lever table is compared to the JSON keys
    //    above, which says nothing about which variables the resolver actually consults; an undeclared
    //    `process.env.X` is invisible to both that comparison and the ci.yml loosening check.
    //    The scan is over NAMES, not over the shape of the read. The resolver takes `env` as a parameter
    //    defaulting to process.env and indexes it through the lever table, so there are legitimately no
    //    `process.env.X` dot-accesses to find; keying on that spelling would have made this check pass by
    //    matching nothing, and would still miss `env['VERSO_PERF_X']`, a template, or a computed name.
    //    Any VERSO_PERF_* token appearing anywhere in the file must be a declared lever.
    const resolverSource = read('frontend/e2e/verso/perf-budget.ts');
    const declaredEnv = new Set(levers.map((lever: any) => String(lever && lever.env)).filter(Boolean));
    const mentioned = new Set(resolverSource.match(/\bVERSO_PERF_[A-Z0-9_]+\b/g) || []);
    for (const name of mentioned) {
        if (!declaredEnv.has(name)) {
            failures.push(`frontend/e2e/verso/perf-budget.ts names ${name}, which PERF_LEVERS does not declare — `
                + 'an undeclared lever is checked by neither the lever/budget comparison nor the ci.yml loosening gate');
        }
    }
    //    Positive control: PERF_LEVERS is compared to the JSON keys elsewhere, but if the lever table's
    //    env names never appeared in the file at all this scan would be looking at nothing.
    for (const name of declaredEnv) {
        if (!mentioned.has(name)) {
            failures.push(`PERF_LEVERS declares ${name} but frontend/e2e/verso/perf-budget.ts never mentions it, so `
                + 'the scan for undeclared levers is reading a file that does not contain the declared ones either');
        }
    }

    return failures;
}

/**
 * Every leg F6 claims to certify must be backed by a tracked file that something actually RUNS.
 *
 * "The evidence file exists" is the weak half; committed evidence nobody executes is how a suite goes
 * quietly dark. So each leg also names how it runs, and the claim is checked end to end: a suite leg
 * must be reachable by the glob `npm test` expands and CI must invoke that; a scripted leg must have
 * its script in backend/package.json AND a CI step invoking it by name; a workflow leg must be a
 * workflow with triggers and jobs. Delete the multi-node CI step and the multi-node leg goes red even
 * though its test file is still sitting in the tree.
 */
function checkCertificationMatrixHasEvidence(): CheckOutcome {
    const failures: string[] = [];
    const notes: string[] = [];
    const backendScripts = JSON.parse(read('backend/package.json')).scripts || {};
    const ci = read('.github/workflows/ci.yml');
    const suiteGlobIsRun = /src\/tests\/\*\.test\.ts/.test(String(backendScripts.test || ''));
    const suiteRunsInCi = /run:\s*npm test\b/.test(ci);
    if (!suiteGlobIsRun) failures.push('backend `npm test` no longer expands src/tests/*.test.ts, so committed evidence is not executed');
    if (!suiteRunsInCi) failures.push('no CI step runs the backend suite, so every suite-backed certification leg is unexecuted');

    for (const { leg, evidence, runBy } of CERTIFICATION_MATRIX) {
        if (!exists(evidence)) {
            failures.push(`certification leg "${leg}" claims evidence at ${evidence}, which does not exist`);
            continue;
        }
        if (runBy === 'backend-suite') {
            if (!/^backend\/src\/tests\/[^/]+\.test\.ts$/.test(evidence)) {
                failures.push(`"${leg}": ${evidence} claims the backend suite but the suite glob cannot reach it`);
            }
            continue;
        }
        if (runBy === 'workflow') {
            const workflow = read(evidence);
            if (!/^on:/m.test(workflow) || !/^jobs:/m.test(workflow)) {
                failures.push(`"${leg}": ${evidence} is not a workflow GitHub would run (no triggers or no jobs)`);
            }
            continue;
        }
        if ('workflow' in runBy) {
            if (!exists(runBy.workflow)) {
                failures.push(`"${leg}": the workflow that runs ${evidence} (${runBy.workflow}) does not exist`);
            } else if (!executedByRunStep(read(runBy.workflow), path.basename(evidence))) {
                failures.push(`"${leg}": ${runBy.workflow} does not hand ${path.basename(evidence)} to a runner in any run: step, `
                    + 'so the leg is committed but unexecuted (a mention in a shell variable or a comment is not evidence it runs)');
            }
            continue;
        }
        const command = String(backendScripts[runBy.script] || '');
        if (!command) failures.push(`"${leg}": backend/package.json has no ${runBy.script} script to run ${evidence}`);
        else if (!new RegExp(String.raw`npm run ${runBy.script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![:\w-])`).test(ci)) {
            failures.push(`"${leg}": ${runBy.script} exists but no CI step invokes it, so ${evidence} never runs`);
        }
    }
    notes.push(`${CERTIFICATION_MATRIX.length} certification legs, each with evidence a suite, script or workflow executes`);
    return { failures, notes };
}

/** ADR-0007 must carry the numbered invariants, in the heading form F1 through F5 use. */
function checkAdrInvariants(): CheckOutcome {
    const failures: string[] = [];
    const adrPath = 'documentation/adr/0007-f6-migration-certification.md';
    if (!exists(adrPath)) return { failures: [`missing ${adrPath}`] };
    const adr = read(adrPath);
    for (let invariant = 1; invariant <= 10; invariant++) {
        const id = `F6-INV-${String(invariant).padStart(2, '0')}`;
        if (!new RegExp(`^### ${id}\\b`, 'm').test(adr)) failures.push(`ADR-0007 missing ${id}`);
    }
    // The rollout is the decision F6 records; an ADR that does not name its stages cannot be audited
    // against them. Each stage must appear as its own numbered list item.
    for (let stage = 1; stage <= 7; stage++) {
        if (!new RegExp(`^${stage}\\.\\s+\\S`, 'm').test(adr)) failures.push(`ADR-0007 does not describe rollout stage ${stage}`);
    }
    return { failures };
}

/** The phase's own artefacts must exist and be runnable, or F6 is a document rather than a gate. */
function checkPhaseArtefactsAreWired(): CheckOutcome {
    const failures: string[] = [];
    const artefacts = [
        'documentation/adr/0007-f6-migration-certification.md',
        'backend/scripts/verify-f6-migration.ts',
        'backend/src/tests/f6-final-criteria.test.ts',
    ];
    for (const artefact of artefacts) if (!exists(artefact)) failures.push(`F6 artefact missing: ${artefact}`);

    const backendScripts = JSON.parse(read('backend/package.json')).scripts || {};
    const rootScripts = JSON.parse(read('package.json')).scripts || {};
    if (!backendScripts['verify:f6']) failures.push('backend/package.json has no verify:f6 script');
    else if (!backendScripts['verify:f6'].includes('verify-f6-migration')) failures.push('backend verify:f6 does not run this gate');
    if (!rootScripts['verify:f6']) failures.push('root package.json has no verify:f6 script');
    for (let phase = 0; phase <= 6; phase++) {
        if (!rootScripts[`verify:f${phase}`]) failures.push(`root package.json lost verify:f${phase}; the phase ladder is incomplete`);
    }

    // A gate nothing runs is documentation. F6's verdict reaches CI by two independent routes and at
    // least one of them must exist: an explicit `npm run verify:f6` step, or the evidence test — which
    // asserts this gate reports no failures — being reachable by the suite glob that CI executes.
    const notes: string[] = [];
    const workflows = walk(path.join(REPO_ROOT, '.github', 'workflows'), (f) => /\.ya?ml$/.test(f));
    const explicitStep = workflows.some((file) => /npm run verify:f6(?![:\w-])/.test(fs.readFileSync(file, 'utf8')));
    const suiteGlobReachesEvidence = /src\/tests\/\*\.test\.ts/.test(String(backendScripts.test || ''))
        && exists('backend/src/tests/f6-final-criteria.test.ts');
    const suiteRunsInCi = /run:\s*npm test\b/.test(read('.github/workflows/ci.yml'));
    if (!explicitStep && !(suiteGlobReachesEvidence && suiteRunsInCi)) {
        failures.push('nothing in CI reaches this gate: no workflow runs `npm run verify:f6` and the evidence '
            + 'test that asserts its verdict is not reachable by a suite CI executes');
    }
    if (!explicitStep) {
        notes.push('this gate reaches CI only through backend/src/tests/f6-final-criteria.test.ts in the backend '
            + 'suite. Add an explicit `npm run verify:f6` step beside the F0-F5 gate steps in ci.yml, and add '
            + 'backend/scripts/verify-f6-migration.ts plus that test to the "Gates that travel" manifest, so an '
            + 'uncommitted F6 file fails as a missing gate rather than as a broken suite.');
    }
    return { failures, notes };
}

const CHECKS: Check[] = [
    { id: 'F6-C01', title: 'request-typing debt may not rise', run: checkRequestTypingRatchet },
    { id: 'F6-C02', title: 'migrated handlers stay typed', run: checkMigratedHandlersAreFullyTyped },
    { id: 'F6-C03', title: 'built-in types declare 100% of their fields', run: checkBuiltinFieldCompleteness },
    { id: 'F6-C04', title: 'zero divergence between the visual contracts', run: checkVisualContractHasNoDivergence },
    { id: 'F6-C05', title: 'legacy plugins have compatibility coverage', run: checkLegacyPluginCompatibilityCoverage },
    { id: 'F6-C06', title: 'the sandbox fails closed on every platform it claims', run: checkSandboxFailsClosed },
    { id: 'F6-C07', title: 'every database driver is certified', run: checkEveryDriverIsCertified },
    { id: 'F6-C08', title: 'the F0 performance budget covers every measurement', run: checkPerformanceBudgetIsComplete },
    { id: 'F6-C09', title: 'every certification leg has running evidence', run: checkCertificationMatrixHasEvidence },
    { id: 'F6-C10', title: 'ADR-0007 records invariants and the rollout', run: checkAdrInvariants },
    { id: 'F6-C11', title: 'the F6 gate itself is wired into the phase ladder', run: checkPhaseArtefactsAreWired },
];

interface F6VerificationResult {
    ok: boolean;
    failures: string[];
    notes: string[];
    results: Array<{ id: string; title: string; failures: string[]; notes: string[] }>;
}

/**
 * Run every check. No check can prevent another from running: a check that throws contributes its
 * exception as a failure line and the run continues.
 */
function verify(): F6VerificationResult {
    const results = CHECKS.map((check) => {
        try {
            const outcome = check.run();
            return { id: check.id, title: check.title, failures: outcome.failures || [], notes: outcome.notes || [] };
        } catch (error: any) {
            return {
                id: check.id,
                title: check.title,
                failures: [`the check itself threw: ${error && error.stack ? error.stack.split('\n')[0] : error}`],
                notes: [],
            };
        }
    });
    const failures = results.flatMap((result) => result.failures.map((failure) => `[${result.id}] ${failure}`));
    const notes = results.flatMap((result) => result.notes.map((note) => `[${result.id}] ${note}`));
    return { ok: failures.length === 0, failures, notes, results };
}

if (require.main === module) {
    const result = verify();
    const printOnly = process.argv.includes('--print');
    for (const note of result.notes) console.log(`note: ${note}`);
    if (!result.ok && !printOnly) {
        console.error(`F6 migration/certification gate failed (${result.failures.length} findings across `
            + `${result.results.filter((entry) => entry.failures.length).length} of ${CHECKS.length} checks):`);
        result.failures.forEach((failure) => console.error(`  - ${failure}`));
        process.exitCode = 1;
    } else if (!result.ok) {
        console.log(`--print: ${result.failures.length} findings suppressed`);
        result.failures.forEach((failure) => console.log(`  - ${failure}`));
    } else {
        console.log(`F6 verified across ${CHECKS.length} checks: typing ratchet holding, built-in fields complete, `
            // This line used to say "named by a test", because that was all F6-C05 could prove: a slug
            // appearing in test source. It now says what the check actually runs — every plugin's manifest,
            // entry load and init() exercised by f6-plugin-compatibility.test.ts — and it still stops
            // there. It does NOT claim the plugins' behaviour is tested: no HTTP handler, no database
            // query and no rendered block is asserted anywhere, and a green line that implied otherwise is
            // the sentence a future reader would quote as proof of testing nobody wrote. It reads the
            // ratchet's own constants, so it cannot drift into overstating them.
            + `visual contract undivided, plugin compatibility ratchet holding (${MIN_COVERED_MARKETPLACE_PLUGINS} of `
            + `${MIN_COVERED_MARKETPLACE_PLUGINS + MAX_UNCOVERED_MARKETPLACE_PLUGINS} marketplace plugins load and `
            + 'boot under their own manifest), '
            + 'sandbox fail-closed, every driver certified, '
            + 'every budgeted measurement bounded and every certification leg backed by running evidence.');
    }
}

module.exports = {
    verify,
    CHECKS,
    CERTIFICATION_MATRIX,
    // Pure seams the F6 evidence test drives with synthetic inputs, so "adding a member turns it red"
    // can be demonstrated in-process instead of by editing the tree and remembering to put it back.
    classifyBoundarySource,
    budgetCoverageFailures,
    RATCHETS: {
        MAX_REQUEST_ANY_OCCURRENCES,
        MAX_UNTYPED_BOUNDARY_FILES,
        MIN_FULLY_TYPED_BOUNDARY_FILES,
        MIN_COVERED_MARKETPLACE_PLUGINS,
        MAX_UNCOVERED_MARKETPLACE_PLUGINS,
    },
};

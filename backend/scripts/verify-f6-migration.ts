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
const MAX_REQUEST_ANY_OCCURRENCES = 143;
/** Boundary files that still contain at least one `req: any`. A brand-new untyped route file raises it. */
const MAX_UNTYPED_BOUNDARY_FILES = 24;
/** Boundary files that are FULLY migrated: at least one typed `req` and not one `req: any` left. */
const MIN_FULLY_TYPED_BOUNDARY_FILES = 19;
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
 * Marketplace plugins named by at least one backend test — the legacy-compatibility coverage floor.
 *
 * This read 9/22 while the search included comments. Five of those nine were slugs appearing only in
 * prose or in a packaging path, never in a line of test code, so the recorded floor was flattering the
 * state of the world by more than a factor of two. 4/27 is what is actually true today.
 *
 * These are ratchet bounds, not a target: the floor may only rise and the ceiling may only fall. The
 * point of writing down the unflattering number is that the next person to add a plugin has to move
 * one of them, in a diff someone reads.
 */
const MIN_COVERED_MARKETPLACE_PLUGINS = 4;
/** Marketplace plugins no backend test mentions. A plugin added without a compatibility test raises it. */
const MAX_UNCOVERED_MARKETPLACE_PLUGINS = 27;

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
 * Legacy plugins must be covered by compatibility tests.
 *
 * The population is every plugin that actually ships in the marketplace, read off disk. "Covered" means
 * a backend test names the plugin's slug — that is what makes a plugin's behaviour a thing CI defends
 * rather than a thing a refactor discovers. Adding a plugin directory without a test raises the
 * uncovered count and turns this red; deleting a plugin's test lowers the covered count and does the
 * same. Neither number can be satisfied by editing a list in this file.
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
    // COMMENTS ARE NOT COVERAGE.
    //
    // This searched the raw concatenation of every backend test source, so a slug named in a `//`
    // line, a doc block or a prose sentence counted exactly as much as a slug the test loads. Both
    // directions were wrong: adding `// TODO: add compatibility coverage for <slug>` would have marked
    // an untested plugin covered for ever, and rewording a comment could turn the ratchet red without
    // any test changing. Stripping comments first does not make this a proof that the plugin is
    // exercised — it is still a mention — but it is now a mention in CODE.
    const testSources = walk(path.join(BACKEND_ROOT, 'src', 'tests'), (f) => f.endsWith('.ts'))
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, ' ')
        .replace(/([^:])\/\/.*$/gm, '$1');
    const covered = slugs.filter((slug) => new RegExp(String.raw`(?<![A-Za-z0-9-])${slug}(?![A-Za-z0-9-])`).test(testSources));
    const uncovered = slugs.filter((slug) => !covered.includes(slug));

    if (covered.length < MIN_COVERED_MARKETPLACE_PLUGINS) {
        failures.push(`only ${covered.length} of ${slugs.length} marketplace plugins are named by a backend test `
            + `(floor ${MIN_COVERED_MARKETPLACE_PLUGINS}); a plugin lost its compatibility coverage. Covered: ${covered.join(', ')}`);
    } else if (covered.length > MIN_COVERED_MARKETPLACE_PLUGINS) {
        notes.push(`${covered.length} plugins are covered; raise MIN_COVERED_MARKETPLACE_PLUGINS to ${covered.length}.`);
    }
    if (uncovered.length > MAX_UNCOVERED_MARKETPLACE_PLUGINS) {
        failures.push(`${uncovered.length} marketplace plugins have no backend test naming them `
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
        const values = Object.values(budgets[section] || {});
        if (!values.length) failures.push(`f0-performance-budgets.json has no ${section} ceilings`);
        if (values.some((value) => !Number.isFinite(Number(value)))) failures.push(`${section} contains a non-numeric ceiling`);
    }

    // GIVE `versoEditorMilliseconds` A CONSUMER.
    //
    // It was a committed budget nobody read. The same three numbers live a second time as literals in
    // frontend/e2e/verso/perf.spec.ts, and only those literals decide anything — so the committed file
    // looked like a guarantee while being decorative, and the two copies were free to drift apart with
    // nothing to notice. The spec is not edited from here (it runs under Playwright against a built
    // site, which this gate cannot execute and therefore must not silently rewrite); instead the two
    // copies are PINNED to each other, so changing one without the other is red.
    //
    // The env levers are checked in the loosening direction only. ci.yml states the intention to
    // calibrate them on the real runner, and raising a threshold there would quietly make the
    // committed budget meaningless — that has to be a visible edit to the budget, not a job variable.
    const editorBudget = budgets.versoEditorMilliseconds || {};
    const specPath = 'frontend/e2e/verso/perf.spec.ts';
    if (!exists(specPath)) {
        failures.push(`${specPath} is missing, so nothing consumes versoEditorMilliseconds and the committed editor budget enforces nothing`);
    } else {
        const spec = read(specPath);
        const levers: Array<[string, string]> = [
            ['inputP95', 'VERSO_PERF_INPUT_P95_MS'],
            ['transactionP95', 'VERSO_PERF_TRANSACT_P95_MS'],
            ['timeToInteractive', 'VERSO_PERF_TTI_MS'],
        ];
        for (const [key, lever] of levers) {
            const committed = Number(editorBudget[key]);
            const declared = new RegExp(String.raw`process\.env\.${lever}\s*\?\?\s*(\d+(?:\.\d+)?)`).exec(spec);
            if (!declared) {
                failures.push(`${specPath} no longer defaults ${lever} to a literal, so f0-performance-budgets.json#versoEditorMilliseconds.${key} cannot be pinned to what the spec enforces`);
            } else if (Number(declared[1]) !== committed) {
                failures.push(`${specPath} enforces ${lever}=${declared[1]}ms while f0-performance-budgets.json commits ${key}=${committed}ms — the budget and the only thing that reads it disagree`);
            }
        }
        const ciWorkflow = exists('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : '';
        for (const [key, lever] of levers) {
            const committed = Number(editorBudget[key]);
            const inWorkflow = new RegExp(String.raw`${lever}\s*:\s*['"]?(\d+(?:\.\d+)?)`).exec(ciWorkflow);
            if (inWorkflow && Number(inWorkflow[1]) > committed) {
                failures.push(`ci.yml sets ${lever}=${inWorkflow[1]}ms, looser than the committed ${key}=${committed}ms. Raise the budget in f0-performance-budgets.json where it is reviewed, not in a job variable`);
            }
        }
    }

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
            // NOT "legacy plugins covered". F6-C05 is a coverage RATCHET: it asserts that a plugin slug is
            // NAMED by some backend test, which today holds for a minority of the marketplace. A green line
            // claiming they are "covered" is the sentence a future reader quotes as proof of compatibility
            // testing that was never written. The line says what the check proves, and no more — and it
            // reads the ratchet's own constants, so it can never drift into overstating them again.
            + `visual contract undivided, plugin coverage ratchet holding (${MIN_COVERED_MARKETPLACE_PLUGINS} of `
            + `${MIN_COVERED_MARKETPLACE_PLUGINS + MAX_UNCOVERED_MARKETPLACE_PLUGINS} named by a test), `
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

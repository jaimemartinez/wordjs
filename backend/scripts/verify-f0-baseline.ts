/**
 * F0 architecture baseline gate.
 *
 * This intentionally records surfaces, not implementation formatting:
 *   - Express route declarations (including unannotated routes)
 *   - the semantic OpenAPI contract (documentation prose removed)
 *   - explicit request-boundary `any` debt
 *   - the serialisable plugin bridge ABI
 *   - the real-OS sandbox workflow and performance budgets
 *
 * Run from backend/: npm run verify:f0
 * Print the current snapshot while intentionally updating the contract:
 *   node -r ts-node/register scripts/verify-f0-baseline.ts --print
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ts = require('typescript');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const BASELINE_PATH = path.join(BACKEND_ROOT, 'f0-baseline.json');
const BUDGETS_PATH = path.join(BACKEND_ROOT, 'f0-performance-budgets.json');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const ROUTER_METHODS = new Set([...HTTP_METHODS, 'use']);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value: any): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
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

function receiverName(node: any): string | null {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    return null;
}

function pathValues(node: any, source: any): string[] {
    if (!node) return ['<middleware>'];
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isArrayLiteralExpression(node)) {
        const values = node.elements.flatMap((element: any) => pathValues(element, source));
        return values.length ? values : ['<empty-array>'];
    }
    const text = node.getText(source).replace(/\s+/g, ' ').trim();
    return [`<dynamic:${text}>`];
}

function routeInventory(): Array<{ file: string; receiver: string; method: string; path: string }> {
    const routeDir = path.join(BACKEND_ROOT, 'src', 'routes');
    const files = [...walk(routeDir, (f) => f.endsWith('.ts')), path.join(BACKEND_ROOT, 'src', 'index.ts')];
    const routes: Array<{ file: string; receiver: string; method: string; path: string }> = [];

    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const visit = (node: any): void => {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const method = node.expression.name.text.toLowerCase();
                const receiver = receiverName(node.expression.expression);
                if (receiver && /(?:^app$|router$)/i.test(receiver) && ROUTER_METHODS.has(method)) {
                    for (const routePath of pathValues(node.arguments[0], source)) {
                        routes.push({ file: relative(file), receiver, method, path: routePath });
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return routes.sort((a, b) => stable(a).localeCompare(stable(b)));
}

function stripDocumentation(value: any): Json {
    if (Array.isArray(value)) return value.map(stripDocumentation);
    if (!value || typeof value !== 'object') return value as Json;
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
        if (['description', 'summary', 'externalDocs', 'tags'].includes(key)) continue;
        out[key] = stripDocumentation(value[key]);
    }
    return out;
}

function countPattern(files: string[], pattern: RegExp): { occurrences: number; files: number } {
    let occurrences = 0;
    let touched = 0;
    for (const file of files) {
        const matches = fs.readFileSync(file, 'utf8').match(pattern) || [];
        if (matches.length) touched++;
        occurrences += matches.length;
    }
    return { occurrences, files: touched };
}

function pluginBridge(): { exportedSymbols: string[]; semanticSha256: string } {
    const file = path.join(BACKEND_ROOT, 'types', 'wordjs-bridge.d.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const exportedSymbols: string[] = [];
    for (const statement of source.statements) {
        const modifiers = statement.modifiers || [];
        const exported = modifiers.some((modifier: any) => modifier.kind === ts.SyntaxKind.ExportKeyword);
        if (exported && statement.name && statement.name.text) exportedSymbols.push(statement.name.text);
    }
    const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
    return {
        exportedSymbols: exportedSymbols.sort(),
        semanticSha256: sha256(printer.printFile(source).replace(/\s+/g, ' ').trim()),
    };
}

function semanticFileHash(file: string): string {
    const normalized = fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+#.*$/, '').trim())
        .filter(Boolean)
        .join('\n');
    return sha256(normalized);
}

function collectSnapshot(): any {
    const routes = routeInventory();
    const endpoints = routes.filter((route) => HTTP_METHODS.has(route.method));
    const mounts = routes.filter((route) => route.method === 'use');
    const boundaryFiles = [
        ...walk(path.join(BACKEND_ROOT, 'src', 'routes'), (f) => f.endsWith('.ts')),
        ...walk(path.join(BACKEND_ROOT, 'src', 'middleware'), (f) => f.endsWith('.ts')),
    ];
    const swagger = require(path.join(BACKEND_ROOT, 'src', 'config', 'swagger'));
    const semanticPaths = stripDocumentation(swagger.paths || {});
    const swaggerPaths = Object.keys(swagger.paths || {});
    let swaggerOperations = 0;
    for (const routePath of swaggerPaths) {
        for (const method of Object.keys(swagger.paths[routePath] || {})) {
            if (HTTP_METHODS.has(method.toLowerCase())) swaggerOperations++;
        }
    }
    const backendTests = walk(path.join(BACKEND_ROOT, 'src'), (f) => /(?:^|[\\/])[^\\/]+\.test\.ts$/.test(f));
    const frontendTests = walk(path.join(REPO_ROOT, 'frontend', 'src'), (f) => /\.(?:test|spec)\.(?:ts|tsx)$/.test(f));

    return {
        restSource: {
            routeFiles: walk(path.join(BACKEND_ROOT, 'src', 'routes'), (f) => f.endsWith('.ts')).length,
            endpointDeclarations: endpoints.length,
            mountDeclarations: mounts.length,
            semanticSha256: sha256(stable(routes)),
        },
        openapi: {
            paths: swaggerPaths.length,
            operations: swaggerOperations,
            semanticSha256: sha256(stable(semanticPaths)),
        },
        typingDebt: {
            requestAny: countPattern(boundaryFiles, /\breq\s*:\s*any\b/g),
            responseAny: countPattern(boundaryFiles, /\bres\s*:\s*any\b/g),
        },
        pluginBridge: pluginBridge(),
        verificationSurface: {
            backendTestFiles: backendTests.length,
            frontendTestFiles: frontendTests.length,
            sandboxWorkflowSemanticSha256: semanticFileHash(path.join(REPO_ROOT, '.github', 'workflows', 'sandbox-parity.yml')),
            performanceBudgetsSha256: semanticFileHash(BUDGETS_PATH),
        },
    };
}

function diff(expected: any, actual: any, prefix = ''): string[] {
    if (stable(expected) === stable(actual)) return [];
    if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object' || Array.isArray(expected) || Array.isArray(actual)) {
        return [`${prefix || '<root>'}: expected ${stable(expected)}, got ${stable(actual)}`];
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].sort().flatMap((key) => diff(expected[key], actual[key], prefix ? `${prefix}.${key}` : key));
}

/** The operation ids the F6 harness actually measures, read from its OPERATIONS map rather than grepped. */
function harnessOperationIds(file: string): string[] | null {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let ids: string[] | null = null;
    const visit = (node: any): void => {
        if (ts.isVariableDeclaration(node) && node.name && node.name.text === 'OPERATIONS') {
            let initializer = node.initializer;
            while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))) {
                initializer = initializer.expression;
            }
            if (initializer && ts.isObjectLiteralExpression(initializer)) {
                ids = initializer.properties
                    .map((property: any) => (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null))
                    .filter((name: string | null): name is string => Boolean(name));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return ids;
}

/**
 * F6 performance budget — the STRUCTURAL half of "no regression beyond the budget defined in F0".
 *
 * F0 shipped ceilings in absolute milliseconds and nothing that checked they were still meaningful. Two
 * failure modes follow, and both have shipped in this repository before:
 *
 *   - A ceiling nothing can reach. `f0-performance-budgets.json` puts postCreateP95 at 20ms while the
 *     calibration host measures 7ms, so a change that made creation two and a half times slower would
 *     have passed. The margin window below makes "raise the number until it goes green" impossible
 *     without also re-recording the observation that justified it.
 *   - A budget table walked in one direction only. `f0-content-bench.ts --enforce` iterates the budget
 *     entries and looks each one up in the measurements, so a NEW operation nobody wrote a ceiling for is
 *     measured and silently unenforced. Rendering — one of the four operations F6 must certify — is
 *     exactly that case in the F0 file. Here the operation set and the harness that measures it are
 *     compared both ways, so adding an operation to either side without the other fails.
 *
 * This function never measures anything: timing belongs in backend/src/tests/f6-performance-budget.test.ts,
 * which runs in `npm test`. What it guarantees is that the budget is complete, internally consistent,
 * still descended from F0's ceilings, and still wired to a gate that executes it.
 */
function verifyPerformanceBudget(baseline: any): string[] {
    const problems: string[] = [];
    const budget = baseline && baseline.performanceBudget;
    if (!budget) {
        return ['performanceBudget: missing — F6 cannot certify "within the budget defined in F0" when no budget exists'];
    }
    if (budget.schemaVersion !== 1) problems.push(`performanceBudget.schemaVersion: expected 1, got ${stable(budget.schemaVersion)}`);

    const positive = (value: any) => typeof value === 'number' && Number.isFinite(value) && value > 0;
    const method = budget.methodology || {};
    for (const key of ['warmupIterations', 'operationSamples', 'referenceSamples']) {
        if (!positive(method[key]) || !Number.isInteger(method[key])) problems.push(`performanceBudget.methodology.${key}: expected a positive integer, got ${stable(method[key])}`);
    }
    if (!(typeof method.trimFraction === 'number' && method.trimFraction >= 0 && method.trimFraction < 0.25)) {
        problems.push(`performanceBudget.methodology.trimFraction: expected [0, 0.25), got ${stable(method.trimFraction)}`);
    }
    const margin = Array.isArray(method.ceilingMarginRange) ? method.ceilingMarginRange : [];
    if (margin.length !== 2 || !positive(margin[0]) || !positive(margin[1]) || margin[0] <= 1 || margin[1] <= margin[0]) {
        problems.push(`performanceBudget.methodology.ceilingMarginRange: expected [low>1, high>low], got ${stable(method.ceilingMarginRange)}`);
    }
    const planOperations: string[] = Array.isArray(method.planOperations) ? method.planOperations : [];
    if (!planOperations.length) problems.push('performanceBudget.methodology.planOperations: the F6 plan names creation, update, query and render — the list may not be empty');

    const reference = budget.reference || {};
    for (const key of ['observedMillisecondsTrimmedMean', 'minimumMillisecondsTrimmedMean', 'maximumMillisecondsTrimmedMean']) {
        if (!positive(reference[key])) problems.push(`performanceBudget.reference.${key}: expected a positive number, got ${stable(reference[key])}`);
    }
    if (positive(reference.minimumMillisecondsTrimmedMean) && positive(reference.maximumMillisecondsTrimmedMean) && positive(reference.observedMillisecondsTrimmedMean)) {
        if (!(reference.minimumMillisecondsTrimmedMean < reference.observedMillisecondsTrimmedMean && reference.observedMillisecondsTrimmedMean < reference.maximumMillisecondsTrimmedMean)) {
            problems.push('performanceBudget.reference: the recorded observation must sit strictly inside its own bounds, otherwise the denominator gate is red or vacuous from the first run');
        }
    }

    const budgets = fs.existsSync(BUDGETS_PATH) ? JSON.parse(fs.readFileSync(BUDGETS_PATH, 'utf8')) : { contentMilliseconds: {} };
    const operations = budget.operations || {};
    const operationIds = Object.keys(operations);
    if (!operationIds.length) problems.push('performanceBudget.operations: empty — a budget with no operations passes everything');

    const covered: string[] = [];
    for (const id of operationIds) {
        const spec = operations[id] || {};
        covered.push(spec.planOperation);
        if (!planOperations.includes(spec.planOperation)) {
            problems.push(`performanceBudget.operations.${id}.planOperation: ${stable(spec.planOperation)} is not one of ${stable(planOperations)}`);
        }
        if (typeof spec.callSite !== 'string' || !spec.callSite.trim()) {
            problems.push(`performanceBudget.operations.${id}.callSite: a budget that does not name the call it measures cannot be checked against the harness`);
        }
        // Number.isFinite on the RAW value: Number(null) is 0 and would pass a coercing check, which is
        // how an uncalibrated ceiling reads as a valid one.
        if (!positive(spec.observedRatioToReference)) problems.push(`performanceBudget.operations.${id}.observedRatioToReference: no recorded measurement justifies the ceiling`);
        if (!positive(spec.maximumRatioToReference)) problems.push(`performanceBudget.operations.${id}.maximumRatioToReference: expected a positive number, got ${stable(spec.maximumRatioToReference)}`);
        if (positive(spec.observedRatioToReference) && positive(spec.maximumRatioToReference) && margin.length === 2) {
            const factor = spec.maximumRatioToReference / spec.observedRatioToReference;
            if (factor < margin[0]) problems.push(`performanceBudget.operations.${id}: ceiling is ${factor.toFixed(2)}x the recorded observation, under the ${margin[0]}x floor — it will flap on a loaded host and be disabled`);
            if (factor > margin[1]) problems.push(`performanceBudget.operations.${id}: ceiling is ${factor.toFixed(2)}x the recorded observation, over the ${margin[1]}x cap — a threshold nothing can fail is the same defect as no threshold`);
        }
        if (!positive(spec.maximumMillisecondsP95)) problems.push(`performanceBudget.operations.${id}.maximumMillisecondsP95: the secondary catastrophe ceiling is missing`);
        if (!positive(spec.observedMillisecondsP95)) problems.push(`performanceBudget.operations.${id}.observedMillisecondsP95: no recorded absolute measurement`);
        if (positive(spec.maximumMillisecondsP95) && positive(spec.observedMillisecondsP95) && spec.maximumMillisecondsP95 <= spec.observedMillisecondsP95) {
            problems.push(`performanceBudget.operations.${id}: the absolute ceiling is at or below the value already measured, so it is red on arrival`);
        }
        // THE KEY MUST BE DECLARED, not merely valid when present.
        //
        // All three gates that enforce "F6 may not loosen a committed F0 ceiling" used to skip an
        // operation whose `f0BudgetKey` was absent — and nothing required it to be there. So deleting
        // one line from f0-baseline.json disabled the rule for that operation everywhere at once, and
        // every gate still printed green. Verified by deleting `"f0BudgetKey": "postUpdateP95"` and
        // raising that operation's ceiling to 99999: all three passed.
        //
        // `null` stays legal because one operation genuinely has no F0 ancestor (rendering was never
        // budgeted by F0), but it now costs a written `note`. Absent is not the same as "considered and
        // there is none", and only the second one is a decision.
        if (!Object.prototype.hasOwnProperty.call(spec, 'f0BudgetKey')) {
            problems.push(`performanceBudget.operations.${id}.f0BudgetKey: absent. Declare which F0 ceiling this operation inherits, or null plus a note saying why none exists — an absent key silently switches off the rule that F6 may not loosen an F0 ceiling`);
        } else if (spec.f0BudgetKey === null && !(typeof spec.note === 'string' && spec.note.trim())) {
            problems.push(`performanceBudget.operations.${id}: f0BudgetKey is null with no note. Say why this operation has no F0 ancestor, so "there is no ceiling to inherit" stays a recorded decision rather than an omission`);
        }
        if (spec.f0BudgetKey !== null && spec.f0BudgetKey !== undefined) {
            const inherited = (budgets.contentMilliseconds || {})[spec.f0BudgetKey];
            if (!positive(inherited)) {
                problems.push(`performanceBudget.operations.${id}.f0BudgetKey: ${stable(spec.f0BudgetKey)} does not exist in ${relative(BUDGETS_PATH)}`);
            } else if (positive(spec.maximumMillisecondsP95) && spec.maximumMillisecondsP95 > inherited) {
                problems.push(`performanceBudget.operations.${id}: F6 ceiling ${spec.maximumMillisecondsP95}ms is looser than the F0 ceiling ${inherited}ms it inherits — F6 does not get to quietly raise a committed budget`);
            }
        }
    }
    const missingPlan = planOperations.filter((name) => !covered.includes(name));
    if (missingPlan.length) problems.push(`performanceBudget.operations: the F6 plan operations ${stable(missingPlan)} have no budgeted operation`);
    const duplicated = covered.filter((name, index) => covered.indexOf(name) !== index);
    if (duplicated.length) problems.push(`performanceBudget.operations: ${stable([...new Set(duplicated)])} is covered by more than one operation, so "the plan operation is budgeted" no longer identifies which measurement enforces it`);

    const http = budget.httpSteadyState || {};
    if (!http.reference || typeof http.reference.path !== 'string' || !http.reference.path.trim()) {
        problems.push('performanceBudget.httpSteadyState.reference.path: the HTTP ratios need a same-run denominator');
    }
    const roles = http.roles || {};
    if (!Object.keys(roles).length) problems.push('performanceBudget.httpSteadyState.roles: empty — perf-bench would enforce nothing');
    for (const [role, spec] of Object.entries<any>(roles)) {
        if (typeof spec.path !== 'string' || !spec.path.trim()) problems.push(`performanceBudget.httpSteadyState.roles.${role}.path: missing`);
        if (typeof spec.required !== 'boolean') problems.push(`performanceBudget.httpSteadyState.roles.${role}.required: expected a boolean, got ${stable(spec.required)} — an ambiguous "required" is how a target quietly stops being exercised`);
        const uncalibrated = spec.observedRatioToReference === null && spec.maximumRatioToReference === null;
        const calibrated = positive(spec.observedRatioToReference) && positive(spec.maximumRatioToReference);
        if (!uncalibrated && !calibrated) {
            problems.push(`performanceBudget.httpSteadyState.roles.${role}: ratio pair must be BOTH null (uncalibrated, and perf-bench --enforce fails closed) or BOTH positive numbers — a half-filled pair silently disables the check`);
        }
        if (calibrated && margin.length === 2) {
            const factor = spec.maximumRatioToReference / spec.observedRatioToReference;
            if (factor < margin[0] || factor > margin[1]) {
                problems.push(`performanceBudget.httpSteadyState.roles.${role}: ceiling is ${factor.toFixed(2)}x the recorded observation, outside the ${stable(margin)} window`);
            }
        }
    }

    // The budget must stay wired to something that EXECUTES it. Deleting the test, or renaming an
    // operation without touching the harness, has to be a red gate rather than a budget that is merely
    // described. This mirrors the F5 gate's `check(tests.includes(...))` for the same reason.
    const testPath = path.join(BACKEND_ROOT, 'src', 'tests', 'f6-performance-budget.test.ts');
    if (!fs.existsSync(testPath)) {
        problems.push(`${relative(testPath)}: missing — the performance budget would be documented but never evaluated`);
    } else {
        // Read the harness's OPERATIONS map through the AST, not with a substring search. The first
        // version of this check asked whether the test file CONTAINED the operation id, and an id that
        // only appears inside a negative control ("contentDelete: measured but has no budget") satisfied
        // it — the gate would have reported a budgeted operation as measured when nothing measures it.
        // Comparing the two SETS is also what makes the direction f0-content-bench.ts is missing work:
        // an operation added to the harness with no ceiling fails here too.
        const harness = harnessOperationIds(testPath);
        if (!harness) {
            problems.push(`${relative(testPath)}: no OPERATIONS map found — the budget has no harness to enforce it`);
        } else {
            for (const id of operationIds.filter((id) => !harness.includes(id))) {
                problems.push(`performanceBudget.operations.${id}: not measured by the OPERATIONS map in ${relative(testPath)} — a budgeted operation nothing measures is dead text`);
            }
            for (const id of harness.filter((id) => !operationIds.includes(id))) {
                problems.push(`${relative(testPath)}: measures ${stable(id)}, which has no ceiling in performanceBudget.operations — an unbudgeted measurement is unenforced, and that is exactly the hole in f0-content-bench.ts`);
            }
        }
        const test = fs.readFileSync(testPath, 'utf8');
        if (!test.includes('f0-baseline.json')) problems.push(`${relative(testPath)}: does not read the committed budget, so it is enforcing a second copy of the numbers`);
    }
    const benchPath = path.join(REPO_ROOT, 'scripts', 'perf-bench.mjs');
    if (!fs.existsSync(benchPath)) {
        problems.push(`${relative(benchPath)}: missing — the HTTP half of the budget has no enforcer`);
    } else {
        const bench = fs.readFileSync(benchPath, 'utf8');
        if (!/export function evaluateHttpRun/.test(bench)) problems.push(`${relative(benchPath)}: no exported evaluateHttpRun, so nothing can prove the HTTP gate turns red`);
        if (!bench.includes('f0-baseline.json')) problems.push(`${relative(benchPath)}: does not consume the committed budget — it invented a second mechanism`);
    }
    return problems;
}

function verify(): { ok: boolean; current: any; differences: string[] } {
    if (!fs.existsSync(BASELINE_PATH)) {
        return { ok: false, current: collectSnapshot(), differences: [`missing ${relative(BASELINE_PATH)}`] };
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const current = collectSnapshot();
    const differences = [...diff(baseline.snapshot, current), ...verifyPerformanceBudget(baseline)];
    return { ok: differences.length === 0, current, differences };
}

if (require.main === module) {
    const result = verify();
    if (process.argv.includes('--print')) {
        // Carries the F6 performance budget through verbatim. `--print > f0-baseline.json` is the
        // documented way to accept an intentional snapshot change, and printing only the snapshot would
        // have deleted the budget block as a side effect of an unrelated route rename.
        const existing = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : {};
        const printed: any = { schemaVersion: 1, snapshot: result.current };
        if (existing.performanceBudget) printed.performanceBudget = existing.performanceBudget;
        process.stdout.write(`${JSON.stringify(printed, null, 2)}\n`);
    } else if (!result.ok) {
        console.error('F0 baseline drift detected. Intentional contract changes must update f0-baseline.json and explain the compatibility impact.');
        for (const item of result.differences) console.error(`  - ${item}`);
        process.exitCode = 1;
    } else {
        console.log('F0 baseline verified: REST source, OpenAPI, typing debt, plugin ABI, tests, sandbox workflow, budgets and the F6 performance budget match.');
    }
}

module.exports = { collectSnapshot, verify, stable, diff, verifyPerformanceBudget };

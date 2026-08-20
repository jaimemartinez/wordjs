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

function verify(): { ok: boolean; current: any; differences: string[] } {
    if (!fs.existsSync(BASELINE_PATH)) {
        return { ok: false, current: collectSnapshot(), differences: [`missing ${relative(BASELINE_PATH)}`] };
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const current = collectSnapshot();
    const differences = diff(baseline.snapshot, current);
    return { ok: differences.length === 0, current, differences };
}

if (require.main === module) {
    const result = verify();
    if (process.argv.includes('--print')) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, snapshot: result.current }, null, 2)}\n`);
    } else if (!result.ok) {
        console.error('F0 baseline drift detected. Intentional contract changes must update f0-baseline.json and explain the compatibility impact.');
        for (const item of result.differences) console.error(`  - ${item}`);
        process.exitCode = 1;
    } else {
        console.log('F0 baseline verified: REST source, OpenAPI, typing debt, plugin ABI, tests, sandbox workflow and budgets match.');
    }
}

module.exports = { collectSnapshot, verify, stable, diff };

/**
 * Swagger spec is not vacuous, and it does not lie about its version.
 *
 * Regression guard for the "silently empty spec" bug: swagger.ts globbed
 * `./src/routes/*.js` relative to process.cwd(), but every route is a `.ts`
 * file, so swagger-jsdoc parsed nothing and served a spec with ZERO paths while
 * still returning HTTP 200 — a classic vacuous-green. This test loads the REAL
 * config module (the same `require('../config/swagger')` the router uses) and
 * asserts the spec actually enumerates paths.
 *
 * Mutation check performed by hand: reverting the glob to `./src/routes/*.js`
 * makes paths.length === 0 and this test fails on the first assertion.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SwaggerParser = require('@apidevtools/swagger-parser');
const swaggerJsdoc = require('swagger-jsdoc');

const specs = require('../config/swagger');

describe('swagger spec', () => {
    it('enumerates a non-empty set of API paths', () => {
        const paths = Object.keys(specs.paths || {});
        assert.ok(
            paths.length > 0,
            `swagger spec has zero paths — the @swagger JSDoc comments were not parsed ` +
                `(check the apis[] globs in src/config/swagger.ts).`,
        );
    });

    it('covers roughly every annotated router (no silent under-parse)', () => {
        // Independently count the route files that carry at least one @swagger block.
        const routesDir = path.join(__dirname, '..', 'routes');
        const annotatedFiles = fs
            .readdirSync(routesDir)
            .filter((f: string) => f.endsWith('.ts'))
            .filter((f: string) =>
                fs.readFileSync(path.join(routesDir, f), 'utf8').includes('@swagger'),
            );

        assert.ok(
            annotatedFiles.length > 0,
            'no route files contain @swagger annotations — fixture assumption broken',
        );

        // Each annotated router contributes at least one path, so the parsed spec
        // must expose AT LEAST as many paths as there are annotated route files.
        // (It exposes far more in practice — 86 vs 24 — but this floor is what a
        // broken glob or a half-parsed spec would fall through.)
        const pathCount = Object.keys(specs.paths || {}).length;
        assert.ok(
            pathCount >= annotatedFiles.length,
            `swagger spec exposes only ${pathCount} paths but ${annotatedFiles.length} route ` +
                `files are annotated with @swagger — the spec is under-parsed.`,
        );
    });

    // THE VERSION THE SPEC ANNOUNCES IS THE PRODUCT'S, NOT A LITERAL.
    //
    // It was hardcoded '1.0.0' and stayed there while the product reached 2.1.0: /api-docs told every
    // integrator, and every client generated from the spec, a version that had been false since the
    // first release. A hardcoded string cannot drift into being wrong — it is wrong the moment the
    // product is bumped, and nothing compared the two. This is that comparison.
    //
    // Mutation check performed by hand: putting the literal '1.0.0' back into src/config/swagger.ts
    // fails the first assertion below with "2.1.0 !== 1.0.0".
    it('announces the product version, read from the release manifest', () => {
        const rootManifest = require('../../../package.json');

        assert.strictEqual(
            specs.info.version,
            rootManifest.version,
            `swagger spec announces version ${specs.info.version} but the release manifest ` +
                `(package.json) says ${rootManifest.version} — the spec's version is not derived ` +
                `from the product's, so it goes stale at the next release.`,
        );
    });

    it('announces a real semver version (never the 0.0.0 fallback)', () => {
        // resolveProductVersion() in src/config/swagger.ts degrades to '0.0.0' rather than throwing
        // when no manifest can be read. That is the right behaviour for a docs route at request time
        // and the wrong outcome for a checkout, so the fallback must never be what the suite sees:
        // it would mean the manifest lookup is broken in exactly the way this test exists to catch.
        assert.match(
            String(specs.info.version),
            /^\d+\.\d+\.\d+/,
            `swagger spec version ${specs.info.version} is not semver-shaped.`,
        );
        assert.notStrictEqual(
            specs.info.version,
            '0.0.0',
            'swagger spec fell back to 0.0.0 — no package.json could be read from src/config/.',
        );
    });
});

// ─── A POPULATED SPEC IS NOT THE SAME THING AS A LEGAL ONE ────────────────────────────────────────
//
// Everything above proves the spec is non-empty and honest about its version. None of it asks whether
// the document is VALID, and it was not: thirteen operations carried an @swagger block with no
// `responses` key at all — the one field OpenAPI 3.0 makes REQUIRED on an operation object. Nothing in
// the pipeline objects: swagger-jsdoc merges whatever YAML it finds without judging it, and
// swagger-ui-express renders the result without complaining. So an invalid spec shipped in silence,
// and every client generated from /api-docs inherited the hole.
//
// Three passes, because each fails on something the others cannot see:
//   1. A structural sweep of our own — the only one that can name an OPERATION and the SOURCE LINE to
//      open. A gate whose output is a JSON pointer makes the reader do the lookup.
//   2. @apidevtools/swagger-parser `validate()` — the OpenAPI 3.0 meta-schema itself, so this gate does
//      not degrade into "whatever rules we happened to hand-write above".
//   3. swagger-jsdoc with `failOnErrors: true` — config/swagger.ts runs with the default
//      (failOnErrors: false), which is right for a docs route that must keep serving and wrong for a
//      checkout: a malformed block is SWALLOWED, and the operation simply vanishes from the spec
//      rather than announcing itself.
//
// Mutation check performed by hand: deleting the `responses:` block from any one operation in
// src/routes/*.ts makes pass 1 and pass 2 name that exact operation; corrupting a block's YAML
// indentation makes pass 3 throw.

const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * The source globs config/swagger.ts feeds swagger-jsdoc — READ FROM IT, never restated.
 *
 * They used to be retyped here as a literal, and the file list below was retyped a second time, so
 * nothing compared any of the three to the real `options.apis`. A glob added to or removed from
 * config/swagger.ts left the strict `failOnErrors` pass and the file:line index quietly checking a
 * DIFFERENT set of files from the one the served spec is built from — the gate would stay green while
 * covering the wrong thing. config/swagger.ts publishes the resolved list as a non-enumerable `__apis`
 * (invisible to the OpenAPI document itself); a missing export is a hard failure here, because falling
 * back to a hardcoded guess is the very drift this exists to prevent.
 */
const sourceGlobs = (): string[] => {
    const apis = (specs as any).__apis;
    assert.ok(
        Array.isArray(apis) && apis.length > 0,
        'src/config/swagger.ts no longer exports __apis — this test cannot verify the SAME sources ' +
            'swagger-jsdoc scanned, and a hardcoded copy of the globs is exactly the drift it exists to ' +
            'prevent. Restore the export rather than restating the list here.',
    );
    return apis.slice();
};

/**
 * Every .ts file sourceGlobs() covers, as { rel, abs }: EXPANDED FROM THE GLOBS, not from a second
 * hand-written list of directories.
 *
 * The app ENTRY declares operations too — /healthz, /readyz, /metrics and /api are app.get()s at the
 * server root, outside the /api/v1 server, each carrying its own `servers` block to say so. Expanding
 * the real globs is what guarantees it is indexed: with a hand-written list, a failure in one of those
 * four reported "source location not found" and handed the reader a JSON pointer instead of a file to
 * open — exactly the degradation this index exists to prevent.
 *
 * The patterns config/swagger.ts uses are deliberately simple (an absolute directory, then either a
 * `*` basename or a fixed one, with a `{ts,js}` extension brace), so this expands that shape only and
 * takes the `.ts` side: the suite runs from source. Anything richer would be a new pattern in
 * config/swagger.ts, and the assertion below makes that loud instead of silently indexing nothing.
 */
const indexableSources = (): Array<{ rel: string; abs: string }> => {
    const srcRoot = path.join(__dirname, '..', '..');
    const rel = (abs: string) => path.relative(srcRoot, abs).split(path.sep).join('/');
    const out: Array<{ rel: string; abs: string }> = [];

    for (const glob of sourceGlobs()) {
        const tsOnly = glob.replace('{ts,js}', 'ts');
        const dir = path.dirname(tsOnly);
        const base = path.basename(tsOnly);
        if (!fs.existsSync(dir)) continue;
        if (base.indexOf('*') === -1) {
            const abs = path.join(dir, base);
            if (fs.existsSync(abs)) out.push({ rel: rel(abs), abs });
            continue;
        }
        const literal = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const matcher = new RegExp('^' + base.split('*').map(literal).join('[^\\\\/]*') + '$');
        for (const file of fs.readdirSync(dir).filter((f: string) => matcher.test(f))) {
            out.push({ rel: rel(path.join(dir, file)), abs: path.join(dir, file) });
        }
    }

    assert.ok(
        out.length > 0,
        `none of the globs in src/config/swagger.ts (${sourceGlobs().join(', ')}) expanded to a source ` +
            `file — the operation source index would be empty and every failure would degrade to ` +
            `"source location not found".`,
    );
    return out;
};

/**
 * `METHOD /path` → `file:line` of the @swagger comment that declares it.
 *
 * The spec object has no memory of where each operation came from, so a failure reported off it alone
 * can only quote a JSON pointer. This walks the same files swagger-jsdoc scans and indexes the
 * path-item and operation keys inside the JSDoc blocks, so the gate hands back a location to open. An
 * operation that cannot be located is still reported — without a location, never dropped.
 */
const buildOperationSourceIndex = (): Map<string, string> => {
    const index = new Map<string, string>();
    for (const source of indexableSources()) {
        const lines = fs.readFileSync(source.abs, 'utf8').split(/\r?\n/);
        let currentPath = '';
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.indexOf('*/') !== -1) {
                currentPath = '';
                continue;
            }
            const comment = /^\s*\*\s?(.*)$/.exec(line);
            if (!comment) continue;
            const body = comment[1];
            // A path-item key sits at column 0 of the comment body: `/plugins/{slug}/status:`.
            if (/^\/\S*:\s*$/.test(body)) {
                currentPath = body.slice(0, body.length - 1);
                continue;
            }
            if (!currentPath) continue;
            // An operation key sits exactly two spaces in — deeper matches are schema properties
            // that merely happen to be spelled like an HTTP method.
            const method = /^ {2}([a-z]+):\s*$/.exec(body);
            if (method && OPERATION_METHODS.indexOf(method[1]) !== -1) {
                index.set(
                    `${method[1].toUpperCase()} ${currentPath}`,
                    `${source.rel}:${i + 1}`,
                );
            }
        }
    }
    return index;
};

let operationSourceIndex: Map<string, string> | null = null;
const operationSource = (key: string): string => {
    if (!operationSourceIndex) operationSourceIndex = buildOperationSourceIndex();
    return operationSourceIndex.get(key) || 'source location not found';
};

const problem = (list: string[], key: string, reason: string): void => {
    list.push(`${key}: ${reason}  [${operationSource(key)}]`);
};

/**
 * Every structural rule OpenAPI 3.0 imposes on an operation that we can attribute to a NAMED operation.
 * Collect them all — a gate that stops at the first offender turns one fix-and-rerun cycle into
 * thirteen, and hides the shape of the problem from whoever has to schedule the work.
 */
const structuralProblems = (spec: any): string[] => {
    const problems: string[] = [];
    const paths = spec.paths || {};
    for (const pathKey of Object.keys(paths).sort()) {
        const item = paths[pathKey] || {};
        const templated = (String(pathKey).match(/\{[^}]+\}/g) || []).map((t: string) =>
            t.slice(1, t.length - 1),
        );
        const itemParams = Array.isArray(item.parameters) ? item.parameters : [];
        for (const method of OPERATION_METHODS) {
            const op = item[method];
            if (!op || typeof op !== 'object') continue;
            const key = `${method.toUpperCase()} ${pathKey}`;

            const params = itemParams.concat(Array.isArray(op.parameters) ? op.parameters : []);
            for (const p of params) {
                if (!p || typeof p.name !== 'string' || typeof p.in !== 'string') {
                    problem(problems, key, 'a parameter object is missing "name" or "in"');
                }
            }
            const declared = params
                .filter((p: any) => p && p.in === 'path')
                .map((p: any) => p.name);
            for (const t of templated) {
                if (declared.indexOf(t) === -1) {
                    problem(
                        problems,
                        key,
                        `the path template {${t}} is never declared as an "in: path" parameter`,
                    );
                }
            }

            if (!op.responses || typeof op.responses !== 'object') {
                problem(
                    problems,
                    key,
                    'no "responses" object — OpenAPI 3.0 requires one on every operation',
                );
                continue;
            }
            const codes = Object.keys(op.responses);
            if (codes.length === 0) {
                problem(problems, key, '"responses" is present but empty');
                continue;
            }
            for (const code of codes) {
                if (!/^([1-5][0-9]{2}|[1-5]XX|default)$/.test(code)) {
                    problem(
                        problems,
                        key,
                        `response key "${code}" is not a status code, an NXX range or "default"`,
                    );
                }
                const resp = op.responses[code];
                if (!resp || typeof resp.description !== 'string' || !resp.description.trim()) {
                    problem(
                        problems,
                        key,
                        `response ${code} has no "description" — required by OpenAPI 3.0`,
                    );
                }
            }
        }
    }
    return problems;
};

const decodePointerSegment = (segment: string): string =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~');

/**
 * Turn one `#/paths/~1plugins~1assets/get must have ...` line from swagger-parser into the same
 * `METHOD /path: reason  [file:line]` shape the sweep above emits, so a reader never has to decode a
 * JSON pointer by hand. Anything that is not an operation-scoped pointer is passed through verbatim.
 */
const humanizeValidatorLine = (line: string): string => {
    const trimmed = line.trim();
    const parsed = /^#(\/\S*)\s+(.*)$/.exec(trimmed);
    if (!parsed) return trimmed;
    const segments = parsed[1].split('/').slice(1).map(decodePointerSegment);
    if (
        segments[0] === 'paths' &&
        segments.length >= 3 &&
        OPERATION_METHODS.indexOf(segments[2]) !== -1
    ) {
        const key = `${segments[2].toUpperCase()} ${segments[1]}`;
        const rest = segments.slice(3);
        const where = rest.length ? ` (at ${rest.join('/')})` : '';
        return `${key}: ${parsed[2]}${where}  [${operationSource(key)}]`;
    }
    return trimmed;
};

/**
 * The sweep and the meta-schema describe the same defect in different words. Fold them onto one line
 * per (operation, kind-of-defect) so a thirteen-operation failure reads as thirteen items, not
 * twenty-six.
 */
const dedupeKey = (entry: string): string => {
    const at = entry.indexOf(': ');
    if (at === -1) return entry;
    const key = entry.slice(0, at);
    const reason = entry.slice(at + 2);
    return `${key}|${/responses/.test(reason) ? 'responses' : reason.replace(/\s+/g, ' ').slice(0, 60)}`;
};

describe('swagger spec — OpenAPI 3.0 structural validity', () => {
    it('is a valid OpenAPI 3.0 document (every operation declares its responses)', async () => {
        // JSON round-trip: validate() dereferences and annotates its input in place, and `specs` is the
        // live object the /api-docs route serves and the tests above read.
        const clone = JSON.parse(JSON.stringify(specs));

        const found = new Map<string, string>();
        for (const entry of structuralProblems(clone)) {
            const k = dedupeKey(entry);
            if (!found.has(k)) found.set(k, entry);
        }

        let validatorMessage = '';
        try {
            await SwaggerParser.validate(clone);
        } catch (err: any) {
            validatorMessage = String((err && err.message) || err);
            // First line is the "Swagger schema validation failed." banner; the rest are the errors.
            for (const line of validatorMessage.split('\n').slice(1)) {
                if (!line.trim()) continue;
                const entry = humanizeValidatorLine(line);
                const k = dedupeKey(entry);
                if (!found.has(k)) found.set(k, entry);
            }
        }

        const problems = Array.from(found.values()).sort();
        assert.ok(
            problems.length === 0,
            `the generated OpenAPI spec is NOT a valid OpenAPI 3.0 document — ${problems.length} ` +
                `problem(s):\n${problems.map((p: string) => `  - ${p}`).join('\n')}\n\n` +
                `"responses" is REQUIRED on every operation object in OpenAPI 3.0. swagger-jsdoc merges ` +
                `a block that omits it without complaint and swagger-ui renders the result, so nothing ` +
                `but this gate notices. Fix the @swagger comment at the location shown — the status ` +
                `codes documented must be the ones the handler and its middleware actually answer.` +
                (validatorMessage
                    ? `\n\nRaw @apidevtools/swagger-parser output:\n${validatorMessage}`
                    : ''),
        );
    });

    it('parses every @swagger block strictly — no silently swallowed YAML', () => {
        // config/swagger.ts leaves failOnErrors at its default (false) ON PURPOSE: the docs router
        // requires it at request time, and a malformed comment must not take /api-docs down. The cost is
        // that a typo'd block DISAPPEARS — no error, no endpoint, and the "non-empty spec" tests above
        // still pass because the other 170 paths are fine. Re-run the SAME globs strictly here, where
        // throwing is exactly what we want.
        let built: any;
        try {
            built = swaggerJsdoc({
                failOnErrors: true,
                definition: {
                    openapi: '3.0.0',
                    info: { title: 'WordJS REST API', version: String(specs.info.version) },
                },
                apis: sourceGlobs(),
            });
        } catch (err: any) {
            assert.fail(
                `at least one @swagger JSDoc block is not parseable YAML, so swagger-jsdoc drops the ` +
                    `operation it declares and the endpoint silently vanishes from /api-docs:\n` +
                    `${(err && err.message) || err}`,
            );
        }

        // A strict pass that parsed nothing would "succeed" vacuously — the exact failure mode the
        // globs in config/swagger.ts already had once.
        assert.ok(
            Object.keys((built && built.paths) || {}).length > 0,
            'the strict swagger-jsdoc pass produced zero paths — the globs no longer match any source ' +
                'file, so this gate would pass no matter what the @swagger comments said.',
        );
    });
});

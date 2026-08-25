/**
 * THE MARKS THE AUTH MIDDLEWARE STAMPS ON THE REQUEST — AS A CLASS, NOT AS THREE EXAMPLES.
 *
 * Typing the HTTP boundary (f95f139f) surfaced three defects that `any` had been hiding, and all three
 * are the SAME defect wearing different clothes: a field that lives on the Express `Request` at runtime
 * has no single owner, so nothing in the toolchain can tell you when it is dead, when it is unused, or
 * when two files describe it differently.
 *
 *   · `req.userId` was stamped on ten paths in middleware/auth.ts and READ NOWHERE. A mark nobody reads
 *     is not free: the next reader assumes it is authoritative, and it is one edit away from disagreeing
 *     with `req.user.id` (the field that IS the documented contract — documentation/api.md §2.2).
 *   · `ownerOrCan` was destructured out of middleware/permissions in TWO route files and called in
 *     neither. An import that resolves and is never used reads as coverage that is not there.
 *   · `apiToken` was declared THREE times — auth.ts (the object), webhooks.ts (the same object, retyped
 *     by hand) and collab.ts (`unknown`). TypeScript cannot see the disagreement, because each is a
 *     separate intersection over `Request`, not a redeclaration of one property. A fourth file writing
 *     `Request & { apiToken?: boolean }` and gating on `=== true` compiles clean and never fires — and
 *     `req.apiToken` is the mark that stops a leaked machine token from planting a webhook. (That
 *     intersection form still compiles clean AFTER the consolidation; see the last two tests, which
 *     measure exactly which forms the compiler does and does not catch.)
 *
 * So these tests do not name `userId`, `ownerOrCan` or `apiToken` as the thing under test. They DERIVE
 * the mark list from middleware/auth.ts's own source and then assert three invariants over it, so the
 * next write-only mark, the next dead import and the next parallel declaration are red on arrival.
 *
 * Every scanner here carries a POSITIVE CONTROL: it is shown a synthetic source that plainly contains
 * the thing it hunts and is required to find it. A scanner that reports "nothing wrong" because it is
 * broken must not be indistinguishable from a clean tree.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const BACKEND = path.join(__dirname, '..', '..');
const REPO = path.join(BACKEND, '..');
const SRC = path.join(BACKEND, 'src');
const AUTH_TS = path.join(SRC, 'middleware', 'auth.ts');
const GLOBALS_DTS = path.join(SRC, 'types', 'globals.d.ts');
const ROUTES_DIR = path.join(SRC, 'routes');
const SELF = path.resolve(__filename);

const rel = (p: string) => path.relative(REPO, p).replace(/\\/g, '/');

// ─── SOURCE PLUMBING ───────────────────────────────────────────────────────────────────────────────

/** Files are CRLF in this tree; every scanner below works on LF so line/offset maths stays honest. */
const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/**
 * Replace comment BODIES with spaces, preserving every newline and every offset.
 *
 * Blanking rather than deleting is the point: line numbers and match offsets keep pointing at the real
 * source, so a failure message names a line a human can open. Strings and template literals are tracked
 * so that a `//` inside `'http://x'` is not mistaken for a comment — the exact trap that would make the
 * scanner silently swallow the rest of a line of real code.
 */
function blankComments(src: string): string {
    const out = src.split('');
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        const d = src[i + 1];
        if (c === '/' && d === '/') {
            while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
        } else if (c === '/' && d === '*') {
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; }
            if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
        } else if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < n) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === quote) { i++; break; }
                i++;
            }
        } else {
            i++;
        }
    }
    return out.join('');
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

function walk(dir: string, acc: string[] = []): string[] {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return acc; }
    for (const name of entries) {
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        const full = path.join(dir, name);
        let st: { isDirectory(): boolean };
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full, acc);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) acc.push(full);
    }
    return acc;
}

/**
 * Everything that could hold a READER of a request mark: the backend's own source (tests included — a
 * test asserting on a mark is evidence the mark is load-bearing), the bundled platform plugins and the
 * 25 marketplace plugins, whose handlers registered through `plugin-api.http.route()` run in-process
 * and therefore receive the REAL Express request object.
 */
function readerCorpus(): string[] {
    return [
        ...walk(SRC),
        ...walk(path.join(BACKEND, 'plugins')),
        ...walk(path.join(REPO, 'marketplace', 'plugins')),
    ].filter((f) => path.resolve(f) !== SELF);
}

// ─── 1. A MARK THAT NOBODY READS ───────────────────────────────────────────────────────────────────

/** Every `req.<name> =` assignment in a source: the marks that file stamps onto the request. */
function marksStampedBy(source: string): string[] {
    const found = new Set<string>();
    const re = /\breq\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) found.add(m[1]);
    return [...found].sort();
}

/** Reads of `req.<name>` / `request.<name>` — an occurrence NOT in the left-hand side of an assignment. */
function readSitesOfMark(source: string, mark: string): number[] {
    const re = new RegExp(`\\b(?:req|request)\\.${mark}\\b(?!\\s*=(?!=))`, 'g');
    const hits: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) hits.push(m.index);
    return hits;
}

describe('request marks: nothing is stamped that nothing reads', () => {
    test('the write-only-mark scanner finds a planted write-only mark (positive control)', () => {
        const stamper = blankComments([
            'function mw(req: any) {',
            '  req.ghost = 1;              // stamped, never read anywhere',
            '  req.seen = 2;               // stamped AND read below',
            '  // req.decoy = 3;           <- a comment must not count as a stamp',
            "  const url = 'http://x//y';  // a // inside a string must not eat this line",
            '}',
        ].join('\n'));
        const reader = blankComments('function gate(req: any) { return !!req.seen; }');

        assert.deepEqual(marksStampedBy(stamper), ['ghost', 'seen'],
            'the stamp scanner must see exactly the two real assignments — not the commented one.');
        assert.equal(readSitesOfMark(stamper + '\n' + reader, 'seen').length, 1,
            'the read scanner must find the one genuine read of `req.seen`.');
        assert.equal(readSitesOfMark(stamper + '\n' + reader, 'ghost').length, 0,
            'the read scanner must find no read of `req.ghost` — an assignment is not a read.');
    });

    test('every mark middleware/auth.ts stamps on the request is read somewhere', () => {
        const auth = blankComments(read(AUTH_TS));
        const marks = marksStampedBy(auth);
        assert.ok(marks.length >= 2, `expected auth.ts to stamp several marks, found ${marks.length}`);

        const corpus = readerCorpus().map((f) => ({ file: f, src: blankComments(read(f)) }));

        const orphans: string[] = [];
        for (const mark of marks) {
            const writes = (auth.match(new RegExp(`\\breq\\.${mark}\\s*=(?!=)`, 'g')) || []).length;
            const readers = corpus
                .filter(({ src }) => readSitesOfMark(src, mark).length > 0)
                .map(({ file }) => rel(file));
            if (readers.length === 0) {
                orphans.push(`req.${mark} — stamped ${writes} time(s) in ${rel(AUTH_TS)}, read by NOBODY`);
            }
        }

        assert.deepEqual(orphans, [],
            'A request mark with no reader is dead weight that reads as authoritative. Either the consumer '
            + 'was lost (restore it) or the mark never had one (delete the writes). `req.user` is the '
            + 'documented identity contract (documentation/api.md §2.2); a second, silently redundant copy '
            + 'of the same id is one edit away from disagreeing with it.\n  ' + orphans.join('\n  '));
    });
});

// ─── 2. AN IMPORT THAT IS NEVER CALLED ─────────────────────────────────────────────────────────────

/** Names destructured from `require('../middleware/permissions')` that never appear again in the file. */
function unusedPermissionImports(source: string): string[] {
    const re = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"][^'"]*middleware\/permissions['"]\s*\)\s*;?/g;
    const unused: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
        const names = m[1].split(',').map((s) => s.split(':').pop()!.trim()).filter(Boolean);
        // The rest of the file, with THIS import statement removed, so the binding site is not its own use.
        const body = source.slice(0, m.index) + source.slice(m.index + m[0].length);
        for (const name of names) {
            if (!new RegExp(`\\b${name}\\b`).test(body)) unused.push(name);
        }
    }
    return unused.sort();
}

describe('permissions middleware: no route imports a gate it never applies', () => {
    test('the unused-import scanner finds a planted unused import (positive control)', () => {
        const planted = blankComments([
            "const { can, ownerOrNever } = require('../middleware/permissions');",
            "router.get('/', can('read'), handler);",
        ].join('\n'));
        assert.deepEqual(unusedPermissionImports(planted), ['ownerOrNever'],
            'the scanner must flag the import that is never applied, and only that one.');
    });

    test('every permissions middleware a route imports is actually applied in that route', () => {
        const offenders: string[] = [];
        for (const file of (fs.readdirSync(ROUTES_DIR) as string[]).filter((f: string) => f.endsWith('.ts'))) {
            const full = path.join(ROUTES_DIR, file);
            for (const name of unusedPermissionImports(blankComments(read(full)))) {
                offenders.push(`${rel(full)} imports \`${name}\` and never applies it`);
            }
        }
        assert.deepEqual(offenders, [],
            'A permissions gate that is imported but never mounted looks, at a glance, like the route is '
            + 'guarded by it. Drop the import (the export can stay — documentation/api.md §2.2 lists the '
            + 'middleware) so the reader is not misled.\n  ' + offenders.join('\n  '));
    });
});

// ─── 3. ONE RUNTIME FIELD, ONE DECLARATION ─────────────────────────────────────────────────────────

type Decl = { name: string; file: string; line: number };

/**
 * Every property declared onto the Express `Request` by a source: the three shapes this tree uses are
 * `type X = Request & { … }`, `interface X extends Request { … }` and the shared augmentation
 * `declare module 'express-serve-static-core' { interface Request { … } }`.
 *
 * Brace-balanced rather than regex-terminated, because the very field this exists to police —
 * `apiToken?: { id: number; scopes: string[]; name: string }` — contains a nested `}` that a lazy
 * `\{[^}]*\}` would stop at, hiding every field declared after it.
 */
function requestPropertyDeclarations(source: string, file: string): Decl[] {
    const decls: Decl[] = [];
    const heads = [
        /\bRequest\s*&\s*\{/g,
        /\binterface\s+\w+\s+extends\s+Request\s*\{/g,
        /\binterface\s+Request\s*\{/g,
    ];
    for (const head of heads) {
        head.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = head.exec(source))) {
            let depth = 0;
            let i = m.index + m[0].length - 1;
            const open = i;
            for (; i < source.length; i++) {
                if (source[i] === '{') depth++;
                else if (source[i] === '}') { depth--; if (depth === 0) break; }
            }
            const body = source.slice(open + 1, i);
            // Top-level members only: split on `;`/newline at brace depth 0 inside the body.
            let d = 0;
            let seg = '';
            let segStart = open + 1;
            const flush = (endIdx: number) => {
                const fm = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/.exec(seg);
                if (fm) decls.push({ name: fm[1], file, line: lineOf(source, segStart + seg.indexOf(fm[1])) });
                seg = '';
                segStart = endIdx + 1;
            };
            for (let k = 0; k < body.length; k++) {
                const ch = body[k];
                if (ch === '{' || ch === '(' || ch === '[') d++;
                else if (ch === '}' || ch === ')' || ch === ']') d--;
                if (d === 0 && (ch === ';' || ch === '\n')) flush(open + 1 + k);
                else seg += ch;
            }
            flush(i);
        }
    }
    return decls;
}

describe('request marks: one runtime field, one declaration', () => {
    test('the declaration scanner sees past a nested object type (positive control)', () => {
        const planted = blankComments([
            'type A = Request & {',
            '    token?: { id: number; scopes: string[] };',
            '    after?: boolean;',
            '};',
            'interface B extends Request { alsoHere?: string; }',
        ].join('\n'));
        const names = requestPropertyDeclarations(planted, 'synthetic.ts').map((d) => d.name).sort();
        assert.deepEqual(names, ['after', 'alsoHere', 'token'],
            '`after` is declared BEHIND a nested `}` — a scanner that stops at the first closing brace '
            + 'would miss it and then certify the file as declaring nothing twice.');
    });

    test('each mark auth.ts stamps is declared exactly once, in src/types/globals.d.ts', () => {
        const marks = marksStampedBy(blankComments(read(AUTH_TS)));

        const byName = new Map<string, Decl[]>();
        for (const file of walk(SRC).filter((f) => path.resolve(f) !== SELF).concat([GLOBALS_DTS])) {
            for (const d of requestPropertyDeclarations(blankComments(read(file)), file)) {
                if (!byName.has(d.name)) byName.set(d.name, []);
                byName.get(d.name)!.push(d);
            }
        }

        const problems: string[] = [];
        for (const mark of marks) {
            const sites = byName.get(mark) || [];
            const where = sites.map((d) => `${rel(d.file)}:${d.line}`);
            if (sites.length !== 1) {
                problems.push(`req.${mark} is declared ${sites.length} time(s): ${where.join(', ') || '(nowhere)'}`);
            } else if (path.resolve(sites[0].file) !== path.resolve(GLOBALS_DTS)) {
                problems.push(`req.${mark} is declared in ${where[0]}, not in ${rel(GLOBALS_DTS)}`);
            }
        }

        assert.deepEqual(problems, [],
            'Parallel declarations of one runtime field cannot drift LOUDLY: each is a separate '
            + 'intersection over Request, so TypeScript never compares them. A file that retypes '
            + '`apiToken` as a boolean and gates on `=== true` compiles clean and never fires — on the '
            + 'mark that keeps a leaked machine token from planting a webhook. Moving the declaration '
            + 'into the shared augmentation makes two of the three redeclaration forms a compile error, '
            + 'but NOT `Request & { … }` — so this source-level check is the only thing that catches '
            + 'that one.\n  ' + problems.join('\n  '));
    });
});

// ─── 4. THE SAME INVARIANT, ASKED OF THE COMPILER ──────────────────────────────────────────────────

/**
 * Type-check a synthetic module AS IF it sat in backend/src, without ever touching the disk.
 *
 * A source-text scan can prove the declarations were merged; only the compiler can prove the merge took
 * EFFECT — that a handler annotated with the bare `Request` now sees `apiToken` with its real shape.
 * The file is virtual (served by a custom CompilerHost) so nothing is written into a tree other agents
 * are working in, and module resolution still walks up to backend/node_modules because the virtual path
 * lives there.
 */
function typeCheckSnippet(snippet: string): string[] {
    const virtualPath = path.join(SRC, '__request-marks-probe.ts');
    const parsed = ts.parseJsonConfigFileContent(
        ts.readConfigFile(path.join(BACKEND, 'tsconfig.json'), ts.sys.readFile).config,
        ts.sys,
        BACKEND
    );
    const options = { ...parsed.options, noEmit: true };
    const host = ts.createCompilerHost(options, true);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    const originalFileExists = host.fileExists.bind(host);
    const originalReadFile = host.readFile.bind(host);
    const same = (f: string) => path.resolve(f) === path.resolve(virtualPath);
    host.getSourceFile = (fileName: string, languageVersion: any, onError?: any, shouldCreate?: any) =>
        same(fileName)
            ? ts.createSourceFile(fileName, snippet, languageVersion, true, ts.ScriptKind.TS)
            : originalGetSourceFile(fileName, languageVersion, onError, shouldCreate);
    host.fileExists = (fileName: string) => same(fileName) || originalFileExists(fileName);
    host.readFile = (fileName: string) => (same(fileName) ? snippet : originalReadFile(fileName));

    const program = ts.createProgram({ rootNames: [GLOBALS_DTS, virtualPath], options, host });
    return program
        .getSemanticDiagnostics()
        .filter((d: any) => d.file && same(d.file.fileName))
        .map((d: any) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

describe('request marks: the compiler agrees', () => {
    test('a handler typed as the bare Request can read req.apiToken and req.isHeadless', () => {
        const errors = typeCheckSnippet([
            "import type { Request } from 'express';",
            'export const scopesOf = (req: Request): string[] => (req.apiToken ? req.apiToken.scopes : []);',
            'export const tokenName = (req: Request): string => String(req.apiToken?.name ?? "");',
            'export const headless = (req: Request): boolean => req.isHeadless === true;',
        ].join('\n'));
        assert.deepEqual(errors, [],
            '`req.apiToken` / `req.isHeadless` are the marks the headless gates read, so a route that '
            + 'wants to gate on them must be able to — with the shared Request type, not a hand-rolled '
            + 'local copy of the declaration.');
    });

    test('the consolidated declaration keeps its real shape (it is not `any` or `unknown`)', () => {
        const errors = typeCheckSnippet([
            "import type { Request } from 'express';",
            'export const wrong = (req: Request): number => req.apiToken!.scopes;',
        ].join('\n'));
        assert.ok(errors.some((e) => e.startsWith('TS2322')),
            'Assigning `string[]` to `number` MUST still be an error. If this snippet compiles, the '
            + 'declarations were consolidated onto `any`/`unknown`, which merges the three parallel '
            + 'declarations by giving up the checking that was the point.\n  saw: ' + JSON.stringify(errors));
    });

    /**
     * WHAT THE CONSOLIDATION ACTUALLY BUYS, MEASURED RATHER THAN ASSUMED.
     *
     * The drift these three parallel declarations permitted is concrete: retype the mark as a boolean,
     * gate on `=== true`, and the gate silently never fires — because the runtime value is an object.
     * On `req.apiToken`, that gate is what stops a leaked machine token from planting a webhook.
     *
     * With the mark declared on `Request` itself, TWO of the three ways to redeclare it become compile
     * errors — including `interface … extends Request`, the form routes/webhooks.ts was using. The
     * third, `Request & { … }`, does NOT: TypeScript builds a fresh intersection instead of comparing
     * the property against the existing declaration, so a contradictory type passes silently. That is
     * measured (both directions, against globals.d.ts with and without the mark), not assumed, and it
     * is why the source-level "declared exactly once" test above is not redundant with this one — it is
     * the only thing standing between the tree and the intersection form.
     */
    test('a mis-shaped redeclaration is a compile error in the extends and augmentation forms', () => {
        const viaExtends = typeCheckSnippet([
            "import type { Request } from 'express';",
            'interface Wrong extends Request { apiToken?: boolean }',
            'export const gate = (req: Wrong): boolean => req.apiToken === true;',
        ].join('\n'));
        assert.ok(viaExtends.some((e) => e.startsWith('TS2430')),
            '`interface X extends Request { apiToken?: boolean }` must not compile — this is the exact '
            + 'shape routes/webhooks.ts used to carry, so it is the shape most likely to come back.\n  '
            + 'saw: ' + JSON.stringify(viaExtends));

        const viaAugmentation = typeCheckSnippet([
            "import 'express';",
            "declare module 'express-serve-static-core' { interface Request { apiToken?: boolean } }",
            'export const x = 1;',
        ].join('\n'));
        assert.ok(viaAugmentation.some((e) => e.startsWith('TS2717')),
            'A second module augmentation that disagrees about the type must not compile.\n  '
            + 'saw: ' + JSON.stringify(viaAugmentation));
    });

    test('the intersection form still escapes the compiler — the source-level test is what catches it', () => {
        const viaIntersection = typeCheckSnippet([
            "import type { Request } from 'express';",
            'type Wrong = Request & { apiToken?: boolean };',
            'export const gate = (req: Wrong): boolean => req.apiToken === true;',
        ].join('\n'));
        assert.deepEqual(viaIntersection, [],
            'This records a KNOWN LIMIT, so nobody reads the consolidation as a stronger guarantee than '
            + 'it is: an intersection does not redeclare a property, it builds a new type, so TypeScript '
            + 'never compares the two and `req.apiToken === true` compiles against an object-typed mark. '
            + 'If this ever goes red, TypeScript has closed the hole — good news: delete this test and '
            + 'fold the form into the one above.');
    });
});

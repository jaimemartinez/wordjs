/**
 * EVERY ROUTE MODULE ON DISK IS ONE THE SERVER MOUNTS.
 *
 * backend/src/routes/frontend.ts — the legacy Handlebars public renderer — was mounted nowhere (index.ts
 * said so) yet kept on disk "as a fallback". It went on carrying the read rules of an older day: it
 * resolved a bare slug POST-before-page, the precedence that let an Author's post take a page's URL and
 * that GET /posts/slug/:slug no longer uses, and it read snake_case fields off a Post instance, so it
 * could not render a single entry at all. Code that serves nothing is still code the next person
 * re-mounts, copies or audits as if it were live; a security rule fixed in the mounted route and not in
 * its dead twin is the drift this repository keeps finding. It is deleted, and this test keeps the class
 * closed: each module under src/routes must be required by the server's own code (index.ts, the routes
 * index, or a router that nests it).
 *
 * MUTATION PROOF: restore routes/frontend.ts and this test names it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');
const ROUTES = path.join(SRC, 'routes');

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'tests' || entry.name === 'node_modules') continue;
            sourceFiles(full, out);
        } else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/** The route modules some server file actually require()s, resolved to absolute paths. */
function requiredRouteModules(): Set<string> {
    const found = new Set<string>();
    const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
    for (const file of sourceFiles(SRC)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(re)) {
            const target = path.resolve(path.dirname(file), m[1]);
            // A directory require ('./routes') loads its index.ts, exactly as Node resolves it.
            const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
            const asTs = isDir ? path.join(target, 'index.ts') : (target.endsWith('.ts') ? target : `${target}.ts`);
            if (path.dirname(asTs) === ROUTES && path.resolve(asTs) !== path.resolve(file)) found.add(path.resolve(asTs));
        }
    }
    return found;
}

describe('route modules', () => {
    it('every module under src/routes is mounted by the server', () => {
        const mounted = requiredRouteModules();
        const modules = fs.readdirSync(ROUTES).filter((n: string) => n.endsWith('.ts') && n !== 'index.ts');
        assert.ok(modules.length > 20, 'the scan sees the routes directory');
        const dead = modules.filter((n: string) => !mounted.has(path.resolve(ROUTES, n)));
        assert.deepStrictEqual(dead, [], `route modules nothing mounts: ${dead.join(', ')}`);
    });

    it('the scan recognizes a mount (sanity: index.ts mounts the routes index, which mounts posts)', () => {
        const mounted = requiredRouteModules();
        assert.ok(mounted.has(path.resolve(ROUTES, 'index.ts')));
        assert.ok(mounted.has(path.resolve(ROUTES, 'posts.ts')));
    });

    // GET /api/v1/ publishes a route map. It used to be a hand-kept literal that went stale (a third of
    // the mounted groups were missing, and it announced version 1.0.0). Every group the server mounts
    // (on the routes index, or on the app by src/index.ts and core/db-admin) must be in it.
    it('the API index route map lists every mounted route group', () => {
        const groups = require('../routes/index').API_ROUTE_GROUPS;
        assert.ok(groups && typeof groups === 'object', 'routes/index exposes API_ROUTE_GROUPS');
        const listed = new Set(Object.values(groups));
        const mounted = new Set<string>();
        const indexText = fs.readFileSync(path.join(ROUTES, 'index.ts'), 'utf8');
        for (const m of indexText.matchAll(/router\.use\(\s*'(\/[^']+)'\s*,(?!\s*multisiteGuards)/g)) mounted.add(m[1]);
        const appMount = /app\.use\(\s*[`'"](?:\$\{config\.api\.prefix\}|\/api\/v1)(\/[^`'"]+)[`'"]\s*,\s*(?:router\b|require\()/g;
        for (const file of [path.join(SRC, 'index.ts'), path.join(SRC, 'core', 'db-admin', 'index.js')]) {
            for (const m of fs.readFileSync(file, 'utf8').matchAll(appMount)) mounted.add(m[1]);
        }
        assert.ok(mounted.has('/posts') && mounted.has('/backups') && mounted.has('/db-migration'), 'the scan sees both kinds of mount');
        const missing = [...mounted].filter((p) => !listed.has(p));
        assert.deepStrictEqual(missing, [], `route groups missing from GET /api/v1/: ${missing.join(', ')}`);
    });

    it('the API index announces the product version, not a literal', () => {
        const router = require('../routes/index');
        const layer = router.stack.find((l: any) => l.route && l.route.path === '/' && l.route.methods.get);
        assert.ok(layer, 'GET / is mounted on the routes index');
        let body: any = null;
        layer.route.stack[0].handle({}, { json: (b: any) => { body = b; } });
        const expected = require(path.resolve(SRC, '..', '..', 'package.json')).version;
        assert.strictEqual(body.version, expected);
        assert.strictEqual(body.routes.dbMigration, '/api/v1/db-migration');
    });
});

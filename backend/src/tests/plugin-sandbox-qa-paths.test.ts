/**
 * The documented plugin paths the 3-mode QA found broken (2026-10-21), each pinned at the core seam:
 *
 *   M3-03 / S4-01  a MySQL/MariaDB user without GRANT OPTION creates the plugin's DB login but cannot grant
 *                  it its tables → every query of a hot-activated plugin failed with "access denied".
 *   S4-14          "delete its data too" stopped at the first table a foreign key protected and still said
 *                  every table was gone.
 *   M4-05 / S4-18  an approved private relay (host:port) stayed blocked: the STARTTLS upgrade
 *                  `tls.connect({ socket, host })` carries no port, so it never matched the approval.
 *   M4-04 / S4-19  a multipart upload was staged in the OS temp dir, which the plugin's sandbox cannot read.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Duplex } = require('stream');
const Module = require('module');

// ---------------------------------------------------------------------------------------------------------
// M3-03 / S4-01 — a refused GRANT drops the plugin back to the SQL text-guard, never to a principal with no rights
// ---------------------------------------------------------------------------------------------------------
test('a GRANT the database refuses routes the plugin through the text-guard instead of a rightless principal', async () => {
    const calls: string[] = [];
    const ctxSeen: any[] = [];
    const { getCurrentPlugin, runWithContext } = require('../core/plugin-context');
    const fakeDriver = {
        all: async () => [], get: async () => undefined, run: async () => ({}),
        ensurePluginUser: async () => { calls.push('create-user'); ctxSeen.push(getCurrentPlugin()); },
        grantPluginPrefixToUser: async () => { calls.push('grant-prefix'); }, // no tables yet: grants nothing, succeeds
        grantPluginTableToUser: async () => { calls.push('grant-table'); throw new Error("GRANT command denied to user 'wjsqa'@'%' for table 'wjp_faq_faqs'"); },
        runAsUser: async () => { calls.push('as-user'); throw new Error("Access denied for user 'wjp_faq'@'%'"); },
        dropPluginUser: async () => { calls.push('drop-user'); },
    };
    const sharedCalls: string[] = [];
    const dbPath = require.resolve('../config/database');
    const fakeDb = {
        getDbType: () => ({ isMySQL: true, isPostgres: false }),
        getDbAsync: () => fakeDriver,
        dbAsync: { all: async (sql: string) => { sharedCalls.push(sql); ctxSeen.push('shared'); return [{ ok: 1 }]; } },
    };
    const prev = require.cache[dbPath];
    const m = new Module(dbPath); m.filename = dbPath; m.loaded = true; m.exports = fakeDb;
    require.cache[dbPath] = m;
    const isoPath = require.resolve('../core/plugin-db-isolation');
    delete require.cache[isoPath];
    try {
        const iso = require('../core/plugin-db-isolation');
        await runWithContext('faq', () => iso.provision('faq'));
        assert.equal(iso.isProvisioned('faq'), true, 'first activation provisions the login user');
        assert.deepStrictEqual(ctxSeen, [null], 'the principal is provisioned as the host, not under the plugin');
        await iso.grantNewTable('faq', 'wjp_faq_faqs');
        assert.equal(iso.isProvisioned('faq'), false, 'a refused GRANT must stop routing through that principal');
        const rows = await iso.runScoped('faq', 'all', 'SELECT * FROM wjp_faq_faqs', []);
        assert.deepStrictEqual(rows, [{ ok: 1 }], 'the query ran on the shared connection (text-guard)');
        assert.ok(!calls.includes('as-user'), 'the rightless principal was used');
    } finally {
        if (prev) require.cache[dbPath] = prev; else delete require.cache[dbPath];
        delete require.cache[isoPath];
    }
});

// ---------------------------------------------------------------------------------------------------------
// S4-14 — dropping a plugin's tables does not depend on the catalog's order
// ---------------------------------------------------------------------------------------------------------
test('every table of a plugin is dropped whatever foreign keys link them, and leftovers are reported', async () => {
    const { dropTablesInDependencyOrder } = require('../core/plugins');
    // parent ← child ← grandchild, listed parent-first as information_schema returns them.
    const refs: Record<string, string[]> = { wjp_cm_events: ['wjp_cm_regs'], wjp_cm_regs: ['wjp_cm_payments'], wjp_cm_payments: [] };
    const alive = new Set(Object.keys(refs));
    const drop = async (t: string) => {
        if ((refs[t] || []).some((c) => alive.has(c))) throw new Error('Cannot delete or update a parent row: a foreign key constraint fails');
        alive.delete(t);
    };
    const r = await dropTablesInDependencyOrder(['wjp_cm_events', 'wjp_cm_payments', 'wjp_cm_regs'], drop);
    assert.deepStrictEqual(r.kept, []);
    assert.deepStrictEqual(r.dropped.sort(), ['wjp_cm_events', 'wjp_cm_payments', 'wjp_cm_regs']);
    assert.equal(alive.size, 0);

    // A table OUTSIDE the plugin still references one of its tables: that one stays, and is reported.
    alive.clear(); ['wjp_cm_events', 'wjp_cm_regs'].forEach((t) => alive.add(t));
    const external = new Set(['wjp_cm_events']);
    const r2 = await dropTablesInDependencyOrder(['wjp_cm_events', 'wjp_cm_regs'], async (t: string) => {
        if (external.has(t)) throw new Error('other objects depend on it');
        alive.delete(t);
    });
    assert.deepStrictEqual(r2.dropped, ['wjp_cm_regs']);
    assert.deepStrictEqual(r2.kept, ['wjp_cm_events']);
    assert.match(String(r2.lastError && r2.lastError.message), /depend/);
});

test('the uninstall route surfaces leftover tables instead of a plain success', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'plugins.ts'), 'utf8');
    assert.match(src, /dropTablesInDependencyOrder\(mine,/, 'uninstallPluginData drops through the dependency-order helper');
    assert.match(src, /result\.tablesKept = dropped\.kept/);
    const page = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'frontend', 'src', 'app', 'admin', 'plugins', 'page.tsx'), 'utf8');
    assert.match(page, /res\?\.cleanup\?\.tablesKept/, 'the admin page reads tablesKept');
    assert.match(page, /plugins\.delete\.tablesKept/);
});

// ---------------------------------------------------------------------------------------------------------
// M4-05 / S4-18 / X4-06 — STARTTLS over an approved private connection
// ---------------------------------------------------------------------------------------------------------
test('TLS over an already-connected socket is not judged again by host (STARTTLS to an approved relay)', () => {
    const eg = require('../core/egress-guard');
    eg.setPrivateDestinations(['192.168.182.192:25']);
    const tls = eg.getGuardedModule('tls');
    // The relay socket was opened (and judged, WITH its port) by net.connect. The upgrade only wraps it.
    const plain = new Duplex({ read() { /* */ }, write(_c: any, _e: any, cb: any) { cb(); } });
    let sock: any;
    assert.doesNotThrow(() => { sock = tls.connect({ socket: plain, host: '192.168.182.192', servername: 'relay.lan', rejectUnauthorized: false }); },
        'the STARTTLS upgrade over the approved connection was refused');
    sock.on('error', () => { /* the fake peer never answers the handshake */ });
    sock.destroy();
    // Without a socket, tls.connect dials by itself: still judged (an unapproved private host is refused).
    assert.throws(() => tls.connect({ host: '10.9.9.9', port: 465 }), /egress|blocked/i);
    // …and with the approved pair it is allowed to dial.
    const direct = tls.connect({ host: '192.168.182.192', port: 25, rejectUnauthorized: false });
    direct.on('error', () => { /* nothing listens in the test */ });
    direct.destroy();
    eg.setPrivateDestinations([]);
});

test('a getter cannot flip the socket away after the check (TOCTOU)', () => {
    const eg = require('../core/egress-guard');
    const tls = eg.getGuardedModule('tls');
    const plain = new Duplex({ read() { /* */ }, write(_c: any, _e: any, cb: any) { cb(); } });
    let reads = 0;
    const opts: any = { host: '10.9.9.9', port: 443, rejectUnauthorized: false };
    Object.defineProperty(opts, 'socket', { get() { reads++; return reads === 1 ? plain : undefined; }, configurable: true, enumerable: true });
    const s = tls.connect(opts);
    s.on('error', () => { /* */ });
    assert.strictEqual(Object.getOwnPropertyDescriptor(opts, 'socket')!.value, plain, 'the socket must be pinned as the value that was checked');
    s.destroy();
});

// ---------------------------------------------------------------------------------------------------------
// M4-04 / S4-19 / X4-05 — the multipart upload is staged where the plugin can read it
// ---------------------------------------------------------------------------------------------------------
test("uploads are staged in the plugin's own private tmp storage, readable for that plugin only", () => {
    const { uploadStagingDir, privateStorageDirs } = require('../core/sandbox-paths');
    const { isStagedUploadRead } = require('../core/io-guard');
    const root = path.resolve(__dirname, '..', '..');
    const dir = uploadStagingDir(root, 'mail-server', 1);
    assert.equal(path.dirname(dir), privateStorageDirs(root, 'mail-server', 1)[2], 'under the plugin\'s os-tmp storage');
    const file = path.join(dir, 'b88a3d59');
    assert.equal(isStagedUploadRead('mail-server', file, false), true);
    assert.equal(isStagedUploadRead('mail-server', file, true), false, 'writes stay gated like any storage');
    assert.equal(isStagedUploadRead('other-plugin', file, false), false, "another plugin's staged upload is not readable");
    assert.equal(isStagedUploadRead('mail-server', path.join(dir, '..', 'secret.json'), false), false, 'only the staging dir');
    assert.equal(isStagedUploadRead('mail-server', path.join(require('os').tmpdir(), 'wordjs-uploads', 'x'), false), false);
    assert.equal(isStagedUploadRead('theme:x', file, false), false);
    // Site 2's worker stages in its own storage, not site 1's.
    assert.notEqual(uploadStagingDir(root, 'mail-server', 2), dir);
});

test('the host mounts multipart routes on the per-plugin staging dir, not the OS temp dir', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'plugin-isolate.ts'), 'utf8');
    assert.match(src, /uploadStagingDir\(path\.resolve\(__dirname, '\.\.', '\.\.'\), slug, siteId\)/);
    assert.match(src, /multer\(\{ dest: stagingDir,/);
    assert.doesNotMatch(src, /multer\(\{ dest: path\.join\(os\.tmpdir\(\)/);
});

// ---------------------------------------------------------------------------------------------------------
// FALLOS 112 — "Restart plugin" recovers an ACTIVE plugin that failed to start
// ---------------------------------------------------------------------------------------------------------
test('restarting an active plugin with no running isolate starts it instead of answering 404', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'plugins.ts'), 'utf8');
    const route = src.slice(src.indexOf("router.post('/:slug/reload'"), src.indexOf("router.post('/:slug/reload'") + 2500);
    assert.match(route, /if \(!isIsolated\(slug\)\) \{[\s\S]*?isPluginActive\(slug\)[\s\S]*?loadOnePlugin\(slug\)/,
        'a stopped active plugin must be started through the full load pipeline');
    assert.match(route, /status\(404\)[\s\S]*?is it active\?/, 'an inactive plugin still answers 404');
    // The card shows why a stopped plugin is stopped (its runtime.lastError), next to that button.
    const page = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'frontend', 'src', 'app', 'admin', 'plugins', 'page.tsx'), 'utf8');
    assert.match(page, /\(isCrashLooping \|\| isRefused \|\| isStopped\) && plugin\.runtime\?\.lastError/);
});

// ---------------------------------------------------------------------------------------------------------
// FALLOS 116 — deactivating a plugin must never uninstall a dependency the core (or another plugin) uses
// ---------------------------------------------------------------------------------------------------------
test('the dependency GC never removes a core dependency or one another active plugin needs', () => {
    const fs = require('fs');
    const { selectPrunableDependencies, isLoadedByHost } = require('../core/plugins');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    const coreDeps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) });
    assert.ok(coreDeps.includes('uuid'), 'uuid is a core dependency (routes/media requires it)');

    // card-gallery / photo-carousel / video-gallery declare uuid: deactivating the last of them kept removing it.
    // Whatever the ledger says, nothing the release's package.json declares is ever chosen when the plugin
    // installer did not add it — and the installer never adds a package that is already present.
    const none = selectPrunableDependencies(coreDeps, { usedByOtherPlugins: new Set(), installedByPlugins: new Set(), loadedByHost: () => false });
    assert.deepStrictEqual(none, [], 'a core dependency was selected for uninstall');

    // A package the installer did add is still kept while the host has loaded it…
    require('uuid');
    assert.equal(isLoadedByHost('uuid'), true);
    assert.deepStrictEqual(selectPrunableDependencies(['uuid'], { usedByOtherPlugins: new Set(), installedByPlugins: new Set(['uuid']), loadedByHost: isLoadedByHost }), []);
    // …or while another active plugin declares it.
    assert.deepStrictEqual(selectPrunableDependencies(['left-pad'], { usedByOtherPlugins: new Set(['left-pad']), installedByPlugins: new Set(['left-pad']), loadedByHost: () => false }), []);
    // Only a package the installer added, nobody else uses and the host never loaded is removed.
    assert.deepStrictEqual(selectPrunableDependencies(['left-pad', 'uuid'], { usedByOtherPlugins: new Set(), installedByPlugins: new Set(['left-pad']), loadedByHost: isLoadedByHost }), ['left-pad']);
});

test('the GC asks the ledger, the host and the other plugins before uninstalling', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'plugins.ts'), 'utf8');
    const prune = src.slice(src.indexOf('async function prunePluginDependencies'), src.indexOf('const PLUGINS_DIR_REAL'));
    assert.match(prune, /selectPrunableDependencies\(Object\.keys\(manifest\.dependencies\), \{[\s\S]*?installedByPlugins: readPluginInstalledDeps\(\),[\s\S]*?loadedByHost: isLoadedByHost/);
    assert.doesNotMatch(prune, /isLikelyCore/, 'the hard-coded shield list is gone');
    assert.match(src, /recordPluginInstalledDeps\(slug,/, 'installs are recorded');
});

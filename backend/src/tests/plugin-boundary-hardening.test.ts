/**
 * The plugin boundary, pinned where it was widened by one detail:
 *   egress   — an IPv6 address embedding a public IPv4 still obeys the IPv6 prefix rules; SIIT is judged.
 *   require  — a core module named by an ABSOLUTE path (or another letter case) is judged like `./x`.
 *   streams  — an inherited `fd` on Object.prototype never reaches a file stream.
 *   cron     — a plugin cannot take over an event it does not own, and a recurrence is a plain name.
 *   shortcodes, notification transports, GraphQL SDL, option names — the shapes a plugin may register.
 *   scanner  — only the top-level node_modules is the dependency folder; re-exports and computed
 *              `process['…']` are read like their plain spellings; symbolic links are not followed.
 *   manifest — a permission removed by an update stops counting at once.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-boundary-${process.pid}-`));
config.dbPath = path.join(TMP_DIR, 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* */ }
});

test('egress: an embedded public IPv4 never clears an IPv6 address the prefix rules block', () => {
    const { isBlockedIp } = require('../core/egress-guard');
    for (const ip of ['fe80::5efe:1.1.1.1', 'fc00::5efe:8.8.8.8', 'fd12:3456::200:5efe:8.8.8.8', 'fec0::5efe:8.8.8.8', 'ff02::5efe:8.8.8.8']) {
        assert.strictEqual(isBlockedIp(ip), true, ip);
    }
    // SIIT (::ffff:0:a.b.c.d) is judged by its IPv4.
    assert.strictEqual(isBlockedIp('::ffff:0:127.0.0.1'), true);
    assert.strictEqual(isBlockedIp('::ffff:0:169.254.169.254'), true);
    // Public destinations stay public.
    assert.strictEqual(isBlockedIp('2001:4860:4860::8888'), false);
    assert.strictEqual(isBlockedIp('::ffff:8.8.8.8'), false);
    assert.strictEqual(isBlockedIp('2002:0808:0808::1'), false);
});

test('streams: a polluted Object.prototype.fd is not handed to createReadStream', () => {
    const { guardFsCall } = require('../core/secure-require');
    const args: any[] = ['/tmp/x', { encoding: 'utf8' }];
    (Object.prototype as any).fd = 3;
    try {
        try { guardFsCall('zz-boundary', 'createReadStream', args); } catch { /* the path check may refuse: irrelevant here */ }
        const opts = args[1];
        assert.ok(Object.prototype.hasOwnProperty.call(opts, 'fd'), 'the snapshot carries its own fd slot');
        assert.strictEqual(opts.fd, undefined, 'an own undefined shadows the inherited fd');
    } finally { delete (Object.prototype as any).fd; }
});

test('require: the policy vocabularies cannot be emptied', () => {
    const sr = require('../core/secure-require');
    assert.ok(Object.isFrozen(sr.BLOCKED_PLUGIN_MODULES));
    assert.ok(Object.isFrozen(sr.FS_WRITE_METHODS) && Object.isFrozen(sr.FS_READ_METHODS) && Object.isFrozen(sr.FS_LINK_DENIED));
    assert.throws(() => sr.NETWORK_MODULES.clear());
    assert.throws(() => sr.NETWORK_MODULES.delete('net'));
    assert.ok(sr.NETWORK_MODULES.has('net'));
});

test('require: a core module named by an absolute path or another letter case is judged like ./x', () => {
    const src = fs.readFileSync(path.join(__dirname, '../core/secure-require.ts'), 'utf8');
    assert.match(src, /if \(!\(request\[0\] === '\.' \|\| path\.isAbsolute\(request\) \|\| \/\^file:\/i\.test\(request\)\)\) return undefined;/);
    assert.match(src, /'egress-guard', 'egress-tunnel-client',/);
    assert.match(src, /\]\.map\(n => foldCase\(path\.join\(CORE_DIR, n\)\)\)\);/);
});

test('worker: the IPC primitive is pinned, the undici dispatcher is inert without network, import() judges the resolved target', () => {
    const src = fs.readFileSync(path.join(__dirname, '../core/plugin-worker.js'), 'utf8');
    assert.match(src, /for \(const k of \['_send', '_disconnect'\]\)/);
    assert.match(src, /Object\.defineProperty\(process, k, \{ value: v, writable: false, configurable: false, enumerable: false \}\)/);
    assert.match(src, /pinInertDispatcher\(`network is blocked for plugin/);
    assert.match(src, /for \(const k of \['undici\.globalDispatcher\.1', 'undici\.globalDispatcher\.2'\]\)/);
    assert.match(src, /const res = nextResolve\(specifier, context\);/);
    assert.match(src, /if \(url\.startsWith\('node:'\) && blockedName\(url\.slice\(5\)\)\) refuse\(\);/);
    assert.match(src, /if \(\/\^data:\/i\.test\(String\(specifier\)\)\) refuse\(\);/);
    assert.match(src, /for \(const k of \['registerHooks', 'register'\]\)/);
    assert.match(src, /eg\.sealEgressPolicy\(\)/);
});

test('egress: the child policy is sealed once installed', () => {
    const src = fs.readFileSync(path.join(__dirname, '../core/egress-guard.ts'), 'utf8');
    assert.match(src, /export function setAllowedHosts\(list: any\): void \{\r?\n {4}assertPolicyOpen\(\);/);
    assert.match(src, /export function setPrivateDestinations\(list: any\): void \{\r?\n {4}assertPolicyOpen\(\);/);
});

test('cron: a plugin never replaces an event it does not own, and a recurrence is a plain name', async () => {
    const cron = require('../core/cron');
    const { runWithContext } = require('../core/plugin-context');
    const options = require('../core/options');
    const ts = 4102444800000; // 2100-01-01, never due during the test
    // A core event in a slot a plugin will aim at.
    await cron.scheduleSingleEvent(ts, 'zz_boundary_core_hook', []);
    let err: any = null;
    try {
        await runWithContext('zz-boundary', () => cron.scheduleSingleEvent(ts, 'zz_boundary_core_hook', []));
    } catch (e) { err = e; }
    // Either refused for ownership, or refused earlier for a missing settings grant: never a takeover.
    const events = await options.getOption('cron', {});
    const slot = events && events[ts] && events[ts]['zz_boundary_core_hook_[]'];
    assert.ok(slot, 'the core event is still there');
    assert.strictEqual(slot.pluginSlug == null, true, 'still owned by core');
    if (err) assert.match(String(err.message), /belongs to someone else|permission|denied/i);
    await assert.rejects(() => cron.scheduleEvent(ts + 1, { evil: 'x'.repeat(10) }, 'zz_boundary_hook', []), /recurrence/);
    await assert.rejects(() => cron.scheduleEvent(ts + 1, 'x'.repeat(65), 'zz_boundary_hook', []), /recurrence/);
    try { await cron.unscheduleEvent(ts, 'zz_boundary_core_hook', []); } catch { /* cleanup */ }
});

test('shortcodes: a tag is a plain name', () => {
    const sc = require('../core/shortcodes');
    sc.addShortcode('', () => 'x');
    sc.addShortcode(123 as any, () => 'x');
    sc.addShortcode('bad tag', () => 'x');
    assert.strictEqual(sc.shortcodeExists(''), false);
    assert.strictEqual(sc.doShortcode('[a] [b]'), '[a] [b]', 'no empty tag captures every [');
    sc.addShortcode('zz-boundary_ok', () => 'ok');
    assert.strictEqual(sc.doShortcode('[zz-boundary_ok]'), 'ok');
    sc.removeShortcode('zz-boundary_ok');
});

test('notifications: a plugin transport never replaces a core one, and a link is http(s) or a site path', async () => {
    const notifications = require('../core/notifications');
    const { runWithContext } = require('../core/plugin-context');
    assert.throws(() => runWithContext('zz-boundary', () => notifications.registerTransport('db', () => undefined)), /provided by WordJS/);
    assert.throws(() => runWithContext('zz-boundary', () => notifications.registerTransport('', () => undefined)), /invalid name/);
    const src = fs.readFileSync(path.join(__dirname, '../core/notifications.ts'), 'utf8');
    assert.match(src, /action_url: safeActionUrl\(data\.action_url\)/);
});

test('GraphQL: a plugin adds new types and the Query fields it routes — nothing that changes what exists', () => {
    const { buildPluginExtension } = require('../core/graphql/plugin-bridge');
    const build = (typeDefs: string, fields: any = { 'Query.zzBooks': { path: '/books' } }) => buildPluginExtension('zz-boundary', 1, { typeDefs, fields }, () => null);
    assert.strictEqual(typeof build('type ZzBook { id: Int } extend type Query { zzBooks: [ZzBook] }'), 'object');
    for (const sdl of [
        'extend input ContentInput { _break: String! } extend type Query { zzBooks: Int }',
        'extend type Post { secret: String } extend type Query { zzBooks: Int }',
        'extend enum PostStatus { HIJACK } extend type Query { zzBooks: Int }',
        'extend type Query { zzBooks: Int zzUnrouted: Int }',
        'directive @zz on FIELD_DEFINITION extend type Query { zzBooks: Int }',
        'schema { query: ZzQ } type ZzQ { zzBooks: Int }',
        'type Query { zzBooks: Int }',
    ]) {
        assert.strictEqual(typeof build(sdl), 'string', `refused: ${sdl}`);
    }
});

test('options: backups, the cache switch and certificates are never a plugin namespace', () => {
    const { isPluginWritableOption } = require('../core/plugin-owned-options');
    for (const [slug, key] of [['backup', 'backup_schedule'], ['backup', 'backup_retention'], ['auto', 'auto_backup'], ['redis', 'redis_cache_enabled'], ['acme', 'acme_last_renewal']]) {
        assert.strictEqual(isPluginWritableOption(slug, key), false, `${slug} → ${key}`);
    }
});

test('scanner: only the top-level node_modules is the dependency folder', () => {
    const { isScannerSkippedDir, isUnscannedCodePath } = require('../core/scan-exclusions');
    assert.strictEqual(isScannerSkippedDir('node_modules', false, 0), true);
    assert.strictEqual(isScannerSkippedDir('node_modules', false, 2), false, 'a nested node_modules is scanned as the plugin\'s own code');
    assert.strictEqual(isScannerSkippedDir('my_node_modules', false, 0), false);
    assert.strictEqual(isUnscannedCodePath(['node_modules', 'x', 'index.js'], false), false);
    assert.strictEqual(isUnscannedCodePath(['my_node_modules', 'dist', 'x.js'], false), true, 'a skipped dir below a look-alike still counts');
});

test('scanner: re-exports and computed process members are read; symbolic links are not followed', () => {
    const core = require('../core/plugins');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-boundary-scan-'));
    try {
        const manifest = { name: 'zz-boundary-scan', version: '1.0.0', permissions: [] };
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        const scan = (code: string, file = 'index.mjs') => {
            fs.writeFileSync(path.join(dir, file), code);
            try { core.validatePluginPermissions('zz-boundary-scan', dir, manifest); return 'clean'; }
            catch (e: any) { return String(e && e.message); }
            finally { fs.rmSync(path.join(dir, file), { force: true }); }
        };
        assert.notStrictEqual(scan("export * from 'child_process';\n"), 'clean');
        assert.notStrictEqual(scan("export { exec } from 'child_process';\n"), 'clean');
        assert.notStrictEqual(scan("const b = process['binding'];\n", 'index.js'), 'clean');
        fs.mkdirSync(path.join(dir, 'lib', 'node_modules', 'x'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'lib', 'node_modules', 'x', 'index.js'), "require('child_process').exec('id');\n");
        assert.notStrictEqual(scan('module.exports = 1;\n', 'index.js'), 'clean', 'a nested node_modules is read');
        fs.rmSync(path.join(dir, 'lib'), { recursive: true, force: true });
        // A link loop must not hang or overflow the walk.
        try { fs.symlinkSync(dir, path.join(dir, 'loop'), 'junction'); } catch { /* links unavailable here */ }
        assert.strictEqual(scan('module.exports = 1;\n', 'index.js'), 'clean');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manifest: dropping io-guard\'s cached declaration drops the bridge\'s too', () => {
    const src = fs.readFileSync(path.join(__dirname, '../core/io-guard.ts'), 'utf8');
    assert.match(src, /require\('\.\/plugin-context'\)\.forgetPluginDeclaration\(pluginSlug\)/);
    const ctx = require('../core/plugin-context');
    assert.strictEqual(typeof ctx.forgetPluginDeclaration, 'function');
});

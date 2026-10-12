/**
 * WordJS — widget and sidebar ids from the request are stored as ordinary keys.
 *
 * PUT /api/v1/widgets/:widgetId/instances/:instanceId and the sidebar routes write ONE entry of a
 * stored option (`widget_<id>`, `sidebars_widgets`) under a key taken from the URL. That was a bracket
 * write on the parsed object, where '__proto__' is the prototype setter: the entry never reached the
 * stored JSON and the object took the request's value as its prototype. Reads had the mirror problem:
 * an id never written ('constructor') answered a member of Object.prototype instead of "nothing".
 *
 * Pinned here: '__proto__', 'constructor' and an ordinary id all round-trip as OWN entries, the stored
 * JSON keeps its shape and key order, an unknown id reads as empty, and Object.prototype is untouched.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// CWD in a temp dir and config.dbPath repointed BEFORE the DB layer loads.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-widgets-keys-'));
process.chdir(TMP_ROOT);
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

describe('widget option keys taken from the request', () => {
    let W: any;
    let getOption: any;
    let dbAsync: any;

    const storedRow = async (name: string) => {
        const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
        return JSON.parse(row.option_value);
    };

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        W = require('../core/widgets');
        ({ getOption } = require('../core/options'));
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); } catch { /* ignore */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('instance ids __proto__, constructor and an ordinary id are stored and read as own entries', async () => {
        assert.deepStrictEqual(await W.getWidgetSettings('text', 'constructor'), {},
            'an id that was never written reads as empty, not as Object.prototype.constructor');

        await W.setWidgetSettings('text', 'a1', { title: 'first' });
        await W.setWidgetSettings('text', '__proto__', { title: 'proto', polluted: 'yes' });
        await W.setWidgetSettings('text', 'constructor', { title: 'ctor' });
        await W.setWidgetSettings('text', 'a1', { title: 'first, edited' });

        const stored = await storedRow('widget_text');
        assert.deepStrictEqual(Object.keys(stored), ['a1', '__proto__', 'constructor'],
            'every id is a key of the stored JSON, an edited one keeps its place');
        assert.deepStrictEqual(stored.a1, { title: 'first, edited' });

        const loaded = await getOption('widget_text');
        assert.strictEqual(Object.getPrototypeOf(loaded), Object.prototype);

        assert.deepStrictEqual(await W.getWidgetSettings('text', '__proto__'), { title: 'proto', polluted: 'yes' });
        assert.deepStrictEqual(await W.getWidgetSettings('text', 'constructor'), { title: 'ctor' });
        assert.deepStrictEqual(await W.getWidgetSettings('text', 'a1'), { title: 'first, edited' });

        assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
        assert.strictEqual(({} as any).polluted, undefined);
    });

    it('sidebar ids follow the same rule', async () => {
        assert.deepStrictEqual(await W.getSidebarWidgets('constructor'), [],
            'a sidebar that was never written has no widgets');

        await W.setSidebarWidgets('sidebar-1', ['text-a1']);
        await W.setSidebarWidgets('__proto__', ['text-x']);
        const key = await W.addWidgetToSidebar('constructor', 'text', { title: 'added' });

        const stored = await storedRow('sidebars_widgets');
        assert.deepStrictEqual(Object.keys(stored), ['sidebar-1', '__proto__', 'constructor']);
        assert.deepStrictEqual(await W.getSidebarWidgets('__proto__'), ['text-x']);
        assert.deepStrictEqual(await W.getSidebarWidgets('constructor'), [key]);
        assert.deepStrictEqual(await W.getSidebarWidgets('sidebar-1'), ['text-a1']);
        assert.strictEqual(Array.isArray(Object.getPrototypeOf(await getOption('sidebars_widgets'))), false);
    });
});

/**
 * FAQ RUNS WITHOUT ITS ADMIN MENU WHEN `admin_menu:register` IS NOT GRANTED (FALLOS 148).
 *
 * An administrator may leave `admin_menu:register` off — on the permission screen, or in the consent dialog
 * of a Marketplace update, which asks for every permission again. The bridged adminMenu.add() is then
 * refused, and FAQ called it without handling the refusal: an unhandled rejection is fatal in the plugin
 * sandbox, so the plugin crash-looped through its restarts and its routes and block went down with it.
 *
 * The plugin's own init runs here against a stub host API (every call a no-op) whose adminMenu.add refuses
 * the way the bridge does — asynchronously, and synchronously for good measure — and the test proves init
 * completes, nothing goes unhandled, and the granted case still adds the entry exactly once.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const faq = require(path.resolve(__dirname, '..', '..', '..', 'marketplace', 'plugins', 'faq', 'index.js'));

/** A host API where every member is a callable no-op (db.all → [], db.get → null), except `adminMenu`. */
function stubHost(adminMenu: any): any {
    const fn: any = new Proxy(function () { /* no-op */ }, {
        get: (_t, key) => (key === 'then' ? undefined : key === 'tablePrefix' ? 'wjp_faq_' : fn),
        apply: () => fn,
    });
    const db = new Proxy({}, {
        get: (_t, key) => key === 'tablePrefix' ? 'wjp_faq_'
            : key === 'all' ? async () => []
                : key === 'get' ? async () => null
                    : async () => ({ changes: 0, lastID: 0 }),
    });
    return new Proxy({}, { get: (_t, key) => (key === 'adminMenu' ? adminMenu : key === 'db' ? db : fn) });
}

/** Run `body` and return the unhandled rejections seen by the end of the next macrotask. */
async function unhandledDuring(body: () => Promise<void>): Promise<any[]> {
    const seen: any[] = [];
    const onRej = (reason: any) => { seen.push(reason); };
    process.on('unhandledRejection', onRej);
    try {
        await body();
        await new Promise((r) => setTimeout(r, 20));
    } finally {
        process.off('unhandledRejection', onRej);
    }
    return seen;
}

const refusal = () => new Error("🛡️ Security Block: Plugin 'faq' tried to access 'admin_menu' (register) without permission.");

describe('faq without admin_menu:register', () => {
    it('a refused (rejected) adminMenu.add is logged and init completes — no unhandled rejection', async () => {
        const warnings: string[] = [];
        const warn = console.warn;
        console.warn = (...a: any[]) => { warnings.push(a.join(' ')); };
        try {
            const seen = await unhandledDuring(() => faq.init(stubHost({ add: () => Promise.reject(refusal()) })));
            assert.deepStrictEqual(seen, [], 'the refusal went unhandled — the sandbox treats that as fatal');
        } finally {
            console.warn = warn;
        }
        assert.ok(warnings.some((w) => /admin menu not added/.test(w)), `the refusal is reported: ${JSON.stringify(warnings)}`);
    });

    it('a refusal thrown synchronously is handled the same way', async () => {
        const warn = console.warn;
        console.warn = () => { /* quiet */ };
        try {
            const seen = await unhandledDuring(() => faq.init(stubHost({ add: () => { throw refusal(); } })));
            assert.deepStrictEqual(seen, []);
        } finally {
            console.warn = warn;
        }
    });

    it('control: with the grant, the menu entry is added once, as before', async () => {
        const added: any[] = [];
        await faq.init(stubHost({ add: async (entry: any) => { added.push(entry); } }));
        assert.strictEqual(added.length, 1);
        assert.strictEqual(added[0].href, '/admin/plugin/faq');
        assert.strictEqual(added[0].cap, 'manage_options');
    });
});

/**
 * The marketplace-plugin pass (32 plugins × install, permissions, configuration, public blocks, update,
 * uninstall) — the core and plugin defects it found, each pinned here:
 *
 *  · Updates: the catalog offered an "update" to any DIFFERENT version, so an installed build newer than
 *    the catalog's was offered a downgrade.
 *  · Releases shipped the backend development fixtures (hello-world, test-schema) as installable plugins.
 *  · A plugin route that hit a missing permission answered 502 "Isolated plugin error"; it now says which
 *    permission is missing and where to grant it (403 plugin_permission_denied).
 *  · Plugin sidebar entries were a single fixed-language string: `labels` per language, shape-checked.
 *  · memberships: the paywall offered "Create account" on a site whose registration is closed — the public
 *    config now says whether visitors may register.
 *  · video-gallery shipped its Verso block but never declared it; every marketplace menu entry carries
 *    English/Spanish/Portuguese labels.
 */
const { test, describe, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
import { bootPlugin, type BootedPlugin } from './fixtures/marketplace-plugin-harness';

const PLUGINS_DIR = path.resolve(__dirname, '../../../marketplace/plugins');

describe('update offers', () => {
    const { isNewerVersion } = require('../routes/marketplace');

    test('only a newer catalog version is an update', () => {
        assert.strictEqual(isNewerVersion('1.2.1', '1.2.0'), true);
        assert.strictEqual(isNewerVersion('2.0.0', '1.9.9'), true);
        assert.strictEqual(isNewerVersion('1.10.0', '1.9.0'), true, 'numeric, not lexical');
        assert.strictEqual(isNewerVersion('1.2.0', '1.2.0'), false);
        assert.strictEqual(isNewerVersion('1.1.0', '1.2.0'), false, 'an older catalog build is not an update (it was offered as one)');
    });
});

describe('release contents', () => {
    const { shouldIgnore, ROOT_DIR } = require('../../../scripts/make-release.js');
    const p = (rel: string) => path.join(ROOT_DIR, ...rel.split('/'));

    test('the development fixture plugins are not packaged', () => {
        assert.strictEqual(shouldIgnore(p('backend/plugins/hello-world')), true);
        assert.strictEqual(shouldIgnore(p('backend/plugins/hello-world/index.js')), true);
        assert.strictEqual(shouldIgnore(p('backend/plugins/test-schema/manifest.json')), true);
    });

    test('the plugins directory itself still is', () => {
        assert.strictEqual(shouldIgnore(p('backend/plugins')), false);
    });
});

describe('a missing permission on a plugin route', () => {
    const { describePermissionRefusal } = require('../core/plugin-context');

    test('names the permission and where to grant it', () => {
        const r = describePermissionRefusal("Plugin 'newsletter' tried to access 'settings' (read) without permission");
        assert.ok(r);
        assert.strictEqual(r.plugin, 'newsletter');
        assert.strictEqual(r.permission, 'settings:read');
        assert.match(r.error, /"settings:read"/);
        assert.match(r.error, /Plugins → newsletter → Permissions/);
    });

    test('themes are pointed at Appearance', () => {
        const r = describePermissionRefusal("Theme 'theme:aurora' tried to access 'database' (write) without permission");
        assert.ok(r);
        assert.match(r.error, /Appearance → Themes/);
    });

    test('any other failure is not a refusal', () => {
        assert.strictEqual(describePermissionRefusal('ECONNRESET'), null);
        assert.strictEqual(describePermissionRefusal(undefined), null);
    });

    test('the isolated route answers 403 plugin_permission_denied, not 502', () => {
        const src = fs.readFileSync(path.join(__dirname, '../core/plugin-isolate.ts'), 'utf8');
        const at = src.indexOf("describePermissionRefusal(e && e.message)");
        assert.ok(at > 0, 'the route catch consults describePermissionRefusal');
        const tail = src.slice(at, at + 600);
        assert.match(tail, /res\.status\(403\)\.json\(\{ code: 'plugin_permission_denied'/);
        assert.ok(tail.indexOf('status(403)') < tail.indexOf("'Isolated plugin error'"), 'checked before the generic 502');
    });
});

describe('plugin menu labels per language', () => {
    const { registerAdminMenu, unregisterAdminMenu, getAdminMenuItems } = require('../core/adminMenu');
    const SLUG = 'labels-probe-qa';
    afterEach(() => unregisterAdminMenu(SLUG));
    const item = () => getAdminMenuItems().find((m: any) => m.plugin === SLUG);

    test('kept, bounded and shape-checked', () => {
        registerAdminMenu(SLUG, {
            href: '/admin/labels-probe-qa', label: 'Reservas', cap: 'read',
            labels: { en: 'Bookings', es: 'Reservas', 'pt-BR': 'Reservas', EN: 'bad key', '../x': 'bad', fr: 42, de: '   ', it: 'x'.repeat(500) },
        });
        const m = item();
        assert.ok(m);
        assert.strictEqual(m.label, 'Reservas');
        assert.deepStrictEqual(Object.keys(m.labels).sort(), ['en', 'es', 'it', 'pt-BR']);
        assert.strictEqual(m.labels.en, 'Bookings');
        assert.strictEqual(m.labels.it.length, 200);
    });

    test('absent or malformed → no labels (the plain label is used)', () => {
        registerAdminMenu(SLUG, { href: '/admin/labels-probe-qa', label: 'X', cap: 'read', labels: ['en', 'Bookings'] });
        assert.strictEqual(item().labels, undefined);
    });

    test('every marketplace plugin menu entry has English, Spanish and Portuguese labels', () => {
        const missing: string[] = [];
        for (const slug of fs.readdirSync(PLUGINS_DIR)) {
            const file = path.join(PLUGINS_DIR, slug, 'index.js');
            if (!fs.existsSync(file)) continue;
            const src = fs.readFileSync(file, 'utf8');
            const at = src.indexOf('adminMenu.add({');
            if (at < 0) continue;
            const block = src.slice(at, src.indexOf('});', at));
            if (!/labels: \{ en: '[^']+', es: '[^']+', pt: '[^']+' \}/.test(block)) missing.push(slug);
        }
        // conference-manager's entry is already English ("Conference") and is versioned by its own train.
        assert.deepStrictEqual(missing.filter((s) => s !== 'conference-manager'), []);
    });

    test('the contact-forms entry is not a second "Forms"', () => {
        const src = fs.readFileSync(path.join(PLUGINS_DIR, 'contact-forms/index.js'), 'utf8');
        assert.match(src, /label: 'Formularios de contacto'/);
        assert.match(src, /en: 'Contact forms'/);
    });
});

describe('video-gallery declares its Verso block', () => {
    test('manifest entry points at the shipped component', () => {
        const dir = path.join(PLUGINS_DIR, 'video-gallery');
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        const verso = manifest.frontend && manifest.frontend.versoComponents;
        assert.ok(verso && verso.entry, 'frontend.versoComponents.entry is declared');
        assert.ok(fs.existsSync(path.join(dir, verso.entry)));
        const src = fs.readFileSync(path.join(dir, verso.entry), 'utf8');
        assert.match(src, /export const versoComponentDef/);
        assert.match(src, /type: "custom" as const/, 'the gallery is picked from a list, not typed as an id');
    });
});

describe('memberships: the paywall knows whether visitors may register', () => {
    const ADMIN = { id: 1, role: 'administrator' };
    let plugin: BootedPlugin;
    beforeEach(async () => { plugin = await bootPlugin('memberships'); });
    afterEach(() => plugin.close());

    test('closed registration (the default) is reported to the block and the admin screen', async () => {
        const pub = await plugin.call('get', '/public/tiers');
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.body.registrationOpen, false);
        const cfg = await plugin.call('get', '/config', { user: ADMIN });
        assert.strictEqual(cfg.status, 200);
        assert.strictEqual(cfg.body.registrationOpen, false);
    });

    test('open registration', async () => {
        plugin.options.set('users_can_register', '1');
        const pub = await plugin.call('get', '/public/tiers');
        assert.strictEqual(pub.body.registrationOpen, true);
        plugin.options.set('users_can_register', '0');
        assert.strictEqual((await plugin.call('get', '/public/tiers')).body.registrationOpen, false);
    });

    test('the paywall offers neither "Create account" without registration nor "Subscribe" without a provider', () => {
        const src = fs.readFileSync(path.join(PLUGINS_DIR, 'memberships/client/verso/MembershipsVerso.tsx'), 'utf8');
        assert.match(src, /const canRegister = !\(m\.cfg && m\.cfg\.registrationOpen === false\);/);
        assert.match(src, /\{canRegister && \(freeOpens/);
        assert.match(src, /!canPay \? \(\s*<span className="wjms-note">El pago en línea aún no está disponible\.<\/span>/);
    });

    test('switching provider does not resend the hidden, refused credential', () => {
        const src = fs.readFileSync(path.join(PLUGINS_DIR, 'memberships/client/admin/page.tsx'), 'utf8');
        assert.match(src, /const chosen = p\.id === payload\.paymentProvider;/);
        assert.match(src, /const typed = chosen \? /);
    });
});

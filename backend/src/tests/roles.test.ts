/**
 * WordJS - Roles & Capabilities Tests
 *
 * Guards the regression where the role→capability map was never seeded (config.roles was hardcoded
 * to {}), so getRoles() returned an empty map and EVERY role — administrator included — resolved to
 * zero capabilities. That produced a 403 on capability-gated routes (e.g. GET /api/v1/users), an
 * auto-logout in the admin UI, and an empty admin Roles page. The fix: built-in DEFAULT_ROLES used
 * as the fallback, plus an administrator all-caps ('*') short-circuit in the User model.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { getRoles } = require('../core/roles');
const User = require('../models/User');

const makeUser = (role: string) => {
    const u = new User({});
    u.role = role;
    return u;
};

describe('Roles & Capabilities', () => {
    it('exposes the five core roles by default (no seeding required)', () => {
        const roles = getRoles();
        for (const slug of ['administrator', 'editor', 'author', 'contributor', 'subscriber']) {
            assert.ok(roles[slug], `core role missing: ${slug}`);
            assert.ok(Array.isArray(roles[slug].capabilities), `${slug} has no capabilities array`);
        }
    });

    it('administrator implicitly holds every capability', () => {
        const admin = makeUser('administrator');
        assert.equal(admin.can('list_users'), true);
        assert.equal(admin.can('manage_options'), true);
        assert.equal(admin.can('some_unknown_future_cap'), true);
        assert.deepEqual(admin.getCapabilities(), ['*']);
    });

    it('editor can edit posts but not manage options or list users', () => {
        const editor = makeUser('editor');
        assert.equal(editor.can('edit_posts'), true);
        assert.equal(editor.can('access_admin_panel'), true);
        assert.equal(editor.can('manage_options'), false);
        assert.equal(editor.can('list_users'), false);
    });

    it('subscriber can only read (no post editing, no admin options)', () => {
        const subscriber = makeUser('subscriber');
        assert.equal(subscriber.can('read'), true);
        assert.equal(subscriber.can('edit_posts'), false);
        assert.equal(subscriber.can('manage_options'), false);
    });
});

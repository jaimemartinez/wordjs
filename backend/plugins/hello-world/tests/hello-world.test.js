/**
 * Hello World Plugin - Unit Tests
 *
 * The plugin's own tests, for its author: run them with
 *   node --test backend/plugins/hello-world/tests/hello-world.test.js
 * WordJS does NOT run them at activation — a plugin's test files are code, and the host never executes
 * plugin code outside the sandbox. Keep tests like these in your plugin and run them in your own CI.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const plugin = require('../index.js');

describe('Hello World Plugin', () => {

    it('exports init, deactivate and metadata', () => {
        assert.strictEqual(typeof plugin.init, 'function');
        assert.strictEqual(typeof plugin.deactivate, 'function');
        assert.ok(plugin.metadata && plugin.metadata.name);
        assert.match(plugin.metadata.version, /^\d+\.\d+\.\d+$/);
    });

    it('registers the [hello] shortcode through the bridge', () => {
        const registered = {};
        const bridge = { shortcodes: { add: (tag, handler) => { registered[tag] = handler; } } };
        plugin.init(bridge);
        assert.strictEqual(typeof registered.hello, 'function');
        assert.strictEqual(registered.hello({ name: 'Ada' }, '', 'hello'), '<p class="hello-world-greeting">Hello, Ada!</p>');
    });

    it('greets the world by default and escapes the name', () => {
        assert.strictEqual(plugin.renderHello({}), '<p class="hello-world-greeting">Hello, world!</p>');
        assert.strictEqual(plugin.renderHello({ name: '<b>x</b>' }), '<p class="hello-world-greeting">Hello, &lt;b&gt;x&lt;/b&gt;!</p>');
    });

});

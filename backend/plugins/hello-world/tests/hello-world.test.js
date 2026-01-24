/**
 * Hello World Plugin - Unit Tests
 * These tests run BEFORE the plugin is activated.
 * If any test fails, the plugin will NOT be activated.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Hello World Plugin', () => {

    it('should export init function', () => {
        const plugin = require('../index.js');
        assert.ok(typeof plugin.init === 'function', 'Plugin must export init function');
    });

    it('should export deactivate function', () => {
        const plugin = require('../index.js');
        assert.ok(typeof plugin.deactivate === 'function', 'Plugin must export deactivate function');
    });

    it('should export metadata', () => {
        const plugin = require('../index.js');
        assert.ok(plugin.metadata, 'Plugin must export metadata');
        assert.ok(plugin.metadata.name, 'Metadata must have name');
        assert.ok(plugin.metadata.version, 'Metadata must have version');
    });

    it('should have valid version format', () => {
        const plugin = require('../index.js');
        const versionRegex = /^\d+\.\d+\.\d+$/;
        assert.ok(
            versionRegex.test(plugin.metadata.version),
            `Version "${plugin.metadata.version}" must match semver format (x.y.z)`
        );
    });

});

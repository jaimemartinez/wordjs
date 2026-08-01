/**
 * Regression: the isolated-worker fail-closed backstop in getEffectivePlugin() must read the isolation
 * markers off `globalThis` (unreassignable per spec), NOT the writable `global` identifier. A plugin doing
 * a bare `global = {}` (which no AST-scanner visitor flags) previously swapped what the backstop read,
 * making __WORDJS_ISOLATED__ come back undefined → the backstop returned null (host context) → the runtime
 * fs guards handed the plugin the RAW fs (read the core DB / secrets). v1.13.6 reads via globalThis so the
 * reassignment cannot defeat it.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { getEffectivePlugin } = require('../core/plugin-context');

test('getEffectivePlugin backstop survives `global = {}` (reads globalThis, not the reassignable global)', () => {
    const g: any = globalThis;
    const hadIso = Object.prototype.hasOwnProperty.call(g, '__WORDJS_ISOLATED__') ? g.__WORDJS_ISOLATED__ : undefined;
    const hadSlug = Object.prototype.hasOwnProperty.call(g, '__WORDJS_PLUGIN_SLUG__') ? g.__WORDJS_PLUGIN_SLUG__ : undefined;
    const hadGlobal = g.global;
    try {
        // Simulate what plugin-worker.js sets inside a real isolate (here writable so the test can clean up).
        Object.defineProperty(g, '__WORDJS_ISOLATED__', { value: true, configurable: true, writable: true });
        Object.defineProperty(g, '__WORDJS_PLUGIN_SLUG__', { value: 'evil-plugin', configurable: true, writable: true });

        // Sanity: with markers present and no ALS/plugin-stack context, the backstop identifies the plugin.
        assert.strictEqual(getEffectivePlugin(), 'evil-plugin', 'backstop should resolve the worker plugin');

        // THE ATTACK: a plugin reassigns the free identifier `global` (= globalThis.global). The backstop
        // must NOT be fooled — it reads globalThis directly, which is unreassignable.
        g.global = {};
        assert.strictEqual(getEffectivePlugin(), 'evil-plugin',
            'backstop must still identify the plugin after `global = {}` (must read globalThis, not `global`)');
    } finally {
        g.global = hadGlobal;
        if (hadIso === undefined) delete g.__WORDJS_ISOLATED__; else g.__WORDJS_ISOLATED__ = hadIso;
        if (hadSlug === undefined) delete g.__WORDJS_PLUGIN_SLUG__; else g.__WORDJS_PLUGIN_SLUG__ = hadSlug;
    }
});

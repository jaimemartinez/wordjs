/**
 * WordJS - ZIP extraction guard tests (decompression-bomb defense).
 * Pure unit test — no DB, no server. Locks the size/entry caps that protect every extract path
 * (plugin upload, theme upload, backup restore).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { assertZipWithinBudget } = require('../core/zip-guard');

const entry = (size: number) => ({ header: { size } });

describe('zip-guard assertZipWithinBudget', () => {
    it('allows an archive within budget', () => {
        assert.doesNotThrow(() => assertZipWithinBudget([entry(1000), entry(2000)], { maxTotalBytes: 10000, maxEntries: 100 }));
    });

    it('rejects when the uncompressed total exceeds the cap (bomb)', () => {
        assert.throws(
            () => assertZipWithinBudget([entry(6 * 1024 * 1024), entry(6 * 1024 * 1024)], { maxTotalBytes: 10 * 1024 * 1024 }),
            /decompression bomb/i
        );
    });

    it('rejects when there are too many entries', () => {
        const many = Array.from({ length: 5001 }, () => entry(1));
        assert.throws(() => assertZipWithinBudget(many, { maxEntries: 5000 }), /entries, over the/i);
    });

    it('tags the error with a stable code for callers', () => {
        try {
            assertZipWithinBudget([entry(999999999)], { maxTotalBytes: 1 });
            assert.fail('should have thrown');
        } catch (e: any) {
            assert.strictEqual(e.code, 'ZIP_BUDGET_EXCEEDED');
        }
    });

    it('ignores entries with no declared size (directories) and bad input', () => {
        assert.doesNotThrow(() => assertZipWithinBudget([{ header: {} }, {}, null] as any, { maxTotalBytes: 10 }));
        assert.doesNotThrow(() => assertZipWithinBudget(undefined as any));
    });

    it('uses the kind label in the message', () => {
        assert.throws(() => assertZipWithinBudget([entry(999)], { maxTotalBytes: 1, kind: 'plugin' }), /plugin archive/i);
    });
});

'use strict';

// The installer's release-asset resolution, exercised directly.
//
// Why this file exists at all: `packages/create-wordjs` had no test script and no CI step. It is the
// first command a new user runs (`npx create-wordjs my-site`), it is published to npm — which is
// immutable, so a bad version can only be succeeded, never corrected — and nothing anywhere asserted
// that it picks the right file out of a release. That is the same blind spot that let it carry a HIGH
// advisory (adm-zip <0.6.0) while the three audited workspaces were clean.
//
// These drive the real `pickBundleAsset` out of index.js rather than restating its rule, so a change
// to the rule changes the result here instead of quietly agreeing with a copy.

const { test } = require('node:test');
const assert = require('node:assert');

const { pickBundleAsset } = require('../index.js');

test('picks the tag-named bundle even when a plugin asset shadows it', () => {
    // A release carries the core bundle AND all 31 marketplace plugin zips. GitHub returns assets in
    // upload order, so a plugin whose slug begins with "wordjs-" can appear first. Matching the shape
    // `wordjs-*.zip` would download that plugin and try to boot it as a site.
    const assets = [
        { name: 'wordjs-seo-tools-1.0.0.zip' },
        { name: 'marketplace-index.json' },
        { name: 'wordjs-v2.0.0.zip' },
        { name: 'wordjs-sbom.cdx.json' },
    ];
    assert.strictEqual(pickBundleAsset(assets, 'v2.0.0').name, 'wordjs-v2.0.0.zip');
});

test('the tag-named bundle wins wherever it sits in the list', () => {
    const assets = [
        { name: 'wordjs-v2.0.0.zip' },
        { name: 'wordjs-seo-tools-1.0.0.zip' },
    ];
    assert.strictEqual(pickBundleAsset(assets, 'v2.0.0').name, 'wordjs-v2.0.0.zip');
});

test('falls back to the loose match for releases whose bundle is not tag-named', () => {
    // Every release before v2.0.0, and any future rename in release.yml: degrade to the previous
    // behaviour rather than to a hard failure.
    const assets = [{ name: 'wordjs-compiled-release.zip' }];
    assert.strictEqual(pickBundleAsset(assets, 'v1.14.1').name, 'wordjs-compiled-release.zip');
});

test('asset names are matched case-insensitively', () => {
    const assets = [{ name: 'WordJS-V2.0.0.zip' }];
    assert.strictEqual(pickBundleAsset(assets, 'v2.0.0').name, 'WordJS-V2.0.0.zip');
});

test('a release with no bundle reports absence instead of guessing', () => {
    assert.strictEqual(pickBundleAsset([{ name: 'marketplace-index.json' }], 'v2.0.0'), null);
    assert.strictEqual(pickBundleAsset([], 'v2.0.0'), null);
    assert.strictEqual(pickBundleAsset(undefined, 'v2.0.0'), null);
    assert.strictEqual(pickBundleAsset(null, 'v2.0.0'), null);
});

test('malformed asset entries do not throw', () => {
    // The GitHub API response is untrusted input as far as this process is concerned.
    const assets = [null, {}, { name: null }, { name: 42 }, { name: 'wordjs-v2.0.0.zip' }];
    assert.strictEqual(pickBundleAsset(assets, 'v2.0.0').name, 'wordjs-v2.0.0.zip');
});

test('requiring the CLI does not run it', () => {
    // index.js guards main() behind `require.main === module`. Without that guard this very file
    // would have started scaffolding a site on import, so assert the guard rather than trusting it.
    const src = require('node:fs').readFileSync(require.resolve('../index.js'), 'utf8');
    assert.match(src, /require\.main === module/);
});

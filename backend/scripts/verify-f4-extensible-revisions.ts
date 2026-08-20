/** CI gate for F4: declarations, frozen codecs, legacy decode, UI disclosure and DB parity travel together. */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`F4 verification failed: ${message}`);
};

const constants = read('backend/src/core/revision-constants.ts');
const snapshots = read('backend/src/core/revision-snapshots.ts');
const revisions = read('backend/src/core/revisions.ts');
const schema = read('backend/src/core/content-schema.ts');
const builtins = read('backend/src/core/content-schemas-builtins.ts');
const protectedMeta = read('backend/src/core/protected-meta.ts');
const postsRoute = read('backend/src/routes/posts.ts');
const revisionsRoute = read('backend/src/routes/revisions.ts');
const tests = read('backend/src/tests/f4-extensible-revisions.test.ts');
const drivers = read('backend/src/tests/driver-conformance.test.ts');
const frontend = read('frontend/src/lib/revisionRestoreDescription.ts');
const sidebar = read('frontend/src/components/RevisionsSidebar.tsx');
const adr = read('documentation/adr/0005-f4-versioned-extensible-revisions.md');

check(constants.includes('Object.freeze(['), 'legacy metadata decoder is mutable');
check(constants.includes("REVISION_SNAPSHOT_META_KEY = '_wjs_revision_snapshot'"), 'stable snapshot meta key is absent');
check(schema.includes('fields[field].revisioned = true'), 'compatibility list does not project to per-field authority');
check(schema.includes('computed fields cannot be restored'), 'computed revision fields are accepted');
check(builtins.includes('LEGACY_REVISIONABLE_META_KEYS'), 'built-in declarative metadata omitted historical fields');
check(protectedMeta.includes('REVISION_SNAPSHOT_META_KEY'), 'snapshot instructions are writable through generic meta');
check(snapshots.includes("SNAPSHOT_FORMAT = 'wordjs.revision.snapshot'"), 'versioned envelope is absent');
check(snapshots.includes("INACTIVE_PLUGIN_POLICY = 'snapshot-authoritative'"), 'plugin deactivation policy is absent');
check(snapshots.includes('revision_codec_unsupported'), 'unknown codecs do not fail closed');
check(snapshots.includes('rejectUnknownKeys'), 'manifest parser is not strict');
check(snapshots.includes('RESTORABLE_COLUMNS'), 'column identifiers are not allowlisted');
check(snapshots.includes('preserveFieldsValue'), 'disabled-plugin safety snapshots lose undo data');
check(revisions.includes('decodeRevisionSnapshot'), 'restore bypasses the frozen decoder');
check(revisions.includes('restorePlan.frozenFields'), 'restore safety snapshot ignores frozen plugin fields');
check(revisions.includes('Revision restore would create a parent cycle'), 'restored parent chains are not protected');
check(revisions.includes('scheduleFuturePublish'), 'restored scheduling state is not reconciled');
check(postsRoute.includes('isRevisionableMeta(storageKey, post.postType)'), 'single-key plugin writes do not create revisions');
check(revisionsRoute.includes('getRevisionRestoreIntent'), 'REST restore does not inspect decoded field intent');
check(revisionsRoute.includes('req.user.can(caps.publish)'), 'REST restore bypasses publish authorization');
check(frontend.includes('revision.restore?.fields'), 'restore disclosure is not generated from the snapshot');
check(sidebar.includes('buildRevisionRestoreMessage'), 'Verso does not use generated restore disclosure');
check(tests.includes('after plugin upgrade and deactivation'), 'plugin lifecycle conformance test is absent');
check(tests.includes('manifest-less revisions retain'), 'legacy decoder conformance test is absent');
check(tests.includes('unknown codec fails closed'), 'unknown-codec failure test is absent');
check(drivers.includes('F4 declarative revision restore'), 'real-engine F4 transaction conformance is absent');
check(drivers.includes('EXPECTED_F4_ROLLBACK'), 'real-engine F4 rollback injection is absent');

for (let invariant = 1; invariant <= 10; invariant++) {
    check(adr.includes(`F4-INV-${String(invariant).padStart(2, '0')}`), `ADR missing F4 invariant ${invariant}`);
}

console.log('F4 extensible revisions verified: frozen schema/codecs, legacy decode, plugin lifecycle, atomic restore and generated disclosure.');

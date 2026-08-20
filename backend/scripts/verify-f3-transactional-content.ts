/** CI gate for F3: the atomic boundary and durable delivery machinery must travel together. */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`F3 verification failed: ${message}`);
};

const database = read('backend/src/config/database.ts');
const outbox = read('backend/src/core/content-outbox.ts');
const migrations = read('backend/src/core/schema-migrations.ts');
const post = read('backend/src/models/Post.ts');
const revisions = read('backend/src/core/revisions.ts');
const routes = read('backend/src/routes/posts.ts');
const cache = read('backend/src/core/cache.ts');
const hooks = read('backend/src/core/hooks.ts');
const webhooks = read('backend/src/core/webhooks.ts');
const health = read('backend/src/core/system-health.ts');
const sqliteNative = read('backend/src/drivers/sqlite-native-async.ts');
const sqliteLegacy = read('backend/src/drivers/sqlite-legacy.ts');
const test = read('backend/src/tests/f3-content-outbox.test.ts');
const failures = read('backend/src/tests/f0-content-mutation-failures.test.ts');
const adr = read('documentation/adr/0004-f3-transactional-content-outbox.md');

check(database.includes('AsyncLocalStorage<TransactionScope>') || database.includes('transactionScope'), 'transaction context is absent');
check(database.includes('return await fn(active.query)'), 'nested transactions do not join the pinned connection');
check(database.includes('afterCommit'), 'post-commit effect seam is absent');
check(database.includes("'webhook_deliveries', 'content_outbox'"), 'restore does not discard stale external work');
check(database.includes('Refusing to clear content while stale external work remains'), 'restore cleanup does not fail closed');
check(migrations.includes("id: '0014_create_content_outbox'"), 'content outbox migration is absent');
for (const column of ['event_id', 'event_type', 'aggregate_id', 'claim_token', 'claimed_until', 'last_error']) {
    check(migrations.includes(column), `content outbox migration is missing ${column}`);
}
check(outbox.includes("new Set(['post.created', 'post.updated', 'post.deleted'])"), 'semantic event allowlist drifted');
check(outbox.includes("status = 'processing'"), 'atomic lease claim is absent');
check(outbox.includes("status = 'dead'"), 'dead-letter state is absent');
check(outbox.includes('database.afterCommit'), 'outbox can dispatch before commit');
check(outbox.includes('databaseNowSeconds'), 'lease timing does not use the database clock');
check(!outbox.includes('return fallback'), 'database-clock failure can fall back to a skewed process clock');
check(outbox.includes('pruneProcessed'), 'processed-event retention is absent');
check(post.includes("recordContentEvent('post.created'"), 'Post.create does not emit a durable event');
check(post.includes("recordContentEvent('post.updated'"), 'Post.update does not emit a durable event');
check(post.includes("recordContentEvent('post.deleted'"), 'Post.delete does not emit a durable event');
check(!post.includes("doAction('wp_insert_post'"), 'Post.create still invokes hooks inline');
check(!post.includes("doAction('post_updated'"), 'Post.update still invokes hooks inline');
check(revisions.includes('runContentMutation(() => restoreRevision'), 'revision restore is outside the F3 unit');
check(routes.match(/runContentMutation/g)?.length >= 6, 'content routes do not consistently use the F3 unit');
check(cache.includes('transactionActive()'), 'cache reads are not transaction-aware');
check(hooks.includes('afterCommit'), 'generic hooks are not deferred after commit');
check(webhooks.includes('currentContentEventId'), 'webhook fan-out lacks the outbox idempotency key');
check(health.includes('checkContentOutbox'), 'dead/delayed events are not visible in health');
check(test.includes('two workers racing one row'), 'lease race conformance test is absent');
check(test.includes('overlapping SQLite transactions serialize'), 'SQLite concurrency regression test is absent');
check(test.includes('cannot be absorbed by another request transaction'), 'SQLite cross-request isolation test is absent');
check(test.includes('cannot reuse a closed transaction context'), 'stale transaction-context regression test is absent');
check(test.includes('database clear removes semantic events'), 'restore stale-work regression test is absent');
check(sqliteNative.includes('waitForTransaction'), 'native SQLite does not isolate non-transactional requests');
check(sqliteLegacy.includes('waitForTransaction'), 'legacy SQLite does not isolate non-transactional requests');
check(failures.includes('rolls back the post'), 'F0 partial-state characterization was not inverted for F3');

for (let invariant = 1; invariant <= 10; invariant++) {
    check(adr.includes(`F3-INV-${String(invariant).padStart(2, '0')}`), `ADR missing F3 invariant ${invariant}`);
}

console.log('F3 transactional content verified: pinned unit-of-work, atomic outbox, leased retries and post-commit effects.');

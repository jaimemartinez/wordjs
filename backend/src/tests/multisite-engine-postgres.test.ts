/**
 * Multisite on postgres: the network's guarantees on this engine — namespaces, the network store, isolation
 * through the real routes, plugin principals, collaboration, backups, certificates, deletion and what
 * another node wrote (tests/fixtures/multisite-engine-suite.ts). One engine per process: the engine is
 * process-wide. Run on every engine by the "Phase suites on 3 engines" matrix (.github/workflows/f6-certification.yml).
 */
require('./fixtures/multisite-engine-suite').runMultisiteEngineSuite('postgres');

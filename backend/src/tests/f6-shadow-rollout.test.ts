/**
 * F6 evidence: the rollout ramp for the generated content validator.
 *
 * Every assertion here is derived from the module under test rather than from a hand-written copy
 * of it. The mode list, the behaviour matrix and the divergence records all come out of
 * core/content-rollout; adding a rung to CONTENT_VALIDATION_MODES without deciding its behaviour
 * turns this file red, which is the only reason a matrix test is worth writing.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

import type { ContentComparisonInput, ContentComparisonOutcome } from '../core/content-rollout';

const {
    CONTENT_VALIDATION_MODES,
    CONTENT_VALIDATION_PLAN,
    configureContentRollout,
    contentRolloutReport,
    contentValidationConfig,
    isLegacyDerivedType,
    normalizeContentValidationConfig,
    resetContentRollout,
    resolveContentValidationMode,
    warnLegacyContentCaller,
} = require('../core/content-rollout');
// Typed separately: a bare `require` erases the generic, and this test's whole point is that a
// mis-shaped comparison input is caught rather than accepted as `any`.
const { evaluateContentValidation } = require('../core/content-rollout') as {
    evaluateContentValidation: <R>(input: ContentComparisonInput<R>) => ContentComparisonOutcome<R>;
};
const { compileContentContract } = require('../core/content-contract');
const { getBuiltinContentSchemas } = require('../core/content-schemas-builtins');
const postTypes = require('../core/post-types');

type Mode = 'off' | 'shadow' | 'enforce';

interface FakeResult {
    ok: boolean;
    issues: Array<{ path: string; code: string }>;
}

const ACCEPTED: FakeResult = { ok: true, issues: [] };
const REJECTED: FakeResult = { ok: false, issues: [{ path: 'meta.rating', code: 'type' }] };

function builtinPost() {
    const schema = getBuiltinContentSchemas().find((candidate: { name: string }) => candidate.name === 'post');
    assert.ok(schema, 'built-in post schema missing');
    return schema;
}

/**
 * A type declared the DECLARATIVE way, carrying one field the legacy `supports` array is
 * structurally unable to express. The divergence this produces is not synthetic: it is what the
 * legacy descriptor loses, measured rather than imagined.
 */
function reviewSchema(name = 'f6_review') {
    const schema = JSON.parse(JSON.stringify(builtinPost()));
    schema.name = name;
    schema.labels = { singular: 'Review', plural: 'Reviews', addNew: 'Add Review', edit: 'Edit Review' };
    schema.storage.discriminator.value = name;
    schema.presentation.rewrite.slug = name;
    schema.fields.rating = {
        type: 'integer',
        storage: { kind: 'meta', key: 'rating' },
        required: false, multiple: false, revisioned: false,
        description: 'Editorial score.',
    };
    return schema;
}

/** Drive the ramp with instrumented validators so the calls themselves can be counted. */
function instrumented(type: string, permissiveResult: FakeResult, generatedResult: FakeResult) {
    const calls = { permissive: 0, generated: 0 };
    const outcome = evaluateContentValidation<FakeResult>({
        type,
        operation: 'create',
        route: 'POST /posts',
        permissive: () => { calls.permissive++; return permissiveResult; },
        generated: () => { calls.generated++; return generatedResult; },
        accepted: (result: FakeResult) => result.ok,
        issuesOf: (result: FakeResult) => result.issues,
        shapeAt: () => 'string(12)',
    });
    return { calls, outcome };
}

function captureWarnings(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, restore: () => { console.warn = original; } };
}

beforeEach(() => { resetContentRollout(); });
afterEach(() => { resetContentRollout(); });

describe('F6 rollout ramp', () => {
    /**
     * THE GATE. The expectation table is keyed by mode and checked against the exported mode list
     * in BOTH directions, so a fourth rung added to CONTENT_VALIDATION_MODES fails here before it
     * can silently inherit some other rung's behaviour. `CONTENT_VALIDATION_PLAN` fails to compile
     * for the same omission; this is the half that still bites under ts-node's transpileOnly.
     */
    it('gives every declared rung a decided, exercised behaviour', () => {
        const expected: Record<Mode, { permissiveRuns: number; generatedRuns: number; verdictAccepted: boolean }> = {
            // Emergency downgrade: the generated validator does not run, so it cannot reject.
            off: { permissiveRuns: 1, generatedRuns: 0, verdictAccepted: true },
            // Rung 1-2: both run, the pre-migration verdict is the one returned.
            shadow: { permissiveRuns: 1, generatedRuns: 1, verdictAccepted: true },
            // Rung 5: only the generated validator runs, and it rejects.
            enforce: { permissiveRuns: 0, generatedRuns: 1, verdictAccepted: false },
        };

        assert.deepStrictEqual(
            [...CONTENT_VALIDATION_MODES].sort(),
            Object.keys(expected).sort(),
            'a rollout mode exists with no decided behaviour in this matrix (or vice versa)',
        );

        for (const mode of CONTENT_VALIDATION_MODES as readonly Mode[]) {
            assert.ok(CONTENT_VALIDATION_PLAN[mode], `mode ${mode} has no plan`);
            resetContentRollout();
            configureContentRollout({ mode });
            const { calls, outcome } = instrumented('f6_matrix', ACCEPTED, REJECTED);
            assert.strictEqual(calls.permissive, expected[mode].permissiveRuns, `${mode}: permissive validator run count`);
            assert.strictEqual(calls.generated, expected[mode].generatedRuns, `${mode}: generated validator run count`);
            assert.strictEqual(outcome.verdict.ok, expected[mode].verdictAccepted, `${mode}: verdict authority`);
            assert.strictEqual(outcome.mode, mode);
        }
    });

    it('shadow does not reject what the pre-migration path accepted, and enforce does', () => {
        const schema = reviewSchema();
        const contract = compileContentContract(schema);
        const body = { title: 'Nice', meta: { rating: 'not-a-number' } };

        configureContentRollout({ types: { [schema.name]: 'shadow' } });
        const shadowed = contract.validateCreate(body);
        assert.strictEqual(shadowed.ok, true, 'shadow mode must never change acceptance');

        configureContentRollout({ types: { [schema.name]: 'enforce' } });
        const enforced = contract.validateCreate(body);
        assert.strictEqual(enforced.ok, false);
        assert.ok(enforced.issues.some((issue: { path: string }) => issue.path === 'meta.rating'));

        // Same body, same schema, opposite outcome — decided by the rung and nothing else. Without
        // this rung, discovering that in production leaves only "revert the release".
        assert.notStrictEqual(shadowed.ok, enforced.ok);
    });

    it('records which route, which field, and what each validator said — but never the value', () => {
        const schema = reviewSchema();
        const contract = compileContentContract(schema);
        configureContentRollout({ types: { [schema.name]: 'shadow' } });

        contract.validateCreate(
            { title: 'Nice', meta: { rating: 'sixteen-and-a-half' } },
            { route: 'POST /wp-json/wp/v2/f6_review' },
        );

        const entry = contentRolloutReport().types.find((row: { type: string }) => row.type === schema.name);
        assert.ok(entry, 'the divergent type is absent from the report');
        assert.strictEqual(entry.divergences, 1);
        assert.deepStrictEqual(entry.divergentFields, ['meta.rating']);
        assert.strictEqual(entry.samples.length, 1);

        const sample = entry.samples[0];
        assert.strictEqual(sample.route, 'POST /wp-json/wp/v2/f6_review', 'the recording caller must be identifiable');
        assert.strictEqual(sample.operation, 'create');
        assert.strictEqual(sample.permissiveAccepted, true);
        assert.strictEqual(sample.generatedAccepted, false);
        assert.deepStrictEqual(sample.fields, [{
            path: 'meta.rating', legacy: 'accepted', generated: 'type', valueShape: 'string(18)',
        }]);

        // A divergence ledger that copies request bodies is a retained log of user content on every
        // node for the length of the cut-over. The shape answers the diagnostic question instead.
        assert.ok(!JSON.stringify(entry).includes('sixteen-and-a-half'), 'the submitted value leaked into the report');
    });

    it('holds one type back while the rest of the site keeps enforcing', () => {
        const held = reviewSchema('f6_held');
        const other = reviewSchema('f6_other');
        configureContentRollout({ mode: 'enforce', types: { f6_held: 'shadow' } });

        const body = { title: 'Nice', meta: { rating: 'nope' } };
        assert.strictEqual(compileContentContract(held).validateCreate(body).ok, true, 'the held type must not reject');
        assert.strictEqual(compileContentContract(other).validateCreate(body).ok, false, 'the rest of the site must keep enforcing');

        assert.deepStrictEqual(resolveContentValidationMode('f6_held'), { mode: 'shadow', source: 'type-override' });
        assert.deepStrictEqual(resolveContentValidationMode('f6_other'), { mode: 'enforce', source: 'runtime-default' });
    });

    it('charges an enforcing deployment nothing until an operator asks for the comparison', () => {
        const schema = reviewSchema();
        const contract = compileContentContract(schema);
        const body = { title: 'Nice', meta: { rating: 'nope' } };

        configureContentRollout({ mode: 'enforce' });
        assert.strictEqual(contract.validateCreate(body).ok, false);
        let entry = contentRolloutReport().types.find((row: { type: string }) => row.type === schema.name);
        assert.strictEqual(entry.comparisons, 0, 'steady-state enforcement must not run the legacy validator');
        assert.strictEqual(entry.uncompared, 1, 'an evaluation that produced no evidence must still be counted');

        // The cut-over window: keep enforcing, but answer "what is enforcement now rejecting?".
        configureContentRollout({ mode: 'enforce', compareWhileEnforcing: true });
        assert.strictEqual(contract.validateCreate(body).ok, false, 'comparing must not soften the verdict');
        entry = contentRolloutReport().types.find((row: { type: string }) => row.type === schema.name);
        assert.strictEqual(entry.comparisons, 1);
        assert.strictEqual(entry.divergences, 1);
    });
});

describe('F6 comparison integrity', () => {
    it('compares every dual run, and exposes no way to run the pair without recording', () => {
        configureContentRollout({ mode: 'shadow' });
        for (let index = 0; index < 25; index++) instrumented('f6_integrity', ACCEPTED, REJECTED);

        const report = contentRolloutReport();
        assert.strictEqual(report.integrity.dualRuns, 25);
        assert.strictEqual(report.integrity.comparisons, 25);
        assert.strictEqual(report.integrity.everyDualRunCompared, true);

        // The counters are taken at the two ends of the single code path that runs both validators.
        // A second dual-run site added anywhere would show up here as dualRuns > comparisons — and
        // there is deliberately no exported recorder that would let one be added without recording.
        const rollout = require('../core/content-rollout');
        assert.strictEqual(typeof rollout.recordContentComparison, 'undefined',
            'exporting the recorder would reopen the "run both, decide later whether to compare" hole');
    });

    it('keeps the divergence samples a bounded ring, newest kept', () => {
        const schema = reviewSchema();
        const contract = compileContentContract(schema);
        configureContentRollout({ types: { [schema.name]: 'shadow' }, sampleLimit: 3 });

        for (let index = 0; index < 10; index++) {
            contract.validateCreate({ title: 'Nice', meta: { rating: 'x'.repeat(index + 1) } });
        }

        const entry = contentRolloutReport().types.find((row: { type: string }) => row.type === schema.name);
        assert.strictEqual(entry.divergences, 10, 'the count must stay exact even though the samples are capped');
        assert.strictEqual(entry.samples.length, 3);
        assert.strictEqual(entry.samples[2].fields[0].valueShape, 'string(10)', 'the ring must keep the newest');
    });
});

describe('F6 safe-to-enforce evidence', () => {
    it('refuses without evidence, refuses on divergence, and grants after clean agreement', () => {
        configureContentRollout({ mode: 'shadow', minimumComparisons: 5 });

        const noEvidence = contentRolloutReport().types.find((row: { type: string }) => row.type === 'f6_evidence');
        assert.strictEqual(noEvidence, undefined, 'a type nobody has exercised should not appear as evidence');

        instrumented('f6_evidence', ACCEPTED, REJECTED);
        let entry = contentRolloutReport().types.find((row: { type: string }) => row.type === 'f6_evidence');
        assert.strictEqual(entry.safeToEnforce, false);
        assert.match(entry.reason, /diverged on: meta\.rating/);

        resetContentRollout();
        configureContentRollout({ mode: 'shadow', minimumComparisons: 5 });
        for (let index = 0; index < 4; index++) instrumented('f6_evidence', ACCEPTED, ACCEPTED);
        entry = contentRolloutReport().types.find((row: { type: string }) => row.type === 'f6_evidence');
        assert.strictEqual(entry.safeToEnforce, false, 'agreement is not evidence until there is enough of it');
        assert.match(entry.reason, /only 4 of the 5 comparisons/);
        assert.deepStrictEqual(contentRolloutReport().blockedFromEnforcing, ['f6_evidence']);

        instrumented('f6_evidence', ACCEPTED, ACCEPTED);
        entry = contentRolloutReport().types.find((row: { type: string }) => row.type === 'f6_evidence');
        assert.strictEqual(entry.safeToEnforce, true);
        assert.match(entry.reason, /5 comparisons since /);
        assert.deepStrictEqual(contentRolloutReport().blockedFromEnforcing, []);
    });

    it('reports a disabled type as unevidenced rather than as agreeing', () => {
        configureContentRollout({ mode: 'off' });
        instrumented('f6_disabled', ACCEPTED, REJECTED);
        const entry = contentRolloutReport().types.find((row: { type: string }) => row.type === 'f6_disabled');
        assert.strictEqual(entry.comparisons, 0);
        assert.strictEqual(entry.safeToEnforce, false);
        assert.match(entry.reason, /no evidence is being collected/,
            '"we saw no divergences" must never be able to mean "we never looked"');
    });

    /**
     * THE REVERSE GEAR, ON THE REAL BUILT-IN SCHEMAS.
     *
     * What stood here before asserted that `legacyProjectionOfSchema(schema).fields` equals
     * `schema.fields` for every built-in — which is TRUE, and was precisely the bug. The round trip
     * is the identity for the built-ins, so the "legacy" authority was the generated validator, so
     * `off` and `shadow` rejected exactly what `enforce` rejects. The old test then submitted
     * `{status:'scheduled'}` — a body the contract REJECTS — and asserted that nothing diverged,
     * which was guaranteed by construction. A tautology cannot fail, so it protected nothing.
     *
     * These three assertions can each fail. If the low rungs ever stop reversing, the first goes red;
     * if `off` starts collecting evidence it never gathered, the second; if the ramp starts letting a
     * genuinely invalid body through while ENFORCING, the third.
     */
    it('the low rungs actually reverse: a body enforcement rejects is accepted under shadow and off', () => {
        const rejectedBody = { title: 'Ready', status: 'scheduled' };

        for (const schema of getBuiltinContentSchemas()) {
            // Establish that this body is genuinely rejected by the contract, so the rest is not
            // vacuous for a schema that happens to accept it.
            configureContentRollout({ mode: 'enforce', types: {} });
            const enforcing = compileContentContract(schema).validateCreate(rejectedBody);
            if (enforcing.ok) continue;

            configureContentRollout({ mode: 'shadow', types: {} });
            const shadowed = compileContentContract(schema).validateCreate(rejectedBody);
            assert.strictEqual(shadowed.ok, true,
                `${schema.name}: shadow rejected a write enforcement rejects — the rung below enforcement does not exist`);

            configureContentRollout({ mode: 'off', types: {} });
            const disabled = compileContentContract(schema).validateCreate(rejectedBody);
            assert.strictEqual(disabled.ok, true,
                `${schema.name}: the emergency downgrade still rejects, so there is no way back from enforcement`);
        }
    });

    it('shadow records the rejection it declined to make, and off records nothing', () => {
        const rejectedBody = { title: 'Ready', status: 'scheduled' };
        const [schema] = getBuiltinContentSchemas().filter((candidate: { name: string }) => candidate.name === 'post');
        assert.ok(schema, 'the built-in post schema is missing');

        configureContentRollout({ mode: 'shadow', types: {}, minimumComparisons: 1 });
        compileContentContract(schema).validateCreate(rejectedBody);
        const shadowRow = contentRolloutReport().types.find((row: { type: string }) => row.type === 'post');
        assert.ok(shadowRow && shadowRow.divergences > 0,
            'shadow accepted the write but recorded no divergence, so the evidence stage 3 is decided on is empty');
        assert.ok(shadowRow.divergentFields.includes('status'),
            `the divergence does not name the offending field: ${JSON.stringify(shadowRow.divergentFields)}`);
        assert.strictEqual(shadowRow.safeToEnforce, false,
            'a type whose writes enforcement would reject must not be reported safe to enforce');

        // `off` runs one validator, so it cannot produce evidence — and must say so rather than
        // present an empty ledger as agreement. The ledger is module-level and additive, so without
        // this reset the row would still carry the shadow comparisons above and the assertion would
        // be measuring the previous half of this test.
        resetContentRollout();
        configureContentRollout({ mode: 'off', types: {}, minimumComparisons: 1 });
        compileContentContract(schema).validateCreate(rejectedBody);
        const offRow = contentRolloutReport().types.find((row: { type: string }) => row.type === 'post');
        assert.strictEqual(offRow.safeToEnforce, false);
        assert.match(offRow.reason, /no evidence is being collected/);
    });

    it('a body the contract accepts diverges under no rung', () => {
        configureContentRollout({ mode: 'shadow', types: {} });
        for (const schema of getBuiltinContentSchemas()) {
            compileContentContract(schema).validateCreate({ title: 'Ready', status: 'draft' });
        }
        const divergent = contentRolloutReport().types.filter((row: { divergences: number }) => row.divergences > 0);
        assert.deepStrictEqual(divergent.map((row: { type: string }) => row.type), [],
            'a valid write was recorded as a divergence, so the ramp reports noise as evidence');
    });
});

describe('F6 deprecation notices', () => {
    it('fires once per legacy caller and counts what it suppressed', () => {
        const captured = captureWarnings();
        try {
            for (let index = 0; index < 500; index++) {
                warnLegacyContentCaller('rest-write', 'f6_noisy', 'legacy adapter in use');
            }
        } finally {
            captured.restore();
        }

        // A warning that repeats on every save is filtered on day one, which is indistinguishable
        // from never having emitted it. The volume stays visible where it is useful: the report.
        assert.strictEqual(captured.lines.length, 1, 'the deprecation notice flooded the log');
        const ledger = contentRolloutReport().legacyCallers.find((row: { type: string }) => row.type === 'f6_noisy');
        assert.strictEqual(ledger.caller, 'rest-write');
        assert.strictEqual(ledger.emitted, true);
        assert.strictEqual(ledger.suppressed, 499);
    });

    it('keeps the ledger even when the notices are switched off', () => {
        configureContentRollout({ deprecationWarnings: false });
        const captured = captureWarnings();
        try {
            warnLegacyContentCaller('rest-write', 'f6_quiet', 'legacy adapter in use');
        } finally {
            captured.restore();
        }
        assert.deepStrictEqual(captured.lines, []);
        const ledger = contentRolloutReport().legacyCallers.find((row: { type: string }) => row.type === 'f6_quiet');
        assert.ok(ledger, 'silencing the log must not erase the fact that a legacy caller exists');
        assert.strictEqual(ledger.emitted, false);
    });

    it('keeps registerPostType working, and lets it mark the type it registered', () => {
        const captured = captureWarnings();
        try {
            const registered = postTypes.registerPostType('f6_legacy_type', {
                label: 'Legacy', supports: ['title', 'editor'], capability_type: 'post',
            });
            // Rung 7 is a MAJOR-version concern. F6 retires nothing: the adapter still returns the
            // same runtime descriptor every existing plugin reads.
            assert.strictEqual(registered.name, 'f6_legacy_type');
            assert.deepStrictEqual(registered.supports, ['title', 'editor']);
            assert.ok(postTypes.getPostType('f6_legacy_type'), 'the legacy registry entry must still exist');
            assert.ok(postTypes.getContentTypeSchema('f6_legacy_type'), 'the legacy adapter must still produce an F1 schema');

            postTypes.registerPostType('f6_legacy_type', { label: 'Legacy', supports: ['title'] });
        } finally {
            captured.restore();
            postTypes.unregisterPostType('f6_legacy_type');
        }

        assert.strictEqual(isLegacyDerivedType('f6_legacy_type'), true);
        assert.strictEqual(isLegacyDerivedType('post'), false,
            'a declaratively registered type must not be reported as legacy-derived');
        assert.strictEqual(captured.lines.length, 1,
            'a plugin re-registering on every activation cycle must not re-announce itself');
    });
});

describe('F6 ramp configuration', () => {
    it('normalizes idempotently and refuses a rung it does not know', () => {
        const once = normalizeContentValidationConfig({ mode: 'shadow', types: { post: 'off' }, sampleLimit: 5 });
        const twice = normalizeContentValidationConfig(once);
        assert.deepStrictEqual(twice, once, 'config/app and core/content-rollout must agree on the normalized shape');

        // A typo in a ramp lever must not quietly move a type to some other rung.
        const bogus = normalizeContentValidationConfig({ mode: 'enforcing', types: { post: 'shadowy' } });
        assert.strictEqual(bogus.mode, 'enforce');
        assert.deepStrictEqual(bogus.types, {});

        assert.strictEqual(normalizeContentValidationConfig({ sampleLimit: -5 }).sampleLimit, 0);
        assert.strictEqual(normalizeContentValidationConfig({ minimumComparisons: 0 }).minimumComparisons, 1);
        assert.strictEqual(normalizeContentValidationConfig(undefined).mode, 'enforce',
            'the default rung is the one F2 already shipped: on');
    });

    it('is read per request, so a rung change lands without a deploy', () => {
        const schema = reviewSchema();
        const contract = compileContentContract(schema);
        const body = { title: 'Nice', meta: { rating: 'nope' } };

        configureContentRollout({ mode: 'enforce' });
        assert.strictEqual(contract.validateCreate(body).ok, false);
        // Same compiled contract object, no re-registration, no restart.
        configureContentRollout({ mode: 'shadow' });
        assert.strictEqual(contract.validateCreate(body).ok, true);
        assert.strictEqual(contentValidationConfig().mode, 'shadow');
    });

    it('publishes the ramp as a normalized config block the write path can read unconditionally', () => {
        const config = require('../config/app');
        assert.ok(config.contentValidation, 'config.contentValidation must always exist');
        assert.ok((CONTENT_VALIDATION_MODES as readonly string[]).includes(config.contentValidation.mode));
        assert.strictEqual(typeof config.contentValidation.types, 'object');
        assert.strictEqual(typeof config.contentValidation.compareWhileEnforcing, 'boolean');
        assert.strictEqual(typeof config.contentValidation.minimumComparisons, 'number');
    });
});

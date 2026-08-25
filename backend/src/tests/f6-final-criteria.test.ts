/**
 * F6: the final migration/certification criteria, and the proof that the gate enforcing them is real.
 *
 * Two kinds of test live here and they do different jobs.
 *
 * The first kind runs the gate against the real tree and asserts it passes. That is the certification.
 *
 * The second kind is the one this repository learned to insist on: a NEGATIVE CONTROL for every gate
 * whose logic can be reached as a pure function. A gate that only ever sees a passing input has never
 * been shown to fail, and this programme has twice shipped a "gate" that enumerated a hand-written
 * table or self-skipped and counted as PASS. Each negative control below feeds the gate's own predicate
 * a synthetic ADDED MEMBER — one more `req: any`, one more measurement with no budget, one more
 * platform claiming confinement — and asserts the predicate rejects it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const gate = require('../../scripts/verify-f6-migration');
const isolate = require('../core/plugin-isolate');
const { fieldsForFeatures } = require('../core/content-schema');
const { getBuiltinContentSchemas } = require('../core/content-schemas-builtins');
const DriverInterface = require('../drivers/interface');

describe('F6 certification', () => {
    test('every F6 criterion holds against the real tree', () => {
        const result = gate.verify();
        assert.deepStrictEqual(result.failures, [], `F6 gate findings:\n${result.failures.join('\n')}`);
        assert.strictEqual(result.ok, true);
    });

    test('the gate reports ALL findings instead of stopping at the first', () => {
        // Structural, not incidental: the reason the F5 gate hid ten assertions was that it threw on the
        // first failure. `verify()` must produce one result per check, always, and the failure list must
        // be the concatenation of every check's findings.
        const result = gate.verify();
        assert.strictEqual(result.results.length, gate.CHECKS.length);
        const flattened = result.results.flatMap((entry: any) => entry.failures);
        assert.strictEqual(result.failures.length, flattened.length);
        for (const entry of result.results) {
            assert.ok(entry.id && entry.title, 'every check must identify itself in the report');
            assert.ok(Array.isArray(entry.failures) && Array.isArray(entry.notes));
        }
    });

    test('every certification leg names evidence that exists', () => {
        assert.ok(gate.CERTIFICATION_MATRIX.length >= 12, 'the matrix must cover the legs F6 claims');
        for (const leg of gate.CERTIFICATION_MATRIX) {
            assert.ok(leg.leg && leg.evidence && leg.runBy, `incomplete matrix row: ${JSON.stringify(leg)}`);
        }
    });
});

describe('F6 request-boundary typing (F6-INV-01, F6-INV-02, F6-INV-03)', () => {
    test('a handler counts as typed by its annotation, never by the NAME of the type', () => {
        // This is the defect the F5 gate shipped with, transposed: a check keyed to a type name would
        // call the second handler untyped the moment a file imported a shared alias instead of declaring
        // a local one. All three of these are typed; none of them share a spelling.
        const local = gate.classifyBoundarySource(
            'router.get("/", async (req: AuthenticatedRequest<IdParams>, res: Response) => { res.json({}); });');
        const shared = gate.classifyBoundarySource(
            'router.get("/", async (req: SomeOtherProjectRequest, res: Response) => { res.json({}); });');
        const inline = gate.classifyBoundarySource(
            'router.get("/", async (req: Request<{ id: string }>, res: Response) => { res.json({}); });');
        for (const [label, classified] of [['local alias', local], ['shared alias', shared], ['inline', inline]] as const) {
            assert.strictEqual(classified.typedHandlers, 1, `${label} handler should count as typed`);
            assert.strictEqual(classified.anyOccurrences, 0, `${label} handler should carry no debt`);
        }
    });

    test('ADDING one `req: any` is visible to the gate — the negative control for the ratchet', () => {
        const clean = 'router.get("/", async (req: TypedRequest, res: Response) => { res.json({}); });';
        const regressed = `${clean}\nrouter.post("/", async (req: any, res: any) => { res.json({}); });`;
        assert.strictEqual(gate.classifyBoundarySource(clean).anyOccurrences, 0);
        assert.strictEqual(gate.classifyBoundarySource(regressed).anyOccurrences, 1);

        // And the file stops being fully migrated, which is what F6-INV-02 forbids. "Fully migrated" is
        // the same predicate the gate uses: at least one typed handler and not one `req: any` left.
        const fullyMigrated = (source: string) => {
            const c = gate.classifyBoundarySource(source);
            return c.typedHandlers > 0 && c.anyOccurrences === 0;
        };
        assert.strictEqual(fullyMigrated(clean), true);
        assert.strictEqual(fullyMigrated(regressed), false);
    });

    test('the ratchet ceilings are the measurement, not a comfortable round number', () => {
        // A ratchet set above the real value is a ratchet with slack, and slack is where the next
        // regression hides. verify() emits a tightening note whenever a ratchet has slack, so a green
        // run with no such note is the proof that the ceilings are exactly where the tree is.
        const result = gate.verify();
        const slack = result.notes.filter((note: string) => /tighten|raise MIN_/.test(note));
        assert.deepStrictEqual(slack, [], `ratchets have slack:\n${slack.join('\n')}`);
        assert.ok(gate.RATCHETS.MAX_REQUEST_ANY_OCCURRENCES > 0, 'F6 opens with real debt; a zero here would mean the counter broke');
    });
});

describe('F6 built-in field completeness (F6-INV-04, F6-INV-05)', () => {
    test('every built-in declares exactly the fields the F1 mapper produces for its features', () => {
        const builtins = getBuiltinContentSchemas();
        assert.ok(builtins.length >= 5, 'the five core row types must all be declared');
        for (const schema of builtins) {
            assert.deepStrictEqual(
                Object.keys(schema.fields).sort(),
                Object.keys(fieldsForFeatures(schema.features)).sort(),
                `${schema.name} declares fields the feature mapper does not produce`,
            );
        }
    });

    test('every revisioned field is in the projection F4 freezes', () => {
        for (const schema of getBuiltinContentSchemas()) {
            for (const [name, field] of Object.entries<any>(schema.fields)) {
                if (!field.revisioned) continue;
                assert.ok(schema.revisions.fields.includes(name),
                    `${schema.name}.${name} is revisioned but F4 would never snapshot it`);
            }
        }
    });

    test('every built-in field has a storage binding that could be honoured', () => {
        for (const schema of getBuiltinContentSchemas()) {
            for (const [name, field] of Object.entries<any>(schema.fields)) {
                const storage = field.storage;
                assert.ok(storage && typeof storage.kind === 'string', `${schema.name}.${name} has no storage binding`);
                if (storage.kind === 'column') assert.ok(storage.column, `${schema.name}.${name} binds to no column`);
                if (storage.kind === 'meta') assert.ok(storage.key, `${schema.name}.${name} binds to no meta key`);
            }
        }
    });
});

describe('F6 sandbox fail-closed certification (F6-INV-08)', () => {
    // sandbox-parity.yml already certifies Landlock+seccomp, AppContainer and Seatbelt on real runners.
    // These assertions are the part a workflow cannot make about itself: the DECISION is fail-closed on
    // every host, including the ones where the mechanism can never exist.
    const CONFINED = ['linux', 'win32', 'darwin'];

    test('a platform that claims confinement never launches without it', () => {
        for (const platform of CONFINED) {
            assert.notStrictEqual(isolate.platformKernelMechanism(platform), 'none',
                `${platform} must claim a confinement mechanism`);
            for (const state of ['unknown', 'unsupported', 'disabled', 'degraded']) {
                for (const netGranted of [false, true]) {
                    const decision = isolate.__platformLaunchDecision({ platform, state, netGranted, tsNode: false });
                    assert.strictEqual(decision.use, false,
                        `${platform} failed OPEN in state '${state}' (network=${netGranted})`);
                }
            }
            assert.strictEqual(isolate.__nativeSandboxRequired({ configured: true, platform, tsNode: false }), true,
                `${platform}: compiled production must refuse to run a plugin unconfined`);
        }
    });

    test('ADDING an unknown platform does not silently inherit confinement — the negative control', () => {
        // A platform nobody taught the product about must resolve to 'none' and must not launch. This is
        // what stops "we added a platform" from meaning "we added an unconfined platform".
        for (const platform of ['freebsd', 'aix', 'sunos', 'android']) {
            assert.strictEqual(isolate.platformKernelMechanism(platform), 'none', `${platform} must not claim confinement`);
            const decision = isolate.__platformLaunchDecision({ platform, state: 'active', netGranted: false, tsNode: false });
            assert.strictEqual(decision.use, false, `${platform} launched a plugin with no mechanism behind it`);
        }
    });

    test('a failed Linux probe is never reported as a floor in force', () => {
        assert.strictEqual(isolate.__linuxFloorDecision({ platform: 'linux', zeroConf: 'degraded', netGranted: false }).layer, 'none');
        assert.strictEqual(isolate.__linuxFloorDecision({ platform: 'linux', zeroConf: 'active', netGranted: false }).layer, 'landlock');
        assert.strictEqual(isolate.__linuxFloorDecision({ platform: 'linux', zeroConf: 'active', netGranted: false }).denyNetwork, true);
    });
});

describe('F6 engine and budget certification (F6-INV-09)', () => {
    test('a driver is recognised by implementing the interface, not by where it lives', () => {
        const contract = Object.getOwnPropertyNames(DriverInterface.prototype).filter((name: string) => name !== 'constructor');
        assert.ok(contract.length >= 5, 'the driver contract must have real methods');
        const implementsContract = (candidate: any) => Boolean(candidate)
            && contract.every((method: string) => typeof candidate[method] === 'function');

        for (const name of ['postgres', 'mysql', 'sqlite-native-async']) {
            assert.strictEqual(implementsContract(require(`../drivers/${name}`)), true, `${name} must implement the driver contract`);
        }
        // Negative control: a module in the same directory that is NOT a driver must not be counted as
        // one, and a near-miss missing a single method must not either.
        assert.strictEqual(implementsContract(require('../drivers/mysql-text-rule')), false);
        const nearMiss: Record<string, unknown> = {};
        for (const method of contract.slice(1)) nearMiss[method] = () => undefined;
        assert.strictEqual(implementsContract(nearMiss), false, 'a driver missing one method is not a driver');
    });

    test('budget coverage is checked in BOTH directions — the negative control for the perf budget', () => {
        const measured = ['postCreateP95', 'postUpdateP95'];
        assert.deepStrictEqual(gate.budgetCoverageFailures(measured, measured), []);
        // A new measurement with no ceiling is unenforced.
        assert.strictEqual(gate.budgetCoverageFailures([...measured, 'postRenderP95'], measured).length, 1);
        // A ceiling nothing measures can never be exceeded, which reads as safety and is not.
        assert.strictEqual(gate.budgetCoverageFailures(measured, [...measured, 'ghostP95']).length, 1);
    });
});

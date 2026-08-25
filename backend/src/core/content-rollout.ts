/**
 * F6 rollout ramp for the F2 content validator.
 *
 * F2 shipped its generated validator already enforcing. That is rung 5 of the plan's ramp
 * ("new system on by default") reached without rungs 1 and 2 ever existing, so the earlier
 * rungs are not history here — they are the missing *reverse* gear. An operator who finds
 * that enforcement rejects a body production used to accept has, today, exactly two options:
 * ship a revert, or leave the type broken. This module adds the rung below enforcement and
 * the evidence that tells you when to leave it.
 *
 * Three properties are built in rather than left to callers:
 *
 *   1. The two validators are NEVER both run except inside `evaluateContentValidation`, which
 *      records the comparison before it returns. "No double-write without comparing results"
 *      is therefore structural, not a convention: there is no exported way to run the pair.
 *      `dualRuns` and `comparisons` are counted at the two ends of that one path and the report
 *      publishes their equality, so an edit that adds a second dual-run site is visible as data.
 *
 *   2. Divergence records carry field paths, issue codes and the SHAPE of the offending value —
 *      never the value. A divergence log on a write path that copies request bodies is a log of
 *      user content, indefinitely retained, in memory, on every node. `valueShape` answers the
 *      question that actually matters ("legacy took a string, the contract wants an integer")
 *      without becoming that.
 *
 *   3. Every ledger is bounded. Types, divergent fields, samples and deprecation keys all have
 *      caps, because the alternative is a remote input deciding how much memory a node keeps.
 *
 * Deliberately dependency-free apart from a lazy read of the app config: `core/content-schema`
 * imports this module and must stay loadable inside an isolated plugin worker, where
 * `config/app` is deliberately inert.
 */

export const CONTENT_VALIDATION_MODES = ['off', 'shadow', 'enforce'] as const;

export type ContentValidationMode = (typeof CONTENT_VALIDATION_MODES)[number];

export type ContentValidationOperation = 'create' | 'update';

interface ModePlan {
    /** Whose verdict the caller receives. This is the only thing that changes acceptance. */
    authority: 'permissive' | 'generated';
    /** When the other validator also runs — for comparison only, never for the verdict. */
    compare: 'always' | 'when-configured' | 'never';
}

/**
 * The ramp, as a table rather than a chain of ifs.
 *
 * Adding a mode to CONTENT_VALIDATION_MODES without deciding both of its columns is a
 * compile error here (`satisfies Record<ContentValidationMode, ModePlan>`) and a test
 * failure in f6-shadow-rollout, which enumerates the modes from the constant instead of
 * restating them. A mode with no plan must never fall through to "behaves like enforce".
 */
export const CONTENT_VALIDATION_PLAN = {
    // WHY THE LOW RUNG IS 'permissive' AND NOT 'legacy'.
    //
    // Both rows used to read `authority: 'legacy'`, and the legacy verdict was the schema
    // round-tripped through the legacy post-type descriptor. That round trip is the IDENTITY for
    // every type an installation can actually have — the built-ins build their fields with
    // `fieldsForFeatures(features)` and `adaptLegacyPostType` recomputes exactly that, and
    // `registerPostType` stores the already-adapted schema, so adapting it again changes nothing.
    // `validateContentInput` reads only `fields` and the discriminator, so the "legacy" verdict was
    // bit-for-bit the enforcing verdict, and BOTH lower rungs rejected precisely what `enforce`
    // rejects. Measured on the real `post` and `page` schemas: `{title:'x', status:'scheduled'}`
    // returned the same `status:enum` rejection under enforce, shadow AND off.
    //
    // Two things were broken by that, both of them the point of this module. The downgrade lever did
    // not downgrade — an operator whose writes started 400-ing could set `off`, restart every node,
    // and watch the same 400s. And `safeToEnforce` compared the enforcing validator against itself,
    // so it reported "no divergence" for every type in stage 3 of the ADR: a tautology presented as
    // evidence for the decision it was supposed to inform.
    //
    // The real pre-migration behaviour is not "the legacy descriptor's rules". Before F2 the write
    // routes ran NO contract validation at all — `POST /posts` destructured the body and defaulted
    // `status` without checking any enum. So the honest baseline for a downgrade is: accept, and let
    // the checks that existed before F2 (auth, sanitisation, the model) do their jobs unchanged.

    // Emergency downgrade: the contract does not reject, and the generated validator does not run,
    // so no evidence is collected either. The report names this state explicitly so "we saw no
    // divergences" can never be read as "nothing diverges".
    off: { authority: 'permissive', compare: 'never' },
    // Rung 1-2. Acceptance is the pre-migration behaviour — the contract cannot reject — while the
    // generated verdict is computed and recorded. A divergence here means exactly "enforcing would
    // have rejected this write", which is the signal stage 3 is supposed to be decided on. This rung
    // costs a second validation per write, which is why it is a rung and not a destination.
    shadow: { authority: 'permissive', compare: 'always' },
    // Rung 5, the default. The comparison is off by default here: once a type is enforcing, the
    // permissive run buys nothing per request forever. During a cut-over an operator turns
    // `compareWhileEnforcing` on to answer "what is enforcement now rejecting?".
    enforce: { authority: 'generated', compare: 'when-configured' },
} as const satisfies Record<ContentValidationMode, ModePlan>;

export interface ContentValidationConfig {
    /** Global default for every type that has no explicit entry in `types`. */
    mode: ContentValidationMode;
    /** Per-type ramp position: holds a type back, or opts one forward, without moving the rest. */
    types: Readonly<Record<string, ContentValidationMode>>;
    /** Keep comparing while enforcing (cut-over window). Off in steady state — it doubles cost. */
    compareWhileEnforcing: boolean;
    /** Rung 6. Off switches the legacy-adapter deprecation notices off, not their bookkeeping. */
    deprecationWarnings: boolean;
    /** Divergence samples retained per type. */
    sampleLimit: number;
    /** Comparisons a type needs before the report is willing to call enforcement safe. */
    minimumComparisons: number;
}

export interface ContentDivergentField {
    path: string;
    /** Issue code the legacy projection raised for this path, or 'accepted'. */
    legacy: string;
    /** Issue code the generated contract raised for this path, or 'accepted'. */
    generated: string;
    /** Shape of the submitted value — never the value itself. */
    valueShape: string;
}

export interface ContentDivergenceSample {
    at: string;
    route: string;
    operation: ContentValidationOperation;
    permissiveAccepted: boolean;
    generatedAccepted: boolean;
    fields: ContentDivergentField[];
}

export interface ContentRolloutTypeReport {
    type: string;
    mode: ContentValidationMode;
    modeSource: ContentModeSource;
    legacyDerived: boolean;
    comparisons: number;
    agreements: number;
    divergences: number;
    /** Evaluations that ran a single validator, so produced no evidence. */
    uncompared: number;
    divergentFields: string[];
    firstSeen: string | null;
    lastSeen: string | null;
    lastDivergenceAt: string | null;
    samples: ContentDivergenceSample[];
    safeToEnforce: boolean;
    reason: string;
}

export interface ContentRolloutReport {
    generatedAt: string;
    /**
     * Per PROCESS, not per cluster. Stated rather than implied: reading one node's report and
     * concluding "no divergences" is the multi-node version of never looking.
     */
    scope: { pid: number; startedAt: string; note: string };
    config: ContentValidationConfig;
    integrity: {
        dualRuns: number;
        comparisons: number;
        /** dualRuns === comparisons. False means a pair of validators ran without being compared. */
        everyDualRunCompared: boolean;
    };
    types: ContentRolloutTypeReport[];
    blockedFromEnforcing: string[];
    legacyCallers: Array<{ caller: string; type: string; firstAt: string; emitted: boolean; suppressed: number }>;
    deprecationLedgerFull: boolean;
}

/**
 * Why a type is at the rung it is at. `config/app` normalizes the block at boot, so the file
 * always carries a mode and "the operator wrote enforce" is indistinguishable from "nobody said
 * anything" — the report does not pretend otherwise and calls both `default`.
 */
export type ContentModeSource = 'type-override' | 'runtime-default' | 'default';

const DEFAULT_CONFIG: ContentValidationConfig = Object.freeze({
    mode: 'enforce' as ContentValidationMode,
    types: Object.freeze({}) as Readonly<Record<string, ContentValidationMode>>,
    compareWhileEnforcing: false,
    deprecationWarnings: true,
    sampleLimit: 20,
    minimumComparisons: 50,
});

const MAX_TRACKED_TYPES = 256;
const MAX_DIVERGENT_FIELDS_PER_TYPE = 64;
const MAX_SAMPLE_LIMIT = 200;
const MAX_DEPRECATION_KEYS = 512;
const MAX_TYPE_NAME_LENGTH = 128;

function isMode(value: unknown): value is ContentValidationMode {
    return typeof value === 'string' && (CONTENT_VALIDATION_MODES as readonly string[]).includes(value);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * Parse `post=shadow,page=off`. Unknown modes are dropped rather than defaulted: a typo in a
 * ramp lever must not silently move a type to some other rung.
 */
function parseTypeModes(value: unknown): Record<string, ContentValidationMode> {
    const modes: Record<string, ContentValidationMode> = {};
    if (typeof value === 'string') {
        for (const pair of value.split(',')) {
            const [name, mode] = pair.split('=').map((part) => part.trim());
            if (name && isMode(mode)) modes[name.slice(0, MAX_TYPE_NAME_LENGTH)] = mode;
        }
        return modes;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, mode] of Object.entries(value as Record<string, unknown>)) {
            if (name && name !== '__proto__' && isMode(mode)) modes[name.slice(0, MAX_TYPE_NAME_LENGTH)] = mode;
        }
    }
    return modes;
}

/**
 * Normalize the `contentValidation` block of wordjs-config.json. Idempotent, so config/app can
 * call it at boot and this module can re-run it over the already-normalized object without the
 * two disagreeing — a single source for the union, the defaults and the env levers.
 *
 * Environment wins over the file here, unlike most of config/app. The ramp is an operational
 * lever pulled per node in the middle of a cut-over; making it require an edit-and-persist of a
 * shared config file is how an operator ends up skipping the shadow rung altogether.
 */
export function normalizeContentValidationConfig(raw: unknown): ContentValidationConfig {
    const source = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
    const envMode = process.env.WORDJS_CONTENT_VALIDATION;
    const fileTypes = parseTypeModes(source.types);
    const envTypes = parseTypeModes(process.env.WORDJS_CONTENT_VALIDATION_TYPES);
    return {
        mode: isMode(envMode) ? envMode : (isMode(source.mode) ? source.mode : DEFAULT_CONFIG.mode),
        types: Object.freeze({ ...fileTypes, ...envTypes }),
        compareWhileEnforcing: source.compareWhileEnforcing !== undefined
            ? source.compareWhileEnforcing === true
            : process.env.WORDJS_CONTENT_VALIDATION_COMPARE === 'true',
        deprecationWarnings: source.deprecationWarnings !== false,
        sampleLimit: boundedInteger(source.sampleLimit, DEFAULT_CONFIG.sampleLimit, 0, MAX_SAMPLE_LIMIT),
        minimumComparisons: boundedInteger(source.minimumComparisons, DEFAULT_CONFIG.minimumComparisons, 1, 1_000_000),
    };
}

let runtimeOverride: Partial<ContentValidationConfig> | null = null;
let effectiveCache: { key: unknown; override: unknown; value: ContentValidationConfig } | null = null;

let appConfig: { contentValidation?: unknown } | null = null;

function fileBlock(): unknown {
    // Lazy: config/app reads the filesystem at load and is deliberately inert inside an isolated
    // plugin worker. Requiring it at module scope would drag that into core/content-schema.
    // Resolved ONCE — this runs on the content write path, and `require` of a cached module is
    // still a lookup per request. The property is re-read every call so a runtime change to
    // config.contentValidation is honoured without a restart.
    if (!appConfig) {
        try {
            appConfig = require('../config/app') || null;
        } catch {
            return undefined;
        }
    }
    return appConfig ? appConfig.contentValidation : undefined;
}

/** Effective ramp configuration: runtime override over environment over file over defaults. */
export function contentValidationConfig(): ContentValidationConfig {
    const key = fileBlock();
    if (effectiveCache && effectiveCache.key === key && effectiveCache.override === runtimeOverride) {
        return effectiveCache.value;
    }
    const base = normalizeContentValidationConfig(key);
    // Merged field by field rather than re-normalized: re-running normalize would let the
    // environment levers land on top of the runtime override a second time, so an admin action
    // taken during a cut-over would be silently undone by an env var set at boot.
    const patch = runtimeOverride;
    const value: ContentValidationConfig = patch ? {
        mode: isMode(patch.mode) ? patch.mode : base.mode,
        types: Object.freeze({ ...base.types, ...parseTypeModes(patch.types) }),
        compareWhileEnforcing: patch.compareWhileEnforcing !== undefined
            ? patch.compareWhileEnforcing === true : base.compareWhileEnforcing,
        deprecationWarnings: patch.deprecationWarnings !== undefined
            ? patch.deprecationWarnings !== false : base.deprecationWarnings,
        sampleLimit: patch.sampleLimit !== undefined
            ? boundedInteger(patch.sampleLimit, base.sampleLimit, 0, MAX_SAMPLE_LIMIT) : base.sampleLimit,
        minimumComparisons: patch.minimumComparisons !== undefined
            ? boundedInteger(patch.minimumComparisons, base.minimumComparisons, 1, 1_000_000) : base.minimumComparisons,
    } : base;
    effectiveCache = { key, override: runtimeOverride, value };
    return value;
}

/**
 * In-process ramp lever. This is what an admin action or a test moves; the config file remains
 * the boot position. Returns the resulting effective configuration so a caller can log what it
 * actually achieved rather than what it asked for.
 */
export function configureContentRollout(patch: Partial<ContentValidationConfig> | null): ContentValidationConfig {
    runtimeOverride = patch ? { ...patch } : null;
    effectiveCache = null;
    return contentValidationConfig();
}

export function resolveContentValidationMode(type: string): { mode: ContentValidationMode; source: ContentModeSource } {
    const config = contentValidationConfig();
    const override = Object.prototype.hasOwnProperty.call(config.types, type) ? config.types[type] : undefined;
    if (isMode(override)) return { mode: override, source: 'type-override' };
    if (runtimeOverride && isMode(runtimeOverride.mode)) return { mode: config.mode, source: 'runtime-default' };
    return { mode: config.mode, source: 'default' };
}

interface TypeStats {
    comparisons: number;
    agreements: number;
    divergences: number;
    uncompared: number;
    divergentFields: Set<string>;
    firstSeen: string | null;
    lastSeen: string | null;
    lastDivergenceAt: string | null;
    samples: ContentDivergenceSample[];
}

const stats = new Map<string, TypeStats>();
const legacyDerivedTypes = new Set<string>();
const deprecationLedger = new Map<string, { caller: string; type: string; firstAt: string; emitted: boolean; suppressed: number }>();
let deprecationLedgerFull = false;
let dualRuns = 0;
let comparisons = 0;
let startedAt = new Date().toISOString();

function statsFor(type: string): TypeStats | null {
    const existing = stats.get(type);
    if (existing) return existing;
    // A registry can only hold registered types, but the cap stays: the day a caller passes an
    // unregistered discriminator through here, the ledger must not be the thing that grows.
    if (stats.size >= MAX_TRACKED_TYPES) return null;
    const created: TypeStats = {
        comparisons: 0, agreements: 0, divergences: 0, uncompared: 0,
        divergentFields: new Set<string>(),
        firstSeen: null, lastSeen: null, lastDivergenceAt: null,
        samples: [],
    };
    stats.set(type, created);
    return created;
}

/** Shape, never value: the divergence record must not become a copy of user content. */
export function valueShapeOf(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'absent';
    if (Array.isArray(value)) return `array[${value.length}]`;
    if (typeof value === 'string') return value === '' ? 'string(empty)' : `string(${value.length})`;
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    if (typeof value === 'object') return 'object';
    return typeof value;
}

export interface ContentIssueLike {
    path: string;
    code: string;
}

function issueMap(issues: ReadonlyArray<ContentIssueLike>): Map<string, string> {
    const map = new Map<string, string>();
    for (const issue of issues) if (!map.has(issue.path)) map.set(issue.path, issue.code);
    return map;
}

function compareIssues(
    legacy: ReadonlyArray<ContentIssueLike>,
    generated: ReadonlyArray<ContentIssueLike>,
    shapeAt: (path: string) => string,
): ContentDivergentField[] {
    const left = issueMap(legacy);
    const right = issueMap(generated);
    const fields: ContentDivergentField[] = [];
    for (const path of new Set([...left.keys(), ...right.keys()])) {
        const legacyCode = left.get(path) || 'accepted';
        const generatedCode = right.get(path) || 'accepted';
        if (legacyCode === generatedCode) continue;
        fields.push({ path, legacy: legacyCode, generated: generatedCode, valueShape: shapeAt(path) });
    }
    return fields.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ContentComparisonInput<R> {
    type: string;
    operation: ContentValidationOperation;
    /** Which surface produced this write. Defaults to the canonical REST route for the operation. */
    route?: string;
    /**
     * The pre-migration verdict: what the write path accepted before F2 added the contract check.
     * Never invoked unless the plan says the permissive path runs.
     *
     * Named `permissive`, not `legacy`, because the previous name invited exactly the implementation
     * that broke the ramp — "run the legacy projection of the schema", which for every real type is
     * the generated validator wearing a different hat.
     */
    permissive: () => R;
    /** The generated F2 verdict. Never invoked unless the plan says the generated path runs. */
    generated: () => R;
    accepted: (result: R) => boolean;
    issuesOf: (result: R) => ReadonlyArray<ContentIssueLike>;
    /** Shape lookup for a field path, used to describe a divergence without recording the value. */
    shapeAt?: (path: string) => string;
}

export interface ContentComparisonOutcome<R> {
    mode: ContentValidationMode;
    modeSource: ContentModeSource;
    /** The verdict the caller must act on. */
    verdict: R;
    compared: boolean;
    diverged: boolean;
}

function defaultRoute(operation: ContentValidationOperation): string {
    return operation === 'create' ? 'POST /posts' : 'PUT /posts/:id';
}

/**
 * Run the ramp for one write.
 *
 * THE ONLY PLACE BOTH VALIDATORS RUN. The recording is not a call the caller makes afterwards
 * and can forget; it happens between the second run and the return, on every path. If someone
 * later adds a second site that invokes both, `dualRuns` stops matching `comparisons` and the
 * report's `everyDualRunCompared` goes false — which the F6 test asserts.
 */
export function evaluateContentValidation<R>(input: ContentComparisonInput<R>): ContentComparisonOutcome<R> {
    const type = String(input.type || '').slice(0, MAX_TYPE_NAME_LENGTH);
    const { mode, source } = resolveContentValidationMode(type);
    const plan = CONTENT_VALIDATION_PLAN[mode];
    const config = contentValidationConfig();

    if (legacyDerivedTypes.has(type)) {
        // Rung 6, and the reason it lives here: this fires on a REQUEST path. Once per type, not
        // once per write — a warning that repeats on every save is a warning an operator filters
        // out on day one, which is indistinguishable from never having emitted it.
        warnLegacyContentCaller('rest-write', type,
            `content type '${type}' is validated through the legacy registerPostType adapter; declare it with registerContentType before the adapters are retired`);
    }

    const compare = plan.compare === 'always'
        || (plan.compare === 'when-configured' && config.compareWhileEnforcing);

    if (!compare) {
        const verdict = plan.authority === 'permissive' ? input.permissive() : input.generated();
        const entry = statsFor(type);
        if (entry) {
            entry.uncompared++;
            entry.lastSeen = new Date().toISOString();
            if (!entry.firstSeen) entry.firstSeen = entry.lastSeen;
        }
        return { mode, modeSource: source, verdict, compared: false, diverged: false };
    }

    dualRuns++;
    const permissiveResult = input.permissive();
    const generatedResult = input.generated();
    const diverged = recordContentComparison(type, input, permissiveResult, generatedResult);
    return {
        mode,
        modeSource: source,
        verdict: plan.authority === 'permissive' ? permissiveResult : generatedResult,
        compared: true,
        diverged,
    };
}

/**
 * Intentionally NOT exported. Exporting it would allow a caller to run both validators and then
 * decide whether to record, which is the exact hole `evaluateContentValidation` exists to close.
 */
function recordContentComparison<R>(
    type: string,
    input: ContentComparisonInput<R>,
    permissiveResult: R,
    generatedResult: R,
): boolean {
    comparisons++;
    const at = new Date().toISOString();
    const permissiveAccepted = input.accepted(permissiveResult);
    const generatedAccepted = input.accepted(generatedResult);
    const shapeAt = input.shapeAt || (() => 'unknown');
    const fields = compareIssues(input.issuesOf(permissiveResult), input.issuesOf(generatedResult), shapeAt);
    const diverged = fields.length > 0 || permissiveAccepted !== generatedAccepted;

    const entry = statsFor(type);
    if (!entry) return diverged;
    entry.comparisons++;
    entry.lastSeen = at;
    if (!entry.firstSeen) entry.firstSeen = at;
    if (!diverged) {
        entry.agreements++;
        return false;
    }
    entry.divergences++;
    entry.lastDivergenceAt = at;
    for (const field of fields) {
        if (entry.divergentFields.size >= MAX_DIVERGENT_FIELDS_PER_TYPE) break;
        entry.divergentFields.add(field.path);
    }
    const limit = contentValidationConfig().sampleLimit;
    if (limit > 0) {
        entry.samples.push({
            at,
            route: input.route || defaultRoute(input.operation),
            operation: input.operation,
            permissiveAccepted,
            generatedAccepted,
            fields: fields.slice(0, MAX_DIVERGENT_FIELDS_PER_TYPE),
        });
        // Ring, newest kept: during a cut-over the last twenty divergences are the ones being
        // debugged, and an unbounded array here is a remote client choosing this node's heap.
        while (entry.samples.length > limit) entry.samples.shift();
    }
    return diverged;
}

/**
 * Mark a type as produced by the legacy registration adapter, and announce it once.
 *
 * Called from `adaptLegacyPostType`, which is the single funnel every legacy registration passes
 * through. The mark is what lets the write path know it is validating a lossily-described type
 * without post-types.ts having to carry a flag for it.
 */
export function noteLegacyContentAdapter(type: string, detail?: string): void {
    const name = String(type || '').slice(0, MAX_TYPE_NAME_LENGTH);
    if (!name) return;
    legacyDerivedTypes.add(name);
    warnLegacyContentCaller('registerPostType', name,
        detail || `content type '${name}' was registered through the legacy registerPostType adapter`);
}

export function isLegacyDerivedType(type: string): boolean {
    return legacyDerivedTypes.has(type);
}

/**
 * Emit a deprecation notice ONCE per (caller, type) and count what it suppressed.
 *
 * A plugin that re-registers on every activation cycle, or a route that validates on every save,
 * would otherwise turn rung 6 into log noise. The suppressed counter keeps the volume visible in
 * the report even though it is invisible in the log — which is the property a muted warning loses.
 */
export function warnLegacyContentCaller(caller: string, type: string, message: string): boolean {
    const key = `${caller}|${type}`;
    const existing = deprecationLedger.get(key);
    if (existing) {
        existing.suppressed++;
        return false;
    }
    if (deprecationLedger.size >= MAX_DEPRECATION_KEYS) {
        if (!deprecationLedgerFull) {
            deprecationLedgerFull = true;
            console.warn('[wordjs][deprecation] legacy content-adapter ledger is full; further deprecation notices are suppressed. See contentRolloutReport().');
        }
        return false;
    }
    const enabled = contentValidationConfig().deprecationWarnings;
    deprecationLedger.set(key, { caller, type, firstAt: new Date().toISOString(), emitted: enabled, suppressed: 0 });
    // The ledger entry is created either way: turning the notices off must silence the log, not
    // erase the fact that a legacy caller exists. The report is the durable answer.
    if (enabled) console.warn(`[wordjs][deprecation] ${message} (${caller})`);
    return enabled;
}

function verdictOnEnforcing(type: string, mode: ContentValidationMode, entry: TypeStats | undefined, minimum: number): { safeToEnforce: boolean; reason: string } {
    if (!entry || entry.comparisons === 0) {
        return mode === 'off'
            ? { safeToEnforce: false, reason: 'validation is disabled for this type; no evidence is being collected' }
            : { safeToEnforce: false, reason: 'no comparisons recorded yet' };
    }
    if (entry.divergences > 0) {
        const fields = [...entry.divergentFields].sort().join(', ') || '<verdict only>';
        return {
            safeToEnforce: false,
            reason: `${entry.divergences} of ${entry.comparisons} comparisons diverged on: ${fields}`,
        };
    }
    if (entry.comparisons < minimum) {
        return {
            safeToEnforce: false,
            reason: `agreement so far, but only ${entry.comparisons} of the ${minimum} comparisons required as evidence`,
        };
    }
    return {
        safeToEnforce: true,
        reason: `${entry.comparisons} comparisons since ${entry.firstSeen}, no divergence`,
    };
}

/**
 * The queryable answer to "is it safe to enforce yet?".
 *
 * This is a REPORT built from in-process counters, not an option row and not a persisted table.
 * Persisting a divergence would put a second write on the content write path — the one thing F3's
 * transactional unit exists to prevent — and would make the observability of the migration depend
 * on the storage the migration is changing. The cost is that the answer is per node; `scope` says
 * so out loud so an operator aggregates instead of trusting one process's view.
 */
export function contentRolloutReport(): ContentRolloutReport {
    const config = contentValidationConfig();
    const types: ContentRolloutTypeReport[] = [];
    const names = new Set<string>([...stats.keys(), ...Object.keys(config.types), ...legacyDerivedTypes]);
    for (const type of [...names].sort()) {
        const entry = stats.get(type);
        const { mode, source } = resolveContentValidationMode(type);
        const verdict = verdictOnEnforcing(type, mode, entry, config.minimumComparisons);
        types.push({
            type,
            mode,
            modeSource: source,
            legacyDerived: legacyDerivedTypes.has(type),
            comparisons: entry ? entry.comparisons : 0,
            agreements: entry ? entry.agreements : 0,
            divergences: entry ? entry.divergences : 0,
            uncompared: entry ? entry.uncompared : 0,
            divergentFields: entry ? [...entry.divergentFields].sort() : [],
            firstSeen: entry ? entry.firstSeen : null,
            lastSeen: entry ? entry.lastSeen : null,
            lastDivergenceAt: entry ? entry.lastDivergenceAt : null,
            samples: entry ? entry.samples.map((sample) => ({ ...sample, fields: sample.fields.map((field) => ({ ...field })) })) : [],
            safeToEnforce: verdict.safeToEnforce,
            reason: verdict.reason,
        });
    }
    return {
        generatedAt: new Date().toISOString(),
        scope: {
            pid: process.pid,
            startedAt,
            note: 'per-process counters; aggregate every node before concluding a type is safe to enforce',
        },
        config,
        integrity: {
            dualRuns,
            comparisons,
            everyDualRunCompared: dualRuns === comparisons,
        },
        types,
        blockedFromEnforcing: types.filter((entry) => !entry.safeToEnforce && entry.mode !== 'enforce').map((entry) => entry.type),
        legacyCallers: [...deprecationLedger.values()].map((entry) => ({ ...entry })),
        deprecationLedgerFull,
    };
}

/** Test seam. Production has no reason to forget evidence mid-flight. */
export function resetContentRollout(): void {
    stats.clear();
    legacyDerivedTypes.clear();
    deprecationLedger.clear();
    deprecationLedgerFull = false;
    dualRuns = 0;
    comparisons = 0;
    startedAt = new Date().toISOString();
    runtimeOverride = null;
    effectiveCache = null;
}

module.exports = {
    CONTENT_VALIDATION_MODES,
    CONTENT_VALIDATION_PLAN,
    normalizeContentValidationConfig,
    contentValidationConfig,
    configureContentRollout,
    resolveContentValidationMode,
    evaluateContentValidation,
    noteLegacyContentAdapter,
    isLegacyDerivedType,
    warnLegacyContentCaller,
    contentRolloutReport,
    resetContentRollout,
    valueShapeOf,
};

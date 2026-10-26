/**
 * WordJS - GraphQL query limits (depth and cost), as graphql-js validation rules.
 *
 * Both rules run at VALIDATION time, before a single resolver (and therefore before a single REST
 * sub-request) executes, so an abusive document is refused for the price of parsing it.
 *
 *  · DEPTH — the deepest chain of nested selection sets, fragments expanded. Introspection's own
 *    `__schema`/`__type` subtrees are measured too (they are the classic depth bomb).
 *  · COST — an upper bound on the work a query can trigger. Every field that returns an OBJECT costs 1
 *    and every scalar leaf costs LEAF_COST (a tenth): a leaf is read from a payload already fetched, but it
 *    is still a value written into the response, so a list multiplies it like any other field and a page
 *    of aliased leaves is not free. A field whose definition carries
 *    `extensions.cost.rest` is backed by a REST sub-request and costs REST_COST more, leaf or not.
 *    A field marked `extensions.cost.list` returns a page: its subtree is multiplied by the page size it
 *    asked for (`first`, or the default when absent, or the MAXIMUM when the value is a variable —
 *    validation cannot see variable values, so it assumes the worst). Aliases are separate fields and
 *    are counted separately, so `a: posts … b: posts …` cannot multiply work for free.
 *  · FIELDS — how many fields the operation selects once every fragment is expanded (no page multiplier:
 *    this bounds the shape of the response, the cost bounds its volume), and how many ALIASED fields one
 *    selection set holds, the fragments spread into it counted with it. The parser's token cap bounds the
 *    document, but a fragment spread in many places expands to many more fields than it has tokens.
 *
 *  · MUTATIONS — every field of the Mutation root (and any field marked `extensions.cost.mutation`) is a
 *    REST write: it costs MUTATION_COST on top
 *    (so writes are never free next to reads), and an operation may hold at most `maxMutations` of them,
 *    aliases and fragment spreads counted one by one. The API rate limiter counts the GraphQL request
 *    once; without the cap one document could carry an unbounded batch of writes past it.
 *
 * Plugin fields (core/graphql/extensions) may declare the same `extensions.cost`; without it they cost
 * what any other field costs (1 for an object, LEAF_COST for a scalar).
 */

import {
    GraphQLError,
    getNamedType,
    isObjectType,
    isInterfaceType,
    Kind,
} from 'graphql';
import type {
    ASTVisitor,
    FieldNode,
    FragmentDefinitionNode,
    GraphQLField,
    GraphQLNamedType,
    SelectionSetNode,
    ValidationContext,
    ValueNode,
} from 'graphql';

export const REST_COST = 5;
/** Extra cost of a REST write (a mutation field), on top of REST_COST. */
export const MUTATION_COST = 20;
/** Cost of a scalar leaf (an object field costs 1). */
export const LEAF_COST = 0.1;

// The walk sums whole tenths (UNIT per cost point), so adding leaves never drifts past a limit by rounding.
const UNIT = 10;

export interface FieldCost {
    /** The field is resolved with a REST sub-request. */
    rest?: boolean;
    /** The field returns a page of `first` items (connection) — its subtree is multiplied by that size. */
    list?: boolean;
    /** Page size assumed when `first` is not given. */
    defaultFirst?: number;
    /** The field is a REST write (a mutation): costs MUTATION_COST more and counts against maxMutations. */
    mutation?: boolean;
}

export interface LimitOptions {
    maxDepth: number;
    maxCost: number;
    maxPageSize: number;
    /** Most mutation fields one operation may hold (default 10). */
    maxMutations?: number;
    /** Most fields one operation may select, fragments expanded (default 1000). */
    maxFields?: number;
    /** Most aliased fields one selection set may hold, fragments spread into it included (default 50). */
    maxAliases?: number;
}

function fieldCostOf(def: GraphQLField<any, any> | undefined): FieldCost {
    const ext: any = def && def.extensions;
    return (ext && ext.cost) || {};
}

function intArg(node: FieldNode, name: string): { present: boolean; value: number | null } {
    const arg = (node.arguments || []).find(a => a.name.value === name);
    if (!arg) return { present: false, value: null };
    const v: ValueNode = arg.value;
    if (v.kind === Kind.INT) return { present: true, value: parseInt(v.value, 10) };
    // A variable (or anything else): unknown at validation time.
    return { present: true, value: null };
}

function fieldsOf(type: GraphQLNamedType | null | undefined): Record<string, GraphQLField<any, any>> | null {
    if (type && (isObjectType(type) || isInterfaceType(type))) return type.getFields();
    return null;
}

/**
 * `cost` is in tenths (UNIT). `aliases` counts the aliased fields of THIS selection set (a fragment's own
 * level adds to the level it is spread into); `aliasPeak` is the most any nested selection set holds.
 */
type Measure = { depth: number; cost: number; mutations: number; fields: number; aliases: number; aliasPeak: number };

/** Per-operation walk state: fragment cycle guard and the memo of already-measured fragments. */
interface WalkState {
    visiting: Set<string>;
    memo: Map<string, Measure>;
}

/** A partial result already over a limit: the caller needs no exact figure to refuse the operation. */
function overLimit(m: Measure, opts: LimitOptions): boolean {
    return m.cost > opts.maxCost * UNIT || m.depth > opts.maxDepth || m.mutations > maxMutationsOf(opts)
        || m.fields > maxFieldsOf(opts) || Math.max(m.aliases, m.aliasPeak) > maxAliasesOf(opts);
}

function maxMutationsOf(opts: LimitOptions): number {
    return opts.maxMutations && opts.maxMutations > 0 ? opts.maxMutations : 10;
}

function maxFieldsOf(opts: LimitOptions): number {
    return opts.maxFields && opts.maxFields > 0 ? opts.maxFields : 1000;
}

function maxAliasesOf(opts: LimitOptions): number {
    return opts.maxAliases && opts.maxAliases > 0 ? opts.maxAliases : 50;
}

/**
 * Walk a selection set, expanding fragments, and report (depth, cost). `visiting` guards fragment
 * cycles (NoFragmentCyclesRule reports them; this walker must simply not recurse forever on one).
 *
 * A fragment's (depth, cost) depends only on its own selections and the type it is measured against,
 * so it is measured ONCE per (fragment, type) and reused for every later spread: without the memo a
 * chain of fragments that each spread the next one twice costs 2^n walks to measure. The walk also
 * stops as soon as a running figure passes a limit — the operation is refused either way, and the
 * reported figure is then a lower bound ("at least").
 */
function measure(
    context: ValidationContext,
    selectionSet: SelectionSetNode,
    parentType: GraphQLNamedType | null,
    opts: LimitOptions,
    state: WalkState,
): Measure {
    let depth = 0;
    let cost = 0;
    let mutations = 0;
    let selected = 0;
    let aliases = 0;
    let aliasPeak = 0;
    const add = (r: Measure) => {
        depth = Math.max(depth, r.depth);
        cost += r.cost;
        mutations += r.mutations;
        selected += r.fields;
        aliases += r.aliases;
        aliasPeak = Math.max(aliasPeak, r.aliasPeak);
    };
    for (const sel of selectionSet.selections) {
        if (sel.kind === Kind.FIELD) {
            const name = sel.name.value;
            selected++;
            if (sel.alias && sel.alias.value !== name) aliases++;
            if (name === '__typename') {
                if (overLimit({ depth, cost, mutations, fields: selected, aliases, aliasPeak }, opts)) break;
                continue;
            }
            const fields = fieldsOf(parentType);
            const def = fields ? fields[name] : undefined;
            let childType: GraphQLNamedType | null = def ? getNamedType(def.type) : null;
            if (!def && name === '__schema') childType = context.getSchema().getType('__Schema') || null;
            if (!def && name === '__type') childType = context.getSchema().getType('__Type') || null;
            const spec = fieldCostOf(def);
            // Every field of the Mutation root is a write, declared or not (an extension's included).
            const isWrite = !!spec.mutation || (!!parentType && parentType === context.getSchema().getMutationType());
            let child: Measure = { depth: 0, cost: 0, mutations: 0, fields: 0, aliases: 0, aliasPeak: 0 };
            if (sel.selectionSet) child = measure(context, sel.selectionSet, childType, opts, state);
            let multiplier = 1;
            if (spec.list) {
                const first = intArg(sel, 'first');
                multiplier = !first.present
                    ? (spec.defaultFirst || 10)
                    : (first.value === null ? opts.maxPageSize : Math.max(0, Math.min(first.value, opts.maxPageSize)));
            }
            const own = sel.selectionSet ? UNIT : LEAF_COST * UNIT;
            cost += own + (spec.rest ? REST_COST * UNIT : 0) + (isWrite ? MUTATION_COST * UNIT : 0) + multiplier * child.cost;
            depth = Math.max(depth, 1 + child.depth);
            mutations += (isWrite ? 1 : 0) + child.mutations;
            selected += child.fields;
            // The child's own level is a selection set of its own.
            aliasPeak = Math.max(aliasPeak, child.aliases, child.aliasPeak);
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
            const cond = sel.typeCondition ? context.getSchema().getType(sel.typeCondition.name.value) : parentType;
            add(measure(context, sel.selectionSet, cond || parentType, opts, state));
        } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
            const name = sel.name.value;
            if (state.visiting.has(name)) continue;
            const frag: FragmentDefinitionNode | null | undefined = context.getFragment(name);
            if (!frag) continue;
            const cond = context.getSchema().getType(frag.typeCondition.name.value) || parentType;
            const key = `${name}|${cond ? cond.name : ''}`;
            let r = state.memo.get(key);
            if (!r) {
                state.visiting.add(name);
                r = measure(context, frag.selectionSet, cond, opts, state);
                state.visiting.delete(name);
                state.memo.set(key, r);
            }
            add(r);
        }
        if (overLimit({ depth, cost, mutations, fields: selected, aliases, aliasPeak }, opts)) break;
    }
    return { depth, cost, mutations, fields: selected, aliases, aliasPeak };
}

/** Measure one operation; exported for tests and for the X-GraphQL-Cost diagnostics. `cost` is rounded up. */
export function measureOperation(context: ValidationContext, selectionSet: SelectionSetNode, rootType: GraphQLNamedType | null, opts: LimitOptions) {
    const m = measure(context, selectionSet, rootType, opts, { visiting: new Set(), memo: new Map() });
    return { depth: m.depth, cost: Math.ceil(m.cost / UNIT), mutations: m.mutations, fields: m.fields, aliases: Math.max(m.aliases, m.aliasPeak) };
}

/** One rule for both limits, so each operation is walked once. */
export function createLimitRule(opts: LimitOptions) {
    return function QueryLimitsRule(context: ValidationContext): ASTVisitor {
        return {
            OperationDefinition(node) {
                const schema = context.getSchema();
                const root = node.operation === 'query' ? schema.getQueryType()
                    : node.operation === 'mutation' ? schema.getMutationType()
                        : schema.getSubscriptionType();
                const { depth, cost, mutations, fields, aliases } = measureOperation(context, node.selectionSet, root || null, opts);
                if (depth > opts.maxDepth) {
                    context.reportError(new GraphQLError(
                        `Query depth ${depth} exceeds the maximum allowed depth of ${opts.maxDepth}.`,
                        { nodes: [node], extensions: { code: 'GRAPHQL_DEPTH_LIMIT', depth, maxDepth: opts.maxDepth } },
                    ));
                }
                if (mutations > maxMutationsOf(opts)) {
                    context.reportError(new GraphQLError(
                        `Operation holds ${mutations} mutations; at most ${maxMutationsOf(opts)} are allowed per document.`,
                        { nodes: [node], extensions: { code: 'GRAPHQL_MUTATION_LIMIT', mutations, maxMutations: maxMutationsOf(opts) } },
                    ));
                }
                if (fields > maxFieldsOf(opts)) {
                    context.reportError(new GraphQLError(
                        `Operation selects at least ${fields} fields; at most ${maxFieldsOf(opts)} are allowed (fragments expanded).`,
                        { nodes: [node], extensions: { code: 'GRAPHQL_FIELD_LIMIT', fields, maxFields: maxFieldsOf(opts) } },
                    ));
                }
                if (aliases > maxAliasesOf(opts)) {
                    context.reportError(new GraphQLError(
                        `A selection set holds at least ${aliases} aliased fields; at most ${maxAliasesOf(opts)} are allowed.`,
                        { nodes: [node], extensions: { code: 'GRAPHQL_ALIAS_LIMIT', aliases, maxAliases: maxAliasesOf(opts) } },
                    ));
                }
                if (cost > opts.maxCost) {
                    context.reportError(new GraphQLError(
                        `Query cost ${cost} exceeds the maximum allowed cost of ${opts.maxCost}.`,
                        { nodes: [node], extensions: { code: 'GRAPHQL_COST_LIMIT', cost, maxCost: opts.maxCost } },
                    ));
                }
            },
        };
    };
}

/**
 * Does `value`, serialized as JSON, take more than `maxBytes`? Answered by walking the value and adding up
 * what each piece writes, stopping at the first byte past the limit — never by serializing it: a result
 * whose leaves are all the same string (aliases of one field) holds a few references in memory, and it is
 * JSON.stringify that would turn them into the response that does not fit.
 */
export function exceedsResponseBytes(value: unknown, maxBytes: number): boolean {
    let total = 0;
    const stack: unknown[] = [value];
    // Every object adds at least two bytes, so even a cycle ends here — as "too large".
    while (stack.length) {
        const v = stack.pop();
        if (v === null || v === undefined) total += 4;
        else if (typeof v === 'string') total += Buffer.byteLength(v, 'utf8') + 2;
        else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') total += String(v).length;
        else if (typeof v === 'object') {
            if (Array.isArray(v)) {
                total += 2 + v.length;
                for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
            } else if (typeof (v as any).toJSON === 'function') {
                const j = (v as any).toJSON();
                total += 2;
                if (j !== v) stack.push(j);
            } else {
                total += 2;
                for (const k of Object.keys(v as object)) {
                    total += Buffer.byteLength(k, 'utf8') + 4;
                    stack.push((v as any)[k]);
                }
            }
        }
        if (total > maxBytes) return true;
    }
    return false;
}

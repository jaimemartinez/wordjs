/**
 * WordJS - GraphQL query limits (depth and cost), as graphql-js validation rules.
 *
 * Both rules run at VALIDATION time, before a single resolver (and therefore before a single REST
 * sub-request) executes, so an abusive document is refused for the price of parsing it.
 *
 *  · DEPTH — the deepest chain of nested selection sets, fragments expanded. Introspection's own
 *    `__schema`/`__type` subtrees are measured too (they are the classic depth bomb).
 *  · COST — an upper bound on the work a query can trigger. Every field that returns an OBJECT costs 1
 *    (a scalar leaf is read from a payload already fetched and costs nothing; the parser's token cap is
 *    what bounds a document made of thousands of scalar aliases). A field whose definition carries
 *    `extensions.cost.rest` is backed by a REST sub-request and costs REST_COST more, leaf or not.
 *    A field marked `extensions.cost.list` returns a page: its subtree is multiplied by the page size it
 *    asked for (`first`, or the default when absent, or the MAXIMUM when the value is a variable —
 *    validation cannot see variable values, so it assumes the worst). Aliases are separate fields and
 *    are counted separately, so `a: posts … b: posts …` cannot multiply work for free.
 *
 * Plugin fields (core/graphql/extensions) may declare the same `extensions.cost`; without it they cost
 * what any other field costs (1 for an object, 0 for a scalar).
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

export interface FieldCost {
    /** The field is resolved with a REST sub-request. */
    rest?: boolean;
    /** The field returns a page of `first` items (connection) — its subtree is multiplied by that size. */
    list?: boolean;
    /** Page size assumed when `first` is not given. */
    defaultFirst?: number;
}

export interface LimitOptions {
    maxDepth: number;
    maxCost: number;
    maxPageSize: number;
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

type Measure = { depth: number; cost: number };

/** Per-operation walk state: fragment cycle guard and the memo of already-measured fragments. */
interface WalkState {
    visiting: Set<string>;
    memo: Map<string, Measure>;
}

/** A partial result already over a limit: the caller needs no exact figure to refuse the operation. */
function overLimit(m: Measure, opts: LimitOptions): boolean {
    return m.cost > opts.maxCost || m.depth > opts.maxDepth;
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
    for (const sel of selectionSet.selections) {
        if (sel.kind === Kind.FIELD) {
            const name = sel.name.value;
            if (name === '__typename') continue;
            const fields = fieldsOf(parentType);
            const def = fields ? fields[name] : undefined;
            let childType: GraphQLNamedType | null = def ? getNamedType(def.type) : null;
            if (!def && name === '__schema') childType = context.getSchema().getType('__Schema') || null;
            if (!def && name === '__type') childType = context.getSchema().getType('__Type') || null;
            const spec = fieldCostOf(def);
            let child = { depth: 0, cost: 0 };
            if (sel.selectionSet) child = measure(context, sel.selectionSet, childType, opts, state);
            let multiplier = 1;
            if (spec.list) {
                const first = intArg(sel, 'first');
                multiplier = !first.present
                    ? (spec.defaultFirst || 10)
                    : (first.value === null ? opts.maxPageSize : Math.max(0, Math.min(first.value, opts.maxPageSize)));
            }
            cost += (sel.selectionSet ? 1 : 0) + (spec.rest ? REST_COST : 0) + multiplier * child.cost;
            depth = Math.max(depth, 1 + child.depth);
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
            const cond = sel.typeCondition ? context.getSchema().getType(sel.typeCondition.name.value) : parentType;
            const r = measure(context, sel.selectionSet, cond || parentType, opts, state);
            depth = Math.max(depth, r.depth);
            cost += r.cost;
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
            depth = Math.max(depth, r.depth);
            cost += r.cost;
        }
        if (overLimit({ depth, cost }, opts)) break;
    }
    return { depth, cost };
}

/** Measure one operation; exported for tests and for the X-GraphQL-Cost diagnostics. */
export function measureOperation(context: ValidationContext, selectionSet: SelectionSetNode, rootType: GraphQLNamedType | null, opts: LimitOptions) {
    return measure(context, selectionSet, rootType, opts, { visiting: new Set(), memo: new Map() });
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
                const { depth, cost } = measureOperation(context, node.selectionSet, root || null, opts);
                if (depth > opts.maxDepth) {
                    context.reportError(new GraphQLError(
                        `Query depth ${depth} exceeds the maximum allowed depth of ${opts.maxDepth}.`,
                        { nodes: [node], extensions: { code: 'GRAPHQL_DEPTH_LIMIT', depth, maxDepth: opts.maxDepth } },
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

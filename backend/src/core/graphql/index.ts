/**
 * WordJS - GraphQL API (phase 1: read-only), assembled.
 *
 *  · schema    — core/graphql/schema (every data field is a REST read through core/graphql/dispatch)
 *  · seam      — core/graphql/extensions (registerGraphQLExtension + the wordjs_graphql_register_types hook)
 *  · limits    — core/graphql/limits (depth + cost), parser token cap, max page size, introspection switch
 *
 * The schema is built lazily and cached; it is rebuilt when the extension registry or the hook's
 * callbacks change, so activating/deactivating host code that extends it takes effect on the next query.
 */

import { NoSchemaIntrospectionCustomRule, parse as graphqlParse } from 'graphql';
import type { GraphQLSchema, ValidationRule } from 'graphql';
import { buildCoreSchema } from './schema';
import { applyExtensions, hookFingerprint, registryVersion } from './extensions';
import { createLimitRule } from './limits';
import type { LimitOptions } from './limits';

export { registerGraphQLExtension, unregisterGraphQLExtensions, REGISTER_HOOK } from './extensions';
export type { GraphQLExtension, GraphQLResolverSpec } from './extensions';
export { createRestClient, restGet } from './dispatch';
export type { GraphQLContext } from './schema';

/** REST clamps every list at 100 per page; a GraphQL page can never be larger than the read behind it. */
export const MAX_PAGE_SIZE = 100;

// One built schema per site: a plugin's declarative extension (core/graphql/plugin-bridge) belongs to the
// site its worker serves. A single site has the one entry it always had.
const cached = new Map<number, { schema: GraphQLSchema; version: number; fingerprint: readonly unknown[] }>();

function sameFingerprint(a: readonly unknown[], b: readonly unknown[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function getSchema(): GraphQLSchema {
    const version = registryVersion();
    const fingerprint = hookFingerprint();
    let site = 1;
    try {
        const siteContext = require('../site-context');
        site = siteContext.currentSiteIdOrNull() ?? siteContext.PRIMARY_SITE_ID;
    } catch { /* single site */ }
    let entry = cached.get(site);
    if (!entry || entry.version !== version || !sameFingerprint(entry.fingerprint, fingerprint)) {
        entry = { schema: applyExtensions(buildCoreSchema(), site), version, fingerprint };
        cached.set(site, entry);
    }
    return entry.schema;
}

export function limitOptions(): LimitOptions & { maxTokens: number } {
    const config = require('../../config/app');
    const g = (config.api && config.api.graphql) || {};
    return {
        maxDepth: g.maxDepth || 10,
        maxCost: g.maxCost || 1000,
        maxTokens: g.maxTokens || 5000,
        maxPageSize: MAX_PAGE_SIZE,
    };
}

/**
 * Is introspection on? The `graphql_introspection` setting decides when it is set ('1'/'0'); unset, it is
 * on in development and OFF in production (config.nodeEnv, which itself fails safe to 'production').
 */
export async function introspectionEnabled(): Promise<boolean> {
    let stored: any;
    try { stored = await require('../options').getOption('graphql_introspection', null); } catch { stored = null; }
    if (stored !== null && stored !== undefined && stored !== '') {
        return stored === true || stored === 1 || stored === '1' || stored === 'true';
    }
    return require('../../config/app').nodeEnv !== 'production';
}

/** The validation rules added on top of graphql-js's specified rules for one request. */
export async function extraValidationRules(): Promise<ValidationRule[]> {
    const rules: ValidationRule[] = [createLimitRule(limitOptions())];
    if (!(await introspectionEnabled())) rules.push(NoSchemaIntrospectionCustomRule);
    return rules;
}

/** graphql-js parse with the token cap (a cheap guard against huge documents before validation runs). */
export function parseWithLimits(source: any, options?: any) {
    return graphqlParse(source, { ...(options || {}), maxTokens: limitOptions().maxTokens });
}

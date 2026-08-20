/** CI gate for ADR-0002 and the published F1 content contract. */

import fs from 'fs';
import path from 'path';

const {
    normalizeContentTypeSchema,
    adaptLegacyPostType,
    contentSchemaToPostType,
} = require('../src/core/content-schema');
const { getBuiltinContentSchemas } = require('../src/core/content-schemas-builtins');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const JSON_SCHEMA_PATH = path.join(BACKEND_ROOT, 'content-schema.v1.json');
const ADR_PATH = path.join(REPO_ROOT, 'documentation', 'adr', '0002-f1-declarative-content-schema.md');
const EXPECTED_BUILTINS = ['attachment', 'nav_menu_item', 'page', 'post', 'revision'];
const REQUIRED_SECTIONS = [
    'schemaVersion', 'name', 'labels', 'description', 'visibility', 'features',
    'fields', 'relationships', 'storage', 'permissions', 'revisions',
    'presentation', 'extensions',
];

function verify(): { ok: boolean; differences: string[] } {
    const differences: string[] = [];
    if (!fs.existsSync(JSON_SCHEMA_PATH)) differences.push('missing backend/content-schema.v1.json');
    if (!fs.existsSync(ADR_PATH)) differences.push('missing ADR-0002');
    if (differences.length) return { ok: false, differences };

    const published = JSON.parse(fs.readFileSync(JSON_SCHEMA_PATH, 'utf8'));
    if (published.$schema !== 'https://json-schema.org/draft/2020-12/schema') differences.push('published schema is not draft 2020-12');
    if (published.properties?.schemaVersion?.const !== 1) differences.push('published schemaVersion is not const 1');
    const required = [...(published.required || [])].sort();
    if (JSON.stringify(required) !== JSON.stringify([...REQUIRED_SECTIONS].sort())) {
        differences.push('published required sections drifted from the runtime contract');
    }

    const builtins = getBuiltinContentSchemas();
    const names = builtins.map((schema: { name: string }) => schema.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_BUILTINS)) {
        differences.push(`built-in schemas: expected ${EXPECTED_BUILTINS.join(', ')}, got ${names.join(', ')}`);
    }
    for (const schema of builtins) {
        try {
            const normalized = normalizeContentTypeSchema(schema);
            const roundTrip = normalizeContentTypeSchema(JSON.parse(JSON.stringify(normalized)));
            if (roundTrip.name !== schema.name) differences.push(`${schema.name}: JSON round-trip changed identity`);
            if (roundTrip.storage.discriminator.value !== schema.name) differences.push(`${schema.name}: storage discriminator drift`);
            if (roundTrip.permissions.capabilityType.length === 0) differences.push(`${schema.name}: empty capability family`);
            for (const field of roundTrip.revisions.fields) {
                if (!Object.prototype.hasOwnProperty.call(roundTrip.fields, field)) {
                    differences.push(`${schema.name}: revision references undeclared field ${field}`);
                }
            }
        } catch (error: any) {
            differences.push(`${schema.name}: ${error && error.message ? error.message : error}`);
        }
    }

    const extension = { provider: 'legacy', version: 1 };
    const callback = () => 'runtime-only';
    const adapted = adaptLegacyPostType('f1_probe', {
        label: 'F1 Probe', supports: ['title', 'editor', 'revisions'],
        capability_type: 'probe', extension, callback,
    });
    const runtime = contentSchemaToPostType(adapted.schema, adapted.runtimeExtensions);
    if (runtime.extension !== extension || runtime.callback !== callback) differences.push('legacy runtime extension compatibility broke');
    if (!adapted.schema.extensions.extension || Object.prototype.hasOwnProperty.call(adapted.schema.extensions, 'callback')) {
        differences.push('legacy adapter did not separate portable and runtime-only extension data');
    }
    try {
        normalizeContentTypeSchema({ ...adapted.schema, extensions: { callback } });
        differences.push('runtime validator accepted an executable extension');
    } catch { /* expected */ }

    const adr = fs.readFileSync(ADR_PATH, 'utf8');
    for (let i = 1; i <= 10; i++) {
        const id = `F1-INV-${String(i).padStart(2, '0')}`;
        if (!new RegExp(`^### ${id}\\b`, 'm').test(adr)) differences.push(`ADR-0002 missing ${id}`);
    }
    return { ok: differences.length === 0, differences };
}

if (require.main === module) {
    const result = verify();
    if (!result.ok) {
        console.error('F1 content-schema gate failed:');
        result.differences.forEach((difference) => console.error(`  - ${difference}`));
        process.exitCode = 1;
    } else {
        console.log('F1 content schema verified: published contract, built-ins, portability, legacy adapter and ADR invariants match.');
    }
}

module.exports = { verify };

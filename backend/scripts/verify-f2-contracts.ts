/** CI gate for F2: one schema language, generated artifacts and live integrations cannot drift. */

const fs = require('fs');
const path = require('path');
const { getBuiltinContentSchemas } = require('../src/core/content-schemas-builtins');
const { compileContentContract, buildContentOpenApiComponents } = require('../src/core/content-contract');

const ROOT = path.resolve(__dirname, '..', '..');

function read(relative: string): string {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function check(condition: unknown, message: string): void {
    if (!condition) throw new Error(`F2 verification failed: ${message}`);
}

const schemas = getBuiltinContentSchemas().sort((a: any, b: any) => a.name.localeCompare(b.name));
check(schemas.length === 5, 'expected exactly five built-in F1 schemas');

for (const schema of schemas) {
    const contract = compileContentContract(schema);
    check(contract.schema.name === schema.name, `${schema.name}: compiled contract changed the discriminator`);
    check(contract.policy.create === schema.permissions.operations.create, `${schema.name}: create policy drift`);
    check(contract.policy.edit === schema.permissions.operations.edit, `${schema.name}: edit policy drift`);
    check(contract.policy.del === schema.permissions.operations.delete, `${schema.name}: delete policy drift`);
    check(contract.policy.publish === schema.permissions.operations.publish, `${schema.name}: publish policy drift`);
    check(contract.policy.publiclyReadable === schema.visibility.public, `${schema.name}: public-read policy drift`);
    check(contract.createOpenApi && contract.updateOpenApi, `${schema.name}: missing OpenAPI projections`);
}

const components = buildContentOpenApiComponents(schemas) as Record<string, any>;
check(Array.isArray(components.ContentCreateInput?.oneOf), 'generic create DTO is not a oneOf');
check(Array.isArray(components.ContentUpdateInput?.anyOf), 'generic partial-update DTO is not an anyOf');
check(components.ContentCreateInput.oneOf.length === 3, 'only the three REST-exposed built-ins belong in create DTOs');
check(components.ContentUpdateInput.anyOf.length === 3, 'only the three REST-exposed built-ins belong in update DTOs');
check(components.ContentPostCreateInput?.properties?.status?.enum?.includes('future'), 'scheduled status missing from generated OpenAPI');

const backendDto = read('backend/src/generated/content-dtos.generated.ts');
const frontendClient = read('frontend/src/lib/generated/content-client.generated.ts');
const postsRoute = read('backend/src/routes/posts.ts');
const capabilities = read('backend/src/core/post-capabilities.ts');
const swagger = read('backend/src/config/swagger.ts');
const frontendApi = read('frontend/src/lib/api.ts');
const adr = read('documentation/adr/0003-f2-generated-content-contracts.md');

for (const schema of schemas) {
    check(backendDto.includes(`${schema.name}: `), `${schema.name}: absent from backend DTO field map`);
    check(frontendClient.includes(`${schema.name}: `), `${schema.name}: absent from frontend DTO field map`);
}
check(!/\bany\b/.test(backendDto), 'backend generated DTO contains any');
check(!/\bany\b/.test(frontendClient), 'frontend generated client contains any');
check(/interface ContentPostCreateInput/.test(backendDto), 'per-type create DTOs were not generated');
check(/type CoreContentUpdateInput =/.test(frontendClient), 'per-type update DTO union was not generated');
check(!/\breq\s*:\s*any\b/.test(postsRoute), 'content handler still uses req:any');
check(postsRoute.includes('validateCreate') && postsRoute.includes('validateUpdate'), 'runtime validators are not wired into posts routes');
check(postsRoute.includes('canDeletePostRecord'), 'generated delete policy is not wired into posts routes');
check(capabilities.includes('policyFromContentSchema'), 'capability resolver does not consume declared operations');
check(swagger.includes('buildContentOpenApiComponents'), 'Swagger does not consume F1-derived components');
check(frontendApi.includes('createContentClient'), 'frontend API does not instantiate the generated client');
check(!/export interface Post\b/.test(frontendApi), 'manual Post DTO still duplicates generated DTO');

for (let invariant = 1; invariant <= 10; invariant++) {
    check(adr.includes(`F2-INV-${String(invariant).padStart(2, '0')}`), `ADR missing F2 invariant ${invariant}`);
}

console.log(`F2 contract verified: ${schemas.length} schemas, runtime validators, policies, OpenAPI, DTOs and frontend client.`);

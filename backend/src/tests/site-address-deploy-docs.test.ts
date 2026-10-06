/**
 * SITE ADDRESS — what operators read and deploy must describe what the code does.
 *
 * The host-gate redesign changed behaviour every deployment meets on its first request: an undeclared
 * name is 421 (it was 409 plus a /migration page), forwarded headers are believed only from a trusted
 * hop, WORDJS_SITE_URL became a wizard suggestion, and the gateway enforces a policy the backend pushes.
 * Shipping that with the old documentation and deploy templates sends operators into 421s with nothing to
 * read (review finding #14), and a frontend replica pinned with WORDJS_BACKEND_URL into a 421 on every
 * API call with no hint that the backend now needs WORDJS_TRUST_PROXY (#6).
 *
 * So each check here is DERIVED from the code wherever possible — the CLI's own usage text, the gateway's
 * own internal routes, the policy's own environment keys, the writer's own use of rename — so the docs
 * cannot silently fall behind the next change either. The Helm checks are structural: no `helm` binary is
 * assumed in the backend suite (the CI Docker job runs `helm lint` / `helm template` on the chart).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');

/**
 * The text of a markdown section: from its heading line to the next heading of the same or higher level.
 * Lines inside fenced code blocks are not headings (a shell comment `# replica A` is not a section).
 */
function section(doc: string, headingStart: string): string {
    const lines = doc.split('\n');
    const at = lines.findIndex((l) => l.startsWith(headingStart));
    assert.ok(at !== -1, `heading not found: ${headingStart}`);
    const level = (/^#+/.exec(lines[at]) || [''])[0].length;
    let fenced = false;
    let end = -1;
    for (let i = at + 1; i < lines.length; i++) {
        if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
        if (!fenced && /^#+ /.test(lines[i]) && (/^#+/.exec(lines[i]) || [''])[0].length <= level) {
            end = i;
            break;
        }
    }
    return lines.slice(at, end === -1 ? undefined : end).join('\n');
}

describe('documentation/site-address.md — the operator guide matches the code', () => {
    const doc = read('documentation/site-address.md');

    test('every command and option of `npm run site` is documented', () => {
        const { USAGE } = require('../../scripts/site-address.js');
        const commands = [...USAGE.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m: RegExpMatchArray) => m[1]);
        const options = [...new Set([...USAGE.matchAll(/--[a-z][a-z-]*/g)].map((m: RegExpMatchArray) => m[0]))];
        // Positive control: the parse found the commands, so an empty loop cannot pass vacuously.
        assert.ok(commands.includes('canonical') && commands.includes('add') && commands.length >= 6, `parsed commands: ${commands}`);
        assert.ok(options.includes('--expires') && options.includes('--dir'), `parsed options: ${options}`);
        for (const command of commands) {
            assert.match(doc, new RegExp(`npm run site -- ${command}\\b`), `site-address.md does not show \`npm run site -- ${command}\``);
        }
        for (const option of options) {
            assert.ok(doc.includes(option), `site-address.md does not mention ${option}`);
        }
    });

    test('every environment variable the host policy reads is documented', () => {
        const { PUSH_ENV_KEYS } = require('../../../gateway/src/host-edge.js');
        assert.ok(PUSH_ENV_KEYS.length >= 4, 'positive control: the gateway push names the policy env keys');
        for (const name of [...PUSH_ENV_KEYS, 'WORDJS_SITE_URL']) {
            assert.ok(doc.includes(`\`${name}\``), `site-address.md does not document ${name}`);
        }
    });

    test('the refusal codes the gate answers are documented, in the guide and in api.md', () => {
        const api = read('documentation/api.md');
        const gateCodes = [...read('backend/src/core/host-policy.js').matchAll(/code: '(rest_[a-z_]+)'/g)].map((m: RegExpMatchArray) => m[1]);
        assert.deepStrictEqual(gateCodes.sort(), ['rest_host_not_allowed', 'rest_invalid_host'], 'positive control: the gate codes parsed');
        for (const code of [...gateCodes, 'rest_insecure_transport']) {
            assert.ok(doc.includes(code), `site-address.md does not explain ${code}`);
            assert.ok(api.includes(code), `api.md does not list ${code}`);
        }
        const writerCodes = [...new Set([...read('backend/src/core/site-address.ts').matchAll(/'(rest_[a-z_]+)'/g)].map((m: RegExpMatchArray) => m[1]))];
        assert.ok(writerCodes.includes('rest_site_address_stale'), 'positive control: the writer codes parsed');
        for (const code of writerCodes) assert.ok(api.includes(code), `api.md does not document ${code} (core/site-address.ts throws it)`);
    });
});

describe('the retired migration guard is not described as current behaviour', () => {
    // Operator-facing text. documentation/adr/ is the decision record and keeps its history.
    const OPERATOR_DOCS = [
        ...fs.readdirSync(path.join(REPO, 'documentation')).filter((f: string) => f.endsWith('.md')).map((f: string) => `documentation/${f}`),
        'docker/README.md',
        'deploy/compose/README.md',
        'deploy/helm/wordjs/README.md',
        'deploy/helm/wordjs/values.yaml',
        'deploy/helm/wordjs/templates/NOTES.txt',
    ];
    // A 409 tied to the host check, or the guard by name. A SENTENCE that says it is history is fine
    // (judged per sentence: a paragraph-long markdown line must not be excused by an unrelated "never").
    const STALE = /migration_required|(?:migration|site-url) guard|\b409\b[^.\n|]*\b(?:migration|mismatch|siteUrl|host)\b|\b(?:mismatch|siteUrl)\b[^.\n|]*\b409\b/i;
    const HISTORY = /\b(?:old|was|were|used to|before|gone|original|retired|removed|no longer|never)\b/i;
    const sentences = (line: string) => line.split(/(?<=[.!?:;])\s+(?=[A-Z*`(_[])/);

    test('no operator document presents the 409 host check as current', () => {
        assert.ok(OPERATOR_DOCS.length > 20, 'positive control: the documentation folder was listed');
        assert.deepStrictEqual(sentences('It was 409. Now it is 421 for any host.'), ['It was 409.', 'Now it is 421 for any host.'], 'positive control: sentence split');
        const offenders: string[] = [];
        for (const rel of OPERATOR_DOCS) {
            read(rel).split('\n').forEach((line, i) => {
                for (const sentence of sentences(line)) {
                    if (STALE.test(sentence) && !HISTORY.test(sentence)) offenders.push(`${rel}:${i + 1}: ${sentence.trim().slice(0, 160)}`);
                }
            });
        }
        assert.deepStrictEqual(offenders, [], 'these lines describe the retired guard (409 / migration_required) as current; the answer is 421 now (documentation/site-address.md)');
    });

    test('WORDJS_SITE_URL is not described as read by the entrypoint alone (the wizard suggests it)', () => {
        assert.match(read('backend/src/routes/setup.ts'), /process\.env\.WORDJS_SITE_URL/, 'positive control: the backend reads the variable');
        for (const rel of ['docker/README.md', 'deploy/compose/README.md', 'documentation/deployment.md', 'deploy/helm/wordjs/values.yaml', 'deploy/helm/wordjs/templates/NOTES.txt']) {
            assert.doesNotMatch(read(rel), /only reader|nothing reads it|just decorates/i, `${rel} still says only the entrypoint reads WORDJS_SITE_URL`);
        }
    });
});

describe('deployment notes the redesign needs', () => {
    test('multi-node: a pinned frontend replica needs WORDJS_TRUST_PROXY on the backend, or every call is 421 (#6)', () => {
        const pinning = section(read('documentation/multi-node.md'), '## Pinning a frontend replica');
        assert.match(pinning, /WORDJS_BACKEND_URL/, 'positive control: the section was found');
        assert.match(pinning, /WORDJS_TRUST_PROXY/, 'the WORDJS_BACKEND_URL section must say each backend needs WORDJS_TRUST_PROXY for the replicas');
        assert.match(pinning, /421/, 'the WORDJS_BACKEND_URL section must name the symptom (421) of a missing WORDJS_TRUST_PROXY');
    });

    test('gateway.md documents every endpoint of the internal control plane, /host-policy included', () => {
        const gatewayDoc = read('documentation/gateway.md');
        const index = read('gateway/src/index.js');
        const edge = read('gateway/src/host-edge.js');
        const routes = [
            ...[...index.matchAll(/internalApp\.(get|post|put|delete)\('([^']+)'/g)].map((m: RegExpMatchArray) => `${m[1].toUpperCase()} ${m[2]}`),
            ...[...edge.matchAll(/\bapp\.(get|post|put|delete)\('([^']+)'/g)].map((m: RegExpMatchArray) => `${m[1].toUpperCase()} ${m[2]}`),
        ];
        assert.ok(routes.includes('POST /register') && routes.includes('POST /host-policy'), `positive control: routes parsed: ${routes}`);
        for (const route of routes) assert.ok(gatewayDoc.includes(route), `gateway.md does not document ${route}`);
        assert.match(gatewayDoc, /gateway-host-policy\.json/, 'gateway.md must name the file the pushed policy is stored in');
    });

    test('docker: no document claims config writes avoid an atomic rename while configManager renames', () => {
        assert.match(read('backend/src/core/configManager.ts'), /renameSync/, 'positive control: the config writer is atomic (temp file + rename)');
        for (const rel of ['docker/entrypoint.sh', 'docker/README.md']) {
            assert.doesNotMatch(read(rel), /no atomic rename/i, `${rel} still says every config writer uses a plain writeFileSync`);
        }
    });

    test('CHANGELOG [Unreleased] carries the site-address change and its upgrade notes', () => {
        const changelog = read('CHANGELOG.md');
        const start = changelog.indexOf('## [Unreleased]');
        const end = changelog.indexOf('\n## [', start + 1);
        assert.ok(start !== -1 && end !== -1, 'positive control: the [Unreleased] section was found');
        const unreleased = changelog.slice(start, end);
        for (const needle of ['421', 'npm run site', 'WORDJS_TRUST_PROXY', 'WORDJS_ALLOWED_HOSTS', 'documentation/site-address.md']) {
            assert.ok(unreleased.includes(needle), `CHANGELOG [Unreleased] does not mention ${needle}`);
        }
    });
});

describe('Helm chart — every host the release routes is one the app answers', () => {
    const CHART = 'deploy/helm/wordjs';
    const helpers = read(`${CHART}/templates/_helpers.tpl`);
    const deployment = read(`${CHART}/templates/deployment.yaml`);
    const ingress = read(`${CHART}/templates/ingress.yaml`);

    /** The body of a `define` block in _helpers.tpl. */
    function defineBody(name: string): string {
        const start = helpers.indexOf(`{{- define "${name}" -}}`);
        assert.ok(start !== -1, `_helpers.tpl does not define ${name}`);
        const end = helpers.indexOf('{{- end }}', start);
        return helpers.slice(start, end);
    }

    /** Every key path in values.yaml, from its indentation (comments and list items skipped). */
    function valuesPaths(): Set<string> {
        const paths = new Set<string>();
        const stack: Array<{ indent: number; key: string }> = [];
        for (const line of read(`${CHART}/values.yaml`).split('\n')) {
            const m = /^(\s*)([A-Za-z_][\w-]*):/.exec(line);
            if (!m) continue;
            const indent = m[1].length;
            while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
            stack.push({ indent, key: m[2] });
            paths.add(stack.map((s) => s.key).join('.'));
        }
        return paths;
    }

    test('the Deployment exports WORDJS_ALLOWED_HOSTS from the wordjs.allowedHosts helper', () => {
        assert.match(deployment, /- name: WORDJS_SITE_URL/, 'positive control: the env block was found');
        assert.match(deployment, /\{\{-? with \(include "wordjs\.allowedHosts" \.\) \}\}\s*\n\s*- name: WORDJS_ALLOWED_HOSTS\s*\n\s*value: \{\{ \. \| quote \}\}/,
            'deployment.yaml must export WORDJS_ALLOWED_HOSTS = include "wordjs.allowedHosts"');
        assert.match(deployment, /\{\{-? with \.Values\.trustProxy \}\}\s*\n\s*- name: WORDJS_TRUST_PROXY/, 'deployment.yaml must export trustProxy as WORDJS_TRUST_PROXY');
    });

    test('every host source the Ingress routes feeds WORDJS_ALLOWED_HOSTS (no 421 on a routed host)', () => {
        const rules = ingress.slice(ingress.indexOf('rules:'));
        const routed = [...new Set([...rules.matchAll(/\.Values\.ingress\.(host|extraHosts)\b/g)].map((m: RegExpMatchArray) => m[1]))];
        assert.deepStrictEqual(routed.sort(), ['extraHosts', 'host'], 'the Ingress routes ingress.host and ingress.extraHosts');
        const body = defineBody('wordjs.allowedHosts');
        for (const source of routed) {
            assert.match(body, new RegExp(`\\.Values\\.ingress\\.${source}\\b`), `wordjs.allowedHosts does not export ingress.${source}`);
        }
        assert.match(body, /include "wordjs\.siteUrl"/, 'wordjs.allowedHosts must export the release siteUrl');
        assert.match(body, /\.Values\.allowedHosts\b/, 'wordjs.allowedHosts must export allowedHosts');
        // An https ingress host is exported with its scheme (R12): it is what lets it sign in behind TLS.
        assert.match(body, /\$scheme = "https"/, 'wordjs.allowedHosts must mark TLS-covered hosts https');
        assert.match(body, /join "," /, 'WORDJS_ALLOWED_HOSTS is comma-separated');
    });

    test('every .Values path the templates read is declared in values.yaml', () => {
        const declared = valuesPaths();
        assert.ok(declared.has('ingress.host') && declared.has('persistence.data.size'), 'positive control: values.yaml parsed');
        const templatesDir = path.join(REPO, ...CHART.split('/'), 'templates');
        const missing: string[] = [];
        for (const file of fs.readdirSync(templatesDir)) {
            const text = read(`${CHART}/templates/${file}`);
            for (const m of text.matchAll(/\.Values((?:\.[A-Za-z_][\w]*)+)/g)) {
                const p = (m as RegExpMatchArray)[1].slice(1);
                if (!declared.has(p)) missing.push(`${file}: .Values.${p}`);
            }
        }
        assert.deepStrictEqual([...new Set(missing)], [], 'templates read values that values.yaml does not declare');
    });

    test('NOTES.txt tells the operator to pick the public address in the wizard, not to install through it', () => {
        const notes = read(`${CHART}/templates/NOTES.txt`);
        assert.match(notes, /Site address/, 'NOTES.txt must point at the wizard\'s Site address field');
        assert.match(notes, /WORDJS_ALLOWED_HOSTS/, 'NOTES.txt must say the routed hosts are exported');
        assert.doesNotMatch(notes, /RUN THE WIZARD THERE/, 'readiness gates the Service until install: the wizard is only reachable through the port-forward');
    });
});

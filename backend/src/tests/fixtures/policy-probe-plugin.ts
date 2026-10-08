/**
 * A probe plugin for the plugin-policy tests: an isolated plugin that reports, from INSIDE its child
 * process, what its sandbox actually lets it do — so the tests assert the policy a child was spawned with
 * by its behaviour, not by reading the host's maps.
 *
 * The probe filter `wjs_policy_probe_<slug>` returns JSON:
 *   spawn    — a token drawn when the child loaded the plugin (a different token ⇒ the child was respawned;
 *              process.pid itself is a forbidden read for plugin code)
 *   network  — the child received the network grant (its guarded dns is usable)
 *   a / b    — whether the child's egress guard lets it resolve PROBE_HOST_A / PROBE_HOST_B:
 *              'allowed' | 'blocked' | 'no-network'. Both are IP literals, so an allowed lookup answers
 *              without any DNS traffic (deterministic offline); the allowlist decides, nothing else.
 */
const fs = require('fs');
const path = require('path');

const PROBE_HOST_A = '192.0.2.10';
const PROBE_HOST_B = '192.0.2.20';

function probeFilterName(slug: string): string {
    return `wjs_policy_probe_${String(slug).replace(/[^a-z0-9]/gi, '_')}`;
}

function probeSource(slug: string): string {
    return [
        "'use strict';",
        'const SPAWN = Math.random().toString(36).slice(2) + Date.now().toString(36);',
        'exports.init = function (wordjs) {',
        `  wordjs.hooks.addFilter(${JSON.stringify(probeFilterName(slug))}, async function () {`,
        "    const out = { spawn: SPAWN, network: false, a: 'no-network', b: 'no-network' };",
        '    let dnsp = null;',
        "    try { const d = require('dns'); dnsp = d && d.promises; out.network = !!(dnsp && typeof dnsp.lookup === 'function'); } catch (e) { out.network = false; }",
        '    if (out.network) {',
        "      const look = async (ip) => { try { await dnsp.lookup(ip); return 'allowed'; } catch (e) { return /blocked/i.test(String(e && e.message)) ? 'blocked' : 'error:' + String(e && e.message); } };",
        `      out.a = await look(${JSON.stringify(PROBE_HOST_A)});`,
        `      out.b = await look(${JSON.stringify(PROBE_HOST_B)});`,
        '    }',
        '    return JSON.stringify(out);',
        '  });',
        '};',
        '',
    ].join('\n');
}

/** Write the probe plugin into `dir` (manifest declares network). Returns the entry file. */
function writeProbePlugin(dir: string, slug: string): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: slug, version: '1.0.0', isolated: true, permissions: [{ scope: 'network' }],
    }));
    const entry = path.join(dir, 'index.js');
    fs.writeFileSync(entry, probeSource(slug));
    return entry;
}

module.exports = { writeProbePlugin, probeFilterName, PROBE_HOST_A, PROBE_HOST_B };

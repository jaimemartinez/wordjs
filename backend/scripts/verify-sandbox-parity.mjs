#!/usr/bin/env node
/**
 * Certify WordJS's real native sandbox on the current operating system.
 *
 * This intentionally imports the compiled production modules. A duplicate probe can prove an OS
 * primitive while the product launches something else; exercising dist/core closes that drift hole.
 * Run `npm run build` in backend/ before this script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distCore = path.join(repoRoot, 'backend', 'dist', 'core');
const require = createRequire(import.meta.url);
const jsonArg = process.argv.find((arg) => arg.startsWith('--json='));
const reportPath = jsonArg ? path.resolve(jsonArg.slice('--json='.length)) : null;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function load(name) {
    const target = path.join(distCore, `${name}.js`);
    assert(fs.existsSync(target), `compiled sandbox module missing: ${target}; run npm run build in backend/`);
    return require(target);
}

function pureContractTest() {
    const isolate = load('plugin-isolate');
    assert(isolate.platformKernelMechanism('linux') === 'landlock', 'Linux must select Landlock');
    assert(isolate.platformKernelMechanism('win32') === 'appcontainer', 'Windows must select AppContainer');
    assert(isolate.platformKernelMechanism('darwin') === 'seatbelt', 'macOS must select Seatbelt');
    assert(isolate.platformKernelMechanism('freebsd') === 'none', 'unknown platforms must not claim confinement');

    const denied = isolate.__linuxFloorDecision({ platform: 'linux', zeroConf: 'active', netGranted: false });
    const granted = isolate.__linuxFloorDecision({ platform: 'linux', zeroConf: 'active', netGranted: true });
    const degraded = isolate.__linuxFloorDecision({ platform: 'linux', zeroConf: 'degraded', netGranted: false });
    assert(denied.layer === 'landlock' && denied.denyNetwork === true,
        'Linux without the network grant must keep Landlock and deny IP sockets');
    assert(granted.layer === 'landlock' && granted.denyNetwork === false,
        'Linux with the network grant must keep Landlock and change only the socket rule');
    assert(degraded.layer === 'none', 'a failed native probe must never be reported as active');

    const shim = fs.readFileSync(path.join(repoRoot, 'backend', 'scripts', 'landlock-seccomp-shim.pl'), 'utf8');
    assert(/0x00010000[^\n]*CLONE_THREAD/.test(shim) && /process clone -> EPERM/.test(shim),
        'Linux must permit thread clones but deny process-shaped clone/fork');
    assert(/0x00050026[^\n]*ENOSYS/.test(shim),
        'Linux clone3 must fall back to inspectable clone flags');
    assert(/Anonymous executable creation \/ alternate exec/.test(shim)
        && /\b319, 322\b/.test(shim) && /\b279, 281\b/.test(shim),
    'Linux must deny memfd_create/execveat on both supported architectures');

    for (const platform of ['win32', 'darwin']) {
        for (const netGranted of [false, true]) {
            const decision = isolate.__platformLaunchDecision({
                platform, state: 'active', netGranted, tsNode: false,
            });
            assert(decision.use === true,
                `${platform} must keep its native sandbox when network=${netGranted ? 'granted' : 'denied'}`);
        }
    }

    const paths = load('sandbox-paths');
    const alpha = paths.sandboxPaths(path.join(repoRoot, 'backend'), 'alpha', distCore);
    const beta = paths.sandboxPaths(path.join(repoRoot, 'backend'), 'beta', distCore);
    assert(!alpha.readOnly.includes(path.join(repoRoot, 'backend')), 'the install root must never be a read grant');
    assert(alpha.storage.every((entry) => !beta.storage.includes(entry)), 'plugin-private storage must be disjoint');
    assert(!alpha.writable.some((entry) => ['data', 'logs', 'os-tmp', 'uploads', 'themes']
        .map((name) => path.join(repoRoot, 'backend', name)).includes(entry)),
    'shared mutable roots must never be writable');

    const windows = load('sandbox-windows');
    assert(windows.appContainerProfileNameForPlugin(repoRoot, 'alpha')
        !== windows.appContainerProfileNameForPlugin(repoRoot, 'beta'),
    'AppContainer identity must be unique per plugin');

    const mac = load('sandbox-macos');
    const macRoot = '/srv/wordjs/backend';
    const macProfile = mac.buildSeatbeltProfile({
        appRoot: macRoot,
        readOnlyDirs: [`${macRoot}/dist/core`, `${macRoot}/node_modules`, `${macRoot}/plugins/alpha`],
        writableDirs: [`${macRoot}/plugins/alpha`, `${macRoot}/data/plugins/alpha-private`],
        nodePath: '/opt/wordjs/runtime/node',
        runtimeRoots: ['/opt/wordjs/runtime'],
        denyNetwork: true,
    });
    assert(!macProfile.includes(`(allow file-read* (subpath "${macRoot}"))`),
        'Seatbelt must not read the whole install root');
    assert(mac.auditProfile(macProfile).length === 0, 'Seatbelt profile audit rejected the production authority shape');
    assert(!/^\(allow sysctl-read\)$/m.test(macProfile), 'Seatbelt must not grant blanket sysctl reads');

    console.log('OK: sandbox decisions, filesystem authority and Linux process/W^X contracts are fail-honest, per-plugin and grant-invariant');
}

async function certifyCurrentPlatform() {
    const platformSpec = {
        linux: { module: 'sandbox-linux', probe: 'probeLinuxZeroConf', mechanism: 'landlock' },
        win32: { module: 'sandbox-windows', probe: 'probeAppContainer', mechanism: 'appcontainer' },
        darwin: { module: 'sandbox-macos', probe: 'probeSeatbelt', mechanism: 'seatbelt' },
    }[process.platform];
    if (!platformSpec) {
        console.error(`Unsupported parity platform: ${process.platform}`);
        process.exitCode = 2;
        return;
    }

    const native = load(platformSpec.module);
    const state = await native[platformSpec.probe]();
    assert(state === 'active', `${platformSpec.mechanism} probe returned '${state}', expected 'active'`);

    const isolate = load('plugin-isolate');
    const integratedState = await isolate.probePlatformConfinement();
    const integrated = isolate.getSandboxPlatformConfinement();
    assert(integratedState === 'active', `integrated sandbox state is '${integratedState}'`);
    assert(integrated.mechanism === platformSpec.mechanism,
        `integrated mechanism is '${integrated.mechanism}', expected '${platformSpec.mechanism}'`);
    assert(integrated.network?.state === 'active', 'both network-policy launch shapes were not certified');
    assert(String(integrated.appliesTo).includes('every isolated plugin'),
        'the report does not guarantee that the native sandbox wraps every isolated plugin');

    const report = {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        state: integratedState,
        confinement: integrated,
        certifiedAt: new Date().toISOString(),
    };
    if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`OK: ${platformSpec.mechanism} certified for filesystem/process confinement and both network policies`);
    console.log(JSON.stringify(report, null, 2));
}

try {
    pureContractTest();
    if (!process.argv.includes('--self-test')) await certifyCurrentPlatform();
} catch (error) {
    console.error(`FAIL: ${error?.stack || error}`);
    process.exitCode = 1;
} finally {
    // Native probe relays deliberately own IPC/Job handles for their children's lifetime. A CI verifier
    // has no server loop to return to, so terminate after synchronous report/file output has flushed.
    setTimeout(() => process.exit(process.exitCode || 0), 100);
}

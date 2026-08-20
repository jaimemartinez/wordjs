/**
 * WordJS - Windows kernel confinement for isolated plugin children (AppContainer, no native deps)
 *
 * This is the Windows implementation of WordJS's common native-sandbox contract. It applies below the
 * Node permission model and JavaScript guards, so bypassing those layers still meets a kernel token,
 * filesystem DACL boundary and Job Object limits.
 *
 * Every child is launched into an AppContainer. A child without the network grant has ZERO capabilities;
 * a network-granted child receives only the well-known `internetClient` capability. Package-SID
 * filesystem confinement, child-process denial and Job limits are identical in both shapes:
 *
 *   · NETWORK — a lowbox token with no network capability cannot open a socket at all. MEASURED on
 *     Windows 11 26200: `require('net').connect(80, '1.1.1.1')` fails with EACCES inside the container
 *     and connects outside it. That is a KERNEL refusal below JavaScript.
 *   · FILESYSTEM — an AppContainer can only reach objects whose DACL names its own package SID. Everything
 *     the operator did not explicitly grant is refused: MEASURED, `fs.readdirSync('C:\\Users\\<user>')`
 *     fails with EPERM, while a write inside a directory granted to the SID succeeds. So core `src/`,
 *     `node_modules`, sibling plugins and the operator's home are out of reach at the kernel level, the
 *     same scoped-filesystem property Landlock provides on Linux.
 *
 * PROBE-GATED, LIKE EVERY OTHER LAYER IN THIS SANDBOX. Nothing here is inferred from `process.platform`
 * or from an API call returning success. probeAppContainer() spawns a REAL child through the REAL launch
 * path and reports 'active' only when that child was ACTUALLY refused BOTH things it must be refused —
 * a socket to a raw IP AND a read outside the granted zones — and only when the host could still TALK to
 * it. Anything less degrades to a lower floor. Reporting confinement that is not there is the
 * "looks secure but isn't" state, which is worse than reporting none; see the twin note on
 * sandboxHardeningState in plugin-isolate.ts.
 *
 * ZERO-CONFIGURATION AND DEFAULT-ON. The per-install AppContainer profile and its required DACL entries
 * are created automatically under the service account. `config.sandbox.useAppContainer=false` is the
 * explicit opt-out; with the default fail-closed policy that opt-out also requires
 * `sandbox.requireHardening=false` before an isolated plugin may run.
 *
 * MEASURED LAUNCH FACTS — each of these cost a real experiment on a real Windows 11 host, and each one
 * silently breaks the launch if you get it wrong:
 *
 *   1. `--preserve-symlinks-main` AND `--preserve-symlinks` are BOTH required. Node resolves a module's
 *      realpath, and realpath lstats every ancestor up to the drive root — which an AppContainer granted
 *      only its own zones cannot do. Without any flag the child dies before user code with
 *      `Error: EPERM: operation not permitted, lstat 'C:\'` while resolving the MAIN module. With only
 *      `--preserve-symlinks-main` the main module loads and then the first `require('./dep')` dies the
 *      same way. Both flags together load main and dependencies cleanly (measured: exit 0, dep loaded).
 *      The alternative — granting the SID traverse rights on `C:\`, `C:\Users`, … — also works and is
 *      deliberately NOT taken: it is a persistent, invasive change to a machine the operator did not ask
 *      us to modify, for a problem two argv flags solve.
 *   2. `LOCALAPPDATA` MUST be present in the child's environment block. Without it CreateProcessW with
 *      PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES fails with 203 ERROR_ENVVAR_NOT_FOUND — the
 *      AppContainer's redirected AppData root is derived from it. This is not documented anywhere useful;
 *      it was bisected out of the environment block one variable at a time (deterministic across repeats,
 *      and the sandbox's own secret-free env allowlist does not contain it, so the launch failed 100% of
 *      the time until it was added). It is a PATH, not a secret.
 *   3. PowerShell 5.1 cannot marshal STARTUPINFOEX / SECURITY_CAPABILITIES / the MSVCRT fd block itself.
 *      The ENTIRE CreateProcess dance therefore lives inside the Add-Type C# and PowerShell calls exactly
 *      ONE method — the same shape the Job Object helper in plugin-isolate.ts already uses. Every input
 *      reaches that method through the launcher's own environment (base64 where it is a list or a
 *      command line), so the generated script text is STATIC and pure ASCII: PS 5.1 reads script text as
 *      ANSI and a single non-ASCII byte breaks the parser. assertAscii() enforces that rather than
 *      trusting it.
 *
 * IPC — THE QUESTION THAT DECIDED THE DESIGN, AND ITS ANSWER. CreateProcess is not fork, so it was an
 * open question whether an AppContainer child could speak the fork-style channel the whole plugin bridge
 * is built on. It can, with NO protocol change at all:
 *
 *     The host spawns the PowerShell relay with Node's ordinary `stdio: [..., 'ipc']`, so NODE creates
 *     the channel and the host keeps a REAL ChildProcess (child.send / child.on('message'),
 *     serialization 'advanced'). Node hands that pipe to the relay as CRT fd 3. The relay reads the
 *     handle straight back out of its OWN STARTUPINFO.lpReserved2 (the MSVCRT inherited-fd block), marks
 *     it inheritable, and republishes it to the AppContainer child at fd 3 with NODE_CHANNEL_FD=3.
 *
 * MEASURED, end to end, on Windows 11 26200 / Node 25.2.1: the child's `process.send` exists and its
 * message arrives on the host's ChildProcess; a message sent DOWN with child.send() arrives in the
 * child; and 'advanced' serialization fidelity survives in both directions (Buffer.isBuffer() true on
 * the host, `instanceof Date` true in the child) — all while that same child was refused the network
 * (EACCES) and the out-of-zone read (EPERM). The alternative candidate — a named pipe ACL'd to the
 * AppContainer SID carrying the plugin-worker protocol — was not needed and is not implemented: it would
 * have required re-implementing libuv's Windows IPC framing on the host side (the wire format is a libuv
 * frame header, not raw JSON lines — confirmed by reading the bytes off a hand-built pipe), which is an
 * internal detail no sane layer should depend on.
 *
 * CONSEQUENCE THE INTEGRATION MUST KNOW: `child.pid` is the RELAY (powershell.exe), not the contained
 * node process — the same shape the cgroup path already has, where child.pid is systemd-run. The
 * contained pid is reported separately (see launchInAppContainer's `containedPid`, written by the relay
 * to a pid file and read back here). Teardown does NOT depend on that pid: the relay puts the child in a
 * Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and holds the only handle, so killing the relay
 * kills the contained child by kernel refcount, giving deterministic parent-death teardown.
 *
 * WHAT THIS DOES NOT DO, stated plainly because a sandbox document that overclaims is a liability:
 *   · It is not a seccomp analogue. There is no syscall denylist here; Windows has no unprivileged
 *     equivalent that needs no native dependency.
 *   · io-guard's realpath-based canonicalisation degrades inside the container: fs.realpathSync EPERMs
 *     for any path whose ancestors lie outside the granted zones (measured). io-guard already treats a
 *     realpath failure as fail-closed (it compares the lexical form and cannot turn a DENY into an
 *     ALLOW), so this loses a defence-in-depth layer against link tricks, it does not open a hole.
 *   · A network-GRANTED plugin remains inside AppContainer. `internetClient` permits public egress while
 *     the connect-time JavaScript guard still blocks loopback, private and metadata destinations.
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { sandboxPaths } = require('./sandbox-paths');

/** Strip line breaks before a value reaches a log line (same reason as plugin-isolate's logSafe). */
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

/** Read the sandbox config block without ever letting a missing/broken config throw into a launch path. */
function sandboxConfig(): any {
    try { return require('../config/app').sandbox || {}; } catch { return {}; }
}

/**
 * Profile-name prefix. Production profiles are derived from install root + plugin slug, so package-SID
 * ACL authority is isolated per plugin rather than accumulated by one installation-wide identity.
 */
const DEFAULT_PROFILE_NAME = 'WordJSPluginSandbox';
function appContainerProfileNameForRoot(root: string): string {
    const canonical = path.resolve(String(root || '.')).toLowerCase();
    const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 20);
    return `${DEFAULT_PROFILE_NAME}.${digest}`;
}
function appContainerProfileNameForPlugin(root: string, slug: string): string {
    const canonical = path.resolve(String(root || '.')).toLowerCase();
    const digest = crypto.createHash('sha256').update(`${canonical}\0${String(slug)}`, 'utf8').digest('hex').slice(0, 32);
    return `${DEFAULT_PROFILE_NAME}.${digest}`;
}
function defaultAppContainerProfileName(): string {
    return appContainerProfileNameForRoot(path.resolve(__dirname, '..', '..'));
}

/**
 * Resident/CPU/pid budgets. RSS_BUDGET_BYTES is deliberately the SAME 768 MB the cgroup MemoryMax, the
 * /proc RSS poll and the existing Job Object cap use in plugin-isolate.ts — these must agree or the
 * layers fight each other. PIDS_MAX mirrors the cgroup TasksMax there for the same reason.
 */
const RSS_BUDGET_BYTES = 768 * 1024 * 1024;
const PIDS_MAX = 512;
// A clean Windows host may make the first Add-Type invocation wait on Defender/JIT compilation for
// longer than 30 seconds. GitHub's Windows Server 2025 runner reproduced that twice while the same
// helper completed on the next invocation. This is setup work, cached for the process/install, so give
// the profile API a realistic cold-start budget without ever treating a timeout as success.
const PROFILE_API_TIMEOUT_MS = 90000;

/** Windows quoting for one argv element (the CommandLineToArgvW rules: backslashes only double before a quote). */
function quoteWinArg(arg: string): string {
    const s = String(arg);
    if (s.length > 0 && !/[\s"]/.test(s)) return s;
    let out = '"';
    let backslashes = 0;
    for (const ch of s) {
        if (ch === '\\') { backslashes++; continue; }
        if (ch === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
        out += '\\'.repeat(backslashes) + ch; backslashes = 0;
    }
    return out + '\\'.repeat(backslashes * 2) + '"';
}
function buildCommandLine(exe: string, args: string[]): string {
    return [quoteWinArg(exe), ...args.map(quoteWinArg)].join(' ');
}

/**
 * PS 5.1 reads script text as ANSI: one non-ASCII byte and the parser fails in a way that surfaces as an
 * unexplained launch failure, not a syntax error you can find. The generated script below is static, so
 * this can only ever fire if someone edits it carelessly — which is exactly when it is worth having.
 */
// Written as a code-point scan rather than a regex: a character class covering tab/CR/LF is a literal
// control character in source, which the lint bans (no-control-regex) for good reasons of its own.
function isAsciiScript(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 9 || c === 10 || c === 13) continue; // tab / LF / CR are the only control chars allowed
        if (c < 0x20 || c > 0x7E) return false;
    }
    return true;
}
function assertAscii(script: string, what: string): void {
    if (!isAsciiScript(script)) throw new Error(`[Sandbox] generated ${what} contains non-ASCII text (PowerShell 5.1 parses script text as ANSI and would fail obscurely).`);
}

// ── 1. The AppContainer profile ──────────────────────────────────────────────────────────────────
//
// CreateAppContainerProfile registers the package under the CURRENT USER and returns its SID; it fails
// with HRESULT 0x800700B7 (ERROR_ALREADY_EXISTS) once it exists, which is why the derive call is not a
// fallback for failure but the NORMAL second path — every run after the first takes it.
// DeriveAppContainerSidFromAppContainerName is a pure function of the name, so it also answers for a
// profile another install created.

function buildProfileScript(name: string, action: 'ensure' | 'derive' | 'delete'): string {
    const script = [
        "$ErrorActionPreference='Stop'",
        "try {",
        "$sig=@'",
        "using System; using System.Runtime.InteropServices;",
        "public static class WJSACProfile {",
        "[DllImport(\"userenv.dll\", CharSet=CharSet.Unicode)] public static extern int CreateAppContainerProfile(string n, string d, string desc, IntPtr caps, uint capCount, out IntPtr sid);",
        "[DllImport(\"userenv.dll\", CharSet=CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string n, out IntPtr sid);",
        "[DllImport(\"userenv.dll\", CharSet=CharSet.Unicode)] public static extern int DeleteAppContainerProfile(string n);",
        "[DllImport(\"advapi32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);",
        "[DllImport(\"kernel32.dll\")] public static extern IntPtr LocalFree(IntPtr p);",
        // FreeSid lives in advapi32, NOT userenv -- naming userenv here makes Add-Type succeed and then
        // throw at CALL time with "Unable to find an entry point named 'FreeSid'", which surfaces as the
        // profile being unavailable on a host where it is perfectly available. Measured, not guessed.
        "[DllImport(\"advapi32.dll\")] public static extern IntPtr FreeSid(IntPtr sid);",
        "public static string Ensure(string n) {",
        "IntPtr sid = IntPtr.Zero;",
        // ZERO capabilities on purpose: caps=NULL, capCount=0. An AppContainer with `internetClient` would
        // have working sockets and this whole layer would buy nothing over the JS egress guard.
        "int hr = CreateAppContainerProfile(n, n, n, IntPtr.Zero, 0, out sid);",
        "if (hr != 0) { int hr2 = DeriveAppContainerSidFromAppContainerName(n, out sid); if (hr2 != 0) return \"FAIL create=\" + hr + \" derive=\" + hr2; }",
        "IntPtr str = IntPtr.Zero;",
        "if (!ConvertSidToStringSidW(sid, out str)) return \"FAIL tostring \" + Marshal.GetLastWin32Error();",
        "string s = Marshal.PtrToStringUni(str); LocalFree(str); FreeSid(sid);", // ConvertSidToStringSid's buffer is LocalFree; the SID itself is FreeSid
        "return \"OK \" + s;",
        "}",
        "public static string Derive(string n) {",
        "IntPtr sid = IntPtr.Zero; int hr = DeriveAppContainerSidFromAppContainerName(n, out sid);",
        "if (hr != 0) return \"FAIL derive=\" + hr; IntPtr str = IntPtr.Zero;",
        "if (!ConvertSidToStringSidW(sid, out str)) return \"FAIL tostring \" + Marshal.GetLastWin32Error();",
        "string s = Marshal.PtrToStringUni(str); LocalFree(str); FreeSid(sid); return \"OK \" + s;",
        "}",
        "public static string Delete(string n) { int hr = DeleteAppContainerProfile(n); return hr == 0 ? \"OK deleted\" : (\"FAIL delete=\" + hr); }",
        "}",
        "'@",
        "Add-Type -TypeDefinition $sig",
        action === 'ensure'
            ? "Write-Output ([WJSACProfile]::Ensure($env:WJS_AC_NAME))"
            : (action === 'derive'
                ? "Write-Output ([WJSACProfile]::Derive($env:WJS_AC_NAME))"
                : "Write-Output ([WJSACProfile]::Delete($env:WJS_AC_NAME))"),
        "} catch { Write-Output ('FAIL ex:' + $_.Exception.Message) }",
    ].join("\n");
    assertAscii(script, 'AppContainer profile script');
    return script;
}

/**
 * Create-or-derive the AppContainer profile and return its SID string (`S-1-15-2-…`), or null.
 *
 * Idempotent by construction (see the note above buildProfileScript). Cached per process because the SID
 * is a pure function of the name and the probe, every launch and the health endpoint all want it.
 */
let profileSidCache: Map<string, Promise<string | null>> | undefined;
function ensureAppContainerProfile(name?: string): Promise<string | null> {
    const profile = String(name || sandboxConfig().appContainerName || defaultAppContainerProfileName());
    if (!profileSidCache) profileSidCache = new Map();
    const hit = profileSidCache.get(profile);
    if (hit) return hit;
    const p = (async (): Promise<string | null> => {
        if (process.platform !== 'win32') return null;
        // The name goes in through the environment, never interpolated into the script text — so a name
        // from config can never become PowerShell source.
        const r = await runPowerShellWithEnv(buildProfileScript(profile, 'ensure'), { WJS_AC_NAME: profile }, PROFILE_API_TIMEOUT_MS);
        const m = /OK (S-1-15-2-[0-9-]+)/.exec(r.out);
        if (!m) { console.warn(`[Sandbox] AppContainer profile '${logSafe(profile)}' unavailable: ${logSafe(r.out.trim().slice(0, 200))}`); return null; }
        return m[1];
    })();
    profileSidCache.set(profile, p);
    return p;
}

/** Delete the AppContainer profile. Exposed so an operator turning the layer off can leave no residue. */
async function deleteAppContainerProfile(name?: string): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    const profile = String(name || sandboxConfig().appContainerName || defaultAppContainerProfileName());
    const r = await runPowerShellWithEnv(buildProfileScript(profile, 'delete'), { WJS_AC_NAME: profile }, PROFILE_API_TIMEOUT_MS);
    if (profileSidCache) profileSidCache.delete(profile);
    return /OK deleted/.test(r.out);
}

/** runPowerShell with extra env vars for the launcher (inputs travel in env, never in script text). */
function runPowerShellWithEnv(script: string, extra: Record<string, string>, timeoutMs: number): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
        let ps: any;
        try {
            const b64 = Buffer.from(script, 'utf16le').toString('base64');
            ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
                { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...launcherEnv(), ...extra } });
        } catch { return resolve({ code: -1, out: '' }); }
        let out = '';
        try { ps.stdout.on('data', (d: any) => { out += String(d); }); } catch { /* */ }
        try { ps.stderr.on('data', (d: any) => { out += String(d); }); } catch { /* */ }
        let done = false;
        const finish = (code: number) => { if (done) return; done = true; resolve({ code, out }); };
        const t = setTimeout(() => {
            try { ps.kill(); } catch { /* */ }
            out += `${out && !out.endsWith('\n') ? '\n' : ''}TIMEOUT after ${timeoutMs} ms`;
            finish(-2);
        }, timeoutMs);
        if (t.unref) t.unref();
        ps.on('error', () => { clearTimeout(t); finish(-1); });
        ps.on('exit', (code: number) => { clearTimeout(t); finish(code == null ? -1 : code); });
    });
}

/**
 * Environment for the LAUNCHER (powershell.exe), which is host-side and trusted but still gets an
 * explicit allowlist rather than the host's full environment — app secrets (JWT_SECRET, DB creds, …)
 * have no business in a process whose only job is to call CreateProcess. This is NOT the child's
 * environment; that one is built by the caller and passed through separately.
 */
function launcherEnv(): Record<string, string> {
    const keys = ['SystemRoot', 'windir', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'NUMBER_OF_PROCESSORS', 'OS', 'SystemDrive', 'PROCESSOR_ARCHITECTURE'];
    const e: Record<string, string> = {};
    for (const k of keys) { const v = process.env[k]; if (v !== undefined) e[k] = v; }
    return e;
}

// ── 2. The DACL grants (and the revoke that must exist alongside them) ───────────────────────────
//
// An AppContainer reaches ONLY objects whose DACL names its package SID; `icacls <dir> /grant *<SID>:…`
// is how that ACE is added. Two modes express read/execute versus writable authority:
//   · 'rx'   — read + execute + inherit. Narrow core, dependency and plugin roots plus the Node runtime.
//              This lets the child load what it needs without exposing config, DB, logs or siblings.
//   · 'full' — the historical API name for read/write/delete WITHOUT file execute, WRITE_DAC or
//              WRITE_OWNER. Directories retain traverse. This preserves W^X on every writable tree.
//
// REVOKE IS NOT OPTIONAL. Every ACE this adds is a persistent modification to the operator's filesystem.
// An earlier hand-run of this experiment left a stray ACE behind on a real machine, and an operator who
// turns the feature off and finds an unexplained `S-1-15-2-…` on their install directory has been handed
// a mystery, not a sandbox. revokeAppContainerAccess() removes exactly what grant added, is idempotent,
// and is covered by its own test.

type AclMode = 'traverse' | 'rx' | 'full' | 'revoke';
function buildIcaclsScript(mode: AclMode): string {
    // The SID and the directory list travel in the environment (base64 for the list); nothing here is
    // interpolated into script text, so a path can never become PowerShell source.
    const operation = mode === 'revoke'
        ? [
            "  $null = & icacls $d /remove:g \"*${sid}\" /T /C /Q",
            "  if ($LASTEXITCODE -ne 0) { $fail++; continue }",
            "  $null = & icacls $d /remove:d \"*${sid}\" /T /C /Q",
        ]
        : mode === 'traverse'
            ? ["  $null = & icacls $d /grant:r \"*${sid}:(RX)\" /C /Q"]
            : mode === 'rx'
                ? ["  $null = & icacls $d /grant:r \"*${sid}:(OI)(CI)(RX)\" /T /C /Q"]
                : [
                    // Remove earlier recursive Full/Modify ACEs first. The new authority is inherited
                    // from the zone root and splits containers from files: directories need X to
                    // traverse, while files deliberately never receive X. Modify excludes WRITE_DAC and
                    // WRITE_OWNER, so the child cannot remove or widen this policy itself.
                    "  $null = & icacls $d /remove:g \"*${sid}\" /T /C /Q",
                    "  if ($LASTEXITCODE -ne 0) { $fail++; continue }",
                    "  $null = & icacls $d /remove:d \"*${sid}\" /T /C /Q",
                    "  if ($LASTEXITCODE -ne 0) { $fail++; continue }",
                    "  $null = & icacls $d /grant:r \"*${sid}:(CI)(M)\" \"*${sid}:(OI)(CI)(IO)(RD,WD,AD,REA,WEA,RA,WA,DE,RC,S)\" /C /Q",
                ];
    const script = [
        "$ErrorActionPreference='Continue'",
        "$sid = $env:WJS_AC_SID",
        "$dirs = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WJS_AC_DIRS_B64)) -split \"`n\" | Where-Object { $_.Length -gt 0 }",
        "$fail = 0; $skip = 0",
        "foreach ($d in $dirs) {",
        // A zone that does not exist on this install is SKIPPED, never fatal -- the same tolerance
        // Missing optional uploads/logs zones are skipped rather than making the launch fail.
        "  if (-not (Test-Path -LiteralPath $d)) { $skip++; continue }",
        // ${sid} braces are load-bearing: in a PowerShell double-quoted string `$sid:` parses as a
        // scope/drive qualifier ("$env:PATH" is the same syntax), so `"*$sid:(OI)..."` would NOT expand to
        // the SID -- it would silently produce a malformed principal and icacls would grant nothing.
        ...operation,
        "  if ($LASTEXITCODE -ne 0) { $fail++ }",
        "}",
        "Write-Output (\"ICACLS fail=$fail skip=$skip total=\" + $dirs.Count)",
    ].join("\n");
    assertAscii(script, 'icacls script');
    return script;
}

/** Derive the deterministic package SID without registering a new profile. */
async function deriveAppContainerSid(name: string): Promise<string | null> {
    if (process.platform !== 'win32') return null;
    const r = await runPowerShellWithEnv(buildProfileScript(name, 'derive'), { WJS_AC_NAME: name }, PROFILE_API_TIMEOUT_MS);
    return /OK (S-1-15-2-[0-9-]+)/.exec(r.out)?.[1] || null;
}

// A recursive icacls over the application tree can take tens of seconds. Remember successful grants in
// a host-only directory so the zero-config setup cost is paid once per SID/path/access shape, not once per
// server start. This is an optimisation, never an authority decision: AppContainer's kernel token and the
// object's real DACL remain the enforcement point, and launch/probe still fail closed if either is wrong.
const ACL_CACHE_VERSION = 'v3';
function appContainerAclCacheRoot(): string {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'WordJS', 'sandbox-acl-cache', ACL_CACHE_VERSION);
}

function appContainerAclCacheKey(sid: string, dir: string, mode: Exclude<AclMode, 'revoke'>): string {
    const canonical = path.resolve(String(dir)).toLowerCase();
    return crypto.createHash('sha256')
        .update(`${sid}\0${canonical}\0${mode}`, 'utf8')
        .digest('hex');
}

function aclMarkerPath(sid: string, dir: string, mode: Exclude<AclMode, 'revoke'>): string {
    return path.join(appContainerAclCacheRoot(), `${appContainerAclCacheKey(sid, dir, mode)}.ok`);
}

function aclGrantIsCached(sid: string, dir: string, mode: Exclude<AclMode, 'revoke'>): boolean {
    // Exact shape only. Treating an old full grant as satisfying rx made permission reductions sticky.
    return fs.existsSync(aclMarkerPath(sid, dir, mode));
}

function writeAclMarker(sid: string, dir: string, mode: Exclude<AclMode, 'revoke'>): void {
    const marker = aclMarkerPath(sid, dir, mode);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    // The marker is written only after icacls reports a completely successful batch. Renaming a complete
    // temporary file prevents a crash during the write from manufacturing a successful-looking marker.
    const temp = `${marker}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temp, `${path.resolve(dir)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.renameSync(temp, marker); } catch (e: any) {
        // Another process may have completed the same grant between our check and rename. That is success.
        if (!fs.existsSync(marker)) throw e;
        try { fs.rmSync(temp, { force: true }); } catch { /* best-effort temporary-file cleanup */ }
    }
}

function removeAclMarkers(sid: string, dir: string): void {
    for (const mode of ['traverse', 'rx', 'full'] as const) {
        try { fs.rmSync(aclMarkerPath(sid, dir, mode), { force: true }); } catch { /* cache is optional */ }
    }
}

async function acquireAclCacheLock(sid: string): Promise<() => void> {
    const root = appContainerAclCacheRoot();
    fs.mkdirSync(root, { recursive: true });
    const key = crypto.createHash('sha256').update(sid, 'utf8').digest('hex').slice(0, 32);
    const lock = path.join(root, `${key}.lock`);
    const deadline = Date.now() + 130000; // slightly longer than the bounded icacls invocation
    for (;;) {
        try {
            const fd = fs.openSync(lock, 'wx', 0o600);
            try {
                fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
            } catch (e) {
                try { fs.closeSync(fd); } catch { /* */ }
                try { fs.rmSync(lock, { force: true }); } catch { /* */ }
                throw e;
            }
            let released = false;
            return () => {
                if (released) return;
                released = true;
                try { fs.closeSync(fd); } catch { /* */ }
                try { fs.rmSync(lock, { force: true }); } catch { /* */ }
            };
        } catch (e: any) {
            if (!e || e.code !== 'EEXIST') throw e;
            // A killed setup process must not block all future launches forever. A real icacls batch is
            // bounded to two minutes, so ten minutes cannot be a live lock from this implementation.
            try {
                const age = Date.now() - fs.statSync(lock).mtimeMs;
                if (age > 10 * 60 * 1000) { fs.rmSync(lock, { force: true }); continue; }
            } catch { continue; }
            if (Date.now() >= deadline) throw new Error('timed out waiting for AppContainer ACL provisioning lock', { cause: e });
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
}

/**
 * Grant (or revoke) the AppContainer SID's access to a set of directories. Idempotent in both directions.
 * Returns true only when every existing directory in the list was processed without error — a partial
 * grant is a launch that will fail in a confusing place later, so the caller must be able to see it.
 */
async function grantAppContainerAccess(sid: string, dirs: string[], mode: AclMode = 'rx'): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    if (!sid || !/^S-1-15-2-[0-9-]+$/.test(sid)) return false; // only ever an AppContainer package SID
    const list = Array.from(new Map(
        (dirs || []).filter(Boolean).map((d) => {
            const resolved = path.resolve(String(d));
            return [resolved.toLowerCase(), resolved] as const;
        }),
    ).values());
    if (list.length === 0) return true;
    let release: (() => void) | null = null;
    let cacheAvailable = true;
    try {
        release = await acquireAclCacheLock(sid);
    } catch (e: any) {
        // A cache failure must not become a sandbox bypass or an availability dependency. Run the original
        // idempotent icacls operation uncached; the real DACL result is still checked below.
        cacheAvailable = false;
        console.warn(`[Sandbox] AppContainer ACL cache unavailable; provisioning directly: ${logSafe(e && e.message)}`);
    }

    try {
        // Missing optional zones remain a successful no-op and are deliberately not cached: if one appears
        // later, a subsequent launch must grant it rather than trusting a marker created before it existed.
        let pending = list.filter((d) => fs.existsSync(d));
        if (mode !== 'revoke' && cacheAvailable) {
            pending = pending.filter((d) => !aclGrantIsCached(sid, d, mode));
        }
        if (pending.length === 0) return true;

        const r = await runPowerShellWithEnv(buildIcaclsScript(mode), {
            WJS_AC_SID: sid,
            WJS_AC_DIRS_B64: Buffer.from(pending.join('\n'), 'utf8').toString('base64'),
        }, 120000); // icacls /T over a large node_modules tree is not fast
        const m = /ICACLS fail=(\d+) skip=(\d+) total=(\d+)/.exec(r.out);
        if (!m) { console.warn(`[Sandbox] AppContainer ${logSafe(mode)} failed to run: ${logSafe(r.out.trim().slice(0, 200))}`); return false; }
        const failed = Number(m[1]);
        // A failure here is reported, never fatal by itself. MEASURED on this host: granting
        // C:\Program Files\nodejs is refused for a non-admin account (the directory is owned by
        // TrustedInstaller) and the AppContainer child STILL launches and runs — because CreateProcessW
        // opens the image in the LAUNCHER's security context, not the new process's. So the read-exec grant
        // on the Node runtime is belt-and-braces for runtimes that ship files the child itself opens later,
        // not a precondition. The grants that genuinely matter are the narrow readable roots the operator owns.
        // What must never happen is claiming confinement on the strength of a grant that did not land —
        // which is why this returns false and probeAppContainer decides on evidence from a real child.
        if (failed > 0) console.warn(`[Sandbox] AppContainer ${logSafe(mode)}: ${logSafe(failed)} of ${logSafe(m[3])} director${failed === 1 ? 'y' : 'ies'} could not be updated (an ACL change on a directory this account does not own — e.g. a Node runtime under Program Files — needs an elevated one-time icacls; the launch may still work, and the probe is what decides).`);
        if (failed === 0 && mode !== 'revoke' && cacheAvailable) {
            for (const dir of pending) {
                writeAclMarker(sid, dir, mode);
                // The real ACE was replaced, so an alternate-shape marker is now stale.
                for (const other of ['traverse', 'rx', 'full'] as const) {
                    if (other !== mode) try { fs.rmSync(aclMarkerPath(sid, dir, other), { force: true }); } catch { /* cache optional */ }
                }
            }
        }
        return failed === 0;
    } finally {
        if (mode === 'revoke') for (const dir of list) removeAclMarkers(sid, dir);
        if (release) release();
    }
}

/** Remove every ACE grantAppContainerAccess added. Thin, named alias so the revoke path is discoverable. */
function revokeAppContainerAccess(sid: string, dirs: string[]): Promise<boolean> {
    return grantAppContainerAccess(sid, dirs, 'revoke');
}

// ── 3. The launch ────────────────────────────────────────────────────────────────────────────────
//
// One PowerShell method, one CreateProcess. The relay:
//   1. reads the IPC pipe handle Node put at CRT fd 3 out of its OWN STARTUPINFO.lpReserved2,
//   2. builds the child's MSVCRT fd block with that handle republished at fd 3 (fd 0/1/2 = the stdio
//      Node already gave the relay, so the existing per-plugin log rate-limiter keeps working unchanged),
//   3. creates a Job Object carrying the resource caps + KILL_ON_JOB_CLOSE,
//   4. CreateProcessW SUSPENDED with PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES (zero capabilities),
//   5. assigns the child to the job BEFORE resuming it — a child that ran even briefly outside the job
//      could have forked past the pid cap or committed past the memory cap first,
//   6. resumes it, writes the contained pid where the host can read it, closes its own copy of the IPC
//      handle so the pipe has exactly one downstream end, and WAITS.
//
// The relay must outlive the child: it is the process the host's ChildProcess is bound to, and its job
// handle is what guarantees the child dies with it.

function buildRelayScript(): string {
    const script = [
        "$ErrorActionPreference='Stop'",
        "try {",
        "$sig=@'",
        "using System; using System.Runtime.InteropServices; using System.Text; using System.IO;",
        "public static class WJSACRelay {",
        "[StructLayout(LayoutKind.Sequential)] public struct SI { public UInt32 cb; public IntPtr r1; public IntPtr desk; public IntPtr title; public UInt32 x; public UInt32 y; public UInt32 xs; public UInt32 ys; public UInt32 xc; public UInt32 yc; public UInt32 fill; public UInt32 flags; public UInt16 show; public UInt16 cbR2; public IntPtr lpR2; public IntPtr hIn; public IntPtr hOut; public IntPtr hErr; }",
        "[StructLayout(LayoutKind.Sequential)] public struct SIEX { public SI Si; public IntPtr AttrList; }",
        "[StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr hProcess; public IntPtr hThread; public UInt32 pid; public UInt32 tid; }",
        "[StructLayout(LayoutKind.Sequential)] public struct SECCAPS { public IntPtr Sid; public IntPtr Caps; public UInt32 CapCount; public UInt32 Reserved; }",
        "[StructLayout(LayoutKind.Sequential)] public struct SIDATTR { public IntPtr Sid; public UInt32 Attributes; }",
        // JOBOBJECT_BASIC_LIMIT_INFORMATION: the two LARGE_INTEGER time limits, LimitFlags, the working-set
        // pair, ActiveProcessLimit (the fork-bomb cap), Affinity, PriorityClass, SchedulingClass.
        "[StructLayout(LayoutKind.Sequential)] public struct BLI { public Int64 PerProcUserTime; public Int64 PerJobUserTime; public UInt32 LimitFlags; public UIntPtr MinWS; public UIntPtr MaxWS; public UInt32 ActiveProcessLimit; public UIntPtr Affinity; public UInt32 PriorityClass; public UInt32 SchedulingClass; }",
        "[StructLayout(LayoutKind.Sequential)] public struct IOC { public UInt64 a; public UInt64 b; public UInt64 c; public UInt64 d; public UInt64 e; public UInt64 f; }",
        "[StructLayout(LayoutKind.Sequential)] public struct ELI { public BLI Basic; public IOC Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProc; public UIntPtr PeakJob; }",
        // JOBOBJECT_CPU_RATE_CONTROL_INFORMATION: ControlFlags + a union whose CpuRate member is in
        // 1/100 of a percent of ONE cpu-time budget across the whole job (so 5000 == 50%).
        "[StructLayout(LayoutKind.Sequential)] public struct CPURATE { public UInt32 ControlFlags; public UInt32 CpuRate; }",
        "[DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode)] public static extern void GetStartupInfoW(ref SI si);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool InitializeProcThreadAttributeList(IntPtr l, Int32 c, Int32 f, ref IntPtr size);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool UpdateProcThreadAttribute(IntPtr l, UInt32 f, IntPtr attr, IntPtr val, IntPtr size, IntPtr prev, IntPtr ret);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern void DeleteProcThreadAttributeList(IntPtr l);",
        "[DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, UInt32 flags, IntPtr env, string cwd, ref SIEX si, out PI pi);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool SetHandleInformation(IntPtr h, UInt32 mask, UInt32 flags);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr GetStdHandle(Int32 n);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern UInt32 WaitForSingleObject(IntPtr h, UInt32 ms);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h, out UInt32 code);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool TerminateProcess(IntPtr h, UInt32 code);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern UInt32 ResumeThread(IntPtr h);",
        "[DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr a, string n);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr p, uint l);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);",
        "[DllImport(\"advapi32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool ConvertStringSidToSidW(string s, out IntPtr sid);",
        "[DllImport(\"kernel32.dll\")] public static extern IntPtr LocalFree(IntPtr p);",
        // ProcThreadAttributeValue(n, thread, input, additive) = n | (thread?0x10000) | (input?0x20000).
        // SecurityCapabilities = 9 -> 0x00020009 (already in use), MitigationPolicy = 7 -> 0x00020007,
        // HandleList = 2 -> 0x00020002. Spelled out because a wrong ordinal can leave an otherwise valid
        // AppContainer launch with a broken IPC channel or with unrelated inheritable handles leaked in.
        "public const uint ATTR_SECURITY_CAPABILITIES = 0x00020009;",
        "public const uint ATTR_MITIGATION_POLICY = 0x00020007;",
        "public const uint ATTR_HANDLE_LIST = 0x00020002;",
        // PROCESS_CREATION_MITIGATION_POLICY_PROHIBIT_DYNAMIC_CODE_ALWAYS_ON = 1ui64 << 36.
        "public const long PROHIBIT_DYNAMIC_CODE = 0x1000000000L;",
        // Read the handle our parent placed at CRT fd `idx`. Layout: int count; byte flags[count]; HANDLE h[count].
        "public static IntPtr InheritedFd(int idx) {",
        "SI si = new SI(); si.cb = (UInt32)Marshal.SizeOf(typeof(SI)); GetStartupInfoW(ref si);",
        "if (si.lpR2 == IntPtr.Zero || si.cbR2 < 4) return IntPtr.Zero;",
        "int n = Marshal.ReadInt32(si.lpR2, 0); if (idx >= n) return IntPtr.Zero;",
        "return Marshal.ReadIntPtr(si.lpR2, 4 + n + idx * IntPtr.Size); }",
        "public static string Env(string k) { string v = Environment.GetEnvironmentVariable(k); return v == null ? \"\" : v; }",
        "public static string B64(string k) { string v = Env(k); return v.Length == 0 ? \"\" : Encoding.UTF8.GetString(Convert.FromBase64String(v)); }",
        "public static int Num(string k) { int v; return Int32.TryParse(Env(k), out v) ? v : 0; }",
        "public static int Run() {",
        "IntPtr sid = IntPtr.Zero, capSid = IntPtr.Zero, capArray = IntPtr.Zero, attrList = IntPtr.Zero, capsPtr = IntPtr.Zero, envPtr = IntPtr.Zero, res2 = IntPtr.Zero, job = IntPtr.Zero, handleListPtr = IntPtr.Zero, mitPtr = IntPtr.Zero;",
        "try {",
        "IntPtr hIpc = InheritedFd(3);",
        "if (hIpc == IntPtr.Zero || hIpc == new IntPtr(-1)) { Console.Error.WriteLine(\"WJSAC FAIL noipcfd\"); return 121; }",
        "if (!SetHandleInformation(hIpc, 1, 1)) { Console.Error.WriteLine(\"WJSAC FAIL inheritipc \" + Marshal.GetLastWin32Error()); return 121; }", // HANDLE_FLAG_INHERIT
        "IntPtr hIn = GetStdHandle(-10), hOut = GetStdHandle(-11), hErr = GetStdHandle(-12);",
        "if (!SetHandleInformation(hIn, 1, 1) || !SetHandleInformation(hOut, 1, 1) || !SetHandleInformation(hErr, 1, 1)) { Console.Error.WriteLine(\"WJSAC FAIL inheritstdio \" + Marshal.GetLastWin32Error()); return 121; }",
        "if (!ConvertStringSidToSidW(Env(\"WJS_AC_SID\"), out sid)) { Console.Error.WriteLine(\"WJSAC FAIL sid\"); return 121; }",
        "int n = 4, hsz = IntPtr.Size, cb = 4 + n + n * hsz;",
        "res2 = Marshal.AllocHGlobal(cb); Marshal.WriteInt32(res2, 0, n);",
        // FOPEN=0x01 on every slot; FPIPE=0x08 additionally on fd 3 so the CRT knows it is a pipe.
        "byte[] fl = new byte[] { 0x01, 0x01, 0x01, 0x09 };",
        "IntPtr[] hs = new IntPtr[] { hIn, hOut, hErr, hIpc };",
        "for (int i = 0; i < n; i++) Marshal.WriteByte(res2, 4 + i, fl[i]);",
        "for (int i = 0; i < n; i++) Marshal.WriteIntPtr(res2, 4 + n + i * hsz, hs[i]);",
        "string[] pairs = B64(\"WJS_AC_ENV_B64\").Split('\\n');",
        "StringBuilder eb = new StringBuilder();",
        "for (int i = 0; i < pairs.Length; i++) { if (pairs[i].Length > 0) { eb.Append(pairs[i]); eb.Append('\\0'); } }",
        "eb.Append('\\0');",
        "envPtr = Marshal.StringToHGlobalUni(eb.ToString());",
        // S-1-15-3-1 is the well-known internetClient capability SID. It is added only for a plugin whose
        // admin grant permits network; every other capability remains absent. Filesystem and process
        // confinement come from the package SID/token and are unchanged by this one network capability.
        "SECCAPS caps = new SECCAPS(); caps.Sid = sid; caps.Caps = IntPtr.Zero; caps.CapCount = 0; caps.Reserved = 0;",
        "if (Env(\"WJS_AC_INTERNET_CLIENT\") == \"1\") {",
        "if (!ConvertStringSidToSidW(\"S-1-15-3-1\", out capSid)) { Console.Error.WriteLine(\"WJSAC FAIL internetclientsid\"); return 121; }",
        "SIDATTR sa = new SIDATTR(); sa.Sid = capSid; sa.Attributes = 4;",
        "capArray = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SIDATTR))); Marshal.StructureToPtr(sa, capArray, false);",
        "caps.Caps = capArray; caps.CapCount = 1;",
        "}",
        "capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECCAPS))); Marshal.StructureToPtr(caps, capsPtr, false);",
        // The attribute list is sized for exactly the attributes we are about to add: InitializeProcThreadAttributeList
        // reserves per-slot storage up front and UpdateProcThreadAttribute fails once the count is exhausted.
        "bool noDynCode = Env(\"WJS_AC_NO_DYNAMIC_CODE\") == \"1\";",
        "int attrCount = 2 + (noDynCode ? 1 : 0);",
        "IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, attrCount, 0, ref size);",
        "attrList = Marshal.AllocHGlobal(size);",
        "if (!InitializeProcThreadAttributeList(attrList, attrCount, 0, ref size)) { Console.Error.WriteLine(\"WJSAC FAIL initattr \" + Marshal.GetLastWin32Error()); return 121; }",
        "if (!UpdateProcThreadAttribute(attrList, 0, new IntPtr(ATTR_SECURITY_CAPABILITIES), capsPtr, new IntPtr(Marshal.SizeOf(typeof(SECCAPS))), IntPtr.Zero, IntPtr.Zero)) { Console.Error.WriteLine(\"WJSAC FAIL updateattr \" + Marshal.GetLastWin32Error()); return 121; }",
        // Restrict inheritance to the four descriptors deliberately republished below. This mirrors current
        // libuv's own uv_spawn path and prevents a concurrent host launch from leaking another plugin's handle.
        "handleListPtr = Marshal.AllocHGlobal(4 * IntPtr.Size);",
        "Marshal.WriteIntPtr(handleListPtr, 0 * IntPtr.Size, hIn); Marshal.WriteIntPtr(handleListPtr, 1 * IntPtr.Size, hOut); Marshal.WriteIntPtr(handleListPtr, 2 * IntPtr.Size, hErr); Marshal.WriteIntPtr(handleListPtr, 3 * IntPtr.Size, hIpc);",
        "if (!UpdateProcThreadAttribute(attrList, 0, new IntPtr(ATTR_HANDLE_LIST), handleListPtr, new IntPtr(4 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) { Console.Error.WriteLine(\"WJSAC FAIL handlelist \" + Marshal.GetLastWin32Error()); return 121; }",
        // DYNAMIC CODE PROHIBITION -- off by default and NOT a parity row; see NODE_SURVIVES_PROHIBIT_DYNAMIC_CODE.
        "if (noDynCode) {",
        "mitPtr = Marshal.AllocHGlobal(8); Marshal.WriteInt64(mitPtr, 0, PROHIBIT_DYNAMIC_CODE);",
        "if (!UpdateProcThreadAttribute(attrList, 0, new IntPtr(ATTR_MITIGATION_POLICY), mitPtr, new IntPtr(8), IntPtr.Zero, IntPtr.Zero)) { Console.Error.WriteLine(\"WJSAC FAIL mitigation \" + Marshal.GetLastWin32Error()); return 121; }",
        "}",
        "job = BuildJob();",
        "if (job == IntPtr.Zero) return 121;",
        "SIEX si2 = new SIEX();",
        "si2.Si.cb = (UInt32)Marshal.SizeOf(typeof(SIEX)); si2.AttrList = attrList;",
        "si2.Si.flags = 0x00000100; si2.Si.hIn = hIn; si2.Si.hOut = hOut; si2.Si.hErr = hErr;",
        "si2.Si.cbR2 = (UInt16)cb; si2.Si.lpR2 = res2;",
        "PI pi; StringBuilder cl = new StringBuilder(B64(\"WJS_AC_CMDLINE_B64\"));",
        // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED
        "bool ok = CreateProcessW(Env(\"WJS_AC_EXE\"), cl, IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x00000400 | 0x08000000 | 0x00000004, envPtr, Env(\"WJS_AC_CWD\"), ref si2, out pi);",
        "if (!ok) { int gle = Marshal.GetLastWin32Error(); Console.Error.WriteLine(\"WJSAC FAIL createprocess \" + gle + (gle == 203 ? \" (LOCALAPPDATA missing from the child environment)\" : \"\")); return 121; }",
        // Assign BEFORE the first instruction runs, so no code executes outside the caps.
        "if (!AssignProcessToJobObject(job, pi.hProcess)) { Console.Error.WriteLine(\"WJSAC FAIL assignjob \" + Marshal.GetLastWin32Error()); TerminateProcess(pi.hProcess, 121); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); return 121; }",
        // Probe the ACTIVE_PROCESS=1 guarantee with a second, suspended, identically-contained process. The
        // kernel must terminate it and reject the assignment. Nothing untrusted executes during this proof.
        "if (Env(\"WJS_AC_VERIFY_JOB_LIMIT\") == \"1\") {",
        "PI pp; StringBuilder pcl = new StringBuilder(B64(\"WJS_AC_CMDLINE_B64\"));",
        "bool pok = CreateProcessW(Env(\"WJS_AC_EXE\"), pcl, IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x00000400 | 0x08000000 | 0x00000004, envPtr, Env(\"WJS_AC_CWD\"), ref si2, out pp);",
        "if (!pok) { Console.Error.WriteLine(\"WJSAC FAIL jobprobe-create \" + Marshal.GetLastWin32Error()); TerminateProcess(pi.hProcess, 121); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); return 121; }",
        "bool admitted = AssignProcessToJobObject(job, pp.hProcess);",
        "if (admitted) { Console.Error.WriteLine(\"WJSAC FAIL jobprobe-admitted\"); TerminateProcess(pp.hProcess, 121); TerminateProcess(pi.hProcess, 121); CloseHandle(pp.hThread); CloseHandle(pp.hProcess); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); return 121; }",
        "CloseHandle(pp.hThread); CloseHandle(pp.hProcess);",
        "}",
        "ResumeThread(pi.hThread); CloseHandle(pi.hThread);",
        "string pf = Env(\"WJS_AC_PIDFILE\"); if (pf.Length > 0) { try { File.WriteAllText(pf, pi.pid.ToString()); } catch (Exception) { } }",
        // Our copy of the IPC handle must go, or the pipe never sees the child's end close.
        "CloseHandle(hIpc);",
        "WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);",
        "UInt32 code = 0; GetExitCodeProcess(pi.hProcess, out code); CloseHandle(pi.hProcess);",
        "if (code != 0) Console.Error.WriteLine(\"WJSAC CHILD EXIT \" + code);",
        "return (int)code;",
        "} finally {",
        "if (attrList != IntPtr.Zero) { DeleteProcThreadAttributeList(attrList); Marshal.FreeHGlobal(attrList); }",
        "if (capsPtr != IntPtr.Zero) Marshal.FreeHGlobal(capsPtr);",
        "if (handleListPtr != IntPtr.Zero) Marshal.FreeHGlobal(handleListPtr);",
        "if (capArray != IntPtr.Zero) Marshal.FreeHGlobal(capArray);",
        "if (capSid != IntPtr.Zero) LocalFree(capSid);",
        "if (envPtr != IntPtr.Zero) Marshal.FreeHGlobal(envPtr);",
        "if (res2 != IntPtr.Zero) Marshal.FreeHGlobal(res2);",
        "if (sid != IntPtr.Zero) LocalFree(sid);",
        // job is deliberately NOT closed here: the finally runs after the child exited, and closing it
        // earlier would trip KILL_ON_JOB_CLOSE and kill the child we are supervising.
        "} }",
        "public static IntPtr BuildJob() {",
        "long mem = 0; long.TryParse(Env(\"WJS_AC_MEM_BYTES\"), out mem);",
        "int procs = Num(\"WJS_AC_ACTIVE_PROCS\"); int cpu = Num(\"WJS_AC_CPU_PERCENT\");",
        "IntPtr j = CreateJobObjectW(IntPtr.Zero, null);",
        "if (j == IntPtr.Zero) { Console.Error.WriteLine(\"WJSAC FAIL createjob \" + Marshal.GetLastWin32Error()); return IntPtr.Zero; }",
        "ELI i = new ELI(); BLI b = i.Basic;",
        // KILL_ON_JOB_CLOSE is unconditional: it is what makes killing the relay kill the contained child
        // and without it a relay killed by the host leaves an orphan running
        // with the plugin's registrations still live -- the exact leak plugin-isolate's subtree sweep exists
        // to prevent on Linux. DIE_ON_UNHANDLED_EXCEPTION keeps an over-budget child from popping a WER dialog.
        "UInt32 f = 0x00002000 | 0x00000400;",
        "if (mem > 0) { f |= 0x00000100; i.ProcessMemoryLimit = new UIntPtr((ulong)mem); }",
        "if (procs > 0) { f |= 0x00000008; b.ActiveProcessLimit = (UInt32)procs; }",
        "b.LimitFlags = f; i.Basic = b;",
        "int cb2 = Marshal.SizeOf(i); IntPtr p = Marshal.AllocHGlobal(cb2); Marshal.StructureToPtr(i, p, false);",
        "bool ok = SetInformationJobObject(j, 9, p, (uint)cb2); Marshal.FreeHGlobal(p);", // 9 = JobObjectExtendedLimitInformation
        "if (!ok) { Console.Error.WriteLine(\"WJSAC FAIL setjoblimits \" + Marshal.GetLastWin32Error()); CloseHandle(j); return IntPtr.Zero; }",
        "if (cpu > 0 && cpu < 100) {",
        "CPURATE cr = new CPURATE();",
        // ENABLE (0x1) | HARD_CAP (0x4): a hard ceiling, not a weight -- a plugin spinning on the CPU is
        // throttled by the kernel instead of competing with the host for the whole box.
        "cr.ControlFlags = 0x1 | 0x4; cr.CpuRate = (UInt32)(cpu * 100);",
        "int cb3 = Marshal.SizeOf(cr); IntPtr p2 = Marshal.AllocHGlobal(cb3); Marshal.StructureToPtr(cr, p2, false);",
        "bool ok2 = SetInformationJobObject(j, 15, p2, (uint)cb3); Marshal.FreeHGlobal(p2);", // 15 = JobObjectCpuRateControlInformation
        "if (!ok2) Console.Error.WriteLine(\"WJSAC WARN setcpurate \" + Marshal.GetLastWin32Error());",
        "}",
        "return j; }",
        "}",
        "'@",
        "Add-Type -TypeDefinition $sig",
        "exit ([WJSACRelay]::Run())",
        "} catch { [Console]::Error.WriteLine('WJSAC FAIL ex:' + $_.Exception.Message); exit 121 }",
    ].join("\n");
    assertAscii(script, 'AppContainer relay script');
    return script;
}

/**
 * argv flags every AppContainer child needs, with the failure each one prevents.
 *
 * Kept as a named export so the integration can put them in FRONT of the caller's execArgv and so the
 * test can assert their presence without re-deriving the reason from a comment.
 */
const APPCONTAINER_NODE_FLAGS = [
    // Node resolves a module's realpath, and realpath lstats every ancestor up to the drive root. Inside a
    // container granted only its own zones that is refused, and the child dies before user code with
    //     Error: EPERM: operation not permitted, lstat 'C:\'
    // --preserve-symlinks-main skips that resolution for the ENTRY module; --preserve-symlinks skips it for
    // every require() after it. Measured: neither flag => the main module never loads; main-only => main
    // loads and the first relative require() dies the same way; both => clean boot. The alternative (giving
    // the AppContainer SID traverse rights on C:\, C:\Users, ...) is a persistent, invasive change to the
    // operator's machine for a problem two flags solve, so it is deliberately not taken.
    '--preserve-symlinks-main',
    '--preserve-symlinks',
];

/**
 * Environment keys the CHILD must have on top of whatever the caller passes.
 *
 * LOCALAPPDATA is not a convenience: without it CreateProcessW with PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
 * fails with 203 ERROR_ENVVAR_NOT_FOUND, deterministically, because the AppContainer's redirected AppData
 * root is derived from it. It is a path, not a secret, which is why it is safe to add to a child whose
 * environment is otherwise a strict secret-free allowlist.
 */
function requiredChildEnv(): Record<string, string> {
    const e: Record<string, string> = {};
    // libuv itself restores this same class of Windows runtime variables in uv_spawn. Our relay calls
    // CreateProcessW directly, so it must do that work explicitly. These are identity/path metadata, not
    // application secrets; keeping the list here avoids inheriting JWT/database credentials by accident.
    const keys = ['SystemRoot', 'windir', 'SystemDrive', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC',
        'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN'];
    for (const k of keys) {
        const v = process.env[k];
        if (v !== undefined) e[k] = v;
    }
    return e;
}

/**
 * Return a user-owned copy of the current Node executable that can be ACL'd to an AppContainer without
 * elevation. A stock MSI install lives under Program Files: CreateProcess can open node.exe in the
 * launcher's context, but the lowbox token must load the image/DLLs afterwards and otherwise exits with
 * STATUS_DLL_INIT_FAILED (0xC0000142). Keeping the immutable runtime outside plugin write zones closes
 * that zero-configuration gap without granting an AppContainer traverse rights over Program Files.
 */
function getAppContainerRuntimePath(): string {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    let identity = `${process.version}-${process.arch}`;
    try {
        const st = fs.statSync(process.execPath);
        identity += `-${st.size}-${Math.floor(st.mtimeMs)}`;
    } catch { /* the copy below will report the useful error */ }
    identity = identity.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(local, 'WordJS', 'sandbox-runtime', identity, 'node.exe');
}

/**
 * Materialise the static relay beside the private Node runtime. Passing it via PowerShell's
 * -EncodedCommand eventually hits Windows' command-line ceiling as the native checks grow. The digest in
 * the filename makes updates immutable/cache-safe; no caller-controlled value is ever written as script.
 */
function ensureAppContainerRelayScript(): string {
    const script = buildRelayScript();
    const digest = crypto.createHash('sha256').update(script, 'utf8').digest('hex').slice(0, 16);
    const target = path.join(path.dirname(getAppContainerRuntimePath()), `relay-${digest}.ps1`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
        if (fs.readFileSync(target, 'utf8') === script) return target;
    } catch { /* create below */ }
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, script, { encoding: 'ascii', flag: 'wx' });
    try { fs.renameSync(tmp, target); }
    catch (e: any) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
        if (!fs.existsSync(target)) throw e;
    }
    return target;
}

async function ensureAppContainerRuntime(sid: string): Promise<string> {
    const target = getAppContainerRuntimePath();
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    let ready = false;
    try {
        const src = fs.statSync(process.execPath);
        const dst = fs.statSync(target);
        ready = src.size === dst.size;
    } catch { /* copy below */ }
    if (!ready) fs.copyFileSync(process.execPath, target);
    const granted = await grantAppContainerAccess(sid, [dir], 'rx');
    if (!granted) throw new Error(`could not grant the AppContainer read/execute access to its user-owned Node runtime (${dir})`);
    return target;
}

type LaunchOpts = {
    sid: string;
    exe: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdio?: any;
    memoryBytes?: number;
    cpuPercent?: number;
    addNodeFlags?: boolean; // default true; the caller can opt out if it already inserted them
    allowNetwork?: boolean; // adds only internetClient; all other AppContainer restrictions remain
    verifyProcessLimit?: boolean; // native probe only: tries and must fail to add a second suspended process
};

type LaunchResult = {
    child: any;          // the host-side ChildProcess -- this is the RELAY, and it owns the live IPC channel
    relayPid: number | null;
    containedPid: number | null; // the node process actually inside the AppContainer
    pidFileDir: string | null;   // caller cleans up after the child exits
};

/**
 * Launch `exe args` inside the AppContainer named by `sid`, wired to a fork-style IPC channel.
 *
 * The returned `child` is a real Node ChildProcess with a working `send`/`on('message')` at
 * `serialization: 'advanced'` — the plugin-worker protocol is carried UNCHANGED. It is bound to the
 * relay, not to the contained process, so:
 *   · `child.pid` is powershell.exe; the contained pid is `containedPid` (same shape as the existing
 *     systemd-run --scope path, where child.pid is systemd-run).
 *   · `child.kill()` kills the relay, and the contained child dies with it by JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
 *   · the relay's exit code IS the contained child's exit code (121 marks a relay-level failure, which
 *     it also explains on stderr, tagged WJSAC).
 */
async function launchInAppContainer(opts: LaunchOpts): Promise<LaunchResult> {
    if (process.platform !== 'win32') throw new Error('[Sandbox] launchInAppContainer is Windows-only.');
    if (!opts || !/^S-1-15-2-[0-9-]+$/.test(String(opts.sid || ''))) throw new Error('[Sandbox] launchInAppContainer needs an AppContainer package SID.');

    const cfg = sandboxConfig();
    const addFlags = opts.addNodeFlags !== false;
    const argv = addFlags ? [...APPCONTAINER_NODE_FLAGS, ...(opts.args || [])] : [...(opts.args || [])];
    const cmdLine = buildCommandLine(opts.exe, argv);

    const childEnv: Record<string, string> = { ...(opts.env || {}), ...requiredChildEnv() };
    // Node's child bootstrap reads these two to attach the fork channel to the inherited fd.
    childEnv.NODE_CHANNEL_FD = '3';
    childEnv.NODE_CHANNEL_SERIALIZATION_MODE = 'advanced';
    if (opts.verifyProcessLimit) childEnv.WJS_PROCESS_DENIAL = 'JOB_OBJECT';
    const envPairs = Object.keys(childEnv)
        .filter((k) => childEnv[k] !== undefined && childEnv[k] !== null)
        .map((k) => `${k}=${String(childEnv[k])}`);

    // mkdtemp so the pid file lands on a kernel-exclusive 0700 name nobody can pre-create or predict --
    // the same reasoning as the seccomp BPF file in plugin-isolate.ts. Nothing secret is in it; a
    // predictable path in a shared temp dir is simply a bad habit to keep out of this module.
    let pidFileDir: string | null = null;
    let pidFile = '';
    try {
        const d: string = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-ac-'));
        pidFileDir = d;
        pidFile = path.join(d, 'pid');
    } catch { /* no pid file: teardown goes through the job, so only telemetry loses out */ }

    const relayEnv: Record<string, string> = {
        ...launcherEnv(),
        WJS_AC_SID: opts.sid,
        WJS_AC_EXE: opts.exe,
        WJS_AC_CMDLINE_B64: Buffer.from(cmdLine, 'utf8').toString('base64'),
        WJS_AC_CWD: opts.cwd || process.cwd(),
        WJS_AC_ENV_B64: Buffer.from(envPairs.join('\n'), 'utf8').toString('base64'),
        WJS_AC_PIDFILE: pidFile,
        WJS_AC_MEM_BYTES: String(Math.max(0, Math.floor(opts.memoryBytes ?? (cfg.useJobObjectMemoryCap === false ? 0 : RSS_BUDGET_BYTES)))),
        // The relay is outside the job; the contained Node is its sole allowed process. With one active
        // process already present, Windows refuses every attempted descendant before it can execute. This
        // is the kernel no-subprocess guarantee and avoids Node's loader incompatibility with
        // PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY (STATUS_DLL_INIT_FAILED on current Node/Windows).
        WJS_AC_ACTIVE_PROCS: '1',
        WJS_AC_CPU_PERCENT: String(Math.max(0, Math.floor(opts.cpuPercent ?? (Number(cfg.cpuQuotaPercent) > 0 ? Number(cfg.cpuQuotaPercent) : 0)))),
        WJS_AC_INTERNET_CLIENT: opts.allowNetwork ? '1' : '0',
        WJS_AC_VERIFY_JOB_LIMIT: opts.verifyProcessLimit ? '1' : '0',
    };

    const relayScript = ensureAppContainerRelayScript();
    // stdio MUST carry an 'ipc' slot at index 3 -- that is where Node puts the channel, and where the
    // relay looks for it. A caller that omits it gets a child with no `process.send`, which the probe
    // would (correctly) call not-active.
    const stdio = opts.stdio || ['ignore', 'pipe', 'pipe', 'ipc'];
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', relayScript], {
        windowsHide: true,
        stdio,
        serialization: 'advanced',
        env: relayEnv,
    });

    // The contained pid appears only after the relay's CreateProcess returns; poll briefly rather than
    // block a load on it. A null pid is not fatal -- teardown goes through the job, not the pid; only the
    // RSS poll and operator telemetry want it.
    let containedPid: number | null = null;
    if (pidFile) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null && child.exitCode !== undefined) break; // relay already died; stop waiting
            try {
                const raw = fs.readFileSync(pidFile, 'utf8').trim();
                const n = Number(raw);
                if (Number.isFinite(n) && n > 0) { containedPid = n; break; }
            } catch { /* not written yet */ }
            await new Promise((r) => { const t = setTimeout(r, 25); if ((t as any).unref) (t as any).unref(); });
        }
    }
    // The pid file's temp dir is cleaned up HERE, on the child's own exit, rather than being left to the
    // caller. A caller that forgets leaks one directory per plugin load, forever, in the operator's temp
    // -- the kind of debris that is invisible until someone audits the box. `pidFileDir` is still returned
    // so a test can assert on it, but nothing has to act on it.
    if (pidFileDir) {
        const dir = pidFileDir;
        const sweep = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
        try { child.once('exit', sweep); child.once('error', sweep); } catch { sweep(); }
    }
    return { child, relayPid: child.pid ?? null, containedPid, pidFileDir };
}

// ── 4. Job Object caps for the NON-AppContainer Windows launch ───────────────────────────────────
//
// plugin-isolate.ts already assigns each forked child to a Job Object with JOB_OBJECT_LIMIT_PROCESS_MEMORY.
// This is that helper's capability set EXTENDED, exposed from here so the integration can call it without
// this module having to edit plugin-isolate.ts:
//   · JOB_OBJECT_LIMIT_ACTIVE_PROCESS  -- the fork-bomb cap. The peer of the cgroup path's TasksMax, and
//     the answer to the same threat: a plugin that spawns until the host's task table is gone. Per-JOB,
//     so it bounds the plugin's own subtree and never counts the host's processes (the same reason
//     plugin-isolate deliberately uses RLIMIT_NOFILE but not the per-UID RLIMIT_NPROC).
//   · JOBOBJECT_CPU_RATE_CONTROL_INFORMATION -- the CPU quota, driven by the SAME config knob
//     (sandbox.cpuQuotaPercent) the cgroup CPUQuota path uses, so an operator sets one number and gets the
//     same policy on either OS. HARD_CAP, so it is a ceiling and not a scheduling weight.
// Both are opt-in through their knobs and both are best-effort: a failure warns and leaves the previous
// (memory-only) behaviour exactly as it was.

function buildJobCapsScript(): string {
    const script = [
        "$ErrorActionPreference='Stop'",
        "try {",
        "$sig=@'",
        "using System; using System.Runtime.InteropServices;",
        "public static class WJSJobCaps {",
        "[StructLayout(LayoutKind.Sequential)] public struct BLI { public Int64 PerProcUserTime; public Int64 PerJobUserTime; public UInt32 LimitFlags; public UIntPtr MinWS; public UIntPtr MaxWS; public UInt32 ActiveProcessLimit; public UIntPtr Affinity; public UInt32 PriorityClass; public UInt32 SchedulingClass; }",
        "[StructLayout(LayoutKind.Sequential)] public struct IOC { public UInt64 a; public UInt64 b; public UInt64 c; public UInt64 d; public UInt64 e; public UInt64 f; }",
        "[StructLayout(LayoutKind.Sequential)] public struct ELI { public BLI Basic; public IOC Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProc; public UIntPtr PeakJob; }",
        "[StructLayout(LayoutKind.Sequential)] public struct CPURATE { public UInt32 ControlFlags; public UInt32 CpuRate; }",
        "[DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr a, string n);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr p, uint l);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, uint p);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);",
        "public static string Apply(uint pid, long mem, int procs, int cpu) {",
        "IntPtr j = CreateJobObjectW(IntPtr.Zero, null);",
        "if (j == IntPtr.Zero) return \"JOBCAPS_FAIL create \" + Marshal.GetLastWin32Error();",
        "ELI i = new ELI(); BLI b = i.Basic;",
        // No KILL_ON_JOB_CLOSE here: this helper is a one-shot that EXITS, and the job survives only
        // because a running assigned process keeps it alive after the handles close. Adding
        // KILL_ON_JOB_CLOSE would kill the plugin the instant this helper returned.
        "UInt32 f = 0x00000400;",
        "if (mem > 0) { f |= 0x00000100; i.ProcessMemoryLimit = new UIntPtr((ulong)mem); }",
        "if (procs > 0) { f |= 0x00000008; b.ActiveProcessLimit = (UInt32)procs; }",
        "b.LimitFlags = f; i.Basic = b;",
        "int cb = Marshal.SizeOf(i); IntPtr p = Marshal.AllocHGlobal(cb); Marshal.StructureToPtr(i, p, false);",
        "bool ok = SetInformationJobObject(j, 9, p, (uint)cb); Marshal.FreeHGlobal(p);",
        "if (!ok) { CloseHandle(j); return \"JOBCAPS_FAIL setinfo \" + Marshal.GetLastWin32Error(); }",
        "if (cpu > 0 && cpu < 100) {",
        "CPURATE cr = new CPURATE(); cr.ControlFlags = 0x1 | 0x4; cr.CpuRate = (UInt32)(cpu * 100);",
        "int cb2 = Marshal.SizeOf(cr); IntPtr p2 = Marshal.AllocHGlobal(cb2); Marshal.StructureToPtr(cr, p2, false);",
        "bool ok2 = SetInformationJobObject(j, 15, p2, (uint)cb2); Marshal.FreeHGlobal(p2);",
        "if (!ok2) { CloseHandle(j); return \"JOBCAPS_FAIL setcpu \" + Marshal.GetLastWin32Error(); } }",
        "IntPtr h = OpenProcess(0x0100 | 0x0001 | 0x0400, false, pid);", // SET_QUOTA|TERMINATE|QUERY_INFORMATION
        "if (h == IntPtr.Zero) { CloseHandle(j); return \"JOBCAPS_FAIL open \" + Marshal.GetLastWin32Error(); }",
        "bool asn = AssignProcessToJobObject(j, h);",
        "int gle = Marshal.GetLastWin32Error();",
        "CloseHandle(h); CloseHandle(j);",
        "return asn ? \"JOBCAPS_OK\" : (\"JOBCAPS_FAIL assign \" + gle); }",
        "}",
        "'@",
        "Add-Type -TypeDefinition $sig",
        "$r = [WJSJobCaps]::Apply([uint32]$env:WJS_JC_PID, [int64]$env:WJS_JC_MEM, [int]$env:WJS_JC_PROCS, [int]$env:WJS_JC_CPU)",
        "Write-Output $r",
        "if ($r -ne 'JOBCAPS_OK') { exit 1 }",
        "} catch { Write-Output ('JOBCAPS_FAIL ex:' + $_.Exception.Message); exit 1 }",
    ].join("\n");
    assertAscii(script, 'job caps script');
    return script;
}

type JobCaps = { memoryBytes?: number; activeProcessLimit?: number; cpuPercent?: number };

/**
 * Assign an ALREADY-RUNNING pid to a Job Object carrying memory + active-process + CPU-rate caps.
 *
 * Superset of plugin-isolate's assignProcessToJobObject: same one-shot, no-native-dep shape, same
 * post-fork assignment so the IPC channel is untouched, plus the two caps Windows was missing. Resolves
 * true only on JOBCAPS_OK; every failure resolves false and leaves whatever cap was already in force.
 */
async function applyWindowsJobCaps(pid: number, caps: JobCaps = {}): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    if (!Number.isFinite(pid) || pid <= 0) return false;
    const cfg = sandboxConfig();
    const mem = Math.max(0, Math.floor(caps.memoryBytes ?? (cfg.useJobObjectMemoryCap === false ? 0 : RSS_BUDGET_BYTES)));
    const procs = Math.max(0, Math.floor(caps.activeProcessLimit ?? (Number(cfg.pidsMax) > 0 ? Number(cfg.pidsMax) : PIDS_MAX)));
    const cpu = Math.max(0, Math.floor(caps.cpuPercent ?? (Number(cfg.cpuQuotaPercent) > 0 ? Number(cfg.cpuQuotaPercent) : 0)));
    const r = await runPowerShellWithEnv(buildJobCapsScript(), {
        WJS_JC_PID: String(Math.floor(pid)),
        WJS_JC_MEM: String(mem),
        WJS_JC_PROCS: String(procs),
        WJS_JC_CPU: String(cpu),
    }, 30000);
    return r.code === 0 && /JOBCAPS_OK/.test(r.out);
}

/**
 * Probe the extended Job Object caps on THIS host: assign a throwaway child and require JOBCAPS_OK.
 *
 * Same discipline as probeJobObjectCap in plugin-isolate — the probe child is kept alive long enough to
 * outlast a COLD `Add-Type` JIT (2-5 s, more on a loaded box), because OpenProcess against a pid that
 * already exited would report the caps unavailable for the whole process lifetime.
 */
let jobCapsProbe: Promise<boolean> | undefined;
function probeWindowsJobCaps(): Promise<boolean> {
    if (jobCapsProbe) return jobCapsProbe;
    jobCapsProbe = (async () => {
        if (process.platform !== 'win32') return false;
        let probe: any;
        try { probe = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 25000)'], { windowsHide: true, stdio: 'ignore' }); }
        catch { return false; }
        if (!probe || !probe.pid) return false;
        try {
            const ok = await applyWindowsJobCaps(probe.pid, { memoryBytes: 256 * 1024 * 1024, activeProcessLimit: 64, cpuPercent: 50 });
            if (ok) console.log('[Sandbox] extended Job Object caps ACTIVE on Windows (per-child ProcessMemoryLimit + ActiveProcessLimit fork-bomb cap + hard CPU rate cap).');
            else console.warn('[Sandbox] extended Job Object caps unavailable here (PowerShell/Win32 probe failed) - the existing memory cap and the RSS poll are unaffected.');
            return ok;
        } finally { try { probe.kill(); } catch { /* */ } }
    })();
    return jobCapsProbe;
}

// ── 5. The probe ─────────────────────────────────────────────────────────────────────────────────

/**
 * Live state of the Windows AppContainer layer, in the same vocabulary as sandboxHardeningState:
 *   'unsupported' = not Windows · 'disabled' = sandbox.useAppContainer is not on ·
 *   'active' = a real child was actually refused BOTH the network and the out-of-zone read, and we could
 *              still talk to it · 'degraded' = enabled, but that could not be demonstrated on this host.
 * 'degraded' is the dangerous "looks secure but isn't" state and is deliberately NOT reported as active.
 */
let appContainerState: 'unknown' | 'unsupported' | 'disabled' | 'active' | 'degraded' = 'unknown';
function getAppContainerState() { return appContainerState; }
let appContainerSid: string | null = null;
function getAppContainerSid() { return appContainerSid; }

/**
 * The probe child. It reports THREE facts and the probe requires a specific verdict on each:
 *   connect  -- a socket to a raw IP. Must be a PERMISSION refusal (EACCES/EPERM). Deliberately not
 *               "any failure": ENOTFOUND/ETIMEDOUT/ECONNREFUSED are what an offline or filtered host
 *               produces, and accepting those would let a machine with no internet masquerade as a
 *               machine with kernel network confinement. Only the kernel produces EACCES here.
 *   read     -- a directory outside every granted zone. Must be EPERM/EACCES.
 *   write    -- a file INSIDE the granted zone. Must succeed, or the container is so tight that no real
 *               plugin could run in it and 'active' would be a lie of a different kind.
 * Sent over the fork channel, which also proves the IPC relay works -- a container we cannot talk to is
 * not a shippable confinement.
 */
const PROBE_CHILD_SOURCE = [
    "var fs=require('fs'),path=require('path');",
    "var out={ipc:!!process.send,connect:null,read:null,write:null,exec:null};",
    "try{fs.readdirSync(process.env.WJS_PROBE_OUTSIDE);out.read='OPEN'}catch(e){out.read=(e&&e.code)||String(e)}",
    "try{fs.writeFileSync(path.join(__dirname,'probe-write.tmp'),'ok');out.write='OK'}catch(e){out.write=(e&&e.code)||String(e)}",
    // The relay has already made a second suspended AppContainer process hit the Job limit before this
    // child was resumed. Calling child_process from inside this one-process job is deliberately avoided:
    // Node's synchronous uv_spawn setup can block after Windows rejects CreateProcess.
    "out.exec=process.env.WJS_PROCESS_DENIAL||'MISSING';var netSettled=false;",
    "function maybeDone(){if(!netSettled)return;if(!process.send){console.log('WJSPROBE '+JSON.stringify(out));process.exit(0)}",
    "process.send(out,function(){setTimeout(function(){process.exit(0)},150)})}",
    "var s=require('net').connect(80,'1.1.1.1');",
    "s.on('connect',function(){if(netSettled)return;netSettled=true;out.connect='CONNECTED';try{s.destroy()}catch(e){}maybeDone()});",
    "s.on('error',function(e){if(netSettled)return;netSettled=true;out.connect=(e&&e.code)||String(e);maybeDone()});",
    "setTimeout(function(){if(netSettled)return;netSettled=true;out.connect='TIMEOUT';try{s.destroy()}catch(e){}maybeDone()},5000);",
].join('');

/** Run the probe child OUTSIDE any container. The negative control: it proves the read we require to be
 *  refused is a read that is normally ALLOWED, so a 'refused' verdict can only come from the sandbox. */
function runProbeControl(zoneDir: string, outsideDir: string): Promise<any | null> {
    const execProbe = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, timeout: 10000 });
    const execVerdict = execProbe && !execProbe.error && execProbe.status === 0 ? 'OK' : 'FAIL';
    return new Promise((resolve) => {
        let p: any;
        try {
            p = spawn(process.execPath, ['-e', PROBE_CHILD_SOURCE], {
                cwd: zoneDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
                env: { ...launcherEnv(), WJS_PROBE_OUTSIDE: outsideDir },
            });
        } catch { return resolve(null); }
        let got: any = null;
        const finish = () => { try { p.kill(); } catch { /* */ } resolve(got); };
        p.on('message', (m: any) => { got = { ...(m || {}), exec: execVerdict }; });
        p.on('error', () => resolve(null));
        p.on('exit', () => finish());
        const t = setTimeout(finish, 20000); if (t.unref) t.unref();
    });
}

let acProbe: Promise<'active' | 'degraded' | 'unsupported' | 'disabled'> | undefined;
function probeAppContainer(): Promise<'active' | 'degraded' | 'unsupported' | 'disabled'> {
    if (acProbe) return acProbe;
    acProbe = (async () => {
        if (process.platform !== 'win32') { appContainerState = 'unsupported'; return 'unsupported'; }
        // Default-on and zero-configuration. The profile and required ACLs are created automatically
        // under the current user; an explicit false remains the administrative opt-out.
        if (sandboxConfig().useAppContainer === false) { appContainerState = 'disabled'; return 'disabled'; }

        const appRoot = path.resolve(__dirname, '..', '..');
        const probeProfileA = appContainerProfileNameForPlugin(appRoot, '__wordjs_probe_a__');
        const probeProfileB = appContainerProfileNameForPlugin(appRoot, '__wordjs_probe_b__');
        const sid = await ensureAppContainerProfile(probeProfileA);
        const siblingSid = await ensureAppContainerProfile(probeProfileB);
        if (!sid || !siblingSid || sid === siblingSid) {
            appContainerState = 'degraded';
            try { if (sid) await deleteAppContainerProfile(probeProfileA); } catch { /* */ }
            try { if (siblingSid) await deleteAppContainerProfile(probeProfileB); } catch { /* */ }
            console.warn('[Sandbox] AppContainer requested but distinct per-plugin profiles could not be created or derived - isolated plugins keep the standard Windows launch.');
            return 'degraded';
        }
        appContainerSid = sid;

        // Everything the probe touches lives in a throwaway mkdtemp zone, and the ACEs on it die with it.
        let zone: string | null = null;
        let outside: string | null = null;
        let launched: LaunchResult | null = null;
        let allowedLaunched: LaunchResult | null = null;
        try {
            const zoneDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-ac-zone-'));
            zone = zoneDir;
            // The negative-control target: a directory the probe child must be REFUSED inside the
            // container and must be able to read outside it. A sibling temp dir is ideal -- it exists, it
            // is readable by this account, and it is never granted to the SID.
            const outsideDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-ac-outside-'));
            outside = outsideDir;
            fs.writeFileSync(path.join(outsideDir, 'canary.txt'), 'canary');

            const control = await runProbeControl(zoneDir, outsideDir);
            if (!control || control.read !== 'OPEN' || control.write !== 'OK' || control.exec !== 'OK' || control.connect !== 'CONNECTED') {
                appContainerState = 'degraded';
                console.warn(`[Sandbox] AppContainer probe ABORTED: the uncontained control was not clean (read=${logSafe(control && control.read)}, write=${logSafe(control && control.write)}, connect=${logSafe(control && control.connect)}).`);
                return 'degraded';
            }

            // Use a user-owned runtime copy: an MSI Node under Program Files cannot receive a package-SID
            // ACE without elevation and dies during DLL initialisation inside the lowbox token.
            const runtimeExe = await ensureAppContainerRuntime(sid);
            await grantAppContainerAccess(sid, [zoneDir], 'full');
            // Model a real sibling plugin: its own SID can read this zone, while sid A must still be denied.
            await grantAppContainerAccess(siblingSid, [outsideDir], 'full');

            launched = await launchInAppContainer({
                sid,
                exe: runtimeExe,
                // -e carries no main module, so --preserve-symlinks-main has nothing to skip here; the flags
                // are still passed because the probe must exercise the REAL argv shape (the #192 lesson in
                // plugin-isolate.ts: a probe that does not mirror the launch green-lights a launch that fails).
                args: ['-e', PROBE_CHILD_SOURCE],
                cwd: zoneDir,
                env: { ...launcherEnv(), WJS_PROBE_OUTSIDE: outsideDir },
                memoryBytes: 256 * 1024 * 1024,
                cpuPercent: 0,
                allowNetwork: false,
                verifyProcessLimit: true,
            });

            const verdict: any = await new Promise((resolve) => {
                let got: any = null, done = false;
                const finish = () => { if (done) return; done = true; try { launched!.child.kill(); } catch { /* */ } resolve(got); };
                launched!.child.on('message', (m: any) => { got = m; finish(); });
                launched!.child.on('error', () => finish());
                launched!.child.on('exit', () => setTimeout(finish, 50));
                const t = setTimeout(finish, 30000); if (t.unref) t.unref();
            });

            if (!verdict || !verdict.ipc) {
                appContainerState = 'degraded';
                console.warn('[Sandbox] AppContainer probe FAILED: no fork-IPC round-trip from the contained child. A container the host cannot talk to is not a usable sandbox, so the layer stays OFF and the standard Windows launch is used.');
                return 'degraded';
            }
            // BOTH refusals, or nothing. A network verdict that is merely "did not connect" is not proof of
            // kernel confinement, so only a permission error counts.
            const netDenied = verdict.connect === 'EACCES' || verdict.connect === 'EPERM';
            const readDenied = verdict.read === 'EPERM' || verdict.read === 'EACCES';
            const execDenied = verdict.exec === 'JOB_OBJECT';
            const canWork = verdict.write === 'OK';
            if (!netDenied || !readDenied || !execDenied || !canWork) {
                appContainerState = 'degraded';
                console.warn(`[Sandbox] AppContainer probe FAILED (connect=${logSafe(verdict.connect)}, read=${logSafe(verdict.read)}, exec=${logSafe(verdict.exec)}, write=${logSafe(verdict.write)}).`);
                return 'degraded';
            }
            // Certify the network-GRANTED shape independently. internetClient may enable sockets, but it
            // must not widen the package SID's filesystem or process authority.
            allowedLaunched = await launchInAppContainer({
                sid, exe: runtimeExe, args: ['-e', PROBE_CHILD_SOURCE], cwd: zoneDir,
                env: { ...launcherEnv(), WJS_PROBE_OUTSIDE: outsideDir },
                memoryBytes: 256 * 1024 * 1024, cpuPercent: 0,
                allowNetwork: true,
                verifyProcessLimit: true,
            });
            const allowedVerdict: any = await new Promise((resolve) => {
                let got: any = null, done = false;
                const finish = () => { if (done) return; done = true; try { allowedLaunched!.child.kill(); } catch { /* */ } resolve(got); };
                allowedLaunched!.child.on('message', (m: any) => { got = m; finish(); });
                allowedLaunched!.child.on('error', () => finish());
                allowedLaunched!.child.on('exit', () => setTimeout(finish, 50));
                const t = setTimeout(finish, 30000); if (t.unref) t.unref();
            });
            const allowedShape = !!allowedVerdict && allowedVerdict.ipc === true
                && (allowedVerdict.read === 'EPERM' || allowedVerdict.read === 'EACCES')
                && allowedVerdict.exec === 'JOB_OBJECT'
                && allowedVerdict.write === 'OK' && allowedVerdict.connect === 'CONNECTED';
            if (!allowedShape) {
                appContainerState = 'degraded';
                console.warn(`[Sandbox] AppContainer internetClient probe FAILED (connect=${logSafe(allowedVerdict && allowedVerdict.connect)}, read=${logSafe(allowedVerdict && allowedVerdict.read)}, write=${logSafe(allowedVerdict && allowedVerdict.write)}). The network grant must change only egress, not remove the container.`);
                return 'degraded';
            }
            appContainerState = 'active';
            console.log('[Sandbox] Windows AppContainer confinement ACTIVE for both network policies: package-SID filesystem isolation and the one-process Job Object always remain; internetClient is present only for network-granted plugins.');
            return 'active';
        } catch (e: any) {
            appContainerState = 'degraded';
            console.warn(`[Sandbox] AppContainer probe errored: ${logSafe(e && e.message)} - the layer stays OFF.`);
            return 'degraded';
        } finally {
            try { if (launched && launched.child) launched.child.kill(); } catch { /* */ }
            try { if (allowedLaunched && allowedLaunched.child) allowedLaunched.child.kill(); } catch { /* */ }
            try { if (launched && launched.pidFileDir) fs.rmSync(launched.pidFileDir, { recursive: true, force: true }); } catch { /* */ }
            try { if (allowedLaunched && allowedLaunched.pidFileDir) fs.rmSync(allowedLaunched.pidFileDir, { recursive: true, force: true }); } catch { /* */ }
            // Remove the ACEs this probe added to its own throwaway zone BEFORE deleting it, so nothing is
            // left behind even if the rmSync loses a race with a still-dying child.
            try { if (zone) await revokeAppContainerAccess(sid, [zone]); } catch { /* */ }
            try { if (outside) await revokeAppContainerAccess(siblingSid, [outside]); } catch { /* */ }
            try { await revokeAppContainerAccess(sid, [path.dirname(getAppContainerRuntimePath())]); } catch { /* */ }
            try { await deleteAppContainerProfile(probeProfileA); } catch { /* */ }
            try { await deleteAppContainerProfile(probeProfileB); } catch { /* */ }
            try { if (zone) fs.rmSync(zone, { recursive: true, force: true }); } catch { /* */ }
            try { if (outside) fs.rmSync(outside, { recursive: true, force: true }); } catch { /* */ }
        }
    })();
    return acProbe;
}

/**
 * The zones an AppContainer child needs, split by the access each one requires.
 *
 * Mirrors io-guard.ts SAFE_WRITE_DIRS + ownDir exactly: if the
 * kernel's write set and the JS guard's write set disagree, one of them is wrong, and it is always the
 * looser one that matters. Provided here so the integration derives both from one declaration.
 */
function appContainerZones(appRoot: string, slug: string, coreDir: string = __dirname): { traverse: string[]; readExec: string[]; write: string[] } {
    const p = sandboxPaths(appRoot, slug, coreDir);
    return {
        traverse: p.traverse,
        readExec: p.readOnly,
        write: p.writable,
    };
}

/** Remove the persistent SID authority when a plugin is actually uninstalled (not merely restarted). */
async function retireAppContainerPlugin(appRoot: string, slug: string): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    const profile = appContainerProfileNameForPlugin(appRoot, slug);
    // Never CREATE a profile while uninstalling a plugin that was never isolated. Derivation is pure.
    const sid = await deriveAppContainerSid(profile);
    if (!sid) return false;
    const zones = appContainerZones(appRoot, slug, __dirname);
    const candidates: Array<{ dir: string; mode: Exclude<AclMode, 'revoke'> }> = [
        ...zones.traverse.map((dir) => ({ dir, mode: 'traverse' as const })),
        ...zones.readExec.map((dir) => ({ dir, mode: 'rx' as const })),
        ...zones.write.map((dir) => ({ dir, mode: 'full' as const })),
        { dir: path.dirname(getAppContainerRuntimePath()), mode: 'rx' as const },
    ];
    // A recursive revoke is expensive (node_modules can contain tens of thousands of entries). Only
    // walk paths whose successful grant marker proves this SID was actually installed there. Deleting
    // the profile still retires the SID if a crash happened in the tiny ACL-before-marker window.
    const touched = Array.from(new Map(candidates
        .filter(({ dir, mode }) => aclGrantIsCached(sid, dir, mode))
        .map(({ dir }) => [path.resolve(dir).toLowerCase(), path.resolve(dir)] as const)).values());
    const revoked = touched.length === 0 || await revokeAppContainerAccess(sid, touched);
    const deleted = await deleteAppContainerProfile(profile);
    return revoked && deleted;
}

module.exports = {
    ensureAppContainerProfile,
    deleteAppContainerProfile,
    grantAppContainerAccess,
    revokeAppContainerAccess,
    launchInAppContainer,
    probeAppContainer,
    getAppContainerState,
    getAppContainerSid,
    appContainerZones,
    retireAppContainerPlugin,
    ensureAppContainerRuntime,
    getAppContainerRuntimePath,
    ensureAppContainerRelayScript,
    // Extended Job Object caps (fork-bomb + CPU quota) for the NON-AppContainer Windows launch.
    applyWindowsJobCaps,
    probeWindowsJobCaps,
    // Constants the integration and the tests must not re-derive.
    APPCONTAINER_NODE_FLAGS,
    RSS_BUDGET_BYTES,
    PIDS_MAX,
    DEFAULT_PROFILE_NAME,
    appContainerProfileNameForRoot,
    appContainerProfileNameForPlugin,
    deriveAppContainerSid,
    defaultAppContainerProfileName,
    // Test seams: pure builders, so a test can assert the ASCII guard and the argv quoting without
    // creating an AppContainer profile or touching a single ACL.
    __buildRelayScript: buildRelayScript,
    __buildJobCapsScript: buildJobCapsScript,
    __buildProfileScript: buildProfileScript,
    __buildIcaclsScript: buildIcaclsScript,
    __aclCacheKey: appContainerAclCacheKey,
    __aclCacheRoot: appContainerAclCacheRoot,
    __buildCommandLine: buildCommandLine,
    __quoteWinArg: quoteWinArg,
    __probeChildSource: PROBE_CHILD_SOURCE,
};

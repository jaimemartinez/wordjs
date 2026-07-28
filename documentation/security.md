# WordJS Security Architecture 🛡️

WordJS implements a "Defense in Depth" security model for its plugin ecosystem, designed to protect the core system and sensitive data from malicious or poorly written extensions.

> **Status & honesty note.** WordJS is **pre-production** and primarily solo-maintained. The defenses
> documented here are implemented and tested, but the project has **not** had an independent security
> audit — one is **recommended before any production deployment**. `SECURITY.md` (repo root) is the
> disclosure / reporting policy and realistic-posture summary; this document is the deeper defenses
> reference. The plugin sandbox is the project's central thesis (see `POSITIONING.md`).

## 1. The Pillars of Defense

> **OS-process-isolated sandbox — every plugin, no exceptions.** A plugin marked `"isolated": true`
> (mandatory for all plugins) runs in a **separate OS process** (`child_process.fork`,
> `backend/src/core/plugin-isolate.ts` forks `plugin-worker.js`) — its own heap, event loop, and OS
> memory cap, so a crash, OOM, or heap escape is contained to the child and never reaches the host (a
> `worker_threads` Worker, by contrast, shared the host heap/rss; that transport remains only as a legacy
> fallback). The plugin reaches core ONLY through the permission-checked `wordjs` **capability bridge**,
> RPC'd over the IPC channel (structured-clone, `serialization: 'advanced'`) — it never touches the
> host's raw `fs` / `child_process` / `dbAsync` / secrets. The AST scanner (§1.1) and the runtime guards
> (§1.2) run **inside the child** as *belt-and-suspenders* around that boundary. **There is no "trusted"
> plugin tier and no bypass** — every plugin is sandboxed, and capabilities are admin-granted per plugin
> (default-deny). See §8 for the capability-grant model.

> **Themes run in the same isolate.** A theme's `functions.js` is **no longer executed in-process** on the
> host — it runs in a **child_process isolate** exactly like a plugin, via `loadIsolatedPlugin('theme:<slug>')`
> (`backend/src/core/theme-engine.ts` → `loadThemeLogic`), behind the **same** capability bridge and runtime
> guards, after the **same** Acorn AST pre-scan (a scan failure blocks the theme from loading). This closed
> the in-process-theme RCE cluster: host-side theme code had no runtime `eval`/`Function`/dynamic-`import`
> guard, so a malicious `functions.js` achieved host RCE that no static scan can fully prevent. Any
> hooks/shortcodes a theme registers flow through the same RPC bridge; theme-registered Handlebars helpers
> execute inside the theme's security context (`runWithContext('theme:<slug>', …)`) so the context-gated
> guards still fire against them.

### 1.1 AST Static Analysis (Pre-Activation)
Before a plugin is activated, its entire source code is parsed into an **Abstract Syntax Tree (AST)** using Acorn (`backend/src/core/plugins.ts → validatePluginPermissions`).

*   **Logic:** Unlike simple regex checks, the AST scanner "understands" the code structure.
*   **Detection:**
    *   **Obfuscation:** Detects dynamic property access like `global["ev" + "al"]()`.
    *   **Dangerous Functions:** Blocks `eval()`, `execSync()`, `spawn()`, etc.
    *   **Sensitive Globals:** Restricts reads of `process` (except `.env`), `global`/`globalThis`, `require`, `module`, `arguments`, and `__dirname`/`__filename`. (`Buffer` is intentionally **not** restricted — under OS-process isolation a plugin's `Buffer` only exposes its **own** process memory, and it's needed for legitimate crypto/binary work such as the mail-server's AES-GCM secret encryption.)
    *   **Module Hijacking:** Blocks `require()` of sensitive Node.js modules like `child_process`, `fs`, `http`/`https`, `net`, `dgram`, `dns`, `cluster`, `async_hooks`, `vm`, `worker_threads`, etc. (the `node:` prefix is normalized first).
*   **Fail-closed:** If a plugin file cannot be parsed, it is treated as a **violation** (never waved through).
*   **Enforcement:** Validation happens on every activation attempt and **on every server boot** (to prevent post-activation code poisoning).
*   **One install pipeline (uploads AND marketplace):** Plugin zips reach disk only through the shared guarded installer (`installPluginFromZip` in `backend/src/routes/plugins.ts`) — zip-bomb budget, Zip Slip path checks, slug validation, squat refusal, manifest validation, and the AST scan. The admin **Marketplace** tab (`backend/src/routes/marketplace.ts`) converges on the same pipeline: catalog zips are fetched server-side (https-only, size-capped, strict filename shape), **sha256-verified** against the catalog entry — **verification is now mandatory for any remote source** (a catalog entry that omits `sha256` is refused, fail-closed; local-dir sources are exempt) — then handed to `installPluginFromZip` — so a one-click install gets the exact same vetting as a manual upload. Themes install through the same sha256-mandatory remote path.

### 1.2 Runtime Context Proxies
WordJS uses `AsyncLocalStorage` to track the execution context of every request.

> **Detached Code is Still Sandboxed:** Plugin code that runs *outside* the `AsyncLocalStorage` wrapper — Express route handlers a plugin registers, synchronous hooks, timers (`setTimeout`/`setInterval`), and module top-level code — used to run with an empty context and was therefore treated as trusted core (a real RCE bypass). The runtime guards now resolve the active plugin via `getEffectivePlugin()`, which uses the `AsyncLocalStorage` context **or**, when absent, the nearest plugin/theme frame on the call stack. Synchronous hooks (`doActionSync`/`applyFiltersSync`) also run their callbacks inside the plugin context. As a result, detached plugin code remains subject to its manifest permissions.

*   **Environment Protection:** Global `process.env` is replaced with a **strict Read-Only Proxy**. 
    *   Plugins CANNOT read sensitive keys from the environment.
    *   Secrets (DB passwords, JWT keys) are loaded directly from `wordjs-config.json` by the core and never exposed to `process.env`.
    *   Plugins attempting to access secrets will receive `undefined`.

*   **Module Interception (`secure-require.ts`):** WordJS patches both `Module.prototype.require` **and** the lower-level `Module._load` (so obfuscation paths like `require('module').constructor._load(...)` are caught too), returning secured replacements for sensitive modules:
    *   **`fs` Proxy + io-guard:** Filesystem operations require `filesystem:read` / `filesystem:write` permission. Plugins may access their own directory freely; link/symlink creation is denied outright (TOCTOU + escape vector); any `fs` function not classified as read or write is **deny-by-default**. `io-guard.ts` additionally confines plugin fs to the plugin dir and **blocks** secret/config files (`.env*`, `wordjs-config.json`) and the live database files (`*.db`/`*.sqlite*` and the configured `dbPath`), which hold every credential, session token, and secret. A plugin **cannot read a sibling plugin's directory** (IO-1): the whole `plugins/` tree is intentionally **not** a broad read safe-zone (a sibling read = cross-plugin secret/data exfiltration, e.g. another plugin's encryption-key file). A plugin reads only its **own** dir (`plugins/<slug>` or `themes/<slug>`) plus the shared `uploads`/`data`/`themes`/`logs`/`os-tmp`/`node_modules`/`src` safe zones. `require()`/`import` resolution still works because reads of any `package.json` or anything under a `node_modules/` dir are allowed — **except** inside a sibling plugin's dir, which is denied (module resolution never legitimately reads a sibling's `package.json`/`node_modules`). The live-DB-file block is enforced **only in the isolated child** (`global.__WORDJS_ISOLATED__`), because on the host the bridge's own scoped DB driver legitimately opens `data/wordjs.db` under a plugin context. **Self-code-modification / scanner-evasion is blocked:** a plugin cannot create, rename, or copy a file into an **executable code extension** (`.js`/`.cjs`/`.mjs`/`.node`/`.wasm`, TS variants) anywhere it can write — its committed code is what the AST scanner vetted, so a fresh runtime `.js` (written directly, or written as `.txt` then renamed/copied) would run un-scanned. `copyFile`/`cp` and `link`/`symlink` are all patched (source read-checked **and** destination write-checked), so neither the raw DB nor a secret can be copied or hard-linked out of the safe zones. And `require()` is refused for any module resolved under a **writable data dir** (`uploads`/`data`/`os-tmp`/`logs`), so a payload dropped there can't be loaded even if it somehow existed. Raw writes are also **byte-metered** per plugin (single-write cap + a rolling append/stream growth quota) so a plugin can't fill the shared volume (`ENOSPC` DoS) via its own `fs`; the `fs.promises` path is metered against the same budget.
    *   **`child_process` Proxy:** Shell execution is **blocked for every plugin** — there is no capability or tier that unlocks it. (The `system:admin` shell escape was removed along with the trust tier.)
    *   **Network Trap (data-exfil / SSRF):** A separate OS process still has full Node net access, so raw `net`/`tls`/`http`/`https`/`http2`/`dns`/`dgram` modules are **blocked by default** and opened only when a plugin has been granted the **`network`** capability (admin opt-in, with an exfiltration warning — e.g. mail-server's SMTP/MX delivery). The binding-backed globals `fetch`/`WebSocket`/`EventSource` are not reachable through the module loader, so they are trapped directly on `globalThis` for plugins without the `network` grant as well. ESM `import()` is also gated (the CommonJS `require` proxy doesn't cover it): a module-resolution hook rejects the same sensitive builtins, and the worker **fails closed** (refuses to run) if no hook API is available (Node ≥ 18.19 required to run plugins).
    *   **Public-destinations-only egress (`egress-guard.ts`):** A plugin that *has* been granted `network` is still confined to **public** destinations. The egress guard blocks loopback (`127.0.0.0/8`, `::1`), link-local **including `169.254.169.254` cloud-metadata** (`169.254.0.0/16`, `fe80::/10`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), IPv6 ULA (`fc00::/7`), the unspecified/`0.0.0.0` and multicast/reserved ranges, and IPv4-mapped-IPv6 — and **fails closed** on a garbage or unresolvable host. Validation happens **at connect time against the actual resolved IP** (anti-DNS-rebinding) by injecting a validating `lookup` into every connect path across `net`/`tls`/`http`/`https`/`http2`/`dgram` plus the global `fetch`/`WebSocket`/`EventSource`. **IPC / unix-socket / named-pipe targets** (e.g. `/var/run/docker.sock`, the connect `path` option) are **denied outright** — they are a container/host RCE vector, not public egress. The single chokepoint is `net.Socket.prototype.connect`, patched **inside the isolated child** and **locked** (`Object.defineProperty` `writable:false, configurable:false`) so a plugin cannot reassign or un-patch it; it also covers the `net.Stream` alias, the `Object.getPrototypeOf(Socket.prototype).connect` bypass, custom http(s) agents/`createConnection`, and the pre-normalized `[options, cb]` arg array. It is **TOCTOU-hardened**: the connect options `host`/`hostname`/`path` are snapshot once into primitives, validated, then redefined as own frozen data-properties so a malicious getter cannot return a benign value to the check and a private one to Node's later re-read. For global `fetch`, redirects are followed **natively** by `fetch` (which correctly strips `Authorization`/`Cookie` on cross-origin hops) and **each hop's connect is IP-validated at the socket layer** by the prototype patch — the `guardedFetch` wrapper just fast-fails on an obviously blocked initial host; the connect patch is authoritative. If `egress-guard` cannot load, the network globals are **blocked entirely** (fail-closed).
    *   **Core outgoing webhooks are SSRF-guarded too:** the same egress posture applies to *core* outbound requests, not just plugin `network` grants. WordJS's outgoing webhooks (`/admin/webhooks`, fired on content events like `post.published`) are **HMAC-signed** and **SSRF-hardened** in `backend/src/core/webhooks.ts` — deliveries to loopback / cloud-metadata / RFC1918 destinations are rejected, validated against the resolved IP **at delivery time**.
    *   **Native-binding lockdown:** `process.binding`/`_linkedBinding` throw for plugin contexts and `.node` addons are refused (`process.dlopen` is also blocked for all plugins — a `.node` addon runs outside every JS-level guard, so no trust tier unlocks it). `process.getBuiltinModule(id)` (Node ≥ 22.3) — a direct C++-backed accessor that hands back a builtin **without** routing through `Module._load` / `Module.prototype.require` / the ESM loader — is likewise re-routed through the same per-plugin module policy (secure `fs`/`child_process` proxy, inert blocked proxy for `net`/`vm`/`worker_threads`/…), so it can't be used to fetch an unguarded builtin.
    *   **Native-backed builtins that sidestep the `fs` proxy are blocked outright:** the module blocklists (`secure-require.ts` and the isolate's ESM `import()` hook) are keyed by name, so a C++-backed builtin that never routes through the `fs`/`require` proxies is an escape unless it is on the list. **`node:sqlite`** — `DatabaseSync` opens/creates arbitrary files by native code (reading the core credential DB, writing host payloads) and `loadExtension()` maps a native addon (host RCE via a loader separate from `process.dlopen`) — and **`node:wasi`** — a WASI `preopen` maps a host directory into a WASM instance whose native `fd_read`/`fd_write`/`path_open` bypass the guard — are therefore both blocked for plugins, on the CommonJS require path **and** the ESM `import()` path. `process.report.getReport()`/`getReportSync()` are blocked too (alongside `writeReport()`): the report's `environmentVariables` is the full host `process.env`, an env-secret leak for any code running in the host process.
    *   **Obfuscation-Immune:** Because enforcement happens at runtime (not just static analysis), even obfuscated code like `fs["read" + "FileSync"]()` is blocked.

*   **Secret & Core-Module Scrubbing:** A plugin that `require()`s a core module could capture the real `fs`/secrets it closed over. So plugins are **denied** sensitive core modules; `config/app` is handed back as a read-only Proxy with credential-like fields (`*secret*`, `*password*`, `*key*`, `*token*`, …) stripped; and the `config/database` `dbAsync` is replaced with a **table-scoped** view. That in-process view now delegates to the **same** lexer-based guard (`assertSqlAllowed`, `backend/src/core/plugin-api.ts`) as the RPC bridge, so the two DB surfaces cannot diverge — an earlier regex-only in-process guard was evadable with SQL comments/quotes (`FROM/**/users`) and applied no cross-plugin prefix restriction. That scoping is **default-deny by prefix and applies to every plugin**: every table a query touches must be one the plugin OWNS under its `wjp_<slug>_` prefix, so it can't read another plugin's tables or any core table — backed by an explicit denylist of core tables (`users`, `user_meta`, `options`, `roles`, `sessions`, …) and rejection of `ATTACH`/`DETACH`/`PRAGMA`, schema catalogs (`sqlite_master`/`information_schema`/`pg_catalog`), file/extension SQL functions (`readfile`/`writefile`/`load_extension`/`pg_read_file`/…), stacked statements, comma cross-joins, and `RETURNING`; a Postgres `DELETE … USING <table>` target is prefix-attributed like `FROM`/`JOIN`. The fail-closed table attribution also rejects `ON CONFLICT … DO UPDATE` upserts (plugins use UPDATE-then-INSERT instead), and the scoped view exposes only `get`/`all`/`run` — **no `transaction()`**. There is no "unscoped DB" capability for any plugin. Plugins that need user or site data use the **safe bridges** `wordjs.users.*` (a projection that never includes `user_pass`, gated on `users:read`) and `wordjs.site.*` (gated on `settings:read`) instead.

*   **API Sandboxing (capability bridge):** The `wordjs` object passed to a plugin's `init(api)` (`backend/src/core/plugin-api.ts`) is the *only* sanctioned path to core, and inside an isolated plugin those calls are RPC'd to the host over IPC. The host dispatcher (`callApi` in `plugin-isolate.ts`) enforces an **exact method allowlist** — a malicious child cannot walk an arbitrary dotted path on the api object — and registration / mail-provider / notify-transport / route all flow only through their own dedicated IPC kinds (default-deny). Every method then enforces the plugin's capability grant (`verifyPermission` = manifest-declared **AND** admin-granted, default-deny) **and** constrains arguments host-side: option-key allowlists, SQL table-scoping, and path confinement to the plugin's own dir + uploads. **No plugin skips the option/table scoping** — these constraints are unconditional now that the trusted tier is gone.

*   **DoS containment (host-side):** Beyond the layered memory caps (§4), the host bounds a misbehaving child: a per-child bridge-call **token-bucket rate limit** + concurrency cap, a global **IPC message-rate cap**, inbound/outbound RPC **payload size caps**, an `fs.write` size limit + per-plugin disk quota, an admin-menu cap, hook/route/shortcode **registration caps** (incl. per-hook-name), and a 30s **RPC timeout** that recycles a wedged child. Repeated abuse `SIGKILL`s and tears the child down.

### 1.3 CrashGuard v2.0 (Anti-Boot Loop)
WordJS includes a sophisticated system to prevent a single buggy or malicious plugin from taking down the entire server.

*   **The 3-Strike Rule:** To avoid "false positives" (like a power outage during plugin load), CrashGuard uses a strike system.
    1.  **Strike 1 & 2:** If the server crashes during plugin initialization, CrashGuard logs a warning and retries on next boot.
    2.  **Strike 3:** If the plugin consistently crashes the server 3 times, it is **automatically disabled**, and a critical alert is sent to the admin panel.
*   **Runtime Blame System:** If an asynchronous error (like an unhandled promise rejection or a `setTimeout` crash) occurs outside of a request, CrashGuard analyzes the stack trace. If the error originated from a plugin, that plugin is identified ("blamed") and disabled on the next restart to prevent a crash loop.

### 1.4 Mandatory Permission Authorization
Plugins must explicitly declare their requirements in `manifest.json`.

*   **Transparency:** Administrators are presented with a clear "Authorization Modal" before activation.
*   **Least Privilege:** Plugins only get what they ask for (and what the admin approves).

---

## 2. Forbidden Patterns & Developer Rules

To pass the AST scanner, your plugin code must follow these rules:

1.  **No Dynamic Requires:** Use `require('name')` with string literals only. `require(path.join(...))` is blocked.
2.  **No Global Pollution:** Accessing or modifying `global` properties is prohibited.
3.  **Use core APIs:** Instead of `fs.writeFile`, use the WordJS APIs or declare `filesystem` permissions.
4.  **No Shell Execution:** `child_process` is strictly forbidden to prevent RCE (Remote Code Execution).

---

## 3. Dealing with Security Blocks

If your plugin fails validation, you will receive a detailed error:
`🛡️ Security Block: Plugin 'name' failed validation: Blocked dangerous calls detected: eval, Direct 'global' access...`

To fix this:
1.  Check the `manifest.json` permissions.
2.  Remove any obfuscated or prohibited code patterns.
3.  Use official WordJS hooks/filters instead of direct global manipulation.

---

## 4. Current Limitations (Threat Model)

WordJS provides a high level of isolation, but it is not a virtual machine, and it has **not** had an independent security audit.
*   **Vulnerability Scoping:** The AST scanner focuses on the plugin's own source code, not its `node_modules`.
*   **Runtime code generation (opt-in backstop):** The install-time AST scanner only sees *statically-visible* `eval`/`new Function(string)`, not code assembled at runtime or inside an unscanned dependency. An **opt-in** `config.sandbox.blockCodeGen` starts the isolated child with V8's `--disallow-code-generation-from-strings`, hard-blocking runtime `eval`/`new Function(string)` as a belt-and-suspenders layer under the scanner. It is default off (some plugin deps legitimately use `Function()`) and force-disabled under `ts-node`, so it only bites a **compiled prod worker**.
*   **Resource Limits (memory, layered):** Because each plugin is a *separate OS process*, its memory is the child's own rss — bounded in layers rather than by a single Worker `resourceLimits`: (a) an **opt-in preventive cgroup v2** `memory.max` via `systemd-run --user --scope` (`config.sandbox.useCgroupMemoryCap=true`, probe-gated, no root) that has the kernel OOM-kill only the offending child at the resident budget (768 MB); (b) a **default-on preventive Windows Job Object** (`JOB_OBJECT_LIMIT_PROCESS_MEMORY` = 768 MB, assigned to the forked child by a one-shot PowerShell P/Invoke — pure-JS, no native dep — probe-gated; opt out via `config.sandbox.useJobObjectMemoryCap=false`) so the kernel fails any over-budget commit; (c) a **reactive host-side RSS poll** on every platform (Linux `/proc`, Windows `tasklist`, macOS `ps`) that `SIGKILL`s the child over 768 MB; (d) a **loose `RLIMIT_AS` virtual backstop** (`ulimit -v`, `config.sandbox.addressSpaceCapMb`, default 16384 MB — kept generous because V8's pointer-compression cage reserves ~4 GB virtual) plus `--max-old-space-size=256` for the JS heap; and (e) **anti-exhaustion caps** — a **file-descriptor cap** (`RLIMIT_NOFILE` = 4096) on the rlimit launch path and a **task/PID cap** (cgroup `TasksMax` = 512) on the systemd-scope path, so a plugin can't drain the host's fd or task tables (fork/thread-bomb). An **opt-in** per-plugin **CPU quota** now ships (`config.sandbox.cpuQuotaPercent`, applied as `CPUQuota=N%` of one core in the same systemd `--user` scope as the cgroup memory cap, so it only bites when `useCgroupMemoryCap` is also on); it defaults to `0` (off), so **by default** a plugin can still burn CPU (DoS) until you enable it.
*   **Runtime Escapes:** Low-level escapes are blocked at runtime *inside the child* — `Module._load` is intercepted like `Module.prototype.require`, `process.binding`/`_linkedBinding` throw, `.node` native addons are refused, ESM `import()` of sensitive builtins is rejected (fail-closed), the native-backed builtins `node:sqlite` (arbitrary file I/O + `loadExtension` native-addon RCE) and `node:wasi` (host-dir `preopen` → native WASM file I/O) are blocked, `process.report.getReport()` (host-env leak) is blocked, and deferred plugin code (`setTimeout`/`setInterval`, EventEmitter listeners, top-level/detached callbacks) is re-anchored to the plugin context via `getEffectivePlugin()` so it cannot shed its sandbox. (`process.dlopen` is also blocked for all plugins — loading a native addon is a direct sandbox escape, so no trust tier unlocks it.) For a `network`-granted plugin, SSRF/exfiltration is contained by the connect-time public-IP egress guard (§1.2): even a DNS-rebinding or redirect-to-private attempt is validated against the *actual resolved IP* at the locked `net.Socket.prototype.connect` chokepoint inside the child.
*   **Syscall surface / kernel hardening (default-on, opt-out):** A **default-on** Linux layer (`config.sandbox.useKernelHardening`, opt out with `=false`; via `bubblewrap`, probe-validated per host — falls back to plain fork isolation on a host lacking `bwrap` / unprivileged user-namespaces; a no-op on Windows/macOS) launches each isolated child as an **unprivileged uid (nobody) with all Linux capabilities dropped, `no-new-privs`, PID/IPC/UTS namespaces, and a read-only filesystem** (the app root stays writable so plugin storage keeps working; network is preserved and still egress-guarded; the resident RSS poll sums the bwrap subtree so the memory cap keeps biting). It composes with the cgroup/rlimit memory cap and is fail-safe — any probe failure falls back to the standard isolated launch (zero regression). By default a probe failure degrades to the JS-guards-only launch, but you can set `config.sandbox.requireHardening=true` to **fail closed** — a plugin is then refused unless the bwrap/seccomp backstop is actually ACTIVE. The live hardening state (`active` / `degraded` / `disabled` / `unsupported`) is reported on admin `GET /health/details`. It also applies a **`seccomp`-bpf syscall DENYLIST** (assembled in pure JS, no native dep, via `bwrap --seccomp`): `ptrace`, `mount`/`umount2`/`pivot_root`, `kexec_*`, `*_module`, `bpf`, `keyctl`/`add_key`/`request_key`, `userfaultfd`, `setns`, `process_vm_readv`/`writev`, `perf_event_open`, `reboot`, `open_by_handle_at`, … → `EPERM` (syscalls a Node app/web plugin never issues but that are escape/kernel-manipulation primitives). The probe boots Node UNDER the filter to prove it doesn't break plugins. Validate it on a host with `node backend/scripts/verify-sandbox-hardening.js`. The **`Landlock` LSM** is intentionally **not** used — its filesystem-confinement goal is already met by the read-only mount namespace above, and the LSM itself would need a native dependency contrary to this sandbox's no-native-deps design. **Trade-off:** the uid-drop means a plugin **cannot bind a privileged port (`<1024`)** under hardening (e.g. the mail-server on port 25 — its default `2525` is unaffected). A *preventive* memory cap on Windows now **ships** as a Job Object (`ProcessMemoryLimit`, default-on, probe-gated, pure-JS PowerShell P/Invoke — see §4); the reactive `tasklist` RSS poll remains as a backstop for the brief post-fork assign window.
*   **CSP — present, but not an XSS backstop:** A Content-Security-Policy **is** now served on every browser-facing route by the Next frontend (`frontend/next.config.ts` `headers()`), not the gateway (the gateway still runs `helmet({ contentSecurityPolicy: false })` for the API/proxy layer, `gateway/src/index.js`). The honest caveat: `script-src` deliberately keeps `'unsafe-inline' 'unsafe-eval' blob: https:` — Next.js inline bootstrap, the Puck editor's `eval`/`Function`, plugin admin bundles loaded via `import(URL.createObjectURL(blob))` (`lib/pluginBundleLoader.ts`), and theme assets in the Puck `srcdoc` iframe all require it — so `script-src` is **not** an XSS defense. The structural value is `frame-ancestors 'self'`, `object-src 'none'`, and `base-uri 'self'`; the XSS control remains the server-side sanitizer in `lib/sanitize.ts` (see §10).
*   **CSRF:** Protection is **origin-based with exact matching** (Origin/Referer + a gateway-pinned `X-Forwarded-Host`, see §9), not per-request CSRF tokens. It now **fails closed** when both Origin and Referer are absent (a header-less cookie-authenticated request is rejected; only a `Bearer`-token caller passes — see §9). Token-based CSRF is future work.

For ultra-high security environments, audit third-party plugin dependencies before installation, run an independent security review, and complete the §7 production checklist (rotate all secrets, set a strong `gatewaySecret`).

---

## 5. Permission Reference 📚

These are the valid scopes and access levels you can declare in `manifest.json`.

| Scope               | Access  | Description                                                 |
| :------------------ | :------ | :---------------------------------------------------------- |
| **`database`**      | `read`  | Allows reading from the plugin's own `wjp_<slug>_` tables using `dbAsync`. |
|                     | `write` | Allows INSERT/UPDATE/DELETE **and** `createTable` on the plugin's own tables. (There is no `database:admin` / unscoped tier — core tables are always refused.) |
| **`settings`**      | `read`  | Can read site options via `getOption()`.                    |
|                     | `write` | Can modify site options via `updateOption()`.               |
| **`filesystem`**    | `read`  | Read files (e.g., templates, assets) using `fs` or `path`.  |
|                     | `write` | Write files to disk (Use cautiously).                       |
| **`network`**       | (grant) | Outbound HTTP/sockets to **public destinations only**. **Blocked by default** (raw `net`/`http`/… and `fetch`/`WebSocket` are trapped); opened only when an admin **grants** the `network` capability (with an exfiltration warning). Even when granted, the egress guard (§1.2) blocks loopback/metadata/private/CGNAT/ULA targets and unix sockets, validated at connect time. |
| **`email`**         | `admin` | Allows `wordjs.mail(...)` (send via the registered provider) and admin mail operations. Still sandboxed — raw SMTP requires the `network` grant. |
|                     | `provider` | Allows registering the host-wide mail provider (`wordjs.provideMail`). |
| **`notifications`** | `send` / `provider` | `send` allows dispatching alerts via `wordjs.notify`; the `notifications:provider` grant allows registering a notification transport. |
| **`users`**         | `read`  | Allows the safe-projection user bridges (`wordjs.users.findByEmail/findByLogin/findById/search`). Never exposes `user_pass` or core tables. |
| **`express`**       | `register_route` | Register HTTP routes (mounted host-side under `/api/v1/plugin/<slug>`). |
| **`admin_menu`**    | `register` | Add an item to the admin sidebar via `wordjs.adminMenu.add`. |
| **`assets`**        | `write` | Enqueue front-end scripts/styles via `wordjs.assets.enqueueScript`/`enqueueStyle`. |

> **Capabilities are admin-granted per plugin (default-deny).** A manifest only **requests** a
> capability; it can never be the sole basis for one. A bridge call works only if the capability is
> BOTH declared in the manifest AND **granted by an admin** in `/admin/plugins`
> (`backend/src/core/plugin-permissions.ts`, persisted in the `plugin_grants` option). See §8. There is
> **no "trusted" tier and no bypass** — every plugin (first-party included) goes through the full AST
> scan and the same grant checks. The genuinely dangerous raw capabilities — shell/`child_process`,
> native addons, unscoped/core-table DB, secret-named options, raw cookie/header control, raw-HTML
> hooks — were **removed entirely**: no plugin can be granted them, by any means.

### Example Manifest declaration:

```json
"permissions": [
    { "scope": "database", "access": "write", "reason": "Storing poll results" },
    { "scope": "notifications", "access": "send", "reason": "Alerting admin on new votes" }
]
```

---

---

## 6. Internal Cluster Security (mTLS) 🔒

WordJS uses a **Mutual TLS (mTLS)** architecture to secure communication between internal components (Gateway, Backend, Frontend). This applies in every run mode: **monolith** (all three in one process), **split** (all three on one host), and **separate** (each on a different machine — see §6.4 and **[Separate mode](separate-mode.md)**).

### 6.1 Gateway as Certificate Authority
The Gateway acts as the master of the mTLS infrastructure:
*   **Location:** The master certificates, including the **Cluster Root CA key**, are stored in `gateway/certs/`.
*   **Isolation:** The private key of the CA NEVER leaves the Gateway folder (written `0600`).
*   **CA minting:** `node scripts/cluster.js init` (`gateway/src/cluster-ca.js`) mints the cluster CA, the gateway's own `gateway-internal` identity, and the gateway's **public** cert — which is now **also signed by the cluster CA** (so a frontend on another host validates the gateway's public origin from the same trust root via `NODE_EXTRA_CA_CERTS`). It writes a multi-node `gateway-config.json` (routable `gatewayInternalBind`, ports) and clears the registry.
*   **Identity Provisioning:** the Backend and Frontend each receive a unique per-node identity signed by the CA — on one host during setup, or, in separate mode, via the token-enrollment flow in §6.4.

### 6.2 Selective Distribution (Least Privilege)
To prevent lateral movement if a service is compromised, certificates are distributed selectively:
*   **Backend:** Receives `backend.crt`, `backend.key`, and `cluster-ca.crt`.
*   **Frontend:** Receives `frontend.crt`, `frontend.key`, and `cluster-ca.crt`.
*   **Gateway:** Receives ALL files (as it is the master) but only uses `gateway-internal` for identity.

### 6.3 Secure Control Plane
The Backend manages the Gateway via a dedicated **Internal API** (Port `gatewayInternalPort`, default 3100). This API:
*   Requires a valid `backend` mTLS certificate to connect (the `/register` listener requests and verifies a client cert whose CN is in `{backend, frontend}`).
*   Allows the Backend to push new public SSL certificates (from Let's Encrypt) to the Gateway without direct filesystem access.
*   Allows remote configuration of the Gateway without restarting the main OS process.

### 6.4 Join-token enrollment (separate mode) 🎟️
When the three services run on **different machines**, hand-copying certs is error-prone, so a node bootstraps its mTLS identity with a **join token**, `kubeadm join`-style (`scripts/cluster.js`, `scripts/node-join.js`, `gateway/src/cluster-ca.js`):
*   **Mint (gateway):** `node scripts/cluster.js token <backend|frontend>` mints a **single-use, role-bound, TTL** token (default 60 min) and prints the exact `node-join` command, including the gateway address, enroll port, token, and CA fingerprint (`--ca-hash`).
*   **Enroll (new machine):** `node scripts/node-join.js --role … --gateway … --token … --ca-hash … --advertise …` generates a keypair + CSR (`openssl`) and makes **one** `POST /enroll` call to the gateway's **token-enrollment listener** — a **separate** HTTPS listener on `gatewayEnrollPort` (default 3101) that **does NOT request a client cert** (the strict-mTLS `/register` listener in §6.3 is unchanged). It is rate-limited and never exposed to the public internet.
*   **Sign (gateway):** the gateway `consume`s the token (validating role + TTL + single-use), then signs the CSR while **forcing `CN=<role>` from the token — the CSR's subject is ignored** — so a node can never mint itself a different identity. It returns `{ cert, ca (cluster CA), config (bootstrap: gatewaySecret + ports + siteUrl) }`.
*   **Verify + start:** `node-join` verifies the returned CA against `--ca-hash` (MITM guard), writes `<role>/certs/*` + `<role>/wordjs-config.json`, and starts the service, which then **registers over mTLS** on `/register`. The token is burned after that first call; everything afterward is mTLS.

Config keys: `advertiseHost`, `gatewayHost`, `gatewayInternalBind`, `gatewayEnrollPort`, `internalApiUrl` (the frontend's SSR base = the gateway's public origin, trusted via `NODE_EXTRA_CA_CERTS`), `gatewaySecret`. Manage tokens with `node scripts/cluster.js tokens` / `revoke-tokens` / `info`. Full walkthrough: **[Separate mode](separate-mode.md)**.

---

## 7. Production Security Checklist ✅

Before deploying WordJS to production, ensure the following:

### JWT Secret (CRITICAL)

The installer automatically generates cryptographically secure secrets in `wordjs-config.json`.
You can verify them by checking the file:

```json
"jwtSecret": "a4f... (long random string)"
"gatewaySecret": "b9c... (long random string)"
```

The signing secret **never** falls back to a hardcoded/public constant. If no secret is configured (e.g. before setup completes), the backend uses a per-process ephemeral random secret so issued tokens cannot be forged — but those tokens reset on every restart. Complete setup so a persistent secret is written to `wordjs-config.json` for production. `jwt.verify` is also pinned to the `HS256` algorithm, and passwords are hashed with bcrypt at cost factor 12.

**Session revocation & login throttling** (stateless JWT, so these add the server-side state JWTs lack):
*   **Revocation:** Logout and password change stamp a per-user `token_valid_after` epoch; the auth middleware rejects any token whose `iat` predates it (including in `optionalAuth`, which treats a revoked token as anonymous). A stolen token stops working after logout / password reset rather than living until expiry.
*   **Per-account lockout:** After **10** consecutive failed logins, an account is locked for **15 minutes** — this throttles a distributed/botnet attack that the per-IP rate limiter alone does not stop. The counter is backed by the **shared rate-limit store** (the same `cache.getClient()` Redis client the IP limiters use), keyed by the normalized username, so the throttle holds across multiple replicas; an in-memory `Map` is the single-node path and the always-on fallback. Any Redis error (or no client configured) degrades to in-process — a Redis outage **never** blocks login (fail-safe, mirroring the limiter's pass-on-store-error philosophy).

**Access-control hardening** (`backend/src/routes/users.ts`):
*   **Administrator-edit guard (AUTH-1):** a non-administrator cannot edit an administrator account (editing mutates email + password, so without this an `edit_users` delegate could seize an admin).
*   **No self-role change:** a user cannot change their **own** role (otherwise a `promote_users` holder could self-promote).
*   **Privilege-amplification guard (AUTH-A1):** a delegated `promote_users` holder cannot assign the `administrator` role **nor** any custom role that grants `*` (all-caps) or a capability the caller does not themselves hold — so a non-admin cannot mint a fully-privileged account. The requested role is validated against the known roles allowlist (no mass-assignment of a bogus role); only an administrator may assign `administrator`.
*   **Notification IDOR (REG-1):** `markAsRead`/`delete` are scoped `WHERE uuid = ? AND (user_id = ? OR user_id = 0)`, so a caller can act only on their own notifications while broadcasts (`user_id = 0`) stay dismissable by any user.

### Two-Factor Authentication (TOTP)

Recommended for any account with elevated capabilities. WordJS ships **TOTP two-factor auth** (`backend/src/core/mfa.ts` + `core/totp.ts`):
*   **Enrolment:** a user calls `POST /auth/mfa/setup` (returns the shared secret / QR), confirms a code to `POST /auth/mfa/enable`, and can `POST /auth/mfa/disable` or check `GET /auth/mfa/status`. Self-service UI at `/admin/account`.
*   **Login challenge:** when a 2FA-enabled account authenticates, login completes only after `POST /auth/mfa` verifies a TOTP or one-time **backup code** (`POST /auth/mfa/backup-codes` regenerates them).
*   **Admin-enforced MFA-by-role policy:** an administrator can *require* MFA for chosen roles via `GET`/`PUT /auth/mfa/policy` (edited in the Security Center). A global `mfaComplianceGate` then blocks a user who is subject to the policy but has not yet enrolled, until they set up 2FA.

### Scoped API Tokens

For headless / machine clients that cannot carry the browser cookie, WordJS issues **scoped personal access tokens** (`backend/src/models/ApiToken.ts`):
*   **Format:** `Authorization: Bearer wjt_<secret>`; the secret is shown **once** at creation and stored only as a **sha256** hash at rest.
*   **Scopes:** global `read`/`write`/`*` plus **per-resource** scopes (e.g. `posts:write`, `media:read`). The effective permission is the **intersection** of the token's scopes and the owning user's capabilities (a token can never exceed its user).
*   **Management:** `GET`/`POST`/`DELETE /auth/tokens` (list / mint / revoke), with a self-service UI at `/admin/tokens`.
*   **CSRF:** the `Bearer wjt_…` path is the sanctioned non-browser API-caller path referenced by the fail-closed CSRF rule in §9 — it carries no ambient cookie, so it is exempt from the Origin/Referer check.

### Configuration (No Env Vars)

WordJS does **not** use `.env` files. All security settings are in `wordjs-config.json`.

| Setting         | Required | Description                                                        |
| --------------- | -------- | ------------------------------------------------------------------ |
| `jwtSecret`     | ✅ Yes    | Token signing key (64+ random bytes). **Rotate before production.** |
| `nodeEnv`       | ✅ Yes    | Set to `production`                                                 |
| `gatewaySecret` | ✅ Yes    | Gateway management auth. **Must be strong and rotated** — the shipped public default is rejected, so management endpoints return 503 until you set a real one. |
| `db.password`   | If PG    | Database password. **Rotate before production.**                   |

> **Operator action (required):** rotate `jwtSecret`, `gatewaySecret`, and `db.password` away from any
> value that was ever committed or shared, and set a strong `gatewaySecret`. The installer generates
> fresh secrets, but if you cloned/seeded a config you must rotate them yourself.

### XSS Protection (isomorphic)

User-generated HTML is sanitized via a single `sanitizeHTML()` that works on **both** sides of the render (`frontend/src/lib/sanitize.ts`):

*   **Browser:** DOMPurify with a strict tag/attribute allowlist (`on*` handlers and `<script>`/`<object>`/etc. are dropped).
*   **Server (SSR):** `sanitize-html` with a mirrored allowlist, so the **initial** server-rendered HTML is already safe *before* hydration (returning raw HTML there used to be an XSS window). Both paths **fail closed** (strip all tags) if the sanitizer is unavailable.

```typescript
import { sanitizeHTML } from '@/lib/sanitize';

// Safe rendering — same call works in SSR and in the browser.
<div dangerouslySetInnerHTML={{ __html: sanitizeHTML(content) }} />
```

**Puck page-tree sanitizer (server-side, every write path).** The Puck visual-builder page tree (`_puck_data`) is stored verbatim in post meta and rendered as HTML on many independent public sites, so it is sanitized on **every write** by the shared module `backend/src/core/sanitize-meta.ts` (used by **both** `routes/posts.ts` and the WXR importer `core/wxr-import.ts`, so neither path bypasses it). It walks the tree and sanitizes string leaves: HTML-bearing fields (`content`/`html`/`text`/`title`/`heading`/`description`/`caption`/`body`) through the post-body `sanitize-html` allowlist; and — crucially — **every other** string leaf runs through `safePuckUrl`, a **value-based** (not key-name) check that blanks only values starting with `javascript:`/`data:`/`vbscript:`/`file:` (after stripping control-char obfuscation) and leaves labels/classes/colors/relative paths/fragments untouched. This closes stored XSS via URL props that are **not** in any key allowlist (e.g. `CTABanner`/`PricingTable` `buttonLink`, XSS-01). `_puck_data` arriving as a JSON **string** is now parsed → sanitized → re-stringified (previously object-only — a bypass, XSS-02).

**Menu item URL scheme validation (XSS-03).** Menu item URLs are scheme-validated on **both** create and update (`safeMenuUrl` in `backend/src/routes/menus.ts`). Only safe targets pass: relative paths, in-page fragments (`#…`), query strings (`?…`), and absolute `http`/`https`/`mailto`/`tel` URLs. Disallowed schemes (`javascript:`/`data:`/`vbscript:`/…) or unparseable values are neutralized to `'#'`. A protocol-relative `//host` URL is explicitly treated as an **external** navigation (open-redirect in the nav) and also neutralized to `'#'` — it is **not** accepted as a relative path. Menu urls render site-wide as `<a href>`, so this is stored-XSS / open-redirect prevention.

**SQL identifier allowlist on `custom_tables` import (SQLI-01).** The `custom_tables` import path (`backend/src/core/import-export.ts`) validates every table **and** column name against a strict simple-identifier regex (`^[A-Za-z_][A-Za-z0-9_]*$`) before interpolation, refuses the protected **core** tables (`users`, `posts`, `options`, …), and refuses SQLite reserved tables (names starting with `sqlite_`). Without this, an import could write arbitrary rows into a core table (e.g. a backdoor admin in `users`) or inject SQL fragments via identifier names; dotted/schema-qualified names, comments, and SQL fragments are rejected.

### Path Traversal Prevention

All plugin and theme slugs are validated before filesystem operations:

```javascript
function validateSlug(slug) {
    // Only alphanumeric, dashes, underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) return false;
    
    // Ensure path stays within allowed directory
    const safePath = path.resolve(PLUGINS_DIR, slug);
    return safePath.startsWith(path.resolve(PLUGINS_DIR));
}
```

### Command Injection Prevention

All shell commands use `execFile` instead of `exec`:

```javascript
// ❌ Vulnerable
exec(`node "${scriptPath}"`);

// ✅ Safe
execFile('node', [scriptPath]);
```

In particular, plugin dependency installation passes package names to `execFile` as an argument array (not a shell string), so a malicious manifest dependency name cannot inject shell commands.

> **CORS:** In production, the backend allows only the configured origins (site / frontend / gateway) rather than reflecting arbitrary origins with credentials.

### Additional Recommendations

1. **HTTPS**: Always use SSL/TLS in production (via Nginx or Caddy)
2. **Rate Limiting**: The Gateway includes rate limiting by default
3. **Firewall**: Only expose port 3000 (or 80/443)
4. **Backups**: Configure automatic backups. Backups are stored **on-host** in `backend/backups/` and are **retention-pruned** after each run — only the newest N are kept (the `backup_retention` option, default `7`; set `0` to keep all), so scheduled backups can't fill the disk. Off-host / S3 storage is roadmap, so copy backups off the box for disaster recovery.
5. **Metrics endpoint**: The Prometheus `GET /metrics` endpoint is **disabled by default** and returns `404` unless you set a scrape token (`config.metrics.token` or the `METRICS_TOKEN` env var). When enabled, scrape it only over a trusted network with `Authorization: Bearer <token>`; never expose it without a token.
6. **Install token (pre-install takeover)**: Before the instance is installed, the `/setup/install` and `/setup/test-db` endpoints are gated by a **one-time install token** (`backend/src/core/install-token.ts`). It is generated at boot when the instance is not yet installed, **printed to the server console**, and **mirrored to a `0600` file** in the data dir (`data/install-token`) for headless/Docker reads. An operator may supply their own via the `WORDJS_INSTALL_TOKEN` env var, but a value **under 16 chars is ignored** (with a warning) and a random token used instead — an entropy floor so a short/guessable value can't reduce the takeover gate to a brute-forceable secret. The token is checked **constant-time**, held in memory (fail-closed if not generated), and the on-disk mirror is removed once installed.
7. **Updates**: Keep Node.js and dependencies updated

---

## 8. Plugin Capability Model (Android-style grants — no trust tier)

There is **one** plugin model: every plugin is sandboxed, and each capability is **admin-granted per plugin** with **default-deny** (`backend/src/core/plugin-permissions.ts`). The old binary trusted/untrusted split — and all of its bypass machinery (`plugin-trust.ts`, `config.trustedSystemPlugins`, the `__WORDJS_PLUGIN_TRUSTED__` child flag, the `system:admin` scan-skip, and the admin trust toggle) — has been **removed**. No plugin is privileged; first-party plugins are merely **pre-granted** the capabilities they declare, and they run under the exact same sandbox and grant checks as anything uploaded.

**How it works:** a plugin's `manifest.json` **requests** capabilities; an admin **grants** each one per plugin via toggles in `/admin/plugins` (`POST /plugins/:slug/permissions`, persisted in the `plugin_grants` option, mirrored in memory so the bridge gates read it synchronously). A bridge call succeeds only if the capability is BOTH declared in the manifest AND granted (`verifyPermission`); `:admin` access implies read+write.

**These constraints apply to every plugin, unconditionally:**

| Surface | Rule (all plugins) |
| :-- | :-- |
| DB | own `wjp_<slug>_` tables only; raw SQL on core tables refused. No unscoped tier exists. |
| User / site data | via the safe bridges `wordjs.users.*` (`users:read`; projection only, never `user_pass`) and `wordjs.site.*` (`settings:read`). |
| Options | non-secret keys only; secret-named options are never exposed. |
| Routes | always namespaced under `/api/v1/plugin/<slug>`. Absolute paths were removed. |
| Route I/O | host auth cookie `wordjs_token` (+ csrf/session) stripped from the forwarded request; `Set-Cookie`/`CSP`/`HSTS`/`Location` stripped from the reply; plugin-set cookies namespaced + path-confined + lifetime-clamped. Verbatim header control was removed. |
| Raw-HTML hooks | `wordjs_head`/`wordjs_footer` (SSR-injected, unescaped) **denied** for everyone (stored-XSS). |
| Outbound network | **blocked** unless the `network` capability is granted (admin opt-in, exfiltration warning). |
| Mail / notifications | `wordjs.mail` / `wordjs.notify` via grants; registering a host-wide provider needs `email:provider` / `notifications:provider`. Still sandboxed. |
| Shell / native | `child_process` and native addons (`dlopen`) are **blocked for all plugins** — removed, not gated. |

**Hot-reload semantics:** changing a plugin's grants **reloads its isolated child process** so the host-capability gates re-evaluate and a `network` change takes effect — no server restart needed. Unload/reload performs a full teardown.

> **Note:** `db-migration` is **no longer a plugin** — its functionality moved into core at
> `backend/src/core/db-admin/`. Any older doc referencing it (or a "trusted system plugin" list) is stale.

---

## 9. CSRF & Host Trust (X-Forwarded-Host)

State-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`) are guarded by `csrfProtection` (`backend/src/middleware/auth.ts`):

*   The check compares the request **Origin** (or Referer-derived origin) against an allowlist using **exact origin matching** via `URL` parsing — never `startsWith` (a prefix match would let `https://victim.com.evil.com` satisfy an allowed `https://victim.com`).
*   Behind the gateway, `req.get('Host')` is the internal upstream (`127.0.0.1:PORT`), so the backend instead honors **`X-Forwarded-Host`**. The gateway **pins** that header to the real client-facing `Host` and strips any client-supplied value (`gateway/src/index.js`), so a remote attacker cannot forge it to satisfy the same-origin check.
*   `/api/v1/setup/*` is exempt (origin not yet configured).
*   **Fail-closed on missing Origin AND Referer (AUTH-A2):** when **both** headers are absent the unsafe request is **rejected** (`403 rest_csrf_invalid`) **unless** it carries an `Authorization: Bearer` token. The reason: the JWT also rides in the HttpOnly `wordjs_token` cookie the browser attaches automatically, so a header-less *cookie*-authenticated request could drive a state change with **no** anti-CSRF signal — previously this failed **open**. Only the Bearer-header path is a genuine non-browser API caller that cannot be CSRF'd via an ambient cookie, so only it is allowed through with no Origin/Referer.

This is origin-based protection, **not** per-request CSRF tokens — see §4.

---

## 10. Security Headers

The gateway uses **Helmet.js** for the API/proxy layer, and the **Next frontend** sets the browser-facing headers on every route (`frontend/next.config.ts` `headers()` on source `/:path*`):

- `Content-Security-Policy` (see the CSP note below)
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`

`Strict-Transport-Security` is **not** set by `next.config.ts` — it comes from the gateway's Helmet defaults (`helmet({ contentSecurityPolicy: false })` leaves HSTS enabled, `gateway/src/index.js`). Terminate TLS in front of the gateway so the HSTS header is honored.

> **CSP is in place — but it is not the XSS line of defense.** A Content-Security-Policy **is** served on
> every browser-facing response by the Next frontend (`next.config.ts`). It is correct that the **gateway**
> does not emit a CSP (`helmet({ contentSecurityPolicy: false })`, `gateway/src/index.js`) — that is the
> API/proxy layer, not the user-facing app. The policy is `default-src 'self'` with `frame-ancestors
> 'none'`, `object-src 'none'`, and `base-uri 'self'` — its real value is **clickjacking / structural**.
> `script-src` intentionally keeps `'unsafe-inline' 'unsafe-eval' blob: https:` (Next.js bootstrap, Puck
> `eval`/`Function`, plugin bundles via `import(URL.createObjectURL(blob))`, theme assets in the Puck
> `srcdoc` iframe), so for your threat model do **not** treat the CSP as an XSS backstop — the XSS control
> is the server-side sanitizer (§7).


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
> `worker_threads` Worker, by contrast, shared the host heap/rss; worker_threads was the earlier transport and no longer ships — every launch
> path is now a separate OS process). The plugin reaches core ONLY through the permission-checked `wordjs` **capability bridge**,
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
    *   **Module Hijacking:** Blocks `require()`/`import` of sensitive Node.js modules — `child_process`, `fs/promises`, `http`/`https`, `dgram`, `cluster`, `async_hooks`, `vm`, `worker_threads`, `module`, `inspector`, `v8`, `repl`, `sqlite`, `wasi` (the `node:` prefix is normalized first). Two cases are handled by **declaration** rather than a flat block, and the runtime guards in §1.2 are the actual enforcement for both: `net`/`dns` are flagged only when the manifest declares neither `network` nor `email:admin`; and bare `fs` is **not** blocked here at all — instead each `fs.<method>()` call must be covered by a declared `filesystem:read` / `filesystem:write`.
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
    *   **`fs` Proxy + io-guard:** Filesystem operations require `filesystem:read` / `filesystem:write` permission. Plugins may access their own directory freely — **except the published surface** (`plugins/<slug>/public/` plus the three fixed host-known files), which is **read-only to the plugin**; see *The publicly-served plugin surface* below for why the write side and the serve side are one rule. Link/symlink creation is denied outright (TOCTOU + escape vector); any `fs` function not classified as read or write is **deny-by-default**. `io-guard.ts` additionally confines plugin fs to the plugin dir and **blocks** secret/config files (`.env*`, `wordjs-config.json`) and the live database files (`*.db`/`*.sqlite*` and the configured `dbPath`), which hold every credential, session token, and secret. A plugin **cannot read a sibling plugin's directory** (IO-1): the whole `plugins/` tree is intentionally **not** a broad read safe-zone (a sibling read = cross-plugin secret/data exfiltration, e.g. another plugin's encryption-key file). A plugin reads only its **own** dir (`plugins/<slug>` or `themes/<slug>`) plus the shared `uploads`/`data`/`themes`/`logs`/`os-tmp`/`node_modules`/`src` safe zones. `require()`/`import` resolution still works because reads of any `package.json` or anything under a `node_modules/` dir are allowed — **except** inside a sibling plugin's dir, which is denied (module resolution never legitimately reads a sibling's `package.json`/`node_modules`). The live-DB-file block is enforced **only in the isolated child** (`global.__WORDJS_ISOLATED__`), because on the host the bridge's own scoped DB driver legitimately opens `data/wordjs.db` under a plugin context. **Self-code-modification / scanner-evasion is blocked:** a plugin cannot create, rename, or copy a file into an **executable code extension** (`.js`/`.cjs`/`.mjs`/`.node`/`.wasm`, TS variants) anywhere it can write — its committed code is what the AST scanner vetted, so a fresh runtime `.js` (written directly, or written as `.txt` then renamed/copied) would run un-scanned. `copyFile`/`cp` and `link`/`symlink` are all patched (source read-checked **and** destination write-checked), so neither the raw DB nor a secret can be copied or hard-linked out of the safe zones. And `require()` is refused for any module resolved under a **writable data dir** (`uploads`/`data`/`os-tmp`/`logs`), so a payload dropped there can't be loaded even if it somehow existed. Raw writes are also **byte-metered** per plugin (single-write cap + a rolling append/stream growth quota) so a plugin can't fill the shared volume (`ENOSPC` DoS) via its own `fs`; the `fs.promises` path is metered against the same budget.
    *   **`child_process` Proxy:** Shell execution is **blocked for every plugin** — there is no capability or tier that unlocks it. (The `system:admin` shell escape was removed along with the trust tier.)
    *   **Network Trap (data-exfil / SSRF):** A separate OS process still has full Node net access, so raw `net`/`tls`/`http`/`https`/`http2`/`dns`/`dgram` modules are **blocked by default** and opened only when a plugin has been granted the **`network`** capability (admin opt-in, with an exfiltration warning — e.g. mail-server's SMTP/MX delivery). The binding-backed globals `fetch`/`WebSocket`/`EventSource` are not reachable through the module loader, so they are trapped directly on `globalThis` for plugins without the `network` grant as well. ESM `import()` is also gated (the CommonJS `require` proxy doesn't cover it): a module-resolution hook rejects the same sensitive builtins, and the worker **fails closed** (refuses to run) if no hook API is available (Node ≥ 18.19 required to run plugins).
    *   **Public-destinations-only egress (`egress-guard.ts`):** A plugin that *has* been granted `network` is still confined to **public** destinations. The egress guard blocks loopback (`127.0.0.0/8`, `::1`), link-local **including `169.254.169.254` cloud-metadata** (`169.254.0.0/16`, `fe80::/10`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), IPv6 ULA (`fc00::/7`), the unspecified/`0.0.0.0` and multicast/reserved ranges, and IPv4-mapped-IPv6 — and **fails closed** on a garbage or unresolvable host. Validation happens **at connect time against the actual resolved IP** (anti-DNS-rebinding) by injecting a validating `lookup` into every connect path across `net`/`tls`/`http`/`https`/`http2`/`dgram` plus the global `fetch`/`WebSocket`/`EventSource`. **IPC / unix-socket / named-pipe targets** (e.g. `/var/run/docker.sock`, the connect `path` option) are **denied outright** — they are a container/host RCE vector, not public egress. The single chokepoint is `net.Socket.prototype.connect`, patched **inside the isolated child** and **locked** (`Object.defineProperty` `writable:false, configurable:false`) so a plugin cannot reassign or un-patch it; it also covers the `net.Stream` alias, the `Object.getPrototypeOf(Socket.prototype).connect` bypass, custom http(s) agents/`createConnection`, and the pre-normalized `[options, cb]` arg array. It is **TOCTOU-hardened**: the connect options `host`/`hostname`/`path` are snapshot once into primitives, validated, then redefined as own frozen data-properties so a malicious getter cannot return a benign value to the check and a private one to Node's later re-read. For global `fetch`, redirects are followed **natively** by `fetch` (which correctly strips `Authorization`/`Cookie` on cross-origin hops) and **each hop's connect is IP-validated at the socket layer** by the prototype patch — the `guardedFetch` wrapper just fast-fails on an obviously blocked initial host; the connect patch is authoritative. If `egress-guard` cannot load, the network globals are **blocked entirely** (fail-closed).
    *   **Core outgoing webhooks are SSRF-guarded too:** the same egress posture applies to *core* outbound requests, not just plugin `network` grants. WordJS's outgoing webhooks (`/admin/webhooks`, fired on content events like `post.published`) are **HMAC-signed** and **SSRF-hardened** in `backend/src/core/webhooks.ts` — deliveries to loopback / cloud-metadata / RFC1918 destinations are rejected, validated against the resolved IP **at delivery time**.
    *   **Native-binding lockdown:** `process.binding`/`_linkedBinding` throw for plugin contexts and `.node` addons are refused (`process.dlopen` is also blocked for all plugins — a `.node` addon runs outside every JS-level guard, so no trust tier unlocks it). `process.getBuiltinModule(id)` (Node ≥ 22.3) — a direct C++-backed accessor that hands back a builtin **without** routing through `Module._load` / `Module.prototype.require` / the ESM loader — is likewise re-routed through the same per-plugin module policy (secure `fs`/`child_process` proxy, inert blocked proxy for `net`/`vm`/`worker_threads`/…), so it can't be used to fetch an unguarded builtin.
    *   **Native-backed builtins that sidestep the `fs` proxy are blocked outright:** the module blocklists (`secure-require.ts` and the isolate's ESM `import()` hook) are keyed by name, so a C++-backed builtin that never routes through the `fs`/`require` proxies is an escape unless it is on the list. **`node:sqlite`** — `DatabaseSync` opens/creates arbitrary files by native code (reading the core credential DB, writing host payloads) and `loadExtension()` maps a native addon (host RCE via a loader separate from `process.dlopen`) — and **`node:wasi`** — a WASI `preopen` maps a host directory into a WASM instance whose native `fd_read`/`fd_write`/`path_open` bypass the guard — are therefore both blocked for plugins, on the CommonJS require path **and** the ESM `import()` path. `process.report.getReport()`/`getReportSync()` are blocked too (alongside `writeReport()`): the report's `environmentVariables` is the full host `process.env`, an env-secret leak for any code running in the host process.
    *   **Obfuscation-Immune:** Because enforcement happens at runtime (not just static analysis), even obfuscated code like `fs["read" + "FileSync"]()` is blocked.

*   **Secret & Core-Module Scrubbing:** A plugin that `require()`s a core module could capture the real `fs`/secrets it closed over. So plugins are **denied** sensitive core modules; `config/app` is handed back as a read-only Proxy with credential-like fields (`*secret*`, `*password*`, `*key*`, `*token*`, …) stripped; and the `config/database` `dbAsync` is replaced with a **table-scoped** view. That in-process view now delegates to the **same** lexer-based guard (`assertSqlAllowed`, `backend/src/core/plugin-api.ts`) as the RPC bridge, so the two DB surfaces cannot diverge — an earlier regex-only in-process guard was evadable with SQL comments/quotes (`FROM/**/users`) and applied no cross-plugin prefix restriction. That scoping is **default-deny by prefix and applies to every plugin**: every table a query touches must be one the plugin OWNS under its `wjp_<slug>_` prefix, so it can't read another plugin's tables or any core table — backed by an explicit denylist of core tables (`users`, `user_meta`, `options`, `roles`, `sessions`, …) and rejection of `ATTACH`/`DETACH`/`PRAGMA`/`VACUUM`, schema catalogs (`sqlite_master`/`information_schema`/`pg_catalog`), file/extension SQL functions (`readfile`/`writefile`/`load_extension`/`pg_read_file`/…), Postgres' query-executing XML family (`query_to_xml`/`table_to_xml`/`schema_to_xml`/`database_to_xml`/`cursor_to_xml`/…, which takes a whole SQL query as a **string argument** — laundering it through a literal that `lexSql` blanks by design, so the statement names zero tables and both the prefix allowlist and the core-table denylist passed vacuously), stacked statements, and `RETURNING`; a comma cross-join is not rejected outright — every table in the list is captured by the walker and prefix-checked — and a Postgres `DELETE … USING <table>` target is prefix-attributed like `FROM`/`JOIN`. **DDL is additionally constrained by a positive object-class allowlist:** a plugin may only `CREATE`/`ALTER`/`DROP` its own `TABLE`, `INDEX`, `VIEW` or `TRIGGER`; every other object class (`SCHEMA`, `DATABASE`, `ROLE`, `FUNCTION`, `EXTENSION`, `SYSTEM`, …) is denied outright, because such a statement names no table at all — so `DROP SCHEMA public CASCADE`, `CREATE ROLE … SUPERUSER` and a `SECURITY DEFINER` function whose body (a literal) reads `users` all satisfied the table rules vacuously. `ALTER … RENAME TO` is prefix-checked on the **destination** as well (the pre-rename token says nothing about where the table lands, so `RENAME TO users` would shadow a core table). A **data-modifying CTE** — a `WITH` whose body contains `insert`/`update`/`delete`/`replace`/`merge` — is classified as a **write** and refused on the read path: `with` is on the read verb list, so on Postgres such a statement executed a mutation under `database:read` alone even with the write grant revoked. The bridge's scoped view exposes `get`/`all`/`run`/`batch`/`createTable`/`getType` — **no `transaction()`** (and `batch` is a transport optimisation only: every statement runs the same permission check and the same guard, and it refuses DDL). There is no "unscoped DB" capability for any plugin. Plugins that need user or site data use the **safe bridges** `wordjs.users.*` (a projection that never includes `user_pass`, gated on `users:read`) and `wordjs.site.*` (gated on `settings:read`) instead.

*   **API Sandboxing (capability bridge):** The `wordjs` object passed to a plugin's `init(api)` (`backend/src/core/plugin-api.ts`) is the *only* sanctioned path to core, and inside an isolated plugin those calls are RPC'd to the host over IPC. The host dispatcher (`callApi` in `plugin-isolate.ts`) enforces an **exact method allowlist** — a malicious child cannot walk an arbitrary dotted path on the api object — and registration / mail-provider / notify-transport / route all flow only through their own dedicated IPC kinds (default-deny). Every method then enforces the plugin's capability grant (`verifyPermission` = manifest-declared **AND** admin-granted, default-deny) **and** constrains arguments host-side: option-key allowlists, SQL table-scoping, and path confinement to the plugin's own dir + uploads. **No plugin skips the option/table scoping** — these constraints are unconditional now that the trusted tier is gone.

*   **DoS containment (host-side):** Beyond the layered memory caps (§4), the host bounds a misbehaving child: a per-child bridge-call **token-bucket rate limit** + concurrency cap, a global **IPC message-rate cap**, inbound/outbound RPC **payload size caps**, an `fs.write` size limit + per-plugin disk quota, an admin-menu cap, hook/route/shortcode **registration caps** (incl. per-hook-name), and a 30s **RPC timeout** that recycles a wedged child. Repeated abuse `SIGKILL`s and tears the child down.

### 1.3 CrashGuard v2.0 (Anti-Boot Loop)
WordJS includes a sophisticated system to prevent a single buggy or malicious plugin from taking down the entire server.

*   **The 3-Strike Rule:** To avoid "false positives" (like a power outage during plugin load), CrashGuard uses a strike system.
    1.  **Strike 1 & 2:** If the server crashes during plugin initialization, CrashGuard logs a warning and retries on next boot.
    2.  **Strike 3:** If the plugin consistently crashes the server 3 times (`MAX_STRIKES = 3`, `backend/src/core/crash-guard.ts`), it is **automatically disabled** — dropped from the active list under a dist-lock — and a persistent `error` entry is appended to the `admin_notices` option (`backend/src/core/plugins.ts`). That append is **best-effort**: a lock or option failure is logged and swallowed, because wedging crash recovery is worse than losing a notice. Notices now have their **own** admin-only router — `GET /api/v1/notices` (list) and `DELETE /api/v1/notices/:id` (dismiss), rendered at `/admin/notices`. They used to live at `GET /api/v1/settings/notices`, where the settings wildcard `GET /settings/:key` matched first and answered with `key='notices'`; because that key is not in `PUBLIC_SETTINGS` the response was `403` **even for an administrator**, so a CrashGuard notice was unreadable, its id was unknowable, and the autoloaded `admin_notices` option grew without ever being pruned. The legacy path still resolves, but notices are not a setting and no longer live under one.
*   **Runtime Blame System:** If an asynchronous error (like an unhandled promise rejection or a `setTimeout` crash) occurs outside of a request, CrashGuard analyzes the stack trace. If the error originated from a plugin, that plugin is identified ("blamed") and disabled on the next restart to prevent a crash loop.

### 1.3a The publicly-served plugin surface (allowlist, and read-only to the plugin)

`app.use('/plugins', express.static('./plugins'))` used to publish the **entire** plugin tree to the anonymous internet: source, tests, `.map` files, and every plugin's `data/` dir (mail-server's attachments and `bayes.json` were reachable on a *clean install*, despite that directory being documented as holding encryption keys). Combined with the fact that a plugin may write inside its **own** directory with no permission grant at all, that mount **annulled the entire network-containment model**: the `network` capability and every userspace or native egress rule police the *socket*, and none can see a plugin writing `leak.txt` and an attacker fetching `https://site/plugins/<slug>/leak.txt` unauthenticated. Nobody was validating the read channel the **server itself** opened. `dotfiles: 'deny'` only ever hid names beginning with a dot.

Two rules now replace it, derived from **one** declaration in `backend/src/core/io-guard.ts` so that "what is published" and "what a plugin may not write" can never disagree:

*   **Served (`isPluginServedRelPath`, consumed by `backend/src/index.ts`):** only `plugins/<slug>/public/**` with an extension on a fixed allowlist (`.css`, `.js`/`.mjs`, images, fonts, media, `.pdf`), plus three exact host-known files the admin shell requests by construction (`manifest.json`, `client/admin/admin.css`, `dist/component.bundle.css`). Everything else — `data/`, source, `.map`, `.json`, `node_modules`, anything dropped at runtime — is a **404**, fail-closed. The allowlist deliberately excludes anything that runs as a **document in this origin** (`.html`/`.htm`/`.svg`/`.xml`), where the global CSP allows `'unsafe-inline'` and the frontend shares the origin in both shipped modes. Requests are decoded **once** and proved with `safe-path.resolveWithin`, and the **resolved** absolute path is what `res.sendFile` receives, so the gate and the file layer cannot read the string differently. Responses carry `X-Content-Type-Options: nosniff`, and non-asset types get `application/octet-stream` + `Content-Disposition: attachment`, as `/uploads` already did.
*   **Not writable (`isPluginPublishedPath`):** the whole `public/` subtree is denied to the plugin's own `fs`, deliberately **wider** than the servable extension list — a narrower rule would let a plugin stage bytes at `public/x.unknown` and wait for the list to grow. Serving an allowlist while leaving it writable would just reopen the channel through the door next to it. `.html` is additionally unwritable via `EXECUTABLE_CODE_EXT` (a plugin that wrote `pwn.html` had a stored-XSS primitive with zero permissions).

Practical consequence for authors: **ship anything the browser must fetch in `public/`**, and treat it as build output — the plugin cannot rewrite it at runtime.

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
*   **Runtime code generation (default-on backstop):** The install-time AST scanner only sees *statically-visible* `eval`/`new Function(string)`, not code assembled at runtime or inside an unscanned dependency. A **default-on (opt-out)** `config.sandbox.blockCodeGen` starts the isolated child with V8's `--disallow-code-generation-from-strings`, hard-blocking runtime `eval`/`new Function(string)` as a belt-and-suspenders layer under the scanner. Set `blockCodeGen: false` only for a plugin whose dependencies genuinely need runtime `Function()`/`eval` (some template engines do). It is force-disabled under `ts-node` regardless (dev needs codegen to compile TS), so it only bites a **compiled prod worker**.
*   **Resource Limits (memory, layered):** Because each plugin is a *separate OS process*, its memory is the child's own rss — bounded in layers rather than by a single Worker `resourceLimits`: (a) an **opt-in preventive cgroup v2** `memory.max` via `systemd-run --user --scope` (`config.sandbox.useCgroupMemoryCap=true`, probe-gated, no root) that has the kernel OOM-kill only the offending child at the resident budget (768 MB); (b) a **default-on preventive Windows Job Object** (`JOB_OBJECT_LIMIT_PROCESS_MEMORY` = 768 MB, assigned before the suspended child resumes, probe-gated; opt out via `config.sandbox.useJobObjectMemoryCap=false`) so the kernel fails any over-budget commit; (c) a **reactive host-side RSS poll** on every platform (Linux `/proc`, Windows `tasklist`, macOS `ps`) that `SIGKILL`s the child over 768 MB; (d) a **loose Linux `RLIMIT_AS` virtual backstop** (`ulimit -v`, `config.sandbox.addressSpaceCapMb`, default 16384 MB — kept generous because V8's pointer-compression cage reserves ~4 GB virtual) plus `--max-old-space-size=256` for the JS heap; and (e) **anti-exhaustion caps** — a **file-descriptor cap** (`RLIMIT_NOFILE` = 4096) on the Linux rlimit path and a **task/PID cap** (cgroup `TasksMax` = 512) on the systemd-scope path. Seccomp independently denies Linux process creation while retaining `CLONE_THREAD`. An **opt-in** per-plugin **CPU quota** ships (`config.sandbox.cpuQuotaPercent`, applied as `CPUQuota=N%` of one core in the same systemd `--user` scope as the cgroup memory cap, so it only bites when `useCgroupMemoryCap` is also on); it defaults to `0` (off), so **by default** a plugin can still burn CPU (DoS) until you enable it. Current macOS has no unprivileged preventive resident-memory primitive: its `RLIMIT_AS` spelling is probed and rejected as unenforced, leaving the V8 heap ceiling, process separation and reactive RSS poll.
*   **Runtime Escapes:** Low-level escapes are blocked at runtime *inside the child* — `Module._load` is intercepted like `Module.prototype.require`, `process.binding`/`_linkedBinding` throw, `.node` native addons are refused, ESM `import()` of sensitive builtins is rejected (fail-closed), the native-backed builtins `node:sqlite` (arbitrary file I/O + `loadExtension` native-addon RCE) and `node:wasi` (host-dir `preopen` → native WASM file I/O) are blocked, `process.report.getReport()` (host-env leak) is blocked, and deferred plugin code (`setTimeout`/`setInterval`, EventEmitter listeners, top-level/detached callbacks) is re-anchored to the plugin context via `getEffectivePlugin()` so it cannot shed its sandbox. (`process.dlopen` is also blocked for all plugins — loading a native addon is a direct sandbox escape, so no trust tier unlocks it.) For a `network`-granted plugin, SSRF/exfiltration is contained by the connect-time public-IP egress guard (§1.2): even a DNS-rebinding or redirect-to-private attempt is validated against the *actual resolved IP* at the locked `net.Socket.prototype.connect` chokepoint inside the child.
*   **Native kernel sandbox (default-on, fail-closed):** every production plugin is wrapped by Landlock+seccomp on Linux, AppContainer on Windows, or Seatbelt on macOS. Each path is activated only after a real confined child and an unconfined control prove scoped filesystem access, process/dangerous-syscall denial, working storage+IPC, and both network-policy shapes. A network grant changes only egress; it never removes the native sandbox. `config.sandbox.requireHardening` defaults to true, so an unavailable probe or failed per-plugin native launch refuses the plugin. Linux needs no namespace or host tuning: `/usr/bin/perl` applies Landlock, `no_new_privs` and the seccomp filter to itself and then execs Node. AppContainer adds only `internetClient` for a granted plugin while retaining its package SID, no-child policy and Job limits. Seatbelt changes only its outbound-network allow. The additional Node permission model and JavaScript guards remain defense-in-depth. Live state is reported as `sandbox.kernel`, `sandbox.network` and `sandbox.permission` on admin `GET /health/details`; verify the compiled implementation with `backend/scripts/verify-sandbox-parity.mjs`.
*   **CSP — present, but not an XSS backstop:** A Content-Security-Policy **is** now served on every browser-facing route by the Next frontend (`frontend/next.config.ts` `headers()`), not the gateway (the gateway still runs `helmet({ contentSecurityPolicy: false })` for the API/proxy layer, `gateway/src/index.js`). The honest caveat: `script-src` deliberately keeps `'unsafe-inline' 'unsafe-eval' blob: https:` — Next.js inline bootstrap, `eval`/`Function` in bundled libs, and plugin admin bundles loaded via `import(URL.createObjectURL(blob))` (`lib/pluginBundleLoader.ts`) — so `script-src` is **not** an XSS defense. Two of the original reasons for the widening are now historical: the retired Puck editor's `eval` and its `about:srcdoc` theme iframe. Verso needs neither (its canvas is a same-origin route, `/admin/canvas-frame`), but the policy has **not** been re-narrowed — treat that as an open cleanup, not a done one. The structural value is `frame-ancestors 'self'`, `object-src 'none'`, and `base-uri 'self'`; the XSS control remains the server-side sanitizer in `lib/sanitize.ts` (see §10).
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
| **`assets`**        | `write` | Enqueue front-end scripts/styles via `wordjs.assets.enqueueScript`/`enqueueStyle`. `src` must resolve **inside your plugin's `public/` directory** with a servable extension (§1.3a) — anywhere else throws. `public/` is read-only to the plugin, so what is served is what the admin installed and the AST scanner saw. |

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
*   **Location:** The master certificates live in `gateway/certs/`. The **Cluster Root CA key** is kept there only in the **separate-mode** flow: `ensureClusterCA()` creates `gateway/certs/` `0700` and *keeps* `cluster-ca.key`, because the gateway must sign enrolment CSRs at runtime (`gateway/src/cluster-ca.js`). A single-host `npm run setup` does the opposite — it stages the CA key in `.certs_tmp`, distributes it to nobody, and **removes the staging dir** once the three identities are issued (`setup/index.js`), so on a single host no CA key survives the install.
*   **Isolation:** The CA private key is never distributed. `cluster-ca.key` is written `0600` (plus a follow-up `chmod`, wrapped in a `try/catch` for Windows), and a node only ever receives `cluster-ca.crt` — the `/enroll` response is `{ cert, ca: <the CA **certificate**>, config }` and never carries the key (`gateway/src/index.js`).
*   **CA minting:** `node scripts/cluster.js init` (`gateway/src/cluster-ca.js`) mints the cluster CA, the gateway's own `gateway-internal` identity, and the gateway's **public** cert — which is now **also signed by the cluster CA** (so a frontend on another host validates the gateway's public origin from the same trust root via `NODE_EXTRA_CA_CERTS`). It writes a multi-node `gateway-config.json` (routable `gatewayInternalBind`, ports) and clears the registry.
*   **Identity Provisioning:** the Backend and Frontend each receive a unique per-node identity signed by the CA — on one host during setup, or, in separate mode, via the token-enrollment flow in §6.4.

### 6.2 Selective Distribution (Least Privilege)
To prevent lateral movement if a service is compromised, each service gets **only its own** identity. `distributeCert()` (`setup/index.js`) copies exactly three files per target, and empties each destination `certs/` first — except the directory it is reading the fresh certs *from* — so a key from an earlier install cannot linger:
*   **Backend:** Receives `backend.crt`, `backend.key`, and `cluster-ca.crt`.
*   **Frontend:** Receives `frontend.crt`, `frontend.key`, and `cluster-ca.crt`.
*   **Gateway:** Receives the **same three-file shape** — `gateway-internal.crt`, `gateway-internal.key`, `cluster-ca.crt`. It is *not* handed the other services' keys. What makes it the master is what `cluster.js init` additionally leaves on it in separate mode: the CA signing key (`cluster-ca.key`) and the public front-door pair under `gateway/ssl/`.

In separate mode nothing is copied at all: each node generates its own keypair locally and writes `<role>/certs/{<role>.key,<role>.crt,cluster-ca.crt}` from the enrolment response (`scripts/node-join.js`), so a private key never crosses a machine boundary.

### 6.3 Secure Control Plane
The Backend manages the Gateway via a dedicated **Internal API** (Port `gatewayInternalPort`, default 3100). This API:
*   Requires a valid `backend` mTLS certificate to connect (the `/register` listener requests and verifies a client cert whose CN is in `{backend, frontend}`).
*   Allows the Backend to push new public SSL certificates (from Let's Encrypt) to the Gateway without direct filesystem access.
*   Allows remote configuration of the Gateway without restarting the main OS process.

### 6.4 Join-token enrollment (separate mode) 🎟️
When the three services run on **different machines**, hand-copying certs is error-prone, so a node bootstraps its mTLS identity with a **join token**, `kubeadm join`-style (`scripts/cluster.js`, `scripts/node-join.js`, `gateway/src/cluster-ca.js`):
*   **Mint (gateway):** `node scripts/cluster.js token <backend|frontend>` mints a **single-use, role-bound, TTL** token (default 60 min, `--ttl <minutes>` to change it) and prints the exact `node-join` command, including the gateway address, enroll port, token, and CA fingerprint (`--ca-hash`). `--host <node-ip>` **pins** the address the enrolling node is allowed to claim. Only a **sha256 of the token** is persisted (`gateway/cluster-tokens.json`, written `0600` and replaced atomically), so the store file never holds a usable credential; each mint also GCs spent/expired entries.
*   **Enroll (new machine):** `node scripts/node-join.js --role … --gateway … --token … --ca-hash … --advertise …` generates a keypair + CSR (`openssl`) and makes **one** `POST /enroll` call to the gateway's **token-enrollment listener** — a **separate** HTTPS listener on `gatewayEnrollPort` (default 3101) that **does NOT request a client cert** (the strict-mTLS `/register` listener in §6.3 is unchanged). It is rate-limited (30 req/min/IP) and refuses to start at all unless `cluster-ca.key` + the `gateway-internal` identity are present. It binds `gatewayInternalBind` — `127.0.0.1` by default, and whatever routable internal address you passed to `cluster.js init --host/--bind` in a real cluster; keeping that interface off the public internet is the **operator's** job, nothing in the code enforces it.
*   **Sign (gateway):** the gateway `consume`s the token (validating role + TTL + single-use), then signs the CSR while **forcing `CN=<role>` from the token — the CSR's subject is ignored** — so a node can never mint itself a different identity. The **SAN is pinned too**: if the token pinned a host, `--advertise` must equal it; if it did not, `--advertise` must equal the address the node is actually connecting from — otherwise the call is refused `400`. Without that, a token holder could put any host in the SAN and mint a cluster-CA cert that impersonates the gateway to the frontend. It returns `{ cert, ca (cluster CA), config (bootstrap: gatewaySecret + ports + siteUrl) }`.
*   **Verify + start:** `node-join` verifies the returned CA against `--ca-hash` (MITM guard) — **only when that flag is supplied**. The enrol request itself runs with `rejectUnauthorized: false`, because the node has no trust anchor yet, so an enrolment *without* `--ca-hash` is plain trust-on-first-use with no chain check; the command `cluster.js token` prints always includes the flag, so use it as printed. (`--advertise` likewise defaults to the node's first non-internal IPv4 when omitted.) It then writes `<role>/certs/*` + `<role>/wordjs-config.json` and starts the service, which **registers over mTLS** on `/register`. The token is burned (`used: true`) on that first call; everything afterward is mTLS.

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
*   **Enrolment (sudo re-auth required):** a user calls `POST /auth/mfa/setup` (returns the shared secret / QR), confirms a code to `POST /auth/mfa/enable`, and can `POST /auth/mfa/disable` or check `GET /auth/mfa/status`. Self-service UI at `/admin/account`. **Both halves of enrolment now demand `currentPassword`** (`403 rest_bad_current_password`), through the same `requireSudoPassword` helper as the two self-service password doors in `routes/users.ts` — so the sudo rule (per-account lockout bucket + in-flight cap, i.e. not an unthrottled password oracle) cannot drift between them. The MFA routes were **asymmetric**: turning 2FA off, regenerating backup codes and changing the password all demanded extra proof, while turning it *on* demanded nothing beyond the ambient cookie. A hijacked session (same-origin XSS calling `fetch` with credentials — the cookie is HttpOnly, it is never "stolen" — or an unlocked laptop) could therefore enrol the **attacker's** authenticator and lock the owner out permanently, because `forgot-password`/`reset-password` change the password but clear no `mfa_*` key. `/setup` is gated as well as `/enable` because `/setup` is what discloses the TOTP secret, and the `mfa:` throttle never helped: the attacker got the code right first time. The invariant this encodes: **no operation that depends on a cookie alone may produce a state its owner cannot undo.**
*   **Administrative reset (the way out of a lockout):** `POST /api/v1/users/:id/mfa/reset` clears every `mfa_*` key on the target (`core/mfa.disable`), so the account logs in with its password and re-enrols. Gated `authenticate` + `sessionOnly` (a leaked `wjt_` token must never strip a second factor) + `edit_users`, with the same `isPrivilegedTarget` rule as `PUT /users/:id` — `edit_users` is delegable, so without it a delegate could disarm an administrator's 2FA and then attack their password. It refuses **self** (`400 rest_cannot_reset_own_mfa`): an admin turning off their own 2FA must still pass `POST /auth/mfa/disable` with a current code, or this route would hand a hijacked admin session exactly the cookie-only power that route deliberately refuses. Residual, by design: a **sole** administrator who loses their authenticator still needs a second admin. Audited as `user.mfa_reset` (who reset whose factor; no secret material).
*   **Login challenge:** when a 2FA-enabled account authenticates, `POST /auth/login` sets **no session cookie** — it returns a 5-minute `mfa_challenge` JWT, and login completes only after `POST /auth/mfa` verifies a TOTP or one-time **backup code** (`POST /auth/mfa/backup-codes` regenerates them). That challenge token is signed with the same secret as a session JWT but carries `purpose: 'mfa_challenge'`, and `authenticate()` rejects **any** token bearing a `purpose` with `401` (`optionalAuth` treats it as anonymous), so it can never be replayed as a session to skip the second factor. A verified TOTP's time-step is consumed one-time via an atomic compare-and-set (`UPDATE … WHERE meta_value = <expected>`), and a backup code is consumed the same way, so two concurrent submissions of the same code cannot both pass.
*   **Admin-enforced MFA-by-role policy:** an administrator can *require* MFA for chosen roles, with a **grace window in days**, via `GET`/`PUT /auth/mfa/policy` (`authenticate` + `sessionOnly` + `isAdmin` — an API token, even an admin's, can never reconfigure it). A subject user who has not enrolled is only **nudged** while inside the window (login and `/auth/me` carry `withinGrace` + `graceDeadline`); once it lapses, the global `mfaComplianceGate` (`backend/src/middleware/auth.ts`) answers `403 mfa_enrollment_required` to everything except the enrolment/session allowlist (`/auth/me`, `/auth/logout`, `/auth/refresh`, `/auth/mfa/{setup,enable,status,backup-codes,disable}`) — deliberately **not** `/auth/mfa/policy` or `/auth/tokens`, so an enforced admin cannot disable the requirement or mint a headless token instead of enrolling. The grace anchor is `max(policy.enforcedAt, the user's registration)`, and `enforcedAt` is stamped server-side on the transition to ≥1 required role, so it cannot be back-dated to expire everyone's grace at once. The gate fails **open** if the policy row itself is unreadable (a site-wide option blip must not lock everyone out) and **closed** (`503`) if one user's compliance can't be evaluated. `wjt_` API tokens are categorically exempt — including one minted before the policy took effect, a documented residual: revoke such tokens if a role's headless access must also be gated.

### Scoped API Tokens

For headless / machine clients that cannot carry the browser cookie, WordJS issues **scoped personal access tokens** (`backend/src/models/ApiToken.ts`):
*   **Format:** `Authorization: Bearer wjt_<secret>`; the secret is shown **once** at creation and stored only as a **sha256** hash at rest.
*   **Scopes:** global `read`/`write`/`*` plus **per-resource** scopes (e.g. `posts:write`, `media:read`). The effective permission is the **intersection** of the token's scopes and the owning user's capabilities (a token can never exceed its user).
*   **Management:** `GET`/`POST`/`DELETE /auth/tokens` (list / mint / revoke), with a self-service UI at `/admin/tokens`.
*   **A token can never become a session.** Marking routes one-by-one as off-limits to tokens was the wrong shape of rule: `POST /auth/refresh` carried only `authenticate`, which accepts a `wjt_` token as readily as a session JWT, and it set a 7-day `wordjs_token` cookie — so a leaked machine token minted an interactive session that no longer carried `req.apiToken`, walked straight past `sessionOnly` on `/auth/tokens` and `/auth/mfa/*`, and survived revoking the original token. The rule is now inverted at the **sink**: `issueSessionCookie()` (`backend/src/middleware/auth.ts`) is the single door that mints the cookie, and it refuses **any** headless request with `403 rest_session_from_token_forbidden`. `sessionOnly` lives in the same module, next to the headless mark both read, so a future route that issues a cookie inherits the refusal instead of having to remember it.
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

**Editor page-tree sanitizer (server-side, every write path).** The visual builder’s page tree (`_puck_data` — the meta key keeps its historical name; see `documentation/plugins.md` §13) is stored verbatim in post meta and rendered as HTML on many independent public sites, so it is sanitized on **every write** by the shared module `backend/src/core/sanitize-meta.ts` (used by **both** `routes/posts.ts` and the WXR importer `core/wxr-import.ts`, so neither path bypasses it). It walks the tree and sanitizes string leaves: HTML-bearing fields (`content`/`html`/`text`/`title`/`heading`/`description`/`caption`/`body`) through the post-body `sanitize-html` allowlist; and — crucially — **every other** string leaf runs through `safePuckUrl`, a **value-based** (not key-name) check that blanks only values starting with `javascript:`/`data:`/`vbscript:`/`file:` (after stripping control-char obfuscation) and leaves labels/classes/colors/relative paths/fragments untouched. This closes stored XSS via URL props that are **not** in any key allowlist (e.g. `CTABanner`/`PricingTable` `buttonLink`, XSS-01). `_puck_data` arriving as a JSON **string** is now parsed → sanitized → re-stringified (previously object-only — a bypass, XSS-02).

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

**`core/safe-path.resolveWithin(base, ...segments)` is the shared primitive**, and the rule it encodes is *validate the form of each segment **and** prove containment on the **resolved** value* — a guard that checks one string while the write uses another is this repo's most-repeated defect shape. Three sinks that were not using it now do:

*   **Attachment deletion** (`models/Media.ts`). The unlink target was `path.join(uploads.dir, <value read straight out of post_meta>)`. `_wp_attached_file` was writable through the generic meta writers, so an `author` could point their own upload at `../data/wordjs.db` and have `DELETE /media/:id` unlink it — arbitrary file deletion, and because `fs.existsSync` ran first the route always answered `200 {deleted:true}`, making it an existence oracle for arbitrary paths too. The per-size loop was worse: it based itself on `path.dirname(mainPath)`, so one poisoned main value moved the base for **every** size entry — N deletions per request. Each size now resolves against the uploads root plus the main file's already-proven segments, and failure is **closed**: an unresolvable main name deletes nothing (the DB row still goes, so a poisoned value cannot make an attachment undeletable). The meta keys themselves are now protected (see `documentation/api.md` §6.2) — a value that can never be written is a stronger statement than one merely contained on the way out, so both layers are in place.
*   **Backup restore** (`core/backup.ts`). The archive's entry name was prefix-tested **raw** (`name.startsWith('themes/')`) while the write used `path.resolve(backendRoot, name)`, and containment was proved against `backendRoot` rather than the content root the prefix promised — so `themes/../dist/index.js` passed both checks and landed on executable code (adm-zip does not normalize on read). Entries are now split into segments and resolved with `resolveWithin` against the **specific** content root (`uploads`/`plugins`/`themes`), any failure aborts the whole restore instead of `continue`-ing, and the archive is validated as a backup **before** the write loop rather than after — an archive that fails validation used to have already left files on disk.
*   **Plugin static serving** (`index.ts`) — see §1.3a.

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
2. **Rate Limiting**: Enforced in the **backend**, not the gateway (`backend/src/index.ts`): a global per-IP API limiter (1000 / 15 min on `config.api.prefix`), a 10/hour limiter on `/auth/register`, `/auth/forgot-password`, `/auth/reset-password` and `/setup/migrate`, a **failed-logins-only** per-IP backstop on `/auth/login` + `POST /auth/mfa` (so several users behind one public IP who authenticate successfully are never throttled), 50/hour on the upload routes (`/media`, `/themes/upload`, `/plugins/upload`, `/backups`), **60/min on `POST /analytics/track`** (anonymous, and every call stores a permanent row), 10 form submissions/minute, and 20 setup attempts / 15 min. **`/api/v1/collab/*` is excluded from the global limiter and has its own** per-IP window instead: inline collaborative editing is default-on and commits one transaction per keystroke (~10 POST/s by design), so at 1000 / 15 min (1.11 req/s) a single author exhausted the window after about two minutes of typing — and from then on **every** `/api/v1/*` call answered `429`, including `PUT /posts/:id`, the manual Save the client advertises as the safety net in its own collaboration notices. The feature's traffic was disabling the feature's fallback. The collab window's ceiling is **derived** from `core/collab-rooms`' `CONFIG` (`MAX_OPS_PER_SEC × MAX_CONNS_PER_USER`) rather than re-typed, and it is only a coarse anti-flood net — the binding control remains the per-connection token bucket inside `collab-rooms`, which is the only place that can answer with the retry delay the client waits on. All are Redis-backed when a cache client is configured (so the cap holds across replicas) and **pass on store error**, so a Redis outage degrades to allowing the request rather than 500ing the API. The **gateway** rate-limits only its join-token enrollment listener (30/min); it applies **no** limiter to proxied traffic, so put your own in front if you need edge throttling
3. **Firewall**: Only expose port 3000 (or 80/443)
4. **Backups**: Configure automatic backups. Backups are stored **on-host** in `backend/backups/` and are **retention-pruned** after each run — only the newest N are kept (the `backup_retention` option, default `7`; set `0` to keep all), so scheduled backups can't fill the disk. Off-host / S3 storage is roadmap, so copy backups off the box for disaster recovery.
5. **Metrics endpoint**: The Prometheus `GET /metrics` endpoint is **disabled by default** and returns `404` unless you set a scrape token (`config.metrics.token` or the `METRICS_TOKEN` env var). When enabled, scrape it only over a trusted network with `Authorization: Bearer <token>`; never expose it without a token.
6. **Install token (pre-install takeover)**: Before the instance is installed, the `/setup/install` and `/setup/test-db` endpoints are gated by a **one-time install token** (`backend/src/core/install-token.ts`). It is generated at boot when the instance is not yet installed, **printed to the server console**, and **mirrored to a `0600` file** in the data dir (`data/install-token`) for headless/Docker reads. An operator may supply their own via the `WORDJS_INSTALL_TOKEN` env var, but a value **under 16 chars is ignored** (with a warning) and a random token used instead — an entropy floor so a short/guessable value can't reduce the takeover gate to a brute-forceable secret. The token is checked **constant-time**, held in memory (fail-closed if not generated), and the on-disk mirror is removed once installed.
7. **Updates**: Keep Node.js and dependencies updated

---

## 8. Plugin Capability Model (Android-style grants — no trust tier)

There is **one** plugin model: every plugin is sandboxed, and each capability is **admin-granted per plugin** with **default-deny** (`backend/src/core/plugin-permissions.ts`). The old binary trusted/untrusted split — and all of its bypass machinery (`plugin-trust.ts`, `config.trustedSystemPlugins`, the `__WORDJS_PLUGIN_TRUSTED__` child flag, the `system:admin` scan-skip, and the admin trust toggle) — has been **removed**. No plugin is privileged. Grants are seeded by the **admin's activation** — for **every** plugin, not just first-party ones: activating a plugin that holds no grant record grants exactly the capabilities it **declares**, persisted only after activation and the AST scan succeed, and only while it has no record, so a later revoke survives re-activation (`backend/src/routes/plugins.ts`). First-party plugins run under the exact same sandbox and grant checks as anything uploaded.

**How it works:** a plugin's `manifest.json` **requests** capabilities; an admin **grants** each one per plugin via toggles in `/admin/plugins` (`POST /plugins/:slug/permissions`, persisted in the `plugin_grants` option, mirrored in memory so the bridge gates read it synchronously). A bridge call succeeds only if the capability is BOTH declared in the manifest AND granted (`verifyPermission`); `:admin` access implies read+write.

**These constraints apply to every plugin, unconditionally:**

| Surface | Rule (all plugins) |
| :-- | :-- |
| DB | own `wjp_<slug>_` tables only; raw SQL on core tables refused. No unscoped tier exists. |
| User / site data | via the safe bridges `wordjs.users.*` (`users:read`; projection only, never `user_pass`) and `wordjs.site.*` (`settings:read`). |
| Options | non-secret keys only; secret-named options are never exposed. |
| Routes | always namespaced under `/api/v1/plugin/<slug>`. Absolute paths were removed. |
| Route I/O | host auth cookie `wordjs_token` (+ csrf/session) stripped from the forwarded request; `Set-Cookie`/`Set-Cookie2`/`CSP`/`HSTS`/`Location`/`Content-Type`/`Refresh` stripped from the reply; plugin-set cookies namespaced + path-confined + lifetime-clamped (max 20 per reply). Verbatim header control was removed. |
| Raw-HTML hooks | `wordjs_head`/`wordjs_footer` (SSR-injected, unescaped) **denied** for everyone (stored-XSS). |
| Outbound network | **blocked** unless the `network` capability is granted (admin opt-in, exfiltration warning). The denial is kernel-backed by seccomp/Landlock, AppContainer or Seatbelt; a grant changes only that egress rule. |
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
*   `/api/v1/setup/*` is exempt (origin not yet configured). The exemption is computed from `req.originalUrl` and matches the `/setup` **segment**, never a `startsWith('/setup')` prefix. This matters: `csrfProtection` is mounted *with* the API prefix and Express strips a mount path from `req.url` first, so the earlier comparison against the full `/api/v1/setup` could never match — the exemption was declared, documented, and dead, and a headless installer got a `403 rest_csrf_invalid` on a site that had no users to CSRF.
*   **Fail-closed on missing Origin AND Referer (AUTH-A2):** when **both** headers are absent the unsafe request is **rejected** (`403 rest_csrf_invalid`) **unless** it carries an `Authorization: Bearer` token. The reason: the JWT also rides in the HttpOnly `wordjs_token` cookie the browser attaches automatically, so a header-less *cookie*-authenticated request could drive a state change with **no** anti-CSRF signal — previously this failed **open**. Only the Bearer-header path is a genuine non-browser API caller that cannot be CSRF'd via an ambient cookie, so only it is allowed through with no Origin/Referer.

This is origin-based protection, **not** per-request CSRF tokens — see §4.

---

## 10. Security Headers

The gateway **and** the backend both use **Helmet.js** for the API/proxy layer (`gateway/src/index.js`, `backend/src/index.ts`), and the **Next frontend** sets the browser-facing headers on every route (`frontend/next.config.ts` `headers()` on source `/:path*`):

- `Content-Security-Policy` (see the CSP note below)
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()`

`Strict-Transport-Security` is **not** set by `next.config.ts` — it comes from Helmet's defaults (`max-age=31536000; includeSubDomains`), which apply on **both** the gateway (`helmet({ contentSecurityPolicy: false })` leaves HSTS enabled) and the backend. Terminate TLS in front of the gateway so the HSTS header is honored.

> **Helmet does not give you an "XSS filter".** The Helmet version WordJS ships (`^8`) emits
> `X-XSS-Protection: 0`, which **disables** the legacy browser XSS auditor rather than enabling it.
> Do not count it as a control; the XSS defense is the server-side sanitizer (§7).

> **CSP is in place — but it is not the XSS line of defense.** A Content-Security-Policy **is** served on
> every browser-facing response by the Next frontend (`next.config.ts`). It is correct that the **gateway**
> does not emit a CSP (`helmet({ contentSecurityPolicy: false })`, `gateway/src/index.js`) — that is the
> API/proxy layer, not the user-facing app. (The **backend** does emit its own, much looser, Helmet CSP on
> its API / `/uploads` responses — `default-src 'self'`, `object-src 'none'`, but `connect-src` and
> `img-src` include `*` and there is no `frame-ancestors`; the frontend policy below is the one that
> governs the pages a user actually browses.) The policy is `default-src 'self'` with `frame-ancestors
> 'self'`, `object-src 'none'`, and `base-uri 'self'` — its real value is **clickjacking / structural**.
> `script-src` intentionally keeps `'unsafe-inline' 'unsafe-eval' blob: https:` (Next.js bootstrap,
> `eval`/`Function` in bundled libs, plugin bundles via `import(URL.createObjectURL(blob))`; the
> now-retired Puck editor and its `srcdoc` iframe were the original reasons and the policy has not been
> re-narrowed since), so for your threat model do **not** treat the CSP as an XSS backstop — the XSS control
> is the server-side sanitizer (§7).


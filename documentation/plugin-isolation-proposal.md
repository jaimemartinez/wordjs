# Plugin Isolation (child_process / OS process) — IMPLEMENTED

> This document started life as a design *proposal* for hard plugin isolation. It is now **shipped and
> mandatory**: every plugin runs in a **separate OS process** (`child_process.fork`) behind the
> `wordjs` capability bridge. The original proposal text is kept below (sections 1–7) for the threat
> model and the rationale for *why* a hard, host-owned-capability boundary was chosen; the status
> banner that follows describes what actually shipped, and where it differs from the proposal (notably:
> there is **no in-process tier and no "trusted" tier at all** — *every* plugin is isolated and
> capabilities are admin-granted per plugin, default-deny — and the as-built isolate primitive is
> `child_process`, which gives true OS-level isolation rather than the heap-only boundary of the
> originally-shipped `worker_threads` runtime).

> **Status update (2026-06-20): IMPLEMENTED — isolated-only (mandatory), cross-platform, OS-process.**
> The `wordjs` capability bridge (`src/core/plugin-api.ts`) and the isolate runtime
> (`src/core/plugin-isolate.ts` + `plugin-worker.js`, **`child_process.fork`** — works in any
> environment, no native deps) are in `main`. Every plugin runs in its **own OS process** — its own
> heap, event loop and OS memory cap — reaching core only via the bridge over IPC; a plugin MUST declare
> `"isolated": true` and use the bridge. The **legacy in-process execution path has been removed** —
> `loadActivePlugins`/`activatePlugin` reject non-isolated plugins and `deactivatePlugin` terminates the
> child. A separate OS process gives **kernel-enforced** heap / crash / OOM / resource isolation + host-
> owned capabilities everywhere: a crash, an off-heap (Buffer) OOM, or a hard V8 escape is contained to
> the child and **the host process always survives** — something a `worker_threads` isolate (which shares
> the host heap and rss) could not guarantee. `plugin-worker.js` is transport-agnostic: it normalizes a
> `child_process` IPC channel and a legacy `worker_threads` `parentPort` to one API, and a Worker-like
> adapter in `plugin-isolate.ts` keeps the RPC code unchanged. IPC uses v8 structured clone
> (`serialization: 'advanced'`) so `Buffer`/`Date`/`Map` survive — no live references cross the boundary.
> Deeper kernel-surface hardening (seccomp/landlock + dropped uid) can layer on top of the already-
> separate process (see §2/§6).
>
> **Bridge surface (complete, tested):** options.get/set, db.all/get/run/createTable/getType (core-table
> scoped for untrusted), hooks.add{Action,Filter}/doAction, **http.route (host runs auth, forwards JSON
> over RPC)**, **shortcodes.add (async, RPC'd + expanded by doShortcodeAsync)**, fs.read/write (confined),
> mail, notify, adminMenu.add, cron.schedule, assets.enqueue{Script,Style}. The dispatch is split by design: data calls travel as a
> generic `kind:'call'` IPC message that `callApi` checks against an **EXACT method allowlist**
> (`ALLOWED_BRIDGE_METHODS`: options.get/set, db.all/get/run/createTable/getType, hooks.doAction,
> fs.read/write, mail, notify, adminMenu.add, cron.schedule, `assets.enqueueScript`/`assets.enqueueStyle`,
> the safe `users.findByEmail/findByLogin/findById/search` projection, and `site.url/domain/adminEmail`) — a child sends ANY method string and
> `callApi` walks it as a dotted path, so without this gate it could reach a registration method or a
> prototype-chain segment directly. **Registration** (hooks/filters, routes, shortcodes, mail-provider,
> notify-transport) flows ONLY through its own dedicated IPC kinds (`register`, `register-route`,
> `register-shortcode`, `register-mail-provider`, `register-notify-transport`), never via a generic
> `call` — so privileged surface (e.g. `provideMail`) is **deliberately absent** from the call allowlist
> (default-deny) and can't be reached through a generic `call`. e2e tests cover the bridge guards, an
> isolated hook/filter over RPC, an isolated DB write, an isolated JSON route served through host
> Express, and an isolated async shortcode expanded via doShortcodeAsync.
>
> **Shortcodes (was the last blocker, now solved):** `doShortcode()` is synchronous so it couldn't
> await an isolated worker. Added `doShortcodeAsync()` (collect matches → resolve callbacks
> concurrently → splice back-to-front) and switched the content render path (`Post.toJSON`) to it.
> Isolated plugins register shortcodes via `wordjs.shortcodes.add`; the host runs a shim that RPCs the
> worker. (This also fixed a latent bug in the old in-process carousel shortcode, which read options
> without awaiting.)
>
> **One model — capabilities admin-granted per plugin, default-deny (`src/core/plugin-permissions.ts`):**
> There is **no trust tier**. Every plugin is sandboxed identically; the manifest *requests* capabilities,
> an admin *grants* each one in `/admin/plugins` (persisted in the `plugin_grants` option, mirrored in
> memory), and a bridge call works only if the capability is BOTH declared AND granted.
> - **Always enforced, for every plugin:** DB default-denied to its own `wjp_<slug>_` tables only,
>   enforced host-side by `assertSqlAllowed` (per-plugin prefix attribution; ATTACH/DETACH/PRAGMA, schema
>   catalogs `sqlite_master`/`information_schema`/`pg_catalog`, stacked statements, comma-joins, the
>   Postgres `USING` clause and `RETURNING` are all rejected; core tables `users`/`options`/`sessions`/…
>   off-limits). Non-secret options only. Routes always namespaced under `/api/v1/plugin/<slug>/*`. It
>   cannot shim the raw-HTML output hooks (`wordjs_head`/`wordjs_footer`/`wp_head`/`wp_footer`); the host
>   auth JWT cookie (`wordjs_token`) is stripped from forwarded route requests and dangerous response
>   headers (Set-Cookie/CSP/HSTS/Location) are stripped from its replies; fs read/write is confined to its
>   own dir (`plugins/<slug>` or `themes/<slug>`) by io-guard, which also blocks `.env`/secret-named files
>   and — in the isolated child — raw DB files (`.db`/`.sqlite` + the configured DB path). The `plugins/`
>   tree is intentionally **not** a broad read safe-zone: a plugin **cannot read a SIBLING plugin's files**
>   (another plugin's encryption-key/`.env`/data); the cross-plugin `package.json`/`node_modules` reads
>   that module resolution needs are scoped to the plugin's own tree + shared ancestors, with sibling-dir
>   reads explicitly denied (IO-1). By default **no outbound network** — the raw socket modules
>   (`net`/`tls`/`dgram`/`http`/`https`/`http2`/`dns`) are denied by secure-require, and the
>   binding-backed globals `fetch`/`WebSocket`/`EventSource` are trapped as throwing getters in the
>   sandbox entry (`plugin-worker.js`).
> - **Grantable capabilities** (admin opt-in, on top of the above): `database`/`settings`/`filesystem`,
>   `users:read` (the safe user projection via `wordjs.users.*` — never `user_pass`), `email:provider`
>   (`provideMail`), `notifications:provider` (`notify.registerTransport`), and **`network`** (opens raw
>   sockets + `fetch`/`WebSocket`, **confined to PUBLIC destinations** — see below). `http.route`
>   `opts.multipart` (host parses the upload, capped at `uploads.maxFileSize`) is available within the
>   namespaced route.
> - **`network` is egress-confined, not an open SSRF surface (`src/core/egress-guard.ts`):** when an
>   admin grants `network`, secure-require hands the plugin the **egress-guarded** `net`/`tls`/`http`/
>   `https`/`http2`/`dgram` module (`getGuardedModule`, fail-closed if the guard errors) and the worker
>   wraps the global `fetch`/`WebSocket`/`EventSource` with the same policy. Egress is restricted to
>   **public** destinations: it blocks loopback (`127.0.0.0/8`, `::1`), link-local incl.
>   **`169.254.169.254` cloud metadata**, RFC1918 private (`10/8`, `172.16/12`, `192.168/16`), CGNAT
>   `100.64/10`, IPv6 ULA (`fc00::/7`) / link-local (`fe80::/10`), IPv4-mapped-v6, multicast/reserved,
>   and **fails CLOSED on an unresolvable/garbage host**. Validation happens **at connect time against
>   the RESOLVED IP** (a validating `lookup` is always injected, anti-DNS-rebinding) — not just on the
>   hostname string. So a `network` grant is **exfiltration to the public internet**, NOT a reach into
>   loopback / metadata-creds / internal RFC1918 services. (It still does not stop deliberate exfil to an
>   attacker's *public* server — that's the point of the grant; see §7 non-goals.)
> - **Connect-time enforcement is locked (can't be un-patched):** inside the child the guard patches
>   `net.Socket.prototype.connect` as the **single chokepoint** (`installChildNetGuard`) — covering
>   `net.connect`/`createConnection`, `new net.Socket()`, the `net.Stream` alias,
>   `Object.getPrototypeOf(Socket.prototype).connect`, custom `http(s)` agents, and the connect undici
>   performs under global `fetch`/`WebSocket` — then **LOCKS** it
>   (`Object.defineProperty … writable:false, configurable:false`) so a network-granted plugin cannot
>   reassign it back to the raw `connect` to restore SSRF. Local **IPC / unix-socket / named-pipe**
>   targets (e.g. `/var/run/docker.sock`, the connect `path` option) are **denied outright** (not public
>   egress); `dgram` send/connect destinations are resolved + validated manually. The connect options
>   `host`/`hostname`/`path` are snapshot ONCE then **frozen** as own data-properties, so a getter cannot
>   return a benign value to the check and a private one to Node's later re-read (TOCTOU defense). Global
>   `fetch` is wrapped (`guardedFetch`): the initial host is fast-failed via `assertUrlAllowed`, then
>   native fetch follows redirects (correctly stripping `Authorization`/`Cookie` cross-origin) while
>   **each redirect hop's actual connect is IP-validated by the prototype patch** — so a
>   redirect-to-private/metadata is blocked at the socket layer.
> - **Removed for every plugin (no grant unlocks them):** shell/`child_process`, native addons, unscoped
>   / core-table DB, `db.createTable` on core tables, secret-named options, absolute routes
>   (`opts.absolute`), raw cookie jar / verbatim Set-Cookie/CSP/HSTS/Location, and raw-HTML hooks.
>
> **First-party plugins are not privileged:** `mail-server`, `conference-manager`, and the galleries run
> in the same sandbox under the same default-deny checks as anything uploaded. Nothing is granted out of
> the box: **activating** a plugin grants exactly the capabilities its manifest declares (the admin
> approves them in the activation dialog, only when the plugin has no prior grant record), and the admin
> can refine or revoke any grant afterward. Changing grants (`POST /plugins/:slug/permissions`, admin-only)
> **hot-reloads the worker**
> (`reloadIsolatedPlugin`) so its network policy re-resolves and the host-capability gates re-evaluate —
> no server restart. A plugin can **never** grant itself anything; the manifest only requests.
>
> **AST static scanner (`acorn`, fail-closed):** **every** plugin is scanned at install/activate and again
> on **every boot** (re-validated to catch code poisoning); a parse failure or a dangerous call blocks
> activation. There is **no scan-skip for any plugin** — the `system:admin` skip and the trusted-slug
> exemption were removed. The scanner catches `eval`/`Function` **statically**; for runtime-constructed
> or downloaded-then-eval'd code there is an **OPT-IN engine-level hard block** —
> `config.sandbox.blockCodeGen` adds `--disallow-code-generation-from-strings` to the child so V8 refuses
> all runtime codegen. It is **OFF by default** (some plugin deps legitimately use `Function()`) and is
> **never applied under ts-node** (dev needs codegen to compile TS).
>
> **Full teardown on unload/reload:** `unloadIsolatedPlugin` terminates the worker AND runs a teardown
> that removes every host-side registration the plugin made — Express route layers are spliced out,
> hook/filter/shortcode shims removed, a provided mail sender / notification transport unregistered, and
> its admin-menu entries dropped — so no stale shim can RPC a dead worker. Teardown is idempotent and
> also runs as a crash safety-net on worker `exit`.
>
> **Themes now isolate too (SHIPPED, 2026-07-18).** The proposal only covered plugins, but a theme's
> `functions.js` was executed **in-process on the host** — with no runtime `eval`/`Function`/dynamic-`import`
> guard, a hostile theme was a full host-RCE path that no static scan can fully close (the in-process-theme
> escape cluster). It now runs in the **same child_process isolate** as a plugin:
> `backend/src/core/theme-engine.ts → loadThemeLogic()` AST-pre-scans `functions.js` (via
> `validatePluginPermissions`, fail-closed) and then calls
> `loadIsolatedPlugin('theme:<slug>', logicPath)` — the isolate layer already namespaces `theme:` slugs, so
> the theme reaches core through the **same** capability bridge, secure-require/io-guard guards, and per-RPC
> limits described above. A theme switch tears down the prior worker first (`unloadIsolatedPlugin`).
> Theme-registered Handlebars helpers still execute host-side at render time, so `render()` re-anchors them
> to the theme's context (`runWithContext('theme:<slug>', …)`) — otherwise a helper would run with an empty
> ALS store (treated as trusted core) and dodge the context-gated guards. Bundled themes' `functions.js`
> only `console.log`, so nothing host-side regressed.
>
> **Per-plugin tier (final — 7 of 8 isolated):**
> | Plugin | Tier | Why |
> |---|---|---|
> | hello-world | **isolated** | hooks only — reference |
> | test-schema | **isolated** | hooks + DB via bridge |
> | card-gallery | **isolated** | JSON routes + options + admin menu (frontend → namespaced path) |
> | photo-carousel | **isolated** | routes + options + **async shortcode** (`[carousel]`) |
> | video-gallery | **isolated** | routes + options + shortcode (`[vgallery]`) |
> | conference-manager | **isolated** | own-table DB (`wjp_conference_manager_*`), namespaced routes (granted its declared caps on activation) |
> | mail-server | **isolated** | inbound SMTP listener (configurable `smtp_listen_port`, default 2525) + outbound MX delivery (to recipient :25) in the worker (granted `network`); Email model → own-table `db`, DKIM key in own DB/files, multipart upload, `provideMail` (`email:provider`) + `notify.registerTransport` (`notifications:provider`) |
> | ~~db-migration~~ | **moved to core (de-pluginized)** | was DB infrastructure, not a feature plugin (runs schema migrations at boot, around the DB lifecycle). Backend → `src/core/db-admin/` (wired in at boot, routes still `/api/v1/db-migration/*`); admin UI → native frontend route `frontend/src/app/admin/db-migration/page.tsx` reached via a permanent **core** Sidebar item (`/admin/db-migration`), NOT a toggleable plugin. Removed from `plugins/` and all generated registries. |
>
> (The table above is the inventory at the time the model was finalized. Every plugin added since —
> the bundled `youtube-videos` (granted `network` for its YouTube RSS/Data-API fetches) and all 25
> marketplace plugins (`marketplace/plugins/`, installed sha256-verified through the same zip
> pipeline) — follows the same isolated-only model; there is no other tier for them to be in.)
>
> **Net (final): the sandbox is isolated-only.** Every plugin runs in its own OS process; the legacy
> in-process execution path was removed (`loadActivePlugins`/`activatePlugin` reject non-isolated plugins,
> `deactivatePlugin` terminates the child). All feature plugins are isolated (verified in-browser
> serving real data — incl. the mail server's inbox and its inbound SMTP listener on its configured
> port (`smtp_listen_port`, default 2525)). db-migration is no
> longer a plugin at all: its backend moved into core (it manages the database server itself) and its
> admin UI is a native frontend route reached from a permanent core Sidebar item. **Every** plugin —
> first-party or uploaded — isolates and is hard-blocked from core tables/secrets regardless of the
> permissions it requests; capabilities are admin-granted per plugin (default-deny) — activation grants a
> plugin only its manifest-declared set (admin-approved, refinable afterward), nothing is pre-seeded, and
> first-party plugins get no extra privilege. There is no privileged tier.
> (The host-side guards — io-guard / secure-require / appRegistry anchoring — stay: bridge calls run in
> plugin context on the host, so they're still load-bearing.)
>
> **Residual risk — be honest about what the child process does and does NOT buy.** The
> `child_process.fork` boundary is a **real OS process boundary**: each plugin has its own heap, event
> loop, rss and pid, so a crash, an off-heap (Buffer) OOM, or a hard V8 escape is contained to the child
> and **the host process always survives** — strictly stronger than the originally-shipped
> `worker_threads` runtime, which shared the host heap/rss and could OOM-crash it. Memory is bounded in
> LAYERS: (a) an **OPT-IN preventive cgroup v2 `memory.max`** via `systemd-run --user --scope`
> (`config.sandbox.useCgroupMemoryCap`, Linux-only, probe-gated, no root) that kernel-OOM-kills only the
> offending child at 768 MB; (b) a **reactive host-side RSS poll** on every platform (Linux `/proc`,
> Windows `tasklist`, macOS `ps`) that SIGKILLs at 768 MB; (c) a **loose `RLIMIT_AS` virtual backstop**
> (`config.sandbox.addressSpaceCapMb`, default 16384 MB) via a `sh -c 'ulimit -v N; exec node …'` wrapper
> + `--max-old-space-size=256` for the JS heap; and (d) a **preventive Windows Job Object** with
> `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (the Win32 analog of cgroup `memory.max`) — default-on on Windows,
> probe-gated, opt-out via `config.sandbox.useJobObjectMemoryCap`. A one-shot PowerShell P/Invoke (no
> native dep) assigns the forked child to a 768 MB-capped job, so the kernel FAILS any commit past the
> budget; the job + limit persist for the child's lifetime via the kernel job refcount, and the brief
> post-fork assign window is covered by the RSS poll exactly as before. What the OS process still does **not** buy by itself is
> **capability-minimal syscall confinement**: the child has a full Node runtime, so capability denial
> still relies on the in-child guards (secure-require proxies `fs`/`child_process`/raw-net modules and
> blocks `worker_threads`/`vm`/`module`/`inspector`; the bootstrap traps `fetch`/`WebSocket`/
> `EventSource`; **when `network` is granted, egress-guard patches and LOCKS
> `net.Socket.prototype.connect` so every outbound connection — incl. fetch redirect hops — is validated
> at connect time against the resolved IP and confined to public destinations**; io-guard confines fs to
> the plugin's own dir; the table-scoped DB confines SQL). A *novel* Node global or native
> binding that reaches the disk/network without going through those proxies would be an escape **of the
> userspace policy** (it could not escape the process or its memory cap). By-construction, OS-enforced
> confinement now ships as an **opt-in** Linux layer (bubblewrap: dropped uid + capabilities + no-new-privs
> + PID/IPC/UTS namespaces + read-only fs + a seccomp syscall denylist; `sandbox.useKernelHardening`,
> default-off, probe-gated — see the status banner). The Windows preventive memory cap (Job Object) is
> now **shipped** (layer (d) above), so the resident budget is kernel-enforced on Linux (cgroup) AND
> Windows (Job Object). An independent security audit is recommended before relying on this for
> genuinely hostile multi-tenant input.

Status: **IMPLEMENTED** (was: proposal) · Author: WordJS · History: the original proposal followed 4
red-team passes on the *in-process* sandbox, which closed every *known* practical escape (AST scan +
runtime require proxy + ALS-anchoring of every entry point + core-module deny-list + dbAsync scoping)
but remained a **soft** boundary — plugin code shared the main-process heap, so a *novel* unanchored
entry point or a missed monkey-patch could reopen RCE. The proposal argued for a **hard** boundary
where raw Node capabilities are unreachable. What shipped is that hard boundary for **all** plugins:
first via `worker_threads` (heap-isolated), then — because a worker shares the host heap/rss and an
off-heap OOM in it cannot be capped without taking the host down — moved to **`child_process.fork`** for
true OS-level process isolation (a `worker_threads` transport remains only as a fallback). See the
status banner above for the as-built details and the residual-risk note for where the OS-process
boundary stops (syscall confinement now ships via the opt-in bubblewrap + seccomp layer; see the banner).

---

## 1. Goal & threat model

**Goal:** an uploaded third-party plugin that is actively malicious cannot read/write outside its
grant, cannot execute shell commands, cannot read other plugins' or core secrets, and cannot crash
or hang the host — *by construction*, not by enumeration of blocked tricks.

**Model (as built):** the proposal originally split *untrusted = isolated* vs *trusted = in-process*, and
an interim build kept two server-side trust tiers (both isolated). **What ships now is simpler and
stronger: there is one model and no trust tier.** Every plugin runs in its own OS process behind the
bridge, and the *capabilities the host grants over the bridge* are **admin-granted per plugin,
default-deny** (Android-style). No plugin gets unscoped DB, secret options, absolute routes, shell, or
native addons — those were removed for everyone; the only thing that distinguishes plugins is which of the
*safe* grantable capabilities an admin has turned on.

| Model | Examples (today) | Runtime | Capabilities |
|---|---|---|---|
| **Single sandbox, per-plugin grants** | every plugin — first-party (conference-manager, mail-server, galleries — granted their declared caps on activation) and uploaded alike | **isolated** (OS process, `child_process.fork`) | bridge only, default-deny: own `wjp_<slug>_` DB tables, non-secret options, namespaced routes, safe `users:read`/`site` bridges, and admin-grantable `network` / `email:provider` / `notifications:provider`. No unscoped DB, secret options, absolute routes, shell, or native addons — for anyone. |

---

## 2. Why vm / worker alone are not enough

- **`vm` (same process, new context):** NOT a security boundary. Node's own docs warn against it for
  untrusted code — `this.constructor.constructor('return process')()` and prototype walks reach the
  outer realm. ❌ as the boundary.
- **`worker_threads` (separate isolate/heap):** gives **heap + crash isolation** (the plugin cannot
  touch main-process objects/secrets) — but the worker still has the **full Node API**, so the plugin
  can `require('fs')`/`require('child_process')` *in its own thread* and hit the disk/shell. ❌ as a
  capability boundary by itself.
- **`isolated-vm`:** a genuine V8 isolate with **no Node bindings at all** (no `require`, `process`,
  `fs`, network) — capabilities are *injected* explicitly as functions. This is the Cloudflare-Workers
  style boundary. ✅ real capability boundary.
- **Separate `child_process`** (+ OS sandbox: seccomp/AppArmor/container, dropped uid, cgroup limits):
  strongest (OS-enforced fs/net/cpu/mem), plus crash/resource isolation. ✅ strongest, heaviest.

**Recommendation (original proposal):** **`isolated-vm` for the plugin logic** (capabilities
unreachable) **+ a worker or child-process wrapper** for CPU/memory limits and crash isolation. For
deployments that can afford it, **child-process + OS sandbox** is the gold standard. Either way the
architecture below is the same — only the isolate primitive differs.

> **As built:** the shipped primitive is **`child_process.fork` (separate OS process)** — the second
> half of that recommendation — chosen over `isolated-vm` because it needs **zero native dependencies**
> and works on any platform, and over `worker_threads` because a separate process gives true OS-level
> crash/OOM/resource isolation (the host always survives) where a worker shared the host heap/rss. The
> **OS-sandbox layer** of the gold standard (dropped uid + dropped capabilities + no-new-privs + namespaces
> + a seccomp syscall denylist) now ships as an **opt-in** Linux layer (bubblewrap, `sandbox.useKernelHardening`,
> default-off, probe-gated); the Landlock LSM is intentionally omitted (the read-only mount namespace covers
> its fs-confinement goal, and it would need a native dep). The kernel resource
> limits ARE in place today: an OPT-IN cgroup v2 `memory.max` (Linux, `systemd-run --user
> --scope`), a default-on preventive **Windows Job Object** memory cap, and a loose `RLIMIT_AS` virtual
> backstop, plus a cross-platform RSS poll (see §6 and the status banner).

---

## 3. Architecture: capability RPC bridge

The core change: untrusted plugins **stop `require('../../src/core/...')`** and instead receive a
single injected, async, permission-checked `wordjs` host object. Raw `fs`/`child_process`/`dbAsync`/
secrets live ONLY in the host (main process) and are never passed into the isolate. Every bridge call
is enforced server-side against the plugin's manifest permissions — the isolate is untrusted input.

```
┌─────────────────────────── main process (host) ───────────────────────────┐
│  Express app · dbAsync · secrets · fs · core modules                       │
│  PluginHost: per-plugin permission set + the bridge implementations        │
│        ▲  RPC (IPC, v8 structured-clone `serialization:'advanced'` — no    │
│        │      live refs; `child_process.fork`, separate OS process)        │
└────────┼───────────────────────────────────────────────────────────────────┘
         │   inject async fns: options.*, db.query, hooks.*, http.route,
         │   fs.read/write (plugin-scoped), mail.send, notify, adminMenu.add
┌────────▼─── isolate (child_process OS process; worker_threads = fallback) ──┐
│  plugin code — Node JS reaching core ONLY via `wordjs.*`; raw fs/net/      │
│  child_process/worker_threads proxied or denied by the in-child guards     │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Capability API (replaces the current direct requires)
Async by necessity (crosses the boundary). Each maps to a current direct use:

| Today (in-process) | Bridge call | Host-side enforcement |
|---|---|---|
| `require('core/options').getOption/updateOption` | `wordjs.options.get(k)` / `set(k,v)` | `settings:read`/`write`; key allowlist (no secret keys) |
| `require('config/database').dbAsync.*` | `wordjs.db.query(sql, params)` | `database:*`; **table scoping enforced host-side** (plugin's own tables only — already prototyped by the dbAsync guard) |
| `require('core/hooks').addAction/doAction` | `wordjs.hooks.addAction(hook, fnId)` / `doAction` | callbacks live in the isolate; host dispatches by id |
| `getApp().get('/x', handler)` | `wordjs.http.route(method, path, fnId)` | host owns Express; on a request it sends a **plain req subset** to the isolate and awaits a **response descriptor** (status/headers/body) — the isolate never touches the socket |
| `fs.readFileSync(...)` | `wordjs.fs.read(relPath)` / `write` | `filesystem:*`; paths confined to the plugin's OWN dir only (the shared `uploads/` dir is no longer reachable via the bridge — that was a trusted-tier affordance), realpath-checked host-side; io-guard denies sibling-plugin reads (IO-1), `.env`/secret files, and raw DB files in the child |
| `nodemailer` / `global.wordjs_send_mail` | `wordjs.mail.send(msg)` | `email:*`; host owns the MTA |
| `notificationService.send` | `wordjs.notify(n)` | `notifications:send` |
| `registerAdminMenu(...)` | `wordjs.adminMenu.add(item)` | declarative |
| cron `scheduleEvent` | `wordjs.cron.schedule(hook, when)` | host fires it back into the isolate (already slug-scoped) |

### 3.2 Lifecycle
- **Load:** host reads manifest → builds the permission set → spawns the isolate with a bootstrap that
  injects only the permitted bridge methods → runs the plugin's module top-level + `init()` inside it.
- **Routes/hooks/cron/transports:** registered by **id**; the host invokes them by sending an event +
  awaiting a result (with a timeout). Crash/timeout → the host disables the plugin (CrashGuard, already
  present) without taking down the process.
- **Resource limits (as built):** layered memory caps on the child — OPT-IN preventive cgroup v2
  `memory.max` (Linux), default-on preventive Windows **Job Object** `ProcessMemoryLimit`, reactive
  cross-platform RSS poll → SIGKILL at 768 MB, loose `RLIMIT_AS`
  backstop + `--max-old-space-size=256` — plus per-RPC timeout, bridge-call rate/concurrency token
  buckets, IPC message-rate caps, payload/disk caps and registration caps. Closes the DoS class the
  in-process model can't. An OPT-IN `config.sandbox.blockCodeGen` additionally passes
  `--disallow-code-generation-from-strings` to the child (engine-level `eval`/`new Function(string)`
  block; off by default, skipped under ts-node).
- **Deactivate:** terminate (SIGKILL) the child process → all its memory/handles gone, deterministically;
  `teardown()` splices out every host-side registration it made.

### 3.3 Frontend components
Plugins ship React components under `client/` that the admin/puck UI imports today. Those are **build-
time** assets, unaffected by runtime isolation — they keep being bundled (and reviewed) as now. Only the
**backend** logic moves into the isolate.

---

## 4. Raw-capability plugins (UPDATE — they isolate too)
> The proposal assumed raw-capability plugins couldn't be isolated and would stay in-process. **That's
> not how it shipped, and the model has since simplified further.** A separate OS process still has a full
> Node runtime, so the host *grants* the *safe* high-level capabilities a plugin needs over the bridge —
> per plugin, admin-controlled, default-deny — instead of exempting anything from isolation or handing out
> raw OS primitives. So:
- **mail-server**: runs its inbound SMTP server on its configured port (`smtp_listen_port`, default
  2525) and does outbound MX delivery (connecting to recipient mail servers on :25) **inside its own OS
  process**. secure-require opens the **egress-guarded** `net`/`tls`/`http`/`https`/`http2`/`dgram`
  (plus raw `dns` for resolution — the connect, not the lookup, is the guarded sink) only when the
  **`network`** capability is granted (resolved host-side at spawn and passed in
  the child's config argument, surfaced in-child as the frozen `global.__WORDJS_PLUGIN_NETWORK__` that
  secure-require's net branch reads, re-resolved on a grant change via `reloadIsolatedPlugin`). Even
  granted, its raw sockets and global `fetch`/`WebSocket` are confined to **public** IPs at connect time
  — outbound MX delivery is the legitimate use; loopback/metadata/RFC1918 targets are denied. (The mail
  plugin separately IP-pins its MX delivery against rebinding, in the plugin itself.) The DKIM key lives
  in the plugin's own DB/files (not a core secret option),
  and the bridge grants multipart upload, `provideMail` (`email:provider`), and `notify.registerTransport`
  (`notifications:provider`). Activating it grants these declared caps (admin-approved, revocable), but it
  runs fully sandboxed.
- **conference-manager**: granted `database` (its own `wjp_conference_manager_` tables) +
  namespaced routes on activation — all over the bridge, no unscoped DB or absolute routes (those no longer exist).
  Isolated.
- **db-migration**: was **de-pluginized** — it manages the database *server process* and runs at boot,
  which is core infrastructure, not a feature plugin. Moved to `backend/src/core/db-admin/`; it is no
  longer a plugin and is not isolated (it's core).
- There is no longer any plugin path to native addons, raw sockets at the OS level (only the
  host-mediated `network` grant), or child processes — those raw capabilities were removed entirely. A
  plugin that genuinely needs that level of OS access is not a sandboxed plugin and belongs in core (as
  db-migration did).

---

## 5. Migration path — COMPLETED
The phased migration the proposal laid out has all landed; for the record:
1. ✅ Shipped the `wordjs` bridge API (`src/core/plugin-api.ts`), passed as `init(wordjs)`.
2. ✅ Ported the bundled plugins' backends to the bridge (galleries, hello-world, test-schema, plus the
   higher-capability mail-server and conference-manager — all sandboxed, granted their declared caps on activation).
3. ✅ Added the isolate runner (`src/core/plugin-isolate.ts` + `plugin-worker.js`), first on
   `worker_threads` (chosen over `isolated-vm` for zero native deps / cross-platform), then **moved to
   `child_process.fork`** for true OS-process isolation (the host always survives a child crash/OOM); the
   transport-agnostic `plugin-worker.js` keeps `worker_threads` only as a fallback transport.
4. ✅ **Flipped past the default to mandatory**: there is no longer a non-isolated path.
   `loadActivePlugins`/`activatePlugin` **reject** any plugin that doesn't declare `"isolated": true`;
   `deactivatePlugin` terminates the worker. The AST scanner runs at activate **and on every boot**.
5. ✅ Direct `require('../../src/core/...')` is gone from the bundled plugin backends — they use the bridge.

---

## 6. Trade-offs & decision

| Primitive | Capability boundary | Crash/DoS isolation | Perf cost | Complexity |
|---|---|---|---|---|
| `vm` | ❌ none | partial | low | low |
| `worker_threads` (was shipped, now fallback) | ❌ (full Node in worker; shares host heap/rss) | ✅ crash, ⚠️ off-heap OOM can take the host down | medium (IPC + clone) | medium |
| **`child_process.fork` (shipped)** | ❌ (full Node in child) but separate OS process: own heap/rss/pid, host always survives | ✅✅ (separate process + layered mem caps: cgroup/RLIMIT_AS/RSS-poll) | higher (process + IPC) | medium-high |
| **`isolated-vm`** | ✅ (no bindings) | ✅ (mem/cpu caps) | medium | medium-high (async API rewrite, native build) |
| **child-process + OS sandbox (seccomp/uid)** | ✅✅ (OS-enforced syscalls) | ✅✅ | higher (process + IPC) | high (= shipped child-process + **opt-in** bwrap kernel layer, Linux) |

**Decision (as built):** shipped the **bridge API + `child_process.fork` (separate OS process)** for
**all** plugins. The proposal leaned toward `isolated-vm`; a process was chosen instead because it has
**zero native dependencies and works on any platform** (`isolated-vm` needs a native build) while still
giving **true OS-level crash/OOM/resource isolation** — a worker_threads version shipped first but was
replaced because a worker shares the host heap/rss and an off-heap OOM in it can't be capped without
crashing the host. The **OS-sandbox layer** that makes capability denial by-construction — dropped uid +
dropped capabilities + no-new-privs + PID/IPC/UTS namespaces + a seccomp syscall denylist — now ships as an
**opt-in** Linux layer (bubblewrap, `sandbox.useKernelHardening`, default-off, probe-gated) on top of the
in-child guards (secure-require module proxies + the `fetch`/`WebSocket`/`EventSource` global trap), without
changing the bridge. The Landlock LSM is intentionally omitted (the read-only mount namespace covers its
fs-confinement goal, and it would need a native dep); a preventive Windows memory cap (Job Object) is now
shipped (default-on, probe-gated). Kernel resource limits in place today: OPT-IN cgroup v2 `memory.max`
(Linux) + preventive Job Object `ProcessMemoryLimit` (Windows), loose `RLIMIT_AS`, cross-platform RSS poll.

## 7. Cost & non-goals
- **Cost (actual):** the bridge API + the `child_process` OS-process isolate runner (+ layered memory
  caps) + porting the bundled plugins + the async-handler / `doShortcodeAsync` convention — all landed.
- **Non-goals:** a granted capability is a granted capability — if an admin grants `network`, the plugin
  can reach the network (that's the point); the model contains *ungranted* capability, not the
  consequences of what was deliberately granted. It does not sandbox the frontend bundle (plugin React
  components are build-time assets, bundled and reviewed as before); it does not replace code review of
  first-party plugins (activating them grants their declared caps, so review them as you would any code you ship); and a separate
  OS process gains an **opt-in** bubblewrap layer (dropped uid + capabilities + `no-new-privs` +
  PID/IPC/UTS namespaces + read-only fs + a **`seccomp` syscall denylist**; `sandbox.useKernelHardening`,
  Linux, default-off, probe-gated). The `Landlock` LSM is not used (the read-only mount namespace already
  provides its fs-confinement goal, and the LSM needs a native dep).
- **Net:** moves plugin security from "we blocked every trick we found" (soft, enumerated)
  toward "core capabilities are reached only through a permission-checked bridge, the plugin runs in a
  separate OS process (own heap/rss, host survives any crash/OOM, layered memory caps), and raw fs/net are
  proxied/trapped in the child, with an opt-in bubblewrap deprivileging layer (dropped uid/caps/
  no-new-privs/namespaces/read-only-fs + a `seccomp` syscall denylist)" — a hard process boundary plus
  guarded capabilities and a by-construction-shrunk syscall surface.

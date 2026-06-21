# Plugin Isolation (child_process / OS process) — IMPLEMENTED

> This document started life as a design *proposal* for hard plugin isolation. It is now **shipped and
> mandatory**: every plugin runs in a **separate OS process** (`child_process.fork`) behind the
> `wordjs` capability bridge. The original proposal text is kept below (sections 1–7) for the threat
> model and the rationale for *why* a hard, host-owned-capability boundary was chosen; the status
> banner that follows describes what actually shipped, and where it differs from the proposal (notably:
> there is **no in-process tier** — trusted plugins are isolated too — and the as-built isolate
> primitive is `child_process`, which gives true OS-level isolation rather than the heap-only boundary
> of the originally-shipped `worker_threads` runtime).

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
> mail, notify, adminMenu.add, cron.schedule. The dispatch is split by design: data calls travel as a
> generic `kind:'call'` IPC message that `callApi` checks against an **EXACT method allowlist**
> (`ALLOWED_BRIDGE_METHODS`: options.get/set, db.all/get/run/createTable/getType, hooks.doAction,
> fs.read/write, mail, notify, adminMenu.add, cron.schedule) — a child sends ANY method string and
> `callApi` walks it as a dotted path, so without this gate it could reach a registration method or a
> prototype-chain segment directly. **Registration** (hooks/filters, routes, shortcodes, mail-provider,
> notify-transport) flows ONLY through its own dedicated IPC kinds (`register`, `register-route`,
> `register-shortcode`, `register-mail-provider`, `register-notify-transport`), never via a generic
> `call` — so privileged surface (e.g. `provideMail`) is **deliberately absent** from the call allowlist
> (default-deny) and can't be reached past its trust gate. e2e tests cover the bridge guards, an
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
> **Two trust tiers — SERVER-SIDE, never self-declarable (`src/core/plugin-trust.ts`):**
> - **Untrusted** (the default for anything uploaded): sandboxed — DB default-denied to its own
>   `wjp_<slug>_` tables only, enforced host-side by `assertSqlAllowed` (per-plugin prefix attribution;
>   ATTACH/DETACH/PRAGMA, schema catalogs `sqlite_master`/`information_schema`/`pg_catalog`, stacked
>   statements, comma-joins, the Postgres `USING` clause and `RETURNING` are all rejected; core tables
>   `users`/`options`/`sessions`/… off-limits), non-secret options only, routes namespaced under
>   `/api/v1/plugin/<slug>/*`, and **no outbound network**. The raw socket modules
>   (`net`/`tls`/`dgram`/`http`/`https`/`http2`/`dns`) are denied by secure-require, and the
>   binding-backed globals `fetch`/`WebSocket`/`EventSource` — which the module loader can't see — are
>   trapped as throwing getters in the sandbox entry (`plugin-worker.js`). It also cannot shim the raw-
>   HTML output hooks (`wordjs_head`/`wordjs_footer`/`wp_head`/`wp_footer`); the host auth JWT cookie
>   (`wordjs_token`) is stripped from forwarded route requests and dangerous response headers
>   (Set-Cookie/CSP/HSTS/Location) are stripped from its replies; fs read/write is confined to its own
>   dir (not the shared uploads).
> - **Operator-trusted** (privileged bridge tier, gated on the trust registry, NOT a manifest perm):
>   unscoped `db.*` + `db.createTable` on core tables, `db.getType()`, read/write of secret-named
>   options, `http.route` `opts.absolute` (keep original paths, no frontend churn), `opts.multipart`
>   (host parses the upload — capped at `uploads.maxFileSize` — and forwards file metadata),
>   `provideMail(handler)`, `notify.registerTransport(name, handler)`, and raw sockets (so the SMTP
>   server isolates fine).
>
> **How trust is granted:** a plugin is trusted if EITHER it is a shipped first-party default
> (`config.trustedSystemPlugins`, currently `conference-manager` + `mail-server`) OR an admin flips its
> trust toggle in the Plugins UI. Admin-granted trust is persisted server-side in the `trusted_plugins`
> option and mirrored in memory so the bridge gates can read it synchronously. A plugin can **never**
> self-declare trust. Flipping the toggle (`POST /plugins/:slug/trust`, admin-only) **hot-reloads the
> worker** (`reloadIsolatedPlugin`) so its routes re-mount (namespaced ↔ absolute), its network policy
> re-resolves, and the host-capability gates re-evaluate — no server restart. Shipped defaults can't be
> toggled off via the UI.
>
> **AST static scanner (`acorn`, fail-closed):** every plugin is scanned at install/activate and again
> on **every boot** (re-validated to catch code poisoning); a parse failure or a dangerous call blocks
> activation. Declaring `system:admin` in a manifest does NOT skip the scan — the skip is reserved for
> plugins listed in `config.trustedSystemPlugins`.
>
> **Full teardown on unload/reload:** `unloadIsolatedPlugin` terminates the worker AND runs a teardown
> that removes every host-side registration the plugin made — Express route layers are spliced out,
> hook/filter/shortcode shims removed, a provided mail sender / notification transport unregistered, and
> its admin-menu entries dropped — so no stale shim can RPC a dead worker. Teardown is idempotent and
> also runs as a crash safety-net on worker `exit`.
>
> **Per-plugin tier (final — 7 of 8 isolated):**
> | Plugin | Tier | Why |
> |---|---|---|
> | hello-world | **isolated** | hooks only — reference |
> | test-schema | **isolated** | hooks + DB via bridge |
> | card-gallery | **isolated** | JSON routes + options + admin menu (frontend → namespaced path) |
> | photo-carousel | **isolated** | routes + options + **async shortcode** (`[carousel]`) |
> | video-gallery | **isolated** | routes + options + shortcode (`[vgallery]`) |
> | conference-manager | **isolated** | trusted: privileged DB + `db.getType` + absolute routes + portal cookies |
> | mail-server | **isolated** | trusted: SMTP server on :25 + MX delivery in the worker; Email model → `db`, DKIM via secret options, multipart upload, `provideMail` + `notify.registerTransport` |
> | ~~db-migration~~ | **moved to core (de-pluginized)** | was DB infrastructure, not a feature plugin (manages the embedded PostgreSQL *server process* via `child_process.execSync` + runs schema migrations at boot). Backend → `src/core/db-admin/` (wired in at boot, routes still `/api/v1/db-migration/*`); admin UI → native frontend route `frontend/src/app/admin/db-migration/page.tsx` reached via a permanent **core** Sidebar item (`/admin/db-migration`), NOT a toggleable plugin. Removed from `plugins/` and all generated registries. |
>
> **Net (final): the sandbox is isolated-only.** Every plugin runs in its own OS process; the legacy
> in-process execution path was removed (`loadActivePlugins`/`activatePlugin` reject non-isolated plugins,
> `deactivatePlugin` terminates the child). All feature plugins are isolated (verified in-browser
> serving real data — incl. the mail server's inbox and its SMTP listener on :25). db-migration is no
> longer a plugin at all: its backend moved into core (it manages the database server itself) and its
> admin UI is a native frontend route reached from a permanent core Sidebar item. Uploaded/untrusted
> third-party plugins isolate by default and are hard-blocked from core tables/secrets regardless of
> the permissions they request; trusted plugins get the privileged bridge capabilities.
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
> + `--max-old-space-size=256` for the JS heap. What the OS process still does **not** buy by itself is
> **capability-minimal syscall confinement**: the child has a full Node runtime, so capability denial
> still relies on the in-child guards (secure-require proxies `fs`/`child_process`/raw-net modules and
> blocks `worker_threads`/`vm`/`module`/`inspector`; the bootstrap traps `fetch`/`WebSocket`/
> `EventSource`; io-guard confines fs; the table-scoped DB confines SQL). A *novel* Node global or native
> binding that reaches the disk/network without going through those proxies would be an escape **of the
> userspace policy** (it could not escape the process or its memory cap). For by-construction,
> OS-enforced confinement, seccomp/landlock + a dropped uid can layer **on top of** the already-separate
> process, and a Windows Job Object would make the memory cap preventive on Windows too — both are
> **roadmap** (see §2/§6). An independent security audit is recommended before relying on this for
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
boundary stops (syscall confinement = roadmap).

---

## 1. Goal & threat model

**Goal:** an uploaded third-party plugin that is actively malicious cannot read/write outside its
grant, cannot execute shell commands, cannot read other plugins' or core secrets, and cannot crash
or hang the host — *by construction*, not by enumeration of blocked tricks.

**Trust tiers (as built):** the proposal originally split *untrusted = isolated* vs *trusted =
in-process*. **What shipped is different and stronger: BOTH tiers are isolated** — the difference is
purely the *capabilities the host grants over the bridge*, not the runtime. There is no in-process tier.
A trusted plugin (e.g. mail-server) runs in its own OS process and gets raw sockets, secret options and
unscoped DB *because the host bridge allows it for trusted slugs* — not because it escapes the isolate.

| Tier | Examples (today) | Runtime | Capabilities |
|---|---|---|---|
| **Operator-trusted** | conference-manager, mail-server (shipped defaults) + any admin-toggled plugin | **isolated** (OS process, `child_process.fork`) | bridge + privileged grants: unscoped DB/core tables, secret options, absolute routes, multipart, `provideMail`, `notify.registerTransport`, raw sockets |
| **Untrusted / third-party** | marketplace / uploaded plugins | **isolated** (OS process, `child_process.fork`) | bridge only: own DB tables, non-secret options, namespaced routes, NO outbound network |

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
> **OS-sandbox layer** of the gold standard (seccomp/AppArmor/landlock, dropped uid) is **not yet
> applied** — it is roadmap that can layer on top of the already-separate process. The kernel resource
> limits ARE partly in place today: an OPT-IN cgroup v2 `memory.max` (Linux, `systemd-run --user
> --scope`) and a loose `RLIMIT_AS` virtual backstop, plus a cross-platform RSS poll (see §6 and the
> status banner).

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
| `fs.readFileSync(...)` | `wordjs.fs.read(relPath)` / `write` | `filesystem:*`; paths confined to the plugin dir + uploads, realpath-checked host-side |
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
  `memory.max` (Linux), reactive cross-platform RSS poll → SIGKILL at 768 MB, loose `RLIMIT_AS`
  backstop + `--max-old-space-size=256` — plus per-RPC timeout, bridge-call rate/concurrency token
  buckets, IPC message-rate caps, payload/disk caps and registration caps. Closes the DoS class the
  in-process model can't.
- **Deactivate:** terminate (SIGKILL) the child process → all its memory/handles gone, deterministically;
  `teardown()` splices out every host-side registration it made.

### 3.3 Frontend components
Plugins ship React components under `client/` that the admin/puck UI imports today. Those are **build-
time** assets, unaffected by runtime isolation — they keep being bundled (and reviewed) as now. Only the
**backend** logic moves into the isolate.

---

## 4. Raw-capability plugins (UPDATE — they isolate too)
> The proposal assumed raw-capability plugins couldn't be isolated and would stay in-process. **That's
> not how it shipped.** A separate OS process still has a full Node runtime, so the host can simply
> *grant* raw capabilities to trusted slugs instead of exempting them from isolation. So:
- **mail-server**: runs its SMTP server on port 25 and does outbound MX delivery **inside its own OS
  process**. secure-require allows raw `net`/`tls`/`dns` for operator-trusted slugs (trust resolved
  host-side at spawn and passed in the child's config argument — `JSON.parse(process.argv[2]).isTrusted`,
  surfaced in-child as the frozen `global.__WORDJS_PLUGIN_TRUSTED__` that secure-require's net branch
  reads, re-resolved on the trust toggle via `reloadIsolatedPlugin`), and the bridge grants secret options (DKIM key), multipart
  upload, `provideMail`, and `notify.registerTransport`. Fully isolated.
- **conference-manager**: trusted → unscoped DB + `db.getType()` + absolute routes (portal cookies),
  all over the bridge. Isolated.
- **db-migration**: was **de-pluginized** — it manages the database *server process* and runs at boot,
  which is core infrastructure, not a feature plugin. Moved to `backend/src/core/db-admin/`; it is no
  longer a plugin and is not isolated (it's core).
- Any plugin needing native addons, raw sockets, or child processes is an **operator-trusted** plugin:
  isolated for crash/heap containment, but the host grants it the raw capability — the correct trust
  model (you audit what you ship / what an admin trusts; you sandbox what users upload).

---

## 5. Migration path — COMPLETED
The phased migration the proposal laid out has all landed; for the record:
1. ✅ Shipped the `wordjs` bridge API (`src/core/plugin-api.ts`), passed as `init(wordjs)`.
2. ✅ Ported the bundled plugins' backends to the bridge (galleries, hello-world, test-schema, and the
   trusted ones).
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
| **child-process + OS sandbox (seccomp/uid)** | ✅✅ (OS-enforced syscalls) | ✅✅ | higher (process + IPC) | high (= shipped child-process + roadmap kernel layer) |

**Decision (as built):** shipped the **bridge API + `child_process.fork` (separate OS process)** for
**all** plugins. The proposal leaned toward `isolated-vm`; a process was chosen instead because it has
**zero native dependencies and works on any platform** (`isolated-vm` needs a native build) while still
giving **true OS-level crash/OOM/resource isolation** — a worker_threads version shipped first but was
replaced because a worker shares the host heap/rss and an off-heap OOM in it can't be capped without
crashing the host. The remaining gap vs the gold standard is the **OS-sandbox layer** (seccomp/landlock
+ dropped uid) that would make capability denial by-construction rather than relying on the in-child
guards (secure-require module proxies + the `fetch`/`WebSocket`/`EventSource` global trap); that layer is
**roadmap** and can be added on top of the already-separate process without changing the bridge.
Kernel resource limits are partly in place today (OPT-IN cgroup v2 `memory.max`, loose `RLIMIT_AS`,
cross-platform RSS poll).

## 7. Cost & non-goals
- **Cost (actual):** the bridge API + the `child_process` OS-process isolate runner (+ layered memory
  caps) + porting the bundled plugins + the async-handler / `doShortcodeAsync` convention — all landed.
- **Non-goals:** this does not make *trusted* plugins safe (they're trusted by definition); it does not
  sandbox the frontend bundle (plugin React components are build-time assets, bundled and reviewed as
  before); it does not replace code review of first-party plugins; and a separate OS process is **not yet**
  syscall-confinement (seccomp/landlock + dropped uid are roadmap — see the residual-risk note in the
  status banner).
- **Net:** moves untrusted-plugin security from "we blocked every trick we found" (soft, enumerated)
  toward "core capabilities are reached only through a permission-checked bridge, the plugin runs in a
  separate OS process (own heap/rss, host survives any crash/OOM, layered memory caps), and raw fs/net are
  proxied/trapped in the child" — a hard process boundary plus guarded capabilities, with syscall-level
  confinement still on the roadmap.

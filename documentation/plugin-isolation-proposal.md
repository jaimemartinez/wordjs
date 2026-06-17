# Plugin Isolation (worker_threads) — IMPLEMENTED

> This document started life as a design *proposal* for hard plugin isolation. It is now **shipped and
> mandatory**: every plugin runs in a `worker_threads` isolate behind the `wordjs` capability bridge.
> The original proposal text is kept below (sections 1–7) for the threat model and the rationale for
> *why* `worker_threads` was chosen; the status banner that follows describes what actually shipped, and
> where it differs from the proposal (notably: there is **no in-process tier** — trusted plugins are
> isolated too — and the isolate primitive is `worker_threads`, not `isolated-vm`).

> **Status update (2026-06-16): IMPLEMENTED — isolated-only (mandatory), cross-platform.** The `wordjs`
> capability bridge (`src/core/plugin-api.ts`) and the isolate runtime (`src/core/plugin-isolate.ts`
> + `plugin-worker.js`, **worker_threads** — works in any environment, no native deps) are in `main`.
> Every plugin runs in a separate V8 isolate, reaching core only via the bridge over RPC; a plugin
> MUST declare `"isolated": true` and use the bridge. The **legacy in-process execution path has been
> removed** — `loadActivePlugins`/`activatePlugin` reject non-isolated plugins and `deactivatePlugin`
> terminates the worker. worker_threads gives heap / crash / resource isolation + host-owned
> capabilities everywhere; `isolated-vm` or child-process + seccomp can swap in as the primitive (same
> architecture) where the platform supports them.
>
> **Bridge surface (complete, tested):** options.get/set, db.all/get/run/createTable (core-table
> scoped), hooks.add{Action,Filter}/doAction, **http.route (host runs auth, forwards JSON over RPC)**,
> **shortcodes.add (async, RPC'd + expanded by doShortcodeAsync)**, fs.read/write (confined), mail,
> notify, adminMenu.add, cron.schedule. e2e tests cover the bridge guards, an isolated hook/filter
> over RPC, an isolated DB write, an isolated JSON route served through host Express, and an isolated
> async shortcode expanded via doShortcodeAsync.
>
> **Shortcodes (was the last blocker, now solved):** `doShortcode()` is synchronous so it couldn't
> await an isolated worker. Added `doShortcodeAsync()` (collect matches → resolve callbacks
> concurrently → splice back-to-front) and switched the content render path (`Post.toJSON`) to it.
> Isolated plugins register shortcodes via `wordjs.shortcodes.add`; the host runs a shim that RPCs the
> worker. (This also fixed a latent bug in the old in-process carousel shortcode, which read options
> without awaiting.)
>
> **Two trust tiers — SERVER-SIDE, never self-declarable (`src/core/plugin-trust.ts`):**
> - **Untrusted** (the default for anything uploaded): sandboxed — own DB tables only (core tables
>   `users`/`options`/`sessions`/… denied), non-secret options only, routes namespaced under
>   `/api/v1/plugin/<slug>/*`, and **no outbound network**. The raw socket modules
>   (`net`/`tls`/`dgram`/`http`/`https`/`http2`/`dns`) are denied by secure-require, and the
>   binding-backed globals `fetch`/`WebSocket`/`EventSource` — which the module loader can't see — are
>   trapped as throwing getters in the worker bootstrap (`plugin-worker.js`).
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
> **Net (final): the sandbox is isolated-only.** Every plugin runs in a worker; the legacy in-process
> execution path was removed (`loadActivePlugins`/`activatePlugin` reject non-isolated plugins,
> `deactivatePlugin` terminates the worker). All feature plugins are isolated (verified in-browser
> serving real data — incl. the mail server's inbox and its SMTP listener on :25). db-migration is no
> longer a plugin at all: its backend moved into core (it manages the database server itself) and its
> admin UI is a native frontend route reached from a permanent core Sidebar item. Uploaded/untrusted
> third-party plugins isolate by default and are hard-blocked from core tables/secrets regardless of
> the permissions they request; trusted plugins get the privileged bridge capabilities.
> (The host-side guards — io-guard / secure-require / appRegistry anchoring — stay: bridge calls run in
> plugin context on the host, so they're still load-bearing.)
>
> **Residual risk — be honest about what a worker is.** `worker_threads` is a **heap / V8-isolate
> boundary, not an OS sandbox.** It buys: the plugin can't touch the host's in-memory objects (secrets,
> DB handle, other plugins), a crash or `maxOldGenerationSizeMb` blow-out is contained, and the
> capability bridge is the only sanctioned path to core. It does **not** buy OS-level fs/network
> confinement: the worker still has a full Node runtime, so the sandbox relies on the in-worker guards
> (secure-require proxies `fs`/`child_process`/raw-net modules; the bootstrap traps `fetch`/`WebSocket`/
> `EventSource`) to deny capabilities. A *novel* Node global or native binding that reaches the disk/network
> without going through those proxies would be an escape. For hard, OS-enforced confinement, `isolated-vm`
> (no Node bindings) or child-process + seccomp/container can swap in as the primitive under the same
> architecture (see §2/§6). An independent security audit is recommended before relying on this for
> genuinely hostile multi-tenant input.

Status: **IMPLEMENTED** (was: proposal) · Author: WordJS · History: the original proposal followed 4
red-team passes on the *in-process* sandbox, which closed every *known* practical escape (AST scan +
runtime require proxy + ALS-anchoring of every entry point + core-module deny-list + dbAsync scoping)
but remained a **soft** boundary — plugin code shared the main-process heap, so a *novel* unanchored
entry point or a missed monkey-patch could reopen RCE. The proposal argued for a **hard** boundary
where raw Node capabilities are unreachable. What shipped is that hard boundary via `worker_threads`
(heap-isolated) for **all** plugins — see the status banner above for the as-built details and the
residual-risk note for where the worker boundary stops.

---

## 1. Goal & threat model

**Goal:** an uploaded third-party plugin that is actively malicious cannot read/write outside its
grant, cannot execute shell commands, cannot read other plugins' or core secrets, and cannot crash
or hang the host — *by construction*, not by enumeration of blocked tricks.

**Trust tiers (as built):** the proposal originally split *untrusted = isolated* vs *trusted =
in-process*. **What shipped is different and stronger: BOTH tiers are isolated** — the difference is
purely the *capabilities the host grants over the bridge*, not the runtime. There is no in-process tier.
A trusted plugin (e.g. mail-server) runs in a worker and gets raw sockets, secret options and unscoped
DB *because the host bridge allows it for trusted slugs* — not because it escapes the isolate.

| Tier | Examples (today) | Runtime | Capabilities |
|---|---|---|---|
| **Operator-trusted** | conference-manager, mail-server (shipped defaults) + any admin-toggled plugin | **isolated** (worker) | bridge + privileged grants: unscoped DB/core tables, secret options, absolute routes, multipart, `provideMail`, `notify.registerTransport`, raw sockets |
| **Untrusted / third-party** | marketplace / uploaded plugins | **isolated** (worker) | bridge only: own DB tables, non-secret options, namespaced routes, NO outbound network |

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

**Recommendation:** **`isolated-vm` for the plugin logic** (capabilities unreachable) **+ a worker or
child-process wrapper** for CPU/memory limits and crash isolation. For deployments that can afford it,
**child-process + OS sandbox** is the gold standard. Either way the architecture below is the same —
only the isolate primitive differs.

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
│        ▲  RPC (postMessage / IPC, structured-clone only — no live refs)    │
└────────┼───────────────────────────────────────────────────────────────────┘
         │   inject async fns: options.*, db.query, hooks.*, http.route,
         │   fs.read/write (plugin-scoped), mail.send, notify, adminMenu.add
┌────────▼──────────── isolate (isolated-vm / worker) ───────────────────────┐
│  plugin code — pure JS, no require/process/fs/net; only `wordjs.*`         │
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
- **Resource limits:** isolate memory cap + per-call CPU/time budget (isolated-vm supports both; or
  worker/child resource limits). Closes the DoS class the in-process model can't.
- **Deactivate:** dispose the isolate → all its memory/handles gone, deterministically.

### 3.3 Frontend components
Plugins ship React components under `client/` that the admin/puck UI imports today. Those are **build-
time** assets, unaffected by runtime isolation — they keep being bundled (and reviewed) as now. Only the
**backend** logic moves into the isolate.

---

## 4. Raw-capability plugins (UPDATE — they isolate too)
> The proposal assumed raw-capability plugins couldn't be isolated and would stay in-process. **That's
> not how it shipped.** A `worker_threads` isolate still has a full Node runtime, so the host can simply
> *grant* raw capabilities to trusted slugs instead of exempting them from isolation. So:
- **mail-server**: runs its SMTP server on port 25 and does outbound MX delivery **inside the worker**.
  secure-require allows raw `net`/`tls`/`dns` for operator-trusted slugs (trust supplied to the worker via
  `workerData → __WORDJS_PLUGIN_TRUSTED__`), and the bridge grants secret options (DKIM key), multipart
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
3. ✅ Added the isolate runner (`src/core/plugin-isolate.ts` + `plugin-worker.js`) on `worker_threads`
   (not `isolated-vm`/child-process — chosen for zero native deps / cross-platform).
4. ✅ **Flipped past the default to mandatory**: there is no longer a non-isolated path.
   `loadActivePlugins`/`activatePlugin` **reject** any plugin that doesn't declare `"isolated": true`;
   `deactivatePlugin` terminates the worker. The AST scanner runs at activate **and on every boot**.
5. ✅ Direct `require('../../src/core/...')` is gone from the bundled plugin backends — they use the bridge.

---

## 6. Trade-offs & decision

| Primitive | Capability boundary | Crash/DoS isolation | Perf cost | Complexity |
|---|---|---|---|---|
| `vm` | ❌ none | partial | low | low |
| `worker_threads` | ❌ (full Node in worker) | ✅ | medium (IPC + clone) | medium |
| **`isolated-vm`** | ✅ (no bindings) | ✅ (mem/cpu caps) | medium | medium-high (async API rewrite) |
| **child-process + OS sandbox** | ✅✅ (OS-enforced) | ✅✅ | higher (process + IPC) | high |

**Decision (as built):** shipped the **bridge API + `worker_threads`** for **all** plugins. The
proposal leaned toward `isolated-vm`; `worker_threads` was chosen instead because it has **zero native
dependencies and works on any platform** (`isolated-vm` needs a native build), at the cost of a weaker
boundary — a worker has the full Node API, so capability denial relies on the in-worker guards
(secure-require module proxies + the `fetch`/`WebSocket`/`EventSource` global trap) rather than the
bindings being absent. The architecture is primitive-agnostic: `isolated-vm` or child-process + OS
sandbox can swap in under the same bridge to get a by-construction boundary for hostile multi-tenant
deployments.

## 7. Cost & non-goals
- **Cost (actual):** the bridge API + worker isolate runner + porting the bundled plugins + the
  async-handler / `doShortcodeAsync` convention — all landed.
- **Non-goals:** this does not make *trusted* plugins safe (they're trusted by definition); it does not
  sandbox the frontend bundle (plugin React components are build-time assets, bundled and reviewed as
  before); it does not replace code review of first-party plugins; and a heap-isolated worker is **not**
  OS-level confinement (see the residual-risk note in the status banner).
- **Net:** moves untrusted-plugin security from "we blocked every trick we found" (soft, enumerated)
  toward "core capabilities are reached only through a permission-checked bridge, and raw fs/net are
  proxied/trapped in the worker" — a hard heap boundary plus guarded capabilities, short of OS isolation.

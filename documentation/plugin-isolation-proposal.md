# Design Proposal: Hard Plugin Isolation (vm / process)

Status: **proposal** · Author: WordJS · Context: after 4 red-team passes the in-process sandbox
closes every *known* practical escape (AST scan + runtime require proxy + ALS-anchoring of every
entry point + core-module deny-list + dbAsync scoping). But it remains a **soft** boundary: plugin
code shares the main process heap, so a *novel* unanchored entry point or a missed monkey-patch can
reopen RCE. This document proposes a **hard** boundary where the raw Node capabilities are simply
**unreachable** to untrusted plugin code.

---

## 1. Goal & threat model

**Goal:** an uploaded third-party plugin that is actively malicious cannot read/write outside its
grant, cannot execute shell commands, cannot read other plugins' or core secrets, and cannot crash
or hang the host — *by construction*, not by enumeration of blocked tricks.

**Trust tiers (key decision):** isolation is for **untrusted** plugins. First-party/bundled plugins
that need raw capabilities (network sockets, native addons) cannot run in a pure isolate and stay
**in-process** under the existing hardened model. This formalizes the current `trustedSystemPlugins`
allowlist into a two-tier model.

| Tier | Examples (today) | Runtime | Capabilities |
|---|---|---|---|
| **Trusted / first-party** | db-migration, conference-manager, mail-server | in-process (current hardened model) | full Node (mail-server needs `net`/SMTP) |
| **Untrusted / third-party** | marketplace / uploaded plugins | **isolated** (this proposal) | only the capability bridge |

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

## 4. What CANNOT be isolated (stays trusted / in-process)
- **mail-server**: opens an SMTP server on port 25 and makes outbound socket connections → needs raw
  `net`; an isolate denies it. Stays first-party/in-process.
- **db-migration / conference-manager**: declared `system:admin` / heavy DB → trusted, in-process.
- Any plugin needing native addons, raw sockets, or child processes. These must be **operator-approved
  first-party** code — which is the correct trust model (you audit what you ship, you sandbox what users upload).

---

## 5. Migration path (phased, non-breaking)
1. **Define + ship the `wordjs` bridge API in-process** (a thin facade over the existing core modules,
   permission-checked). Plugins *can* adopt it while still running in-process. No isolate yet.
2. **Port the bundled plugins' backend to the bridge API** where feasible (galleries, hello-world) to
   prove the API surface is sufficient; keep mail-server/db-migration on direct access (trusted).
3. **Add the isolate runner** (pick `isolated-vm` or child-process) behind a flag; run ONE simple
   untrusted plugin (e.g. hello-world) isolated end-to-end (route + option + db + hook).
4. **Flip the default**: uploaded/untrusted plugins load isolated; `trustedSystemPlugins` load in-process.
   The AST scanner + runtime proxy remain as defense-in-depth for the trusted in-process tier.
5. Deprecate direct `require('../../src/core/...')` for the untrusted tier.

---

## 6. Trade-offs & decision

| Primitive | Capability boundary | Crash/DoS isolation | Perf cost | Complexity |
|---|---|---|---|---|
| `vm` | ❌ none | partial | low | low |
| `worker_threads` | ❌ (full Node in worker) | ✅ | medium (IPC + clone) | medium |
| **`isolated-vm`** | ✅ (no bindings) | ✅ (mem/cpu caps) | medium | medium-high (async API rewrite) |
| **child-process + OS sandbox** | ✅✅ (OS-enforced) | ✅✅ | higher (process + IPC) | high |

**Recommendation:** ship the **bridge API + `isolated-vm`** for the untrusted tier (best
security/effort balance; pure-JS plugins fit naturally), keep first-party/raw-capability plugins
in-process under today's hardened model. Offer **child-process + OS sandbox** as a hardened deployment
option later.

## 7. Cost & non-goals
- **Cost:** real project, not a patch — ~the bridge API + isolate runner + porting the bundled plugins
  + an async-handler convention. Estimate: multi-week. The current hardened in-process sandbox is the
  right interim posture.
- **Non-goals:** this does not make *trusted* plugins safe (they're trusted by definition); it does not
  sandbox the frontend bundle; it does not replace code review of first-party plugins.
- **Net:** moves untrusted-plugin security from "we blocked every trick we found" (soft, enumerated) to
  "the dangerous capabilities don't exist in the isolate" (hard, by construction).

# WordJS — Product Positioning & Strategy

**Status:** Draft for owner review · **Author:** strategy working doc

---

## 1. The repositioning (one sentence)

> **WordJS is the CMS where third-party plugins can't compromise your site** — every
> untrusted plugin runs in an isolated worker and can only reach the system through a
> permission-checked capability bridge.

Everything else (posts, themes, media, menus) is table stakes. The **plugin sandbox is the
product**. We sell *safety of the plugin ecosystem*, not "WordPress, but JavaScript."

---

## 2. What the sandbox actually guarantees today (grounded in the code)

This section is deliberately honest. The differentiator is real: untrusted plugins now run in a
**separate OS process** (kernel-enforced isolation), with the JS-level guards retained as
defense-in-depth *inside* that process. We still don't oversell — the remaining hardening
(syscall filtering, hard kernel memory caps, dropped privileges) is named below.

**Architecture (implemented, in `main`, not a proposal):**
- Every plugin must declare `"isolated": true` and runs in its **own OS process**
  (`child_process.fork`, `plugin-isolate.ts` + `plugin-worker.js`) — its own heap, event loop
  and memory cap, so a crash, OOM, or heap escape is contained to the child *by the kernel*,
  never the host. The legacy in-process execution path was **removed** — `loadActivePlugins` /
  `activatePlugin` reject non-isolated plugins. Cross-platform, no native deps. (A
  `worker_threads` transport remains as a fallback; the same guards run in either.)
- The plugin reaches core **only** through the injected `wordjs` bridge (`plugin-api.ts`),
  RPC'd to the host and **permission-checked on the host side**, in the plugin's context. The
  host's heap — secrets, DB handle, other plugins — is never passed into the isolate
  (structured-clone only, no live refs).
- **Two trust tiers** (`plugin-trust.ts`), server-side, never self-declarable:
  - **Untrusted** (uploaded / marketplace): bridge only. DB scoped away from core tables
    (`users`, `options`, `sessions`, …), secret-named options blocked, routes namespaced
    under `/api/v1/plugin/<slug>`, **no outbound network**.
  - **Operator-trusted** (first-party or admin-toggled in the UI): privileged bridge —
    unscoped DB, secret options, absolute routes, mail provider, notification transport, raw
    sockets.

**Defense-in-depth, all present in code:**
- **AST static scanner** at install (`validatePluginPermissions` in `plugins.ts`, via `acorn`
  + `acorn-walk`): flags `eval` / `Function` / `exec` / `spawn`, `require()` of sensitive
  modules, dynamic/computed/obfuscated access to `process` / `global` / `require`, and
  undeclared capabilities vs. the manifest. **Fail-closed**: an unparseable source file is a
  violation. Self-declaring `system:admin` does **not** skip the scan unless the slug is
  operator-trusted.
- **Network egress trap** (`plugin-worker.js`): the binding-backed globals `fetch` /
  `WebSocket` / `EventSource` are trapped to throw for untrusted plugins; raw socket modules
  (`net` / `tls` / `dns` / `http` / `https` / …) are denied by `secure-require`. So an
  untrusted plugin gets **no exfiltration channel**.
- **`.env` / secret masking**: `io-guard` blocks reads of `.env` and secret files;
  `secure-require`'s `secureConfig()` strips any credential-like config key; the bridge's
  `PROTECTED_OPTION_RE` blocks secret-named options.
- **Module / native lockdown** (`secure-require.ts`): `worker_threads` / `vm` / `module` /
  `inspector` return inert throwing proxies; native `.node` addons, `process.binding`,
  `_linkedBinding` blocked; `fs` / `child_process` proxied and path-confined;
  `setTimeout` / `setInterval` / EventEmitter listeners re-anchored to plugin context so a
  plugin can't strip its sandbox by deferring to a later tick.
- **DoS containment**: process separation (a child OOM / crash / infinite loop cannot take
  down the host — the host event loop is in a different process), a JS-heap cap
  (`--max-old-space-size`), an opt-in **preventive cgroup `MemoryMax`** per child on systemd Linux
  (`systemd-run --user --scope`, probe-gated) with a host-side **RSS poll** default/fallback elsewhere
  (Linux `/proc`, Windows `tasklist`, macOS `ps` → `SIGKILL`) and a loose `RLIMIT_AS` backstop,
  per-child bridge-call rate + message-rate caps, RPC timeouts with wedged-child recycling, bounded
  in-flight calls, inbound/outbound payload caps, fs-write disk quota.

**Residual gaps (state these plainly — they shape the roadmap):**
- It is now **OS process isolation**, but not yet *fully* locked down at the kernel surface.
  The child runs with the full Node API and a normal OS uid; `fs` / `child_process` inside the
  child are still narrowed by **JS-level proxies** (defense-in-depth), so a missed proxy could
  let the child do — *within its own process* — more than its manifest declares. It can no
  longer reach the host heap or crash the host, but it isn't yet capability-minimal at the
  syscall level.
- The per-child memory cap is layered: (a) **preventive** — on systemd Linux each child can run in a
  transient **cgroup v2 scope with `MemoryMax`** (`systemd-run --user --scope`, no root; operator
  opt-in via `sandbox.useCgroupMemoryCap` and additionally probe-gated so it only activates where
  spawn+IPC+teardown verify on that host), so the kernel OOM-kills *only* the offending
  child by construction the instant its resident set exceeds budget; (b) **reactive fallback** where
  cgroups aren't available (Windows, macOS, non-systemd) — a host-side **RSS poll** (Linux `/proc`,
  Windows `tasklist`, macOS `ps`); (c) a loose **`RLIMIT_AS`** virtual backstop (V8's ~4 GB cage makes
  a box-tight virtual cap infeasible, so this only bounds pathological allocation). The remaining gap
  is a **preventive** cap on **Windows** (a Job Object — needs a native helper, not pure-JS) and on
  non-systemd Linux; there the reactive poll + process separation apply.
- The strongest remaining hardening — **syscall filtering (seccomp / landlock), dropped uid,
  containers / cgroups** so the child's OS capabilities shrink "by construction" — is **not yet
  built**; it now layers cleanly on top of the already-separate process.
- The model has had several red-team passes (8 rounds) plus the OS-isolation pivot; it has
  **not had an independent third-party audit**.

**Honest one-liner for the sandbox:** *"Untrusted plugins run in a separate OS process with
defense-in-depth capability guards — materially stronger than any in-process plugin model on
the market — with a clear, documented path to full kernel-level hardening (seccomp, cgroups,
dropped privileges)."* We lead with that, not with "unbreakable."

---

## 3. Target segments (who actually pays for this)

The generic "WordPress alternative" buyer does **not** care about plugin isolation. These
three do:

1. **Security-conscious orgs** (regulated, gov, fintech, healthcare, internal tools): they
   currently *can't* let marketing install plugins because every WordPress plugin is
   full-trust RCE. Our pitch: "install third-party plugins without granting them your
   database and secrets."
2. **Agencies running client-supplied / third-party plugins**: one bad plugin on a shared
   box compromises every client site. Per-plugin isolation + a "safe to install" review
   pipeline is a direct liability reducer they can resell.
3. **Multi-tenant hosters / SaaS-on-CMS**: they need *per-tenant* and *per-plugin*
   containment as a platform primitive. Today they bolt on containers per site; we make
   plugin isolation native, so they can offer a marketplace without each plugin being a
   tenant-escape risk.

Secondary: **plugin developers** who want a credible, capability-declared distribution
channel (the marketplace) where "sandboxed" is a feature buyers pay a premium for.

---

## 4. Why this beats the "WordPress clone" framing

- **WordPress's plugin model is its greatest weakness, sold as a strength.** Every plugin
  runs with full DB + filesystem + network trust; plugin supply-chain compromise is one of
  the most common CMS breach vectors. "WordPress but in JS" inherits that liability and
  competes on a 20-year head start we can't win.
- **A clone competes on ecosystem size (we lose) and on price (race to zero).** Repositioning
  competes on **trust and risk reduction** — a dimension where WordPress structurally
  *cannot* follow without breaking its entire plugin-compatibility promise.
- **It gives us a defensible moat and a reason to charge.** "Safe plugins" is a paid trust
  badge + managed hosting story, not a free-CMS commodity.
- **It focuses the roadmap.** Instead of chasing WP feature-parity forever, we invest in the
  one thing that's genuinely ours: the sandbox, the scanner, the marketplace review pipeline.

---

## 5. The curated marketplace (the commercial core)

The sandbox + AST scanner are the *enabling technology* for a marketplace where **"safe to
install" is a verifiable claim**, not a vibe.

- **"Sandboxed & Reviewed" trust badge.** A plugin earns it by: (a) passing the AST static
  scan clean (fail-closed), (b) running untrusted-tier (no privileged bridge, no raw network,
  core tables off-limits) — verified, not self-declared, and (c) passing human review of its
  capability manifest. Untrusted-tier plugins are *structurally* prevented from touching
  `users` / `options` / secrets regardless of the permissions they request.
- **Capability-manifest disclosure to buyers.** Because the bridge is permission-checked and
  the manifest is the source of truth, we render a plain-language "this plugin can: read
  settings, write its own tables, render a shortcode — it CANNOT: read your users, access
  secrets, make network calls" panel *before install*. This is the App-Store-permissions
  experience CMSs have never had.
- **Review pipeline (mostly automated).** AST scan on upload → capability diff on every
  version bump (flag a plugin that newly requests `network` / `filesystem` / absolute routes)
  → human spot-check for badge tier. The scanner does the heavy lifting; humans gate the
  badge.
- **Tiering as a product surface.** "Untrusted (sandboxed)" is the default and the
  safe-to-install majority. "Operator-trusted" plugins (raw network, system) are clearly
  marked, require explicit operator opt-in via the admin trust toggle, and carry a heavier
  review + warning — the UI already warns what trust grants.
- **Revenue:** marketplace take rate; "Verified Sandboxed" as a paid developer badge;
  private/internal marketplaces for enterprise.

---

## 6. The hosted / managed offering

A managed WordJS where **the sandbox is the headline feature**, not an implementation detail.

- **"Managed CMS where every plugin is contained."** Customers install from the curated
  marketplace; we guarantee untrusted plugins run sandboxed, can't egress, can't touch
  secrets or core tables.
- **Per-tenant isolation** layered on top of per-plugin isolation: each tenant is its own
  container, and within it every plugin is already its own OS process. Defense in depth: even a
  plugin escape is contained to one process, and even a process escape to one tenant.
- **Operator controls as the value prop:** the trust toggle, capability visibility,
  per-plugin resource caps, crash isolation (a runaway plugin can't take the site down), and
  an audit of what every plugin is allowed to do.
- **This is where the kernel-level hardening lands first.** Per-plugin OS-process isolation
  ships in OSS; the hosted environment is where we add **seccomp / landlock, cgroup memory
  caps, and dropped uid** on top of it, so "by construction" capability-minimal isolation
  becomes a real, sellable tier of the managed product before it's everywhere in OSS.

---

## 7. What to cut or demote from core (to make the thesis credible)

The repositioning only works if the core is **small, auditable, and obviously about the
sandbox**. Today the core carries heavyweight infrastructure that dilutes the story and
enlarges the trust surface:

- **Mail / MTA → optional operator-trusted plugin.** The mail-server runs an SMTP listener on
  :25 + outbound MX / DKIM delivery — it *needs* raw sockets, so it's already operator-trusted
  and isolated. It should ship as an **optional add-on**, not a core dependency. Direct-MX
  deliverability is an ops liability most users don't want in core.
- **ACME / cert-manager → out of core.** TLS issuance is a deployment concern (reverse proxy /
  hosting layer), not CMS core.
- **Embedded PostgreSQL → out of core.** Bundling and auto-starting an embedded PG *server
  process* (via `child_process`) is a large native / ops surface that contradicts "small
  auditable core." Make it a dev-convenience / managed option, not a default.
- **Pick ONE database.** The code ships multiple drivers (`sqlite-legacy`, `sqlite-native`,
  `postgres`) with fallback logic. Standardize on **Postgres** (the serious,
  multi-tenant-capable target) for the product; keep SQLite as a dev-only convenience at most.
  Multiple DB paths multiply the test / security matrix for zero positioning value.
- **General principle:** anything requiring **operator-trust / raw capabilities** should be an
  *optional, clearly-marked add-on*, so the **default install is the sandboxed, minimal-trust
  core** the whole pitch rests on. The smaller the trusted core, the more credible "your
  plugins can't compromise you."

---

## 8. Honest risks & what's missing to get there

| Risk / gap | Why it matters | What we do about it |
|---|---|---|
| **Ecosystem from zero** | The marketplace pitch needs plugins; we have a handful of first-party plugins and no third-party authors. A safe marketplace with nothing in it sells nothing. | Seed with high-quality first-party + a paid early-developer program; lead with *internal / agency* private marketplaces (don't need scale to be valuable). |
| **Kernel-surface hardening gap** | Plugins now run in a separate OS process (host-crash / heap-escape closed), but the child still has the full Node API + normal uid; capability-minimality at the syscall level isn't built yet. A skeptical security buyer will probe this. | Add seccomp / landlock + cgroup caps + dropped uid on the **hosted tier first**; message §2 honestly; never claim "unbreakable." |
| **No independent audit** | Self-asserted security doesn't sell to the exact segment we target. Several internal red-team passes ≠ external sign-off. | Commission a third-party pentest / audit of the sandbox; publish results + a public threat model. Make "independently audited" a marketing milestone. |
| **AST scanner is pattern-based** | A static scanner can be evaded; it's a filter, not a proof. Over-reliance in the badge claim is a liability. | Position the scanner as *one layer*; the runtime bridge + untrusted-tier enforcement is the real boundary. Keep fail-closed; expand coverage; treat scan-clean as necessary-not-sufficient for the badge. |
| **License** *(resolved)* | A commercial marketplace + hosted offering needs a license that permits monetization. | **Done:** the project is now consistently **MIT** (no copyleft prod deps; see `THIRD-PARTY-NOTICES.md` + the CI license gate). Optionally revisit a source-available (BSL-style) license later if a hosted clone becomes a threat. |
| **Trust-tier UX is a footgun** | The whole model collapses if operators casually flip plugins to "trusted." | Make the trust toggle high-friction, well-warned (already warns), and audited; default everything to untrusted; surface the capability diff on every grant. |
| **Repositioning abandons a known category** | "WordPress alternative" is at least a search term people use. "Secure plugin CMS" is a category we have to teach. | Lead with the concrete pain ("plugins are how CMSs get breached"), target the three segments in §3 who already feel it, don't try to convert the generic WP migrator on day one. |

---

### Bottom line

The sandbox is **genuinely differentiated and genuinely implemented** — isolated workers, a
permission-checked bridge, non-self-declarable trust tiers, a fail-closed AST scanner, and
network / secret / core-table lockdown. It is **not** OS-level isolation, and we win by being
honest about that while shipping the curated marketplace and hosted offering that turn "your
plugins can't compromise your site" into the product. The work to get there is **ecosystem,
an external audit, the OS-level isolation primitive on hosted, and a deliberately shrunken
trusted core** (cut MTA / ACME / embedded-PG, pick one DB). The license question is resolved
(MIT).

---

**Key source references** (for anyone extending this doc):
- `backend/src/core/plugin-isolate.ts` — worker host, RPC, trust-gated capabilities, teardown
- `backend/src/core/plugin-worker.js` — isolate bootstrap, network egress trap, in-worker guards
- `backend/src/core/plugin-api.ts` — the `wordjs` capability bridge, permission checks, SQL/option/path scoping
- `backend/src/core/secure-require.ts` — module/native/network lockdown, config & DB scrubbing, context anchoring
- `backend/src/core/plugin-trust.ts` — trust tiers (server-side, non-self-declarable)
- `backend/src/core/plugins.ts` (`validatePluginPermissions`) — AST static scanner (acorn, fail-closed)
- `backend/src/core/io-guard.ts` — `.env` / secret-file fs backstop
- `documentation/plugin-isolation-proposal.md` — the soft-vs-hard boundary analysis

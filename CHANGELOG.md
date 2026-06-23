# Changelog

All notable changes to WordJS are documented here. This project follows
[Semantic Versioning](https://semver.org/). Each release is published as a pre-compiled bundle
on the [Releases](https://github.com/jaimemartinez/wordjs/releases) page.

## [Unreleased]

Focus: **a single sandboxed plugin model — the "trusted" tier is gone.** Every plugin runs in the
OS-process sandbox; capabilities are admin-granted per plugin (Android-style, default-deny). No plugin
bypasses the sandbox anymore. This builds on the move from a worker-thread (heap) boundary to a separate
OS process, and ten adversarial red-team rounds' worth of findings.

This window also folds in three **self-audit remediation cycles** (a whole-project adversarial review
of sandbox egress, auth/access, XSS, data integrity, injection, mail, and deploy/ops, then the fixes
below). WordJS remains pre-production and **self-audited, not independently audited** — these are our
own findings and fixes; see the [README](README.md) for the honest maturity caveats.

### Added

- **Theme UI framework (Bootstrap-like, token-driven).** Themes now share one stylesheet
  (`backend/public/css/wordjs-ui.css`) that auto-styles **every** standard HTML element and ships
  Bootstrap-compatible **components** (`.btn`/`.card`/`.alert`/`.badge`/`.table`/`.nav`/`.list-group`/
  `.pagination`/`.modal`/grid…) and a **utility** layer (spacing/display/flex/text/colors/borders/
  sizing…). Everything is driven by `--wjs-*` design tokens, so a theme re-skins the entire framework
  just by declaring tokens in its `:root` — colors, typography scale, spacing, radius, shadows. Loaded on
  public pages **and the editor preview** (WYSIWYG), never the admin UI; the theme stylesheet loads after
  the framework so a theme's own rules always win. All 14 bundled themes ship a full canonical token set
  tuned to their palette (light/dark/mono/glass/brutalist). See `documentation/theming.md`.
- **`noImplicitAny` is now enforced (CI-gated).** Every implicit-any site in the backend (~1,276 across
  92 files) is annotated — real types where locally determinable (Express `Request`/`Response`/
  `NextFunction`, primitives, model/array element types), explicit `any` only at genuinely dynamic
  boundaries (plugin payloads, RPC/hook glue, request bodies). The pass was **type-only** (annotations
  and `as` casts erase at compile time, so runtime is unchanged — verified by transpiling every changed
  file before/after and confirming byte-identical JS), so it introduces no behavior change. The strict
  core (`strictNullChecks`, `strictFunctionTypes`, etc.) was already enforced; the only remaining strict
  sub-flag deliberately off is `useUnknownInCatchVariables`.
- **Opt-in kernel hardening of the plugin sandbox (Linux, default-off).** With
  `config.sandbox.useKernelHardening`, each isolated plugin child runs through bubblewrap as an
  unprivileged uid with all Linux capabilities dropped, `no-new-privs`, PID/IPC/UTS namespaces, a
  read-only filesystem (app root writable), **and a seccomp-bpf syscall denylist** (ptrace, mount,
  kexec, `*_module`, bpf, keyctl, userfaultfd, setns, `process_vm_*`, … → EPERM; x86_64 also denies the
  x32 ABI). Probe-validated per host, composes with the memory caps, network preserved — zero regression
  on single-node / Windows / macOS. The Landlock LSM is intentionally not used (the read-only mount
  namespace already provides its filesystem confinement). Validate with `verify-sandbox-hardening.js`.
- **Preventive memory cap on Windows (Job Object, default-on).** Each isolated plugin child is assigned
  to a Windows Job Object with `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (768 MB) — the Win32 analog of the Linux
  cgroup `memory.max` — so the kernel fails any over-budget commit instead of only the reactive RSS poll
  catching it after the fact. Implemented with a one-shot PowerShell P/Invoke (**pure-JS, no native
  dependency**) that assigns the already-forked child by PID (the fork IPC channel is untouched) then
  exits; the job and its limit persist for the child's lifetime via the kernel job refcount. Probe-gated
  with graceful fallback to the RSS poll (the brief post-fork assign window is covered by that poll,
  exactly as before); opt out via `config.sandbox.useJobObjectMemoryCap=false`. No-op (zero regression)
  on Linux/macOS, where the cgroup/RSS-poll caps are unchanged.
- **Live cross-node plugin activate/deactivate propagation (multi-node).** Activating or deactivating a
  plugin on one node now propagates to the others over Redis (`wordjs:plugin-changed`): each node
  loads/unloads that one isolated plugin live (forked child + routes/hooks/menus) — no rolling restart.
  No-op on single-node. (Cross-node role/option coherence and the `active_plugins` distributed lock were
  already in place.)

### Changed

- **One plugin model: every plugin is sandboxed; capabilities are admin-granted per plugin.** The binary
  trusted/untrusted split is replaced by a single Android-style model — a manifest *requests*
  capabilities, an admin *grants* each one per plugin (default-deny), and a bridge call works only if the
  capability is BOTH declared in the manifest AND granted. First-party plugins (`mail-server`,
  `conference-manager`, the galleries, …) are **pre-granted** their declared capabilities for a working
  out-of-box experience, but they are **not privileged** — they run in the same sandbox under the same
  grant checks as anything uploaded. There is no trust bypass.
- **Plugin sandbox is OS-process isolation.** Every (`"isolated": true`) plugin runs in a **separate OS
  process** (`child_process.fork`) instead of a `worker_threads` Worker. A child has its own heap, event
  loop, and memory; a crash, OOM, or heap escape is contained to the child and can no longer take down the
  host. The plugin reaches core only through the permission-checked `wordjs` bridge (over IPC,
  structured-clone). A `worker_threads` transport remains as a fallback.

### Removed

- **The entire "trusted" plugin tier and its bypass machinery.** Removed `plugin-trust.ts`,
  `config.trustedSystemPlugins`, the `__WORDJS_PLUGIN_TRUSTED__` child flag, the `system:admin`
  AST-scan-skip, and the admin **trust toggle** (`POST /plugins/:slug/trust`, the `trusted_plugins`
  option). No plugin can be marked trusted, and nothing exempts a plugin from the sandbox or the AST
  scanner.
- **Raw/unsafe capabilities that no plugin can be granted anymore:** shell / `child_process` exec, native
  addons (`dlopen`), AST-scan skip, raw cookie jar / verbatim `Set-Cookie`/`CSP`/`HSTS`/`Location`,
  raw-HTML hooks (`wordjs_head`/`wordjs_footer`), unscoped / core-table DB access, and secret-named
  options. These are gone for **every** plugin — they are no longer reachable through any grant or tier.

### Added

- **Android-style per-plugin permissions (admin-controlled, default-deny).** A plugin's manifest now
  only *requests* capabilities; an operator GRANTS each one per plugin via toggles in `/admin/plugins`,
  and a bridge capability works only if it is BOTH declared in the manifest AND granted by the admin
  (`core/plugin-permissions.ts`, option `plugin_grants`). New grant tokens: **`users:read`** (a safe user
  projection), **`email:provider`**, **`notifications:provider`**, and **`network`** (outbound access,
  with an exfiltration warning). New endpoint `POST /plugins/:slug/permissions`, and a one-time
  grandfather of already-active plugins on upgrade so the switch to default-deny is non-breaking.
- **New safe bridges (the in-sandbox replacements for the removed privileged surface):**
  - `wordjs.users.{findByEmail,findByLogin,findById,search}` — gated on `users:read`, returns a **safe
    projection** `{id, userLogin, username, userEmail, displayName, role}` only (never `user_pass` or any
    other credential field).
  - `wordjs.site.{url, domain, adminEmail}` — gated on `settings:read`.
  These give plugins the user/site data they legitimately need without ever exposing core tables or
  secrets, so the previously trust-only use cases are met from inside the sandbox.
- **Layered per-child memory caps.** A reactive host-side RSS poll that SIGKILLs a child over budget on
  every platform (Linux `/proc`, Windows `tasklist`, macOS `ps`), a loose `RLIMIT_AS` virtual backstop,
  and an **opt-in preventive cgroup v2 `MemoryMax`** on systemd Linux (`config.sandbox.useCgroupMemoryCap`,
  applied via `systemd-run --user --scope`, probe-gated). New config: `sandbox.useCgroupMemoryCap`,
  `sandbox.addressSpaceCapMb`.

### Security

- **Bridge-call allowlist** — the IPC `call` dispatcher now default-denies any method outside an exact
  allowlist, so a malicious child can't reach registration/privileged methods past their dedicated gates.
- **DB scoping** hardened: per-plugin `wjp_<slug>_` prefix attribution rejects ATTACH/PRAGMA, schema
  catalogs, stacked statements, comma-joins, and the Postgres `USING`/`RETURNING` exfil path; core tables
  off-limits. `io-guard` now blocks plugin reads of the database files.
- **Route hardening** for **all** plugins (there is no privileged exemption): plugin routes are always
  namespaced under `/api/v1/plugin/<slug>`, the host auth JWT cookie (`wordjs_token`) is stripped from
  forwarded requests, and `Set-Cookie`/CSP/HSTS/Location and plugin-set cookies are sanitized/namespaced.
  Raw-HTML hooks (`wordjs_head`/`wordjs_footer`) are denied to every plugin. Mail/notification providing
  is now a grantable bridge capability (`email:provider` / `notifications:provider`), still sandboxed —
  not a trust-tier privilege.
- **DoS containment**: per-child bridge-call rate + global IPC message-rate caps, inbound/outbound
  payload caps, `fs.write` size + per-plugin disk quota, admin-menu caps, wedged-child recycling.
- AST scanner extended (dynamic `import()`, `.constructor`, `process`/`global` aliasing); cross-tenant
  uploads read closed; activation-time host-RCE via plugin test files closed.
- **Network grant is confined to PUBLIC destinations only** (`core/egress-guard.ts`). When a plugin is
  granted `network`, its outbound connections are validated AT CONNECT TIME (anti-DNS-rebinding) across
  `net`/`tls`/`http`/`https`/`http2`/`dgram` and the global `fetch`/`WebSocket`: loopback, link-local
  (incl. `169.254.169.254` cloud metadata), RFC1918, CGNAT (`100.64.0.0/10`), IPv6 ULA/loopback,
  IPv4-mapped-v6, multicast and unspecified ranges are blocked, and an unresolvable/garbage host
  **fails closed**. IPC / unix-socket / named-pipe targets (e.g. the `path` option, `/var/run/docker.sock`)
  are denied outright. Redirects are followed by native `fetch`, and **every hop is IP-validated at
  connect time** by the locked socket chokepoint (next bullet) — so a redirect to a private/metadata
  host is blocked at the socket layer, not by re-parsing the URL.
- **Egress chokepoint locked inside the isolated child (EG-1).** The guard patches
  `net.Socket.prototype.connect` in the child as the single enforcement point and **locks it**
  (non-writable, non-configurable) so a plugin cannot reassign or un-patch it to restore raw SSRF; it
  covers the `net.Stream` alias, the `getPrototypeOf(Socket.prototype).connect` bypass, and the
  pre-normalized `[options, cb]` connect-arg array. The connect `host`/`hostname`/`path` are snapshotted
  once, validated, then frozen as own data-properties (TOCTOU defense). Unix-socket and `dgram` egress
  to a private/blocked target are denied.
- **Account-takeover / privilege-escalation guards on `PUT /users/:id`.** A non-administrator can no
  longer edit an administrator account (AUTH-1) or change their **own** role; a `promote_users` delegate
  cannot assign the `administrator` role, nor any custom role that grants `*` or a capability the caller
  does not already hold (privilege amplification, AUTH-A1); the requested role is validated against the
  roles allow-list.
- **CSRF check fails closed when both `Origin` and `Referer` are absent (AUTH-A2).** A header-less,
  cookie-authenticated state change is now rejected unless it carries a real `Bearer` token
  (server-to-server) — this path previously failed open. The allowed-origin comparison is an exact
  normalized-origin match (never a prefix `startsWith`).
- **Per-account login lockout (AUTH-A3).** Login now throttles by ACCOUNT (in addition to per-IP) after
  repeated failures, backed by the shared rate-limit store with a byte-identical in-memory fallback; a
  Redis error never blocks login.
- **`GET /posts?status=any` BOLA closed.** A non-privileged user can no longer list other users'
  drafts/pending/private posts — unpublished statuses are scoped to the caller's own author id unless
  they hold `edit_others_posts`/`read_private_posts`.
- **Value-based Puck page-tree (`_puck_data`) sanitizer (`core/sanitize-meta.ts`, shared).** Every
  non-HTML string leaf now runs through a URL-scheme filter that blanks `javascript:`/`data:`/
  `vbscript:`/`file:` (incl. control-char obfuscation), so a URL prop outside any key-name allow-list
  (e.g. `buttonLink`) can no longer carry a script URL; `_puck_data` arriving as a JSON STRING is
  parsed → sanitized → re-stringified. The same code is used by `routes/posts.ts` and the WXR importer.
- **Menu item URLs are scheme-validated on create AND update (`routes/menus.ts`, XSS-03).**
  `javascript:`/`data:`/`vbscript:` become `#`, and a protocol-relative `//host` URL is neutralized to
  `#` (open-redirect closed).
- **Frontend sanitizer + CSP hardening.** The server-side sanitizer (`lib/sanitize.ts`) now drops
  `<style>` and any non-allowlisted `<iframe>`, restricts embeds to a YouTube/Vimeo **host** allow-list,
  and forces a `sandbox` attribute on every surviving iframe (FE-XSS-02). The Next.js CSP
  (`next.config.ts`) sets `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, and a
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:`. `blob:` is REQUIRED — the admin loads
  each plugin's frontend bundle via `import(URL.createObjectURL(blob))` (without it: no plugin UIs/icons)
  — and `https:` in `font-src`/`style-src` is needed for theme fonts/CSS inside the Puck `srcdoc` iframe.
- **SQL-injection hardening on `custom_tables` import (`core/import-export.ts`, SQLI-01).** Each table
  and column name is validated against a strict simple-identifier allow-list, and core tables plus
  `sqlite_*` reserved tables are refused before any identifier is interpolated.
- **Comment parent validation (`routes/comments.ts`, VAL-01).** A reply must reference a parent comment
  that exists AND belongs to the same post (thread-spoofing / cross-post linking closed).
- **Mail server hardening.** Inbound SPF/DNSBL checks default ON and fail closed for external senders;
  outbound direct-MX delivery is IP-pinned into nodemailer (anti-rebinding, with the real MX hostname
  kept as `tls.servername`); DKIM/relay secrets are AES-256-GCM at rest (root key
  `plugins/mail-server/data/.mailenc`, `0600`, with a clear operator error on decrypt failure). An
  operator-configured relay/smarthost is EXEMPT from the public-only SSRF pin (internal/LAN smarthost
  works), and `requireTLS` defaults ON but is opt-out via `mail_relay_require_tls` for a TLS-less
  internal relay (REG-2). `/classification/train` is scoped to its owner, attachment filenames are
  Content-Disposition-encoded, and thread access uses an exact-thread match.
- **Deploy/ops hardening.** A one-time **install token** gates the pre-install `/install` and `/test-db`
  endpoints (printed to the console and mirrored to a `0600` file in the data dir; a `WORDJS_INSTALL_TOKEN`
  override must be ≥16 chars; cleared after setup). `scripts/make-release.js` excludes `*.db`/`*.sqlite`,
  `certs/`, `*.pem`/`*.key`, `*.mailenc`, `plugins/<slug>/data/`, and config backups from release ZIPs.
  Prometheus `/metrics` returns `404` unless a scrape token is configured (`config.metrics.token` /
  `METRICS_TOKEN`). Frontend `metadataBase`/canonical URLs now derive from the configured site URL
  instead of the raw `X-Forwarded-Host` header (FE-SSR-01, SEO/OG poisoning).

### Fixed

- **Atomic transactions on every driver (DATA-TX-01).** `transaction(fn)` is atomic across drivers; the
  SQLite drivers serialize transactions through a promise-chain mutex, a re-entrant `transaction()` call
  throws fast instead of deadlocking, and the open-transaction flag is reset on both commit and rollback.
- **UNIQUE indexes for `users` (login / `LOWER(email)`) and `posts` (`post_name`+`post_type`)
  (DATA-USR-01).** A defensive migration logs any pre-existing duplicates and attempts each index in its
  own try/catch, so it NEVER aborts boot; `User.update` maps a unique-email violation to a clean
  "Email already in use" error instead of a raw 500.
- **Notifications IDOR closed while broadcasts stay dismissable (REG-1).** `markAsRead`/`delete` are
  scoped `WHERE uuid = ? AND (user_id = ? OR user_id = 0)`, so a user can only act on their own
  notification while broadcast notifications (`user_id = 0`) remain dismissable by anyone.
- **Roles cache write-coherence.** The roles cache self-heals on a short TTL, and a local-write epoch
  stops a stale TTL refresh from clobbering a just-written change (DATA-05). (Cross-node roles
  coherence, DATA-COH-01, remains DEFERRED.)

## [1.1.0] - 2026-06-20

Focus: a redesigned, WYSIWYG **visual editor** (Puck) that beats a classic block editor on UX
and matches the live site exactly.

### Added

- **In-place rich-text editing** (`InlineTiptap`). Text and heading blocks are edited directly
  on the canvas with a floating toolbar — bold, italic, underline, strikethrough, links, and
  lists — so the editing surface looks identical to the rendered block.
- **Text color picker** with a swatch palette, a visual custom-color picker (no native OS
  dialog), and an **eyedropper** to sample any color from the page/screen.
- **Font controls**: pick from the **fonts installed in WordJS**, set **font size**, and set
  **text alignment** (left / center / right / justify).
- **Accurate responsive preview.** A device switcher (desktop / tablet / mobile) renders the
  canvas in an isolated iframe at the true device width, so Tailwind breakpoints evaluate as on
  the live site. Desktop is full-bleed; tablet/mobile show a scaled device frame.
- **Searchable block inserter** with categories, one-click **section patterns** (intro,
  services, pricing, testimonials, FAQ, CTA), and an empty-canvas onboarding.
- Loading skeleton for the editor routes.

### Changed

- The editor canvas now renders in an **iframe** for true WYSIWYG — the page's own styles,
  fonts, and fixed header / scroll behave exactly as on the live site.
- A thin, subtle scrollbar is used inside the preview instead of the chunky browser default.

## [1.0.0] - 2026-06-18

Initial public release: JavaScript-native CMS with a worker-thread plugin sandbox, real SSR
public site, Puck visual builder, dynamic roles/permissions, WordPress (WXR) importer,
SQLite/PostgreSQL with a migration system, gateway + monolith run modes, ACME TLS, and
downloadable pre-compiled release bundles. See the [README](README.md) for the full feature set.

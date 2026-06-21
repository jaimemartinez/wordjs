# Changelog

All notable changes to WordJS are documented here. This project follows
[Semantic Versioning](https://semver.org/). Each release is published as a pre-compiled bundle
on the [Releases](https://github.com/jaimemartinez/wordjs/releases) page.

## [Unreleased]

Focus: **a single sandboxed plugin model — the "trusted" tier is gone.** Every plugin runs in the
OS-process sandbox; capabilities are admin-granted per plugin (Android-style, default-deny). No plugin
bypasses the sandbox anymore. This builds on the move from a worker-thread (heap) boundary to a separate
OS process, and ten adversarial red-team rounds' worth of findings.

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

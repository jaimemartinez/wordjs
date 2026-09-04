# WordJS CLI Toolkit 🛠️

WordJS includes several utility scripts in `backend/cli/` plus a set of `npm` scripts in `backend/package.json` for building, running, and maintaining the backend.

> **Runtime model:** The backend is TypeScript. For **production** it now **compiles**: `npm run build` (`tsc -p tsconfig.build.json`) emits `dist/`, and `server.js` runs `dist/index.js` when that build exists. `ts-node` is used only in **development** (or when `dist/` hasn't been built yet) — `server.js` falls back to `node -r ts-node/register src/index.ts`. The strict core is enforced (`strictNullChecks`, `strictFunctionTypes`, `strictPropertyInitialization`, etc.), `noImplicitAny: true` is now **enforced**; one sub-flag remains **off**: `useUnknownInCatchVariables: false` (catch bindings stay `any`).
>
> **CLI scripts and ts-node:** any `cli/*` script that imports core modules (e.g. `require('../src/config/database')`, which resolves to `.ts`) must be run with ts-node registration, e.g. `node -r ts-node/register cli/force-sync-roles.js`. Scripts that only use plain dependencies (e.g. `check_plugins.js`, which uses `better-sqlite3` directly) run with plain `node`. **`cli/wordjs.js` is the exception**: its theme commands need `core/theme-compile` / `theme-derive` / `theme-doctor` / `stitch-import` / `theme-verify`, and it resolves them itself (`loadCore()`, per module) — preferring the compiled `backend/dist/core/*.js` (what production runs) and calling `require('ts-node').register({ project: backend/tsconfig.json, transpileOnly: true })` only when that build is absent. Run it with plain `node` either way; it fails with *"ts-node not found — run `npm install` inside backend/ (or `npm run build`) first"* if neither is available.

## 1. npm Scripts

Run from `backend/`.

| Script              | Command                                          | Purpose                                                              |
| :------------------ | :----------------------------------------------- | :------------------------------------------------------------------ |
| `npm start`         | `node server.js`                                 | Production launcher (supervisor). Runs `dist/index.js` if built, else falls back to ts-node. |
| `npm run dev`       | `node --watch-path=./src -r ./scripts/dev-env.js -r ts-node/register src/index.ts` | Development server with auto-reload via ts-node. The `dev-env.js` preload forces `NODE_ENV=development` (unless already set) so the split-mode dev backend accepts the localhost frontend's credentialed CORS. |
| `npm run build`     | `tsc -p tsconfig.build.json`                      | Compile TypeScript to `dist/` for production (runs `clean` first).  |
| `npm run clean`     | removes `dist/`                                   | Wipe the compiled output (also runs automatically before `build`).  |
| `npm run typecheck` | `tsc --noEmit`                                    | Strict type-check with no emit (also run in CI).                    |
| `npm test`          | `node ../scripts/test-with-flake-retry.mjs --test-force-exit --test-concurrency=1 -r ts-node/register/transpile-only src/tests/*.test.ts` | Run the unit test suite (includes the DB **driver conformance** suite). The repo-root `scripts/test-with-flake-retry.mjs` wrapper spawns `node --test` with these arguments and re-runs the suite (at most 2 retries) **only** when every `not ok` in the run is the known `--test-force-exit` deserialize flake (`Unable to deserialize cloned data`); any real assertion failure is surfaced on the first attempt and never retried. ts-node runs in `transpile-only` mode here (no type-checking) — type errors are the job of `npm run typecheck`. |
| `npm run test:integration` | `node ../scripts/test-with-flake-retry.mjs --test-force-exit -r ts-node/register src/tests-integration/*.test.ts` | Multi-node / endpoint integration tests (run in CI against real `postgres:16` + `redis:7`). Same flake-retry wrapper as `npm test`. |
| `npm run test:multinode` | `node ../scripts/test-with-flake-retry.mjs --test-force-exit -r ts-node/register src/tests-integration/multinode-coherence.integration.ts` | Two-process coherence leg (its own CI job; needs Postgres + Redis). Same flake-retry wrapper as `npm test`. |
| `npm run verify:f0` … `verify:f6` | `node -r ts-node/register scripts/verify-f*.ts` | One phase verifier per ADR in `documentation/adr/` (F0 baseline … F6 migration certification). All seven run in the backend CI job; the repo root aliases each one. |
| `npm run generate:f2` | `node -r ts-node/register scripts/generate-f2-contracts.ts` | Regenerate the F2 content contracts (validators, DTO, OpenAPI, policy, client). `verify:f2` runs it first, then checks the result. |
| `npm run generate:f5` | `node ../scripts/generate-visual-contract.mjs`   | Regenerate the F5 unified visual contract. `verify:f5` re-runs it with `--check` before its own suite. |
| `npm run perf:f0`   | `node -r ts-node/register scripts/f0-content-bench.ts --enforce` | Enforce the F0 content performance budgets committed in `backend/f0-performance-budgets.json`. |
| `npm run lint`      | `eslint "src/**/*.ts"`                            | Lint the backend (a CI gate: ESLint exits non-zero on errors only, so warnings do not fail the job). |
| `npm run format`    | `prettier --write "src/**/*.ts"`                  | Format the backend.                                                 |

> **CI gate:** continuous integration (Node 22) runs the strict typecheck + `lint` + `build` + the seven phase verifiers (`verify:f0` … `verify:f6`) + the unit test suite + `perf:f0` (the F0 content performance budgets) + the **integration suite** (`npm run test:integration`, against real `postgres:16` + `redis:7` service containers), plus a **license gate** (`license-checker --production --failOn 'AGPL;SSPL'`) and a marketplace catalog integrity check (`build-marketplace.js` then `verify-marketplace.js --rebuild`). A **dependency audit** gate (`scripts/ci-audit.mjs`, i.e. `npm audit --omit=dev --audit-level=high`) runs in the `backend`, `gateway`, `frontend` and `install-channel` jobs and blocks on a high/critical production advisory; the root and `setup` workspaces are covered instead by the daily scheduled sweep `.github/workflows/dependency-audit.yml` (04:41 UTC, plus `workflow_dispatch`), which runs the same gate across all six workspaces and opens — or comments on — a `Dependency audit failed (<date>)` issue naming the failing workspaces. The project and all packages are MIT-licensed; dual-licensed dependencies are listed in `THIRD-PARTY-NOTICES.md`.

> **`setup`:** the **root** `package.json` declares `npm run setup` (`node setup/index.js --install`), the one-shot **cluster install orchestrator**. It generates the mTLS cluster PKI (a 10-year **Root CA** plus 2-year **gateway-internal / backend / frontend** service certs, each with `localhost` / `127.0.0.1` + host SANs), mints a random `gatewaySecret` (32 bytes hex) and `jwtSecret` (64 bytes hex), writes/merges `backend/wordjs-config.json` and `gateway/gateway-config.json` (`ssl.enabled`, gateway port `3000` / internal port `3100`), and distributes the certs into each service's `certs/` dir. It does **not** seed the database or create the admin account — that happens later via the interactive install wizard on the frontend; the script finishes by telling the operator to run `npm run install:all` then `npm run dev`. (The hardcoded `adminUser`/`adminPassword` in the `--install` branch are unused placeholders, not real credentials.)

> **`migrate`:** the **root** `package.json` declares `npm run migrate` (`node setup/index.js --migrate`), which delegates to `backend/scripts/migrate.js`. It applies any pending **schema migrations** to the configured database without starting the server (prefers compiled `dist/`, falls back to ts-node on `src/`). It is **idempotent** — the same schema migrations also run automatically at boot — so it's safe to run in a deploy pipeline before rolling out new code. It does **not** switch DB *drivers* (the SQLite ↔ PostgreSQL data copy); that is a separate runtime operation in the **DB-Admin** API (`/api/v1/db-migration/*`, see below).

> **First-run install token:** when the **backend** boots while the instance is **not yet installed** (i.e. on `npm start` / `npm run dev`, *not* `npm run setup`), it prints a one-time install token to the console (banner `🔑 WordJS is not installed yet — finish setup in your browser:`, followed by a clickable `<siteUrl>/install#token=…` URL, the bare token, and the path of the token file). The token rides in the URL **fragment**, not a `?token=` query string: a fragment is never transmitted to any server, so the bootstrap secret stays out of access/proxy logs and out of the `Referer` header — the wizard reads `#token=` (a legacy `?token=` is still accepted so an older printout keeps working) and scrubs both from the address bar. That token gates the otherwise-unauthenticated pre-install endpoints `POST /setup/install` and `POST /setup/test-db` (supplied via the `x-install-token` header or an `installToken` body field), so a not-yet-installed instance can't be taken over by whoever reaches it first. The token is held **in memory only** — a fresh one is minted on each boot while the instance remains uninstalled. For headless/Docker deploys it is **also** mirrored to a `0600` file at `backend/data/install-token` and can be overridden via the `WORDJS_INSTALL_TOKEN` env var (which must be **≥ 16 chars**, or it is ignored with a warning and a random token is used instead). The file/token is cleared once the instance is installed.

## 2. One-Command Site Bootstrap (`npx create-wordjs`)

The **published npm package** `create-wordjs` (source in `packages/create-wordjs/`, MIT) bootstraps a complete WordJS site from nothing with a single command — no clone, no build, no TypeScript compilation on your machine:

```bash
npx create-wordjs@latest my-site
```

It (1) looks up the **latest pre-compiled release ZIP** from GitHub (`jaimemartinez/wordjs`, following the release-asset redirect), (2) extracts it into `my-site/` and installs the runtime dependencies (`npm run release:install` in the extracted bundle), then (3) mints a one-time install token and starts the monolith (`npm run start:mono`), printing a clickable `https://localhost:3000/install#token=…` URL — the browser install wizard takes over (pick a database — SQLite, PostgreSQL, or MySQL/MariaDB — and create the admin).

The token is passed to the backend via the `WORDJS_INSTALL_TOKEN` env var (24 random bytes = 48 hex chars; the backend accepts it because it is ≥ 16 chars — see § 1). A fresh release bundle ships **without** `gateway/gateway-config.json` (secrets are never bundled), so the CLI seeds a minimal `{ "ssl": true }` there to enable **self-signed HTTPS** on `:3000` (never overwriting an existing config); pass `--http` to serve plain HTTP (`WORDJS_HTTP=1`) instead. Plain Node, no TypeScript — the only runtime dependency is `adm-zip`. Requires **Node ≥ 20.9** and refuses to run into a non-empty target directory. The version published to npm is set from the release tag at publish time (`npm pkg set version` in `.github/workflows/release.yml`), so the version committed in `packages/create-wordjs/package.json` is not the authoritative one.

An unknown `-`/`--` option is a hard error (`Unknown option: …`), as is an extra positional argument.

| Option | Purpose |
| :--- | :--- |
| `--zip <path-or-url>` | Use a local release ZIP (or a direct ZIP URL) instead of the GitHub API — handy offline or when rate-limited. |
| `--version <tag>` | Install/upgrade to a specific release tag (e.g. `v2.1.0`) instead of the latest (a bare `2.1.0` is accepted and prefixed with `v`). |
| `--http` | Serve plain HTTP instead of self-signed HTTPS (sets `WORDJS_HTTP=1`). Create flow only. |
| `--no-start` | Scaffold + install dependencies only; don't start the server. |
| `--yes`, `-y` | Skip the confirmation prompt — required when upgrading non-interactively. |
| `--force` | (`upgrade`) Re-apply even if the install is already on the target version. |
| `--no-install` | (`upgrade`) Swap the code only; skip `npm run release:install`. |
| `-h`, `--help` | Show usage (exit 0). |

### Subcommands (beyond the default scaffold)

The default `npx create-wordjs@latest <dir>` above installs a single-machine site. The same bin also has subcommands for **in-place upgrades** and **separate mode** (the three services on **different** machines), so the whole cluster can be stood up without cloning the repo:

| Command | Purpose |
| :--- | :--- |
| `npx create-wordjs@latest <dir>` | Fresh single-machine install (monolith), as above. `<dir>` is **required** here. |
| `npx create-wordjs@latest upgrade [dir]` | Replace the app code in an existing install with the latest release **in place**, preserving `wordjs-config.json`, gateway secrets, the database, and user-installed plugins. `[dir]` defaults to the current directory. |
| `npx create-wordjs@latest gateway [dir] [opts]` | Stand up a **separate-mode gateway**: fetches the release, then runs the bundled `scripts/cluster.js init` to mint the cluster CA + gateway certs and prints ready-to-paste `join` commands (with fresh single-use tokens). Key option: `--host <ip/dns>` (the address other machines dial to reach this gateway). `[dir]` defaults to `wordjs-gateway`. |
| `npx create-wordjs@latest join <role> [dir] [opts]` | Join **this** machine to a gateway as `backend` or `frontend` (the role may also be given as `--role <backend\|frontend>`): fetches the release, then runs the bundled `scripts/node-join.js` to enroll over the token listener and register over mTLS. Options: `--gateway <ip/dns>`, `--token <join-token>`, `--ca-hash <sha256>` (MITM guard), `--advertise <ip/dns>` (this node's routable address), `--enroll-port <port>` (default 3101). `[dir]` defaults to `wordjs-<role>`. Needs `openssl` on `PATH`. |

So `create-wordjs gateway` / `join` are the one-command equivalents of the in-repo `scripts/cluster.js` / `scripts/node-join.js` walkthrough in [§ 6a](#6a-cluster-enrollment-separate-mode-) below — see **[separate-mode.md](separate-mode.md)** for the full flow.

> Unlike the backend `cli/*` scripts below, `create-wordjs` is **not** run from the repo — it is a standalone npm bin invoked via `npx` on an end-user machine to *produce* a WordJS install. The in-repo scaffolders (§ 3, for plugin/theme *authors*) are a different tool.

## 3. Plugin & Theme Scaffolder + Packer (`cli/wordjs.js`)

The plugin/theme-author DX tool. Run it with plain `node` — it needs no `-r ts-node/register` of its own (the theme commands resolve `backend/dist/core/*` or self-register ts-node, see the note in § 1). There is deliberately **no root npm alias**; invoke it directly from the **repo root**:

```bash
node backend/cli/wordjs.js create plugin my-plugin   # scaffold backend/plugins/my-plugin/
node backend/cli/wordjs.js create theme  my-theme    # scaffold backend/themes/my-theme/
node backend/cli/wordjs.js create theme  neon-shop --primary "#7c3aed" --secondary "#0ea5e9" \
  --bg "#0b1020" --text "#e5e7eb" --archetype cyber  # …or generate it from 4 seed colors
node backend/cli/wordjs.js build theme  neon-shop    # recompile theme.json → style.css block
node backend/cli/wordjs.js pack my-plugin --build    # zip a plugin for distribution
node backend/cli/wordjs.js doctor theme default      # lint a theme against the token contract
node backend/cli/wordjs.js import stitch neon-shop   # Stitch design system → theme.json tokens
node backend/cli/wordjs.js verify theme neon-shop    # compiled CSS vs. the design it came from
node backend/cli/wordjs.js help
```

Templates live in `backend/cli/templates/{plugin,theme}/` with `__SLUG__` / `__PASCAL__` / `__NAME__` placeholders (replaced in file names and contents).

**Conventions shared by every command:**

| | |
| :--- | :--- |
| **Slugs** | `create` requires lowercase kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), and so does `pack`. `build theme` / `doctor theme` accept any slug the backend routes accept (`^[a-zA-Z0-9_-]+$`), because an *installed* theme need not have been scaffolded here. |
| **Flags** | `create theme`, `import stitch` and `verify theme` share one strict `--flag value` parser: an unknown flag, a flag without a value, and a bare positional argument each abort with a message listing that command's known flags — a typo can never silently scaffold something else. (`pack` is the exception: it just looks for `--build` and `--out` in its arguments.) |
| **Exit codes** | `0` on success and for `help` / `--help` / `-h`; `1` for every `❌` failure, for a `doctor` report containing errors, for a `build` with compile errors, and when the command line is unrecognized or empty (both print the help text first). |
| **Where themes are written** | `backend/themes/` by default, or `$WORDJS_THEMES_DIR` when that env var is set (tests/CI point it at a throwaway dir). The token contract is always read from `backend/public/theme-tokens.json`. |
| **Overwrite safety** | `create` refuses to write into an existing plugin/theme directory. In seeded mode the compile runs as a dry run first and the whole directory is removed if it fails, so a rejected `theme.json` never leaves a half-scaffolded theme behind. |

### `create plugin <slug>`

Scaffolds a complete, activatable **isolated** plugin:

| File | What it is |
| :--- | :--- |
| `manifest.json` | `id`, `name`, **`"isolated": true`** (required — activation is rejected without it), requested `permissions` with reasons (granted by the admin on activation, default-deny), `frontend.adminPage` `{entry, slug}` and `frontend.versoComponents` `{entry}` (the pre-rename `frontend.puckComponents` is still accepted — see `documentation/plugins.md` §13). |
| `index.js` | The isolated-bridge idioms: `exports.init = function (wordjs) { const { options, http, adminMenu } = wordjs; ... }` with a public GET plus admin-gated POST/DELETE route (`{ auth: true, admin: true }`), slug-prefixed options storage, and `adminMenu.add`. JSDoc-typed against `backend/types/wordjs-bridge.d.ts`, so plain-JS authors get full IntelliSense. |
| `client/admin/page.tsx` | The admin page (starts with `// @ts-nocheck` + `"use client"` — **required** for committed plugin client files: the frontend CI type-checks the generated registries, which import these files directly). |
| `client/verso/<Pascal>Verso.tsx` | A Verso block: `export const versoComponentDef` + default-exported render, themed via an embedded `<style>` with `--wjs-*` token fallbacks. |

The CLI then prints the required flow: **restart the backend once** (new plugin folders are discovered at boot; from then on activation hot-loads them) → **activate** in `/admin/plugins` → regenerate the frontend registries:

```bash
node frontend/scripts/generate-admin-plugin-registry.js
node frontend/scripts/generate-verso-plugin-registry.js
```

> **Dev hot-reload:** with `NODE_ENV=development` (i.e. `npm run dev`), the backend watches every active isolated plugin's directory (`backend/src/core/plugin-dev-watch.ts`) and re-spawns its child process ~300 ms after a `.js`/`.json` save — the reload re-runs the full load pipeline including the AST security scan, so nothing is bypassed. Manual equivalent (admin-only, works in any environment): `POST /api/v1/plugins/:slug/reload`.

### `create theme <slug>`

**Template mode** (no seed colors, no `--archetype`) copies `backend/cli/templates/theme/`, which is exactly two files:

- `theme.json` — `name` / `version` / `description` / `author` plus the `layout` structure config the public shell honors (`containerWidth: "1100px"`, `sidebar: false`).
- `style.css` — a `:root` pre-seeded with **53** `--wjs-*` tokens (the contract, seeded from `backend/themes/default/style.css`), followed by a **commented-out** chrome block with 14 more `--wjs-nav-*` / `--wjs-footer-*` tokens to uncomment. That comment points at `backend/themes/default/style.css` as the worked example, because it is the one theme that ships with every install (everything else arrives from the marketplace).

No `functions.js` is scaffolded in this mode. `--name` sets both the `__NAME__` placeholder and `theme.json`'s `name`; `--author` / `--description` are patched into `theme.json` after the copy. Details in `documentation/themes.md` / `documentation/theming.md`.

**Seeded (declarative) mode:** pass **all four** seed colors — `--primary --secondary --bg --text <#rrggbb>` (the leading `#` is optional, since most shells are happier without it) — and instead of copying the template the CLI writes a **declarative `theme.json`** (`generator: "wordjs"`, `seeds`, the same `layout` defaults), compiles `style.css` from it via `core/theme-compile.ts`, and adds a `functions.js` stub. The resulting `style.css` contains **only** the generated block — the 53-token template is not involved.

`--archetype cyber|brutalist|editorial|glassmorphism|organic|obsidian` records a personality **label** in `theme.json`; the list is read from `core/theme-derive`'s `ARCHETYPE_NAMES` at runtime and an unknown name aborts with the available names. The label **emits no CSS** — `theme-compile` only validates it (`ARCHETYPE_UNKNOWN`), and it feeds no token either (`deriveTokens()` takes the four seeds and nothing else). The archetype preset stylesheets (`.theme-container` / `.theme-hero` / `.theme-card` / `button.theme-btn` plus bare `body` and `h1, h2, h3` rules) belonged to the retired legacy theme model and **no longer reach any stylesheet**: `theme-compile` never calls `archetypeCss()`, so nothing in the compiled block comes from the archetype. `archetypeCss` has since been removed from `core/theme-derive.ts` outright — `theme-derive.test.ts` asserts it is `undefined`, so re-exporting it goes red — and the `ARCHETYPES` preset map survives only in the standalone `scripts/create-40-themes.js` generator, which is unit-tested but is not on the compile path; don't be misled by finding those `.theme-*` rules there. **`--archetype` implies seeded mode**: passing it (or any subset of the seed colors) without all four colors fails with *"Seeded creation needs all four colors"*. Contract reference: *Declarative theming (`theme.json`)* in `documentation/themes.md`.

### `build theme <slug>`

Recompiles an existing theme's `theme.json` (its `seeds` / `archetype` / `tokens` / `styles` sections) into the `/* @wjs-generated:start */ … /* @wjs-generated:end */` block of `backend/themes/<slug>/style.css`, replacing only that block — manual CSS outside the markers is preserved byte for byte (no markers yet → the block is prepended with a warning). If a stylesheet somehow carries **several** marked blocks they all get replaced and collapse into one, because a stale block sitting *after* the fresh one would win the cascade; a start marker with no closing one is not treated as a block at all, so the remainder is left alone rather than guessed at. Prints every compile diagnostic as `[CODE] path — message` (`❌` errors, `⚠️` warnings; did-you-mean suggestions are part of the message text); on errors it exits `1` **without writing**.

Two behaviors worth knowing:

- **It bumps `theme.json`'s patch version** after a successful write (`1.0.0` → `1.0.1`; a missing `version` is treated as `1.0.0` and becomes `1.0.1`), because the public stylesheet URL is keyed by that version — otherwise browsers would keep the pre-build CSS for up to an hour. The bump never blocks the build: the CSS is written first, so if `theme.json` is unreadable the CLI prints `⚠️  Could not bump theme.json version (…)` and leaves the file alone, and if the version is readable but not three numeric parts (`1.0`, `1.0.0-beta`) the bump is silently skipped — no warning, and the `✅` summary simply omits its `theme.json version → …` line.
- **It refuses to invent a block.** If `theme.json` has none of the declarative keys *and* `style.css` has no `@wjs-generated` markers, it prints an `ℹ️ … nothing to build` line and exits `0` without touching the theme — so running it on a hand-authored theme is a no-op, not a mutilation.

### `doctor theme <slug>`

Lints an installed theme against the machine-readable token contract (`backend/public/theme-tokens.json`), the layout schema (`backend/public/theme-layouts.schema.json`) and, for a declarative theme, the compiler itself. Findings print grouped as `❌`/`⚠️`/`ℹ️` with their code, followed by a `N error(s), M warning(s), K info.` summary; **exit `1` if there is any error**, `0` otherwise. The full code list is in [themes.md — Diagnostics reference](themes.md#diagnostics-reference); the same report is available to admins over `GET /api/v1/themes/:slug/doctor`.

The doctor is **fail-open**: when the token manifest is missing or unreadable it prints `⚠️ Token manifest (backend/public/theme-tokens.json) not found — nothing to lint against.` and exits `0` with no findings.

### `import stitch <slug> [--from <file>] [--name/--author/--description <text>]`

Turns a [Stitch](https://stitch.withgoogle.com) design system into the theme's `theme.json` tokens, then recompiles — so `style.css` never lags behind the design. The theme directory must already exist (`create theme <slug>` first).

> The command is dispatched normally, but `wordjs.js help` does **not** list it — the printed usage covers `create` / `build` / `pack` / `doctor` / `verify` only. Take this section as its reference until the help text catches up.

The design is read from `themes/<slug>/.design/stitch.json` unless `--from` points elsewhere; the default location doubles as **provenance**, which is what lets `verify theme` re-check the theme later with no arguments. Save the `get_project` / `list_design_systems` payload there verbatim — the resolved `namedColors` palette it carries is the authority, not the seed colours that were typed into Stitch.

The mapping is mechanical and deliberately narrow:

- **Only manifest-known tokens are written.** Anything the mapper produces that `theme-tokens.json` does not list is skipped and reported (`⚠️ N mapped token(s) are not in the manifest`), never silently emitted.
- **Hand-written values survive.** Keys the design does not own are preserved and listed back (`kept N value(s) the design does not own`), so an imported theme can still carry decisions Stitch has no concept of — `layout`, `styles`, chrome composition.
- **Hero tokens are always emitted**, with their contrast asserted at ≥ 4.5:1. They were the tokens most often left to inherit, which is how a hero title once ended up the same colour as the band behind it.

Exits `1` if the design file is unreadable, if the mapping throws, or if the recompile that follows has errors.

### `verify theme <slug> [--against <file>]`

Compares the theme's **compiled** `style.css` against the design system it claims to come from, and reports what does not match. It reads the built stylesheet, not a dry run — the question it answers is "does what ships equal the design", which a dry run cannot answer.

Output has four parts, and the last three exist so a gap can never read as a pass:

| | |
| :--- | :--- |
| `❌ <token>` | Mismatch: `expected` (with the design field it came from) vs `actual` (or `(nothing declares it)`). |
| `⚠️ N value(s) the design does not pin` | The design has nothing to compare against for these. |
| `⚠️ <source> has no mapping rule` | The verifier itself has no rule for this design field — a known blind spot, printed rather than skipped. Stitch's `spacingScale` is currently here. |
| `ℹ️ N design value(s) no token consumes` | The design defines them; no `--wjs-*` token wants them. |

Closes with `N matched, M mismatched, K not comparable.` and exits `1` on any mismatch, pointing at `build theme <slug>` as the fix. Same `--against` semantics as `import stitch --from`: without it, the design is read from `themes/<slug>/.design/stitch.json`.

### `pack <slug> [--build] [--out <dir>]`

Zips `backend/plugins/<slug>` into `<slug>.zip` with a single `<slug>/` root folder — the exact layout `POST /api/v1/plugins/upload` (Admin → Plugins → Add New) expects — excluding `node_modules/`, `data/`, `.git/` and `os-tmp/` (dependencies reinstall automatically on activation), and prints the resulting size. Output defaults to the current directory (`--out <dir>` to change; the directory is created if needed).

It aborts if `backend/plugins/<slug>/manifest.json` does not exist, and if `adm-zip` cannot be resolved (*"run `npm install` inside backend/ first"*) — it is a backend dependency, resolved from `backend/node_modules`. With `--build` it first runs `backend/scripts/build-plugin.js <slug>` to pre-compile the frontend bundles into `dist/`, aborting if that build fails; if the builder script is missing the flag is skipped with a warning instead.

## 4. Role Manager (`cli/force-sync-roles.js`)

**Use case:** You accidentally deleted the Administrator role or permissions are corrupted.

This script re-seeds the `wordjs_user_roles` option in the database from the default roles defined in `backend/src/config/app.ts` (`config.roles`). It imports core TS modules, so run it through ts-node:

```bash
cd backend
node -r ts-node/register cli/force-sync-roles.js
```

**Output:**
```
Initializing database connection...
Syncing roles to database...
Updating existing roles in DB...          (or "Creating roles option in DB..." on a fresh install)
Successfully synced roles! Subscribers now have access_admin_panel.
```

Exits `0` on success, `1` (printing the error) on failure.

## 5. Plugin Diagnostic (`cli/check_plugins.js`)

**Use case:** A plugin is causing the server to crash or not loading, and you need to see what's physically active in the DB.

This script opens the SQLite file(s) with `better-sqlite3` (read-only) and prints the `active_plugins` option for each. It has no TS imports, so plain `node` works, and it resolves paths from **its own location** (`__dirname`), not the working directory — so it runs correctly from anywhere:

```bash
node backend/cli/check_plugins.js
```

Which file it opens, in order: the `database.path` declared in the `wordjs-config.json` two directories up from the script — i.e. the **repo root**, not `backend/` — resolved relative to that config, then the two well-known names `backend/data/wordjs-native.db` and `backend/data/wordjs.db`. Duplicates and non-existent paths are dropped, and **every** surviving candidate is printed (prefixed by its basename) — the two SQLite drivers keep separate files, so reporting only one of them named the wrong install's plugins. If none exists it prints `Error: no SQLite database found (looked in …)` and exits `1`. It only ever reads SQLite: a site configured for PostgreSQL or MySQL is not what it reports on (see § 7).

Other handy diagnostics in `cli/` include `list-users.js`, `inspect-roles.js`, `inspect-user.js`, `verify-roles.js`, `verify-activation.js`, and `dump-routes.js` (lists every registered Express endpoint). Those that import `src/config/database` need the `-r ts-node/register` flag.

## 6. Gateway Registry (`gateway/gateway-registry.json`)

**Use case:** Troubleshooting service discovery.

This is a **file**, not a script. It contains the current state of the Gateway's known services. Inspecting it helps verify whether the backend/frontend registered successfully.

## 6a. Cluster Enrollment (separate mode) 🪪

Two **root** scripts bootstrap **separate mode** — the gateway, backend, and frontend running on **different machines**, joined into one cluster over mutual TLS. They are aliased as `npm run cluster` and `npm run node:join`. The full operator walkthrough is **[separate-mode.md](separate-mode.md)**; the trust-root internals are in **[core-modules.md](core-modules.md)** § 10 (Cluster Certificate Authority).

### Gateway side (`scripts/cluster.js`, run **on the gateway machine**)

```bash
node scripts/cluster.js init   [--host <gw-ip/dns>] [--bind <ip>] [--port 3000] \
                               [--internal-port 3100] [--enroll-port 3101] [--site-url <url>]
node scripts/cluster.js token  <backend|frontend> [--host <node-ip>] [--ttl <minutes>]
node scripts/cluster.js tokens          # list outstanding join tokens
node scripts/cluster.js revoke-tokens   # burn all outstanding tokens
node scripts/cluster.js info            # show CA fingerprint + endpoints
```

* **`init`** mints the cluster CA (keeping the CA key `0600` on the gateway), mints the gateway's own identity + public cert (the public cert is now **also** signed by the cluster CA), writes a multi-node `gateway/gateway-config.json` (`gatewayInternalBind` = the routable IP, `gatewayEnrollPort` default **3101**), and clears the registry. Idempotent — re-running reuses the existing CA.
* **`token <role>`** mints a **single-use, role-bound, TTL** join token and prints the exact `node-join` command (including `--ca-hash`) to paste on the new machine.

### Node side (`scripts/node-join.js`, run **on the new backend/frontend machine**)

```bash
node scripts/node-join.js --role <backend|frontend> --gateway <gw-ip/dns> --token <join-token> \
     [--enroll-port 3101] [--advertise <this-node-ip>] [--ca-hash <sha256>] \
     [--port <svc-port>] [--install] [--build] [--start]
```

`--role`, `--gateway` and `--token` are required (a missing or non-`backend`/`frontend` role, or a missing gateway/token, exits `1` before anything is generated). `--install` / `--build` run the node's dependency install / production build before `--start` launches it.

It generates a keypair + CSR (via `openssl`), makes the **one** tokened `POST /enroll` call to the gateway's enrollment listener (port **3101** — a separate HTTPS listener that does **not** request a client cert; the strict mTLS `/register` listener on 3100 is untouched). The gateway validates the token, **forces `CN` = the token's role** (the CSR subject is ignored), signs the cert, and returns `{cert, cluster-ca, bootstrap config}`. `node-join` verifies the returned CA against `--ca-hash` (MITM guard), writes `<role>/certs/*` + `<role>/wordjs-config.json` (`advertiseHost`, `gatewayHost`, …), and with `--start` launches the service — which then **registers** with the gateway over mTLS.

## 7. Database Files & Maintenance

The database file depends on the active driver (selected by `dbDriver` in `wordjs-config.json` — see `documentation/database.md`):

| Driver               | File / location                     | Notes                                            |
| :------------------- | :---------------------------------- | :----------------------------------------------- |
| `sqlite-native` (default) | `backend/data/wordjs-native.db` | `better-sqlite3`. The DB-manager default.        |
| `sqlite-legacy`      | `backend/data/wordjs.db`            | pure-JS WASM `sql.js`; same SQLite file format. Used as the automatic fallback when a SQLite driver fails to load (e.g. the native binary is missing); also selectable explicitly — in the install wizard as "SQLite (legacy / WASM)" and as a DB-Admin migration target — or by setting `dbDriver: "sqlite-legacy"` in `wordjs-config.json`. |
| `postgres`           | external PostgreSQL server (via the `pg` client) | Set `db: { host, port, user, password, name, ssl }` in `wordjs-config.json`. |
| `mysql` (or `mariadb`) | external MySQL 8.0+ / MariaDB server (via the `mysql2` client) | Same `db` connection object (set `dbPort: 3306`); the driver translates SQLite-dialect SQL to MySQL at the boundary. |

You can open any SQLite file with a SQLite CLI or GUI (like *DB Browser for SQLite*) directly while the server is stopped.

### DB-Admin API (engine migration)

Switching DB engines is done at runtime via the **DB-Admin** core module (`backend/src/core/db-admin/`, formerly the `db-migration` plugin), exposed under `/api/v1/db-migration/*` (requires the `manage_options` capability). See `documentation/api.md` § 6.6 for the endpoint list.

## 8. Notes

* **`migrate` vs. engine migration:** `npm run migrate` (root) applies pending DB **schema** migrations via `backend/scripts/migrate.js` (idempotent; also run at boot). Switching DB **engines** (SQLite ↔ PostgreSQL data copy) is a separate runtime operation in the DB-Admin API (`/api/v1/db-migration/*`).

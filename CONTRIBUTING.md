# Contributing to WordJS

Thanks for taking the time — WordJS is a **primarily solo-maintained** project, so small,
focused, tested pull requests are the ones that merge fastest. Whether you're fixing a typo, adding a
theme, or trying to break the plugin sandbox, you're welcome here.

If you're not sure where to start, look for the
[`good first issue`](https://github.com/jaimemartinez/wordjs/labels/good%20first%20issue) label, or
open a [Discussion](https://github.com/jaimemartinez/wordjs/discussions) to talk an idea through
before writing code.

---

## Getting the project running

**Requirements:** Node **≥ 22**.

```bash
git clone https://github.com/jaimemartinez/wordjs.git
cd wordjs
npm run install:all        # installs root + gateway + backend + frontend + setup
```

**Run it as one process** (the simplest way — a single Node process with SQLite):

```bash
npm run dev:mono           # → http(s)://localhost:3000
```

The first run serves a one-time install wizard at the printed URL — pick a database —
SQLite (zero config), PostgreSQL, MySQL/MariaDB, or a legacy WASM SQLite — and create your admin account. On a fresh checkout it serves plain HTTP; once
`gateway/gateway-config.json` enables TLS the dev server uses a **self-signed localhost certificate**,
so your browser will warn once; that's expected.

**Or run the three services split** (gateway + backend + frontend), useful when you're working on one
of them in isolation:

```bash
npm run dev                # gateway :3000 (public), backend :4000, frontend :3001
```

To run the three services on **separate machines** (joined over mTLS via cluster join tokens), see
the [Separate-mode guide](documentation/separate-mode.md).

---

## Before you push

`ci.yml` runs on every pull request, on `v*` tags, once a day on `main` (06:17 UTC) and on manual
dispatch. A newer push to the same pull request cancels the run it supersedes. Its jobs:
**Gates that travel** (every gate file is committed and actually run),
**Backend (typecheck + test)** (an aggregate over **Backend gates** and the eight
**Backend unit tests** shards, `npm test -- --test-shard=N/8`),
**Multi-node coherence**, **Gateway (test)**, **Install channel
(create-wordjs)** (`npm audit` gate, the package's tests with a zero-tests guard, and a
`node index.js --help` smoke of the installer CLI), **Frontend (lint + build)** (with its coverage
ratchet), **Verso E2E**
(Playwright chromium against an ephemeral HTTP monolith), **Compiled bundle smoke-boot** (builds
the real release ZIP and deploys it in mono, split and enrollment mode via
`scripts/smoke-deploy.sh`), **Docker image (build + boot + install)**, and **Performance budgets**
(measures and enforces the committed Linux calibration; a manual dispatch can re-calibrate). Two more
workflows run on every pull request: **Sandbox parity** (the plugin sandbox on four OS runners) and
**F6 certification** (the phase suites on all three database engines). **CodeQL** also runs on pull
requests and pushes to `main`, but it reports into the Security tab rather than blocking a merge.
Outside the pull-request path, **Release** builds and publishes on a `v*` tag and **Dependency audit**
sweeps daily (see below).

**What a merge into `main` needs.** Branch protection requires the checks above that carry the merge
(the backend aggregate, frontend, gateway, install channel, bundle smoke-boot, gates that travel,
multi-node, Verso E2E, and the Sandbox parity and F6 certification legs) **and requires the branch to
be up to date with `main`**. If `main` moved after your last push, merge it into your branch (or rebase)
and let CI run again. Docker image, Performance budgets and CodeQL are not required.

**Backend coverage runs once a day, not on your pull request.** The instrumented suite
(**Backend coverage**, four shards merged by **Backend coverage (c8 ratchet)**) runs only in the daily
scheduled run and on a manual dispatch (*Actions → CI → Run workflow*), so a coverage drop shows up the
day after the merge. When the daily run fails, the **Report a failed daily run** job opens an issue
titled *Daily CI run failed on main* with the label
[`ci-daily`](https://github.com/jaimemartinez/wordjs/labels/ci-daily), the run link and each job's
result; while that issue is open, a later failure comments on it instead of opening another. Close it
when `main` is green again. The frontend coverage ratchet still runs on every pull request.

Run the equivalents locally so review is about the change, not a red check:

```bash
# Backend
cd backend && npm run typecheck  # tsc --noEmit (strict)
cd backend && npm run lint       # eslint (a CI gate: errors block, warnings don't)
cd backend && npm run build      # compile to dist (CI blocks on this too)
cd backend && npm run verify:f0  # ...through verify:f6 - the phase verifiers, one per ADR
cd backend && npm test           # node --test over src/tests/*.test.ts
cd backend && npm test -- --test-shard=3/8   # just one CI shard (1/8 … 8/8): the same files that CI leg runs
cd backend && npm run perf:f0    # F0 content performance budgets

# Frontend (CI runs these as separate steps)
cd frontend && npm run predev    # regenerate plugin registries first — CI does, and tsc fails on stale ones
cd frontend && npx tsc --noEmit  # type check (next build skips this)
cd frontend && npm run lint      # eslint .
cd frontend && npm run test      # vitest run
cd frontend && npm run build     # next build

# Gateway
cd gateway && npm test
```

**Reproducing one red backend shard.** A CI leg named *Backend unit tests (shard 3/8)* ran exactly the
files `npm test -- --test-shard=3/8` runs: node splits the sorted file list, so every file is in one
shard only. Run it the way CI does, after `npm ci` in `backend/` **and** `setup/` (the installer tests
load `setup/`) and a build:

```bash
cd setup && npm ci
cd backend && npm ci && npm run build
cd backend && npm test -- --test-shard=3/8
```

Keep the `=` form: the test wrapper moves `--test-shard=N/8` in front of the file glob, where node reads
it. Without Postgres and MySQL the driver-conformance blocks skip; CI sets `WORDJS_CI_DB=1` with real
`postgres:16`, `redis:7` and `mysql:8` containers, which turns those skips into failures.

CI also runs a few gates that usually don't need a local equivalent: `npm audit` (blocks
high/critical prod vulns in `backend`, `gateway`, `frontend` and `packages/create-wordjs`), a
license check (`license-checker --production`, blocks
AGPL/SSPL), backend **integration tests** (`npm run test:integration`, against real Postgres + Redis
service containers), and a **marketplace catalog integrity** check — if you touch anything under
`marketplace/plugins/`, rebuild the catalog with `npm run build:marketplace` from the repo root (and
re-check it with `npm run verify:marketplace`) so it stays consistent. `marketplace/dist/` is a
**gitignored build output** (not committed) that the release workflow republishes as GitHub Release
assets — don't try to commit it.

Separately, `.github/workflows/dependency-audit.yml` runs the same `npm audit` gate daily (cron
`41 4 * * *`) and on demand across all **six** workspaces — root, `backend`, `frontend`, `gateway`,
`setup` and `packages/create-wordjs` — and opens (or comments on) an issue naming the failing
workspaces when one fails. Root and `setup` are audited only there, not on the push path.

A green local run isn't a guarantee CI passes (Linux vs. your OS can differ), but it catches the
common cases.

---

## Ground rules

A few conventions keep the project coherent and reviewable:

- **Don't edit core to customize a site.** WordJS is built to be extended, not forked:
  - **Themes** are a declarative token contract: `theme.json` (generator / seeds / tokens / styles /
    layout) is compiled into the `@wjs-generated` block of the theme's `style.css` by
    `node backend/cli/wordjs.js build theme <slug>` — never hand-edit inside that block. Scaffold one
    with `node backend/cli/wordjs.js create theme <slug>`, or copy a bundled theme that declares the
    whole contract (`backend/themes/circuito/`, `gaceta/` or `vergel/`) for the pattern.
    `backend/themes/default/` is the theme active right after an install, but it predates the
    declarative build: its `theme.json` has no token keys and its `style.css` has no generated block.
  - **Plugins** run in their own OS process and reach core only through the injected `wordjs`
    bridge. `manifest.json` declares the entry, `"isolated": true`, the requested `permissions`,
    the admin page and any `frontend.versoComponents`; routes, hooks and admin menu items are
    registered at runtime from `index.js` (`http.route(...)`, `adminMenu.add(...)`). Scaffold the
    full pattern with `node backend/cli/wordjs.js create plugin <slug>`, or copy the example in
    `documentation/examples/plugins/hello-world/`. The core ships no plugin: never commit one under
    `backend/plugins/` (a guard test refuses it) — publish it through `marketplace/plugins/` instead.
  - If you find yourself editing `backend/src/core/*` to change how one site looks or behaves, that's
    usually a sign it belongs in a theme or plugin instead.
- **A fix must not regress working behavior.** Include a test or a clear reproduction, and check that
  the app still boots and the existing tests pass.
- **Keep PRs focused.** One change per PR; avoid drive-by reformatting or unrelated refactors — they
  make review slow and risky.
- **Match the surrounding code.** Follow the naming, style, and structure already in the file you're
  editing rather than introducing a new convention.

### Security issues

**Please do not open a public issue for a security vulnerability** — especially not for a plugin
sandbox escape. The whole project is about that boundary, and a responsible-disclosure path exists for
exactly this. See [`SECURITY.md`](SECURITY.md) and report privately.

Adversarial testing of the sandbox is genuinely one of the most valuable things you can contribute —
just report what you find through the private channel first.

---

## Good places to help

- **Plugins & themes** — a small example plugin or a new token-driven theme teaches the extension
  model and grows the ecosystem. No core edits required.
- **The plugin sandbox** — the AST scanner is pattern-based and the isolation model has only had
  internal red-team passes. Tests, hardening, and (privately-disclosed) escape attempts are all high
  value.
- **Plugin-authoring DX** — SDK ergonomics, TypeScript typings, and docs for people writing plugins.
- **Docs** — the honest kind: what a capability grants, how to import from WordPress, how to write a
  theme.

## Submitting a plugin

The marketplace catalog is open to outside authors, and the policy is public:
**[`marketplace/REVIEW.md`](marketplace/REVIEW.md)**. Read §1 first — it says plainly what the
"reviewed" badge certifies (that a human read the submission against a written checklist and signed
it) and what it does not (it is not a security audit; the sandbox is where isolation actually lives).

1. Build against the sandbox — [`documentation/plugins.md`](documentation/plugins.md) §7 covers the
   permissions manifest and the AST scanner, §12 the per-plugin capability grants an administrator
   grants one at a time.
2. Open a pull request adding `marketplace/plugins/<slug>/` with the submission template — GitHub's
   template chooser exists for issues only, so it has to be named in the URL:
   **<https://github.com/jaimemartinez/wordjs/compare?template=plugin-submission.md>**. Without the
   `?template=` parameter you get the repository's default template, not the submission checklist.
3. The **Plugin review** workflow runs the mechanical checks (REVIEW.md §3). Green means a reviewer
   picks it up; it is not itself an approval. The review record in `marketplace/reviews.json` is
   written by the reviewer in a separate pull request — one that changes both a package and the
   ledger is refused.
4. Expect questions about permission minimality — it is the item most submissions fail.

Found a security issue in a plugin that is already published? That is not a pull request — see
[`SECURITY.md`](SECURITY.md).

## Licensing

WordJS is **MIT-licensed**. By contributing, you agree that your contributions are licensed under the
same MIT license.

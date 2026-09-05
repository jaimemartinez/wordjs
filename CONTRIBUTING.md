# Contributing to WordJS

Thanks for taking the time — WordJS is a **beta, primarily solo-maintained** project, so small,
focused, tested pull requests are the ones that merge fastest. Whether you're fixing a typo, adding a
theme, or trying to break the plugin sandbox, you're welcome here.

If you're not sure where to start, look for the
[`good first issue`](https://github.com/jaimemartinez/wordjs/labels/good%20first%20issue) label, or
open a [Discussion](https://github.com/jaimemartinez/wordjs/discussions) to talk an idea through
before writing code.

---

## Getting the project running

**Requirements:** Node **≥ 20.9**.

```bash
git clone https://github.com/jaimemartinez/wordjs.git
cd wordjs
npm run install:all        # installs root + gateway + backend + frontend + setup
```

**Run it as one process** (the simplest way — a single Node process with SQLite):

```bash
npm run dev:mono           # → https://localhost:3000
```

The first run serves a one-time install wizard at the printed URL — pick a database —
SQLite (zero config), PostgreSQL, MySQL/MariaDB, or a legacy WASM SQLite — and create your admin account. The dev server uses a **self-signed localhost certificate**,
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

`ci.yml` runs eight jobs — **Gates that travel** (every gate file is committed and actually run),
**Backend (typecheck + test)**, **Multi-node coherence**, **Gateway (test)**, **Install channel
(create-wordjs)** (`npm audit` gate, the package's tests with a zero-tests guard, and a
`node index.js --help` smoke of the installer CLI), **Frontend (lint + build)**, **Verso E2E**
(Playwright chromium against an ephemeral HTTP monolith), and **Compiled bundle smoke-boot** (builds
the real release ZIP and deploys it in mono, split and enrollment mode via
`scripts/smoke-deploy.sh`). Two more workflows gate the same push: **Sandbox parity** (the
plugin sandbox on four OS runners) and **F6 certification**; **CodeQL** also runs on every push and
pull request to `main`, but it reports into the Security tab rather than blocking a merge. Outside
the push path, **Release** builds and publishes on a `v*` tag and **Dependency audit** sweeps daily
(see below). Run the equivalents locally so review is about the change, not a red check:

```bash
# Backend
cd backend && npm run typecheck  # tsc --noEmit (strict)
cd backend && npm run lint       # eslint (a CI gate: errors block, warnings don't)
cd backend && npm run build      # compile to dist (CI blocks on this too)
cd backend && npm run verify:f0  # ...through verify:f6 - the phase verifiers, one per ADR
cd backend && npm test           # node --test over src/tests/*.test.ts
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
    full pattern with `node backend/cli/wordjs.js create plugin <slug>`, or copy a bundled example
    like `hello-world` or `test-schema`.
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

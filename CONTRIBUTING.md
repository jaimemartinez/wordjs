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

The first run serves a one-time install wizard at the printed URL — pick SQLite (zero config) or
PostgreSQL and create your admin account. The dev server uses a **self-signed localhost certificate**,
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

CI runs three gates — **Backend (typecheck + test)**, **Frontend (lint + build)**, and
**Gateway (test)**. Run the equivalent locally so review is about the change, not a red check:

```bash
# Backend
cd backend && npm run typecheck  # tsc --noEmit (strict)
cd backend && npm run build      # compile to dist (CI blocks on this too)
cd backend && npm test           # node --test over src/tests/*.test.ts

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
high/critical prod vulns in each service), a license check (`license-checker --production`, blocks
AGPL/SSPL), backend **integration tests** (`npm run test:integration`, against real Postgres + Redis
service containers), and a **marketplace catalog freshness** check — if you touch anything under
`marketplace/plugins/`, rebuild the catalog with `npm run build:marketplace` from the repo root so it
stays consistent. `marketplace/dist/` is a **gitignored build output** (not committed) that the
release workflow republishes as GitHub Release assets — don't try to commit it.

A green local run isn't a guarantee CI passes (Linux vs. your OS can differ), but it catches the
common cases.

---

## Ground rules

A few conventions keep the project coherent and reviewable:

- **Don't edit core to customize a site.** WordJS is built to be extended, not forked:
  - **Themes** style the site through their own `style.css` targeting the existing `.wjs-*` hooks and
    `--wjs-*` tokens — copy an existing theme (e.g. `default/` or `midnight-luxury/`) for the pattern.
  - **Plugins** add functionality through their `manifest.json` (routes, hooks, `puckComponents`) —
    copy a bundled example like `card-gallery` or `hello-world`.
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

## Licensing

WordJS is **MIT-licensed**. By contributing, you agree that your contributions are licensed under the
same MIT license.

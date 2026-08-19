# Versioned git hooks

```sh
npm run hooks:install     # once per clone: git config core.hooksPath .githooks
npm run scan:secrets      # the same gate, over every tracked file (what CI/tests run)
```

`core.hooksPath` is per-clone local config, so it cannot be committed — each clone opts in once.

## What is here

| hook | what it does |
| --- | --- |
| `pre-commit` | refuses a commit whose staged files carry a live session token (`.githooks/secret-scan.mjs`) |
| `pre-push` | delegation only — keeps the machine-local `theme-tokens.json` / `assetVersion` drift gate alive |
| `post-commit`, `post-checkout` | delegation only — keeps graphify's graph refresh alive |

`core.hooksPath` **replaces** `.git/hooks`, it does not add to it, so switching it on would otherwise
switch the existing local hooks off. `_local.sh` runs each hook's local namesake first.

## The secret scan

`secret-scan.mjs` matches a session cookie next to a real value, a signed three-part JWT, and
`Authorization: Bearer eyJ…`. It deliberately does **not** grep for the bare string `wordjs_token`:
that is ordinary source code in `middleware/auth.ts` and dozens of tests, and a rule that rejects
every authentication commit gets bypassed with `--no-verify` on day one.

Escape hatch, for the case where the match is genuinely inert: `git commit --no-verify`. If the match
is real, the token is burned — rotate it; amending does not remove it from a pushed history.

Pinned by `backend/src/tests/repo-hygiene-secrets.test.ts`, which fails the suite if any tracked file
ever matches, if the ignore rules for cookie jars and `.debug-dumps/` are dropped, or if the hook
stops calling the scanner.

<!-- Thanks for contributing to WordJS! Keep PRs focused — one change per PR. -->

## What & why

What does this change, and what problem does it solve? Link any related issue (`Fixes #123`).

## How it was tested

<!-- Which of the CI gates did you run locally? What did you check by hand? -->

- [ ] `cd backend && npm test` passes
- [ ] `cd backend && npm run typecheck` passes
- [ ] `cd frontend && npm run build` passes
- [ ] `cd gateway && npm test` passes
- [ ] Verified the change in the running app

## Checklist

- [ ] Focused scope — no unrelated reformatting or refactors
- [ ] Did **not** edit core to do something a theme or plugin should do
- [ ] A fix includes a test or a clear reproduction; no known regressions
- [ ] No secrets, credentials, or private/client content in the diff
- [ ] Security-sensitive changes: considered the plugin sandbox boundary (see SECURITY.md)

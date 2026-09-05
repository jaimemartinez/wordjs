# Turnaround plan — flipping the "no"s (started 2026-09-04, after 2.1.0)

Source: the 2.1.0 comparative assessment (WordJS vs WordPress, Drupal, Ghost, Strapi, Payload, Directus,
Sanity, Webflow). It listed fourteen changes that would flip the strongest "no"s. This file is the
execution checklist: one phase per row group, each with its evidence of done. Items that need a person
the project does not have yet (a second maintainer, an external auditor, a third-party plugin author)
are prepared here so that only the person is missing.

Loop per phase: implement → local gates (tsc, eslint, tests, build) → adversarial verification →
maintainer review → fix until green → pull request → CI required checks → merge → next phase.

Phases 1–7 went through that loop as one batch (2026-09-04): two adversarial passes (95 findings over the
batch, 18 must-fix closed; then 11 confirmed must-fix over the fixes, closed). What neither pass blocked on is
kept verbatim in `turnaround-followups-2026-09-04.md` for the next triage.

## Phase 0 — Repository hygiene and release pipeline (S)

- [x] `main` protected: pull request required (no approval count, single maintainer), required status
      checks = every CI, F6-certification and sandbox-parity job, admins enforced, no force-push, no delete.
      Evidence: `gh api repos/jaimemartinez/wordjs/branches/main/protection` → 200 with those contexts.
- [x] Dependabot vulnerability alerts and automated security fixes enabled. Evidence: the two endpoints
      answer 204 / `enabled: true`.
- [x] Discussions enabled (the issue-template contact link pointed at a disabled feature).
- [x] `.github/dependabot.yml` groups minor+patch per workspace and majors per workspace; the deferred
      majors (express 5, typescript 7, eslint 10, uuid 14, …) are listed as ignores with a reason.
      Evidence: open Dependabot PRs collapse to a handful of grouped ones.
- [x] `release.yml`: the verify gate also runs frontend tsc + vitest, gateway tests and create-wordjs
      tests; on a version tag a missing `NPM_TOKEN` fails the release instead of skipping the publish.
- [x] OpenAPI `info.version` read from the release manifest instead of a hard-coded `1.0.0`.

## Phase 1 — Quick security and quality wins (S)

- [x] Comments: dedicated rate limiter on `POST /comments` (far stricter than the global one), honeypot
      field, optional captcha hook; anonymous posting stays configurable.
- [x] Silent database degradation: a fallback to `sqlite-legacy` (no FTS) raises a persistent admin
      notice, not only a console warning.
- [x] Linux cgroup mode without `cpuQuotaPercent`: boot refuses or raises a blocking admin notice.
- [x] Media: WebP/AVIF derivatives next to the existing size ladder; `<picture>` on public render.
- [x] Audit log: login success/failure/logout, password and MFA changes, content create/update/delete/
      publish, media, backups (create and restore), marketplace installs; retention pruning with an option.
- [x] MFA-by-role policy: option to make headless `wjt_` tokens subject to the same policy; documented.

## Phase 2 — Public archives, sitemap index, feeds (M)

- [x] `/category/<slug>`, `/tag/<slug>`, `/author/<slug>`, date archives, custom taxonomies, paginated,
      theme `archive.html` finally fed. Sitemap index over N URLs. Per-taxonomy feeds, Atom and JSON Feed.

## Phase 3 — WordPress import that brings media and menus (M)

- [x] WXR import downloads attachments (bounded, resumable) and maps `nav_menu_item` into menus; fixture
      tests count attachments and menu items in = out.

## Phase 4 — Observability (M/L)

- [x] Structured logging (pino) with request correlation ids; `console.*` in `backend/src` under 50.
- [x] `/metrics`: request rate, latency, error rate, DB pool, cache hit ratio, sandbox state.
- [x] Coverage measured (c8 for node:test, vitest coverage for the frontend) with a CI threshold.
- [ ] Backup restore verification job: restore the latest backup into a clean environment and compare
      row and file counts.

## Phase 5 — OpenAPI to 100 % and performance budgets on CI Linux (M)

- [x] Every REST handler documented; the F0 baseline gate gets a coverage floor, not only anti-drift.
- [~] Performance budgets: the Linux CI job with a calibration mode is in place; the Linux calibration itself lands after the first dispatch (artifact → f0-baseline.json).

## Phase 6 — Docker image built and booted in CI, deploy templates (M)

- [x] CI builds the image, boots it, passes `/healthz` and completes the installer. A one-click template
      (compose + Helm chart) referenced from the README.

## Phase 7 — Third-party plugin programme (M, needs authors)

- [x] Public review criteria, PR-based submission with automated scan + sandbox certification + human
      checklist, `reviewed` flag in the catalogue and the "sandboxed & reviewed" badge. Only the authors
      are missing after this.

## Phase 8 — Documentation, changelog, release 2.2.0

- [ ] SECURITY.md Known Limitations, README, POSITIONING updated; CHANGELOG entry; tag cut on green CI.

## Needs a person (prepared, not flippable from the repository)

- A second human maintainer with commit access. `.github/CODEOWNERS` already names the review ledger and the
  files that decide what a record means; "Require review from Code Owners" becomes a real gate only when a
  second owner exists (GitHub forbids self-approval).
- An independent security audit; the scope document and the residuals list are ready in SECURITY.md.
- Third-party plugin authors; the programme in Phase 7 is the on-ramp.

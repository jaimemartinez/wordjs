# Turnaround plan — flipping the "no"s (started 2026-09-04, after 2.1.0)

Source: the 2.1.0 comparative assessment (WordJS vs WordPress, Drupal, Ghost, Strapi, Payload, Directus,
Sanity, Webflow). It listed fourteen changes that would flip the strongest "no"s. This file is the
execution checklist: one phase per row group, each with its evidence of done. Items that need a person
the project does not have yet (a second maintainer, an external auditor, a third-party plugin author)
are prepared here so that only the person is missing.

Loop per phase: implement → local gates (tsc, eslint, tests, build) → adversarial verification →
maintainer review → fix until green → pull request → CI required checks → merge → next phase.

## Phase 0 — Repository hygiene and release pipeline (S)

- [ ] `main` protected: pull request required (no approval count, single maintainer), required status
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

- [ ] Comments: dedicated rate limiter on `POST /comments` (far stricter than the global one), honeypot
      field, optional captcha hook; anonymous posting stays configurable.
- [ ] Silent database degradation: a fallback to `sqlite-legacy` (no FTS) raises a persistent admin
      notice, not only a console warning.
- [ ] Linux cgroup mode without `cpuQuotaPercent`: boot refuses or raises a blocking admin notice.
- [ ] Media: WebP/AVIF derivatives next to the existing size ladder; `<picture>` on public render.
- [ ] Audit log: login success/failure/logout, password and MFA changes, content create/update/delete/
      publish, media, backups (create and restore), marketplace installs; retention pruning with an option.
- [ ] MFA-by-role policy: option to make headless `wjt_` tokens subject to the same policy; documented.

## Phase 2 — Public archives, sitemap index, feeds (M)

- [ ] `/category/<slug>`, `/tag/<slug>`, `/author/<slug>`, date archives, custom taxonomies, paginated,
      theme `archive.html` finally fed. Sitemap index over N URLs. Per-taxonomy feeds, Atom and JSON Feed.

## Phase 3 — WordPress import that brings media and menus (M)

- [ ] WXR import downloads attachments (bounded, resumable) and maps `nav_menu_item` into menus; fixture
      tests count attachments and menu items in = out.

## Phase 4 — Observability (M/L)

- [ ] Structured logging (pino) with request correlation ids; `console.*` in `backend/src` under 50.
- [ ] `/metrics`: request rate, latency, error rate, DB pool, cache hit ratio, sandbox state.
- [ ] Coverage measured (c8 for node:test, vitest coverage for the frontend) with a CI threshold.
- [ ] Backup restore verification job: restore the latest backup into a clean environment and compare
      row and file counts.

## Phase 5 — OpenAPI to 100 % and performance budgets on CI Linux (M)

- [ ] Every REST handler documented; the F0 baseline gate gets a coverage floor, not only anti-drift.
- [ ] Performance budgets recalibrated on the Linux CI runner, ceilings at 1.5×, enforced per PR.

## Phase 6 — Docker image built and booted in CI, deploy templates (M)

- [ ] CI builds the image, boots it, passes `/healthz` and completes the installer. A one-click template
      (compose + Helm chart) referenced from the README.

## Phase 7 — Third-party plugin programme (M, needs authors)

- [ ] Public review criteria, PR-based submission with automated scan + sandbox certification + human
      checklist, `reviewed` flag in the catalogue and the "sandboxed & reviewed" badge. Only the authors
      are missing after this.

## Phase 8 — Documentation, changelog, release 2.2.0

- [ ] SECURITY.md Known Limitations, README, POSITIONING updated; CHANGELOG entry; tag cut on green CI.

## Needs a person (prepared, not flippable from the repository)

- A second human maintainer with commit access (`CODEOWNERS` will be added when there is a name to put in it).
- An independent security audit; the scope document and the residuals list are ready in SECURITY.md.
- Third-party plugin authors; the programme in Phase 7 is the on-ramp.

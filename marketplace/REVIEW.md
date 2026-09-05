# WordJS Marketplace — Plugin Review Policy

This is the public policy for getting a plugin into the WordJS marketplace catalog, and for what the
**reviewed** badge on a catalog entry does and does not mean.

Every plugin in the catalog today is written and maintained by the WordJS project itself. This
document exists so that stops being true: it is the entire on-ramp for an outside author, and nothing
in it is waiting on code that has not been written. Submit a plugin and this process runs.

---

## 1. What "reviewed" certifies — and what it does not

**It certifies that a human read the submission against §4 of this document and recorded a decision
in a tracked file** (`marketplace/reviews.json`), naming themselves and the date, bound to the exact
version, the exact permission set and the exact package contents the plugin had at that moment.

**And it is a statement about ONE catalog: ours.** An administrator may point WordJS at any number of
catalog sources, official or private, and the `review` field travels inside whichever index answers.
This ledger, the gate in §3.4 and everything below it cover only the catalog this repository
publishes. So an entry served by any other source is shown as **Unreviewed** no matter what its own
index claimed about it — the backend replaces the field on the way through
(`backend/src/routes/marketplace.ts`, `isOfficialSource`) and the admin UI refuses the badge a second
time. Nobody else gets to make this project's claim on this project's behalf.

**It is not a security guarantee, and it is not an audit.** Nobody should install a plugin because it
carries the badge who would not have installed it otherwise. Specifically, "reviewed" does **not**
mean:

- that the code is free of vulnerabilities, or that anyone attempted to find them;
- that the plugin's dependencies were audited, now or at any later version;
- that a static scan proved anything. The install-time AST scanner is explicitly a *best-effort
  warning*, not a gate — it says so in its own source (`backend/src/core/plugins.ts`), because
  "does this code reach the filesystem?" is undecidable in general and a determined author can evade
  any syntactic check;
- that the plugin will keep behaving as reviewed. Code changes; a review is a statement about a
  version, and §6 says when it expires.

**Where the actual safety comes from** is the layer underneath, and it applies to every plugin in the
catalog regardless of badge: each isolated plugin runs in its own OS process under a native sandbox
(Landlock + seccomp on Linux, Seatbelt on macOS, AppContainer on Windows) with default-deny
capabilities that an administrator grants one at a time. A reviewed plugin that turns malicious is
confined by exactly the same walls as an unreviewed one. See `documentation/plugins.md` §7–8 and
`documentation/security.md` §1.

This is also why the badge in the marketplace UI reads **"Reviewed"** and not "Sandboxed & reviewed".
A label that pairs the two words makes the pill next to it read as *"the unreviewed ones are not
sandboxed"*, which is the precise misreading this section exists to prevent — on the one string an
administrator reads before clicking Install. The sandbox is stated in the tooltip of every pill,
because it is true of every plugin.

The badge is therefore a statement about **process**, not about **code**: someone looked, wrote down
what they concluded, and signed it. That is worth having, and it is all it is.

---

## 2. Submission requirements

A submission is a pull request adding one directory under `marketplace/plugins/<slug>/`. The
manifest must carry:

| Field | Requirement |
| :-- | :-- |
| `id` | Equals the directory name. Lowercase, `[a-z0-9-]`. |
| `name`, `version`, `description` | Present. `version` is semver. |
| `author` | The real person or organisation responsible. Not a pseudonym you cannot be reached at. |
| `license` | An [OSI-approved](https://opensource.org/licenses) SPDX identifier (`MIT`, `Apache-2.0`, `GPL-3.0-only`, …). A `LICENSE` file with the matching text ships in the package. `AGPL`/`SSPL` are refused — the repository's own dependency gate blocks network-copyleft licences and the catalog holds to the same line. |
| `repository` | A public URL where the source of *this version* can be read. A marketplace entry whose only public artifact is a zip cannot be reviewed by anyone but us. |
| `isolated` | Must be `true`. Legacy in-process plugins are not accepted and no longer load. |
| `permissions` | Every entry `{scope, access, reason}`. The `reason` is a **justification**, not a restatement: say what the plugin does with the capability and why the feature cannot work without it. Alternatively supply the justifications as a `permissions_rationale` object keyed by grant token (`"database:write": "…"`, `"network": "…"`) — useful if you generate the permission list. Either form satisfies the requirement; a permission with neither is rejected. |

Additionally:

- **No shipped `node_modules/` unless you declare `"bundled": true`.** Shipping dependencies makes
  your plugin bundled whether you say so or not (`isBundledPlugin`), which silently opts you out of
  shared dependency installation and garbage collection — declare it so the choice is visible. The
  packed zip must stay under the installer's **10 MB** cap and within the decompression-bomb bounds;
  a bundled plugin that cannot be installed is not a submission.
- **No minified-only source.** Every file the plugin executes must be readable at the version being
  submitted. A build step is fine; a build step whose input you do not publish is not. If the package
  ships compiled bundles (`dist/*.bundle.js`, produced by the marketplace builder), the sources they
  are built from ship with them.
- **No runtime state in the package.** A plugin's top-level `data/` is live state and is excluded by
  the builder; do not work around that.
- **Own your namespace.** Database tables are `wjp_<slug>_*`; option keys are prefixed with your slug.

---

## 3. Automated checks that must pass

These run on the submission pull request
(`.github/workflows/plugin-review.yml`) and again on the release branch. A submission is not looked
at by a human until they are green.

1. **Manifest requirements** — every field in §2, checked mechanically
   (`backend/scripts/scan-plugin.mjs`). Unknown permission scopes and invalid `access` values are
   rejected against the core vocabulary, not against a copy of it.
2. **AST scan clean** — the same install-time scan an administrator's own upload gets
   (`validatePluginPermissions`). It is a warning system, not a proof (§1), but a submission that
   trips it does not proceed: the burden is on the author to explain or remove the construct.
3. **The sandbox you will run inside is certified on all three operating systems** —
   `.github/workflows/sandbox-parity.yml` runs on your pull request and certifies, on four runners,
   that the native confinement (Landlock + seccomp, Seatbelt, AppContainer) and the JS guard layer
   hold, by driving its own probes and booting real malicious plugins through the real RPC path.

   **It does not install or boot YOUR package**, on three operating systems or on any: it never reads
   `marketplace/`. Nothing in CI does. So a submission that only works when the sandbox is absent is
   still not shippable — but the machine will not be the one to notice, which is why §4's update path
   asks you to have run it under all three yourself and asks the reviewer to confirm you did. "It
   worked on Linux" has repeatedly not generalised.
4. **`npm run verify:marketplace`** — the package is installable: sha256 and size match the catalog,
   the inner manifest matches what the entry advertises, every declared frontend entry is actually
   compiled into the zip, no runtime state or junk ships, the filename satisfies the installer's own
   pattern, and the build is byte-for-byte reproducible. It is also where §6's re-review triggers and
   §8's conflict-of-interest rule are enforced.
5. **License gate** — the declared licence is OSI-approved and is not `AGPL`/`SSPL`; bundled
   dependencies are checked to the same standard.
6. **No `network` permission without a documented egress list.** A plugin that requests `network`
   states, in its `reason` (or `permissions_rationale`), where the traffic goes and why —
   `api.stripe.com`, `googleapis.com`. Where the destination is genuinely resolved at runtime and
   cannot be enumerated — an MTA looking up an MX host per message, a relay or webhook the operator
   configures — say so explicitly and bound it; a reviewer will hold you to that description under
   §4. What is refused is a justification that never says where the traffic goes at all: "talks to
   the internet" is a rejection.

> **First-party packages.** Two of the §2 requirements — `license` and `repository` — are about being
> an *outside* submission: they exist so a reviewer can read source that lives elsewhere, under terms
> someone stated. For a plugin recorded as `first-party` in the ledger they are reported as notes
> rather than failures, because its source *is* this repository under this repository's MIT licence.
> Everything else in §2 and §3 applies identically — isolation, the permission vocabulary, a
> justification per permission, the egress rule, the bundling declaration. Those are properties of the
> plugin, not of who wrote it.

---

## 4. The human checklist

What the reviewer actually reads. Each item is a yes/no with a written note in the decision.

- **Permission minimality.** Is every requested capability used, and is each one the narrowest that
  works? `database:read` where `settings:read` would do, `filesystem:write` for something the options
  bridge already stores, `email:provider` for a plugin that only sends its own mail — all are
  rejections, not remarks. This is the item most submissions will fail, and it is the item the badge
  is mostly about.
- **Data handling.** What personal data does the plugin collect, where does it put it, who can read
  it back, and does it leave the installation? Secrets (API keys, tokens) belong in the plugin's own
  `wjp_` table, never in the shared options namespace — a plugin that puts a Stripe key in an option
  is handing it to every other plugin with `settings:read`.
- **Admin UI content safety.** Does the admin page render anything the plugin did not itself
  produce — visitor submissions, remote catalog text, filenames — and if so, is it escaped? An admin
  screen is the highest-privilege surface in the product; stored XSS there is a takeover.
- **Update path.** Does the plugin migrate its own tables forward, and does it survive being
  deactivated and reactivated on a populated database? A plugin whose second version corrupts the
  first version's data is worse than no plugin.

---

## 5. Decision outcomes

**Accepted.** A record is added to `marketplace/reviews.json`:

```json
"my-plugin": {
    "status": "reviewed",
    "reviewer": "<github-handle>",
    "date": "2026-09-04",
    "reviewedVersion": "1.2.0",
    "reviewedPermissionsSha256": "<64 hex>",
    "reviewedContentSha256": "<64 hex>",
    "notes": "Short public summary of what was checked and any caveat."
}
```

`node backend/scripts/marketplace-review.js <slug>` prints that block with the three gate inputs
already filled in for the package as it stands. The catalog entry then publishes
`review: { "status": "reviewed", "reviewer": …, "date": …, "notes": … }`, and the marketplace UI shows
the badge. The version and the two digests stay in the ledger — they are gate inputs (§6), not
something an administrator browsing the catalog has any use for.

**By the reviewer, in a pull request of its own.** The record is not part of the submission. A pull
request that touches both a package under `marketplace/plugins/` and the ledger is refused by
`.github/workflows/plugin-review.yml` before any other check runs, because every mechanical check in
§3 passes for a submitter who appends their own record: the hashes are computed from their own
package, so the ledger agrees with the manifest and the catalog agrees with the ledger. The only
thing that cannot be checked from a diff is *who wrote the record* — see §8.

**Rejected.** The pull request is closed with the reason written in it, and the reason is public.
Nothing is added to the ledger; the plugin is simply not in the catalog. A rejection is not a
judgement about the author and a revised submission is welcome — reopen with the changes.

**Accepted without review.** A plugin may be published as `"status": "unreviewed"` — that is the
default for any slug the ledger does not mention, and the catalog says so plainly rather than leaving
the field blank. Unreviewed plugins are installable; they simply carry no claim.

---

## 6. Re-review triggers

A review is a statement about one version and one set of permissions. It expires when:

- **The permission set changes.** This one is *enforced*, not requested: every review is bound to
  `reviewedPermissionsSha256`, the sorted, deduped set of grant tokens (`scope:access`, or the bare
  `network`) at review time. `npm run verify:marketplace` recomputes it from the manifest on disk and
  fails the build when it has moved, naming the reviewer and date it is invalidating. The badge
  cannot survive the exact change it exists to gate. (The human-readable `reason` prose is
  deliberately not part of the hash — a typo fix must not invalidate a review, or people learn to
  re-stamp the hash without looking. A *materially* rewritten rationale is still a trigger under this
  section; that half is a judgement call and no gate pretends otherwise.)
- **The version changes.** Also *enforced*: `reviewedVersion` records the version that was read, and
  the gate fails when the shipped manifest says anything else. A review is a statement about one
  version, and `2.0.0` after a review of `1.x` is a new submission's worth of change — but so is
  `1.0.1` that nobody read.
- **The package contents change.** Also *enforced*, and this is the one that matters most: the
  permission hash pins what the plugin MAY REACH and says nothing at all about what the code DOES
  with it. `reviewedContentSha256` is a digest of the package sources — every file the builder ships
  out of `marketplace/plugins/<slug>/` except the compiled `dist/` — so a reviewed plugin cannot
  replace the whole of `index.js` under the same permissions and keep the badge. Three things are
  deliberately *not* in that digest, each for the same reason the `reason` prose is not in the
  permission hash: the compiled bundles (build output, so a bump of *our* esbuild would otherwise
  revoke *your* review), the `version` and `permissions` (each bound by its own field above, so one
  change never produces two failures), and the manifest's formatting and permission ordering.
- **A security report** against the plugin, whether or not it is confirmed. The badge is suspended
  while the report is open (§7).

Re-review is the same process, not a lighter one. Update the record's `reviewer`, `date`,
`reviewedVersion`, `reviewedPermissionsSha256` and `reviewedContentSha256` when it passes — after
reading the change, never in order to make a red gate green.

**A failed bind is a red build, not a silent downgrade.** The badge is derived from the ledger by the
builder, so quietly republishing the entry as `unreviewed` would need the same rule in a second place
(the exact drift the single shared reader exists to prevent) and would drop a maintainer's recorded
decision with a green check on the run. It costs nothing in routine maintenance: a first-party
package can never be `reviewed` (§8), so nothing this project ships day to day can trip these.

---

## 7. Revocation

A reviewed plugin loses the badge when the review is withdrawn — a confirmed security issue the
author will not fix, a permission grab found after the fact, an author who has become unreachable, or
a repository that has gone dark.

**Mechanically**, revocation is one commit: the ledger record's `status` becomes `"unreviewed"` and
the review evidence goes with it — `reviewer`, `date`, `reviewedVersion` and the two digests are
refused on any record that is not `reviewed` (§9), so a withdrawn review cannot leave a reviewer's
name attached to a claim the record no longer makes. Dropping the entry entirely means the same
thing. Either way the next catalog build publishes an entry with no claim on it; a `notes` line
saying the review was withdrawn and pointing at the pull request is welcome and is published. Nothing else in the pipeline needs to change — the badge is derived, so removing the
record removes the badge everywhere it is rendered. If the plugin must not be installable at all, the
package is removed from `marketplace/plugins/` and the catalog no longer offers it; installs that
already happened are unaffected, which is why the notice below matters.

**Notifying existing installs** uses the persistent admin-notice surface the product already has, and
this policy commits to it rather than inventing a channel: the autoloaded `admin_notices` option,
written by `backend/src/core/admin-notices.ts`, served by `backend/src/routes/notices.ts` and
rendered at `/admin/notices`. It is the right shape for this — records are upserted by a stable `id`
so a hundred restarts leave one row, the original timestamp survives, and a notice can retire itself
via `clearAdminNotice(id)` when the condition clears. A revocation would upsert one notice per
affected installed plugin (`plugin.review-revoked.<slug>`), stating what was withdrawn and why, and
would clear itself if the plugin is later re-reviewed or uninstalled.

*That notification is described here, not implemented.* Wiring it needs a revocation feed the
installation can read — the catalog is fetched from a GitHub Release, so the natural carrier is the
`review` field the installation already receives on every catalog refresh, compared against the
status recorded when the plugin was installed. That comparison does not exist yet and is deliberately
out of scope for this document; what exists today is the ledger, the gate, and the field on the
catalog entry that such a check would read.

---

## 8. Conflict of interest: first-party plugins

**A plugin authored by the WordJS project can never be `reviewed`.** It carries
`"status": "first-party"` instead.

When the reviewer and the author are the same party, "reviewed" certifies nothing — it is the project
vouching for itself while wearing a badge that is supposed to mean an independent look. All 31
plugins currently in the catalog are first-party and are marked as such.

This is not left to the good intentions of whoever edits the ledger. `verify-marketplace.js` fails the
build if a ledger record claims `reviewed` for a plugin whose manifest `author` is the project
(`backend/scripts/marketplace-review.js`, `FIRST_PARTY_AUTHORS`). `first-party` is not a lesser
badge and not a greater one; it is a different statement — *this is our code, held to the same
sandbox and the same gates, and reviewed by nobody outside the project.*

**And the rule runs both ways.** `first-party` is not a label an outside package may award itself: it
is what waives the two §2 requirements that exist *for* outside submissions — an OSI licence and a
public repository where the source of this version can be read — so a package that self-declares it
would opt out of the requirements that make review possible at all and publish this project's own
name as its badge. A `first-party` record whose manifest `author` is not the project fails the build,
and `scan-plugin.mjs` refuses the licence/repository waiver on the same basis rather than on the
ledger's say-so.

**Who may write the ledger.** The one thing no diff can check is who wrote a record, so it is checked
outside the diff. `marketplace/reviews.json` has an owner in `.github/CODEOWNERS`, and a submission
may not edit it in the same pull request as a package (§5, enforced in `plugin-review.yml`). The
CODEOWNERS entry becomes a hard gate — "Require review from Code Owners" on the protected branch —
with the second maintainer account: GitHub does not let an author approve their own pull request, so
requiring code-owner review while there is a single maintainer would block that maintainer from ever
recording a review. Until then, ownership routes every ledger change to the maintainer's review queue
and states in a tracked file what the branch protection has to become.

---

## 9. Catalog and ledger schema (reference)

**`marketplace/reviews.json`** — tracked, hand-edited, the source of truth. A flat map:

```json
{
    "<slug>": {
        "status": "first-party" | "reviewed" | "unreviewed",
        "reviewer": "<github-handle>",
        "date": "YYYY-MM-DD",
        "reviewedVersion": "<semver>",
        "reviewedPermissionsSha256": "<64 hex>",
        "reviewedContentSha256": "<64 hex>",
        "notes": "<published with the catalog entry>"
    }
}
```

| Field | Meaning |
| :-- | :-- |
| `status` | One of the three. A slug that is absent from the ledger is `unreviewed`. |
| `reviewer` | The GitHub handle of the human who did §4. |
| `date` | `YYYY-MM-DD`, validated. |
| `reviewedVersion` | The `manifest.json` version that was read. Semver, validated (§6). |
| `reviewedPermissionsSha256` | The sorted, deduped grant-token set at review time (§6). |
| `reviewedContentSha256` | Digest of the package sources that were read — every file the builder ships except `dist/`, with the manifest canonicalised so that reformatting, the version and the permission list (each bound separately) are not counted twice (§6). |
| `notes` | Free text, published with the catalog entry. The one field any status may carry. |

The five review fields are **required for `reviewed` and refused on every other status** — a record
that claims no review may not name a reviewer or a date. Revoking a review drops them with the status
(§7).

`node backend/scripts/marketplace-review.js <slug>` prints a ready-made record for a package.

**`marketplace-index.json`** — the build output. Every entry gains:

```json
"review": { "status": "…", "reviewer": "…", "date": "…", "notes": "…" }
```

with the optional keys omitted when empty. It is derived by `backend/scripts/build-marketplace.js`
from the ledger through the single shared reader `backend/scripts/marketplace-review.js`, and
re-derived independently by `backend/scripts/verify-marketplace.js`, which fails on any drift between
the two.

---

## 10. How to submit

1. Read `documentation/plugins.md` — especially §7 (permissions and the AST scanner) and §12
   (per-plugin capability grants). Build against the sandbox, not around it.
2. Open a pull request adding `marketplace/plugins/<slug>/`, using the plugin-submission template.
   GitHub has a template chooser for *issues* only, so the template has to be named in the URL:
   **<https://github.com/jaimemartinez/wordjs/compare?template=plugin-submission.md>** (or append
   `?template=plugin-submission.md` to a compare URL you already have). Without it you get the
   repository's default pull-request template, which is not the submission checklist.
3. Watch the **Plugin review** workflow. Green means a reviewer picks it up; red means the checks in
   §3 tell you what to fix. Do not add your own record to `marketplace/reviews.json` — a pull request
   that touches both a package and the ledger is refused (§5).
4. Expect questions about §4 — permission minimality in particular.

Security issues in an *existing* plugin are not pull requests. Follow `SECURITY.md`.

<!--
  Marketplace plugin submission. Read marketplace/REVIEW.md first — it is the whole policy, including
  what the "reviewed" badge does and does not certify (§1) and the checklist a reviewer will hold you
  to (§4). One plugin per pull request.

  Not submitting a plugin? Use the default template instead (drop `?template=plugin-submission.md`
  from the URL).
-->

## The plugin

- **Slug:** `<marketplace/plugins/…>`
- **Name / version:**
- **Author:**
- **License (OSI SPDX):**
- **Source repository:**
- **What it does, in two sentences:**

## Permissions requested

One row per permission, with the justification from your manifest. A reviewer's first question is
always whether each one is the *narrowest capability that works* (REVIEW.md §4).

| Grant token (`scope:access`) | Why the plugin needs it | Why nothing narrower works |
| :-- | :-- | :-- |
| | | |

- [ ] Every permission above appears in `manifest.json` with a `reason` (or a `permissions_rationale` entry)
- [ ] No permission is requested "for a future feature"
- [ ] **If `network` is requested:** every host contacted is named below, or the destination is resolved at runtime and I have said so explicitly and bounded it

<!-- Egress list, if applicable: -->

## Requirements (REVIEW.md §2)

- [ ] `manifest.json` declares `id` (= folder name), `name`, `version`, `description`, `author`, `license`, `repository`
- [ ] `"isolated": true`
- [ ] An OSI-approved license, and the `LICENSE` file ships in the package
- [ ] No `node_modules/` shipped — or `"bundled": true` is declared and the packed zip is under 10 MB
- [ ] No minified-only source; everything the plugin executes is readable at this version
- [ ] Own namespace: tables are `wjp_<slug>_*`, option keys are slug-prefixed
- [ ] No runtime state (`data/`) in the package

## The four questions a reviewer will ask (REVIEW.md §4)

Answer them here — it is much faster than a round trip.

1. **Permission minimality** —
2. **Data handling** — what personal data is collected, where it is stored, whether any of it leaves the installation:
3. **Admin UI content safety** — does the admin page render anything the plugin did not itself produce, and is it escaped?
4. **Update path** — how the plugin migrates its own tables, and what happens on deactivate → reactivate with existing data:

## Testing

- [ ] Installed from a local catalog build and activated on a clean install
- [ ] Exercised on Linux, macOS **and** Windows, or I have said below which I could not test
- [ ] Deactivated and reactivated with data present; nothing was lost
- [ ] The **Plugin review** workflow is green on this pull request

<!--
  What is checked automatically (REVIEW.md §3): manifest requirements, the install-time AST scan,
  sandbox certification (the `Sandbox parity` workflow), catalog integrity and reproducibility, the
  license gate, and the egress rule. A green run is NOT an approval — it means a human can start.
-->

## Anything else the reviewer should know

<!-- Known limitations, deliberate trade-offs, prior art, related plugins. -->

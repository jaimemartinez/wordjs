# Third-Party Notices

WordJS is licensed under the **MIT License** (see [LICENSE](LICENSE)). Every production
dependency is under a permissive license — MIT, ISC, Apache-2.0, BSD-2-Clause/BSD-3-Clause,
0BSD (`tslib`), MIT-0 (`nodemailer`, `smtp-server`), BlueOak-1.0.0 (`glob`, `minimatch`,
`minipass`, `lru-cache`, `jackspeak`, `path-scurry`, `@isaacs/cliui`, `package-json-from-dist`),
Python-2.0 (`argparse`), CC0-1.0 (`mdn-data`) and CC-BY-4.0 (the `caniuse-lite` browser-support
data table; its attribution notice ships inside the package) — or is dual-licensed with a
permissive option that WordJS elects (see below). Three backend packages (`bayes`, `busboy`,
`streamsearch`) publish no SPDX `license` field in their `package.json`, so `license-checker`
reports them as unknown; each is MIT per the LICENSE / README bundled in the package. There are
**no copyleft (GPL/AGPL/LGPL/SSPL) production dependencies that propagate** to WordJS (the sole
LGPL component, the libvips binary behind `sharp`, is addressed below).

This file records the few dependencies whose license metadata is dual-licensed or whose
copyleft component is non-propagating, and the license WordJS elects for each. None of
these create any source-disclosure obligation for WordJS, its distribution, or a hosted/SaaS
offering.

## Dual-licensed dependencies — elected license

| Dependency | Declared | WordJS elects | Notes |
|---|---|---|---|
| `node-forge` | `(BSD-3-Clause OR GPL-2.0)` | **BSD-3-Clause** | Permissive option taken. |
| `@zone-eu/mailsplit` (via `mailparser`) | `(MIT OR EUPL-1.1+)` | **MIT** | Permissive option taken. |
| `dompurify` (frontend) | `(MPL-2.0 OR Apache-2.0)` | **Apache-2.0** | MPL is file-level copyleft only; Apache-2.0 elected for clarity. |
| `expand-template` (via `better-sqlite3` → `prebuild-install`) | `(MIT OR WTFPL)` | **MIT** | Permissive option taken. Build-time helper for downloading prebuilt native binaries; not loaded at runtime. |
| `rc` (via `better-sqlite3` → `prebuild-install`) | `(BSD-2-Clause OR MIT OR Apache-2.0)` | **MIT** | Permissive option taken. Build-time helper for downloading prebuilt native binaries; not loaded at runtime. |

## Non-propagating copyleft component

| Dependency | License | Why it does not affect WordJS's MIT license |
|---|---|---|
| `sharp` / `@img/sharp-*` (libvips) | `Apache-2.0 AND LGPL-3.0-or-later` | The LGPL-3.0 portion is the prebuilt **libvips** native binary, consumed as a **dynamically-linked shared library**. LGPL explicitly permits use inside permissively-licensed / proprietary software without relicensing, provided the library remains replaceable (it is — it is an unmodified upstream binary). The upstream Apache-2.0 NOTICE for sharp is retained by the package. |

## Network-copyleft

There are **no AGPL or SSPL** dependencies anywhere in the tree (all six lockfiles — root,
`backend/`, `frontend/`, `gateway/`, `setup/` and `packages/create-wordjs/` — were checked). A
hosted / managed / SaaS deployment of WordJS therefore carries **no network-copyleft
source-disclosure obligation**. CI enforces this for the **backend production dependency tree**
with a license gate (`npx license-checker --production --failOn 'AGPL;SSPL'`, run in `backend/`
by the Backend job; `license-checker` is a pinned backend devDependency), so a network-copyleft
dependency cannot silently enter the backend and undermine the MIT / commercial position. The
frontend, gateway, setup and create-wordjs trees are **not** covered by that gate; new
dependencies there must be checked at review time (`npx license-checker --production --failOn
'AGPL;SSPL'` in that directory).

> This notice is informational and not legal advice. WordJS's own license is declared
> consistently: the root `LICENSE` file is MIT and every workspace manifest (`package.json`,
> `backend/`, `frontend/`, `gateway/`, `setup/`, `packages/create-wordjs/`) carries
> `"license": "MIT"`. Any change to that license is the copyright holder's decision; consult
> counsel before commercial distribution.

# Third-Party Notices

WordJS is licensed under the **MIT License** (see [LICENSE](LICENSE)). Every production
dependency is under a permissive license (MIT, ISC, Apache-2.0, BSD). There are **no
copyleft (GPL/AGPL/LGPL/SSPL) production dependencies that propagate** to WordJS.

This file records the few dependencies whose license metadata is dual-licensed or whose
copyleft component is non-propagating, and the license WordJS elects for each. None of
these create any source-disclosure obligation for WordJS, its distribution, or a hosted/SaaS
offering.

## Dual-licensed dependencies — elected license

| Dependency | Declared | WordJS elects | Notes |
|---|---|---|---|
| `node-forge` | `(BSD-3-Clause OR GPL-2.0)` | **BSD-3-Clause** | Permissive option taken. |
| `@zone-eu/mailsplit` (via `mailparser`) | `(MIT OR EUPL-1.1+)` | **MIT** | Permissive option taken. |
| `dompurify` | `(MPL-2.0 OR Apache-2.0)` | **Apache-2.0** | MPL is file-level copyleft only; Apache-2.0 elected for clarity. |

## Non-propagating copyleft component

| Dependency | License | Why it does not affect WordJS's MIT license |
|---|---|---|
| `sharp` / `@img/sharp-*` (libvips) | `Apache-2.0 AND LGPL-3.0-or-later` | The LGPL-3.0 portion is the prebuilt **libvips** native binary, consumed as a **dynamically-linked shared library**. LGPL explicitly permits use inside permissively-licensed / proprietary software without relicensing, provided the library remains replaceable (it is — it is an unmodified upstream binary). The upstream Apache-2.0 NOTICE for sharp is retained by the package. |

## Network-copyleft

There are **no AGPL or SSPL** dependencies anywhere in the tree. A hosted / managed / SaaS
deployment of WordJS therefore carries **no network-copyleft source-disclosure obligation**.
CI enforces this with a license gate (`license-checker --production --failOn 'AGPL;SSPL'`) so
a future copyleft dependency cannot silently enter and undermine the MIT / commercial position.

> This notice is informational and not legal advice. The relicensing of WordJS's own
> declared package metadata to MIT (it already shipped an MIT `LICENSE` file) is the
> copyright holder's decision; consult counsel before commercial distribution.

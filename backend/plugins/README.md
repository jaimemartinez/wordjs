# backend/plugins

Installed plugins live here, one folder per plugin (`backend/plugins/<slug>/`). The core repository and
its release ship this folder EMPTY: plugins reach a site only when an administrator installs them —
from the marketplace (`marketplace/plugins/`), by uploading a ZIP, or with
`node backend/cli/wordjs.js create plugin <slug>`.

A minimal reference plugin lives in `documentation/examples/plugins/hello-world/`; copy it here to try it.

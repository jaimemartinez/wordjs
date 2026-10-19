# Archive — historical records

The documents in this folder are **historical records**, kept for the reasoning and the evidence they
hold. They describe the code as it was when they were written, or a plan that has since been carried
out; they are **not** a description of the current code, and their file and line references may no
longer resolve. For how WordJS works today, start at the [documentation index](../README.md).

| Document | What it records |
| --- | --- |
| [plugin-isolation-proposal.md](plugin-isolation-proposal.md) | The original design proposal for running every plugin in a separate OS process behind a capability bridge: the threat model, why `vm` and worker threads were not enough, and the trade-offs. The isolation it proposed has shipped; the current reference is [plugins.md](../plugins.md), [security.md](../security.md) and the `sandbox` block of `backend/src/config/app.ts`. |
| [theme-audit-checklist.md](theme-audit-checklist.md) | The frozen output of one sweep of the theme system, run against the 64-theme marketplace catalogue that has since been retired (formerly `documentation/.audit-checklist.md`). Its header explains which findings no longer reproduce and which are fixed; it is a record, not a live defect list. |

Other design records live next to the code they shaped: [adr/](../adr/) (architecture decision
records for the F0–F6 content program) and [verso/](../verso/README.md) (the Verso editor's specs and
the records of how it replaced the previous editor).

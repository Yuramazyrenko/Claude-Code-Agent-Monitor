# History and statistics: review fixtures

These before/after images use seeded data and real application routes. Remote commands and scheduling were disabled; no private sessions or credentials are included.

- Remote transfer: retry diagnostics remain visible while a source is syncing, then clear after success.
- Settings: a controlled completion burst left an older count of 3; the independently tested change finished with the actual count of 4.
- Cost display: a seeded API-equivalent total of $3,500 stays visible when the activity/system-info requests fail. This is fixture data, not a subscription charge.

The images retain their original executed backend heads. All 20 current frontend runtime assets match through the recorded capture-to-build comparison; source maps differ only in source path arrays. The Settings pair was captured directly on master and the unchanged independent Settings branch. Backend behavior after the final fixes is verified by separate tests.

Local validation: macOS / Node 24.14.0. Full verify/build passed for all seven cumulative checkpoints, and separately for Settings on master. Installed locked-version dependencies were reused. Windows and current minimum-Node/Linux execution were not run locally; PR CI and maintainer review remain required.

| Layer | Server passed / skipped | Client passed |
|---:|---:|---:|
|1|1521 / 1|495|
|2|1540 / 1|496|
|3 cumulative|1540 / 1|507|
|3 independent|1442 / 1|506|
|4|1624 / 1|507|
|5|1634 / 1|516|
|6|1660 / 1|516|
|7|1729 / 1|516|

Final combined source tree: `296cda4a73dd1f24ffcb1ff3824dd43b69dc565b`. The exact tested source trees are retained in the publication commits; only commit subjects and ancestry metadata were prepared for publication.

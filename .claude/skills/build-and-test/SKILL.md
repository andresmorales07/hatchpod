---
name: build-and-test
description: Rebuild server dist, run vitest unit tests, and stage dist changes
disable-model-invocation: true
---

After modifying server/src/ files, run the full rebuild pipeline:

1. `cd server && npm run build` — compile TypeScript to dist/
2. `cd server && npm test` — run vitest unit tests
3. `git add server/dist/` — stage the rebuilt dist files

Report any failures before staging. If the build or tests fail, stop and show the errors — do not stage broken dist output.

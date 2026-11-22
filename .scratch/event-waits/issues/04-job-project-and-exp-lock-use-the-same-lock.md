# 04: job-project and exp-lock use the same lock

**Status:** done
**Owner try:** no
**Blocked by:** 03

**What to build:** 07 S4 (owner default yes): src/roles/job-project.ts and src/collectors/exp-lock.ts converge on abstract-lock.ts.

- [x] One lock primitive in the repo
- [x] npm test passes

## Comments

- Moved `src/roles/job-project.ts` (`job-adopt`), `src/collectors/exp-ledger.ts` (`exp-ledger`), and `src/collectors/exp-proxy-refresh.ts` (`exp-proxy`) onto `src/utils/abstract-lock.ts` and removed `src/collectors/exp-lock.ts`.
- Build, `npm run test:unit`, and targeted `.mjs` suites (`abstract-lock`, `exp-ledger`, `exp-proxy`, `exp-page`, `mcp-job-cache`, `job-supersession`, `thin-mcp-read-wait-send`, `thin-mcp-worker-tools`) passed; full `npm test` left to the land gate per brief.

- Landed 2cdc7f010841931e579a8c28ae4c50d817ba1047; gate 5/5 passed.

#!/usr/bin/env bash
# MCP-ANCESTOR: per profile full set (MCP brief limits) + three-file gate with ancestry probe before/after + package prettier.
set -u
source <VERIFY_ROOT>/followup-scripts/lib.sh
for p in node22-envproxy node24-envproxy; do
  full_set mcp $p 600 1800 600 900 600 900 300 300 60 -
  run mcp $p 11a-ancestry-probe-before 60 - /usr/bin/python3 -I $S/ancprobe.py
  run mcp $p 11-focused-ancestor-gate 300 - node --test packages/hud-mcp/dist/tests/hud-mcp/ancestor-discovery.test.js packages/hud-mcp/dist/tests/hud-mcp/skeleton.test.js packages/hud-mcp/dist/tests/hud-mcp/int-ledger-registry.test.js
  run mcp $p 11b-ancestry-probe-after 60 - /usr/bin/python3 -I $S/ancprobe.py
  run mcp $p 12-prettier-packages 300 - node node_modules/prettier/bin/prettier.cjs --check packages/hud-mcp/src/process.ts tests/hud-mcp/ancestor-discovery.test.ts tests/hud-mcp/skeleton.test.ts tests/hud-mcp/int-ledger-registry.test.ts
done
src_check mcp after-checks
echo MCP-DONE $(date -u +%FT%TZ)

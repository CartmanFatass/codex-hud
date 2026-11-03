#!/usr/bin/env bash
export ISO_NO_NODE_ENV_PROXY=1
for n in hyg2 runz1 perf; do <VERIFY_ROOT>/scripts/checks.sh <VERIFY_ROOT>/runs/20261103T154219Z $n 22 -noenvproxy; done
echo MASTER2-DONE $(date -u +%FT%TZ)

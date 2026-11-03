#!/usr/bin/env bash
R=<VERIFY_ROOT>/runs/20261103T154219Z
for rt in 24 22; do for n in hyg2 runz1 perf; do <VERIFY_ROOT>/scripts/checks.sh $R $n $rt; done; done
<VERIFY_ROOT>/scripts/perfseries.sh $R
echo MASTER-DONE $(date -u +%FT%TZ)

#!/usr/bin/env bash
# drive.sh PROFILE ROW... : run table rows in order via the runner; stop at the first non-PASS row (no skipping, no retry).
V=<VERIFY_ROOT>
RUN=$V/$(cat $V/wave1-merged-tree-LATEST.txt)
prof=$1; shift
cd "$V" || exit 90
for r in "$@"; do
  python3 -I "$RUN/scripts/w1m.py" row "$prof" "$r"
  rc=$?
  if [ $rc -ne 0 ]; then echo "STOP: row $r gate!=PASS (runner rc=$rc)"; exit $rc; fi
done
echo "DRIVE-SEGMENT-DONE $prof $*"

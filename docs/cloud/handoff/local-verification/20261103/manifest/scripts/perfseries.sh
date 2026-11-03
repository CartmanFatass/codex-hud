#!/usr/bin/env bash
# perfseries.sh <R>: RUNZ1 scan cost (3x per runtime) then the declared B10B strict series.
set -u
source <VERIFY_ROOT>/scripts/lib.sh
R=$1; T=$R/manifest/results.tsv
snap() { echo "## $1 $(date -u +%FT%TZ) loadavg: $(cat /proc/loadavg)"; ps -eo pid,comm,pcpu --sort=-pcpu | head -8; }
prun() { # prun <name> <rt> <id> <cmd>
  local n=$1 rt=$2 id=$3 cmd=$4 L=$R/logs/perf-series s e ec; mkdir -p $L
  local W=$V/wt/$n
  { echo "# target=$n runtime=node$rt commit=$(git -C $W rev-parse HEAD) tree=$(git -C $W rev-parse HEAD^{tree})"
    echo "# node binary: $(nodebin $rt)/node ($($(nodebin $rt)/node -v))"; echo "# command: $cmd (via env -i wrapper, fresh HOME, no HUD_HOME)"
    snap before; } > $L/$id.log
  s=$(date -u +%FT%TZ); echo "# start: $s" >> $L/$id.log
  timeout -k 30 1800 bash -c "source $V/scripts/lib.sh; cd $W; iso $rt bash -c '$cmd'" >> $L/$id.log 2>&1; ec=$?
  e=$(date -u +%FT%TZ); { echo "# end: $e"; echo "# exit: $ec"; snap after; } >> $L/$id.log
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "node$rt" "$id" "$ec" "$s" "$e" "$cmd" >> $T
  echo "$id exit=$ec"
}
for rt in 22 24; do for i in 1 2 3; do prun runz1 $rt runz1-perf-node$rt-run$i 'node tests/int/runz1-perf.mjs'; done; done
# Fresh builds of baseline and candidate immediately before the B10B series; record dist provenance.
for n in base perf; do
  ( cd $V/wt/$n; iso 24 bash -c 'npm run build && npm run build:test' > $R/logs/perf-series/build-$n.log 2>&1; echo "# exit: $?" >> $R/logs/perf-series/build-$n.log
    { echo "commit $(git rev-parse HEAD) tree $(git rev-parse HEAD^{tree})"; git status --porcelain; sha256sum tests/unit/b10b-s3-perf.test.ts dist-test/tests/unit/b10b-s3-perf.test.js dist-test/src/render/delegation/*.js dist/render/delegation/*.js 2>/dev/null; } > $R/manifest/dist-provenance-$n.txt )
done
while read -r id n rt; do
  prun $n $rt b10b-$id 'B10B_PERF=1 node --test dist-test/tests/unit/b10b-s3-perf.test.js'
done < $R/manifest/b10b-perf-order.txt

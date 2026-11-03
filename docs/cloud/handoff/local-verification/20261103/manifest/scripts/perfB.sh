#!/usr/bin/env bash
set -u
source <VERIFY_ROOT>/scripts/lib.sh
R=$1; T=$R/manifest/results.tsv; L=$R/logs/perf-series-B; mkdir -p $L
for n in base perf; do ( cd $V/wt/$n; { echo "commit $(git rev-parse HEAD) tree $(git rev-parse HEAD^{tree})"; git status --porcelain; sha256sum tests/unit/b10b-s3-perf.test.ts dist-test/tests/unit/b10b-s3-perf.test.js dist-test/src/render/delegation/*.js dist/render/delegation/*.js 2>/dev/null; } > $R/manifest/dist-provenance-$n-seriesB.txt ); done
while read -r id n rt; do
  W=$V/wt/$n; f=$L/b10b-$id.log; cmd='B10B_PERF=1 node --test dist-test/tests/unit/b10b-s3-perf.test.js'
  { echo "# target=$n runtime=node$rt commit=$(git -C $W rev-parse HEAD) tree=$(git -C $W rev-parse HEAD^{tree})"; echo "# node: $(nodebin $rt)/node $($(nodebin $rt)/node -v)"; echo "# command: $cmd (env -i wrapper, fresh HOME, no HUD_HOME)"; } > $f
  ( while :; do echo "$(date -u +%T) $(cut -d' ' -f1-4 /proc/loadavg) | $(ps -eo comm,pcpu --sort=-pcpu --no-headers | head -5 | awk '{printf "%s:%s ",$1,$2}')"; sleep 1; done ) > $L/b10b-$id.monitor.txt &
  mon=$!
  s=$(date -u +%FT%TZ); echo "# start: $s" >> $f
  timeout -k 30 1800 bash -c "source $V/scripts/lib.sh; cd $W; iso $rt bash -c '$cmd'" >> $f 2>&1; ec=$?
  e=$(date -u +%FT%TZ); kill $mon; wait $mon 2>/dev/null; { echo "# end: $e"; echo "# exit: $ec"; } >> $f
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "node$rt" "b10b-$id" "$ec" "$s" "$e" "$cmd" >> $T; echo "b10b-$id exit=$ec"
done < $R/manifest/b10b-perf-order-seriesB.txt
echo PERFB-DONE $(date -u +%FT%TZ)

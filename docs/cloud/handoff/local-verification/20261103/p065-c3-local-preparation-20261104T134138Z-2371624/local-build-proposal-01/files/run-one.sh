#!/bin/bash
set -u
set -o noclobber
[ "$#" -eq 1 ] || exit 64
stage="$1"; mode="check"
case "$stage" in 1) cap=230;; *) exit 2;; esac
base=/LV/p065-c3-local-preparation-20261104T134138Z-2371624/p065-local-build-node24-01
py=/usr/bin/python3
if [ "$mode" = check ]; then
 /usr/bin/timeout 60s "$py" -I -S -B "$base/check.py" "$stage" before > "$base/stage-$stage-before.jsonl" 2> "$base/stage-$stage-before.stderr"
 check=$?;tail -n 1 "$base/stage-$stage-before.jsonl"
 if [ "$check" -ne 0 ]; then exit "$check"; fi
fi
"$py" -I -S -B -c 'import datetime,time;print(datetime.datetime.now(datetime.timezone.utc).isoformat(),time.monotonic_ns())' > "$base/stage-$stage-outer-start.txt"
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 TZ=UTC /usr/bin/timeout --foreground --signal=TERM --kill-after=10s "${cap}s" "$py" -I -S -B "$base/stage-$stage-launcher.py" </dev/null > "$base/stage-$stage-outer.stdout" 2> "$base/stage-$stage-outer.stderr"
status=$?
"$py" -I -S -B -c 'import datetime,time;print(datetime.datetime.now(datetime.timezone.utc).isoformat(),time.monotonic_ns())' > "$base/stage-$stage-outer-end.txt"
printf '%s\n' "$status" > "$base/stage-$stage-outer-status.txt"
printf 'outer=%s\n' "$status"
if [ "$status" -ne 0 ]; then exit "$status"; fi
"$py" -I -S -B -c 'import json,sys; e=[json.loads(l) for l in open(sys.argv[1])];r=e[-1];print(json.dumps(r,sort_keys=True));assert r["event"]=="result" and r["direct_exitcode"]==0 and r["lifecycle_valid"] and r["closure"] and r["postcheck_ok"] and r["failure"] is None and any(x.get("event")=="wait_echild" for x in e)' "/LV/p065-c3-local-preparation-20261104T134138Z-2371624/p065-local-build-node24-stage-$stage-evidence-01/events.jsonl"
event=$?
if [ "$event" -ne 0 ]; then exit "$event"; fi
if [ "$stage" -ge 2 ]; then tail -n 10 "/LV/p065-c3-local-preparation-20261104T134138Z-2371624/p065-local-build-node24-stage-$stage-evidence-01/stdout.raw"; fi
/usr/bin/timeout 60s "$py" -I -S -B "$base/check.py" "$stage" after > "$base/stage-$stage-after.jsonl" 2> "$base/stage-$stage-after.stderr"
check=$?;tail -n 1 "$base/stage-$stage-after.jsonl"
exit "$check"

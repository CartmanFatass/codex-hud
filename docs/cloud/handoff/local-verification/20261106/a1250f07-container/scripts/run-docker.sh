#!/usr/bin/env bash
# usage: run-docker.sh <n24|n22> <id> <timeout_s> [--color] -- argv...
set -u
R="$(cd "$(dirname "$0")" && pwd)"
v="$1"; id="$2"; to="$3"; shift 3; color=0
if [ "${1:-}" = "--color" ]; then color=1; shift; fi
[ "$1" = "--" ] && shift
case $v in n24|n24b) img=node:24.22.1-bookworm;; n22|n22b) img=node:22.23.4-bookworm;; *) exit 2;; esac
MID=(); [ -f "$R/$v/machine-id" ] && MID=(-v "$R/$v/machine-id:/etc/machine-id:ro")
W="$R/$v"; out="$W/logs/$id.stdout"; err="$W/logs/$id.stderr"
name="hudverify-$v-$id-$$"
E=(-e HOME=/work/home -e HUD_HOME=/work/hud -e CODEX_HOME=/work/codex -e CLAUDE_CONFIG_DIR=/work/claude -e PI_CODING_AGENT_DIR=/work/pi -e TMPDIR=/work/tmp -e TMUX_TMPDIR=/work/tmp -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8 -e CI=1)
[ $color = 0 ] && E+=(-e NO_COLOR=1)
start=$(date -u +%FT%T.%3NZ)
docker run --rm --init --name "$name" --network none --user 1000:1000 --pids-limit 4096 "${MID[@]}" "${E[@]}" -v "$W:/work" -w /work/src "$img" \
  timeout --kill-after=10 "$to" "$@" >"$out" 2>"$err"
rc=$?
end=$(date -u +%FT%T.%3NZ)
left=$(docker ps -aq --filter "name=^$name\$")
cleanup=$([ -z "$left" ] && echo CONFIRMED || echo UNKNOWN)
node -e '
const [id,v,img,start,end,rc,to,color,cleanup,out,err,...argv]=process.argv.slice(1);
const fs=require("fs"),path=require("path");const o=fs.readFileSync(out,"utf8");
const g=(k)=>{const m=[...o.matchAll(new RegExp("^(?:#|ℹ) "+k+" (\\d+)","gm"))];return m.length?Number(m.at(-1)[1]):null};
const rec={id,node:v,image:img,mode:"synthetic",command:argv,start,end,timeoutSec:Number(to),exitCode:Number(rc),timedOut:rc==="124"||rc==="137",noColor:color==="0",
tests:{tests:g("tests"),pass:g("pass"),fail:g("fail"),skipped:g("skipped"),todo:g("todo"),cancelled:g("cancelled")},cleanup,stdout:path.basename(out),stderr:path.basename(err)};
fs.appendFileSync(path.join(path.dirname(out),"..","results.jsonl"),JSON.stringify(rec)+"\n");
console.log(id,"exit="+rc,JSON.stringify(rec.tests),"cleanup="+cleanup);' "$id" "$v" "$img" "$start" "$end" "$rc" "$to" "$color" "$cleanup" "$out" "$err" "$@"
exit $rc

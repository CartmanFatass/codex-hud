#!/usr/bin/env bash
# usage: run-step.sh <id> <timeout_s> [--color] -- argv...
set -u
R="$(cd "$(dirname "$0")" && pwd)"; C="$R/src"
id="$1"; to="$2"; shift 2; color=0
if [ "${1:-}" = "--color" ]; then color=1; shift; fi
[ "$1" = "--" ] && shift
NODEBIN=$NVM_NODE/v24.22.1/bin
ENVS=(PATH="$NODEBIN:/usr/bin:/bin" HOME="$R/home" HUD_HOME="$R/hud" CODEX_HOME="$R/codex" CLAUDE_CONFIG_DIR="$R/claude" PI_CODING_AGENT_DIR="$R/pi" TMPDIR="$R/tmp" TMUX_TMPDIR="$R/tmp" LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=1)
[ $color = 0 ] && ENVS+=(NO_COLOR=1)
out="$R/logs/$id.stdout"; err="$R/logs/$id.stderr"
start=$(date -u +%FT%T.%3NZ)
( cd "$C" && env -i "${ENVS[@]}" timeout --kill-after=10 "$to" "$@" ) >"$out" 2>"$err"
rc=$?
end=$(date -u +%FT%T.%3NZ)
"$NODEBIN/node" -e '
const [id,start,end,rc,to,color,out,err,...argv]=process.argv.slice(1);
const fs=require("fs");const o=fs.readFileSync(out,"utf8");
const g=(k)=>{const m=[...o.matchAll(new RegExp("^(?:#|ℹ) "+k+" (\\d+)","gm"))];return m.length?Number(m.at(-1)[1]):null};
const rec={id,command:argv,start,end,timeoutSec:Number(to),exitCode:Number(rc),timedOut:rc==="124"||rc==="137",noColor:color==="0",
tests:{tests:g("tests"),pass:g("pass"),fail:g("fail"),skipped:g("skipped"),todo:g("todo"),cancelled:g("cancelled")},stdout:out,stderr:err};
fs.appendFileSync(process.argv[1].replace(/$/,"")&&require("path").join(require("path").dirname(out),"..","results.jsonl"),JSON.stringify(rec)+"\n");
console.log(JSON.stringify(rec));' "$id" "$start" "$end" "$rc" "$to" "$color" "$out" "$err" "$@"
exit $rc

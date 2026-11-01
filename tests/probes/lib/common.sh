#!/usr/bin/env bash
# Shared helpers for the A3 probes (and the later A8 probe).
#
# Every probe script sources this file, calls probe_begin <name>, does its work
# in $PROBE_WORK and writes raw evidence to tmp/tasks/A3/evidence/<name>/.
# probe_begin installs a trap that closes every Herdr tab the script created.
set -u

PROBE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_ROOT="$(cd "$PROBE_LIB_DIR/../../.." && pwd)"
PROBE_SERVER="$PROBE_LIB_DIR/probe-mcp-server.mjs"
PROBE_EVIDENCE_ROOT="$PROBE_ROOT/tmp/tasks/A3/evidence"
PROBE_WORKSPACE="${PROBE_WORKSPACE:-w3Q}"
PROBE_TABS=()
PROBE_LAST_TAB=""
PROBE_LAST_PANE=""

probe_log() {
  printf '[%s] %s\n' "${PROBE_NAME:-probe}" "$*"
}

probe_note() {
  printf '%s\n' "$*" >>"$PROBE_EVID/notes.txt"
  probe_log "$*"
}

probe_fail() {
  probe_note "FAILED: $*"
  printf '[%s] probe could not run: %s\n' "${PROBE_NAME:-probe}" "$*" >&2
  exit 2
}

probe_versions() {
  local out="$1"
  {
    printf 'date: %s\n' "$(date -Is)"
    printf 'codex: %s\n' "$(zsh -ic 'codex --version' 2>/dev/null | tail -1)"
    printf 'claude: %s\n' "$(claude --version 2>/dev/null | tail -1)"
    printf 'pi: %s\n' "$(pi --version 2>/dev/null | tail -1)"
    printf 'herdr: %s\n' "$(herdr --version 2>/dev/null | tail -1)"
    printf 'node: %s\n' "$(node --version 2>/dev/null)"
    printf 'kernel: %s\n' "$(uname -r)"
  } >"$out"
}

json_field() {
  # json_field <dot.path> ; reads JSON from stdin, prints the value or "".
  node -e '
    const fs = require("node:fs");
    let value = JSON.parse(fs.readFileSync(0, "utf8"));
    for (const key of process.argv[1].split(".")) {
      value = value == null ? undefined : value[key];
    }
    process.stdout.write(value == null ? "" : String(value));
  ' "$1"
}

probe_begin() {
  PROBE_NAME="$1"
  PROBE_EVID="$PROBE_EVIDENCE_ROOT/$PROBE_NAME"
  rm -rf "$PROBE_EVID"
  mkdir -p "$PROBE_EVID"
  PROBE_WORK="$(mktemp -d "${TMPDIR:-/tmp}/a3-$PROBE_NAME.XXXXXX")"
  mkdir -p "$PROBE_WORK/tmp" "$PROBE_WORK/home"
  # Run-owned HUD state: harnesses and extensions must never see the user's
  # ~/.hud. Exported so local runs inherit it, and passed to Herdr panes with
  # --env (see probe_tab_create).
  HUD_HOME="$PROBE_WORK/hud-home"
  mkdir -p "$HUD_HOME"
  export HUD_HOME
  : >"$PROBE_EVID/notes.txt"
  trap probe_cleanup EXIT INT TERM
  probe_versions "$PROBE_EVID/versions.txt"
  probe_note "work dir: $PROBE_WORK"
  probe_note "HUD_HOME: $HUD_HOME"
  probe_note "evidence dir: $PROBE_EVID"
}

probe_cleanup() {
  local tab
  for tab in "${PROBE_TABS[@]:-}"; do
    [ -n "$tab" ] || continue
    herdr tab close "$tab" >/dev/null 2>&1 || true
  done
  PROBE_TABS=()
  # Remove only paths this run owns: the work dir (and the temporary HUD_HOME
  # inside it). No shared fallback file exists, so other runs are never touched.
  if [ -n "${PROBE_WORK:-}" ] && [ -d "$PROBE_WORK" ]; then
    rm -rf "$PROBE_WORK" 2>/dev/null || true
  fi
}

probe_ps() {
  # probe_ps <out> ; probe-owned processes only, one row per pid: pid, ppid,
  # comm and the first argv element. The set is this script's process tree plus
  # the ancestry of every probe server recorded in the evidence so far. Host
  # processes outside that set are never recorded and their command lines are
  # never read; daemon presence is checked by process name (probe_proc_comm).
  local out="$1"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [out, evid, selfPid] = process.argv.slice(1);

    const readStat = (pid) => {
      try {
        const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = text.lastIndexOf(")");
        const comm = text.slice(text.indexOf("(") + 1, close);
        const ppid = Number(text.slice(close + 2).split(" ")[1]);
        return { pid: Number(pid), ppid: Number.isFinite(ppid) ? ppid : 0, comm };
      } catch {
        return null;
      }
    };
    const readArgv0 = (pid) => {
      try {
        return (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] || "").slice(0, 160);
      } catch {
        return "";
      }
    };

    // Live process table (pid -> ppid/comm) so the probe tree can be walked.
    const table = new Map();
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const info = readStat(name);
      if (info) table.set(info.pid, info);
    }

    const owned = new Map();
    const add = (pid, fallback) => {
      if (!Number.isInteger(pid) || pid <= 1 || owned.has(pid)) return;
      const info = table.get(pid) || fallback;
      if (!info) return;
      owned.set(pid, {
        pid,
        ppid: info.ppid ?? 0,
        comm: info.comm || "",
        argv0: readArgv0(pid) || info.argv0 || "",
      });
    };

    // 1. this script and its descendants.
    const children = new Map();
    for (const info of table.values()) {
      if (!children.has(info.ppid)) children.set(info.ppid, []);
      children.get(info.ppid).push(info.pid);
    }
    const pending = [Number(selfPid)];
    while (pending.length) {
      const pid = pending.pop();
      add(pid);
      for (const child of children.get(pid) || []) pending.push(child);
    }

    // 2. the ancestry of every probe server recorded in the evidence so far.
    let files = [];
    try {
      files = fs.readdirSync(evid).filter((name) => name.endsWith(".jsonl"));
    } catch {}
    for (const name of files) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(evid, name), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.probe !== "probe-mcp-server") continue;
        add(Number(record.pid));
        add(Number(record.ppid));
        for (const item of record.chain || []) add(Number(item.pid), { ppid: 0, comm: item.comm, argv0: item.argv0 });
      }
    }

    const rows = [...owned.values()].sort((a, b) => a.pid - b.pid);
    const lines = ["pid\tppid\tcomm\targv0", ...rows.map((row) => [row.pid, row.ppid, row.comm, row.argv0].join("\t"))];
    fs.writeFileSync(out, `${lines.join("\n")}\n`);
  ' "$out" "$PROBE_EVID" "$$"
}

probe_proc_comm() {
  # probe_proc_comm <pid> ; process name only (never the command line)
  head -1 "/proc/$1/comm" 2>/dev/null
}

probe_env_summary() {
  # probe_env_summary <jsonl> ; first record's env object with every value that
  # is not a probe-owned `probe-` sentinel redacted. The server already redacts
  # before recording; this keeps the printed summary safe for older records too.
  local file="$1"
  [ -f "$file" ] || return 0
  head -1 "$file" | jq -c '
    (.env // {})
    | with_entries(.value |= (if (type == "string") and startswith("probe-") then . else "<redacted>" end))
  ' 2>/dev/null
}

probe_field() {
  # probe_field <jsonl> <top-level field> ; unique values, comma separated
  local file="$1" field="$2"
  [ -f "$file" ] || return 0
  node -e '
    const fs = require("node:fs");
    const values = new Set();
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record[process.argv[2]] !== undefined) values.add(String(record[process.argv[2]]));
      } catch {}
    }
    process.stdout.write([...values].join(","));
  ' "$file" "$field"
}

probe_proc_env() {
  # probe_proc_env <pid> <outfile> <key>... ; selected keys only, token-ish values redacted
  local pid="$1" out="$2"
  shift 2
  : >"$out"
  local key value
  for key in "$@"; do
    value="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | sed -n "s/^$key=//p" | head -1)"
    case "$key" in
      *TOKEN* | *SECRET* | *KEY* | *PASSWORD* | *AUTH* | *CLAIM* | *CREDENTIAL*) value="<redacted>" ;;
    esac
    printf '%s=%s\n' "$key" "$value" >>"$out"
  done
}

probe_herdr_tabs() {
  herdr tab list --workspace "$PROBE_WORKSPACE" >"$1" 2>&1 || true
}

probe_tab_create() {
  # probe_tab_create <label> <cwd> [extra herdr tab create args...]
  # The run-owned HUD_HOME is injected through --env so the pane's harnesses
  # never fall back to the user's HUD state.
  local label="$1" cwd="$2"
  shift 2
  local json args=(--workspace "$PROBE_WORKSPACE" --label "probe:$label" --no-focus --cwd "$cwd")
  [ -n "${HUD_HOME:-}" ] && args+=(--env "HUD_HOME=$HUD_HOME")
  args+=("$@")
  json="$(herdr tab create "${args[@]}" 2>>"$PROBE_EVID/herdr-errors.txt")" ||
    probe_fail "herdr tab create failed for $label"
  printf '%s\n' "$json" >>"$PROBE_EVID/herdr.jsonl"
  PROBE_LAST_TAB="$(printf '%s' "$json" | json_field result.tab.tab_id)"
  PROBE_LAST_PANE="$(printf '%s' "$json" | json_field result.root_pane.pane_id)"
  [ -n "$PROBE_LAST_TAB" ] && [ -n "$PROBE_LAST_PANE" ] || probe_fail "herdr tab create returned no ids"
  PROBE_TABS+=("$PROBE_LAST_TAB")
  probe_note "created tab $PROBE_LAST_TAB pane $PROBE_LAST_PANE label probe:$label"
}

probe_tab_close() {
  local tab="$1"
  herdr tab close "$tab" >/dev/null 2>&1 || true
  local kept=() t
  for t in "${PROBE_TABS[@]:-}"; do
    [ -n "$t" ] || continue
    [ "$t" = "$tab" ] || kept+=("$t")
  done
  PROBE_TABS=("${kept[@]:-}")
}

probe_pane_run() {
  local pane="$1" command="$2"
  herdr pane run "$pane" "$command" >>"$PROBE_EVID/herdr.jsonl" 2>>"$PROBE_EVID/herdr-errors.txt" ||
    probe_fail "herdr pane run failed on $pane"
}

probe_pane_read() {
  local pane="$1" lines="$2" out="$3"
  herdr pane read "$pane" --lines "$lines" >"$out" 2>&1 || true
}

probe_pane_send_text() {
  local pane="$1" text="$2"
  herdr pane send-text "$pane" "$text" >/dev/null 2>&1 || true
}

probe_pane_send_keys() {
  local pane="$1"
  shift
  herdr pane send-keys "$pane" "$@" >/dev/null 2>&1 || true
}

probe_count_kind() {
  # probe_count_kind <jsonl> <kind>
  local file="$1" kind="$2"
  [ -f "$file" ] || {
    printf '0'
    return
  }
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const kind = process.argv[2];
    let count = 0;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).kind === kind) count += 1;
      } catch {}
    }
    process.stdout.write(String(count));
  ' "$file" "$kind"
}

probe_count_calls() {
  # probe_count_calls <jsonl> ; counts tools/call requests (one per probe call)
  local file="$1"
  [ -f "$file" ] || {
    printf '0'
    return
  }
  node -e '
    const fs = require("node:fs");
    let count = 0;
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.kind === "request" && record.method === "tools/call") count += 1;
      } catch {}
    }
    process.stdout.write(String(count));
  ' "$file"
}

probe_wait_calls() {
  # probe_wait_calls <jsonl> <count> <timeout-seconds>
  local file="$1" want="$2" limit="$3"
  local started now count
  started="$(date +%s)"
  while :; do
    count="$(probe_count_calls "$file")"
    [ "$count" -ge "$want" ] && return 0
    now="$(date +%s)"
    [ $((now - started)) -ge "$limit" ] && return 1
    sleep 1
  done
}

probe_wait_kind() {
  # probe_wait_kind <jsonl> <kind> <count> <timeout-seconds>
  local file="$1" kind="$2" want="$3" limit="$4"
  local started now count
  started="$(date +%s)"
  while :; do
    count="$(probe_count_kind "$file" "$kind")"
    [ "$count" -ge "$want" ] && return 0
    now="$(date +%s)"
    [ $((now - started)) -ge "$limit" ] && return 1
    sleep 1
  done
}

probe_wait_file() {
  # probe_wait_file <path> <timeout-seconds>
  local file="$1" limit="$2"
  local started now
  started="$(date +%s)"
  while :; do
    [ -s "$file" ] && return 0
    now="$(date +%s)"
    [ $((now - started)) -ge "$limit" ] && return 1
    sleep 1
  done
}

probe_wait_pid_gone() {
  # probe_wait_pid_gone <pid> <timeout-seconds>
  local pid="$1" limit="$2"
  local started now
  started="$(date +%s)"
  while :; do
    kill -0 "$pid" 2>/dev/null || return 0
    now="$(date +%s)"
    [ $((now - started)) -ge "$limit" ] && return 1
    sleep 1
  done
}

probe_pid_alive() {
  kill -0 "$1" 2>/dev/null
}

probe_server_summary() {
  # probe_server_summary <jsonl>... ; one line per record: kind pid ppid comm-chain
  local file
  for file in "$@"; do
    [ -f "$file" ] || continue
    printf '# %s\n' "$(basename "$file")" >>"$PROBE_EVID/server-summary.txt"
    node -e '
      const fs = require("node:fs");
      const file = process.argv[1];
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const chain = (record.chain || []).map((item) => `${item.comm}(${item.pid})`).join(" <- ");
        const meta = record.params && record.params._meta ? JSON.stringify(record.params._meta) : "";
        console.log([record.kind, record.pid, record.ppid, chain, record.method || "", meta].join("\t"));
      }
    ' "$file" >>"$PROBE_EVID/server-summary.txt"
  done
}

probe_jsonl_meta() {
  # probe_jsonl_meta <jsonl> ; prints pid, ppid, chain and _meta per call record
  local file="$1"
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.kind !== "request" || record.method !== "tools/call") continue;
      const chain = (record.chain || []).map((item) => `${item.comm}(${item.pid})`).join(" <- ");
      console.log(JSON.stringify({ pid: record.pid, ppid: record.ppid, chain, meta: record.params?._meta ?? null }));
    }
  ' "$file"
}

cmd_join() {
  # cmd_join <arg>... ; prints a shell command line with each argument quoted.
  local out="" arg
  for arg in "$@"; do
    out+="$(printf '%q' "$arg") "
  done
  printf '%s' "${out% }"
}

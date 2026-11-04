#!/usr/bin/env python3
"""Builds SUMMARY.json and REPORT.md inputs from the per-command result.json/meta.json (local raw tree).
Read-only on logs; writes manifest/extra-checks.json, SUMMARY.json and REPORT.md into RUN."""
import json, os, re, glob, hashlib, subprocess, sys

V = "<VERIFY_ROOT>"
RUN = f"{V}/{open(V + '/wave1-merged-tree-LATEST.txt').read().strip()}"
RUNID = os.path.basename(RUN)
plan = json.load(open(f"{RUN}/profile-plan.json"))
PROFS = plan["profiles_order"]
ROWS = [r["id"] for r in plan["rows"]]
NPM_HDR = re.compile(r"^> (\S+)@(\S+) (\S+)$")
CNT = re.compile(r"^(?:#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$")


def stage_counts(text):
    """per npm stage: all summary blocks, plus the stage's own (last) block"""
    stages, cur = [], dict(stage="(top)", blocks=[], cur={})
    def flush():
        if cur["cur"]:
            cur["blocks"].append(cur["cur"])
            cur["cur"] = {}
    for line in text.splitlines():
        m = NPM_HDR.match(line)
        if m:
            flush()
            stages.append(cur)
            cur = dict(stage=m.group(3), blocks=[], cur={})
            continue
        c = CNT.match(line)
        if c:
            k = c.group(1)
            if k == "tests" and "tests" in cur["cur"]:
                flush()
            cur["cur"][k] = int(c.group(2))
    flush()
    stages.append(cur)
    out = []
    for s in stages:
        if s["blocks"]:
            out.append(dict(stage=s["stage"], summary_blocks=s["blocks"], stage_own_summary=s["blocks"][-1]))
    return out


def load(p):
    return json.load(open(p)) if os.path.exists(p) else None


summary = dict(run_id=RUNID, plan_sha256=hashlib.sha256(open(f"{RUN}/profile-plan.json", "rb").read()).hexdigest(),
               identity=plan["identity"], profiles={})
for prof in PROFS:
    P = dict(runtime=plan["profiles"][prof]["runtime_identity"], rows={}, extra={})
    for rid in sorted(os.listdir(f"{RUN}/logs/{prof}")):
        d = f"{RUN}/logs/{prof}/{rid}"
        r, m = load(d + "/result.json"), load(d + "/meta.json")
        if r is None:
            continue
        entry = dict(
            log_dir=f"logs/{prof}/{rid}", capture_dir=f"captures/{prof}/{rid}",
            argv=r.get("argv"), gate=r.get("gate"), raw_exit=(r.get("command") or {}).get("raw_exit"),
            native_signal=(r.get("command") or {}).get("native_signal"),
            timeout_s=(m or {}).get("timeout_s"), timeout_triggered=(r.get("supervisor") or {}).get("timeout_triggered"),
            supervisor_signals_sent=(r.get("supervisor") or {}).get("sent"),
            start=(r.get("times") or {}).get("start"), command_exit_observed=(r.get("times") or {}).get("command_exit_observed"),
            duration_s=(r.get("times") or {}).get("duration_to_exit_s"),
            stdout_sha256=((r.get("streams") or {}).get("stdout") or {}).get("sha256"),
            stderr_sha256=((r.get("streams") or {}).get("stderr") or {}).get("sha256"),
            stdout_bytes=((r.get("streams") or {}).get("stdout") or {}).get("bytes"),
            stderr_bytes=((r.get("streams") or {}).get("stderr") or {}).get("bytes"),
            streams_both_closed=(r.get("streams") or {}).get("both_closed"), logging_ok=(r.get("logging") or {}).get("ok"),
            owned_state=(r.get("closeout") or {}).get("owned_state"),
            owned_identities_recorded=(r.get("closeout") or {}).get("recorded_identities"),
            source_unchanged=(r.get("source") or {}).get("unchanged"), anomalies=r.get("anomalies"),
            reason=r.get("reason"))
        if os.path.exists(d + "/stdout.raw"):
            txt = open(d + "/stdout.raw", "rb").read().decode(errors="replace")
            sc = stage_counts(txt)
            entry["stage_counts"] = sc
            entry["counts_runner_sum"] = (r.get("counts") or {}).get("totals")
            # headline = the stage-own summaries summed (nested child summaries excluded)
            tot = dict(tests=0, pass_=0, fail=0, cancelled=0, skipped=0, todo=0)
            for s in sc:
                o = s["stage_own_summary"]
                for k in ("tests", "fail", "cancelled", "skipped", "todo"):
                    tot[k] += o.get(k, 0)
                tot["pass_"] += o.get("pass", 0)
            entry["counts_stage_own"] = {("pass" if k == "pass_" else k): v for k, v in tot.items()}
            entry["npm_stages_executed"] = [s["stage"] for s in sc]
        if m:
            entry["env_node_use_env_proxy"] = m["node_use_env_proxy_in_env"]
            entry["env_node_options_present"] = m["node_options_present"]
            entry["env_warning_vars_present"] = dict(NODE_NO_WARNINGS=m["node_no_warnings_present"], NODE_REDIRECT_WARNINGS=m["node_redirect_warnings_present"])
            entry["env_color_vars_present"] = dict(NO_COLOR=m["no_color_present"], FORCE_COLOR=m["force_color_present"])
            entry["proxy_names_present"] = m["proxy_names_present"]
        stderr_p = d + "/stderr.raw"
        if os.path.exists(stderr_p):
            se = open(stderr_p, "rb").read().decode(errors="replace")
            entry["stderr_lines"] = se.count("\n")
            entry["stderr_has_UNDICI_EHPA_warning"] = "UNDICI-EHPA" in se
        (P["rows"] if rid in ROWS else P["extra"])[rid] = entry
    # failing test names per row from stdout
    for rid, e in list(P["rows"].items()) + list(P["extra"].items()):
        p = f"{RUN}/logs/{prof}/{rid}/stdout.raw"
        if os.path.exists(p) and e.get("raw_exit") not in (0, None):
            txt = open(p, "rb").read().decode(errors="replace")
            e["failing_tests"] = sorted(set(re.findall(r"^✖ (.+?) \(\d[\d.]*ms\)$", txt, re.M)))[:20]
    # profile-level identity checks
    cps = {os.path.basename(f)[len(prof) + 1:-5]: load(f) for f in glob.glob(f"{RUN}/manifest/checkpoints/{prof}-*.json")}
    P["checkpoints"] = {k: {"source_sha": v["source"]["tracked_nondep_sha256"], "M": v["source"]["head_is_M"], "R": v["source"]["tree_is_R"],
                            "parents": v["source"]["parents_are_T_H"], "nondep_dirty": v["source"]["porcelain_non_dependency_non_generated"],
                            "deps": (v.get("dependencies") or {}).get("manifest_sha256"),
                            "generated": (v.get("generated") or {}).get("manifest_sha256")} for k, v in sorted(cps.items())}
    summary["profiles"][prof] = P

# cross-profile facts
facts = {}
gens = {prof: [c["generated"] for c in P["checkpoints"].values() if c["generated"]] for prof, P in summary["profiles"].items()}
deps = {prof: [c["deps"] for c in P["checkpoints"].values() if c["deps"]] for prof, P in summary["profiles"].items()}
facts["generated_manifest_sha256_per_profile"] = {k: sorted(set(v)) for k, v in gens.items()}
facts["dependency_manifest_sha256_per_profile"] = {k: sorted(set(v)) for k, v in deps.items()}
facts["source_digest_all_checkpoints_and_rows"] = sorted({
    *[c["source_sha"] for P in summary["profiles"].values() for c in P["checkpoints"].values()],
    *[e["source_sha"] for e in []]})
rowsrc = set()
for prof, P in summary["profiles"].items():
    for e in list(P["rows"].values()) + list(P["extra"].values()):
        rid_dir = f"{RUN}/{e['log_dir']}/result.json"
        r = load(rid_dir)
        if r and r.get("source"):
            rowsrc.add(r["source"]["before"]["tracked_nondep_sha256"])
            rowsrc.add(r["source"]["after"]["tracked_nondep_sha256"])
facts["source_digest_before_after_every_command"] = sorted(rowsrc)
facts["control_profile_never_had_NODE_USE_ENV_PROXY"] = all(
    e.get("env_node_use_env_proxy") is False for e in list(summary["profiles"]["node22-noenvproxy-control"]["rows"].values()) + list(summary["profiles"]["node22-noenvproxy-control"]["extra"].values()))
facts["envproxy_profiles_always_had_NODE_USE_ENV_PROXY"] = all(
    e.get("env_node_use_env_proxy") is True for pr in ("node22-envproxy", "node24-envproxy") for e in list(summary["profiles"][pr]["rows"].values()) + list(summary["profiles"][pr]["extra"].values()))
facts["same_node22_binary_sha256_both_node22_profiles"] = (plan["profiles"]["node22-envproxy"]["runtime_identity"]["node_sha256"] == plan["profiles"]["node22-noenvproxy-control"]["runtime_identity"]["node_sha256"])
summary["cross_profile_facts"] = facts

# gate
table = {}
for prof, P in summary["profiles"].items():
    table[prof] = {rid: (P["rows"][rid]["gate"] if rid in P["rows"] else "NOT RUN") for rid in ROWS}
summary["gate_table"] = table
json.dump(summary, open(f"{RUN}/SUMMARY.json", "w"), indent=1)

# console digest
for prof, P in summary["profiles"].items():
    print("==", prof)
    for rid in ROWS:
        e = P["rows"].get(rid)
        if not e:
            print("  ", rid, "NOT RUN"); continue
        print("  %-18s exit=%s gate=%s dur=%ss own=%s stages=%s" % (rid, e["raw_exit"], e["gate"], e["duration_s"], e["counts_stage_own"] if "counts_stage_own" in e else "-", e.get("npm_stages_executed", "")))
    for rid, e in P["extra"].items():
        print("  extra", rid, "exit=%s gate=%s own=%s" % (e["raw_exit"], e["gate"], e.get("counts_stage_own")))
print(json.dumps(facts, indent=1))

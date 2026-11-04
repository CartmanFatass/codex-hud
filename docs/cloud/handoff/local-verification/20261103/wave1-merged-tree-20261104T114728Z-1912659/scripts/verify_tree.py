#!/usr/bin/env python3
"""Round C3-merged-tree: independent 3-way prediction vs. actual merge tree R.

usage: verify_tree.py REPO OUTDIR
Read-only against the repo (git ls-tree / rev-parse / cat-file only).
"""
import json, subprocess, sys, hashlib

REPO, OUT = sys.argv[1], sys.argv[2]
T = "9dd4d06d2ee5ebb022719d11b74d6de0276172a4"
H = "09d9c3d95fe42932ecaf35dd46806a8747681aa7"
R = "48f59142862f643a98286e3d196d23ff13059a23"
C3 = "36d3fd584bd403ed7ada95d1d863a8f63e96588b"
U = "f248f320d42528fd1eb97db9f1cd2ba97e6d3c86"
T_PREV = "4d0b7f146a55cbd631a31a8ce6b6ca9f33ee6dd2"

SRC = {
    "b4047320262f72f401a513db07236ff1473db933": """src/cli/link-export.ts
src/ledger/runtime.ts
tests/int/node-startup-diagnostics.ts
tests/int/process-client.ts
tests/unit/b12d-wal.test.ts
tests/unit/b12r-store.test.ts
tests/unit/b16-writer.test.ts
tests/unit/b45-launch.test.ts
tests/unit/hud-link-export.test.ts
tests/unit/node-proxy-profile.test.ts
tests/unit/process-client.test.ts
tests/unit/run-light-leader.test.ts
tests/unit/run-process.test.ts""".split(),
    "b2897a4f9769bca6305ff0e3ae3dc694a9320ffe": """packages/hud-mcp/src/process.ts
tests/hud-mcp/ancestor-discovery.test.ts
tests/hud-mcp/int-ledger-registry.test.ts
tests/hud-mcp/skeleton.test.ts""".split(),
    "7ba567ee0c3cd12933d79a5029162d32770ee245": """src/core/run/README.md
src/core/run/process-census.ts
src/core/run/process.ts
tests/int/runz1-perf.mjs
tests/unit/run-control-kill-evidence.test.ts
tests/unit/run-control-kill-fixture.ts
tests/unit/run-control.test.ts
tests/unit/runz1-fixture.py
tests/unit/runz1-process.test.ts""".split(),
}


def git(*a):
    return subprocess.run(["git", "-C", REPO, *a], check=True, capture_output=True).stdout


def inv(commit):
    """full recursive leaf inventory {path: (mode,type,sha)}"""
    d = {}
    for line in git("ls-tree", "-r", "-z", "--full-tree", commit).split(b"\0"):
        if not line:
            continue
        meta, path = line.split(b"\t", 1)
        mode, typ, sha = meta.decode().split()
        d[path.decode()] = (mode, typ, sha)
    return d


def tree_of(c):
    return git("rev-parse", c + "^{tree}").decode().strip()


iu, it, ih, ir, ic3, itp = (inv(x) for x in (U, T, H, R, C3, T_PREV))
res = {"commits": {n: {"commit": c, "tree": tree_of(c)} for n, c in
                   dict(U=U, T=T, H=H, R_expected=R, C3=C3, T_prev_reviewed=T_PREV).items()},
       "types": {c: git("cat-file", "-t", c).decode().strip() for c in (T, H, C3, U)}}
res["merge_base_all"] = git("merge-base", "--all", T, H).decode().split()
res["c3_is_ancestor_of_H"] = subprocess.run(["git", "-C", REPO, "merge-base", "--is-ancestor", C3, H]).returncode == 0
res["leaf_counts"] = dict(U=len(iu), T=len(it), H=len(ih), C3=len(ic3), R_actual=len(ir))

ABSENT = None
paths = set(iu) | set(it) | set(ih)
pred, conflicts = {}, []
for p in sorted(paths):
    b, a, s = iu.get(p, ABSENT), it.get(p, ABSENT), ih.get(p, ABSENT)
    if a == s:
        v = a
    elif a == b:
        v = s
    elif s == b:
        v = a
    else:
        conflicts.append(p)
        continue
    if v is not ABSENT:
        pred[p] = v
res["three_way_conflicts"] = conflicts
res["predicted_leaf_count"] = len(pred)

# prefix / file-vs-dir collisions in predicted set
dirs = set()
for p in pred:
    parts = p.split("/")
    for i in range(1, len(parts)):
        dirs.add("/".join(parts[:i]))
res["file_dir_prefix_collisions"] = sorted(p for p in pred if p in dirs)

# mode/type changes & deletions across U->T->R and C3->H
def delta(a, b):
    ch = []
    for p in sorted(set(a) | set(b)):
        if a.get(p) != b.get(p):
            ch.append(p)
    return ch

def kinds(a, b, paths):
    out = {"added": 0, "modified": 0, "deleted": 0, "mode_or_type_change": 0}
    for p in paths:
        x, y = a.get(p), b.get(p)
        if x is None: out["added"] += 1
        elif y is None: out["deleted"] += 1
        elif x[:2] != y[:2]: out["mode_or_type_change"] += 1
        else: out["modified"] += 1
    return out

res["pred_equals_actual_R_complete_entries"] = (pred == ir)
res["pred_vs_actual_diff_paths"] = delta(pred, ir)
res["non_regular_entries_in_R"] = {p: v for p, v in ir.items() if v[0] not in ("100644", "100755") or v[1] != "blob"}
res["modes_in_R"] = sorted({v[0] for v in ir.values()})

t2r = delta(it, ir)
srcpaths = [p for l in SRC.values() for p in l]
res["T_to_R"] = {"changed_count": len(t2r), "kinds": kinds(it, ir, t2r),
                 "source_paths_changed": sorted(set(t2r) & set(srcpaths)),
                 "non_source_changed_count": len(set(t2r) - set(srcpaths)),
                 "non_source_changed_paths": sorted(set(t2r) - set(srcpaths))}
non_doc = [p for p in set(t2r) - set(srcpaths) if not (p.startswith("docs/"))]
res["T_to_R"]["non_source_non_docs_paths"] = sorted(non_doc)

h2c = delta(ic3, ih)
res["C3_to_H"] = {"changed_count": len(h2c), "paths": h2c, "kinds": kinds(ic3, ih, h2c)}
res["C3_to_H"]["all_under_handoff_wave1_dir"] = all(p.startswith("docs/cloud/handoff/wave1-compat-integration/") for p in h2c)
res["C3_to_H"]["non_docs_changed"] = [p for p in h2c if not p.startswith("docs/")]

t2tp = delta(itp, it)
res["Tprev_to_T"] = {"changed_count": len(t2tp), "paths": t2tp, "kinds": kinds(itp, it, t2tp)}

t2u = delta(iu, it)
res["U_to_T"] = {"changed_count": len(t2u), "non_docs_paths": sorted(p for p in t2u if not p.startswith("docs/")),
                 "kinds": kinds(iu, it, t2u)}

# 26-source-path ownership: actual R entry must equal source commit's entry; U must differ or equal?
own = []
for c, lst in SRC.items():
    isrc = inv(c)
    for p in lst:
        e_src, e_r, e_u = isrc.get(p), ir.get(p), iu.get(p)
        own.append({"path": p, "source_commit": c, "source_entry": e_src, "R_entry": e_r,
                    "U_entry": e_u, "T_entry": it.get(p), "H_entry": ih.get(p),
                    "R_equals_source": e_src == e_r})
res["source_ownership"] = own
res["source_ownership_all_match"] = all(o["R_equals_source"] for o in own) and len(own) == 26 and len({o["path"] for o in own}) == 26

# every non-source, non-docs path must equal U (implementation/config/dependency untouched)
non_doc_all = [p for p in set(ir) | set(iu) if not p.startswith("docs/") and p not in set(srcpaths)]
res["non_source_non_docs_equal_U"] = all(ir.get(p) == iu.get(p) for p in non_doc_all)
res["non_source_non_docs_diffs_vs_U"] = [p for p in non_doc_all if ir.get(p) != iu.get(p)]

# tree SHA recomputed by independent object construction (mktree) from predicted inventory
import tempfile, os
def build_tree(entries):
    # entries: {path: (mode,type,sha)} -> recursive mktree using git mktree
    root = {}
    for p, v in entries.items():
        parts = p.split("/")
        d = root
        for x in parts[:-1]:
            d = d.setdefault(x, {})
        d[parts[-1]] = v
    def rec(d):
        lines = []
        for name, v in d.items():
            if isinstance(v, dict):
                lines.append(f"040000 tree {rec(v)}\t{name}")
            else:
                lines.append(f"{v[0]} {v[1]} {v[2]}\t{name}")
        r = subprocess.run(["git", "-C", REPO, "mktree"], input=("\n".join(lines) + "\n").encode(), capture_output=True, check=True)
        return r.stdout.decode().strip()
    return rec(root)

# mktree writes tree objects (content-addressed, same objects as in R) - allowed: no ref/worktree effect
res["recomputed_tree_sha_from_prediction"] = build_tree(pred)
res["recomputed_equals_R"] = res["recomputed_tree_sha_from_prediction"] == R

with open(OUT + "/tree-verification.json", "w") as f:
    json.dump(res, f, indent=1, sort_keys=True)
with open(OUT + "/R-inventory.tsv", "w") as f:
    for p in sorted(ir):
        f.write("%s\t%s\t%s\t%s\n" % (*ir[p], p))
with open(OUT + "/T-to-R-changed-paths.tsv", "w") as f:
    for p in t2r:
        a, b = it.get(p), ir.get(p)
        f.write("%s\t%s\t%s\n" % (p, a, b))

# summary
print(json.dumps({k: res[k] for k in (
    "merge_base_all", "c3_is_ancestor_of_H", "leaf_counts", "three_way_conflicts", "predicted_leaf_count",
    "file_dir_prefix_collisions", "pred_equals_actual_R_complete_entries", "recomputed_equals_R",
    "source_ownership_all_match", "non_source_non_docs_equal_U", "non_source_non_docs_diffs_vs_U",
    "modes_in_R", "non_regular_entries_in_R")}, indent=1))
print("T_to_R", json.dumps({k: v for k, v in res["T_to_R"].items() if k not in ("non_source_changed_paths", "source_paths_changed")}))
print("T_to_R source changed:", len(res["T_to_R"]["source_paths_changed"]))
print("C3_to_H", res["C3_to_H"]["changed_count"], res["C3_to_H"]["kinds"], res["C3_to_H"]["all_under_handoff_wave1_dir"], res["C3_to_H"]["non_docs_changed"])
print("Tprev_to_T", res["Tprev_to_T"])
print("U_to_T", res["U_to_T"])

"""Data-only source identity check. Usage: source_identity.py WORKTREE CANDIDATE_LEAVES_JSON DEP_LEAVES_JSON OUT_DIR"""
import json, os, subprocess, sys, stat, hashlib
wt, cand_p, dep_p, out = sys.argv[1:5]
def git(*a, check=True):
    return subprocess.run(["git","-C",wt,*a],capture_output=True,check=check).stdout
raw = git("ls-tree","-r","-z","--full-tree","HEAD").split(b"\0")
leaves=[]
for e in raw:
    if not e: continue
    meta,path=e.split(b"\t",1); mode,typ,sha=meta.decode().split(" ")
    leaves.append({"path":path.decode("utf-8","surrogateescape"),"mode":mode,"type":typ,"sha":sha})
cand=json.load(open(cand_p)); dep=json.load(open(dep_p))
key=lambda l:(l["path"],l["mode"],l["type"],l["sha"])
inv_eq = sorted(map(key,leaves))==sorted(map(key,cand))
dep_set={key(l) for l in dep}
dep_in = dep_set <= {key(l) for l in leaves}
nm=[l for l in leaves if l["path"].startswith("node_modules/")]
# tracked bytes
mism=[]; checked=0
for l in leaves:
    p=os.path.join(wt,l["path"])
    try: st=os.lstat(p)
    except FileNotFoundError: mism.append((l["path"],"missing")); continue
    if l["mode"]=="120000":
        got=subprocess.run(["git","-C",wt,"hash-object","--stdin","--no-filters"],input=os.readlink(p).encode("utf-8","surrogateescape"),capture_output=True).stdout.decode().strip()
        okmode=stat.S_ISLNK(st.st_mode)
    elif l["type"]=="blob":
        got=subprocess.run(["git","-C",wt,"hash-object","--no-filters","--",l["path"]],capture_output=True).stdout.decode().strip()
        okmode = stat.S_ISREG(st.st_mode) and (bool(st.st_mode&0o100)==(l["mode"]=="100755"))
    else:
        mism.append((l["path"],"nonblob:"+l["type"])); continue
    checked+=1
    if got!=l["sha"]: mism.append((l["path"],"blob_mismatch"))
    if not okmode: mism.append((l["path"],"mode_mismatch"))
status=git("status","--porcelain=v1","--ignored","-z").decode("utf-8","surrogateescape").split("\0")
status=[s for s in status if s]
ident={
 "commit":git("rev-parse","HEAD").decode().strip(),
 "tree":git("rev-parse","HEAD^{tree}").decode().strip(),
 "parents":git("rev-list","--parents","-n","1","HEAD").decode().split()[1:],
 "leaf_count":len(leaves),"node_modules_leaf_count":len(nm),
 "types":{t:sum(1 for l in leaves if l["type"]==t) for t in {l["type"] for l in leaves}},
 "modes":{m:sum(1 for l in leaves if l["mode"]==m) for m in {l["mode"] for l in leaves}},
 "equals_supplied_candidate_leaves":inv_eq,
 "supplied_dependency_leaves_count":len(dep),"supplied_dependency_leaves_subset_of_candidate":dep_in,
 "tracked_bytes_checked":checked,"tracked_byte_mismatches":mism,
 "worktree_status_entries":status,
 "output_roots":{r:("absent" if not os.path.lexists(os.path.join(wt,r)) else "PRESENT") for r in ["dist","dist-test","packages/hud-mcp/dist"]},
 "head_detached":subprocess.run(["git","-C",wt,"symbolic-ref","-q","HEAD"],capture_output=True).returncode!=0,
}
os.makedirs(out,exist_ok=True)
json.dump(ident,open(os.path.join(out,"source-identity.json"),"w"),indent=2,sort_keys=True)
json.dump(leaves,open(os.path.join(out,"leaf-inventory.json"),"w"),indent=1)
print(json.dumps({k:v for k,v in ident.items() if k not in("tracked_byte_mismatches",)},indent=1)); print("mismatches",len(mism),mism[:5])

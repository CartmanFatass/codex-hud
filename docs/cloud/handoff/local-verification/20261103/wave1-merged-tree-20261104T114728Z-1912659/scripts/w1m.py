#!/usr/bin/env python3
"""Merged-tree (M / R) verification runner. Minimal, written for this round only.

Never reuses the earlier matrix.sh/lib.sh. Every command is a direct child of this
process, started in its own session; stdout and stderr go through separate pipes
into separate raw files; the child's own wait status is observed natively by
waitpid (Popen.returncode, negative = killed by that signal).

Layers recorded separately per command (result.json):
  command.raw_exit / command.native_signal   : the tested command's own wait status
  supervisor.*                               : this runner's timeout actions (signals actually sent)
  streams.*                                  : EOF/close of each pipe, bytes, sha256
  logging.ok                                 : did the raw files get written completely
  closeout.*                                 : owned-process census, survivors, D/Z states
  gate                                       : PASS / FAIL / BLOCKED / UNKNOWN (derived, never from a log step)

Usage:
  w1m.py row   PROFILE ROWID                (a row of the fixed table)
  w1m.py adhoc PROFILE ROWID TIMEOUT -- CMD...   (npm ci, supplemental, isolated rerun)
  w1m.py notrun PROFILE ROWID REASON
  w1m.py checkpoint PROFILE LABEL
"""
import os, sys, json, time, signal, subprocess, threading, hashlib, re, datetime, ctypes

RUNID = open("<VERIFY_ROOT>/wave1-merged-tree-LATEST.txt").read().strip()
V = "<VERIFY_ROOT>"
RUN = f"{V}/{RUNID}"
SHORT = "/tmp/w1m-" + RUNID.rsplit("-", 1)[1]  # short root for unix-socket path length
PLAN = json.load(open(f"{RUN}/profile-plan.json"))
M = PLAN["identity"]["M"]
R = PLAN["identity"]["R"]
T = PLAN["identity"]["T"]
H = PLAN["identity"]["H"]
PROXY_NAMES = PLAN["environment"]["proxy_names_passed_unchanged"]
GENERATED = ["dist", "dist-test", "packages/hud-mcp/dist"]
NPM_HDR = re.compile(r"^> (\S+)@(\S+) (\S+)$")
COUNT_RE = re.compile(r"^(?:#|ℹ)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$")
GRACE = PLAN["supervisor"]["term_to_kill_grace_s"]


def utc():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git(wt, *a, check=False):
    r = subprocess.run(["git", "-C", wt, *a], capture_output=True)
    if check and r.returncode:
        raise RuntimeError(r.stderr.decode())
    return r.stdout.decode(errors="replace").strip(), r.returncode


# ---------------------------------------------------------------- /proc helpers
def pstat(pid):
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            s = f.read().decode(errors="replace")
    except OSError:
        return None
    i, j = s.find("("), s.rfind(")")
    comm = s[i + 1:j]
    rest = s[j + 2:].split()
    return dict(pid=pid, comm=comm, state=rest[0], ppid=int(rest[1]), pgrp=int(rest[2]), sid=int(rest[3]), start=int(rest[19]))


def snapshot():
    out = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            st = pstat(int(d))
            if st:
                out[int(d)] = st
    return out


def descendants(root, snap):
    kids = {}
    for p, st in snap.items():
        kids.setdefault(st["ppid"], []).append(p)
    seen, todo = set(), [root]
    while todo:
        x = todo.pop()
        for c in kids.get(x, []):
            if c not in seen:
                seen.add(c)
                todo.append(c)
    return seen


def cmdline(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().replace(b"\0", b" ").decode(errors="replace").strip()
    except OSError:
        return None


def env_has(pid, token):
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            return token in f.read()
    except OSError:
        return None


def ident(st):
    return f'{st["pid"]}:{st["start"]}'


class Census:
    """Records every process that is (a) a descendant of the root, (b) in the root's session or
    process group, or (c) carries this command's unique HOME in its environment. Identity = pid + start ticks."""

    def __init__(self, root_pid, sid, pgid, token):
        self.root, self.sid, self.pgid, self.token = root_pid, sid, pgid, token
        self.seen = {}
        self.stop = threading.Event()
        self.me = os.getpid()
        self.t = threading.Thread(target=self.loop, daemon=True)
        self.n = 0
        self.lock = threading.Lock()

    def scan(self, env_scan):
        with self.lock:
            return self._scan(env_scan)

    def _scan(self, env_scan):
        snap = snapshot()
        desc = descendants(self.root, snap)
        for pid, st in snap.items():
            if pid == self.me:
                continue
            how = []
            if pid == self.root or pid in desc:
                how.append("descendant")
            if st["sid"] == self.sid:
                how.append("session")
            if st["pgrp"] == self.pgid:
                how.append("pgrp")
            if env_scan and pid != 1 and not how and env_has(pid, self.token):
                how.append("environ-token")
            if not how:
                continue
            k = ident(st)
            e = self.seen.get(k)
            if e is None:
                self.seen[k] = dict(pid=pid, start=st["start"], comm=st["comm"], how=sorted(how), ppid_first=st["ppid"],
                                    pgrp=st["pgrp"], sid=st["sid"], first_seen=utc(), last_seen=utc(), last_state=st["state"],
                                    cmdline=cmdline(pid), alive=True)
            else:
                e["last_seen"] = utc()
                e["last_state"] = st["state"]
                e["alive"] = True
                for h in how:
                    if h not in e["how"]:
                        e["how"].append(h)
        for k, e in self.seen.items():
            if e["alive"] and e["pid"] not in snap:
                e["alive"] = False
            elif e["alive"] and snap[e["pid"]]["start"] != e["start"]:
                e["alive"] = False  # pid reused: original identity gone
        self.n += 1

    def loop(self):
        i = 0
        while not self.stop.is_set():
            try:
                self.scan(env_scan=(i % 5 == 0))
            except Exception as ex:  # census failure must be visible, never silent
                self.seen.setdefault("CENSUS-ERROR", dict(error=repr(ex)))
            i += 1
            self.stop.wait(1.0)


# ---------------------------------------------------------------- stream capture
class Pipe:
    def __init__(self, fd, path):
        self.fd, self.path = fd, path
        self.bytes = 0
        self.h = hashlib.sha256()
        self.eof_at = None
        self.error = None
        self.t = threading.Thread(target=self.run, daemon=True)

    def run(self):
        try:
            with open(self.path, "wb") as f:
                while True:
                    b = os.read(self.fd, 1 << 16)
                    if not b:
                        break
                    f.write(b)
                    self.bytes += len(b)
                    self.h.update(b)
                f.flush()
                os.fsync(f.fileno())
            self.eof_at = utc()
        except Exception as ex:
            self.error = repr(ex)
        finally:
            try:
                os.close(self.fd)
            except OSError:
                pass


# ---------------------------------------------------------------- source / generated / deps
def source_check(wt, label):
    head, _ = git(wt, "rev-parse", "HEAD")
    tree, _ = git(wt, "rev-parse", "HEAD^{tree}")
    parents, _ = git(wt, "show", "-s", "--format=%P", "HEAD")
    por = subprocess.run(["git", "-C", wt, "status", "--porcelain=v1", "-uall", "--ignored=no"], capture_output=True).stdout.decode(errors="replace")
    lines = por.splitlines()
    skip = ("node_modules/", "dist/", "dist-test/", "packages/hud-mcp/dist/")
    nondep = [l for l in lines if not l[3:].startswith(skip)]
    ls = subprocess.run(["git", "-C", wt, "ls-files", "-z", "--", ".", ":(exclude)node_modules"], capture_output=True).stdout.split(b"\0")
    h = hashlib.sha256()
    n = 0
    for p in sorted(x for x in ls if x):
        try:
            fp = os.path.join(wt, p.decode())
            if os.path.islink(fp):
                h.update(b"L" + p + b"\0" + os.readlink(fp).encode())
            else:
                h.update(b"F" + p + b"\0" + sha256_file(fp).encode())
        except OSError as ex:
            h.update(b"E" + p + repr(ex).encode())
        n += 1
    return dict(label=label, utc=utc(), head=head, tree=tree, parents=parents, head_is_M=(head == M), tree_is_R=(tree == R),
                parents_are_T_H=(parents == f"{T} {H}"), tracked_nondep_files=n, tracked_nondep_sha256=h.hexdigest(),
                porcelain_total_lines=len(lines), porcelain_non_dependency_non_generated=nondep,
                porcelain_dependency_lines=len([l for l in lines if l[3:].startswith("node_modules/")]))


def tree_manifest(wt, rels):
    out = []
    for rel in rels:
        base = os.path.join(wt, rel)
        if not os.path.isdir(base):
            continue
        for dp, dn, fn in os.walk(base, followlinks=False):
            dn.sort()
            for f in sorted(fn):
                p = os.path.join(dp, f)
                r = os.path.relpath(p, wt)
                if os.path.islink(p):
                    out.append((r, "L:" + os.readlink(p)))
                else:
                    try:
                        out.append((r, sha256_file(p)))
                    except OSError as ex:
                        out.append((r, "ERR:" + repr(ex)))
    return out


def write_manifest(wt, rels, path):
    m = tree_manifest(wt, rels)
    with open(path, "w") as f:
        for r, h in m:
            f.write(f"{h}  {r}\n")
    agg = hashlib.sha256(open(path, "rb").read()).hexdigest()
    per = {}
    for rel in rels:
        sub = [x for x in m if x[0].startswith(rel + "/")]
        per[rel] = dict(files=len(sub), aggregate=hashlib.sha256("".join(f"{h}  {r}\n" for r, h in sub).encode()).hexdigest())
    return dict(path=path, files=len(m), manifest_sha256=agg, per_dir=per)


# ---------------------------------------------------------------- environment
def prof_cfg(prof):
    return PLAN["profiles"][prof]


def build_env(prof, home, hud, tmp, extra):
    cfg = prof_cfg(prof)
    e = dict(PATH=f'{cfg["node_bin_dir"]}:/usr/bin:/bin', HOME=home, HUD_HOME=hud, TMPDIR=tmp, LANG="C.UTF-8", TERM="xterm-256color",
             npm_config_update_notifier="false", npm_config_fund="false", npm_config_audit="false")
    for n in PROXY_NAMES:
        if n in os.environ:
            e[n] = os.environ[n]  # owner's actual policy, passed unchanged, never logged
    if cfg["node_use_env_proxy"]:
        e["NODE_USE_ENV_PROXY"] = "1"
    e.update(extra)
    return e


def proxy_presence():
    pres = {n: (n in os.environ) for n in PROXY_NAMES}
    rel = {}
    for up in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        lo = up.lower()
        rel[up] = dict(upper_present=up in os.environ, lower_present=lo in os.environ,
                       equal=(os.environ.get(up) == os.environ.get(lo)) if (up in os.environ and lo in os.environ) else None)
    return pres, rel


# ---------------------------------------------------------------- counts
def parse_counts(text):
    segs, cur = [], dict(stage="(preamble)", counts=[], hdr=None)
    for line in text.splitlines():
        m = NPM_HDR.match(line)
        if m:
            segs.append(cur)
            cur = dict(stage=m.group(3), counts=[], hdr=line)
            continue
        c = COUNT_RE.match(line)
        if c:
            cur["counts"].append((c.group(1), int(c.group(2))))
    segs.append(cur)
    stages, tot = [], dict(tests=0, pass_=0, fail=0, cancelled=0, skipped=0, todo=0, suites=0)
    for s in segs:
        if not s["counts"] and s["hdr"] is None:
            continue
        agg = {}
        for k, v in s["counts"]:
            agg[k] = agg.get(k, 0) + v
        stages.append(dict(stage=s["stage"], header=s["hdr"], summary_blocks=sum(1 for k, _ in s["counts"] if k == "tests"), counts=agg))
        for k, v in agg.items():
            tot["pass_" if k == "pass" else k] += v
    return dict(stages=stages, totals={("pass" if k == "pass_" else k): v for k, v in tot.items()},
                stages_seen=[s["stage"] for s in stages], any_summary=any(s["summary_blocks"] for s in stages))


# ---------------------------------------------------------------- the runner
def execute(prof, rowid, argv, timeout, planned_row=None, note=None):
    cfg = prof_cfg(prof)
    wt = cfg["worktree"]
    pk = cfg["short"]
    rid = re.sub(r"[^A-Za-z0-9]", "", rowid)[:8]
    base = f"{SHORT}/{pk}{rid}"
    home, hud, tmp = f"{base}/h", f"{base}/u", f"{base}/t"
    for d in (home, hud, tmp):
        os.makedirs(d, exist_ok=False)  # fresh and empty; refuses to reuse
    logd = f"{RUN}/logs/{prof}/{rowid}"
    capd = f"{RUN}/captures/{prof}/{rowid}"
    os.makedirs(logd, exist_ok=False)
    npe, kev = f"{capd}/node-proxy-evidence", f"{capd}/runz1-kill-evidence"
    os.makedirs(npe, exist_ok=False)
    os.makedirs(kev, exist_ok=False)
    extra = dict(NODE_PROXY_EVIDENCE_DIR=npe, RUNZ1_KILL_EVIDENCE_DIR=kev)
    if argv[:2] == ["npm", "ci"]:
        extra["npm_config_cache"] = f"{V}/npm-cache"
    env = build_env(prof, home, hud, tmp, extra)
    pres, rel = proxy_presence()
    pre_src = source_check(wt, "before")
    pre_gen = {g: os.path.isdir(os.path.join(wt, g)) for g in GENERATED}
    meta = dict(row=rowid, planned_row=planned_row, profile=prof, note=note, M=M, R=R, argv=argv, cwd_code=f"<wt:{prof}>",
                cwd_real_local_only=wt, timeout_s=timeout, term_to_kill_grace_s=GRACE,
                env_names=sorted(env), env_values_nonsecret={k: v for k, v in env.items() if k not in PROXY_NAMES},
                proxy_names_present=pres, proxy_case_relations=rel, node_use_env_proxy_in_env=("NODE_USE_ENV_PROXY" in env),
                node_options_present=("NODE_OPTIONS" in env), node_no_warnings_present=("NODE_NO_WARNINGS" in env),
                node_redirect_warnings_present=("NODE_REDIRECT_WARNINGS" in env), no_color_present=("NO_COLOR" in env),
                force_color_present=("FORCE_COLOR" in env), runtime=cfg["runtime_identity"], pre_source=pre_src,
                generated_present_before=pre_gen, loadavg_before=open("/proc/loadavg").read().split()[:4])
    with open(f"{logd}/meta.json", "w") as f:
        json.dump(meta, f, indent=1)
    t_start = utc()
    mono0 = time.monotonic()
    ro, wo = os.pipe()
    re_, we = os.pipe()
    p = subprocess.Popen(argv, cwd=wt, env=env, stdin=subprocess.DEVNULL, stdout=wo, stderr=we, start_new_session=True, close_fds=True)
    os.close(wo)
    os.close(we)
    pgid = p.pid
    so, se = Pipe(ro, f"{logd}/stdout.raw"), Pipe(re_, f"{logd}/stderr.raw")
    so.t.start()
    se.t.start()
    token = f"HOME={home}".encode()
    cen = Census(p.pid, p.pid, pgid, token)
    cen.scan(True)
    cen.t.start()
    root_id = None
    st0 = pstat(p.pid)
    if st0:
        root_id = ident(st0)
    sup = dict(sent=[], timeout_triggered=False, timeout_deadline_s=timeout)
    deadline = mono0 + timeout
    rc = None
    while rc is None:
        try:
            rc = p.wait(timeout=max(0.05, min(1.0, deadline - time.monotonic())))
        except subprocess.TimeoutExpired:
            if time.monotonic() >= deadline and not sup["timeout_triggered"]:
                sup["timeout_triggered"] = True
                sup["sent"].append(dict(signal="SIGTERM", target=f"process group {pgid} (own session leader, pid {p.pid}, start-ticks {root_id})", at=utc()))
                try:
                    os.killpg(pgid, signal.SIGTERM)
                except ProcessLookupError:
                    sup["sent"][-1]["error"] = "ESRCH"
                kill_at = time.monotonic() + GRACE
                while rc is None:
                    try:
                        rc = p.wait(timeout=0.5)
                    except subprocess.TimeoutExpired:
                        if time.monotonic() >= kill_at:
                            sup["sent"].append(dict(signal="SIGKILL", target=f"process group {pgid}", at=utc()))
                            try:
                                os.killpg(pgid, signal.SIGKILL)
                            except ProcessLookupError:
                                sup["sent"][-1]["error"] = "ESRCH"
                            rc = p.wait()
    t_exit = utc()
    mono_exit = time.monotonic()
    # stdout/stderr must reach EOF (every writer closed)
    pipe_wait_s = 20
    t_end = time.monotonic() + pipe_wait_s
    for pp in (so, se):
        pp.t.join(max(0.0, t_end - time.monotonic()))
    streams_closed = so.eof_at is not None and se.eof_at is not None
    # owned processes: allow a bounded natural wind-down, never an extra kill
    time.sleep(1.5)
    cen.scan(True)
    deadline2 = time.monotonic() + 10
    def survivors():
        snap = snapshot()
        out = []
        for k, e in cen.seen.items():
            if k == "CENSUS-ERROR":
                continue
            st = snap.get(e["pid"])
            if st and st["start"] == e["start"] and st["pid"] != p.pid:
                out.append(dict(id=k, comm=e["comm"], state=st["state"], how=e["how"]))
        # also anything newly visible by session / pgrp / environ-token
        for pid, st in snap.items():
            if pid == os.getpid():
                continue
            if st["sid"] == cen.sid or st["pgrp"] == cen.pgid or (pid != 1 and env_has(pid, token)):
                k = ident(st)
                if k not in [s["id"] for s in out]:
                    out.append(dict(id=k, comm=st["comm"], state=st["state"], how=["late-scan"]))
        return out
    left = survivors()
    while left and time.monotonic() < deadline2:
        time.sleep(0.5)
        cen.scan(True)
        left = survivors()
    cen.stop.set()
    cen.t.join(3)
    cen.scan(True)
    left = survivors()
    left_nonzombie = [x for x in left if x["state"] != "Z"]
    zombies = [x for x in left if x["state"] == "Z"]
    dstate = [x for x in left if x["state"] == "D"]
    t_closeout = utc()
    # post-run checks
    post_src = source_check(wt, "after")
    gen_after = {g: os.path.isdir(os.path.join(wt, g)) for g in GENERATED}
    logging_ok = (so.error is None and se.error is None and
                  os.path.getsize(so.path) == so.bytes and os.path.getsize(se.path) == se.bytes)
    stdout_text = open(so.path, "rb").read().decode(errors="replace")
    counts = parse_counts(stdout_text)
    census_out = dict(root=root_id, n_scans=cen.n, identities=cen.seen)
    with open(f"{logd}/owned-processes.json", "w") as f:
        json.dump(census_out, f, indent=1)
    src_ok = (post_src["head_is_M"] and post_src["tree_is_R"] and post_src["parents_are_T_H"] and
              post_src["tracked_nondep_sha256"] == pre_src["tracked_nondep_sha256"] and
              not post_src["porcelain_non_dependency_non_generated"])
    native_signal = None
    if rc is not None and rc < 0:
        try:
            native_signal = signal.Signals(-rc).name
        except ValueError:
            native_signal = f"signal {-rc}"
    owned_state = "none-left (all recorded identities gone)" if not left_nonzombie and not zombies else (
        "LEFT" if left_nonzombie else "zombies-only")
    anomalies = []
    if not streams_closed:
        anomalies.append("stdout/stderr pipe not closed within %ds after command exit" % pipe_wait_s)
    if left_nonzombie:
        anomalies.append("owned processes still alive after command exit: %s" % json.dumps(left_nonzombie))
    if zombies:
        anomalies.append("owned zombie entries remain: %s" % json.dumps(zombies))
    if dstate:
        anomalies.append("D-state owned process")
    if not logging_ok:
        anomalies.append("raw log write error")
    if not src_ok:
        anomalies.append("source/identity drift after command")
    if "CENSUS-ERROR" in cen.seen:
        anomalies.append("census error: " + cen.seen["CENSUS-ERROR"]["error"])
    if sup["timeout_triggered"]:
        anomalies.append("command timed out (supervisor signals sent)")
    gate = "PASS" if (rc == 0 and not anomalies) else ("UNKNOWN" if (anomalies and rc == 0) else "FAIL")
    res = dict(row=rowid, planned_row=planned_row, profile=prof, argv=argv,
               times=dict(start=t_start, command_exit_observed=t_exit, closeout_done=t_closeout,
                          duration_to_exit_s=round(mono_exit - mono0, 3)),
               command=dict(raw_exit=rc, native_signal=native_signal,
                            native_signal_basis=("waitpid status of the direct child (Popen.returncode)" if native_signal else "exited normally per waitpid; no signal"),
                            wrapper_layer="none: the command is the runner's direct child; no shell/timeout wrapper in between",
                            root_pid_identity=root_id),
               supervisor=dict(**sup, runner_exit_note="runner pid %d; this record is the runner's own status, separate from the command's" % os.getpid()),
               streams=dict(stdout=dict(bytes=so.bytes, sha256=so.h.hexdigest(), eof_at=so.eof_at, error=so.error),
                            stderr=dict(bytes=se.bytes, sha256=se.h.hexdigest(), eof_at=se.eof_at, error=se.error),
                            both_closed=streams_closed, separate_unmerged=True),
               logging=dict(ok=logging_ok),
               counts=counts,
               closeout=dict(owned_state=owned_state, recorded_identities=len([k for k in cen.seen if k != "CENSUS-ERROR"]),
                             left_alive=left_nonzombie, zombies=zombies, d_state=dstate,
                             census_method="1Hz /proc scan: descendants of root, root session/pgrp, and HOME-token in /proc/*/environ every 5s; identity=pid+start ticks. Processes that left the tree, changed session and cleared environ within <1s are not observable: not claimed.",
                             tmp_dirs=dict(home=home, hud_home=hud, tmpdir=tmp), capture_dirs=dict(node_proxy=npe, runz1_kill=kev)),
               source=dict(before=pre_src, after=post_src, unchanged=src_ok, generated_present_after=gen_after),
               anomalies=anomalies, gate=gate, note=note)
    with open(f"{logd}/result.json", "w") as f:
        json.dump(res, f, indent=1)
    print(f"[{prof} {rowid}] exit={rc} signal={native_signal} timeout={sup['timeout_triggered']} closed={streams_closed} "
          f"owned={owned_state} src_ok={src_ok} gate={gate} dur={res['times']['duration_to_exit_s']}s "
          f"tests={counts['totals']['tests']} pass={counts['totals']['pass']} fail={counts['totals']['fail']} "
          f"cancelled={counts['totals']['cancelled']} skipped={counts['totals']['skipped']}")
    for a in anomalies:
        print("  ANOMALY:", a)
    return res


def main():
    mode = sys.argv[1]
    prof, rowid = sys.argv[2], sys.argv[3]
    if mode == "row":
        row = next(r for r in PLAN["rows"] if r["id"] == rowid)
        res = execute(prof, rowid, row["argv"], row["timeout_s"], planned_row=rowid)
    elif mode == "adhoc":
        to = int(sys.argv[4])
        assert sys.argv[5] == "--"
        res = execute(prof, rowid, sys.argv[6:], to, note="adhoc/supplemental (not one of the ten table rows unless stated)")
    elif mode == "notrun":
        d = f"{RUN}/logs/{prof}/{rowid}"
        os.makedirs(d, exist_ok=False)
        json.dump(dict(row=rowid, profile=prof, gate="NOT RUN / BLOCKED", reason=sys.argv[4], at=utc()), open(f"{d}/result.json", "w"), indent=1)
        print("recorded NOT RUN", prof, rowid)
        return 0
    elif mode == "checkpoint":
        cfg = prof_cfg(prof)
        wt = cfg["worktree"]
        out = dict(source=source_check(wt, rowid))
        os.makedirs(f"{RUN}/manifest/checkpoints", exist_ok=True)
        if "--deps" in sys.argv:
            out["dependencies"] = write_manifest(wt, ["node_modules"], f"{RUN}/manifest/deps-{prof}-{rowid}.sha256")
        if "--generated" in sys.argv:
            out["generated"] = write_manifest(wt, GENERATED, f"{RUN}/manifest/generated-{prof}-{rowid}.sha256")
        json.dump(out, open(f"{RUN}/manifest/checkpoints/{prof}-{rowid}.json", "w"), indent=1)
        print(json.dumps({k: (v if k != "source" else {kk: v[kk] for kk in ("head_is_M", "tree_is_R", "parents_are_T_H", "tracked_nondep_sha256", "porcelain_non_dependency_non_generated")}) for k, v in out.items()}, indent=1))
        return 0
    return 0 if res["gate"] == "PASS" else 3


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""cpumon.py <owner-pid> <out.tsv> <stop-file>: 1 s per-process CPU deltas (utime+stime from /proc/<pid>/stat, never
arguments or environment). Splits CPU into owned (the owner pid and its descendants) and non-owned. Per sample row:
utc, host busy cores (from /proc/stat), owned cores, non-owned cores, then non-owned comm:cores above 0.05 core."""
import os, sys, time
owner, out, stop = int(sys.argv[1]), sys.argv[2], sys.argv[3]
HZ = os.sysconf('SC_CLK_TCK')
def procs():
    d = {}
    for p in os.listdir('/proc'):
        if not p.isdigit(): continue
        try:
            st = open(f'/proc/{p}/stat').read(); r = st.rsplit(')', 1)[1].split()
            d[int(p)] = (st[st.index('(') + 1:st.rindex(')')], int(r[1]), int(r[11]) + int(r[12]))
        except OSError: pass
    return d
def host():
    f = open('/proc/stat').readline().split()[1:]; v = list(map(int, f)); return sum(v) - v[3] - v[4]
def owned(d):
    kids = {}
    for pid, (_, pp, _) in d.items(): kids.setdefault(pp, []).append(pid)
    s, st = set(), [owner]
    while st:
        x = st.pop()
        if x in s: continue
        s.add(x); st += kids.get(x, [])
    return s
prev, ph, pt = procs(), host(), time.time()
with open(out, 'w') as o:
    o.write('utc\thost_busy_cores\towned_cores\tnonowned_cores\tnonowned_top\n')
    while not os.path.exists(stop):
        time.sleep(1)
        cur, ch, ct = procs(), host(), time.time(); dt = ct - pt
        own = owned(cur) | owned(prev)
        o_c = n_c = 0.0; tops = {}
        for pid, (comm, _, t) in cur.items():
            if pid in prev and prev[pid][0] == comm: dlt = (t - prev[pid][2]) / HZ / dt
            else: dlt = t / HZ / dt if pid not in prev else 0.0
            if dlt <= 0: continue
            if pid in own: o_c += dlt
            else:
                n_c += dlt; tops[comm] = tops.get(comm, 0) + dlt
        top = ' '.join('%s:%.2f' % kv for kv in sorted(tops.items(), key=lambda kv: -kv[1]) if kv[1] >= 0.05)
        o.write('%s\t%.2f\t%.2f\t%.2f\t%s\n' % (time.strftime('%H:%M:%S', time.gmtime(ct)), (ch - ph) / HZ / dt, o_c, n_c, top)); o.flush()
        prev, ph, pt = cur, ch, ct

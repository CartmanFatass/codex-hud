# ancprobe.py: bounded ancestry metadata (pid, ppid, starttime ticks, uid, comm) and an open/close-only access probe of
# /proc/<pid>/environ for each ancestor. Never reads environment contents. Prints JSON.
import json, os, errno
def info(pid):
    d = {'pid': pid}
    try:
        st = open(f'/proc/{pid}/stat').read(); r = st.rsplit(')', 1)[1].split()
        d['comm'] = st[st.index('(') + 1:st.rindex(')')]; d['ppid'] = int(r[1]); d['starttime_ticks'] = int(r[19])
    except OSError as e: d['stat_error'] = errno.errorcode.get(e.errno, str(e.errno))
    try:
        for l in open(f'/proc/{pid}/status'):
            if l.startswith('Uid:'): d['uid_real_eff_saved_fs'] = [int(x) for x in l.split()[1:5]]
    except OSError as e: d['status_error'] = errno.errorcode.get(e.errno, str(e.errno))
    try:
        fd = os.open(f'/proc/{pid}/environ', os.O_RDONLY); os.close(fd); d['environ_open'] = 'ok (closed unread)'
    except OSError as e: d['environ_open'] = errno.errorcode.get(e.errno, str(e.errno))
    return d
chain, pid = [], os.getpid()
for _ in range(16):
    d = info(pid); chain.append(d)
    if pid <= 1 or 'ppid' not in d: break
    pid = d['ppid']
print(json.dumps({'uid': os.getuid(), 'euid': os.geteuid(), 'gid': os.getgid(), 'egid': os.getegid(),
                  'clk_tck': os.sysconf('SC_CLK_TCK'), 'chain_from_probe': chain}, indent=1))

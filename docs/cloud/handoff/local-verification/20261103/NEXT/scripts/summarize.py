#!/usr/bin/env python3
"""summarize.py <run dir>: parse strict logs and check logs into manifest/SUMMARY.json (no pooling)."""
import json, os, re, sys, glob
R = sys.argv[1]
POP = re.compile(r'^(?:# )?b10b-s3-perf (.+?): n=(\d+) p50=([\d.]+)ms p95=([\d.]+)ms p99=([\d.]+)ms max=([\d.]+)ms strict=(\w+)')
TEST = re.compile(r'^(✔|✖) (.+?) \(([\d.]+)ms\)')
TAP = re.compile(r'^(ok|not ok) \d+ - (.+)$')
CNT = re.compile(r'^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)')
def hdr(text, key):
    m = re.search(r'^# %s: (.*)$' % re.escape(key), text, re.M); return m.group(1) if m else None
out = {'strict': [], 'steps': []}
for f in sorted(glob.glob(os.path.join(R, 'logs/strict/*.log'))):
    t = open(f, encoding='utf-8').read()
    pops = [dict(name=m[0], n=int(m[1]), p50=float(m[2]), p95=float(m[3]), p99=float(m[4]), max=float(m[5]), strict=m[6])
            for m in (POP.match(l).groups() for l in t.splitlines() if POP.match(l))]
    tests = [dict(ok=g[0] == '✔', name=g[1], ms=float(g[2])) for g in (TEST.match(l).groups() for l in t.splitlines() if TEST.match(l))]
    tests += [dict(ok=g[0] == 'ok', name=g[1], ms=None, reporter='tap') for g in (TAP.match(l).groups() for l in t.splitlines() if TAP.match(l))]
    out['strict'].append(dict(log=os.path.relpath(f, R), runtime=hdr(t, 'runtime'), start=hdr(t, 'start'), end=hdr(t, 'end'),
                              exit=hdr(t, 'exit'), populations=pops, gates=tests))
for f in sorted(glob.glob(os.path.join(R, 'logs/**/*.log'), recursive=True)):
    if '/strict/' in f or f.endswith('main-driver.log'): continue
    t = open(f, encoding='utf-8', errors='replace').read()
    blocks, cur = [], {}
    for l in t.splitlines():
        m = CNT.match(l)
        if m:
            cur[m.group(1)] = float(m.group(2)) if '.' in m.group(2) else int(m.group(2))
            if m.group(1) == 'duration_ms': blocks.append(cur); cur = {}
    fails = [g[1] for g in (TEST.match(l.strip()).groups() for l in t.splitlines() if TEST.match(l.strip())) if g[0] == '✖']
    fails += [g[1] for g in (TAP.match(l.strip()).groups() for l in t.splitlines() if TAP.match(l.strip())) if g[0] == 'not ok']
    out['steps'].append(dict(log=os.path.relpath(f, R), id=hdr(t, 'id'), command=hdr(t, 'command'), runtime=hdr(t, 'runtime'),
                             start=hdr(t, 'start'), end=hdr(t, 'end'), exit=hdr(t, 'exit'), timeout=hdr(t, 'timeout'),
                             test_blocks=blocks, failing_test_lines=sorted(set(fails))))
json.dump(out, open(os.path.join(R, 'manifest/SUMMARY.json'), 'w'), indent=1, ensure_ascii=False)
for s in out['strict']:
    print(s['log'], 'exit', s['exit'])
    for p in s['populations']: print('  %-110s n=%d p50=%.3f p95=%.3f p99=%.3f max=%.3f %s' % (p['name'][:110], p['n'], p['p50'], p['p95'], p['p99'], p['max'], p['strict']))
    for g in s['gates']: print('  ', '✔' if g['ok'] else '✖', g['name'][:100])
for s in out['steps']:
    print(s['id'], s['exit'], s['test_blocks'], s['failing_test_lines'][:20])

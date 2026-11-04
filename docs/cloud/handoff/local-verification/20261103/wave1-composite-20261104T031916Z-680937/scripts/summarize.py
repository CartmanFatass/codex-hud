#!/usr/bin/env python3
"""summarize.py <RD>: per-command results (exit, signal, counts, failing tests) and benchmark outputs -> SUMMARY.json."""
import json, os, re, sys, glob
RD = sys.argv[1]
CNT = re.compile(r'^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$')
FAIL = re.compile(r'^(?:✖ (.+?) \([\d.]+ms\)|not ok \d+ - (.+))$')
rows = [l.rstrip('\n').split('\t') for l in open(os.path.join(RD, 'manifest/results.tsv'))]
out = {'commands': [], 'benchmark': []}
for tree, prof, rel, cid, ec, sig, s, e, to, cmd in rows:
    base = os.path.join(RD, rel)
    blocks, cur, fails = [], {}, []
    for l in open(os.path.join(base, 'stdout.raw'), encoding='utf-8', errors='replace'):
        l = l.rstrip('\n'); m = CNT.match(l)
        if m:
            cur[m.group(1)] = float(m.group(2)) if '.' in m.group(2) else int(m.group(2))
            if m.group(1) == 'duration_ms': blocks.append(cur); cur = {}
        f = FAIL.match(l.strip())
        if f and (f.group(1) or f.group(2)) != 'failing tests:': fails.append(f.group(1) or f.group(2))
    rec = dict(tree=tree, profile=prof, id=cid, exit=int(ec), signal_or_timeout=sig, start=s, end=e, timeout_s=int(to),
               command=cmd, test_blocks=blocks, failing_tests=sorted(set(fails)), logs=rel,
               stderr_bytes=os.path.getsize(os.path.join(base, 'stderr.raw')))
    out['commands'].append(rec)
    if cid.startswith('bench-'):
        try: b = json.load(open(os.path.join(base, 'stdout.raw')))
        except Exception as ex: b = {'parse_error': str(ex)}
        out['benchmark'].append(dict(run=cid, tree=tree, profile=prof, exit=int(ec), start=s, end=e, output=b))
for p in sorted(glob.glob(os.path.join(RD, 'logs/*/*/not-run.txt'))):
    out.setdefault('not_run', []).append(dict(path=os.path.relpath(p, RD), reason=open(p).read().strip()))
json.dump(out, open(os.path.join(RD, 'SUMMARY.json'), 'w'), indent=1, ensure_ascii=False)
for r in out['commands']:
    b = '; '.join('%s/%s pass, %s fail, %s skip, %s cancel' % (x.get('pass'), x.get('tests'), x.get('fail'), x.get('skipped'), x.get('cancelled')) for x in r['test_blocks'])
    print('%-4s %-26s %-28s exit=%s %s %s %s' % (r['tree'], r['profile'], r['id'], r['exit'], r['signal_or_timeout'], b, r['failing_tests'][:4] if r['failing_tests'] else ''))

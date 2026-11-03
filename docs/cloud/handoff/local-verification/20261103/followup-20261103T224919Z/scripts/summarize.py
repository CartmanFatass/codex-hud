#!/usr/bin/env python3
"""summarize.py <FU>: per-command results (exit, signal, counts, failing tests) and MCP benchmark outputs -> SUMMARY.json."""
import json, os, re, sys, glob
FU = sys.argv[1]
CNT = re.compile(r'^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$')
FAIL = re.compile(r'^(?:✖ (.+?) \([\d.]+ms\)|not ok \d+ - (.+))$')
rows = [l.rstrip('\n').split('\t') for l in open(os.path.join(FU, 'manifest/results.tsv'))]
out = {'commands': [], 'mcp_benchmark': []}
for pkg, prof, cid, ec, sig, s, e, to, cmd in rows:
    base = os.path.join(FU, 'logs', pkg, prof, cid)
    blocks, cur, fails = [], {}, []
    if os.path.exists(base + '.stdout'):
        for l in open(base + '.stdout', encoding='utf-8', errors='replace'):
            l = l.rstrip('\n'); m = CNT.match(l)
            if m:
                cur[m.group(1)] = float(m.group(2)) if '.' in m.group(2) else int(m.group(2))
                if m.group(1) == 'duration_ms': blocks.append(cur); cur = {}
            f = FAIL.match(l.strip())
            if f and (f.group(1) or f.group(2)) != 'failing tests:': fails.append(f.group(1) or f.group(2))
    rec = dict(package=pkg, profile=prof, id=cid, exit=int(ec), signal_or_timeout=sig, start=s, end=e, timeout_s=int(to),
               command=cmd, test_blocks=blocks, failing_tests=sorted(set(fails)),
               stdout=f'logs/{pkg}/{prof}/{cid}.stdout', stderr=f'logs/{pkg}/{prof}/{cid}.stderr', meta=f'logs/{pkg}/{prof}/{cid}.meta.txt')
    out['commands'].append(rec)
    if cid.startswith('bench-node'):
        try: rec_b = json.load(open(base + '.stdout'))
        except Exception as ex: rec_b = {'parse_error': str(ex)}
        out['mcp_benchmark'].append(dict(run=cid, tree=pkg, exit=int(ec), stderr_bytes=os.path.getsize(base + '.stderr'), **rec_b))
for p in glob.glob(os.path.join(FU, 'logs/*/*/*.not-run.txt')):
    out.setdefault('not_run', []).append(dict(path=os.path.relpath(p, FU), reason=open(p).read().strip()))
json.dump(out, open(os.path.join(FU, 'SUMMARY.json'), 'w'), indent=1, ensure_ascii=False)
for r in out['commands']:
    b = '; '.join('%s/%s pass, %s fail, %s skip' % (x.get('pass'), x.get('tests'), x.get('fail'), x.get('skipped')) for x in r['test_blocks'])
    print('%-8s %-26s %-40s exit=%s %s %s' % (r['package'], r['profile'], r['id'], r['exit'], b, r['failing_tests'][:3] if r['failing_tests'] else ''))

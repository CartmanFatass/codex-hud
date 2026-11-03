#!/usr/bin/env python3
"""summarize.py <run dir>: parse results.tsv + logs into SUMMARY.json (raw facts only, no judgments)."""
import csv, json, os, re, sys
R = sys.argv[1]
rows = list(csv.DictReader(open(os.path.join(R, 'manifest/results.tsv')), delimiter='\t'))
COUNT = re.compile(r'^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$')
NOTOK = re.compile(r'^( *)not ok \d+ - (.*?)(?: # .*)?$')
PERF = re.compile(r'(b10b-s3-perf [^:]+?): n=(\d+) p50=([\d.]+)ms p95=([\d.]+)ms p99=([\d.]+)ms max=([\d.]+)ms strict=(\w+)')
def logpath(r):
    t, rt, step = r['target'], r['runtime'], r['step']
    if step.startswith('b10b-B-'):
        return os.path.join(R, 'logs/perf-series-B', step + '.log')
    if step.startswith(('b10b-', 'runz1-perf')):
        return os.path.join(R, 'logs/perf-series', step + '.log')
    return os.path.join(R, 'logs', t, rt, step + '.log')
out = []
for r in rows:
    p = logpath(r)
    text = open(p, errors='replace').read() if os.path.exists(p) else ''
    blocks, cur = [], {}
    for line in text.splitlines():
        m = COUNT.match(line.strip())
        if m:
            if m.group(1) == 'tests' and cur:
                blocks.append(cur); cur = {}
            cur[m.group(1)] = int(m.group(2))
    if cur: blocks.append(cur)
    failing, grab = [], False
    for line in text.splitlines():
        if line.strip() == '✖ failing tests:': grab = True; continue
        if grab and line.startswith('✖ '): failing.append(line[2:].strip())
        if line.startswith('# end:'): grab = False
        m = NOTOK.match(line)
        if m: failing.append(('  ' * (len(m.group(1)) // 4)) + m.group(2).strip())
    e = {**r, 'exit': int(r['exit']), 'log': os.path.relpath(p, R), 'test_counts': blocks, 'failing_tests': failing}
    perf = [dict(zip(['population', 'n', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'strict'], m.groups())) for m in PERF.finditer(text)]
    if perf:
        seen, uniq = set(), []
        for x in perf:
            if x['population'] in seen: continue
            seen.add(x['population']); uniq.append({k: (float(v) if k.endswith('_ms') else int(v) if k == 'n' else v) for k, v in x.items()})
        e['perf'] = uniq
    if r['step'].startswith('runz1-perf'):
        m = re.search(r'^\{.*?^\}', text, re.S | re.M)
        if m:
            try: e['runz1_perf'] = json.loads(m.group(0))
            except Exception as ex: e['runz1_perf_parse_error'] = str(ex)
    out.append(e)
json.dump({'run': os.path.basename(R), 'steps': out}, open(os.path.join(R, 'SUMMARY.steps.json'), 'w'), indent=1, ensure_ascii=False)
for e in out:
    c = '; '.join('tests %s pass %s fail %s skip %s cancel %s' % (b.get('tests'), b.get('pass'), b.get('fail'), b.get('skipped'), b.get('cancelled')) for b in e['test_counts'])
    print(e['target'], e['runtime'], e['step'], 'exit', e['exit'], '|', c, '|', len(e['failing_tests']), 'failing')

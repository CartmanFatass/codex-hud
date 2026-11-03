#!/usr/bin/env python3
"""report.py <run dir>: build SUMMARY.json and REPORT.md from SUMMARY.steps.json and manifests. Numbers come only from logs."""
import json, os, re, sys

R = sys.argv[1]
S = json.load(open(os.path.join(R, 'SUMMARY.steps.json')))['steps']
RUN = os.path.basename(R)

TARGETS = {
    'hyg2': ('dots/hyg2', '2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31', '50438e87a1915d5e739a4a4d926cc9b1e7e85724', 'HYG2'),
    'runz1': ('dots/runz1', '86ca8887fcfb331750ec6dc5518d69134cb795e4', 'da3e386e3512736f3078d0fd9c7b85a868f83f6d', 'RUNZ1'),
    'perf': ('dots/b10b-s3f-perf', '94969100ec85a41f93eb2a0d677aefc886290691', 'c91d20549ccc1df9fe0d8860478f76c892d17db2', 'B10B-S3F-PERF candidate'),
    'base': ('dots/b10b-s3f', 'bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60', 'f9bcdc5c069156d655ca7d3cd7a08590e74b8eec', 'B10B-S3F baseline (perf only)'),
}
CHECK_STEPS = ['01-build', '02-build-test', '03-build-hud-mcp', '04-npm-test', '04b-test-mjs-separate', '05-test-core',
               '06-test-visual', '07-test-hud-mcp', '08-format-check', '09-check-fixtures', '10-git-diff-check']
CMD = {'01-build': 'npm run build', '02-build-test': 'npm run build:test', '03-build-hud-mcp': 'npm run build:hud-mcp',
       '04-npm-test': 'npm test', '04b-test-mjs-separate': 'npm run test:mjs (separately)', '05-test-core': 'npm run test:core',
       '06-test-visual': 'npm run test:visual', '07-test-hud-mcp': 'npm run test:hud-mcp', '08-format-check': 'npm run format:check',
       '09-check-fixtures': 'npm run check:fixtures', '10-git-diff-check': 'git diff --check'}
ENVS = [('node24', 'Node v24.22.1'), ('node22', 'Node v22.23.4, NODE_USE_ENV_PROXY=1 passed'),
        ('node22-noenvproxy', 'Node v22.23.4, NODE_USE_ENV_PROXY not passed (owner-chosen rerun)')]
GATED = {
    'compact no-change tick (reconcile + key press + rows + the 60 rows in view)': ('compact no-change', 2.0),
    'rich no-change tick (reconcile + key press + rows + the 60 rows in view)': ('rich no-change', 2.0),
    'compact changed tick (fresh view model, 1 of 200 differs, clocks moved, a key pressed; every row read)': ('compact changed', 10.0),
    'rich changed tick (fresh view model, 1 of 200 differs, clocks moved, a key pressed; every row read)': ('rich changed', 15.0),
}

def step(t, rt, sid):
    for e in S:
        if e['target'] == t and e['runtime'] == rt and e['step'] == sid:
            return e
    return None

def counts(e):
    out = []
    for b in e['test_counts']:
        out.append('%s tests: %s pass, %s fail, %s skipped, %s cancelled' % (b.get('tests'), b.get('pass'), b.get('fail'), b.get('skipped'), b.get('cancelled')))
    return '; '.join(out)

def verdict(e):
    if e is None:
        return 'NOT RUN'
    return 'PASS' if e['exit'] == 0 else 'FAIL'

def gated(e):
    g = {}
    for p in e.get('perf', []):
        k = p['population'].replace('b10b-s3-perf ', '')
        if k in GATED:
            name, lim = GATED[k]
            g[name] = dict(p50_ms=p['p50_ms'], p95_ms=p['p95_ms'], p99_ms=p['p99_ms'], max_ms=p['max_ms'], n=p['n'], limit_p99_ms=lim, within_gate=p['p99_ms'] <= lim)
    return g

def monitor(sid, series):
    if series != 'B':
        f = os.path.join(R, 'logs/perf-series', sid + '.log')
        snaps = re.findall(r'^## (before|after) (\S+) loadavg: ([\d.]+) ([\d.]+) ([\d.]+)', open(f).read(), re.M)
        return {'kind': 'before/after ps snapshots only', 'loadavg_1m': {s[0]: float(s[2]) for s in snaps}}
    lines = open(os.path.join(R, 'logs/perf-series-B', sid + '.monitor.txt')).read().splitlines()
    l1 = [float(x.split()[1]) for x in lines]
    return {'kind': '1 s sampler (loadavg + top-5 comm by ps %CPU)', 'samples': len(lines), 'loadavg_1m_min': min(l1), 'loadavg_1m_max': max(l1)}

# ---------- SUMMARY.json ----------
summary = {'run_id': RUN, 'report': 'REPORT.md', 'targets': {}, 'checks': {}, 'focused': {}, 'supplementary': [], 'runz1_perf': [], 'b10b_perf': {'A': [], 'B': []}}
for k, (b, c, t, label) in TARGETS.items():
    summary['targets'][k] = {'branch': b, 'commit': c, 'tree': t, 'role': label}
for k in ('hyg2', 'runz1', 'perf'):
    summary['checks'][k] = {}
    for rt, _ in ENVS:
        summary['checks'][k][rt] = {}
        for sid in CHECK_STEPS:
            e = step(k, rt, sid)
            summary['checks'][k][rt][sid] = None if e is None else {
                'command': CMD[sid], 'exit': e['exit'], 'result': verdict(e), 'start_utc': e['start_utc'], 'end_utc': e['end_utc'],
                'test_counts': e['test_counts'], 'failing_tests': e['failing_tests'], 'log': e['log']}
        fid = {'hyg2': '11-focused-hyg2', 'runz1': '11-focused-runz1', 'perf': '11-focused-b10b'}[k]
        e = step(k, rt, fid)
        summary['focused'].setdefault(k, {})[rt] = None if e is None else {
            'command': e['command'], 'exit': e['exit'], 'result': verdict(e), 'test_counts': e['test_counts'], 'failing_tests': e['failing_tests'], 'log': e['log']}
for e in S:
    if e['step'].startswith('07r'):
        summary['supplementary'].append({'target': e['target'], 'runtime': e['runtime'], 'step': e['step'], 'command': e['command'], 'exit': e['exit'], 'test_counts': e['test_counts'], 'log': e['log']})
    if e['step'].startswith('runz1-perf'):
        summary['runz1_perf'].append({'step': e['step'], 'runtime': e['runtime'], 'exit': e['exit'], 'start_utc': e['start_utc'], 'command': e['command'], 'log': e['log'], 'result': e.get('runz1_perf')})
    if e['step'].startswith('b10b-'):
        series = 'B' if e['step'].startswith('b10b-B-') else 'A'
        summary['b10b_perf'][series].append({'step': e['step'], 'side': 'baseline' if e['target'] == 'base' else 'candidate', 'commit': TARGETS[e['target']][1],
            'runtime': e['runtime'], 'exit': e['exit'], 'start_utc': e['start_utc'], 'end_utc': e['end_utc'], 'command': e['command'],
            'gated': gated(e), 'all_populations': e.get('perf', []), 'failing_tests': e['failing_tests'], 'load': monitor(e['step'], series), 'log': e['log']})
json.dump(summary, open(os.path.join(R, 'SUMMARY.json'), 'w'), indent=1, ensure_ascii=False)

# ---------- tables for REPORT.md ----------
def check_table(k):
    rows = ['| Step | Command | ' + ' | '.join(lbl.split(',')[0] + (' (envproxy)' if rt == 'node22' else ' (no envproxy)' if 'noenv' in rt else '') for rt, lbl in ENVS) + ' |',
            '|---|---|' + '---|' * len(ENVS)]
    for sid in CHECK_STEPS:
        cells = []
        for rt, _ in ENVS:
            e = step(k, rt, sid)
            if e is None:
                cells.append('not run (npm test reached test:mjs)' if sid == '04b-test-mjs-separate' else 'NOT RUN')
            else:
                c = '; '.join('%s/%s pass, %s fail, %s skip' % (b.get('pass'), b.get('tests'), b.get('fail'), b.get('skipped')) for b in e['test_counts'] if b.get('tests', 0) > 3)
                cells.append('**%s** (exit %d)%s' % (verdict(e), e['exit'], ': ' + c if c else ''))
        rows.append('| %s | `%s` | %s |' % (sid, CMD[sid], ' | '.join(cells)))
    return '\n'.join(rows)

def focused_table(k):
    rows = ['| Runtime | Result | Counts | Failing tests | Log |', '|---|---|---|---|---|']
    for rt, lbl in ENVS:
        e = summary['focused'][k][rt]
        rows.append('| %s | **%s** (exit %d) | %s | %s | `%s` |' % (lbl, e['result'], e['exit'], '; '.join('%s/%s pass, %s fail' % (b.get('pass'), b.get('tests'), b.get('fail')) for b in e['test_counts']),
                    '<br>'.join(e['failing_tests']) or '—', e['log']))
    return '\n'.join(rows)

def perf_table(series):
    rows = ['| # | Run | Side | Exit | compact no-change p99 (≤2) | rich no-change p99 (≤2) | compact changed p99 (≤10) | rich changed p99 (≤15) | Load (1 min) |',
            '|---|---|---|---|---|---|---|---|---|']
    for i, r in enumerate(summary['b10b_perf'][series], 1):
        g = r['gated']
        def cell(n):
            x = g.get(n)
            if not x:
                return 'missing'
            return ('%.3f' % x['p99_ms']) + ('' if x['within_gate'] else ' **OVER**')
        ld = r['load']
        lt = ('%.2f–%.2f (%d samples)' % (ld['loadavg_1m_min'], ld['loadavg_1m_max'], ld['samples'])) if series == 'B' else ('before %.2f / after %.2f' % (ld['loadavg_1m'].get('before', -1), ld['loadavg_1m'].get('after', -1)))
        rows.append('| %d | %s | %s | %d | %s | %s | %s | %s | %s |' % (i, r['step'].replace('b10b-', ''), r['side'], r['exit'], cell('compact no-change'), cell('rich no-change'), cell('compact changed'), cell('rich changed'), lt))
    return '\n'.join(rows)

def perf_ranges(series):
    rows = ['| Runtime | Side | Population | p50 range | p95 range | p99 range | max range | Runs within gate |', '|---|---|---|---|---|---|---|---|']
    for rt in ('node22', 'node24'):
        for side in ('baseline', 'candidate'):
            runs = [r for r in summary['b10b_perf'][series] if r['runtime'] == rt and r['side'] == side]
            for name in ('compact no-change', 'rich no-change', 'compact changed', 'rich changed'):
                v = [r['gated'][name] for r in runs if name in r['gated']]
                rng = lambda k: '%.3f–%.3f' % (min(x[k] for x in v), max(x[k] for x in v))
                rows.append('| %s | %s | %s | %s | %s | %s | %s | %d/%d |' % (rt, side, name, rng('p50_ms'), rng('p95_ms'), rng('p99_ms'), rng('max_ms'), sum(x['within_gate'] for x in v), len(v)))
    return '\n'.join(rows)

def runz1_table():
    rows = ['| Run | Exit | Population | n | p50 | p95 | p99 | max | refusals |', '|---|---|---|---|---|---|---|---|---|']
    for r in summary['runz1_perf']:
        res = r['result'] or {}
        for pop in ('full_proof', 'additional_complete_scan', 'existing_inspection', 'churn_full_proof', 'esrch_full_proof'):
            x = res.get(pop)
            if x:
                rows.append('| %s | %d | %s | %d | %.3f | %.3f | %.3f | %.3f | %d |' % (r['step'].replace('runz1-perf-', ''), r['exit'], pop, x['n'], x['p50_ms'], x['p95_ms'], x['p99_ms'], x['max_ms'], x['refusals']))
    return '\n'.join(rows)

tmpl = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'report-template.md')).read()
out = tmpl
for key, val in {
    '{{RUN}}': RUN,
    '{{CHECKS_HYG2}}': check_table('hyg2'), '{{CHECKS_RUNZ1}}': check_table('runz1'), '{{CHECKS_PERF}}': check_table('perf'),
    '{{FOCUSED_HYG2}}': focused_table('hyg2'), '{{FOCUSED_RUNZ1}}': focused_table('runz1'), '{{FOCUSED_PERF}}': focused_table('perf'),
    '{{RUNZ1_PERF}}': runz1_table(),
    '{{B10B_A}}': perf_table('A'), '{{B10B_B}}': perf_table('B'), '{{B10B_A_RANGES}}': perf_ranges('A'), '{{B10B_B_RANGES}}': perf_ranges('B'),
}.items():
    out = out.replace(key, val)
open(os.path.join(R, 'REPORT.md'), 'w').write(out)
print('ok')

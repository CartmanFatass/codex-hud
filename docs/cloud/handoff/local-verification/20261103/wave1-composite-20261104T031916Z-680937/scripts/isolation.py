#!/usr/bin/env python3
"""isolation.py <cpumon.tsv>: apply the criterion declared in profile-plan.json before any measurement.
Q1: no 1 s sample with non-owned CPU above 1.0 core. Q2: no 5-sample rolling mean of non-owned CPU above 0.5 core.
Prints QUALIFIES or DOES NOT QUALIFY, plus every violating sample (utc, value, non-owned comm:cores)."""
import sys
rows = [l.rstrip('\n').split('\t') for l in open(sys.argv[1])][1:]
v = [float(r[3]) for r in rows]
q1 = [(r[0], float(r[3]), r[4] if len(r) > 4 else '') for r in rows if float(r[3]) > 1.0]
q2 = [(rows[i + 4][0], sum(v[i:i + 5]) / 5) for i in range(len(v) - 4) if sum(v[i:i + 5]) / 5 > 0.5]
ok = len(rows) >= 55 and not q1 and not q2
print('QUALIFIES' if ok else 'DOES NOT QUALIFY')
print('samples: %d; non-owned cores mean %.3f max %.2f' % (len(v), sum(v) / max(len(v), 1), max(v or [0])))
print('Q1 violations (sample > 1.0 core): %d' % len(q1))
for x in q1: print('  %s %.2f %s' % x)
print('Q2 violations (5 s mean > 0.5 core): %d' % len(q2))
for x in q2: print('  window ending %s mean %.2f' % x)

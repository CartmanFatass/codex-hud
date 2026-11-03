# Published copy: private literals in SUBS/SCAN are replaced by descriptions; the logic is unchanged.
#!/usr/bin/env python3
"""redact.py <src run dir> <dst dir>: copy text evidence with private identifiers replaced; report residual hits."""
import os, re, shutil, sys
src, dst = sys.argv[1], sys.argv[2]
SUBS = [
    (re.compile(r'<VERIFY_ROOT>'), '<VERIFY_ROOT>'),
    (re.compile(r'<REPO>'), '<REPO>'),
    (re.compile(r'<HOME>'), '<HOME>'),
    (re.compile(r'<owner e-mail, literal withheld>'), '<email>'),
    (re.compile(r'(?<![A-Za-z])<host>(?![A-Za-z])'), '<host>'),
    (re.compile(r'\bhttps?://127\.0\.0\.1:\d+'), '<local-proxy>'),
    (re.compile(r'/tmp/claude-\d+/[^\s\'"]*'), '<claude-tmp>'),
]
# Residual scan: anything that still looks private after substitution.
SCAN = re.compile(r'(<home-path, Windows-user-path, GitHub/OpenAI/AWS/Slack token prefixes, private-key header, Claude session/messaging token names, local proxy port, NO_PROXY domain names, owner e-mail local part, local user name, machine name>)')  # literals withheld in the published copy
hits = []
for root, _, files in os.walk(src):
    for f in files:
        sp = os.path.join(root, f); rel = os.path.relpath(sp, src); dp = os.path.join(dst, rel)
        os.makedirs(os.path.dirname(dp), exist_ok=True)
        data = open(sp, 'rb').read()
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            hits.append((rel, 0, '<binary file, not copied>')); continue
        for rx, rep in SUBS:
            text = rx.sub(rep, text)
        for i, line in enumerate(text.splitlines(), 1):
            for m in SCAN.finditer(line):
                hits.append((rel, i, line[max(0, m.start() - 60):m.end() + 60]))
        open(dp, 'w', encoding='utf-8').write(text)
for h in hits:
    print('%s:%s: %s' % h)
print('residual hits:', len(hits), file=sys.stderr)

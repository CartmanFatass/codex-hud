"""Derive the local node24 stage-1 proposal from the already reviewed cloud node24 files by exact, counted substitutions.
Usage: make_local_proposal.py REVIEWED_PACKET_DIR ROOT OUT_DIR
Data-only: reads the reviewed files as text, writes new text files. Executes nothing it reads."""
import hashlib, json, os, sys
Z, ROOT, OUT = sys.argv[1:4]
HOME_PFX = '/HOME'
NODE_L = HOME_PFX + '/.nvm/versions/node/v24.22.1/bin/node'
PY_L = '/usr/bin/python3'
CHECKOUT_L = ROOT + '/wt-source'
BASE_L = ROOT + '/p065-local-build-node24-01'
EPFX_L = ROOT + '/p065-local-build-node24-stage-'
NODE_SHA = 'e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb'
PY_SHA = 'e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f'  # /usr/bin/python3 -> python3.12
TOOLS = {  # path -> sha256 of the resolved file (local, this host)
 '/usr/bin/env': '886e5fa8be716b03eeda48856e0f04493f2969fc148fb7812594ffac647fa050',
 '/usr/bin/timeout': '12690a043dfd555a6c14ccc1564f5649c18f1762c0d6ff66729948130898ec52',
 '/usr/bin/git': 'eb54b535467e0975c1284d4c4d08eea779aeb248a5d34b02e2ee171382e22201',
 '/usr/bin/bash': 'bc5945feb8bd26203ebfafea5ce1878bb2e32cb8fb50ab7ae395cfb1e1aaaef1',
 '/usr/bin/tail': '03806be6481b4232405b9a16cb6d2a615977f12b2fd49fc6eabcefc6c6abbbdc',
}
def rd(p): return open(p, encoding='utf-8').read()
def sub(text, old, new, count=1):
    assert text.count(old) == count, (old, text.count(old))
    return text.replace(old, new)
def sha(b): return hashlib.sha256(b).hexdigest()

# ---- launcher
L = rd(Z + '/builds/node24/stage-1-launcher.py')
L = sub(L, '"""PROPOSED ONLY: P065-on-C3 node24 build stage 1; no execution admission."""',
           '"""PROPOSED ONLY (LOCAL OWNER): P065-on-C3 node24 build stage 1, local paths and tools; no execution admission."""')
L = sub(L, "CHECKOUT = '/workspace/p065-c3-node24-verify-01'", "CHECKOUT = '%s'" % CHECKOUT_L)
L = sub(L, "NODE = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'", "NODE = '%s'" % NODE_L)
L = sub(L, "PYTHON = '/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3'", "PYTHON = '%s'" % PY_L)
L = sub(L, "MANIFEST = '/workspace/p065-c3-build-node24-01/manifest.json'", "MANIFEST = '%s/manifest.json'" % BASE_L)
L = sub(L, "EVIDENCE = '/workspace/p065-c3-build-node24-stage-1-evidence-01'", "EVIDENCE = '%s1-evidence-01'" % EPFX_L)
L = sub(L, "NODE: '61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d'", "NODE: '%s'" % NODE_SHA)
L = sub(L, "PYTHON: 'fa67443527ed9647f760d807e2a38f26340757123e643c4639cf273ed15d5ea7'", "PYTHON: '%s'" % PY_SHA)
assert '/workspace' not in L and '/opt/codex' not in L
LSHA = sha(L.encode())

# ---- checker
C = rd(Z + '/builds/node24/check.py')
C = sub(C, "R='/workspace/p065-c3-node24-verify-01';B='/workspace/p065-c3-build-node24-01';E='/workspace/p065-c3-build-node24-stage-'",
           "R='%s';B='%s';E='%s'" % (CHECKOUT_L, BASE_L, EPFX_L))
C = sub(C, "launch=['a056e932800131b906284a0f72e5db727b55b8d2550147a5dce7027e2af69e9a', 'e2fd555786e4796ab0b6a848dbd8663969d842ddef7b89112f5330045779fc52', '651390e8cb68268a356aab3006d26cb3bb5e6b98fdae14384a9db8aef2a4868b']",
           "launch=['%s']" % LSHA)
old_exp = "'/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node':'61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d','/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3':'fa67443527ed9647f760d807e2a38f26340757123e643c4639cf273ed15d5ea7','/usr/bin/env':'eb1c64bbc9908afcdf8cb48524f17112d8dd76a249f80dee2f01da14747b3b6e','/usr/bin/timeout':'6ca1891dfc0b05d7680770c2884c0391b92467c7bb6500a5c84677e6481739f1'}"
new_exp = "'%s':'%s','%s':'%s'" % (NODE_L, NODE_SHA, PY_L, PY_SHA) + ''.join(",'%s':'%s'" % kv for kv in TOOLS.items()) + '}'
C = sub(C, old_exp, new_exp)
assert '/workspace' not in C and '/opt/codex' not in C

# ---- wrapper
W = rd(Z + '/builds/node24/run-one.sh')
W = sub(W, 'case "$stage" in 1|2|3) cap=230;; *) exit 2;; esac', 'case "$stage" in 1) cap=230;; *) exit 2;; esac')
W = sub(W, 'base=/workspace/p065-c3-build-node24-01', 'base=%s' % BASE_L)
W = sub(W, 'py=/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3', 'py=%s' % PY_L)
W = sub(W, '/workspace/p065-c3-build-node24-stage-$stage-evidence-01', EPFX_L + '$stage-evidence-01', 2)
assert '/workspace' not in W and '/opt/codex' not in W

M = open(Z + '/builds/node24/manifest.json', 'rb').read()
os.makedirs(OUT + '/original', exist_ok=True)
for name, txt in (('stage-1-launcher.py', L), ('check.py', C), ('run-one.sh', W)):
    open(OUT + '/original/' + name, 'w', encoding='utf-8').write(txt)
open(OUT + '/original/manifest.json', 'wb').write(M)
json.dump({'launcher_sha256': LSHA}, open(OUT + '/launcher-pin.json', 'w'))
print('launcher sha256', LSHA, 'manifest sha256', sha(M))

// Synthetic ptrace workload. All original environment data travels through environ.
import { openSync, closeSync } from 'node:fs';
import { launchGroup, launchShellGroup } from '../../dist/core/run/process.js';
const mode = process.argv[2];
const launch =
  mode === 'bash-sh'
    ? (o) => launchShellGroup(o, { path: '/bin/bash', argv0: '/bin/sh' })
    : mode === 'bash-posix'
      ? (o) => launchShellGroup(o, { path: '/bin/bash', args: ['--posix'] })
      : launchGroup;
const fd = openSync('/dev/null', 'w');
const env = {
  'SYNTHETIC.SECRET': 'synthetic-private-sentinel-92386',
  '-u': 'x',
  '--': 'y',
  '-i': 'z',
  HUD_ENV_0: 'original-collision',
  PWD: '/synthetic/pwd',
  'BASH_FUNC_synthetic_fn%%': '() { printf synthetic; }',
  SYNTHETIC_ADVERSARIAL: '${HUD_ENV_0} $ \\c \\n \\_ # \' " =\n ',
  SYNTHETIC_EMPTY: '',
};
try {
  for (const argv of [[process.execPath, '-e', 'setTimeout(()=>{},100)'], ['/synthetic/exec-will-fail']]) {
    let group;
    try {
      group = await launch({
        runId: 'synthetic-env-audit',
        argv,
        cwd: process.cwd(),
        env,
        stdin: null,
        stdoutFd: fd,
        stderrFd: fd,
      });
    } catch (error) {
      if (argv[0] !== '/synthetic/exec-will-fail' || !String(error).includes('before confirmed submission'))
        throw error;
      continue;
    }
    await group.exited;
    group.close();
  }
} finally {
  closeSync(fd);
}

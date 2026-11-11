/** Recognise only the audited width/discovery/tee wrapper, never execute shell text. */
import { join, isAbsolute } from 'node:path';
const TEMPLATE =
  'bash -c \'cols=${COLUMNS:-}; case "$cols" in ""|*[!0-9]*) cols=$(stty size 2>/dev/null </dev/tty | awk \'"\'"\'{print $2}\'"\'"\');; esac; case "$cols" in ""|*[!0-9]*) cols=120;; esac; export COLUMNS=$(( cols > 4 ? cols - 4 : 1 )); plugin_dir=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/claude-hud/*/ 2>/dev/null | awk -F/ \'"\'"\'{ print $(NF-1) "\\t" $(0) }\'"\'"\' | grep -E \'"\'"\'^[0-9]+\\.[0-9]+\\.[0-9]+[[:space:]]\'"\'"\' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-); tee -p >("@FORWARD@" quota record-claude >/dev/null 2>&1) | "@NODE@" "${plugin_dir}dist/index.js"\'';
export function wrapperJobs(command: string, home: string): { widthMargin: number; forward: string[] } | null {
  const node = /"([^"\r\n]+\/node)" "\$\{plugin_dir\}dist\/index\.js"/.exec(command)?.[1];
  const forward = /tee -p >\("([^"\r\n]+)" quota record-claude >\/dev\/null 2>&1\)/.exec(command)?.[1];
  if (!node || !forward || !isAbsolute(node)) return null;
  const normalized = command
    .replace('"' + node + '" "' + '$' + '{plugin_dir}dist/index.js"', '"@NODE@" "' + '$' + '{plugin_dir}dist/index.js"')
    .replace('"' + forward + '"', '"@FORWARD@"');
  if (normalized !== TEMPLATE) return null;
  const executable = forward === '$' + 'HOME/.cargo/bin/toktrack' ? join(home, '.cargo/bin/toktrack') : forward;
  if (!isAbsolute(executable) || !executable.endsWith('/toktrack')) return null;
  return { widthMargin: 4, forward: [executable, 'quota', 'record-claude'] };
}

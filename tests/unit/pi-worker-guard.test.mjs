// Strict Bash cases ported from pi-roles.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { bashViolation, installGuard } from '../../dist/harness/pi/worker/guard.js';

const allowed = [
	"git status --short",
	"git diff",
	"git diff --stat HEAD~1",
	"git log --oneline -5",
	"git show HEAD:scripts/a.gd",
	"git stash list",
	"git branch --show-current",
	"git config --get user.name",
	"git tag --list",
	"git fetch --dry-run",
	"ls -la scripts/",
	"grep -rn 'foo' scripts/ 2>/dev/null",
	"tools/test.sh --filter=tac_ 2>&1 | tail -20",
	"python3 -c 'print(1)' >/dev/null",
	"cat a.md | head -50",
	"echo hi 1>&2",
	"rg install docs/",
	"sed -n '1,40p' file.gd",
	"codegraph explore 'TacBattle apply'",
	"git -C /repo diff --name-only",
	"node -e 'const f = (x) => x > 1'",
	'grep -n "=>" src/a.ts',
	"rg 'a > b' docs/",
	'node -e "console.log(1 > 0)" 2>&1 | head',
	"echo 'x >> y'",
	String.raw`echo "escaped \" > still data"`,
	'echo a#b "a > b"',
	'echo $# "a > b"',
	String.raw`echo a\ #b "a > b"`,
	'echo "$(echo ok # ) \' \"\n)"',
	// A line break inside quotes is data; comments are understood across lines.
	'echo "a\n> b"',
	'echo "a\\\n> b"',
	"node -e '\nconst f = (x) => x > 1;\nconsole.log(f(2))\n' | head",
	// A quoted-delimiter heredoc body is stdin data for a non-shell reader.
	"node <<'JS'\nconst f = (x) => x > 1;\nJS",
	"/repo/tmp/env.sh node --input-type=module <<'NODE'\nconst a = [1].map((x) => x);\nNODE",
	"python3 - <<'PY'\nprint('a' if 2 > 1 else 'b')\nx = (install)\nPY",
	"cat <<-'EOF'\n\ta > b\n\tEOF",
	'node - <<"JS"\nconst x = 1 > 0;\nJS',
	// Expansions inside single quotes are script text, not shell.
	"node -e 'const f = (x) => `${x}`; console.log(f(1) > 0)'",
	"node -e 'const g = $(1); g > 0'",
];
const blocked = [
	["git add -A", "git"],
	["git commit -m x", "git"],
	["git -C /repo checkout main", "git"],
	["cd repo && git stash", "git"],
	["git stash push -m x", "git"],
	["git reset --hard", "git"],
	["git push origin main", "git"],
	["git branch -D feature", "git"],
	["git tag v1", "git"],
	["git config user.name x", "git"],
	["git worktree add ../x", "git"],
	["rm -rf build", "file-changing"],
	["cd x; rm a", "file-changing"],
	["mv a b", "file-changing"],
	["sudo chmod 600 f", "file-changing"],
	["echo x | tee out.txt", "file-changing"],
	["sed -i 's/a/b/' f.gd", "in-place"],
	["perl -pi -e 's/a/b/' f", "in-place"],
	["npm install left-pad", "package"],
	["pip install requests", "package"],
	["echo x > out.txt", "redirection"],
	["echo x >> out.txt", "redirection"],
	["cmd &> out.txt", "redirection"],
	["cmd 2> err.txt", "redirection"],
	['echo "a > b" > out.txt', "redirection"],
	["node -e 'x' > out.txt", "redirection"],
	['echo "$(cat a > b)"', "redirection"],
	['echo "`date > f`"', "redirection"],
	[String.raw`echo \" > f`, "redirection"],
	[String.raw`echo \" > f \"`, "redirection"],
	[String.raw`echo \' > f \'`, "redirection"],
	[`echo 'it'"'"'s' > f`, "redirection"],
	['echo "unterminated > f', "redirection"],
	["echo 'unterminated > f", "redirection"],
	['cat a 2>"err.txt"', "redirection"],
	["cmd &>'log'", "redirection"],
	["echo x > 'out.txt'", "redirection"],
	['echo "$(echo "data" > f)"', "redirection"],
	['echo "$(echo $(cat a > b))"', "redirection"],
	['echo "$( (cat a) > b)"', "redirection"],
	[String.raw`echo \\"data" > f`, "redirection"],
	['echo "`echo "data" > f`"', "redirection"],
	['echo ok # "\nprintf ok > out.txt\n# "', "redirection"],
	['echo "$(case x in x) printf ok > out.txt;; esac)"', "redirection"],
	['echo "$(case x in x) echo ok;; esac)" "a > b"', "redirection"],
	['echo "$(echo "$(case x in x) echo ok;; esac)")" > f', "redirection"],
	['echo a#b "data" > f', "redirection"],
	['echo ${x#y} "data" > f', "redirection"],
	['echo $# "data" > f', "redirection"],
	// Complex syntax keeps the conservative raw checks, even for quoted data.
	[String.raw`echo "\$(cat a > b)"`, "redirection"],
	['echo "$(echo \'a > b\')"', "redirection"],
	['echo "$(echo "a > b")"', "redirection"],
	['echo "`echo \'a > b\'`"', "redirection"],
	['echo ${x#y} "a > b"', "redirection"],
	['echo "$(printf %s ${v:-)}; printf ok > out.txt)"', "redirection"],
	[String.raw`echo $'it\'s' > out.txt; echo 'done'`, "redirection"],
	['echo "$(ca\\\nse x in x) printf ok > out.txt;; esac)"', "redirection"],
	// Isolate each gate item so removing it exposes a masked '>'.
	['echo "${v:-a > b}"', "redirection"],
	['echo $"a > b"', "redirection"],
	['cat <<<"a > b"', "redirection"],
	["cat <<'a > b'", "redirection"],
	["case x in x) echo 'a > b';; esac", "redirection"],
	// These constructs are deliberately outside the quote-masking fix.
	['[[ a > b ]]', "redirection"],
	['(( a > b ))', "redirection"],
	// Heredocs a shell may run, unquoted heredocs and text around a literal body stay checked.
	["bash <<'EOF'\nrm -rf x\nEOF", "file-changing"],
	["node <<'JS' | sh\nrm -rf x\nJS", "file-changing"],
	["ssh host <<'EOF'\necho x > f\nEOF", "redirection"],
	["node <<'JS'\nok\nJS\necho x > out.txt", "redirection"],
	["node <<'JS'\nunterminated > f", "redirection"],
	["cat <<EOF\na > b\nEOF", "redirection"],
	["node <<'JS' <<EOF\nx\nJS\na > b\nEOF", "redirection"],
	["cat <<<'EOF' > f\nEOF", "redirection"],
	// Expansions outside single quotes keep the raw check.
	["node -e 'x => x' $(echo y) > f", "redirection"],
	["echo $'a' > f", "redirection"],
	["node -e '`x`' \"$(cat a > b)\"", "redirection"],
	// Comments and new lines across a multi-line command.
	["echo ok # it's\necho x > f", "redirection"],
	["echo a\nrm -rf x", "file-changing"],
	["node -e '\nx\n' > out.txt", "redirection"],
	// All non-redirect checks must continue to inspect the raw command.
	["echo 'git add -A'", "git"],
	["echo 'x | tee out'", "file-changing"],
	["echo 'sed -i script file'", "in-place"],
	["echo 'npm install pkg'", "package"],
];

test('strict Bash guard preserves legacy read, quote, heredoc and mutation rules', () => {
  for (const cmd of allowed) assert.equal(bashViolation(cmd), undefined, `should allow: ${cmd}`);
  for (const [cmd, why] of blocked) assert.ok(bashViolation(cmd)?.includes(why), `should block (${why}): ${cmd}`);
});

for (const mode of ['strict', 'oracle']) test(`${mode} guard checks native file tools and Bash scratch paths`, t => {
  const root = mkdtempSync('/tmp/hud-guard-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'), job = join(root, 'jobs', 'synthetic'), scratch = join(root, 'scratch');
  const source = join(cwd, 'src.ts'), listing = join(scratch, 'file list'), report = join(job, 'report.md');
  for (const path of [cwd, job, scratch]) mkdirSync(path, { recursive: true });
  writeFileSync(source, 'synthetic');
  symlinkSync(cwd, join(scratch, 'repo-link'));
  let hook;
  installGuard({ on(event, fn) { assert.equal(event, 'tool_call'); hook = fn; } }, mode, job, cwd);
  const invoke = (toolName, input) => hook({ toolName, input }, { cwd });
  const bash = command => invoke('bash', { command });
  const write = path => invoke('write', { path });
  assert.equal(invoke('read', { path: 'src.ts' }), undefined);
  assert.equal(write(report), undefined);
  assert.equal(bash('git status --short'), undefined);
  assert.equal(bash('git fetch --dry-run'), undefined);
  for (const path of ['src.ts', source, join(scratch, 'repo-link', 'src.ts'), `${scratch}/../repo/src.ts`]) assert.ok(write(path)?.block, path);
  assert.ok(invoke('edit', { path: listing })?.block);
  for (const command of [
    'git branch synthetic', 'git tag synthetic HEAD', 'git fetch origin', 'git -C "/tmp/test repo" add a',
    `sed --in-place 's/a/b/' "${listing}"`, `perl -pi.bak -e 's/a/b/' "${listing}"`, 'npm install synthetic',
    'printf x > src.ts', `printf x > "${source}"`, `echo x | tee "${scratch}/repo-link/src.ts"`,
    `cp "${listing}" "${cwd}"`, `mv "${source}" "${listing}"`, `rm -rf "${dirname(cwd)}"`,
    `touch "${listing}" "${source}"`, `echo x > "${listing}"; rm src.ts`,
    `env rm "${source}" && touch "${listing}"`, `npm ci > "${listing}"`,
  ]) assert.ok(bash(command)?.block, command);
  for (const path of [listing, '/dev/shm/hud-synthetic-scratch', join(job, 'notes.md')]) {
    for (const result of [write(path), bash(`printf x > "${path}"`), bash(`touch -- "${path}"`)]) {
      assert.equal(Boolean(result?.block), mode === 'strict', path);
    }
  }
  assert.equal(Boolean(bash(`mkdir -p "${scratch}/nested" && cp "${source}" "${listing}"`)?.block), mode === 'strict');
  assert.equal(Boolean(bash(`echo x | tee -a "${listing}" >/dev/null`)?.block), mode === 'strict');
});

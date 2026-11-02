# Isolated Herdr tests

`npm run test:herdr` builds and runs B7's fake-transport/real-SQLite unit tests,
then Linux private-server tests. It never uses the inherited Herdr session.
The only live-instance discovery during B7 was help, version and bundled schema;
the separately authorized orchestrator question was not a test.

Herdr 0.9.5 supports an isolated headless instance:

```
herdr --session b7-private server
```

`private-server.mjs` starts that command with a minimal new environment, a fresh
`mkdtemp` root, private XDG config/data/state/cache/runtime directories, an empty
`HERDR_CONFIG_PATH`, `/bin/sh` and a private `HUD_HOME`. No inherited `HERDR_*`
keys or shell startup config is passed. The socket must appear **inside that
root** before any mutation. All commands use the resulting explicit socket;
the tracked child supplies the independently verified server stamp. Each test
owns its server, panes and synthetic commands, terminates/reaps that exact child
and removes only its own temporary directory. No tmux is used by this suite.

Real private tests cover tab/split creation, `--env` at shell/process, literal argv
(including quotes, newlines and shell metacharacters), one dispatch, foreground
work, shell return invalidating an old locator, close refusal, and server loss.
A synthetic process titled `codex` receives the real `agent prompt` via its raw
TTY; a private `pane.report_agent` declaration supplies test-only recognition.
This is transport evidence, not real Codex readiness/session identity evidence.
A separate tracked Unix-socket child exits halfway through a reply. SQLite
fixtures use temporary real WAL databases and registered writer stamps.

Private servers are possible here, so real host mutations are not deferred.
Real harness/source proofs, wrapper/context behavior, product matrix, parent MCP
failure, and adversarial target replacement at delivery remain B14 evidence.
No real harness or paid model is started; no capability is marked verified.
If Linux/Herdr is absent the private tests print a skip; fake/SQLite tests still
run. An incompatible installed version fails the private version check.

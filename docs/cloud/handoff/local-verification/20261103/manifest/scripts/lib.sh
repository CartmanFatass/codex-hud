# Sourced by driver scripts. Clean, isolated environment for every command.
V=<VERIFY_ROOT>
N22=$V/runtimes/node-v22.23.4/bin
N24=<HOME>/.nvm/versions/node/v24.22.1/bin
nodebin() { case "$1" in 22) echo $N22;; 24) echo $N24;; esac; }
# iso <rt> <cmd...>: run with env -i, minimal PATH, fresh temp HOME, no HUD_HOME.
# From 2026-11-03T16:0xZ (owner request) the proxy variables are passed through unchanged.
iso() {
  local rt=$1; shift
  local th; th=$(mktemp -d /tmp/hudv-home.XXXXXX)
  local -a px=()
  local v
  for v in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy NODE_USE_ENV_PROXY; do
    [ "$v" = NODE_USE_ENV_PROXY ] && [ "${ISO_NO_NODE_ENV_PROXY:-}" = 1 ] && continue
    [ -n "${!v+x}" ] && px+=("$v=${!v}")
  done
  env -i PATH="$(nodebin $rt):/usr/bin:/bin" HOME="$th" TMPDIR=/tmp LANG=C.UTF-8 TERM=xterm-256color \
    npm_config_cache="$V/npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
    "${px[@]}" ${EXTRA_ENV:-} "$@"
}

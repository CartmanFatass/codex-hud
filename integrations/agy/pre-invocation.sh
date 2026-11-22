#!/bin/sh
# The common no-event path does not start Node or read stdin.
case ${HERDR_PANE_ID-} in
  ''|*[!A-Za-z0-9:_-]*) ;;
  *)
    if [ -n "${HUD_HOME-}" ] && [ -f "$HUD_HOME/watchers/$HERDR_PANE_ID.agy-pending" ]; then
      hook=$(readlink -f -- "$0" 2>/dev/null) &&
        node "${hook%/*}/../../packages/hud-mcp/bin/agy-events.mjs" 2>/dev/null && exit 0
    fi
    ;;
esac
printf '{}\n' || :

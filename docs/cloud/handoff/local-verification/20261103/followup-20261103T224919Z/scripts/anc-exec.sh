# anc-exec.sh <file> <cmd...>: record process ancestry (pid, comm, uid; no arguments), then exec the command.
f=$1; shift
p=$$
while [ -n "$p" ] && [ "$p" -gt 0 ] 2>/dev/null; do
  c=$(cat /proc/$p/comm 2>/dev/null); u=$(awk '/^Uid:/{print $2}' /proc/$p/status 2>/dev/null)
  echo "$p $c uid=$u"
  p=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null)
done > "$f"
exec "$@"

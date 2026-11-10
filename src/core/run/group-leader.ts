/** Fixed program: the session leader alone signals kill(0). Two in-group shells
 * merge control/EOF and child completion through an already-unlinked FIFO. No
 * shell-specific CHLD delivery during read, eval, polling or extra authority.
 * Readers ignore INT/TERM: a caught signal can discard a partially read record.
 * The waiter ignores them only after workload fork and performs one child wait.
 */
export const GROUP_LEADER_SCRIPT = `
interrupted=0
trap 'interrupted=1' INT TERM
trap ':' PIPE
exec 5<&0
printf 'READY\\n' >&4
IFS= read -r submit <&3 || exit 0
[ "$submit" = RUN ] || { printf 'REFUSED\\n' >&4; exit 1; }
(
 trap '' INT TERM
 exec 0<&- 4>&- 5<&- 6<&-
 while :; do
  interrupted=0
  if IFS= read -r line <&3; then
   if [ "\${#line}" -le 256 ]; then
    printf '%s\\n' "CONTROL $line" >&7
   else
    printf 'CONTROL INVALID\\n' >&7
   fi
  elif [ "$interrupted" = 0 ]; then
   printf 'SEAL\\n' >&7
   break
  fi
 done
) &
reader=$!
(
 trap 'interrupted=1' INT TERM
 trap ':' PIPE
 exec 3<&- 6<&-
 "$@" <&5 4>&- 5<&- 7>&- &
 command=$!
 # The workload already forked with the caught dispositions. Only the waiter
 # now ignores group signals, so wait cannot lose its result to trap/retry races.
 trap '' INT TERM
 exec 5<&-
 printf 'STARTED %s\\n' "$command" >&4 2>/dev/null || :
 exec 4>&-
 wait "$command" 2>/dev/null
 status=$?
 printf '%s\\n' "DONE $status" >&7
) &
waiter=$!
printf 'WAITER %s\\n' "$waiter" >&4 2>/dev/null || :
exec 0<&- 3<&- 5<&- 7>&-
# Only this reader ignores signals here, AFTER the waiter fork. Its siblings
# choose their own dispositions; the workload cannot inherit this point.
trap '' INT TERM
sealed=0
while :; do
 interrupted=0
 if IFS=' ' read -r tag op seq rest <&6; then
  case "$tag" in
   SEAL) sealed=1;;
   DONE)
    case "$op" in ''|*[!0-9]*) continue;; esac
    [ -z "$seq$rest" ] || continue
    printf 'WAIT %s\\n' "$op" >&4 2>/dev/null || :
    break;;
   CONTROL)
    [ "$sealed" = 0 ] || { printf 'REFUSED\\n' >&4; continue; }
    case "$seq" in ''|*[!0-9]*) printf 'REFUSED\\n' >&4; continue;; esac
    [ -z "$rest" ] || { printf 'REFUSED\\n' >&4; continue; }
    case "$op" in
     INT) kill -s INT 0 && printf 'ACK %s\\n' "$seq" >&4;;
     TERM) kill -s TERM 0 && printf 'ACK %s\\n' "$seq" >&4;;
     KILL) kill -s KILL 0;;
     *) printf 'REFUSED\\n' >&4;;
    esac;;
   *) printf 'REFUSED\\n' >&4;;
  esac
 elif [ "$interrupted" = 0 ]; then
  break
 fi
done
# WAIT prompts the supervisor to close the original fd3. After supervisor death,
# its EOF already sealed the forwarder. Reap both shells before the leader exits.
for auxiliary in "$reader" "$waiter"; do
 while :; do
  interrupted=0
  wait "$auxiliary" 2>/dev/null
  [ "$interrupted" = 0 ] && break
 done
done
`;

#!/usr/bin/env bash
# profile.sh PROFILE : npm ci, then the ten rows with checkpoints; stops at the first non-PASS step.
V=<VERIFY_ROOT>
RUN=$V/$(cat $V/wave1-merged-tree-LATEST.txt); W=$RUN/scripts/w1m.py
p=$1; cd "$V" || exit 90
python3 -I $W adhoc $p 00-npm-ci 900 -- npm ci --ignore-scripts || exit $?
python3 -I $W checkpoint $p after-npm-ci --deps >/dev/null || exit $?
$RUN/scripts/drive.sh $p 01-build 02-build-test 03-build-hud-mcp || exit $?
python3 -I $W checkpoint $p after-builds --generated >/dev/null || exit $?
$RUN/scripts/drive.sh $p 04-npm-test 05-test-core 06-test-visual 07-test-hud-mcp 08-format-check 09-check-fixtures 10-git-diff-check || exit $?
python3 -I $W checkpoint $p end --deps --generated >/dev/null
echo PROFILE-DONE $p

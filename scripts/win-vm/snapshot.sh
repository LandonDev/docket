#!/usr/bin/env bash
# The Windows rig: `snapshot`. See scripts/win-vm/vm.ts and docs/agents/windows-vm.md.
# One command that changes the machine at a time: install, up, down, snapshot and fetch share a lock
# (-o: the lock is not handed down to QEMU, which outlives this command).
export PATH="$HOME/.bun/bin:$PATH"
dir="${WINVM_DIR:-/srv/agents/win-vm}"
mkdir -p "$dir"
flock -o -n -E 75 "$dir/.lock" bun "$(dirname "$0")/vm.ts" snapshot "$@"
rc=$?
[ $rc -eq 75 ] && echo "win-vm: another install, up, down, snapshot or fetch is running" >&2
exit $rc

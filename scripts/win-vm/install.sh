#!/usr/bin/env bash
# The Windows rig: `install`. See scripts/win-vm/vm.ts and docs/agents/windows-vm.md.
# One command that changes a machine at a time: vm.ts runs itself again under the instance's lock (install takes both).
export PATH="$HOME/.bun/bin:$PATH"
exec bun "$(dirname "$0")/vm.ts" install "$@"

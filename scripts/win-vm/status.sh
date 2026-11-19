#!/usr/bin/env bash
# The Windows rig: `status`. See scripts/win-vm/vm.ts and docs/agents/windows-vm.md.
export PATH="$HOME/.bun/bin:$PATH"
exec bun "$(dirname "$0")/vm.ts" status "$@"

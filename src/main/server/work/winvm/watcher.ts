import { spawn } from 'node:child_process'
import { chmodSync, closeSync, openSync, writeFileSync } from 'node:fs'
import { daemonEnv } from './machine/config'
import { shq } from './machine/daemons'

/**
 * The stop watcher (docs/agents/work-winvm.md "The stop"). A stop of the box's
 * service signals its whole cgroup at once, and on the box the server's main
 * process can die at that moment, so the server cannot hibernate the guest
 * then. QEMU and swtpm start with the stop signals blocked (daemons.ts
 * `stopBlocked`) and keep running; this script, started beside them with the
 * same clean environment, takes the signal instead and asks Windows to
 * hibernate over SSH as the admin, inside the stop's 30 seconds (hibernating
 * takes about 5 s). It then waits for QEMU to exit and keeps the TPM's live
 * state in the machine's lasting copy, since /tmp does not outlive a reboot.
 *
 * When QEMU exits on its own (the keeper's hibernate, a guest shutdown), the
 * watcher exits too and the keeper keeps the TPM.
 */
export interface WatcherSpec {
  qemuPid: number
  /** QEMU's /proc comm, so a pid that came round again is not taken for it */
  qemuComm: string
  ssh: { key: string; port: number; knownHosts: string; user: string }
  tpmPidFile: string
  tpmState: string
  /** the lasting copy of the TPM's state the watcher writes after the stop */
  runTpm: string
  /** how long it waits for QEMU to exit after the hibernate was asked, inside the stop's 30 s */
  waitSec?: number
  /**
   * The X server QEMU's window is on (window.ts), started with the stop signals blocked as QEMU is: ended with
   * SIGKILL once QEMU has gone, by its pid when it watched began and only while that pid is still the server
   * started on `config`, so a display started for the next run is never touched.
   */
  display?: { pid: number; config: string }
}

export const HIBERNATE_COMMAND = 'shutdown /h'

export function watcherScript(w: WatcherSpec): string {
  const ssh = [
    'ssh', '-i', w.ssh.key, '-p', String(w.ssh.port),
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${w.ssh.knownHosts}`,
    `${w.ssh.user}@127.0.0.1`, HIBERNATE_COMMAND
  ].map(shq).join(' ')
  const ticks = Math.round((w.waitSec ?? 25) * 4)
  return `#!/bin/bash
# The Windows VM's stop watcher (src/main/server/work/winvm/watcher.ts). Written and started by the keeper.
set -u
QEMU=${w.qemuPid}
alive() { [ "$(cat /proc/$QEMU/comm 2>/dev/null)" = ${shq(w.qemuComm)} ]; }
say() { echo "$(date -u +%FT%TZ) $*"; }
tpm_alive() { local p; p=$(cat ${shq(w.tpmPidFile)} 2>/dev/null) && [ -n "$p" ] && grep -qF ${shq(w.tpmState)} /proc/$p/cmdline 2>/dev/null; }
keep_tpm() {
  for _ in $(seq 1 40); do tpm_alive || break; sleep 0.25; done
  [ -d ${shq(w.tpmState)} ] || return 0
  rm -rf ${shq(`${w.runTpm}.new`)} && cp -a ${shq(w.tpmState)} ${shq(`${w.runTpm}.new`)} && rm -rf ${shq(w.runTpm)} && mv ${shq(`${w.runTpm}.new`)} ${shq(w.runTpm)} && say "kept the TPM state"
}
end_display() {
${w.display ? `  grep -qF ${shq(w.display.config)} /proc/${w.display.pid}/cmdline 2>/dev/null && kill -KILL ${w.display.pid} 2>/dev/null && say "ended the window's display"` : '  :'}
  return 0
}
on_stop() {
  trap '' TERM INT HUP
  say "stop signal: asking Windows to hibernate"
  ${ssh} </dev/null >/dev/null 2>&1
  for _ in $(seq 1 ${ticks}); do alive || break; sleep 0.25; done
  if alive; then say "QEMU still runs; the stop will cut its power"; exit 1; fi
  say "QEMU exited: the guest hibernated"
  end_display
  keep_tpm
  exit 0
}
trap on_stop TERM INT HUP
say "watching QEMU $QEMU"
while alive; do sleep 1 & wait $!; done
say "QEMU exited on its own"
end_display
exit 0
`
}

/** Writes the script beside the machine's run files and starts it detached, with the clean environment; its pid. */
export function startWatcher(file: string, log: string, w: WatcherSpec, env: NodeJS.ProcessEnv = daemonEnv()): number | undefined {
  writeFileSync(file, watcherScript(w))
  chmodSync(file, 0o755)
  const out = openSync(log, 'a')
  try {
    const child = spawn('/bin/bash', [file], { env, detached: true, stdio: ['ignore', out, out] })
    child.unref()
    return child.pid
  } finally {
    closeSync(out)
  }
}

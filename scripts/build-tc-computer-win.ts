/**
 * Builds tc-computer.exe, the Windows computer-use service (native/tc-computer-win,
 * docs/computer-protocol.md §29), for x64 with the MSVC target through cargo-xwin, on
 * any host that has them (the box: ~/.cargo/bin, the SDK cached under ~/.cache/cargo-xwin).
 * The Windows pack takes it from target/x86_64-pc-windows-msvc/release
 * (build/electron-builder.win.yml). Exits with cargo's code.
 *
 *   bun scripts/build-tc-computer-win.ts
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const WIN_TARGET = 'x86_64-pc-windows-msvc'
export const crate = resolve(import.meta.dirname, '..', 'native', 'tc-computer-win')
export const builtExe = join(crate, 'target', WIN_TARGET, 'release', 'tc-computer.exe')

/** The command, so a test can read it without running cargo. */
export function buildCommand(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const path = [join(homedir(), '.cargo', 'bin'), process.env.PATH ?? ''].join(':')
  return { cmd: 'cargo', args: ['xwin', 'build', '--release', '--target', WIN_TARGET], env: { ...process.env, PATH: path } }
}

if (import.meta.main) {
  const { cmd, args, env } = buildCommand()
  const r = spawnSync(cmd, args, { cwd: crate, env, stdio: 'inherit' })
  if (r.status === 0) console.log(builtExe)
  process.exit(r.status ?? 1)
}

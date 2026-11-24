/**
 * Builds tc-computer.exe, the Windows computer-use service (native/tc-computer-win,
 * docs/computer-protocol.md §29), for x64 with the MSVC target through cargo-xwin, on
 * any host that has them (the box: ~/.cargo/bin, the SDK cached under ~/.cache/cargo-xwin).
 * The Windows pack takes it from target/x86_64-pc-windows-msvc/release
 * (build/electron-builder.win.yml). With `--into DIR` the exe is also copied into DIR: the
 * box's deploy build puts it in its own resources/native, where the Windows VM's keeper finds
 * it (src/main/server/work/winvm/serviceBin.ts). Exits with cargo's code.
 *
 *   bun scripts/build-tc-computer-win.ts [--into DIR]
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

export const WIN_TARGET = 'x86_64-pc-windows-msvc'
export const crate = resolve(import.meta.dirname, '..', 'native', 'tc-computer-win')
export const builtExe = join(crate, 'target', WIN_TARGET, 'release', 'tc-computer.exe')

/**
 * The command, so a test can read it without running cargo. XWIN_ACCEPT_LICENSE: cargo-xwin's first
 * run downloads Microsoft's CRT and SDK and asks to accept their license; the owner accepted it
 * (2026-11-23), and a publish has no one to answer the question.
 */
export function buildCommand(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const path = [join(homedir(), '.cargo', 'bin'), process.env.PATH ?? ''].join(delimiter)
  return { cmd: 'cargo', args: ['xwin', 'build', '--release', '--target', WIN_TARGET], env: { ...process.env, PATH: path, XWIN_ACCEPT_LICENSE: '1' } }
}

/** Copies the exe into `dir` under its own name, whole or not at all (a copy beside it, then a rename). */
export function place(exe: string, dir: string): string {
  mkdirSync(dir, { recursive: true })
  const to = join(dir, 'tc-computer.exe')
  copyFileSync(exe, `${to}.part`)
  renameSync(`${to}.part`, to)
  return to
}

if (import.meta.main) {
  const at = process.argv.indexOf('--into')
  const into = at >= 0 ? process.argv[at + 1] : undefined
  if (at >= 0 && !into) {
    console.error('usage: bun scripts/build-tc-computer-win.ts [--into DIR]')
    process.exit(64)
  }
  const { cmd, args, env } = buildCommand()
  const r = spawnSync(cmd, args, { cwd: crate, env, stdio: 'inherit' })
  if (r.status === 0) console.log(into ? place(builtExe, resolve(into)) : builtExe)
  process.exit(r.status ?? 1)
}

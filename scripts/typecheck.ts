#!/usr/bin/env bun
/**
 * `bun run typecheck`: tsc for the main process and for the renderer at
 * once, then nothing else to wait for but the two Swift checks, which run
 * beside them. Each tsc is incremental, its build info kept per checkout in
 * <git-dir>/temp-code-tsc (node_modules/.cache/temp-code-tsc outside git), so
 * a second run reads only the files that changed: on the box the two ran
 * 128 s and 74 s cold one after the other, and 12 s each with nothing
 * changed (docs/release-gate.md "Measured times"). Each command's output is
 * printed whole, in list order, once all have ended.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** The four commands, run at once. */
export function typecheckCommands(infoDir: string): string[][] {
  const tsc = (project: string, name: string): string[] => [
    'bunx',
    'tsc',
    '--noEmit',
    '-p',
    project,
    '--composite',
    'false',
    '--incremental',
    '--tsBuildInfoFile',
    join(infoDir, `${name}.tsbuildinfo`)
  ]
  return [
    tsc('tsconfig.node.json', 'node'),
    tsc('tsconfig.web.json', 'web'),
    ['bun', 'scripts/gen-swift-contract.ts', '--check'],
    ['bun', 'scripts/gen-swift-computer.ts', '--check']
  ]
}

/** Where the build info lives: the checkout's own git dir, so worktrees sharing one node_modules never share it. */
export function infoDirOf(gitDir: string | null, cwd: string): string {
  return gitDir ? join(gitDir, 'temp-code-tsc') : join(cwd, 'node_modules', '.cache', 'temp-code-tsc')
}

function run(cmd: string[]): Promise<{ cmd: string[]; code: number; out: string }> {
  return new Promise((done) => {
    let out = ''
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (err) => done({ cmd, code: 1, out: out + String(err) }))
    child.on('close', (code) => done({ cmd, code: code ?? 1, out }))
  })
}

if (import.meta.main) {
  const git = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' })
  const infoDir = infoDirOf(git.status === 0 ? git.stdout.trim() : null, process.cwd())
  mkdirSync(infoDir, { recursive: true })
  const results = await Promise.all(typecheckCommands(infoDir).map(run))
  for (const r of results) {
    if (r.out.trim()) process.stdout.write(`$ ${r.cmd.join(' ')}\n${r.out}${r.out.endsWith('\n') ? '' : '\n'}`)
  }
  const failed = results.filter((r) => r.code !== 0)
  for (const r of failed) console.error(`✗ ${r.cmd.slice(0, 5).join(' ')} exited ${r.code}`)
  process.exit(failed.length ? 1 : 0)
}

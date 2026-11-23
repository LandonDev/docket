/**
 * Pack this checkout's built `out/` as a code-only update and tell the host
 * that runs here (docs/agents/code-only-updates.md):
 *
 *   bun scripts/code-pack.ts --commit <sha> --release <N> [--subject <s>] [--to <dir>] [--announce] [--trust-out]
 *
 * release.ts runs it right after it tags release-N, with the commit the gate
 * built: no second build. The pack lands in `<to>/<commit>/` (default
 * dist/code-update). `--announce` says so to the headless host on this
 * machine through tc-local (`code.announce`), which offers it to every
 * linked Mac at once; with no host running here it says so, packs nothing
 * and exits 0. The times of the pack and the announce are printed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { packCode } from './lib/codePack'

const args = process.argv.slice(2)
const value = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const root = resolve(import.meta.dirname, '..')
const commit = value('--commit')
const release = Number(value('--release'))
if (!commit || !release) {
  console.error('usage: bun scripts/code-pack.ts --commit <sha> --release <N> [--subject <s>] [--to <dir>] [--announce] [--trust-out]')
  process.exit(2)
}
const subject = value('--subject') ?? execFileSync('git', ['-C', root, 'log', '-1', '--format=%s', commit], { encoding: 'utf8' }).trim()

// With no host on this machine to offer it (a Mac's own release train) there is nothing to pack for.
const userData = process.env.TEMP_CODE_USER_DATA || '/srv/agents/temp-code-data'
const announce = args.includes('--announce')
if (announce && !existsSync(join(userData, 'server.json'))) {
  console.log(`code-only update: no host runs here (${userData}); not packed`)
  process.exit(0)
}

const started = Date.now()
let packed: ReturnType<typeof packCode>
try {
  packed = packCode({ root, commit, release, subject, to: resolve(value('--to') ?? join(root, 'dist', 'code-update')), trustOut: args.includes('--trust-out') })
} catch (err) {
  console.log(`code-only update: not packed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(3)
}
const { dir, manifest } = packed
console.log(`code-only update: packed ${commit.slice(0, 7)} as 1.0.${release} (${manifest.tar.bytes} bytes, ${manifest.tar.sha256.slice(0, 12)}) in ${Date.now() - started} ms: ${dir}`)

if (announce) {
  const at = Date.now()
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'box', 'tc-local.mjs'), 'code.announce', JSON.stringify({ dir })], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 })
    console.log(`code-only update: offered to the linked Macs in ${Date.now() - at} ms`)
  } catch {
    console.log('code-only update: packed, not announced (the host here did not take code.announce)')
    process.exit(4)
  }
}

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appRoot } from './appRoot'

/**
 * The app's root from wherever the bundle put the code: out/main/index.js or a
 * lazy chunk, out/main/chunks/*.js. A lookup counted up from `__dirname` found
 * out/ from a chunk, and the box's Windows VM said its build had no
 * tc-computer.exe while resources/native held one (1.0.356).
 */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
/** A build's folder as the box's deploy lays it out: package.json, out/main/chunks, resources/native/tc-computer.exe. */
function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'tc-approot-'))
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), '{"name":"temp-code"}')
  mkdirSync(join(root, 'out', 'main', 'chunks'), { recursive: true })
  mkdirSync(join(root, 'resources', 'native'), { recursive: true })
  writeFileSync(join(root, 'resources', 'native', 'tc-computer.exe'), 'MZ')
  return root
}

describe('appRoot', () => {
  it('is the folder holding package.json, from out/main and from a chunk under it alike', () => {
    const root = build()
    expect(appRoot(join(root, 'out', 'main'))).toBe(root)
    expect(appRoot(join(root, 'out', 'main', 'chunks'))).toBe(root)
  })

  it('falls back to two up from where it started when nothing above holds a package.json', () => {
    expect(appRoot('/a/b/c', () => false)).toBe(resolve('/a/b/c', '..', '..'))
  })

  it('finds the VM service and the computer service from code bundled into a chunk, by its real __dirname', () => {
    const root = build()
    const chunk = join(root, 'out', 'main', 'chunks', 'vm-test.js')
    // the lookups bundled as the app's main build bundles them: CommonJS, node's own modules external
    const entry = join(root, 'entry.ts')
    writeFileSync(
      entry,
      `import { tcComputerExe } from ${JSON.stringify(resolve(__dirname, 'work/winvm/serviceBin.ts'))}\n` +
        `import { computerBinaryPath } from ${JSON.stringify(resolve(__dirname, 'computer/binary.ts'))}\n` +
        `console.log(JSON.stringify({ vm: tcComputerExe({ env: {} }), mac: computerBinaryPath({}, 'win32') }))\n`
    )
    execFileSync(resolve(__dirname, '../../../node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=cjs', `--alias:@shared=${resolve(__dirname, '../../shared')}`, '--external:electron', `--outfile=${chunk}`])
    const found = JSON.parse(execFileSync('node', [chunk], { encoding: 'utf8' })) as { vm: string | null; mac: string }
    expect(found.vm).toBe(join(root, 'resources', 'native', 'tc-computer.exe'))
    expect(found.mac).toBe(join(root, 'resources', 'native', 'tc-computer.exe'))
  })
})

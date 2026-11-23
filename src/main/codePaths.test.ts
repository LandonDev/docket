import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A code-only update runs `out/` from a folder under userData, with the
 * bundle's other entries linked beside it (codeChoice.ts `mirrorBundle`).
 * Three rules keep every path right there, and this file holds the main
 * process to them (docs/agents/code-only-updates.md "Paths").
 */
const MAIN = resolve(__dirname)

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

const files = sources(MAIN).map((path) => ({ name: relative(MAIN, path), text: readFileSync(path, 'utf8') }))

describe('paths under a code-only update', () => {
  it('app.getAppPath() is the bundle: only boot.ts and the harness block read it', () => {
    const users = files.filter((f) => /\bgetAppPath\(/.test(f.text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))).map((f) => f.name)
    expect(users.sort()).toEqual(['boot.ts', 'index.ts'])
    const index = files.find((f) => f.name === 'index.ts')!.text
    const lines = index.split('\n').filter((line) => /\bgetAppPath\(/.test(line) && !/^\s*(\/\/|\*)/.test(line))
    expect(lines.map((l) => l.trim())).toEqual(['applyHarness(process.env, bakedHarness(app.getAppPath()))'])
  })

  it('nothing but boot.ts loads the boot code: the rest of the app imports its types alone', () => {
    const loaders = files.filter((f) => /^import (?!type\b)[^\n]*from '(\.\.?\/)+codeChoice'/m.test(f.text)).map((f) => f.name)
    expect(loaders).toEqual(['boot.ts'])
  })

  it('every relaunch names its arguments from process.argv: with none, Electron copies a command line that may hold --tempcode-bundle-code', () => {
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const calls = files.flatMap((f) => [...code(f.text).matchAll(/app\.relaunch\((.{0,60})/g)].map((m) => ({ file: f.name, after: m[1] })))
    expect(calls.map((c) => c.file).sort()).toEqual(['boot.ts', 'update.ts', 'update.ts'])
    for (const call of calls) expect(call.after, `${call.file}: app.relaunch(${call.after}`).toMatch(/^\{ args: \[?(\.\.\.)?process\.argv\.slice\(1\)/)
  })

  it('no file counts up from __dirname to resources/: appRoot() finds it through the mirror', () => {
    const counted = files.filter((f) => /__dirname[^\n]*resources/.test(f.text)).map((f) => f.name)
    expect(counted).toEqual([])
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { place } from '../../../../../scripts/build-tc-computer-win'
import { tcComputerExe } from './serviceBin'

const dirs: string[] = []
const root = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tc-servicebin-'))
  dirs.push(d)
  return d
}
const touch = (path: string): string => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'MZ')
  return path
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('tcComputerExe', () => {
  it('is null when the build has no exe', () => {
    expect(tcComputerExe({ root: root(), env: {} })).toBeNull()
  })

  it('finds the exe the box build placed, before a cargo output', () => {
    const r = root()
    const cargo = touch(join(r, 'native/tc-computer-win/target/x86_64-pc-windows-msvc/release/tc-computer.exe'))
    expect(tcComputerExe({ root: r, env: {} })).toBe(cargo)
    const placed = touch(join(r, 'resources/native/tc-computer.exe'))
    expect(tcComputerExe({ root: r, env: {} })).toBe(placed)
  })

  it('takes TEMP_CODE_WINVM_EXE when it names a file, and nothing else then', () => {
    const r = root()
    touch(join(r, 'resources/native/tc-computer.exe'))
    const given = touch(join(r, 'proof/tc-computer.exe'))
    expect(tcComputerExe({ root: r, env: { TEMP_CODE_WINVM_EXE: given } })).toBe(given)
    expect(tcComputerExe({ root: r, env: { TEMP_CODE_WINVM_EXE: join(r, 'gone.exe') } })).toBeNull()
  })

  it('finds what build-tc-computer-win --into placed', () => {
    const r = root()
    const built = touch(join(r, 'built/tc-computer.exe'))
    const at = place(built, join(r, 'resources/native'))
    expect(at).toBe(join(r, 'resources/native/tc-computer.exe'))
    expect(tcComputerExe({ root: r, env: {} })).toBe(at)
  })
})

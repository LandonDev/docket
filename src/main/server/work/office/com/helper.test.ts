import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cscArgs, defaultCsc, ensureHelper, helperExe } from './helper'
import { TC_OFFICE_CS } from './source'

const ROOT = join(__dirname, '../../../../../..')

describe('tc-office.exe, compiled on the host', () => {
  it('carries native/tc-office-win/TcOffice.cs as it is (run bun scripts/gen-tc-office-source.ts after editing it)', () => {
    expect(TC_OFFICE_CS).toBe(readFileSync(join(ROOT, 'native/tc-office-win/TcOffice.cs'), 'utf8'))
    execFileSync(process.execPath.includes('bun') ? process.execPath : 'bun', [join(ROOT, 'scripts/gen-tc-office-source.ts'), '--check'], { stdio: 'pipe' })
  })

  it('never ships the recorded COM surface or PowerShell in the helper it builds', () => {
    expect(TC_OFFICE_CS).not.toMatch(/class RecordedCom|powershell/i)
    expect(TC_OFFICE_CS).toContain('#if RECORDED')
  })

  it("is named by its source's hash in the temp dir, and built by Windows' own csc with the framework's references", () => {
    expect(helperExe('/t')).toMatch(/^\/t\/tempcode-office-[0-9a-f]{12}\.exe$/)
    expect(defaultCsc({ SystemRoot: 'D:\\Win' })).toBe(join('D:\\Win', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'))
    expect(cscArgs('o.exe', 's.cs')).toEqual(['/nologo', '/optimize', '/target:exe', '/r:System.Core.dll', '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', '/out:o.exe', 's.cs'])
  })

  it('compiles once, uses an exe that is there, and takes the one another instance finished first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-office-'))
    const exe = join(dir, 'h.exe')
    const compile = vi.fn(async (_csc: string, source: string, out: string) => writeFileSync(out, source.slice(0, 10)))
    await expect(ensureHelper({ exe, compile, csc: 'csc' })).resolves.toBe(exe)
    await ensureHelper({ exe, compile, csc: 'csc' })
    expect(compile).toHaveBeenCalledTimes(1)
    expect(readFileSync(exe, 'utf8')).toBe(TC_OFFICE_CS.slice(0, 10))

    const other = join(dir, 'other.exe')
    let made = false
    const raced = vi.fn(async () => {
      writeFileSync(other, 'theirs')
      made = true
      throw new Error('in use')
    })
    await expect(ensureHelper({ exe: other, compile: raced, exists: (p) => made && p === other })).resolves.toBe(other)
    await expect(ensureHelper({ exe: join(dir, 'none.exe'), compile: () => Promise.reject(new Error('csc: missing')) })).rejects.toThrow('csc: missing')
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatsRows, toolsSeen } from './health'
import { statePath } from './tools'

/** Connections' toolchain rows: what Settings' toolchain row said, plus a row for each tool that did not install. */
describe('the conversion tools', () => {
  it('lists the tools installed here by name and release, the venv and tools not offered here left out', () => {
    const rows = formatsRows([
      { name: 'libreoffice', version: '26.8.3', usable: true },
      { name: 'python', version: '3.12.16', usable: true },
      { name: 'venv', version: '3.12.16', usable: true },
      { name: 'ffmpeg', version: '9.0.2', usable: true },
      { name: 'ironcalc', version: '0.9.1', usable: true },
      { name: 'screen-relay', version: '1.4.0', usable: false, error: 'not offered on darwin-arm64' }
    ])
    expect(rows).toEqual([{ id: 'formats.toolchain', pillar: 'formats', group: 'Tools', title: 'Conversion tools', state: 'working', line: 'LibreOffice 26.8, Python 3.12, ffmpeg 9.0 and IronCalc 0.9' }])
  })

  it("counts the pillars' tools past a few, so the line stays one line", () => {
    const pillar = ['docling', 'onlyoffice', 'pdf-tools', 'python-pptx', 'screen-relay'].map((name) => ({ name, version: '1.0.0', usable: true }))
    const [row] = formatsRows([{ name: 'ffmpeg', version: '9.0.2', usable: true }, ...pillar, { name: 'libreoffice', version: '26.8.3', usable: true }])
    expect(row!.line).toBe('LibreOffice 26.8, ffmpeg 9.0 and 5 more')
    expect(formatsRows(pillar.slice(0, 2))[0]!.line).toBe('docling 1.0 and onlyoffice 1.0')
  })

  it('names each tool that failed, why, and the command that installs it again', () => {
    const rows = formatsRows([
      { name: 'libreoffice', version: '26.8.3', usable: true },
      { name: 'ffmpeg', version: '9.0.2', usable: false, error: 'the download did not match its sha256.' },
      { name: 'screen-relay', version: '1.4.0', usable: false }
    ])
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['formats.toolchain', 'working'],
      ['formats.tool:ffmpeg', 'broken'],
      ['formats.tool:screen-relay', 'broken']
    ])
    expect(rows[1]).toMatchObject({ title: 'ffmpeg', line: 'The download did not match its sha256. Install it again with bun scripts/work-tools/install.ts --only ffmpeg' })
    expect(rows[2]).toMatchObject({ title: 'Screen relay', line: expect.stringMatching(/^Its files are missing\. .*--only screen-relay$/) })
    expect(rows.every((r) => !r.fix)).toBe(true)
  })

  it('asks him to install when the installer never ran, and is broken when nothing it tried installed', () => {
    expect(formatsRows([])).toEqual([expect.objectContaining({ state: 'needs-you', line: expect.stringContaining('bun scripts/work-tools/install.ts') })])
    expect(formatsRows([{ name: 'python', version: '3.12.16', usable: false, error: 'probe failed' }])[0]).toMatchObject({ state: 'broken', line: 'None installed' })
  })
})

describe("the host's state file", () => {
  let dir: string
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'formats-health-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('counts a tool usable only while its program is on disk', () => {
    mkdirSync(join(dir, 'work-tools', 'ffmpeg', '9.0.2'), { recursive: true })
    writeFileSync(join(dir, 'work-tools', 'ffmpeg', '9.0.2', 'ffmpeg'), '')
    const tool = (name: string, bin: string) => ({ name, pillar: 'toolchain', version: '9.0.2', licence: 'x', licenceNote: 'x', ok: true, dir: `${name}/9.0.2`, bin, at: 1 })
    writeFileSync(statePath(dir), JSON.stringify({ platform: 'linux-x64', at: 1, tools: { ffmpeg: tool('ffmpeg', 'ffmpeg'), ironcalc: tool('ironcalc', 'gone.node') } }))
    expect(toolsSeen(dir)).toEqual([
      { name: 'ffmpeg', version: '9.0.2', usable: true },
      { name: 'ironcalc', version: '9.0.2', usable: false }
    ])
  })
})

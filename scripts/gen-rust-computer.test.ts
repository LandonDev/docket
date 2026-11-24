import { describe, expect, it } from 'vitest'
import { COMPUTER_METHODS, COMPUTER_ERROR_KINDS } from '../src/shared/computer/protocol'
import { emitWire, staleFiles } from './gen-rust-computer'

describe('gen-rust-computer', () => {
  it('the committed Rust wire types are what the zod makes now', () => {
    expect(staleFiles()).toEqual([])
  })

  it('every method has its params and result, and every error kind its variant', () => {
    const wire = emitWire()
    for (const m of Object.keys(COMPUTER_METHODS)) expect(wire).toContain(`"${m}"`)
    for (const k of COMPUTER_ERROR_KINDS) expect(wire).toContain(`#[serde(rename = "${k}")]`)
    expect(wire).toContain('pub type StateGetResult = super::Observation;')
    expect(wire).toContain('#[serde(tag = "status")]\npub enum StepResult {')
  })

  it('an optional field is left out when unset and a required nullable one is written as null', () => {
    const wire = emitWire()
    const app = wire.slice(wire.indexOf('pub struct AppInfo {'), wire.indexOf('}', wire.indexOf('pub struct AppInfo {')))
    expect(app).toMatch(/#\[serde\(rename = "bundleId", default\)\]\n {4}pub bundle_id: Option<String>,/)
    expect(app).toMatch(/#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\n {4}pub windows: Option<Vec<WindowInfo>>,/)
  })
})

describe('build-tc-computer-win', () => {
  it('cross-builds the release exe for x64 MSVC with cargo-xwin, where the Windows pack takes it from', async () => {
    const { buildCommand, builtExe } = await import('./build-tc-computer-win')
    expect(buildCommand().args).toEqual(['xwin', 'build', '--release', '--target', 'x86_64-pc-windows-msvc'])
    expect(buildCommand().env.XWIN_ACCEPT_LICENSE).toBe('1')
    expect(builtExe).toMatch(/native\/tc-computer-win\/target\/x86_64-pc-windows-msvc\/release\/tc-computer\.exe$/)
    const { readFileSync } = await import('node:fs')
    const yml = readFileSync(new URL('../build/electron-builder.win.yml', import.meta.url), 'utf8')
    expect(yml).toContain('from: native/tc-computer-win/target/x86_64-pc-windows-msvc/release\n    to: resources/native\n    filter: [tc-computer.exe]')
  })
})

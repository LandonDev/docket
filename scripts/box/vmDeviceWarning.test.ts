import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * box-update's deploy check for live resize (box-update-lib.sh `vm_device_warning`): a build that does not read
 * run/machine.json, deployed while the Windows VM runs on virtio-gpu, is named in the deploy log.
 */
const lib = join(import.meta.dirname, 'box-update-lib.sh')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function check(o: { device: 'vga' | 'virtio' | null; reads: boolean }): { code: number | null; err: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tc-vm-device-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'build', 'out', 'main', 'chunks'), { recursive: true })
  writeFileSync(join(dir, 'build', 'out', 'main', 'chunks', 'winvm.js'), o.reads ? 'const machineFile = (run) => join(run, "machine.json")' : 'const args = ["-vga", "std"]')
  if (o.device) writeFileSync(join(dir, 'machine.json'), JSON.stringify({ device: o.device }) + '\n')
  const r = spawnSync('bash', ['-c', `set -Eeuo pipefail; source "$0"; vm_device_warning "$1" "$2"`, lib, join(dir, 'build'), join(dir, 'machine.json')], { encoding: 'utf8', timeout: 20_000 })
  return { code: r.status, err: r.stderr }
}

describe('box-update vm_device_warning', () => {
  it('warns when machine.json says virtio and the build does not read it, and never fails the deploy', () => {
    const r = check({ device: 'virtio', reads: false })
    expect(r.code).toBe(0)
    expect(r.err).toContain('WARN: the Windows VM runs with live resize, and this build does not read its run/machine.json')
    expect(r.err).toContain('Turn off live resize first')
  })

  it('is silent for a build that reads it, a machine on std VGA, and one with no file', () => {
    for (const o of [{ device: 'virtio', reads: true }, { device: 'vga', reads: false }, { device: null, reads: false }] as const) expect(check(o)).toEqual({ code: 0, err: '' })
  })

  it('runs in box-update once the candidate is built, before its trial', () => {
    const script = readFileSync(join(import.meta.dirname, 'box-update.sh'), 'utf8')
    const at = script.indexOf('lib_as_agents vm_device_warning "$candidate" || true')
    expect(at).toBeGreaterThan(script.indexOf('no out/main/boot.js'))
    expect(at).toBeLessThan(script.indexOf('TRIAL:'))
  })
})

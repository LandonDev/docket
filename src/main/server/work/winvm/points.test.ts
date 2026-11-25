import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QcowPoints } from './points'
import { readGuestScreen, readMachineDevice, writeGuestScreen, writeMachineDevice } from './guestScreen'

/**
 * The restore points over a real qcow2 overlay on a backing image (qemu-img
 * and qemu-io, as on the box): the disk's snapshot with the firmware
 * variables and the TPM's state beside it, put back whole.
 */

let dir: string
let f: { disk: string; vars: string; tpm: string; dir: string; run: string }
const write = (byte: string) => execFileSync('qemu-io', ['-c', `write -P ${byte} 0 4k`, f.disk], { stdio: 'pipe' })
const holds = (byte: string) => {
  try {
    execFileSync('qemu-io', ['-c', `read -P ${byte} 0 4k`, f.disk], { stdio: 'pipe' })
    return !/Pattern verification failed/.test(execFileSync('qemu-io', ['-c', `read -P ${byte} 0 4k`, f.disk], { encoding: 'utf8' }))
  } catch {
    return false
  }
}
const snapshots = () => execFileSync('qemu-img', ['snapshot', '-l', f.disk], { encoding: 'utf8' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'winvm-points-'))
  const base = join(dir, 'base.qcow2')
  execFileSync('qemu-img', ['create', '-q', '-f', 'qcow2', base, '16M'])
  f = { disk: join(dir, 'disk.qcow2'), vars: join(dir, 'OVMF_VARS.fd'), tpm: join(dir, 'tpm'), dir: join(dir, 'points'), run: join(dir, 'run') }
  execFileSync('qemu-img', ['create', '-q', '-f', 'qcow2', '-b', base, '-F', 'qcow2', f.disk])
  writeFileSync(f.vars, 'vars before')
  mkdirSync(f.tpm)
  writeFileSync(join(f.tpm, 'tpm2-00.permall'), 'tpm before')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('restore points on a qcow2 overlay', () => {
  it('goes back to a point: the disk, the firmware variables and the TPM as they were', async () => {
    const points = new QcowPoints(f)
    write('0x41')
    await points.save({ id: 'aaaaaa1', name: 'Clean', at: 1, by: 'owner' })
    expect(snapshots()).toContain('tc-point-aaaaaa1')
    write('0x42')
    writeFileSync(f.vars, 'vars after')
    writeFileSync(join(f.tpm, 'tpm2-00.permall'), 'tpm after')
    expect(holds('0x42')).toBe(true)
    await points.restore('aaaaaa1')
    expect(holds('0x41')).toBe(true)
    expect(readFileSync(f.vars, 'utf8')).toBe('vars before')
    expect(readFileSync(join(f.tpm, 'tpm2-00.permall'), 'utf8')).toBe('tpm before')
  })

  it('lists newest first, and a delete drops the snapshot and its folder', async () => {
    const points = new QcowPoints(f)
    await points.save({ id: 'aaaaaa1', name: 'one', at: 1, by: 'owner' })
    await points.save({ id: 'bbbbbb2', name: 'two', at: 2, by: 'keeper' })
    expect(points.list().map((p) => p.name)).toEqual(['two', 'one'])
    await points.remove('aaaaaa1')
    expect(points.list().map((p) => p.name)).toEqual(['two'])
    expect(snapshots()).not.toContain('tc-point-aaaaaa1')
    expect(existsSync(join(f.dir, 'aaaaaa1'))).toBe(false)
  })

  it('records the device and size the run had, and a vga point restored on a virtio run writes vga back', async () => {
    const points = new QcowPoints(f)
    // a run from before live resize: no machine.json, no screen.json
    await points.save({ id: 'aaaaaa1', name: 'Before', at: 1, by: 'owner' })
    expect(points.list()[0]).toMatchObject({ device: 'vga', screen: { width: 1280, height: 800 } })
    writeMachineDevice(f.run, 'virtio')
    writeGuestScreen(f.run, { width: 3456, height: 2234 })
    await points.restore('aaaaaa1')
    expect(readMachineDevice(f.run)).toBe('vga')
    expect(readGuestScreen(f.run)).toEqual({ width: 1280, height: 800 })
  })

  it('a virtio point restored after a downgrade writes virtio back, at its size', async () => {
    const points = new QcowPoints(f)
    writeMachineDevice(f.run, 'virtio')
    writeGuestScreen(f.run, { width: 2560, height: 1600 })
    await points.save({ id: 'bbbbbb2', name: 'On virtio', at: 2, by: 'owner' })
    // Turn off: std VGA at 1280×800
    writeMachineDevice(f.run, 'vga')
    writeGuestScreen(f.run, { width: 1280, height: 800 })
    await points.restore('bbbbbb2')
    expect(readMachineDevice(f.run)).toBe('virtio')
    expect(readGuestScreen(f.run)).toEqual({ width: 2560, height: 1600 })
  })

  it('a point saved before live resize, with neither, restores as std VGA at 1280×800', async () => {
    const points = new QcowPoints(f)
    await points.save({ id: 'cccccc3', name: 'Old', at: 3, by: 'owner' })
    // what a point.json of the older code holds
    writeFileSync(join(f.dir, 'cccccc3', 'point.json'), JSON.stringify({ id: 'cccccc3', name: 'Old', at: 3, by: 'owner' }) + '\n')
    writeMachineDevice(f.run, 'virtio')
    await points.restore('cccccc3')
    expect(readMachineDevice(f.run)).toBe('vga')
    expect(readGuestScreen(f.run)).toEqual({ width: 1280, height: 800 })
  })

  it('takes only its own ids, never a path', async () => {
    const points = new QcowPoints(f)
    await expect(points.restore('../run')).rejects.toThrow('no restore point')
    await expect(points.remove('a/b')).rejects.toThrow('no restore point')
  })
})

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QcowPoints } from './points'

/**
 * The restore points over a real qcow2 overlay on a backing image (qemu-img
 * and qemu-io, as on the box): the disk's snapshot with the firmware
 * variables and the TPM's state beside it, put back whole.
 */

let dir: string
let f: { disk: string; vars: string; tpm: string; dir: string }
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
  f = { disk: join(dir, 'disk.qcow2'), vars: join(dir, 'OVMF_VARS.fd'), tpm: join(dir, 'tpm'), dir: join(dir, 'points') }
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

  it('takes only its own ids, never a path', async () => {
    const points = new QcowPoints(f)
    await expect(points.restore('../run')).rejects.toThrow('no restore point')
    await expect(points.remove('a/b')).rejects.toThrow('no restore point')
  })
})

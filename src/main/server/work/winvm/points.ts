import { execFile } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WinvmPoint } from '@shared/contract-work-winvm'
import { daemonEnv } from './machine/config'

const run = promisify(execFile)

/**
 * Restore points of the standing machine (docs/agents/work-winvm.md "Restore
 * points"), taken only while it is stopped: an internal qcow2 snapshot of
 * its disk (copy on write inside the one file, so a point costs only what
 * changes after it), with the firmware variables and the TPM's state copied
 * beside it. A point holds all three, since a disk without the TPM it was
 * sealed with breaks TPM-bound sign-ins, and a hibernated guest's image is
 * on the disk.
 */
export interface PointStore {
  list(): WinvmPoint[]
  save(point: WinvmPoint): Promise<void>
  restore(id: string): Promise<void>
  remove(id: string): Promise<void>
}

export interface PointFiles {
  disk: string
  vars: string
  tpm: string
  /** the folder the points' files live in: one folder per point */
  dir: string
}

const snapshotOf = (id: string) => `tc-point-${id}`
export const isPointId = (id: string) => /^[a-z0-9]{6,32}$/.test(id)

export class QcowPoints implements PointStore {
  constructor(private readonly f: PointFiles) {}

  private folder(id: string): string {
    if (!isPointId(id)) throw new Error(`no restore point ${JSON.stringify(id)}`)
    return join(this.f.dir, id)
  }

  list(): WinvmPoint[] {
    if (!existsSync(this.f.dir)) return []
    const out: WinvmPoint[] = []
    for (const id of readdirSync(this.f.dir)) {
      const meta = join(this.f.dir, id, 'point.json')
      if (!isPointId(id) || !existsSync(meta)) continue
      try {
        out.push(JSON.parse(readFileSync(meta, 'utf8')) as WinvmPoint)
      } catch {
        // a point whose record cannot be read is not offered
      }
    }
    return out.sort((a, b) => b.at - a.at)
  }

  async save(point: WinvmPoint): Promise<void> {
    const dir = this.folder(point.id)
    const part = `${dir}.part`
    rmSync(part, { recursive: true, force: true })
    mkdirSync(part, { recursive: true })
    copyFileSync(this.f.vars, join(part, 'OVMF_VARS.fd'))
    if (existsSync(this.f.tpm)) cpSync(this.f.tpm, join(part, 'tpm'), { recursive: true })
    await run('qemu-img', ['snapshot', '-q', '-c', snapshotOf(point.id), this.f.disk], { env: daemonEnv() })
    writeFileSync(join(part, 'point.json'), JSON.stringify(point) + '\n')
    renameSync(part, dir)
  }

  async restore(id: string): Promise<void> {
    const dir = this.folder(id)
    if (!existsSync(join(dir, 'point.json'))) throw new Error('That restore point is gone.')
    await run('qemu-img', ['snapshot', '-q', '-a', snapshotOf(id), this.f.disk], { env: daemonEnv() })
    copyFileSync(join(dir, 'OVMF_VARS.fd'), this.f.vars)
    rmSync(this.f.tpm, { recursive: true, force: true })
    if (existsSync(join(dir, 'tpm'))) cpSync(join(dir, 'tpm'), this.f.tpm, { recursive: true })
  }

  async remove(id: string): Promise<void> {
    const dir = this.folder(id)
    await run('qemu-img', ['snapshot', '-q', '-d', snapshotOf(id), this.f.disk], { env: daemonEnv() }).catch((e: Error) => {
      // a snapshot already gone (a disk made again) leaves only the folder to drop
      if (!/not found|Can't find/i.test(String(e))) throw e
    })
    rmSync(dir, { recursive: true, force: true })
  }
}

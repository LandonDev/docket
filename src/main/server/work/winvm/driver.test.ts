import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { statePath, toolsRoot } from '../formats/tools'
import { DRIVER_TOOL, IBEAM_RESOURCE, ibeamCursor, virtioDriver } from './driver'

/** Live resize's driver on the box: the installed tool's folder, or the toolchain's installer run for it alone. */

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'winvm-driver-'))
  mkdirSync(join(root, 'app', 'scripts', 'work-tools'), { recursive: true })
  writeFileSync(join(root, 'app', 'scripts', 'work-tools', 'winvm.json'), '{}')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** What the installer leaves: the tool's folder and its word in state.json. */
function installed(ok = true): void {
  const dir = join(toolsRoot(join(root, 'data')), DRIVER_TOOL, '0.1.302')
  mkdirSync(join(dir, 'viogpudo'), { recursive: true })
  writeFileSync(join(dir, 'viogpudo', 'viogpudo.inf'), 'inf')
  const tool = { name: DRIVER_TOOL, pillar: 'winvm', version: '0.1.302', licence: 'BSD-3-Clause', licenceNote: '', ok, dir: join(DRIVER_TOOL, '0.1.302'), bin: 'viogpudo/viogpudo.inf', at: 1, ...(ok ? {} : { error: 'checksum mismatch' }) }
  writeFileSync(statePath(join(root, 'data')), JSON.stringify({ platform: 'linux-x64', at: 1, tools: { [DRIVER_TOOL]: tool } }))
}

describe("live resize's display driver", () => {
  it('answers the installed folder with no download', async () => {
    installed()
    let asked = 0
    const folder = await virtioDriver({ dataDir: join(root, 'data'), root: join(root, 'app'), install: async () => (asked++, { failed: [] }) }, () => {})
    expect(folder).toBe(join(toolsRoot(join(root, 'data')), DRIVER_TOOL, '0.1.302', 'viogpudo'))
    expect(asked).toBe(0)
  })

  it('installs the tool alone when it is missing, with its lines as progress', async () => {
    const lines: string[] = []
    const asks: unknown[] = []
    const folder = await virtioDriver(
      {
        dataDir: join(root, 'data'),
        root: join(root, 'app'),
        install: async (o) => {
          asks.push({ only: o.only, manifestsDir: o.manifestsDir })
          o.log('virtio-win 0.1.302: installing (build)')
          installed()
          return { failed: [] }
        }
      },
      (l) => lines.push(l)
    )
    expect(asks).toEqual([{ only: [DRIVER_TOOL], manifestsDir: join(root, 'app', 'scripts', 'work-tools') }])
    expect(lines).toEqual(['virtio-win 0.1.302: installing (build)'])
    expect(folder).toMatch(/viogpudo$/)
  })

  it('says why when the install fails, and when the build has no manifests', async () => {
    const fails = virtioDriver({ dataDir: join(root, 'data'), root: join(root, 'app'), install: async () => (installed(false), { failed: [DRIVER_TOOL] }) }, () => {})
    await expect(fails).rejects.toThrow('The display driver did not install: checksum mismatch')
    rmSync(join(root, 'app', 'scripts'), { recursive: true })
    await expect(virtioDriver({ dataDir: join(root, 'data'), root: join(root, 'app') }, () => {})).rejects.toThrow('no tool manifests')
  })

  it("finds the build's I-beam, and says so when it has none", () => {
    expect(ibeamCursor(join(import.meta.dirname, '..', '..', '..', '..', '..'))).toMatch(/resources\/winvm\/tc-ibeam\.cur$/)
    expect(() => ibeamCursor(root)).toThrow(`no ${IBEAM_RESOURCE}`)
  })
})

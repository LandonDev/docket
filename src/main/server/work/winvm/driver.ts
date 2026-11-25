import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appRoot } from '../../appRoot'
import { platformOf, Toolchain } from '../formats/tools'

/**
 * What live resize takes from the box (docs/agents/work-winvm.md "Live resize"): Red Hat's display driver, the
 * `virtio-win` tool of scripts/work-tools/winvm.json, installed by the toolchain's own installer when it is
 * missing (a download of 877 MB, checked by sha256, its one folder kept; no root), and the colour I-beam the
 * build carries in resources/winvm.
 */

export const DRIVER_TOOL = 'virtio-win'
export const IBEAM_RESOURCE = join('resources', 'winvm', 'tc-ibeam.cur')

export interface DriverDeps {
  dataDir: string
  /** the app's root: the build directory on the box, the checkout in a dev tree */
  root?: string
  /** a test's stand-in for the installer */
  install?: (o: { dataDir: string; manifestsDir: string; only: string[]; log: (line: string) => void }) => Promise<{ failed: string[] }>
}

/** The driver's folder on the box, installed first when missing; `progress` hears the installer's lines. */
export async function virtioDriver(d: DriverDeps, progress: (line: string) => void): Promise<string> {
  const chain = new Toolchain(d.dataDir)
  const have = chain.dir(DRIVER_TOOL)
  if (have) return join(have, 'viogpudo')
  const manifestsDir = join(d.root ?? appRoot(), 'scripts', 'work-tools')
  if (!existsSync(join(manifestsDir, 'winvm.json'))) throw new Error(`This box's build has no tool manifests: run bun scripts/work-tools/install.ts --only ${DRIVER_TOOL}`)
  const install =
    d.install ??
    (async (o) => {
      const platform = platformOf()
      if (!platform) throw new Error(`${process.platform}-${process.arch} has no ${DRIVER_TOOL}`)
      const { install } = await import('../../../../../scripts/work-tools/installer')
      return install({ ...o, platform, gentle: true })
    })
  const { failed } = await install({ dataDir: d.dataDir, manifestsDir, only: [DRIVER_TOOL], log: progress })
  const dir = new Toolchain(d.dataDir).dir(DRIVER_TOOL)
  if (failed.includes(DRIVER_TOOL) || !dir) throw new Error(`The display driver did not install: ${chain.state().tools[DRIVER_TOOL]?.error ?? 'see the log'}`)
  return join(dir, 'viogpudo')
}

/** The I-beam's path in this build; a throw when the build has none. */
export function ibeamCursor(root: string = appRoot()): string {
  const path = join(root, IBEAM_RESOURCE)
  if (!existsSync(path)) throw new Error(`This box's build has no ${IBEAM_RESOURCE}.`)
  return path
}

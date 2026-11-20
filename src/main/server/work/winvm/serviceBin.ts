import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Where the box keeps tc-computer.exe, the Windows service the keeper copies into the VM at wake
 * (docs/computer-protocol.md §29.1, the door). It belongs to the box's own build, so the guest's service
 * updates with the box: the deploy build places it in `resources/native` (box-update-lib.sh `build_script`,
 * `bun scripts/build-tc-computer-win.ts --into resources/native`), and a dev tree on the box finds the crate's
 * own cargo output. `TEMP_CODE_WINVM_EXE` names another file, for a proof.
 */
export const SERVICE_EXE = 'tc-computer.exe'

/** The places under the app's root, in the order they are tried. */
export const SERVICE_EXE_PLACES = [
  join('resources', 'native', SERVICE_EXE),
  join('native', 'tc-computer-win', 'target', 'x86_64-pc-windows-msvc', 'release', SERVICE_EXE)
] as const

export interface ServiceBinProbe {
  /** The app's root: the build directory on the box, the checkout in a dev tree. Default: two up from out/main. */
  root?: string
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

/** The absolute path of tc-computer.exe for the VM, or null when this build has none. */
export function tcComputerExe(opts: ServiceBinProbe = {}): string | null {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  if (env.TEMP_CODE_WINVM_EXE) {
    const given = resolve(env.TEMP_CODE_WINVM_EXE)
    return exists(given) ? given : null
  }
  // An ES module bundle has no __dirname (computer/binary.ts says the same).
  const root = opts.root ?? resolve(typeof __dirname === 'string' ? __dirname : process.cwd(), '..', '..')
  for (const place of SERVICE_EXE_PLACES) {
    const path = resolve(root, place)
    if (exists(path)) return path
  }
  return null
}

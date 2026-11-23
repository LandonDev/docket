import { bundleFile } from '../appRoot'
import { existsSync } from 'node:fs'
import { isHeadless } from '../../headless'

/**
 * Where `tc-computer` lives and whether computer use may run on this host
 * (docs/computer-protocol.md "The host"). On the Mac the Service shell's
 * electron.vite step builds it into resources/native, beside the appshot
 * helper; the dev tree's background build may still be running, so
 * availability is asked again at every spawn and every harness start. On
 * Windows it is `tc-computer.exe`, the Rust service of native/tc-computer-win
 * (§29), which the Windows build carries in resources/native.
 */

/** The service's file name on a platform. */
export const computerBinaryName = (platform: NodeJS.Platform = process.platform): string => (platform === 'win32' ? 'tc-computer.exe' : 'tc-computer')

/** TEMP_CODE_COMPUTER_BIN, else resources/native/tc-computer (tc-computer.exe on Windows) under the app's root. */
export function computerBinaryPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  // the app's root by its package.json, whichever chunk of the bundle this code lands in (appRoot)
  return env.TEMP_CODE_COMPUTER_BIN || bundleFile('resources', 'native', computerBinaryName(platform))
}

export interface AvailabilityProbe {
  platform?: NodeJS.Platform
  headless?: boolean
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

/** Why computer use is off on this host, or null when it may run. */
export function computerUnavailable(opts: AvailabilityProbe = {}): string | null {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') return 'computer use runs on a Mac or a Windows PC'
  // A proof's isolated Mac instance runs headless and still serves computer use: tc-computer touches AppKit itself.
  const proofHeadless = env.TEMP_CODE_COMPUTER === '1' && !!env.TEMP_CODE_USER_DATA
  if ((opts.headless ?? isHeadless(env, platform)) && !proofHeadless) return 'this host runs without a screen'
  if (env.TEMP_CODE_COMPUTER === '0') return 'turned off'
  if (!(opts.exists ?? existsSync)(computerBinaryPath(env, platform))) return 'tc-computer is not built'
  return null
}

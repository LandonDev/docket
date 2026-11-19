import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { BROWSER_VIDEO_SETTING, browserVideoOn } from '@shared/video/settings'
import { Toolchain } from '../../formats/tools'

/**
 * Whether the box's browser runs headed for live video: the host's
 * `work.browser.video` setting (on unless turned off), and the tools it needs
 * (the `screen-relay` tool of scripts/work-tools/browser.json: the engine, its
 * X server and its libraries). Without the tools, or with the setting off, the
 * browser starts headless, as it did before video.
 */

/** The `screen-relay` tool's name in the toolchain's state, and the programs it holds. */
export const VIDEO_TOOL = 'screen-relay'

export interface VideoTools {
  /** relay-engine */
  engine: string
  /** Xorg, run through the tool tree's loader paths */
  xorg: string
  /** xclip: his paste goes to the display's clipboard through it */
  xclip: string
  /** the folder the packages were unpacked into: `usr/lib/x86_64-linux-gnu` holds the libraries, `usr/lib/xorg/modules` the server's */
  sys: string
  /** the viewer folder the engine wants to exist, though nothing of it is ever served */
  viewer: string
}

/** The setting as this host's database holds it. A database with no settings table reads as on. */
export function browserVideoSetting(db: DatabaseSync): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(BROWSER_VIDEO_SETTING) as { value?: string } | undefined
    return browserVideoOn(row?.value)
  } catch {
    return true
  }
}

export function setBrowserVideo(db: DatabaseSync, on: boolean): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(BROWSER_VIDEO_SETTING, on ? '1' : '0')
}

const toolchains = new Map<string, Toolchain>()

/** The installed tools under `<dataDir>/work-tools`, or null when the installer has not put them there (or its probe failed). */
export function videoToolsAt(dataDir: string): VideoTools | null {
  let chain = toolchains.get(dataDir)
  if (!chain) toolchains.set(dataDir, (chain = new Toolchain(dataDir)))
  const engine = chain.bin(VIDEO_TOOL)
  const xorg = chain.bin(VIDEO_TOOL, 'xorg')
  const xclip = chain.bin(VIDEO_TOOL, 'xclip')
  if (!engine || !xorg || !xclip) return null
  // <tool>/pkg/relay-engine: the packages sit beside the package, in <tool>/sys
  const root = dirname(dirname(engine))
  return { engine, xorg, xclip, sys: join(root, 'sys'), viewer: join(root, 'pkg', 'dist', 'viewer') }
}

/** The environment a program of the tool tree runs with: its own libraries ahead of the host's. */
export const videoToolsEnv = (tools: VideoTools): { LD_LIBRARY_PATH: string } => ({ LD_LIBRARY_PATH: join(tools.sys, 'usr', 'lib', 'x86_64-linux-gnu') })

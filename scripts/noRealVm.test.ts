// A script that starts an isolated instance names WINVM_DIR, a folder of the run's own. Unset, the instance reads
// the box's standing Windows VM (/srv/agents/win-vm, winvm/machine/config.ts) and its keeper's idle tick can
// hibernate that machine under the owner's Work threads after 30 minutes (wall W-01, 2026-11-24).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname)
/** Scripts that set TEMP_CODE_USER_DATA and may leave WINVM_DIR alone, each with its reason. */
const ALLOWED: Record<string, string> = {
  'e2e-updater.ts': 'a packaged copy on the Mac, or in the Windows guest: no keeper there',
  'e2e-updater-win.ts': 'runs inside the Windows guest',
  'e2e-pc-setup-rig.ts': 'sets it in the Windows guest\'s own environment; its stand-in box (lib/pcRig.ts) names WINVM_DIR',
  'lib/pcDriveRig.ts': 'sets it in the Windows guest\'s own environment; its stand-in box (lib/pcRig.ts) names WINVM_DIR',
  'e2e-code-update.ts': 'a packaged copy on the Mac: its harness block takes HARNESS_KEYS alone',
  'lib/vmScreenMac.ts': 'passes the parent\'s WINVM_DIR through; e2e-vm-screen-mac.ts refuses to start with it unset (throwawayHost)'
}

function scripts(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) scripts(p, out)
    else if (/\.m?ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * A line that hands TEMP_CODE_USER_DATA to a process: an env key or an assignment to an env object, never a
 * comment, a read or a `KEY=value` marker looked for in /proc. Shell scripts are left out: the box's own
 * service file is one, and it is the instance that keeps the real machine.
 */
const LAUNCH = /^(?!\s*(\*|\/\/)).*(\bTEMP_CODE_USER_DATA:\s|\.TEMP_CODE_USER_DATA\s*=[^=])/m

describe('no proof holds the real Windows VM', () => {
  const launchers = scripts(ROOT).filter((p) => LAUNCH.test(readFileSync(p, 'utf8')))

  it('finds the launchers', () => {
    expect(launchers.length).toBeGreaterThan(40)
    expect(launchers.some((p) => p.endsWith('e2e-work-lib.ts'))).toBe(true)
  })

  it('every script that starts an isolated instance names WINVM_DIR', () => {
    const bare = launchers.filter((p) => !readFileSync(p, 'utf8').includes('WINVM_DIR')).map((p) => p.slice(ROOT.length + 1))
    expect(bare.filter((p) => !(p in ALLOWED))).toEqual([])
  })

  it('the allow-list holds no script that has since gone or named it', () => {
    const names = new Set(launchers.map((p) => p.slice(ROOT.length + 1)))
    for (const p of Object.keys(ALLOWED)) {
      expect(names.has(p), p).toBe(true)
      expect(readFileSync(join(ROOT, p), 'utf8').includes('WINVM_DIR'), p).toBe(false)
    }
  })
})

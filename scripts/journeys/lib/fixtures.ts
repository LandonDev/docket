import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLS } from '../../e2e-work-lib'

/** Use the box's installed converter with its working files under the run. */
export function fixtureTool(folder: string, tool: 'ffmpeg' | 'libreoffice', args: string[]): void {
  const parent = join(TOOLS, tool)
  const path = readdirSync(parent).sort().reverse().flatMap((version) => {
    const installed = join(parent, version)
    if (tool === 'ffmpeg') return [join(installed, 'ffmpeg')]
    const opt = join(installed, 'opt')
    return existsSync(opt) ? readdirSync(opt).map((name) => join(opt, name, 'program', 'soffice')) : []
  }).find(existsSync)
  if (!path) throw new Error(`No ${tool} fixture converter in ${parent}`)
  execFileSync(path, args, { cwd: folder, env: { PATH: process.env.PATH, HOME: folder, TMPDIR: folder }, timeout: 45_000, stdio: 'pipe' })
}

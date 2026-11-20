import type { HealthRow } from '@shared/work'
import type { WorkCtx } from '../modules'
import { Toolchain, type ToolState } from './tools'

/**
 * The formats pillar's rows for Connections (docs/agents/work-formats.md
 * "The toolchain"): one row for the conversion tools this host has, which
 * is what Settings → Work's toolchain row said, and one broken row for each
 * tool offered here that did not install. Read from the installer's
 * state.json and the disk; nothing runs, and nothing is installed (the
 * installer is a command, so a row names it).
 */

/** The toolchain's own tools by their proper names; a pillar's tool shows by its manifest name. The venv is Python's, never a tool of its own here. */
const NAMES: Record<string, string> = { libreoffice: 'LibreOffice', python: 'Python', ffmpeg: 'ffmpeg', ironcalc: 'IronCalc', 'screen-relay': 'Screen relay' }
const HIDDEN = new Set(['venv'])
const INSTALL = 'bun scripts/work-tools/install.ts'

const nameOf = (tool: string): string => NAMES[tool] ?? tool
/** major.minor: the line names a release, not a build. */
const short = (version: string): string => version.split('.').slice(0, 2).join('.')
const listOf = (names: readonly string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** Each tool as the host finds it: usable when its probe passed and its program is still on disk. */
export type ToolSeen = Pick<ToolState, 'name' | 'version' | 'error'> & { usable: boolean }

/** The toolchain's own four by name and release, in this order; the pillars' tools by name while few, else counted, so the line stays one line. */
const CORE = ['libreoffice', 'python', 'ffmpeg', 'ironcalc']
const FEW = 3
function installedLine(ok: readonly ToolSeen[]): string {
  const named = (t: ToolSeen): string => `${nameOf(t.name)} ${short(t.version)}`
  const core = CORE.flatMap((n) => ok.filter((t) => t.name === n))
  const rest = ok.filter((t) => !CORE.includes(t.name)).sort((a, b) => a.name.localeCompare(b.name))
  if (rest.length <= FEW) return listOf([...core, ...rest].map(named))
  return listOf([...core.map(named), `${rest.length} ${core.length ? 'more' : 'tools'}`])
}

export function formatsRows(tools: readonly ToolSeen[]): HealthRow[] {
  const shown = tools.filter((t) => !HIDDEN.has(t.name) && !t.error?.startsWith('not offered'))
  const ok = shown.filter((t) => t.usable)
  const failed = shown.filter((t) => !t.usable)
  const base = { id: 'formats.toolchain', pillar: 'formats' as const, group: 'Tools', title: 'Conversion tools' }
  const head: HealthRow = ok.length
    ? { ...base, state: 'working', line: installedLine(ok) }
    : failed.length
      ? { ...base, state: 'broken', line: 'None installed' }
      : { ...base, state: 'needs-you', line: `None installed. Install them with ${INSTALL} on this host.` }
  return [
    head,
    ...failed.map((t): HealthRow => {
      const said = t.error?.replace(/\s+/g, ' ').slice(0, 100).replace(/[.\s]+$/, '')
      const why = said ? said.charAt(0).toUpperCase() + said.slice(1) : 'Its files are missing'
      return { id: `formats.tool:${t.name}`, pillar: 'formats', group: 'Tools', title: nameOf(t.name), state: 'broken', line: `${why}. Install it again with ${INSTALL} --only ${t.name}` }
    })
  ]
}

/** This host's tools, as `work.formats.tools` reports them, without the job runner. */
export function toolsSeen(dataDir: string): ToolSeen[] {
  const chain = new Toolchain(dataDir)
  return chain.list().map((t) => ({ name: t.name, version: t.version, ...(t.error ? { error: t.error } : {}), usable: t.ok && chain.has(t.name) }))
}

export const formatsHealth = { check: async (ctx: WorkCtx): Promise<HealthRow[]> => formatsRows(toolsSeen(ctx.dataDir)) }

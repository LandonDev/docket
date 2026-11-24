import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { WorkScope } from '@shared/work'
import { loadWorkModules, WORK_MODULES } from './modules'

/**
 * Every id, time, measure and destination field of a Work tool says what it is, its unit or form, and
 * where the agent gets it: an agent reads the field's help, never the code beside it. The walk covers
 * every tool a workspace thread is listed (the box browser's and the Windows VM's are listed only on a
 * host that has them, and take the computer tools' own schemas).
 */

type Json = Record<string, unknown>

/** The names that carry an id, a time, a measure or a place. */
const NAMED = /(?:^|_)(?:id|at|time|date|until|from|to|width|height|x|y|size|minutes|path|ref)$|(?:Id|At|Time|Date|Until|From|To|Width|Height|Size|Minutes|Path|Ref)$/

/** Fields whose help would only repeat the name, the tool's description or the choices. */
const ALLOWED: ReadonlySet<string> = new Set<string>([])

const scope: WorkScope = { sessionId: 's', workspaceId: 'w', sector: 'purdue', host: 'env_test', away: false, routineRunId: null, shared: () => false }

function described(node: Json, root: Json): boolean {
  const deref = (n: Json): Json => (typeof n.$ref === 'string' ? ((n.$ref.slice(2).split('/').reduce<unknown>((a, k) => (a as Json)?.[k], root) as Json) ?? n) : n)
  const at = deref(node)
  if (typeof at.description === 'string' && at.description.trim()) return true
  // A literal or a list of choices says itself.
  if (at.const !== undefined || Array.isArray(at.enum)) return true
  return [...((at.anyOf ?? at.oneOf ?? []) as Json[])].some((b) => typeof deref(b).description === 'string')
}

function bare(tool: string, node: Json, path: string, root: Json, out: string[]): void {
  const deref = (n: Json): Json => (typeof n.$ref === 'string' ? ((n.$ref.slice(2).split('/').reduce<unknown>((a, k) => (a as Json)?.[k], root) as Json) ?? n) : n)
  const at = deref(node)
  for (const branch of [...((at.anyOf ?? []) as Json[]), ...((at.oneOf ?? []) as Json[]), ...((at.allOf ?? []) as Json[])]) bare(tool, branch, path, root, out)
  if (at.items && typeof at.items === 'object') bare(tool, at.items as Json, `${path}[]`, root, out)
  for (const item of (at.prefixItems ?? []) as Json[]) bare(tool, item, `${path}[]`, root, out)
  for (const [key, child] of Object.entries((at.properties ?? {}) as Record<string, Json>)) {
    const field = path ? `${path}.${key}` : key
    if (NAMED.test(key) && !described(child, root) && !ALLOWED.has(`${tool} ${field}`)) out.push(`${tool} ${field}`)
    bare(tool, child, field, root, out)
  }
}

describe("Work tools' field help", () => {
  beforeAll(async () => {
    await loadWorkModules()
  }, 120_000)

  it('lists every pillar that loaded, with tools to walk', () => {
    expect(WORK_MODULES.length).toBeGreaterThan(30)
    expect(WORK_MODULES.flatMap((m) => m.tools?.(scope) ?? []).length).toBeGreaterThan(100)
  })

  it('gives every id, time, measure and destination field its help', () => {
    const missing: string[] = []
    for (const module of WORK_MODULES)
      for (const tool of module.tools?.(scope) ?? []) {
        const root = z.toJSONSchema(tool.input, { io: 'input' }) as Json
        bare(tool.name, root, '', root, missing)
      }
    expect([...new Set(missing)]).toEqual([])
  })
})

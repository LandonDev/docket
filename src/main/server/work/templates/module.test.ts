import { describe, expect, it } from 'vitest'
import { requiredCapability } from '@shared/capabilities'
import { RELAY_METHODS } from '@shared/contract-relay'
import { ClientRequestSchema } from '@shared/contract'
import { TEMPLATES_CAPS, TEMPLATES_RELAY, TemplatesRequestSchemas } from '@shared/contract-work-templates'
import { pillarOfMethod } from '@shared/work/wire'
import { PILLAR_LOADERS } from '../modules'

/* The templates pillar's wire: its methods, the capability each needs, and that a Mac window reaches a shelf on the box. */

const methods = TemplatesRequestSchemas.map((s) => s.shape.method.value)

describe('the wire', () => {
  it('declares the seven methods, each the pillar\'s own', () => {
    expect(methods).toEqual(['work.templates.list', 'work.templates.make', 'work.templates.save', 'work.templates.rename', 'work.templates.move', 'work.templates.remove', 'work.templates.unhide'])
    for (const m of methods) expect(pillarOfMethod(m)).toBe('templates')
  })

  it('reads with read and changes with operate', () => {
    expect(requiredCapability({ method: 'work.templates.list' })).toBe('read')
    for (const m of methods.slice(1)) expect(TEMPLATES_CAPS[m as keyof typeof TEMPLATES_CAPS]).toBe('operate')
  })

  it('carries every method to the workspace\'s host', () => {
    expect(TEMPLATES_RELAY).toEqual({})
    for (const m of methods) expect((RELAY_METHODS as Record<string, unknown>)[m]).toBe('link')
  })

  it('takes a day only as YYYY-MM-DD, a real one', () => {
    const make = (today: string) => ClientRequestSchema.safeParse({ id: '1', method: 'work.templates.make', params: { workspaceId: 'w1', template: 'Invoice', today } }).success
    expect(make('2026-11-23')).toBe(true)
    expect(make('2026-02-30')).toBe(false)
    expect(make('11/23/2026')).toBe(false)
  })

  it('names no file by a bare path', () => {
    for (const s of TemplatesRequestSchemas) for (const key of Object.keys((s.shape.params as unknown as { shape: Record<string, unknown> }).shape)) expect(['path', 'paths', 'cwd', 'parent']).not.toContain(key)
  })
})

describe('the module', () => {
  it('loads as the templates pillar', async () => {
    const module = await PILLAR_LOADERS.templates()
    expect(module.id).toBe('templates')
  })
})

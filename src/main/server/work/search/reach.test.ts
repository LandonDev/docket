import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inReach, reachSectors, workspaceOfSector } from '@shared/work/search'
import { threadReach, windowReach } from './reach'
import { BARE, COSMIC, makeRig, PURDUE } from './testkit'

/** Where a search may look: his window's reach and a thread's, and the one file a pillar imports to register. */

describe('source.ts', () => {
  it('is types only: importing it loads no other file of search', () => {
    const source = readFileSync(join(__dirname, 'source.ts'), 'utf8')
    const imports = source.split('\n').filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line))
    expect(imports.length).toBeGreaterThan(0)
    for (const line of imports) expect(line, line).toMatch(/^import type /)
    expect(source).not.toMatch(/\bimport\(/)
  })
})

describe("his window's reach", () => {
  it('is every job of this host and Work Chats, never a code workspace', () => {
    const { ctx } = makeRig()
    const reach = windowReach(ctx)
    expect(reach.workspaces.map((w) => w.id)).toEqual([PURDUE, COSMIC, BARE])
    expect(reach.workspaces.map((w) => w.sector)).toEqual(['purdue', 'cosmic', null])
    expect(reach.chats).toBe(true)
    expect(reach.sessionId).toBeNull()
  })
  it('is one job alone when it names one, and nothing for an id that is no job here', () => {
    const { ctx } = makeRig()
    expect(windowReach(ctx, COSMIC)).toEqual({ workspaces: [{ id: COSMIC, sector: 'cosmic', name: 'Cosmic' }], chats: false, sessionId: null })
    expect(windowReach(ctx, 'ws-code').workspaces).toEqual([])
    expect(windowReach(ctx, 'nope')).toEqual({ workspaces: [], chats: false, sessionId: null })
  })
})

describe("a thread's reach", () => {
  it('is nothing for a code thread, linked to a sector or not', () => {
    const rig = makeRig()
    rig.reaches.set('k1', { work: false, workspaceId: 'ws-code', sectors: ['cosmic'], sessionId: 'k1' })
    expect(threadReach(rig.ctx, 'k1')).toBeNull()
    expect(threadReach(rig.ctx, 'unknown')).toBeNull()
  })
  it("is a Work thread's own job and no other", () => {
    const rig = makeRig()
    rig.reaches.set('t1', { work: true, workspaceId: PURDUE, sectors: ['purdue'], sessionId: 't1' })
    expect(threadReach(rig.ctx, 't1')).toEqual({ workspaces: [{ id: PURDUE, sector: 'purdue', name: 'Purdue' }], chats: false, sessionId: 't1' })
  })
  it('is every job and Work Chats for a Work Chat, as its @ reads', () => {
    const rig = makeRig()
    rig.reaches.set('c1', { work: true, workspaceId: null, sectors: 'all', sessionId: 'c1' })
    const reach = threadReach(rig.ctx, 'c1')!
    expect(reach.workspaces.map((w) => w.id)).toEqual([PURDUE, COSMIC, BARE])
    expect(reach.chats).toBe(true)
    expect(reach.sessionId).toBe('c1')
  })
  it('keeps a job with no sector in reach, with no sector to read LifeOS by', () => {
    const rig = makeRig()
    rig.reaches.set('b1', { work: true, workspaceId: BARE, sectors: [], sessionId: 'b1' })
    const reach = threadReach(rig.ctx, 'b1')!
    expect(reach.workspaces).toEqual([{ id: BARE, sector: null, name: 'Side job' }])
    expect(reachSectors(reach)).toEqual([])
  })
  it('is nothing for a Work thread whose workspace is not a job of this host', () => {
    const rig = makeRig()
    rig.reaches.set('o1', { work: true, workspaceId: 'gone', sectors: ['purdue'], sessionId: 'o1' })
    expect(threadReach(rig.ctx, 'o1')).toBeNull()
  })
})

describe('the reach as a fence', () => {
  it('admits a job in it, and Work Chats only when it has them', () => {
    const { ctx } = makeRig()
    const one = windowReach(ctx, PURDUE)
    expect(inReach(one, PURDUE)).toBe(true)
    expect(inReach(one, COSMIC)).toBe(false)
    expect(inReach(one, null)).toBe(false)
    expect(inReach(windowReach(ctx), null)).toBe(true)
  })
  it('finds the job of a LifeOS row by its sector', () => {
    const { ctx } = makeRig()
    const all = windowReach(ctx)
    expect(workspaceOfSector(all, 'cosmic')).toBe(COSMIC)
    expect(workspaceOfSector(all, 'ref')).toBeUndefined()
    expect(workspaceOfSector(all, null)).toBeUndefined()
    expect(reachSectors(all)).toEqual(['purdue', 'cosmic'])
  })
})

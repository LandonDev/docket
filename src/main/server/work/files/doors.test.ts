import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import type { WorkToolResult } from '@shared/work'
import type { ToolCtx, WorkCtx } from '../modules'
import { importFile } from '../formats/importer'
import { filesHandle, THREADS_BY_TOOLS } from './handle'
import { FS_SHARED, fsPathRefusal, setThreadsMayWrite } from './policy'
import { at, makeRig, thread, WS, type Rig } from './testkit'
import { filesTools } from './tools'

/**
 * The older doors (docs/agents/work-files.md "Agents", "The older doors"): every way an agent can reach a
 * folder others can open, tried in turn, finds it held or refused, and the team's folder is byte for byte as it
 * was. A remote key's generic `fs.*` write into a listed library is refused even where the roots let it through.
 */

let rig: Rig
let held: unknown[]
beforeEach(() => {
  rig = makeRig()
  setThreadsMayWrite(true)
  held = []
})
afterEach(() => {
  setThreadsMayWrite(false)
  rig.close()
})

/** The team's folder as names, all the way down. */
const tree = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? [`${d.name}/`, ...tree(join(dir, d.name)).map((n) => `${d.name}/${n}`)] : [d.name]))

function toolCtx(): ToolCtx {
  const ctx = Object.assign(Object.create(null), rig.ctx, {
    held: { create: (act: { payload: unknown }) => (held.push(act.payload), { n: held.length, summary: 'held', ref: { at: 'host', id: `h${held.length}` }, state: 'held' }), onDecided: () => () => {} },
    results: { add: () => {} }
  }) as WorkCtx
  return Object.assign(Object.create(null), ctx, { scope: ctx.scopeOf('t1')!, sessionId: 't1', signal: new AbortController().signal }) as ToolCtx
}
async function tool(name: string, args: Record<string, unknown>): Promise<WorkToolResult & { text: string }> {
  const t = filesTools.find((x) => x.name === name)!
  const got = await t.run(t.input.parse(args), toolCtx())
  return { ...got, text: got.content.map((c) => ('text' in c ? c.text : '')).join('\n') }
}

describe('every agent route into a folder others can open', () => {
  it('is held or refused, and the folder is as it was', async () => {
    const before = tree(rig.team)
    // The files_* tools: each change held as a file.act, a delete too.
    for (const [name, args] of [
      ['files_make', { place: 'General', kind: 'text', name: 'Notes' }],
      ['files_move', { place: 'General', paths: ['Plan.docx'], name: 'Plan v2.docx' }],
      ['files_move', { place: 'folder', paths: ['notes.txt'], to: { place: 'General', path: '' } }],
      ['files_copy', { place: 'folder', paths: ['notes.txt'], to: { place: 'Events', path: '' } }],
      ['files_trash', { place: 'General', paths: ['Plan.docx'] }]
    ] as const)
      expect((await tool(name, args)).text, name).toMatch(/^Held as item \d+\./)
    expect(held).toHaveLength(5)
    // The wire itself: a thread's change by work.files.* is refused, whatever it claims.
    for (const [method, params] of [
      ['work.files.make', { at: at(join(rig.team, 'General')), kind: 'text', op: 'op-000001' }],
      ['work.files.copy', { refs: [at(join(rig.folder, 'notes.txt'))], to: at(join(rig.team, 'General')), op: 'op-000002', asked: true, origin: { from: 'window' } }],
      ['work.files.write', { ref: at(join(rig.team, 'General', 'Plan.docx')), text: 'x', version: '1:1:' }],
      ['work.files.upload', { at: at(join(rig.team, 'General')), name: 'a.txt', size: 1, sha256: 'a'.repeat(64), op: 'op-000003' }]
    ] as const)
      await expect(filesHandle({ id: 'x', method, params: { workspaceId: WS, ...params } } as unknown as ClientRequest, rig.ctx, thread('t1'), undefined), method).rejects.toThrow(THREADS_BY_TOOLS)
    // The importer, for a thread that opens a team's file as a document: its document is made under the host's data, never beside the file.
    writeFileSync(join(rig.team, 'General', 'Agenda.md'), '# Agenda\n')
    const imported = await importFile(rig.ctx, thread('t1'), { sessionId: 't1', from: { at: 'source', source: at(join(rig.team, 'General', 'Agenda.md')) } })
    expect((imported.source as { path: string }).path.startsWith(rig.dataDir)).toBe(true)
    // The one file there now is the one this test put there: nothing an agent did reached the team.
    expect(tree(rig.team).filter((n) => !before.includes(n))).toEqual(['General/Agenda.md'])
    expect(before.every((n) => tree(rig.team).includes(n))).toBe(true)
  })
})

describe("a remote key's generic fs.* write", () => {
  it('is refused in a listed library, made or named, and passes in his own folder', () => {
    const general = join(rig.team, 'General')
    for (const [method, params] of [
      ['fs.writeText', { path: join(general, 'Plan.docx'), content: 'x' }],
      ['fs.createPath', { parent: general, name: 'New folder', isDir: true }],
      ['fs.createPath', { parent: join(general, 'Not yet', 'Deeper'), name: 'x.txt', isDir: false }],
      ['fs.renamePath', { path: join(general, 'Plan.docx'), name: 'Plan v2.docx' }],
      ['fs.deletePath', { path: join(general, 'Plan.docx') }],
      ['fs.copyPath', { from: join(rig.folder, 'notes.txt'), destParent: general }],
      ['fs.movePath', { from: join(rig.folder, 'notes.txt'), destParent: join(rig.mine) }],
      ['fs.movePath', { from: join(general, 'Plan.docx'), destParent: rig.folder }]
    ] as const)
      expect(fsPathRefusal(rig.ctx, method, params), `${method} ${JSON.stringify(params)}`).toBe(FS_SHARED)
    // A link into the library from his own folder is judged where it leads.
    mkdirSync(join(rig.folder, 'Linked'))
    symlinkSync(general, join(rig.folder, 'Linked', 'General'))
    expect(fsPathRefusal(rig.ctx, 'fs.writeText', { path: join(rig.folder, 'Linked', 'General', 'x.txt'), content: 'x' })).toBe(FS_SHARED)
    // His own folder, and a read anywhere, pass this check (the listener's roots still fence them).
    expect(fsPathRefusal(rig.ctx, 'fs.writeText', { path: join(rig.folder, 'notes.txt'), content: 'x' })).toBeNull()
    expect(fsPathRefusal(rig.ctx, 'fs.createPath', { parent: rig.folder, name: 'Drafts', isDir: true })).toBeNull()
    expect(fsPathRefusal(rig.ctx, 'fs.readText', { path: join(general, 'Plan.docx') })).toBeNull()
    expect(fsPathRefusal(rig.ctx, 'fs.listPath', { path: general })).toBeNull()
  })
})

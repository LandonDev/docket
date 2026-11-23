import type { WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import { canvas } from '../canvas/index'
import { outbox as outboxModule } from '../outbox/index'
import { makeRig, type Rig } from '../outbox/rig'
import { FakeChats } from './fakeChats'
import { messages } from './index'

/**
 * The hold's rig with the messages pillar mounted and LifeOS's chat in
 * memory, for the pillar's tests. Two Work workspaces (Cosmic and Hypixel),
 * a Work workspace with no sector, a code workspace, and a Work thread in
 * Cosmic. Work is turned on after the fake is in place, so `start` watches
 * the fake.
 */
export interface ChatRig {
  rig: Rig
  chats: FakeChats
  /** a workspace in the host's database (what `workSector` reads) and the registry's list */
  workspace(id: string, extra?: Partial<WorkspaceMeta>): void
  thread(id: string, extra?: Partial<SessionMeta>): void
}

export async function makeChatRig(): Promise<ChatRig> {
  const rig = await makeRig({ modules: [outboxModule, canvas, messages], enabled: false })
  const chats = new FakeChats()
  rig.work.ctx.lifeos = chats.client()
  const workspace = (id: string, extra: Partial<WorkspaceMeta> = {}): void => {
    const w = rig.workspace(id, extra)
    rig.work.ctx.db
      .prepare('INSERT OR REPLACE INTO workspaces (id, name, path, git, created_at, kind, sector) VALUES (?, ?, ?, 0, ?, ?, ?)')
      .run(w.id, w.name, w.path, w.createdAt, (w as { kind?: string }).kind ?? 'code', (w as { sector?: string }).sector ?? null)
  }
  workspace('ws-cosmic', { kind: 'work', sector: 'cosmic' } as Partial<WorkspaceMeta>)
  workspace('ws-hypixel', { kind: 'work', sector: 'hypixel' } as Partial<WorkspaceMeta>)
  workspace('ws-nosector', { kind: 'work' } as Partial<WorkspaceMeta>)
  workspace('ws-code')
  const thread = (id: string, extra: Partial<SessionMeta> = {}): void => void rig.thread(id, extra)
  thread('t-cosmic', { scope: 'work', workspaceId: 'ws-cosmic' } as Partial<SessionMeta>)
  thread('t-hypixel', { scope: 'work', workspaceId: 'ws-hypixel' } as Partial<SessionMeta>)
  rig.work.settings.set({ enabled: true })
  return { rig, chats, workspace, thread }
}

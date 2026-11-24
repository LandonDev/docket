import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'

const registered = vi.hoisted(() => [] as { id: string }[])
vi.mock('../../../sessionMove', async (original) => ({
  ...(await original<typeof import('../../../sessionMove')>()),
  registerMoveModule: (_db: unknown, module: { id: string }) => {
    registered.push(module)
    return () => {}
  }
}))

const { ensureChatTables, mailChatHere } = await import('./find')

/** A mail chat moved to another host stays a mail chat there: its row rides the move (sessionMove.ts). */
describe("a mail chat's row", () => {
  it('rides a thread that moves to another host, and the denial reads the table from the first line of ensure', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT, started_by TEXT)')
    ensureChatTables(db)
    expect(registered.map((m) => m.id)).toEqual(['mail-chats', 'narrowed'])
    db.prepare('INSERT INTO sessions VALUES (?, NULL, NULL)').run('chat')
    db.prepare('INSERT INTO work_mail_chats VALUES (?, ?, ?, ?, ?)').run('chat', 'ws', 'box', null, 1)
    expect(mailChatHere('chat')).not.toBeNull()
  })
})

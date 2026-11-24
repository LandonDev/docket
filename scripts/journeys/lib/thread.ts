import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import type { Pair } from './shape'

type ToolReply<T> = {
  content?: { text?: string }[]
  structuredContent?: T
  isError?: boolean
}

export function createThread(pair: Pair, workspaceId: string, title: string): Promise<{ id: string }> {
  return pair.rpc(pair.box, 'session.create', { workspaceId, title, provider: 'claude', permission: 'auto', threadType: 'chat', scope: 'work' })
}

let call = 0

/** The same two HMACs and call shape used by Run.tool and the thread bridge. */
export function toolCall(sessionId: string, seed: string, seq: number, tool: string, args: object) {
  const sign = (words: string): string => createHmac('sha256', Buffer.from(seed, 'hex')).update(words).digest('base64url')
  return { sessionId, appToken: sign('app-bridge:' + sessionId), token: sign(sessionId), call: seq, tool, args }
}

export async function workTool<T = unknown>(pair: Pair, sessionId: string, tool: string, args: object) {
  const answer = await pair.rpc<ToolReply<T>>(pair.box, 'app.workCall', toolCall(sessionId, pair.seed, ++call, tool, args), 60_000)
  const text = (answer.content ?? []).map(({ text }) => text ?? '').join('\n')
  return { text, value: answer.structuredContent, error: !!answer.isError }
}

export async function hostRows<T>(pair: Pair, sql: string, ...args: string[]): Promise<T[]> {
  const { Database } = await import('bun:sqlite')
  const db = new Database(join(pair.box.data, 'temp-code.db'), { readonly: true })
  try {
    return db.query<T, string[]>(sql).all(...args)
  } finally {
    db.close()
  }
}

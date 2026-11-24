import { describe, expect, it } from 'vitest'
import { DENIED_UNCHECKED, harnessDeniedOf, narrowedToolRefusal } from './narrowing'

/**
 * A narrowed thread (a mail chat) on Claude Code's fence: the Work tools, LifeOS and five app tools, nothing else of
 * any MCP server; and a module whose check throws leaves the thread narrowed, never open.
 */
describe('a narrowed thread', () => {
  it('keeps the Work tools, LifeOS (on the app server, as Claude Code sees an add-on), three app tools and two built-ins', () => {
    for (const tool of ['mcp__work__mail_offer', 'mcp__app__lifeos__read_mail_thread', 'mcp__app__lifeos__draft_mail', 'mcp__app__update_notes', 'mcp__app__note_decision', 'mcp__app__cite_source', 'ToolSearch', 'TodoWrite'])
      expect(narrowedToolRefusal(tool), tool).toBeNull()
  })

  it('reaches no other thread, page tool, agent, add-on change, desktop or Mac', () => {
    for (const tool of ['mcp__app__someaddon__do', 'Monitor', 'PowerShell', 'Read', 'EnterWorktree', 'mcp__app__app_list_threads', 'mcp__app__app_read_thread', 'mcp__app__html_preview', 'mcp__app__html_render', 'mcp__app__app_start_thread', 'mcp__app__addon_remove', 'mcp__app__skill_write', 'mcp__app__computer_click', 'mcp__orchestrator__spawn_agent', 'mcp__mac__mac_shell', 'mcp__someaddon__do'])
      expect(narrowedToolRefusal(tool), tool).toBe(`${tool} is not available in this thread.`)
  })


  it('starts narrowed when a module cannot say', () => {
    const lines: string[] = []
    const broken = { id: 'mail', harnessDenied: () => { throw new Error('no table') } } as never
    expect(harnessDeniedOf('s1', [broken], (line) => void lines.push(line))).toEqual([...DENIED_UNCHECKED])
    expect(lines[0]).toContain('starts narrowed')
  })
})

describe('a mail chat when Mail did not load on this computer', () => {
  it('runs nothing: no harness tool, no tool call, and the frame says why in one sentence, from its own mark', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { WORK_LOAD_FAULTS } = await import('./modules')
    const { callRefusalOf, markNarrowed, unloadedRefusal } = await import('./narrowing')
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT, started_by TEXT)')
    db.exec("INSERT INTO sessions VALUES ('chat', NULL, NULL), ('child', 'chat', NULL), ('plain', NULL, NULL)")
    markNarrowed(db, 'chat', 'mail', 1)
    const said = 'Mail did not load on this computer, so this chat cannot run. Open it once Mail is back.'
    // Mail loaded: the frame leaves the thread to Mail's own check.
    expect(unloadedRefusal('chat', db)).toBeNull()
    WORK_LOAD_FAULTS.set('mail', 'boom')
    try {
      for (const id of ['chat', 'child']) expect(unloadedRefusal(id, db), id).toBe(said)
      expect(unloadedRefusal('plain', db)).toBeNull()
      // No module answers for it (Mail is not here); the frame still denies every harness tool and refuses every call.
      expect(harnessDeniedOf('chat', [])).toEqual([...DENIED_UNCHECKED])
      expect(harnessDeniedOf('plain', [])).toEqual([])
      expect(callRefusalOf([], { log: () => {} } as never, { sessionId: 'child', via: 'addon', server: 'lifeos', tool: 'read_mail_thread' })).toBe(said)
    } finally {
      WORK_LOAD_FAULTS.delete('mail')
    }
  })
})

import { describe, expect, it } from 'vitest'
import { DENIED_UNCHECKED, harnessDeniedOf, narrowedToolRefusal } from './narrowing'

/**
 * A narrowed thread (a mail chat) on Claude Code's fence: the Work tools, LifeOS and five app tools, nothing else of
 * any MCP server; and a module whose check throws leaves the thread narrowed, never open.
 */
describe('a narrowed thread', () => {
  it('keeps the Work tools, LifeOS and three app tools', () => {
    for (const tool of ['mcp__work__mail_offer', 'mcp__lifeos__read_mail_thread', 'mcp__app__update_notes', 'mcp__app__note_decision', 'mcp__app__cite_source'])
      expect(narrowedToolRefusal(tool), tool).toBeNull()
  })

  it('reaches no other thread, page tool, agent, add-on change, desktop or Mac', () => {
    for (const tool of ['mcp__app__app_list_threads', 'mcp__app__app_read_thread', 'mcp__app__html_preview', 'mcp__app__html_render', 'mcp__app__app_start_thread', 'mcp__app__addon_remove', 'mcp__app__skill_write', 'mcp__app__computer_click', 'mcp__orchestrator__spawn_agent', 'mcp__mac__mac_shell', 'mcp__someaddon__do'])
      expect(narrowedToolRefusal(tool), tool).toBe(`${tool} is not available in this thread.`)
  })

  it('leaves a built-in to the harness denial', () => {
    expect(narrowedToolRefusal('Read')).toBeNull()
  })

  it('starts narrowed when a module cannot say', () => {
    const lines: string[] = []
    const broken = { id: 'mail', harnessDenied: () => { throw new Error('no table') } } as never
    expect(harnessDeniedOf('s1', [broken], (line) => void lines.push(line))).toEqual([...DENIED_UNCHECKED])
    expect(lines[0]).toContain('starts narrowed')
  })
})

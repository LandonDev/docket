import { describe, expect, test } from 'vitest'
import { toolDisplay } from './display'

describe('toolDisplay', () => {
  test("an add-on call through the app server wears the add-on's name, on every path", () => {
    const listTasks = { app: 'lifeos', action: 'List tasks' }
    expect(toolDisplay('mcp__app__lifeos__list_tasks', {})).toEqual(listTasks)
    expect(toolDisplay('app.addon_call', { tool: 'lifeos__list_tasks', arguments: {} })).toEqual(listTasks)
    expect(toolDisplay('mcp__app__addon_call', { tool: 'lifeos__list_tasks' })).toEqual(listTasks)
  })

  test("the app's own tools and a plain MCP server keep their faces", () => {
    expect(toolDisplay('mcp__app__update_notes', {})).toBeUndefined()
    expect(toolDisplay('mcp__lifeos__list_tasks', {})).toEqual({ app: 'lifeos', action: 'List tasks' })
  })
})

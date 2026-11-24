import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fieldOf, inputProblemWords, nearestName, unknownToolWords } from './inputWords'

const input = z
  .object({
    range: z.string().max(12).describe("One A1 range, such as 'Q1'!B4:D9"),
    limit: z.number().int().min(1).max(50).optional().describe('How many rows'),
    mode: z.enum(['markdown', 'json']).optional(),
    at: z.iso.datetime().optional().describe('ISO 8601'),
    cells: z.array(z.object({ at: z.string().describe('One A1 cell'), value: z.string() })).optional(),
    op: z.discriminatedUnion('kind', [z.object({ kind: z.literal('insert'), text: z.string() }), z.object({ kind: z.literal('clear') })]).optional(),
    path: z.string().refine((v) => v.startsWith('/'), 'must be an absolute path').optional(),
    pick: z.string().meta({ examples: ['B4'] }).optional()
  })
  .strict()

const wordsFor = (args: unknown): string => {
  const parsed = input.safeParse(args)
  if (parsed.success) throw new Error('expected a bad input')
  return inputProblemWords('sheet_read', input, args, parsed.error.issues)
}

describe('inputProblemWords', () => {
  it('a missing field: named, with its help, and what to do', () => {
    expect(wordsFor({})).toBe(
      "Nothing ran: the input does not fit sheet_read. range is missing (One A1 range, such as 'Q1'!B4:D9). Fix the input and call sheet_read again."
    )
  })
  it('a wrong type, with an example from the schema', () => {
    expect(wordsFor({ range: 'B4', limit: 'ten' })).toContain('limit must be a number (How many rows). For example: limit: 1.')
    expect(wordsFor({ range: 'B4', limit: 2.5 })).toContain('limit must be a whole number')
  })
  it('too long and too big', () => {
    expect(wordsFor({ range: 'A'.repeat(13) })).toContain('range must be at most 12 characters')
    expect(wordsFor({ range: 'B4', limit: 99 })).toContain('limit must be at most 50 (How many rows)')
  })
  it('not one of an enum, with the first choice as the example', () => {
    expect(wordsFor({ range: 'B4', mode: 'html' })).toContain('mode must be one of "markdown", "json". For example: mode: "markdown".')
  })
  it('an unknown key names the fields there are', () => {
    expect(wordsFor({ range: 'B4', rnage: 'x' })).toContain('rnage is not a field; the fields are range, limit, mode, at, cells, op, path, pick.')
  })
  it('a nested field, a bad format, a union and a refine keep their own words', () => {
    expect(wordsFor({ range: 'B4', cells: [{ value: 'x' }] })).toContain('cells[0].at is missing (One A1 cell).')
    expect(wordsFor({ range: 'B4', at: 'tomorrow' })).toContain('at must be an ISO 8601 date and time (ISO 8601). For example: at: "2026-11-24T15:00:00Z".')
    expect(wordsFor({ range: 'B4', op: { kind: 'paste' } })).toContain('op.kind must be one of "insert", "clear"')
    expect(wordsFor({ range: 'B4', path: 'notes.md' })).toContain('path must be an absolute path.')
    expect(wordsFor({ range: 'B4', pick: 3 })).toContain('pick must be text. For example: pick: "B4".')
  })
  it('never the raw issue JSON, and three fields at most', () => {
    const words = wordsFor({ limit: 'x', mode: 'y', at: 'z', path: 'w' })
    expect(words).not.toMatch(/[[{]"|"code"|expected/)
    expect(words).toContain('2 more fields did not fit either.')
  })
})

describe('unknown tools', () => {
  const names = ['files_list', 'files_open', 'doc_read', 'work_connections']
  it('picks a near name of the thread’s own, or none', () => {
    expect(nearestName('file_list', names)).toBe('files_list')
    expect(nearestName('doc_raed', names)).toBe('doc_read')
    expect(nearestName('mail_send', names)).toBeNull()
  })
  it('says the tool is not in the list and to read it again', () => {
    expect(unknownToolWords('file_list', names)).toBe(
      "Nothing ran: file_list is not in this thread's tool list. A Work thread's tools depend on its workspace. Read the tool list again and call a tool it names; the nearest is files_list."
    )
    expect(unknownToolWords('mail_send', names)).not.toContain('nearest')
  })
  it('writes a path as an agent writes it back', () => {
    expect(fieldOf(['cells', 0, 'at'])).toBe('cells[0].at')
    expect(fieldOf([])).toBe('')
  })
})

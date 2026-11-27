import { describe, expect, it } from 'vitest'
import { AWAY_DENIED_KINDS, askDeciderOf, awayVerdict, decideAsk } from './away'
import { HOST_CONFIRM_KINDS } from './computer/policy'

describe('awayVerdict', () => {
  describe('a code thread: as before Work', () => {
    it('denies exactly the money kinds of a computer act', () => {
      const denied = HOST_CONFIRM_KINDS.filter((kind) => awayVerdict({ what: 'computer', kind }, 'code') === 'deny')
      expect(denied).toEqual([...AWAY_DENIED_KINDS])
      expect(AWAY_DENIED_KINDS).toEqual(['pay', 'subscribe'])
    })

    it('allows every other computer card, the password card and an unflagged act included', () => {
      expect(awayVerdict({ what: 'computer', kind: 'send' }, 'code')).toBe('allow')
      expect(awayVerdict({ what: 'computer', kind: 'password', password: true }, 'code')).toBe('allow')
      expect(awayVerdict({ what: 'computer', kind: undefined }, 'code')).toBe('allow')
      expect(awayVerdict({ what: 'computer', kind: null }, undefined)).toBe('allow')
      // the host's own reading of the screen plays no part in a code thread
      expect(awayVerdict({ what: 'computer', outward: true }, 'code')).toBe('allow')
    })

    it('allows every tool card, the add-on cards included (the host stands in for the admin)', () => {
      for (const tool of ['Bash', 'Edit', 'addon_add', 'mcp__app__addon_add', 'addon_remove', 'mcp__app__slack__post_message', 'computer_session'])
        expect(awayVerdict({ what: 'tool', tool }, 'code'), tool).toBe('allow')
      expect(awayVerdict({ what: 'tool', tool: 'addon_add' }, null)).toBe('allow')
    })
  })

  describe('a Work thread: it decides and carries on, and nothing leaves', () => {
    it('never allows a computer act the host read as outward, or the model flagged: it is held', () => {
      expect(awayVerdict({ what: 'computer', outward: true }, 'work')).toBe('hold')
      for (const kind of HOST_CONFIRM_KINDS.filter((k) => k !== 'password')) expect(awayVerdict({ what: 'computer', kind }, 'work'), kind).toBe('hold')
      // a money act is held too, never run and never silently dropped
      expect(awayVerdict({ what: 'computer', kind: 'pay', outward: true }, 'work')).toBe('hold')
    })

    it('denies text into a password field, and allows an act that is neither', () => {
      expect(awayVerdict({ what: 'computer', password: true }, 'work')).toBe('deny')
      expect(awayVerdict({ what: 'computer' }, 'work')).toBe('allow')
    })

    it('never allows adding or removing an add-on, by either name', () => {
      for (const tool of ['addon_add', 'mcp__app__addon_add', 'addon_remove', 'mcp__app__addon_remove']) expect(awayVerdict({ what: 'tool', tool }, 'work'), tool).toBe('deny')
    })

    it('allows the other cards: a shell command, an edit, an add-on tool (which the catch judges itself)', () => {
      for (const tool of ['Bash', 'Edit', 'mcp__app__slack__post_message', 'slack__post_message', 'computer_session', 'mcp__app__computer_act'])
        expect(awayVerdict({ what: 'tool', tool }, 'work'), tool).toBe('allow')
    })
  })
})

describe('decideAsk: Full access allows what Away allows, without Away', () => {
  it('names who decides: Away first, then Full access, else nobody', () => {
    expect(askDeciderOf(true, 'edits')).toBe('away')
    expect(askDeciderOf(true, 'auto')).toBe('away')
    expect(askDeciderOf(false, 'auto')).toBe('full')
    for (const permission of ['safe', 'edits', null, undefined]) expect(askDeciderOf(false, permission)).toBeNull()
  })

  it("allows under Full access every ask Away allows, for each kind of thread", () => {
    const asks = [
      { what: 'tool', tool: 'Bash' },
      { what: 'tool', tool: 'mcp__app__skill_write' },
      { what: 'tool', tool: 'slack__post_message' },
      { what: 'computer', kind: 'delete' },
      { what: 'computer', kind: null },
      { what: 'computer', password: true }
    ] as const
    for (const scope of ['code', 'work'] as const)
      for (const ask of asks) {
        const verdict = awayVerdict(ask, scope)
        expect(decideAsk('full', verdict)).toBe(verdict === 'allow' ? 'allow' : 'ask')
      }
  })

  it('still asks him under Full access what Away denies or holds, where Away answers it for him', () => {
    for (const kind of AWAY_DENIED_KINDS) {
      const verdict = awayVerdict({ what: 'computer', kind }, 'code')
      expect(decideAsk('full', verdict)).toBe('ask')
      expect(decideAsk('away', verdict)).toBe('deny')
    }
    for (const tool of ['addon_add', 'mcp__app__addon_remove']) expect(decideAsk('full', awayVerdict({ what: 'tool', tool }, 'work'))).toBe('ask')
    expect(decideAsk('full', awayVerdict({ what: 'computer', outward: true }, 'work'))).toBe('ask')
    expect(decideAsk('full', awayVerdict({ what: 'computer', password: true }, 'work'))).toBe('ask')
  })

  it('asks every card when nobody decides', () => {
    for (const verdict of ['allow', 'deny', 'hold'] as const) expect(decideAsk(null, verdict)).toBe('ask')
  })
})

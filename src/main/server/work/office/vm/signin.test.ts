import { describe, expect, it } from 'vitest'
import { ANOTHER_WAY, APPROVE, SIGN_IN_LINES, walkSignIn } from './signin'

/** The walk to his phone's number over a fake screen: what is on it after each press, and what is pressed. */

function screen(script: { after: Record<string, string[]>; start: string[]; escShows?: string[] }) {
  let on = [...script.start]
  const pressed: string[] = []
  const keys: string[] = []
  const calls: string[] = []
  return {
    pressed,
    keys,
    calls,
    deps: {
      call: async (verb: string, args?: Record<string, unknown>) => {
        calls.push(verb)
        const names = (args?.names as string[] | undefined) ?? []
        if (verb === 'onedrive.signin') {
          on = ['Sign in']
          return null
        }
        const hit = names.find((n) => on.includes(n)) ?? null
        if (verb === 'ui.seen') return hit
        if (verb === 'ui.press' && hit) {
          pressed.push(hit)
          on = script.after[hit] ?? []
        }
        return hit
      },
      key: async (...k: string[]) => {
        keys.push(...k)
        if (script.escShows) on = script.escShows
      },
      sleep: async () => {},
      waits: { first: 3, page: 12, list: 3 }
    }
  }
}

describe("OneDrive's sign-in, walked to his phone", () => {
  it("opens OneDrive's sign-in with his address, presses Sign in, sends the security-key prompt away, and asks for the number", async () => {
    const s = screen({ start: [], after: { 'Sign in': [], [ANOTHER_WAY]: [APPROVE], [APPROVE]: [] }, escShows: [ANOTHER_WAY] })
    expect(await walkSignIn('him@example.edu', s.deps)).toBe('number')
    expect(s.calls[1]).toBe('onedrive.signin')
    expect(s.pressed).toEqual(['Sign in', ANOTHER_WAY, APPROVE])
    expect(s.keys).toContain('esc')
  })
  it('takes up a sign-in left open where it stands', async () => {
    const s = screen({ start: [APPROVE], after: { [APPROVE]: [] } })
    expect(await walkSignIn(null, s.deps)).toBe('number')
    expect(s.calls).not.toContain('onedrive.signin')
  })
  it("stops at OneDrive's first screen when its button never shows, and says what to press", async () => {
    const s = screen({ start: [], after: {} })
    s.deps.call = async (verb: string) => (s.calls.push(verb), null)
    expect(await walkSignIn(null, s.deps)).toBe('first')
    expect(SIGN_IN_LINES.first).toMatch(/press Sign in/)
  })
  it("stops at Purdue's page when it offers nothing it knows: a password is never its to type", async () => {
    const s = screen({ start: [], after: { 'Sign in': ['Enter password'] } })
    expect(await walkSignIn(null, s.deps)).toBe('page')
    expect(s.pressed).toEqual(['Sign in'])
  })
  it('types nothing: every call is a look or a press by name', async () => {
    const s = screen({ start: [], after: { 'Sign in': [ANOTHER_WAY], [ANOTHER_WAY]: [APPROVE], [APPROVE]: [] } })
    await walkSignIn('him@example.edu', s.deps)
    expect(new Set(s.calls)).toEqual(new Set(['ui.seen', 'onedrive.signin', 'ui.press']))
  })
})

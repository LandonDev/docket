import { describe, expect, it } from 'vitest'
import { ANOTHER_WAY, APPROVE, followSignIn, NOT_SENT, OFFICE_SIGN_IN_LINES, SIGN_IN_LINES, THIS_APP_ONLY, walkOfficeSignIn, walkSignIn } from './signin'

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

describe("Office's sign-in, after OneDrive's", () => {
  it("starts Word and presses its title bar's Sign in, which opens Microsoft's window", async () => {
    const calls: string[] = []
    let tries = 0
    const reached = await walkOfficeSignIn({ call: async (verb) => (calls.push(verb), verb === 'ui.press' && ++tries === 3 ? 'Sign in' : null), sleep: async () => {}, waits: { first: 3, page: 1, list: 1 } })
    expect(reached).toBe('window')
    expect(calls).toEqual(['office.start', 'ui.press', 'ui.press', 'ui.press'])
    expect(OFFICE_SIGN_IN_LINES.window).toMatch(/finish it there/)
  })
  it('leaves Word open and says what to press when the button never shows', async () => {
    expect(await walkOfficeSignIn({ call: async () => null, sleep: async () => {}, waits: { first: 1, page: 1, list: 1 } })).toBe('word')
  })
})

describe('an older request still waiting on his phone', () => {
  it("says so instead of promising a number, since Microsoft sends no new request meanwhile", async () => {
    const s = screen({ start: [APPROVE], after: { [APPROVE]: [NOT_SENT[1]!, 'Next'] } })
    expect(await walkSignIn(null, s.deps)).toBe('pending')
    expect(SIGN_IN_LINES.pending).toMatch(/deny it on your phone/)
  })
})

describe('while he answers on his phone', () => {
  function world(script: (t: number) => string[]) {
    let t = 0
    const pressed: { t: number; name: string; within?: string }[] = []
    let signs: { at: number; who: string } | null = null
    return {
      pressed,
      signInAt: (at: number, who: string) => void (signs = { at, who }),
      deps: {
        call: async (verb: string, args?: Record<string, unknown>) => {
          const on = script(t)
          const hit = ((args?.names as string[]) ?? []).find((n) => on.includes(n)) ?? null
          if (verb === 'ui.press' && hit) pressed.push({ t, name: hit, ...(args?.in ? { within: args.in as string } : {}) })
          return hit
        },
        account: async () => (signs && t >= signs.at ? signs.who : null),
        sleep: async (ms: number) => void (t += ms),
        now: () => t,
        forMs: 60_000,
        everyMs: 1000
      }
    }
  }

  it("answers Microsoft's device question with \"No, this app only\" within a second of its showing, and ends once OneDrive is signed in", async () => {
    const w = world((t) => (t >= 7000 && t < 9000 ? [THIS_APP_ONLY, 'Yes'] : []))
    w.signInAt(12_000, 'him@purdue.edu')
    expect(await followSignIn(w.deps)).toBe('signed-in')
    const first = w.pressed.find((p) => p.name === THIS_APP_ONLY)
    expect(first?.t ?? (w.pressed.length ? -1 : 7000)).toBeLessThanOrEqual(8000)
    expect(w.pressed.some((p) => p.name === 'Yes')).toBe(false)
  })

  it("presses Next on \"Request wasn't sent\" every ten seconds, in the sign-in page alone, and Next in OneDrive's own setup", async () => {
    const w = world((t) => (t < 25_000 ? [NOT_SENT[0]!, 'Next'] : []))
    expect(await followSignIn(w.deps)).toBe('gave-up')
    const page = w.pressed.filter((p) => p.within === 'Microsoft.AAD.BrokerPlugin')
    expect(page.map((p) => p.t)).toEqual([0, 10_000, 20_000])
    expect(w.pressed.filter((p) => p.within === 'OneDrive').length).toBeGreaterThan(0)
    expect(w.pressed.every((p) => p.name === 'Next')).toBe(true)
  })

  it('gives up after its time, having typed nothing', async () => {
    const w = world(() => [])
    expect(await followSignIn(w.deps)).toBe('gave-up')
    expect(w.pressed).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT, ANOTHER_WAY, APPROVE, FILE_TAB, FIX_ME, followSignIn, NOT_NOW, NOT_SENT, OFFICE_WORD_LINE, oneWatchAtATime, OPEN_FOLDER, PRIVACY, readNumber, SIGN_IN_LINES, THIS_APP_ONLY, walkOfficeSignIn, walkSignIn } from './signin'

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
  /** Word's screen: what each press shows next, and the presses with the app they were kept to. */
  function word(start: string[], after: Record<string, string[]>) {
    let on = [...start]
    const pressed: string[] = []
    const keys: string[] = []
    const calls: string[] = []
    const deps = {
      call: async (verb: string, args?: Record<string, unknown>) => {
        calls.push(verb)
        if (verb === 'office.start') return null
        const hit = ((args?.names as string[] | undefined) ?? []).find((n) => on.includes(n)) ?? null
        if (verb === 'ui.press' && hit) {
          pressed.push(args?.in ? `${args.in}:${hit}` : hit)
          on = after[hit] ?? on.filter((n) => n !== hit)
        }
        return hit
      },
      key: async (...k: string[]) => void keys.push(...k),
      sleep: async () => {},
      waits: { first: 6, page: 12, list: 3 }
    }
    return { deps, pressed, keys, calls }
  }

  it("starts Word, presses its title bar's Sign in, and goes on through Microsoft's window to the number", async () => {
    const w = word(['Sign in'], { 'Sign in': [ANOTHER_WAY], [ANOTHER_WAY]: [APPROVE], [APPROVE]: [] })
    expect(await walkOfficeSignIn(w.deps)).toBe('number')
    expect(w.calls[0]).toBe('office.start')
    expect(w.pressed).toEqual(['WINWORD:Sign in', ANOTHER_WAY, APPROVE])
  })
  it('closes Word\'s privacy page first', async () => {
    const w = word([PRIVACY, 'Close', 'Sign in'], { Close: ['Sign in'], 'Sign in': [APPROVE], [APPROVE]: [] })
    expect(await walkOfficeSignIn(w.deps)).toBe('number')
    expect(w.pressed.slice(0, 2)).toEqual(['WINWORD:Close', 'WINWORD:Sign in'])
  })
  it('an account Word holds with an error is fixed from File, Account, Fix me', async () => {
    const w = word([FILE_TAB], { [FILE_TAB]: [ACCOUNT], [ACCOUNT]: [FIX_ME], [FIX_ME]: [ANOTHER_WAY], [ANOTHER_WAY]: [APPROVE], [APPROVE]: [] })
    expect(await walkOfficeSignIn(w.deps)).toBe('number')
    expect(w.pressed).toEqual([`WINWORD:${FILE_TAB}`, `WINWORD:${ACCOUNT}`, `WINWORD:${FIX_ME}`, ANOTHER_WAY, APPROVE])
  })
  it("Windows' security-key prompt over Microsoft's window is sent away with Escape", async () => {
    const w = word(['Sign in'], { 'Sign in': [] })
    w.deps.key = async (...k: string[]) => {
      w.keys.push(...k)
      w.deps.call = ((call) => async (verb: string, args?: Record<string, unknown>) => (verb === 'ui.seen' && ((args?.names as string[]) ?? []).includes(ANOTHER_WAY) ? ANOTHER_WAY : call(verb, args)))(w.deps.call)
    }
    await walkOfficeSignIn(w.deps)
    expect(w.keys).toContain('esc')
  })
  it('leaves Word open and says what to press when nothing it knows shows', async () => {
    const w = word([], {})
    expect(await walkOfficeSignIn(w.deps)).toBe('word')
    expect(OFFICE_WORD_LINE).toMatch(/press Sign in at the top of its window, or File, Account, Fix me/)
  })
})

describe('the number for his phone', () => {
  it('is read from the page when it names two or three digits, and only then', async () => {
    expect(await readNumber({ call: async () => '42' })).toBe('42')
    expect(await readNumber({ call: async () => '107' })).toBe('107')
    expect(await readNumber({ call: async () => 'Approve sign in' })).toBeNull()
    expect(await readNumber({ call: async () => null })).toBeNull()
    expect(await readNumber({ call: async () => Promise.reject(new Error('down')) })).toBeNull()
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

  it("OneDrive's tutorial is pressed to its end once the account shows, then the wanted libraries are asked", async () => {
    const w = world((t) => (t < 14_000 ? [] : t < 18_000 ? ['Next'] : t < 22_000 ? [NOT_NOW] : [OPEN_FOLDER]))
    w.signInAt(12_000, 'him@purdue.edu')
    let after = 0
    expect(await followSignIn({ ...w.deps, afterSignIn: async () => void after++ })).toBe('signed-in')
    expect(w.pressed.filter((p) => p.within === 'OneDrive').map((p) => p.name)).toEqual(expect.arrayContaining(['Next', NOT_NOW, OPEN_FOLDER]))
    expect(w.pressed.at(-1)).toMatchObject({ name: OPEN_FOLDER, within: 'OneDrive' })
    expect(after).toBe(1)
  })

  it('a tutorial that never ends still asks for the libraries after a minute', async () => {
    const w = world(() => [])
    w.signInAt(5_000, 'him@purdue.edu')
    let after = 0
    expect(await followSignIn({ ...w.deps, forMs: 120_000, afterSignIn: async () => void after++ })).toBe('signed-in')
    expect(after).toBe(1)
  })

  it('an account that shows in the last minute still has the libraries asked', async () => {
    const w = world(() => [])
    w.signInAt(55_000, 'him@purdue.edu')
    let after = 0
    expect(await followSignIn({ ...w.deps, afterSignIn: async () => void after++ })).toBe('signed-in')
    expect(after).toBe(1)
  })

  it("watching Office, ends on Office's own state and nothing else", async () => {
    const w = world(() => [])
    w.signInAt(30_000, 'licensed')
    expect(await followSignIn(w.deps)).toBe('signed-in')
    expect(w.pressed).toEqual([])
  })

  it('gives up after its time, having typed nothing', async () => {
    const w = world(() => [])
    expect(await followSignIn(w.deps)).toBe('gave-up')
    expect(w.pressed).toEqual([])
  })
})

describe('one watch at a time', () => {
  it("a watch asked for while one runs starts when it ends, the newest only: Office's waits behind OneDrive's tutorial", async () => {
    const watch = oneWatchAtATime()
    const ran: string[] = []
    let endFirst = () => {}
    watch(() => (ran.push('onedrive'), new Promise<void>((done) => (endFirst = done))))
    watch(async () => void ran.push('stale'))
    watch(async () => void ran.push('office'))
    expect(ran).toEqual(['onedrive'])
    endFirst()
    await vi.waitFor(() => expect(ran).toEqual(['onedrive', 'office']))
  })
})

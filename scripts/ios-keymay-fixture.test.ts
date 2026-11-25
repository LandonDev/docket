import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { capabilityRefusal, type Capability } from '../src/shared/capabilities'
import { RELAY_BOX_LOCAL, RELAY_METHODS, relayRefusal } from '../src/shared/contract-relay'
import type { ClientRequest } from '../src/shared/contract'
import type { HostPresence } from '../src/shared/contract-relay'
import { DEVICE_CAPS } from '../src/main/server/devices/binding'
import { rules } from '../src/main/server/work/rules'
import { mail } from '../src/main/server/work/mail'
import { messages } from '../src/main/server/work/messages'
import { clashes } from '../src/main/server/work/clashes'
import { forms } from '../src/main/server/work/forms'
import { msforms } from '../src/main/server/work/msforms'
import { review } from '../src/main/server/work/review'
import type { Caller, WorkCtx } from '../src/main/server/work/modules'

/* The phone's KeyMay (ios/TempCodeClient/Sources/TempCodeClient/Work/Shell/KeyMay.swift)
 * draws a press only where the host would allow it. This test computes, from the
 * host's own rules, the answer for every method in KeyMay's table and every kind
 * of key, and holds Fixtures/keymay.json to it: a host change not carried to the
 * phone fails here, and KeyMayTests fails the phone that differs from the file.
 * UPDATE_FIXTURES=1 writes the file. */

const ROOT = resolve(__dirname, '..')
const KEYMAY = join(ROOT, 'ios/TempCodeClient/Sources/TempCodeClient/Work/Shell/KeyMay.swift')
const FIXTURE = join(ROOT, 'ios/TempCodeClient/Tests/TempCodeClientTests/Fixtures/keymay.json')

const KEYS: Record<string, { caps: Capability[]; revoked?: true }> = {
  read: { caps: ['read'] },
  operate: { caps: ['read', 'operate'] },
  approve: { caps: ['read', 'approve'] },
  admin: { caps: ['read', 'admin'] },
  operateApprove: { caps: ['read', 'operate', 'approve'] },
  operateApproveAdmin: { caps: ['read', 'operate', 'approve', 'admin'] },
  device: { caps: [...DEVICE_CAPS] },
  pending: { caps: ['pending'] },
  // auth.ts `verify` refuses a revoked key at the door, before any method
  revoked: { caps: [], revoked: true }
}

/** KeyMay's rows: `case x = "method"` or `"method?k=v"`. */
function keyMayMethods(): { raw: string; method: string; params?: Record<string, string> }[] {
  const text = readFileSync(KEYMAY, 'utf8')
  return [...text.matchAll(/^\s+case \w+ = "([^"]+)"$/gm)].map(([, raw]) => {
    const [method, query] = raw!.split('?') as [string, string | undefined]
    return query ? { raw: raw!, method, params: Object.fromEntries(new URLSearchParams(query)) } : { raw: raw!, method }
  })
}

/** A ctx that throws on any touch: a handler that reaches it has passed its person check. */
const TOUCHED = 'ctx touched'
const junkCtx = new Proxy({}, { get: () => { throw new Error(TOUCHED) } }) as unknown as WorkCtx

/**
 * The Outbox's person words, read from its handler's own source: each case's
 * `mustBePerson(by, '<word>')`. Its handler opens its host before the switch,
 * so a ctx that throws on touch cannot probe it as it probes the others.
 */
function outboxWords(): Record<string, 'approve' | 'admin'> {
  const text = readFileSync(join(ROOT, 'src/main/server/work/outbox/index.ts'), 'utf8')
  const parts = text.split(/^\s+case '(work\.outbox\.[\w.]+)':/m)
  const words: Record<string, 'approve' | 'admin'> = {}
  // parts: [before, name, body, name, body, …]; a label with an empty body falls through to the next one's.
  let below: 'approve' | 'admin' | undefined
  for (let i = parts.length - 2; i >= 1; i -= 2) {
    const body = parts[i + 1]!
    const word = /mustBePerson\(by, '(approve|admin)'\)/.exec(body)?.[1] as 'approve' | 'admin' | undefined
    const own = body.replace(/[\s{]/g, '') === '' ? below : word
    if (own) words[parts[i]!] = own
    below = own
  }
  return words
}
const OUTBOX_PERSON = outboxWords()

/**
 * Put Back's word, read from its source: `admitRestore` (files/handle.ts) asks operate on a phone's key itself, past
 * reads of the workspace a ctx that throws on touch cannot pass.
 */
function restoreWord(): 'operate' | null {
  const text = readFileSync(join(ROOT, 'src/main/server/work/files/handle.ts'), 'utf8')
  const body = /async function admitRestore[\s\S]*?\n}\n/.exec(text)?.[0] ?? ''
  return /by\.caps\.includes\('operate'\)/.test(body) ? 'operate' : null
}
const RESTORE_WORD = restoreWord()

/** The clicker's press word, read from its source: `refuse` (slides/clicker.ts) asks operate on a phone's key itself. */
function clickerWord(): 'operate' | null {
  const text = readFileSync(join(ROOT, 'src/main/server/work/slides/clicker.ts'), 'utf8')
  const body = /function refuse[\s\S]*?\n}\n/.exec(text)?.[0] ?? ''
  return /by\.caps\.includes\('operate'\)/.test(body) ? 'operate' : null
}
const CLICKER_WORD = clickerWord()

/** A row's `?k=v` as the wire carries it: `true` and `false` are booleans. */
const typed = (params: Record<string, string> = {}): Record<string, unknown> =>
  Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : v]))

/** Ids a pillar's schema parses before its person check (a Microsoft form's id is Forms' own alphabet). */
const FILLER: Record<string, Record<string, unknown>> = {
  'work.forms.': { itemId: 'item' },
  'work.msforms.': { workspaceId: 'w', formId: 'f'.repeat(24), emails: ['a@example.com'] }
}

/** The literal word a handler's person check asks, read by running the handler (null: none). */
async function probeWord(method: string, params?: Record<string, string>): Promise<'operate' | 'approve' | 'admin' | null> {
  const fromOutbox = OUTBOX_PERSON[method]
  if (fromOutbox) return fromOutbox
  if (method === 'work.files.restore') return RESTORE_WORD
  if (method === 'work.slides.show.press') return CLICKER_WORD
  const module = method.startsWith('work.rules.') ? rules : method.startsWith('work.mail.') ? mail : method.startsWith('work.messages.') ? messages : method.startsWith('work.clashes.') ? clashes : method.startsWith('work.forms.') ? forms : method.startsWith('work.msforms.') ? msforms : method.startsWith('work.review.') ? review : null
  if (!module) return null
  const filler = Object.entries(FILLER).find(([prefix]) => method.startsWith(prefix))?.[1] ?? {}
  const thrown = async (caps: string[]): Promise<string> => {
    try {
      await module.handle!({ id: '1', method, params: { ...filler, ...typed(params) } } as never, junkCtx, { kind: 'remote', audience: 'client', caps } as Caller)
      return TOUCHED
    } catch (err) {
      return (err as Error).message
    }
  }
  // A key with only read either reaches the ctx (no person check) or meets the refusal's words.
  const refusal = await thrown(['read'])
  if (refusal === TOUCHED) return null
  const all = ['read', 'operate', 'approve', 'admin']
  // With every word the person check passes: the handler goes on to the ctx, or fails later in words of its own.
  expect(await thrown(all), `${method} with every word`).not.toBe(refusal)
  for (const word of ['operate', 'approve', 'admin'] as const) if ((await thrown(all.filter((c) => c !== word))) === refusal) return word
  throw new Error(`${method}: a person check that wants no single word`)
}

const presence = (screen: 'unlocked' | 'locked'): Pick<HostPresence, 'link' | 'screen' | 'power' | 'since'> => ({ link: 'up', screen, power: 'awake', since: 0 })

/** relay.ts: the box's own rows, video.open and video.close answered by the box, RELAY_METHODS forwarded, the rest refused. */
function relayClass(method: string): 'link' | 'screen' | 'box' | 'never' {
  if ((RELAY_BOX_LOCAL as readonly string[]).includes(method) || method === 'video.open' || method === 'video.close') return 'box'
  return RELAY_METHODS[method as ClientRequest['method']] ?? 'never'
}

function crosses(method: string, locked: boolean): boolean {
  const relay = relayClass(method)
  if (relay === 'box') return true
  if (relay === 'never') return false
  return relayRefusal(presence(locked ? 'locked' : 'unlocked') as HostPresence, relay, 0) === null
}

async function compute(): Promise<unknown> {
  const rows = []
  for (const { raw, method, params } of keyMayMethods()) {
    const req = { method: method as ClientRequest['method'], ...(params ? { params: typed(params) } : {}) }
    const word = await probeWord(method, params)
    const may = (key: { caps: Capability[]; revoked?: true }): boolean =>
      !key.revoked && capabilityRefusal(key.caps, req) === null && (word === null || key.caps.includes(word))
    const allowed = Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [name, may(key)]))
    const full = may(KEYS.operateApproveAdmin!)
    rows.push({ method: raw, word, relay: relayClass(method), allowed, relayed: full && crosses(method, false), relayedLocked: full && crosses(method, true) })
  }
  return { keys: Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [name, key])), rows }
}

/** Wire names of every `Methods.X` the phone's sources name. */
function phoneMethods(): string[] {
  const generated = readFileSync(join(ROOT, 'ios/TempCodeContract/Sources/TempCodeContract/Generated/Methods.swift'), 'utf8')
  const names = new Map<string, string>()
  let current = ''
  for (const line of generated.split('\n')) {
    const e = /public enum (\w+): ContractMethod/.exec(line)
    if (e) current = e[1]!
    const n = /static let name = "([^"]+)"/.exec(line)
    if (n && current) names.set(current, n[1]!)
  }
  const used = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.swift')) for (const [, m] of readFileSync(path, 'utf8').matchAll(/Methods\.(\w+)\.self/g)) used.add(m!)
    }
  }
  walk(join(ROOT, 'ios/TempCode/Sources'))
  walk(join(ROOT, 'ios/TempCodeClient/Sources'))
  return [...used].map((m) => names.get(m)).filter((m): m is string => !!m)
}

describe('KeyMay fixture', () => {
  it('matches what the host allows for every method and key', async () => {
    const computed = `${JSON.stringify(await compute(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, computed)
    expect(readFileSync(FIXTURE, 'utf8'), 'run with UPDATE_FIXTURES=1, then carry the change to KeyMay.swift').toBe(computed)
  })

  it('has a row for every Work, Away, video and computer method the phone calls', () => {
    const rows = new Set(keyMayMethods().map((r) => r.method))
    const missing = phoneMethods().filter((m) => /^(work\.|away\.|video\.|computer\.|workspace\.create$|attachment\.)/.test(m) && !rows.has(m))
    expect(missing).toEqual([])
  })

  it('reads each person check from its handler', async () => {
    expect(await probeWord('work.outbox.send')).toBe('approve')
    expect(await probeWord('work.outbox.grant')).toBe('admin')
    for (const method of ['decide', 'requests', 'request.get', 'request.view', 'decline'])
      expect(await probeWord(`work.outbox.${method}`)).toBe('approve')
    expect(await probeWord('work.rules.add')).toBe('approve')
    expect(await probeWord('work.mail.send')).toBe('approve')
    expect(await probeWord('work.mail.nudge')).toBe('operate')
    for (const method of ['send', 'attempt', 'undo', 'retry']) expect(await probeWord(`work.messages.${method}`)).toBe('approve')
    expect(await probeWord('work.messages.dropDraft')).toBe('operate')
    for (const method of ['search', 'unread', 'drafts', 'unanswered']) expect(await probeWord(`work.messages.${method}`)).toBeNull()
    expect(await probeWord('work.rules.list')).toBeNull()
    // Reopening a form starts it taking answers again: approve on the key itself; closing asks no word past the door.
    expect(await probeWord('work.forms.close', { open: 'true' })).toBe('approve')
    expect(await probeWord('work.forms.close', { open: 'false' })).toBeNull()
    expect(await probeWord('work.msforms.close', { open: 'true' })).toBe('approve')
    expect(await probeWord('work.msforms.close', { open: 'false' })).toBeNull()
    // Review's every call but `ready` asks approve on the key itself; Put Back asks operate on it.
    for (const method of ['week', 'list', 'settle', 'undo', 'seen']) expect(await probeWord(`work.review.${method}`)).toBe('approve')
    expect(await probeWord('work.review.ready')).toBeNull()
    expect(await probeWord('work.files.restore')).toBe('operate')
    expect(await probeWord('work.slides.show.press')).toBe('operate')
  })
})

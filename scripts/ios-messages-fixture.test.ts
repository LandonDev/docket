import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAT_REPLY_MAX, CHAT_ROUTES, CHAT_SOURCES, fileMarkers, firstWords, OWN_REPLY_HELD, REPLY_MAY_HAVE_GONE, replyWhere, SOURCE_APP, SOURCE_NAME, staleOf, syncLine, type ChatRow, type ChatSourceState } from '../src/shared/work/messages'
import { chatFact, rowLine, wantsRead } from '../src/renderer/src/work/messages/model'
import { threadCanvasOf } from '../src/shared/work/files'

/* The phone's Messages rules (ios/TempCodeClient/Sources/TempCodeClient/Work/Messages/MessagesRules.swift) are a port
 * of src/shared/work/messages.ts and the desktop view's row rules. This test writes the desktop's answers for a set of
 * inputs to Fixtures/messages/rules.json and holds the file to them; MessagesRulesTests replays the same inputs on the
 * phone's port. UPDATE_FIXTURES=1 writes the file. Times are read in UTC on both sides. */

const ROOT = resolve(__dirname, '..')
const FIXTURE = join(ROOT, 'ios/TempCodeClient/Tests/TempCodeClientTests/Fixtures/messages/rules.json')

const NOW = Date.UTC(2026, 10, 24, 18, 30)
const MIN = 60_000
const HOUR = 60 * MIN

const row = (over: Partial<ChatRow>): ChatRow => ({
  _id: 'c1', source: 'slack', account: 'T1', channel: 'D1', name: 'Dana Lee', kind: 'direct', sector: 'cosmic', lastAt: NOW,
  lastText: 'Can you look?', lastWho: 'Dana Lee', lastFromMe: false, unread: false, faces: [], ...over
})
const src = (over: Partial<ChatSourceState>): ChatSourceState => ({ kind: 'slack', label: 'Slack', status: 'ok', ...over })

/** A chat's files: which canvas kind opens each beside its conversation. */
const FILES: [string, string?][] = [
  ['plan.pdf'], ['Brief.DOCX'], ['budget.xlsx'], ['data.csv'], ['deck.pptx'], ['photo.HEIC'], ['clip.mov'], ['memo.m4a'],
  ['notes.md'], ['readme.txt'], ['script.py'], ['bundle.zip'], ['logo.svg'], ['macro.docm'], ['noext', 'application/pdf'],
  ['noext', 'image/png'], ['noext', 'text/plain'], ['noext'], ['.hidden'], ['folder/inner.pdf'], ['odd.weird']
]

function compute(): unknown {
  const words = [
    ['Short words', 60],
    ['  Lots   of\nspace  here  ', 60],
    ['This sentence runs on for a good while past the cut so it is cut at a word', 40],
    ['Averyveryverylongwordwithnospacesatallthatgoesonpastthecut and more', 20],
    ['Edge of the cut exactly here', 28]
  ] as const
  const files = [
    ['See the plan [file: plan.pdf]', ['plan.pdf']],
    ['Look\nplan.pdf https://cdn.discordapp.com/a/b/plan.pdf', ['plan.pdf']],
    ['Sent an attachment: a.png, b.png', ['a.png', 'b.png']],
    ['Sent an attachment: a.png, c.png', ['a.png', 'b.png']],
    ['[file: spec.pdf] is what I typed', ['spec.pdf']],
    ['Two [file: a.txt] [file: b.txt]', ['a.txt', 'b.txt']],
    ['No files here', []],
    ['Words\n\n\n\nand more [file: x(1).png]', ['x(1).png']]
  ] as const
  const sources: ChatSourceState[][] = [
    [src({ lastSyncAt: NOW - 5 * MIN })],
    [src({ lastSyncAt: NOW - 20 * MIN })],
    [src({ kind: 'discord', label: 'Discord', lastSyncAt: NOW - 3 * 24 * HOUR }), src({ kind: 'imessage', label: 'iMessage', reportedAt: NOW - 40 * HOUR })],
    [src({ kind: 'teams', label: 'Teams', status: 'idle' })],
    [src({ status: 'error', lastSyncAt: NOW - MIN, error: 'token revoked' })],
    [src({ kind: 'discord', label: 'D1', lastSyncAt: NOW - 2 * HOUR }), src({ kind: 'discord', label: 'D2', lastSyncAt: NOW - 2 * MIN })],
    [src({ kind: 'imessage', label: 'iMessage', lastSyncAt: NOW - 30 * HOUR })]
  ]
  const rows: ChatRow[] = [
    row({}),
    row({ lastFromMe: true, lastText: 'On it.' }),
    row({ kind: 'channel', name: '#builds', lastWho: 'Omar Reyes', lastText: 'Shipped\n the build' }),
    row({ kind: 'group', lastWho: '', lastText: 'hi' }),
    row({ accountName: 'CosmicGames' }),
    row({ source: 'imessage', accountName: 'iMessage' }),
    row({ unread: true }),
    row({ lastInAt: NOW, readAt: NOW - MIN }),
    row({ lastInAt: NOW - HOUR, readAt: NOW - MIN }),
    row({ lastInAt: NOW, sourceReadAt: NOW + MIN }),
    row({ lastInAt: NOW, lastOutAt: NOW + MIN })
  ]
  return {
    now: NOW,
    zone: 'UTC',
    ownReplyHeld: OWN_REPLY_HELD,
    replyMax: CHAT_REPLY_MAX,
    mayHaveGone: REPLY_MAY_HAVE_GONE,
    sources: CHAT_SOURCES.map((s) => ({ source: s, name: SOURCE_NAME[s], app: SOURCE_APP[s], route: CHAT_ROUTES[s], replyWhere: replyWhere(s, 'Dana Lee') })),
    firstWords: words.map(([text, max]) => ({ text, max, out: firstWords(text, max) })),
    fileMarkers: files.map(([text, names]) => ({ text, names, out: fileMarkers(text, names.map((name) => ({ name }))) })),
    stale: sources.flat().map((s) => ({ source: s, out: staleOf(s, NOW) })),
    syncLine: sources.map((list) => ({ sources: list, out: syncLine(list, NOW) })),
    rows: rows.map((r) => ({ row: r, line: rowLine(r), fact: chatFact(r), wantsRead: wantsRead(r) })),
    files: FILES.map(([name, type]) => ({ name, ...(type ? { type } : {}), kind: threadCanvasOf(name, type) }))
  }
}

describe('Messages fixture', () => {
  it("holds the phone's port to the desktop's rules", () => {
    const previous = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      const computed = `${JSON.stringify(compute(), null, 2)}\n`
      if (process.env.UPDATE_FIXTURES === '1') {
        mkdirSync(dirname(FIXTURE), { recursive: true })
        writeFileSync(FIXTURE, computed)
      }
      expect(readFileSync(FIXTURE, 'utf8'), 'run with UPDATE_FIXTURES=1, then carry the change to MessagesRules.swift').toBe(computed)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
})

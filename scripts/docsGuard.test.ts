import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '../src/shared/contract'
import { citations, expandBraces, sectionOf, wireNames } from './lib/docsCitations'

const REPO = resolve(__dirname, '..')

/** The docs/agents files (CLAUDE.md sections until the split) the docs sweep wrote, whose citations must stay true. */
export const GUARDED_SECTIONS = ['docs/agents/add-ons.md', 'docs/agents/skills.md', 'docs/agents/computer-use.md']

describe('the citation extractor', () => {
  const fixture = [
    'The host is src/main/server/addons/ (`addonHost.ts`), proof `bun run script:e2e-addons`.',
    'Run `bun run gate --tier publish` or bun run computer:test; `bun run scripts/x.ts` is a file.',
    'Pure parts in src/shared/{addons,skills}.ts, the wire in `src/shared/contract-addons.ts`,',
    'globs like scripts/e2e-*.ts and `<userData>/harness/` are skipped, and so is docs/<name>.md.',
    'See docs/box.md "Add-ons", docs/computer-protocol.md §17. A path ends a sentence: native/tc-computer/README.md.',
    'Not paths: ~/.claude/skills, the person`s skills/synced, aliax-core/src/adapters/addon.ts.'
  ].join('\n')

  it('finds script entries and bun run names, never a file run', () => {
    expect(citations(fixture).scripts).toEqual(['script:e2e-addons', 'gate', 'computer:test'])
  })

  it('finds paths under the repo roots, drops trailing punctuation, expands one brace and skips globs and placeholders', () => {
    expect(citations(fixture).paths).toEqual([
      'src/main/server/addons/',
      'scripts/x.ts',
      'src/shared/addons.ts',
      'src/shared/skills.ts',
      'src/shared/contract-addons.ts',
      'docs/box.md',
      'docs/computer-protocol.md',
      'native/tc-computer/README.md'
    ])
  })

  it('expands one level of braces', () => {
    expect(expandBraces('src/main/server/{headroom,accountScore}.ts')).toEqual(['src/main/server/headroom.ts', 'src/main/server/accountScore.ts'])
    expect(expandBraces('src/a.ts')).toEqual(['src/a.ts'])
  })

  it('cuts a section at the next heading, and answers null for a missing one', () => {
    const md = '# T\n## One\na\nb\n## Two\nc\n'
    expect(sectionOf(md, 'One')).toBe('a\nb')
    expect(sectionOf(md, 'Two')).toBe('c\n')
    expect(sectionOf(md, 'Three')).toBeNull()
  })
})

describe("the guarded docs/agents files cite what exists", () => {
  const scripts = new Set(Object.keys((JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts))

  for (const file of GUARDED_SECTIONS) {
    it(file, () => {
      const path = join(REPO, file)
      expect(existsSync(path), `${file} is missing`).toBe(true)
      // The file's body after its title, the section as it read in CLAUDE.md.
      const text: string | null = readFileSync(path, 'utf8').replace(/^# [^\n]*\n/, '')
      const heading = file
      const cited = citations(text!)
      const missing = [
        ...cited.scripts.filter((s) => !scripts.has(s)).map((s) => `script entry ${s}`),
        ...cited.paths.filter((p) => !existsSync(join(REPO, p))).map((p) => `path ${p}`)
      ]
      expect(missing, `"${heading}" cites what is missing:\n  ${missing.join('\n  ')}`).toEqual([])
      expect(cited.paths.length + cited.scripts.length).toBeGreaterThan(0)
    })
  }
})

describe('the wire-name extractor', () => {
  it('finds work.<pillar>.<method> names in code spans, braces expanded, and leaves out code calls, globs and placeholders', () => {
    const md = [
      'Ask `work.files.threads {workspaceId, ref}` and `work.docs.{open, close}`; the push `work.files`.',
      'Not `work.tools.of(session)`, `work.test.ts`, `work.office.files*`, `work.<pillar>.<verb>` or work.files.plain outside a span.',
      'Two in one span: `work.capture.add` then `work.pdf.open`.'
    ].join('\n')
    expect(wireNames(md)).toEqual(['work.files.threads', 'work.docs.open', 'work.docs.close', 'work.capture.add', 'work.pdf.open'])
  })
})

/**
 * Names a Work doc writes that are no wire name at all: a key the code keeps under the same spelling. Each says where;
 * the test holds the key to its file, so a key that goes leaves this list too.
 */
const NOT_WIRE: Record<string, string> = {
  'work.canvas.view.v1': 'src/renderer/src/work/canvas/store.ts', // localStorage
  'work.files.view.v1': 'src/renderer/src/work/files/store.ts', // localStorage
  'work.projects.place.v1': 'src/renderer/src/work/projects/place.ts', // localStorage
  'work.return.v1': 'src/renderer/src/lib/workReturn.ts', // localStorage
  'work.digest.closed': 'src/renderer/src/work/digest/DigestHost.tsx', // localStorage
  'work.digest.dismissed': 'src/renderer/src/work/digest/DigestHost.tsx', // localStorage
  'work.digest.seen.pending': 'src/renderer/src/work/digest/store.ts', // localStorage
  'work.prep.aheadOffer': 'src/renderer/src/work/prep/PrepView.tsx', // localStorage
  'work.today.opened.v1': 'src/renderer/src/work/today/warm.tsx', // localStorage
  'work.capture.draft': 'ios/TempCodeClient/Sources/TempCodeClient/Work/Capture/VoiceNote.swift', // the phone's defaults
  'work.lifeos.jwks': 'src/main/server/work/service/ctx.ts', // a host setting
  'work.google.clientId': 'src/main/server/work/google/picker.ts', // a host setting
  'work.guests.origin': 'src/main/server/work/service/config.ts', // a host setting
  'work.winvm.sleepAfter': 'src/main/server/work/winvm/index.ts', // a host setting
  'work.winvm.screen': 'src/main/server/work/winvm/index.ts', // a host setting
  'work.winvm.detail': 'src/main/server/work/winvm/index.ts', // a host setting
  'work.ownerName': 'src/main/server/work/preamble.ts', // a host setting
  'work.office.rangeWrite': 'src/main/server/work/peer.ts' // a peer call between hosts (`ctx.peer`), not a client request
}

/** Wire names a doc itself says are gone, never built or only sketched. Each carries the doc's words. */
const NOT_A_REQUEST: Record<string, string> = {
  'work.sheets.chart': 'work-sheets.md: "The old bars, `work.sheets.chart` and `SheetChart` are gone"',
  'work.collab.token': 'work-service.md: "There is no `work.collab.token` wire method" (the plan\'s sketch)',
  'work.pdf.list': 'work-pdf.md: "There is no `work.pdf.list`"',
  'work.fullEditor.origin': 'work-sheets.md: a setting removed on 2026-11-24',
  'work.files.changed': 'work-today.md: "Files has not built `work.files.changed`"'
}

describe('the Work docs name only wire methods that exist', () => {
  const methods = new Set((ClientRequestSchema.options as { shape: { method: { value: string } } }[]).map((o) => o.shape.method.value))
  const shared = join(REPO, 'src/shared')
  const pushes = new Set(
    readdirSync(shared)
      .filter((f) => /^contract.*\.ts$/.test(f) && !f.includes('.test.'))
      .flatMap((f) => [...readFileSync(join(shared, f), 'utf8').matchAll(/push: '(work[^']*)'/g)].map((m) => m[1]))
  )
  const docs = readdirSync(join(REPO, 'docs/agents')).filter((f) => /^work.*\.md$/.test(f))

  it('reads the contract and the docs', () => {
    expect(methods.size).toBeGreaterThan(500)
    expect(pushes.has('work.office.files')).toBe(true)
    expect(docs.length).toBeGreaterThan(30)
  })

  it('keeps each name that is no wire method where the list says', () => {
    for (const [key, file] of Object.entries(NOT_WIRE)) expect(readFileSync(join(REPO, file), 'utf8'), `${key} in ${file}`).toMatch(new RegExp(`['"\`]${key.replace(/\./g, '\\.')}['"\`]`))
    for (const name of Object.keys(NOT_A_REQUEST)) expect(methods.has(name), `${name} is a request now: take it off NOT_A_REQUEST`).toBe(false)
  })

  for (const doc of docs) {
    it(doc, () => {
      const unknown = wireNames(readFileSync(join(REPO, 'docs/agents', doc), 'utf8')).filter((n) => !methods.has(n) && !pushes.has(n) && !(n in NOT_WIRE) && !(n in NOT_A_REQUEST))
      expect(unknown, `${doc} names a work.* method no contract has. Fix the doc, or, if the doc says it is gone or a sketch, add it to NOT_A_REQUEST with those words:\n  ${unknown.join('\n  ')}`).toEqual([])
    })
  }
})

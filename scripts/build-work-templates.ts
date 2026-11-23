import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptySidecar } from 'work-kit/formats'
import { writeDocx } from 'work-kit/formats/docx'
import type { WorkScope } from '../src/shared/work'
import type { ToolCtx } from '../src/main/server/work/modules'
import { DECKS } from '../src/main/server/work/templates/starters/decks'
import { DOCS } from '../src/main/server/work/templates/starters/docs'
import { themeDocx } from '../src/main/server/work/templates/starters/docx'
import { STARTERS, starterFile, starterKey, type Starter } from '../src/main/server/work/templates/starters/manifest'
import { SHEETS } from '../src/main/server/work/templates/starters/sheets'
import { writeXlsx } from '../src/main/server/work/templates/starters/xlsx'

/**
 * Builds our starter templates into resources/work-templates/<sector>/<Name>.<form>
 * (docs/agents/work-templates.md "The starters"). Run by hand, never at build
 * time, and check in what it writes:
 *
 *   bun --preload ./scripts/lib/electron-stub.ts scripts/build-work-templates.ts
 *
 * Documents go through work-kit's writeDocx and the starters' theme pass,
 * sheets through the starters' own writer: both are the same bytes on every
 * run. Decks are made by the slides pillar's own `slides_new` and kept as it
 * writes them; pptxgenjs stamps the time into the zip and the deck's
 * properties, so a deck differs from run to run in those bytes alone.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'resources', 'work-templates')

async function document(s: Starter): Promise<Uint8Array> {
  const fixture = DOCS[starterKey(s)]
  if (!fixture) throw new Error(`No document fixture for ${starterKey(s)}.`)
  const { blocks, header, footer } = fixture()
  const sidecar = emptySidecar()
  if (header) sidecar.page.headers.push(header)
  if (footer) sidecar.page.footers.push(footer)
  return themeDocx(await writeDocx(blocks, sidecar, { title: s.name, now: () => new Date('2026-01-01T00:00:00Z') }))
}

function sheet(s: Starter): Uint8Array {
  const fixture = SHEETS[starterKey(s)]
  if (!fixture) throw new Error(`No sheet fixture for ${starterKey(s)}.`)
  return writeXlsx(fixture())
}

async function deck(s: Starter, scratch: string): Promise<string> {
  const input = DECKS[starterKey(s)]
  if (!input) throw new Error(`No deck fixture for ${starterKey(s)}.`)
  const { slides } = await import('../src/main/server/work/slides')
  const scope = { workspaceId: 'w1', sector: null } as unknown as WorkScope
  const tool = slides.tools!(scope).find((t) => t.name === 'slides_new')!
  const save = join(scratch, `${s.sector}-${s.slug}.pptx`)
  const ctx = {
    host: 'env_build',
    sessionId: 's1',
    // The scratch folder stands for the app's own data: a deck saved there is his and shared with no one (files/policy.ts sharedOf).
    dataDir: scratch,
    scope,
    signal: new AbortController().signal,
    log: () => {},
    canvas: { open: () => ({ id: 'item_1', sessionId: 's1', kind: 'slides', title: input.title, source: { at: 'file', host: 'env_build', path: save } }) }
  } as unknown as ToolCtx
  const said = await tool.run({ ...input, save }, ctx)
  if (said.isError) throw new Error(`slides_new refused ${starterKey(s)}: ${JSON.stringify(said.content)}`)
  return save
}

const scratch = mkdtempSync(join(tmpdir(), 'work-templates-'))
try {
  const wanted = new Set(STARTERS.map(starterFile))
  for (const s of STARTERS) {
    const file = join(out, starterFile(s))
    mkdirSync(dirname(file), { recursive: true })
    if (s.form === 'docx') writeFileSync(file, await document(s))
    else if (s.form === 'xlsx') writeFileSync(file, sheet(s))
    else copyFileSync(await deck(s, scratch), file)
    console.log(`wrote ${starterFile(s)}`)
  }
  // A starter taken out of the manifest leaves no file behind.
  for (const sector of existsSync(out) ? readdirSync(out) : []) {
    for (const name of readdirSync(join(out, sector))) {
      if (!wanted.has(`${sector}/${name}`)) {
        rmSync(join(out, sector, name))
        console.log(`removed ${sector}/${name}`)
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

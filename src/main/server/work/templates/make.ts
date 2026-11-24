import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FolderRef } from '@shared/work/files'
import { errorText } from '@shared/work/ids'
import { dayOf, fieldKey, fieldValues, filledValues, madeTitle, type TemplateForm, type TemplateMade } from '@shared/work/templates'
import type { Caller, WorkCtx } from '../modules'
import { fillDeck } from './deckFill'
import { lookOf, type LookOf } from './look'
import { fillOffice, isOfficeForm, scanOffice, type OfficeForm } from './ooxml'
import { OUT_OF_REACH, placeFile, type Pillars } from './place'
import { exportWord } from './save'
import { ownerName, reachesFile, resolveTemplate, scratchRoot, tcdocEveryField, type ShelfEntry } from './shelf'

/**
 * Making a file from a template (docs/agents/work-templates.md "Making a
 * file"): one path for the shelf, Files' New, the tools and the other
 * pillars. The template is copied to a scratch folder, filled there, named
 * and put in its place; the scratch folder goes whatever happens. Opening
 * the file is the caller's.
 */

export interface MakeAsk {
  workspaceId: string
  /** an id, a starter's key, or a name */
  template: string
  into?: FolderRef
  fields?: Readonly<Record<string, string>>
  /** the caller's day, `YYYY-MM-DD`; this host's own when absent */
  today?: string
  title?: string
}

export interface MakeDeps {
  look?: LookOf
  pillars?: Pillars
  now?: () => Date
  signal?: AbortSignal
}

export const GONE = (name: string): string => `The file of the template "${name}" is gone.`

/**
 * Fills the scratch copy; a file that cannot be filled is left the plain copy it is. The filled file is written
 * whole beside the copy and only then takes its place, so a write cut short (a full disk) leaves the copy as it
 * was, never a file cut short that would be placed as made.
 */
async function fill(ctx: Pick<WorkCtx, 'convert' | 'log'>, entry: ShelfEntry, form: OfficeForm, scratch: string, values: ReadonlyMap<string, string>, today: string, signal?: AbortSignal): Promise<void> {
  const out = `${scratch}.filled.${form}`
  try {
    if (form === 'docx' || form === 'xlsx') {
      const filled = fillOffice(form, new Uint8Array(readFileSync(scratch)), values, { today })
      if (filled.changed.length) {
        await writeFile(out, filled.bytes)
        await rename(out, scratch)
      }
    } else {
      // The slides pillar writes the deck: to a second file, which then takes the scratch copy's place.
      const said = await fillDeck(ctx, scratch, out, values, signal)
      if (said.filled) await rename(out, scratch)
      for (const w of said.warnings) ctx.log(`templates: ${entry.name}: ${w}`)
    }
  } catch (err) {
    if (signal?.aborted) throw err
    // What it still holds is named in `unfilled`, so the gap is plain.
    ctx.log(`templates: ${entry.name} was not filled: ${errorText(err)}`)
  } finally {
    await rm(out, { force: true })
  }
}

/** The fields still in a file as written. */
function unfilledOf(form: TemplateForm, scratch: string): string[] {
  if (form === 'tcdoc') return tcdocEveryField(scratch)
  if (!isOfficeForm(form)) return []
  try {
    return scanOffice(form, new Uint8Array(readFileSync(scratch)))
  } catch {
    return []
  }
}

/**
 * The scratch file a make fills, and its form. Our own document with a field (a Word template he edited, which the
 * document kind keeps as a `.tcdoc` beside it, `ShelfEntry.twin`) is made Word first, through the formats pillar's
 * export, so it is filled as every Word file is and the made file is Word. Where the export does not answer it is
 * the plain copy, its fields named in `unfilled`.
 */
async function scratchOf(ctx: WorkCtx, by: Caller, entry: ShelfEntry, dir: string, deps: MakeDeps): Promise<{ scratch: string; form: TemplateForm }> {
  const copy = async (form: TemplateForm): Promise<string> => {
    const scratch = join(dir, `template.${form}`)
    try {
      await copyFile(entry.path, scratch)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(GONE(entry.name))
      throw err
    }
    return scratch
  }
  if (entry.form !== 'tcdoc' || !tcdocEveryField(entry.path).length) return { scratch: await copy(entry.form), form: entry.form }
  const word = join(dir, 'template.docx')
  try {
    await exportWord(ctx, by, entry.source, word, { ...(deps.pillars ? { pillars: deps.pillars } : {}), ...(deps.signal ? { signal: deps.signal } : {}) })
    return { scratch: word, form: 'docx' }
  } catch (err) {
    if (deps.signal?.aborted) throw err
    ctx.log(`templates: ${entry.name} is made as it is: its Word export did not answer: ${errorText(err)}`)
    await rm(word, { force: true })
    return { scratch: await copy('tcdoc'), form: 'tcdoc' }
  }
}

export async function makeFromShelf(ctx: WorkCtx, by: Caller, ask: MakeAsk, deps: MakeDeps = {}): Promise<TemplateMade> {
  const { shelf, entry } = resolveTemplate(ctx, ask.workspaceId, ask.template)
  const { workspace } = shelf
  // A key names a template by id, never by path: what it may reach is asked of the folders the make reads and writes.
  if (by.kind === 'remote' && !by.peer && (!ctx.reaches(by, workspace.path) || (entry.where === 'job' && !reachesFile(ctx, by, entry.path)))) throw new Error(OUT_OF_REACH)
  if (!existsSync(entry.path)) throw new Error(GONE(entry.name))

  const today = ask.today ?? dayOf((deps.now ?? (() => new Date()))())
  // The three filled without asking, then the caller's own, which win.
  const values = new Map([...filledValues({ today, ownerName: ownerName(ctx), job: workspace.name }), ...fieldValues(ask.fields ?? {})])
  // A caller that set the day in words gave no day for a date cell: only the default is a true date.
  const dateSaid = Object.keys(ask.fields ?? {}).some((k) => fieldKey(k) === fieldKey('Date'))

  const dir = join(scratchRoot(ctx), randomUUID())
  await mkdir(dir, { recursive: true })
  try {
    const { scratch, form } = await scratchOf(ctx, by, entry, dir, deps)
    if (isOfficeForm(form)) await fill(ctx, entry, form, scratch, values, dateSaid ? '' : today, deps.signal)
    // A job's own look: none yet (look.ts). When there is one, its theme is swapped into the scratch file here.
    void (deps.look ?? lookOf)(ctx, workspace.id)
    const unfilled = unfilledOf(form, scratch)
    const title = madeTitle(entry, values, ask.title)
    const placed = await placeFile(ctx, by, { workspace, kind: entry.kind, form, title, scratch, ...(ask.into ? { into: ask.into } : {}) }, deps.pillars, deps.signal)
    return { source: placed.source, kind: entry.kind, title: placed.title, unfilled }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

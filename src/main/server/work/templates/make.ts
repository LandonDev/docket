import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { FolderRef } from '@shared/work/files'
import { errorText } from '@shared/work/ids'
import { dayOf, fieldKey, fieldValues, filledValues, madeTitle, type TemplateMade } from '@shared/work/templates'
import type { Caller, WorkCtx } from '../modules'
import { fillDeck } from './deckFill'
import { lookOf, type LookOf } from './look'
import { fillOffice, isOfficeForm, scanOffice } from './ooxml'
import { OUT_OF_REACH, placeFile, type Pillars } from './place'
import { ownerName, resolveTemplate, scratchRoot, type ShelfEntry } from './shelf'

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

/** Fills the scratch copy where it lies; a file that cannot be filled is left the plain copy it is. */
async function fill(ctx: Pick<WorkCtx, 'convert' | 'log'>, entry: ShelfEntry, scratch: string, values: ReadonlyMap<string, string>, today: string, signal?: AbortSignal): Promise<void> {
  if (!isOfficeForm(entry.form)) return
  try {
    if (entry.form === 'docx' || entry.form === 'xlsx') {
      const filled = fillOffice(entry.form, new Uint8Array(readFileSync(scratch)), values, { today })
      if (filled.changed.length) writeFileSync(scratch, filled.bytes)
    } else if (entry.form === 'pptx') {
      // The slides pillar writes the deck: to a second file, which then takes the scratch copy's place.
      const out = `${scratch}.filled.pptx`
      try {
        const said = await fillDeck(ctx, scratch, out, values, signal)
        if (said.filled) await copyFile(out, scratch)
        for (const w of said.warnings) ctx.log(`templates: ${entry.name}: ${w}`)
      } finally {
        await rm(out, { force: true })
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err
    // What it still holds is named in `unfilled`, so the gap is plain.
    ctx.log(`templates: ${entry.name} was not filled: ${errorText(err)}`)
  }
}

/** The fields still in a file as written. */
function unfilledOf(entry: ShelfEntry, scratch: string): string[] {
  if (!isOfficeForm(entry.form)) return []
  try {
    return scanOffice(entry.form, new Uint8Array(readFileSync(scratch)))
  } catch {
    return []
  }
}

export async function makeFromShelf(ctx: WorkCtx, by: Caller, ask: MakeAsk, deps: MakeDeps = {}): Promise<TemplateMade> {
  const { shelf, entry } = resolveTemplate(ctx, ask.workspaceId, ask.template)
  const { workspace } = shelf
  // A key names a template by id, never by path: what it may reach is asked of the folders the make reads and writes.
  if (by.kind === 'remote' && !by.peer && (!ctx.reaches(by, workspace.path) || (entry.where === 'job' && !ctx.reaches(by, entry.path)))) throw new Error(OUT_OF_REACH)
  if (!existsSync(entry.path)) throw new Error(GONE(entry.name))

  const today = ask.today ?? dayOf((deps.now ?? (() => new Date()))())
  // The three filled without asking, then the caller's own, which win.
  const values = new Map([...filledValues({ today, ownerName: ownerName(ctx), job: workspace.name }), ...fieldValues(ask.fields ?? {})])
  // A caller that set the day in words gave no day for a date cell: only the default is a true date.
  const dateSaid = Object.keys(ask.fields ?? {}).some((k) => fieldKey(k) === fieldKey('Date'))

  const dir = join(scratchRoot(ctx), randomUUID())
  await mkdir(dir, { recursive: true })
  try {
    const scratch = join(dir, `template.${entry.form}`)
    try {
      await copyFile(entry.path, scratch)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(GONE(entry.name))
      throw err
    }
    await fill(ctx, entry, scratch, values, dateSaid ? '' : today, deps.signal)
    // A job's own look: none yet (look.ts). When there is one, its theme is swapped into the scratch file here.
    void (deps.look ?? lookOf)(ctx, workspace.id)
    const unfilled = unfilledOf(entry, scratch)
    const title = madeTitle(entry, values, ask.title)
    const placed = await placeFile(ctx, by, { workspace, kind: entry.kind, form: entry.form, title, scratch, ...(ask.into ? { into: ask.into } : {}) }, deps.pillars, deps.signal)
    return { source: placed.source, kind: entry.kind, title: placed.title, unfilled }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

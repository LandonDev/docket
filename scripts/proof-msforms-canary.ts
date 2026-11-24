/**
 * The Microsoft Forms canary, run by hand (never scheduled: the plan's "For the owner" 2): on a dummy "TempCode proof
 * canary <time>" in his own OneDrive (the VM's "My files" library), the carrier makes the form, edits it (adds a
 * question, renames it), reads it back and compares, counts its answers, and deletes it (from My forms to the Forms
 * recycle bin, then our one item from the bin). It stops at the first step that broke and prints one line:
 *
 *   CANARY BROKE AT <step>: <what the page showed>       or       CANARY OK make 14s · edit 21s · …
 *
 * and on every way out deletes the dummy and says what it deleted. Through heavy, as a tracked background command:
 *
 *   .temp-code/bin/heavy bun --preload ./scripts/lib/electron-stub.ts scripts/proof-msforms-canary.ts
 *
 * It copies the box's Work browser profile into a 0700 folder under /tmp (refused while the live Work browser runs)
 * and deletes the copy at the end. The rig is scripts/lib/msformsRig.ts, the same as scripts/proof-msforms.ts.
 */
import type { MsAnyQuestion } from '../src/shared/work/msforms'
import { msCarrier } from '../src/main/server/work/msforms/carrier/types'
import { authFor, writeChanges } from '../src/main/server/work/msforms/forms'
import { MsformsStore } from '../src/main/server/work/msforms/store'
import { bootRig, clickInPage, copyProfile, find, openPage, press, readPage, removeCopy, waitFor, type Rig } from './lib/msformsRig'

/** The box's own environment id: the rig takes it, so the library ids are the box's. */
const BOX = 'env_AXPf_aVGh7kfe4eydhNdVQ'
/** His OneDrive as the VM syncs it ("My files"). */
const MY_FILES = `${BOX}~876ae7b476`
const FORMS_HOME = 'https://forms.cloud.microsoft/Pages/DesignPagev2.aspx'

const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(0, 16)
const TITLE = `TempCode proof canary ${stamp}`
const QUESTION = 'TempCode canary question'
const RENAMED = 'TempCode canary question renamed'

const quiet = (line: string): void => void (process.env.TC_CANARY_VERBOSE ? console.log(line) : undefined)
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

class Broke extends Error {
  constructor(
    readonly step: string,
    message: string
  ) {
    super(message)
  }
}

/** Runs one step, timed; a failure is the step's, in the page's own words where the carrier has them. */
async function step<T>(times: [string, number][], name: string, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try {
    const out = await run()
    times.push([name, Date.now() - t0])
    return out
  } catch (err) {
    throw err instanceof Broke ? err : new Broke(name, err instanceof Error ? err.message : String(err))
  }
}

/**
 * Deletes a personal form by its title: My forms → its More options → Delete → Delete, then from the Forms recycle
 * bin our one item alone (its own menu), or the whole bin only when it holds nothing but this dummy. Answers what was
 * deleted, in words; throws when it could not be.
 */
async function deleteForm(rig: Rig, title: string): Promise<string[]> {
  const done: string[] = []
  const tile = new RegExp(`^button "${esc(title)} More options"`)
  const w = await openPage(rig, FORMS_HOME)
  let r = await waitFor(rig, w, /^(tab|button|link) "My forms"/)
  if (!r) throw new Error('the Forms home did not show My forms')
  // Forms' "What's new" dialog, when it shows, is closed first
  const gotIt = find(r.text, /^button "Got it"( focused)?$/)
  if (gotIt !== null) await press(rig, w, r, gotIt)
  if (!(await clickInPage(rig, 'DesignPagev2', 'My forms'))) throw new Error('My forms could not be opened')
  r = await waitFor(rig, w, tile)
  if (!r) throw new Error(`"${title}" was not in My forms`)
  await press(rig, w, r, find(r.text, tile)!)
  r = await readPage(rig, w)
  const del = find(r.text, /^menu item "Delete"( focused)?$/)
  if (del === null) throw new Error('its menu had no Delete')
  await press(rig, w, r, del)
  r = await readPage(rig, w)
  const sure = find(r.text, /^button "Delete"( focused)?$/)
  if (sure === null || !/Delete this form\?/.test(r.text)) throw new Error('Forms did not ask "Delete this form?"')
  await press(rig, w, r, sure)
  done.push(`"${title}" deleted from My forms to the Forms recycle bin`)
  // The recycle bin: its button may sit under another control, so it is pressed by its own click().
  await new Promise((res) => setTimeout(res, 3_000))
  if (!(await clickInPage(rig, 'DesignPagev2', 'Recycle bin'))) throw new Error('the Forms recycle bin could not be opened')
  r = await waitFor(rig, w, tile, 20_000)
  if (!r) throw new Error(`"${title}" was not in the Forms recycle bin`)
  await press(rig, w, r, find(r.text, tile)!)
  r = await readPage(rig, w)
  const gone = find(r.text, /^menu item "(Delete|Delete permanently|Permanently delete)"( focused)?$/)
  if (gone !== null) {
    await press(rig, w, r, gone)
    r = await readPage(rig, w)
    const yes = find(r.text, /^button "(Delete|Yes|Delete permanently)"( focused)?$/)
    if (yes === null) throw new Error('Forms did not ask to confirm the permanent delete')
    await press(rig, w, r, yes)
  } else {
    // No delete of one item: the whole bin is emptied only when it holds this dummy alone.
    r = await readPage(rig, w)
    const tiles = r.text.split('\n').filter((l) => / More options"/.test(l))
    if (tiles.length !== 1 || !tile.test(tiles[0]!.replace(/^\s*\[\d+\] /, ''))) throw new Error('the recycle bin holds other forms and offers no delete of one; left there for him')
    const empty = find(r.text, /^button "Empty recycle bin"/)
    if (empty === null) throw new Error('the recycle bin offered no way to delete')
    await press(rig, w, r, empty)
    r = await readPage(rig, w)
    const yes = find(r.text, /^button "Yes"( focused)?$/)
    if (yes === null) throw new Error('Forms did not ask to empty the recycle bin')
    await press(rig, w, r, yes)
  }
  await new Promise((res) => setTimeout(res, 3_000))
  r = await readPage(rig, w)
  if (find(r.text, tile) !== null) throw new Error(`"${title}" is still in the Forms recycle bin`)
  done.push(`"${title}" deleted for good from the Forms recycle bin`)
  return done
}

const times: [string, number][] = []
let dir = ''
let rig: Rig | null = null
let formId: string | null = null
let made = false
let outcome = ''
const deleted: string[] = []

try {
  dir = copyProfile()
  rig = await bootRig(dir, { host: BOX, log: quiet })
  const r = rig
  const store = new MsformsStore(r.db)
  const carrier = msCarrier()
  if (!carrier) throw new Broke('make', 'the carrier is not wired')

  // 1. make
  await step(times, 'make', async () => {
    try {
      const view = (await r.call('work.msforms.make', { workspaceId: r.workspaceId, folder: { libraryId: MY_FILES, path: '' }, title: TITLE })) as { formId: string }
      formId = view.formId
      made = true
    } catch (err) {
      // a make that stopped after the form existed names it: it is deleted below
      formId = (err as { formId?: string }).formId ?? store.list(r.workspaceId)[0]?.formId ?? null
      made = formId !== null
      throw err
    }
  })
  const row = () => store.get(r.workspaceId, formId!)!

  // 2. edit: one question added, then renamed
  await step(times, 'edit', async () => {
    await writeChanges(r.work.ctx, row(), [{ op: 'add', question: { title: QUESTION, type: 'text', required: false } }], 'owner', 'owner')
    await writeChanges(r.work.ctx, row(), [{ op: 'change', at: 0, question: { title: RENAMED, type: 'text', required: false } }], 'owner', 'owner')
  })

  // 3. read back and compare
  await step(times, 'read back', async () => {
    const read = await carrier.read(authFor(r.work.ctx, row(), 'count', 'owner', { formId }), formId!)
    const want: MsAnyQuestion[] = [{ title: RENAMED, type: 'text', required: false }]
    const got = read.questions.map((q) => ({ title: q.title, type: q.type, required: 'required' in q ? q.required : false }))
    if (read.title !== TITLE) throw new Error(`the page's title is "${read.title}", not the one made`)
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`the page holds ${JSON.stringify(got)}, not ${JSON.stringify(want)}`)
  })

  // 4. count
  await step(times, 'count', async () => {
    const { count } = await carrier.count(authFor(r.work.ctx, row(), 'count', 'owner', { formId }), formId!)
    if (count !== 0) throw new Error(`the Responses view counts ${count} answers on a new form`)
  })

  // 5. delete
  await step(times, 'delete', async () => {
    deleted.push(...(await deleteForm(r, TITLE)))
    made = false
  })
  outcome = `CANARY OK ${times.map(([n, ms]) => `${n} ${Math.round(ms / 1000)}s`).join(' · ')}`
} catch (err) {
  const b = err instanceof Broke ? err : new Broke(times.length ? 'after ' + times.at(-1)![0] : 'start', err instanceof Error ? err.message : String(err))
  outcome = `CANARY BROKE AT ${b.step}: ${b.message}`
} finally {
  // the dummy goes on every way out
  if (made && rig) {
    try {
      deleted.push(...(await deleteForm(rig, TITLE)))
    } catch (err) {
      deleted.push(`NOT deleted: "${TITLE}" (${err instanceof Error ? err.message : String(err)}); delete it in Forms by hand`)
    }
  }
  if (rig) await rig.stop().catch(() => {})
  if (dir) {
    removeCopy(dir)
    deleted.push(`the profile copy ${dir}`)
  }
  console.log(outcome)
  console.log(`deleted: ${deleted.length ? deleted.join('; ') : 'nothing was made'}`)
  process.exit(outcome.startsWith('CANARY OK') ? 0 : 1)
}

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filesPaneOf, type CanvasItem, type CanvasKind } from '@shared/work'
import { attachmentDir, setAttachmentDirContext } from '../../attachmentDir'
import type { WorkModule } from '../modules'
import { dashboards } from '../dashboards/index'
import { DashStore } from '../dashboards/dash'
import { forms } from '../forms/index'
import { writeCopy } from '../forms/forms'
import { servicePaths } from '../service/config'
import { FormsStore } from '../forms/store'
import { frameio } from '../frameio/index'
import { frameioItem, saveItem } from '../frameio/live'
import { media } from '../media/index'
import { liveOf } from '../media/view'
import { meetings } from '../meetings/index'
import { meetingsOf } from '../meetings/service'
import { MeetingStore } from '../meetings/store'
import { Voices } from '../meetings/voices'
import { pdf } from '../pdf/index'
import { PdfStore } from '../pdf/store'
import { slides } from '../slides/index'
import { SlidesStore } from '../slides/store'
import { at, makeRig, WS, type Rig } from './testkit'

/**
 * A closed Files tab deletes its item; every pillar that keeps rows or files by item drops them in `itemsRemoved`,
 * and leaves another item's alone. The rig records what pillars were told; each test hands that to the module.
 */
const PANE = filesPaneOf(WS)
let rig: Rig
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => {
  setAttachmentDirContext(null)
  rig.close()
})

const count = (table: string, itemId: string): number => (rig.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`).get(itemId) as { n: number }).n
/** Two items of a kind on the pane: the one whose tab closes, and one that stays. */
const two = (module: WorkModule, kind: CanvasKind): [CanvasItem, CanvasItem] => {
  module.ensure?.(rig.db)
  const open = (name: string) => rig.canvas.open(PANE, { kind, source: at(join(rig.folder, name)), title: name })
  return [open('Closed.bin'), open('Stays.bin')]
}
/** Closes the tab and tells the module what the store said went. */
const closeTab = (module: WorkModule, item: CanvasItem): void => {
  rig.canvas.close(item.id)
  const told = rig.removed.at(-1)!
  expect(told.map((i) => i.id)).toEqual([item.id])
  module.itemsRemoved!(told, rig.ctx)
}

describe('a closed Files tab', () => {
  it('pdf: its mode, fields and marks go', () => {
    const [gone, stays] = two(pdf, 'pdf')
    const store = new PdfStore(rig.db)
    for (const item of [gone, stays]) {
      store.setMode(item.id, PANE, 'suggests')
      store.mark(item.id, PANE, { page: 1, quads: [], text: 'kickoff' }, 'owner')
    }
    closeTab(pdf, gone)
    expect([count('work_pdf_items', gone.id), count('work_pdf_marks', gone.id)]).toEqual([0, 0])
    expect([count('work_pdf_items', stays.id), count('work_pdf_marks', stays.id)]).toEqual([1, 1])
  })

  it('media: its item, versions and notes go, and the preparer forgets its versions', async () => {
    const [gone, stays] = two(media, 'media')
    const { store } = liveOf(rig.ctx)
    const forgot: string[] = []
    liveOf(rig.ctx).preparer = { forget: (ids: readonly string[]) => void forgot.push(...ids) } as never
    const versions = [gone, stays].map((item) => {
      store.ensureItem(item.id, PANE, { source: item.source, name: item.title, by: 'owner' })
      const v = store.addVersion(item.id, { source: item.source, name: `${item.title} v2`, by: 'owner' })
      store.addNote(item.id, { anchor: { versionId: v.id, at: 0 } as never, body: 'tighten the open', by: 'owner' })
      return v.id
    })
    closeTab(media, gone)
    await new Promise((r) => setTimeout(r, 0))
    for (const t of ['work_media_items', 'work_media_versions', 'work_media_notes']) expect([t, count(t, gone.id), count(t, stays.id) > 0]).toEqual([t, 0, true])
    expect(forgot.length).toBeGreaterThan(0)
    expect(forgot).toContain(versions[0])
    expect(forgot).not.toContain(versions[1])
    expect(store.version(versions[1]!)).not.toBeNull()
  })

  it('meetings: its row, its voices and its playback copy go', () => {
    const [gone, stays] = two(meetings, 'meeting')
    setAttachmentDirContext({ session: () => null, projectCwd: () => null, workspacePath: () => null, dataDir: rig.dataDir })
    const store = new MeetingStore(rig.db)
    const voices = new Voices(rig.db)
    const copies = [gone, stays].map((item) => {
      store.ensure({ id: item.id, sessionId: PANE, workspaceId: WS, title: item.title })
      const name = `rec.${item.id.slice(0, 8)}.meeting.m4a`
      store.patch(item.id, { audio: name })
      voices.setMeeting(item.id, new Map([['s1', [1, 0, 0]]]))
      mkdirSync(attachmentDir(PANE), { recursive: true })
      writeFileSync(join(attachmentDir(PANE), name), 'm4a')
      return join(attachmentDir(PANE), name)
    })
    meetingsOf(rig.ctx)
    closeTab(meetings, gone)
    expect([store.get(gone.id), count('work_meetings_speaker_voices', gone.id), existsSync(copies[0]!)]).toEqual([null, 0, false])
    expect([store.get(stays.id) !== null, count('work_meetings_speaker_voices', stays.id), existsSync(copies[1]!)]).toEqual([true, 1, true])
  })

  it('forms: its row, its public page and its folder of answers go', () => {
    const [gone, stays] = two(forms, 'form')
    const store = new FormsStore(rig.db)
    const kept = [gone, stays].map((item, n) => {
      store.create(item.id, PANE, { title: 'Sign-up', description: '', questions: [] })
      const row = store.update(item.id, { publicId: `public${n}`, sheetRef: { tcsheet: '/x.tcsheet' } })
      writeCopy(rig.ctx, row)
      const folder = join(rig.dataDir, 'work-forms', item.id)
      mkdirSync(folder, { recursive: true })
      return { folder, page: join(servicePaths(rig.dataDir).serviceDir, 'forms', `public${n}.json`) }
    })
    expect(kept.map((k) => existsSync(k.page))).toEqual([true, true])
    closeTab(forms, gone)
    expect([store.get(gone.id), existsSync(kept[0]!.folder), existsSync(kept[0]!.page)]).toEqual([null, false, false])
    expect([store.get(stays.id) !== null, existsSync(kept[1]!.folder), existsSync(kept[1]!.page)]).toEqual([true, true, true])
  })

  it('dashboards: its row goes', () => {
    const [gone, stays] = two(dashboards, 'dashboard')
    const store = new DashStore(rig.db)
    for (const item of [gone, stays]) store.create(item.id, PANE, item.title)
    closeTab(dashboards, gone)
    expect([store.get(gone.id), store.get(stays.id) !== null]).toEqual([null, true])
  })

  it('slides: its mode and pending suggestions go', () => {
    const [gone, stays] = two(slides, 'slides')
    const store = new SlidesStore(rig.db)
    for (const item of [gone, stays]) {
      // The mode is the tab's own seat on its deck (slides/store.ts).
      store.seat(item.id, PANE, item.id)
      store.setMode(item.id, 'writes')
      store.add(item.id, PANE, [{ slide: 1, op: { op: 'delete', slide: 'a' } as never }], 'owner')
    }
    closeTab(slides, gone)
    expect([count('work_slides_seats', gone.id), count('work_slides_ops', gone.id)]).toEqual([0, 0])
    expect([count('work_slides_seats', stays.id), count('work_slides_ops', stays.id)]).toEqual([1, 1])
  })

  it('frameio: its row goes', () => {
    const [gone, stays] = two(frameio, 'media')
    for (const item of [gone, stays]) saveItem(rig.db, { itemId: item.id, sessionId: PANE, account: 'acct', stackId: null, fileIds: ['f1'] } as never)
    closeTab(frameio, gone)
    expect([frameioItem(rig.db, gone.id), frameioItem(rig.db, stays.id) !== null]).toEqual([null, true])
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { FilesOpened, FilesTabs } from '@shared/contract-work-files'
import { filesPaneOf } from '@shared/work/canvas'
import type { Caller } from '../modules'
import { closeFilesState } from '../files/handle'
import { files } from '../files/index'
import { librariesHere } from '../files/places/libraries'
import { makeRig, thread, window, WS, type Rig } from '../files/testkit'
import { forms } from '../forms/index'
import { ensureFormsTables, FormsStore } from '../forms/store'
import { msforms } from './index'
import { NOT_THIS_JOB } from './reach'
import { ensureMsformsTables, MsformsStore } from './store'
import { FORM_A } from './testing'

/**
 * A form in a tab of the Files place: New → TempCode form makes our draft in the
 * workspace's Files pane, and a Microsoft form opens by its own source after the
 * one reach check.
 */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
  ensureFormsTables(rig.db)
  ensureMsformsTables(rig.db)
})
afterEach(() => {
  closeFilesState(rig.db)
  rig.close()
})

async function call<T>(module: typeof files, method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
  const out = await module.handle!(req, rig.ctx, by)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}

describe('New → TempCode form', () => {
  it('makes an empty draft in the Files pane and opens it in a tab of its own', async () => {
    const made = await call<FilesTabs & { tabId: string; itemId: string }>(forms, 'work.forms.make', {})
    const tab = made.tabs.find((t) => t.id === made.tabId)!
    expect(tab).toMatchObject({ kind: 'file', name: 'Untitled form', itemId: made.itemId })
    const item = rig.ctx.canvas.get(made.itemId)!
    expect(item).toMatchObject({ kind: 'form', sessionId: filesPaneOf(WS) })
    expect(new FormsStore(rig.db).get(made.itemId)).toMatchObject({ state: 'draft', body: { title: 'Untitled form', questions: [] } })
    // Two makes are two drafts.
    const again = await call<{ tabId: string }>(forms, 'work.forms.make', {})
    expect(again.tabId).not.toBe(made.tabId)
  })

  it('is listed in the Forms view, and a thread may not make one', async () => {
    const made = await call<{ itemId: string }>(forms, 'work.forms.make', {})
    expect(await call(forms, 'work.forms.list', {})).toEqual([expect.objectContaining({ kind: 'ours', id: made.itemId, title: 'Untitled form', state: 'draft' })])
    await expect(call(forms, 'work.forms.make', {}, thread())).rejects.toThrow('Only the owner')
  })
})

describe('a Microsoft form in a tab', () => {
  const store = () => new MsformsStore(rig.db)
  const keep = (workspaceId = WS) => {
    const library = librariesHere(rig.ctx)[0]!
    return store().create({ workspaceId, formId: FORM_A, tenant: 'purdue0', sector: 'purdue', title: 'Spring sign-up', folder: { libraryId: library.id, path: 'General', siteUrl: 'https://purdue0.sharepoint.com/sites/Esports' }, madeBy: 'owner' })
  }
  const ref = { at: 'msform', host: 'env_test', workspaceId: WS, formId: FORM_A, tenant: 'purdue0' }

  it('opens by its source, once: opening it again answers its tab', async () => {
    void msforms
    keep()
    const opened = await call<FilesOpened>(files, 'work.files.open', { ref })
    expect(opened.item).toMatchObject({ kind: 'msform', title: 'Spring sign-up', source: { at: 'msform', formId: FORM_A, workspaceId: WS } })
    const again = await call<FilesOpened>(files, 'work.files.open', { ref })
    expect(again.tabId).toBe(opened.tabId)
  })

  it("refuses a form that is not this job's", async () => {
    keep('w2')
    await expect(call(files, 'work.files.open', { ref })).rejects.toThrow('not in this job')
    await expect(call(files, 'work.files.open', { ref }, thread())).rejects.toThrow()
    keep()
    await expect(call(files, 'work.files.open', { ref }, { kind: 'model', caps: [], sessionId: 'chat' })).rejects.toThrow()
    void NOT_THIS_JOB
  })
})

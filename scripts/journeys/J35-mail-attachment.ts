import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { holds } from './lib/files'
import { FIRST_MAIL } from './lib/lifeosSeed'
import { evidence, MAIL_PANE, openMail, see, storedText, wordsIn } from './lib/lifeosJourney'
import { journey, step, type Context } from './lib/record'

const NAME = 'Spring LAN notes.txt'
const TEXT = 'Doors open at noon.'
const BYTES = 'Spring LAN\nDoors open at noon.\n'
const BAR = '[data-canvas-bar]'
const EDITOR = '[data-canvas-pane] .tiptap[contenteditable]'
const previewFaults = new WeakMap<Context, string>()

export default journey({
  id: 'J35', title: 'Open, save, and keep a mail attachment as a document', tier: 2, shapes: ['S', 'A'],
  steps: [
    step('Open the attachment tab beside the selected mail and check its source', async (context) => {
      const { pair } = context
      await pair.page.resize(1680)
      pair.later(() => pair.page.resize(1280))
      const thread = await openMail(context, FIRST_MAIL)
      const source = await pair.sandbox!.query<{ messages: { attachments: { name: string; url: string | null }[] }[] }>('mail:thread', { id: thread._id })
      const attachment = source.messages.flatMap(({ attachments }) => attachments).find(({ name }) => name === NAME)
      if (await storedText(context, attachment?.url) !== BYTES) throw new Error('LifeOS does not hold the seeded attachment bytes')
      evidence(context, 'stored', { thread, name: NAME, bytes: BYTES })
      await pair.page.clickOn(MAIL_PANE + ' button[aria-label^=' + JSON.stringify('View ' + NAME + ',') + ']')
      await see(pair.page, '[data-canvas-seat]', NAME)
      await see(pair.page, MAIL_PANE + ' h2', FIRST_MAIL)
      let failure = ''
      await pair.page.until('the attachment preview to answer', 12_000, async () => {
        failure = await wordsIn(pair.page, '[data-canvas-state="failed"]')
        return failure || (await wordsIn(pair.page, EDITOR)).includes(TEXT)
      })
      // A refused preview can still offer Save. Keep the refusal and fail the journey after the available presses.
      if (failure) {
        previewFaults.set(context, failure)
        await pair.page.shot(join(context.folder, 'preview-failed.png'))
        evidence(context, 'preview-failed', { failure })
      } else {
        const editable = await pair.page.eval(`document.querySelector(${JSON.stringify(EDITOR)})?.getAttribute('contenteditable')`)
        if (editable !== 'false') throw new Error('The fetched attachment was editable')
        evidence(context, 'opened', { thread, editable })
      }
    }),
    step('Save a byte-for-byte copy in the workspace', async (context) => {
      const { pair, workspace } = context
      const path = join(workspace.path, NAME)
      await pair.page.watchToasts()
      await pair.page.clickOn(BAR + ' button', 'Save to workspace')
      await pair.page.until('the attachment bytes in the workspace', 8000, () =>
        existsSync(path) && readFileSync(path, 'utf8') === BYTES)
      await pair.page.until('the saving confirmation', 8000, async () => (await pair.page.toasts(true)).some((line) => line === 'Saved ' + NAME + ' to the workspace'))
      evidence(context, 'saved', { name: NAME, bytes: readFileSync(path, 'utf8') })
    }),
    step('end: Keep as document opens an editable copy and puts its words on disk', async (context) => {
      const { pair, workspace } = context
      await pair.page.clickOn('[data-board] [data-view-actions] button[aria-label="More"]', 'More')
      const failure = previewFaults.get(context)
      if (failure) {
        await pair.page.until('the canvas menu', 5000, () => pair.page.centre('[role="menu"]'))
        if (!(await wordsIn(pair.page, '[role="menu"]')).includes('Keep as document')) {
          throw new Error(failure + ' · Keep as document is missing from More')
        }
      }
      await pair.page.press('menuitem', 'Keep as document')
      await see(pair.page, '.tiptap[contenteditable="true"]', TEXT)
      let kept: string | undefined
      await pair.page.until('the imported document bytes in the workspace', 12_000, () =>
        (kept = readdirSync(workspace.path).find((name) => name.endsWith('.tcdoc') && holds(join(workspace.path, name), TEXT))))
      evidence(context, 'kept', { name: kept, text: TEXT })
      if (failure) throw new Error(failure)
    })
  ]
})

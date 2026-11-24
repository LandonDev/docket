import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileAt } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { createThread, hostRows, workTool } from './lib/thread'
import { json, shown } from './lib/tierThree'

const NAME = 'Practice meeting.ogg'
const TRANSCRIPT = 'Practice meeting.txt'
const NOTE = 'The speakers discussed the practice session.'
type Meeting = { item_id: string; session_id: string; status: string; origin: string; audio: string | null; error: string | null; doc: string }
const meeting = async ({ pair, workspace }: Context) => (await hostRows<Meeting>(pair,
  'SELECT item_id, session_id, status, origin, audio, error, doc FROM work_meetings WHERE workspace_id = ?', workspace.id))[0]

export default journey({
  id: 'J43',
  title: 'Bring in a recording, read the transcript and notes, and export the transcript',
  tier: 3,
  shapes: ['A'],
  steps: [
    step('Open a short dummy recording in the meeting canvas', async (context) => {
      const { pair } = context
      const path = fileAt(context, NAME)
      copyFileSync(join(pair.repo, 'src/main/server/work/meetings/fixtures/two-speakers.ogg'), path)
      const { id } = await createThread(pair, context.workspace.id, 'Practice meeting notes')
      const opening = workTool(pair, id, 'meeting_open', { file: path, title: 'Practice meeting' }, 300_000)
      void opening.then(reply => json(context, 'open-tool', reply), () => undefined)
      await pair.page.eval(`void window.__monocode.open(${JSON.stringify(id)})`)
      await pair.page.until('the meeting canvas and its recording row', 35_000, async () =>
        !!await pair.page.centre('[data-meeting]') && (await meeting(context))?.origin === 'recording' && existsSync(path))
    }),
    step('Read the recording’s transcript on screen and on box', async (context) => {
      const { page } = context.pair
      let row: Meeting | undefined
      await page.until('the local transcription to settle', 240_000, async () => {
        row = await meeting(context)
        return !!row && ['ready', 'failed'].includes(row.status)
      })
      json(context, 'meeting', row)
      if (row!.status === 'failed') {
        await page.until('the transcription failure on screen', 12_000, () => page.centre('[data-meeting-failed]'))
        throw new Error('Transcript and notes not walked: ' + row!.error)
      }
      const { segments } = JSON.parse(row!.doc) as { segments: { id: string; text: string }[] }
      if (!segments[0]?.text) throw new Error('The settled recording has no transcript turns. Notes not walked.')
      await page.until('the first stored turn in the transcript', 15_000, () => shown(page, '[data-turn]', segments[0]!.text))
    }),
    step('Read notes tied to a transcript turn', async (context) => {
      const { pair } = context
      const row = (await meeting(context))!
      const { segments } = JSON.parse(row.doc) as { segments: { id: string; text: string }[] }
      const reply = await workTool(pair, row.session_id, 'meeting_notes', { meeting: row.item_id,
        summary: [{ text: NOTE, refs: [segments[0]!.id] }], decisions: [], questions: [], actions: [] })
      json(context, 'notes-tool', reply)
      if (reply.error) throw new Error(reply.text)
      await pair.page.press('tab', 'Notes')
      await pair.page.until('the note in the canvas and meeting row', 15_000, async () =>
        await shown(pair.page, '[data-meeting-notes]', NOTE) && !!(await meeting(context))?.doc.includes(NOTE))
    }),
    // docs/agents/work-meetings.md promises no "Keep as document" for a meeting's notes: its More holds Export transcript
    // and Download recording. The walk ends on what is promised, Export transcript's file holding the stored turn.
    step('end: export the transcript and read the turn in its file', async (context) => {
      const { page } = context.pair
      const row = (await meeting(context))!
      const { segments } = JSON.parse(row.doc) as { segments: { id: string; text: string }[] }
      await page.catchExports()
      // One press on the meeting pane's own More (W49). The chat has a More of its own.
      await page.clickOn('[data-board] [data-view-actions] button[aria-label="More"]')
      await page.until('the pane’s menu on the first press', 5000, () => page.eval('!!document.querySelector("[role=menuitem]")'))
      json(context, 'more-menu', await page.eval(`[...document.querySelectorAll('[role="menuitem"]')].map((item) => item.innerText.trim())`))
      await page.press('menuitem', 'Export transcript')
      const text = (await page.downloaded(TRANSCRIPT)).toString('utf8')
      writeFileSync(join(context.folder, TRANSCRIPT), text)
      if (!text.includes(segments[0]!.text)) throw new Error('The exported transcript lacks the first stored turn')
    })
  ]
})

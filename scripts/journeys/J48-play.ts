import type { GuestSource } from '../../src/shared/contract-work-guests'
import { journey, step, type Context } from './lib/record'
import { createThread, hostRows } from './lib/thread'
import { field, json, shown } from './lib/tierThree'

const THREAD = 'Practice source thread'
const PLAY = 'Read the practice list'
const INSTRUCTIONS = 'Read the attached practice list and list the items in order.'
const FILE = 'Practice play checklist'
export const PLAY_SECTOR = 'cosmic'
type Play = { id: string; made_in: string | null; instructions: string; takes: string; proposed: number }
type Thread = { id: string; title: string; scope: string }
const sources = new WeakMap<Context, { thread: string; doc: string }>()
const document = ({ pair }: Context, id: string) => pair.sandbox!.query<{ title: string } | null>('docs:get', { id })
const play = async ({ pair, workspace }: Context) => (await hostRows<Play>(pair,
  'SELECT id, made_in, instructions, takes, proposed FROM work_routines_plays WHERE workspace_id = ? AND name = ?', workspace.id, PLAY))[0]
const threads = ({ pair, workspace }: Context) => hostRows<Thread>(pair, 'SELECT id, title, scope FROM sessions WHERE workspace_id = ?', workspace.id)

export default journey({
  id: 'J48',
  title: 'Save a Work thread as a play and run it on a file',
  tier: 3,
  shapes: ['A'],
  steps: [
    step('Open a dummy Work thread with a file in the workspace', async (context) => {
      const { pair, workspace } = context
      if (!pair.sandbox) throw new Error('The dummy document needs the isolated LifeOS sandbox')
      const { source } = await pair.rpc<{ source: GuestSource }>(pair.box, 'work.docs.create', { title: FILE, sector: PLAY_SECTOR })
      await pair.showWork(workspace, 'Plays')
      const { id } = await createThread(pair, workspace.id, THREAD)
      sources.set(context, { thread: id, doc: source.id })
      await pair.page.clickOn('[data-thread-row] [data-row-open]', THREAD)
      await pair.page.until('the source thread on screen and box', 18_000, async () =>
        !!await pair.page.centre('[data-composer-input]') && await shown(pair.page, 'body', THREAD) && (await threads(context)).some(row => row.id === id && row.scope === 'work') &&
        (await document(context, source.id))?.title === FILE)
    }),
    step('Save as a play with instructions and a File input', async (context) => {
      const { pair, workspace } = context
      const { page } = pair
      await page.press('button', 'Thread menu')
      await page.press('menuitem', 'Save as a play…')
      await field(page, 'Name', PLAY)
      await field(page, 'Instructions', INSTRUCTIONS)
      await page.clickOn('[aria-label="Takes"] button', 'File')
      await page.clickOn('[role="dialog"] button', 'Add')
      const source = sources.get(context)!.thread
      await page.until('the saved play linked to its source thread on box', 18_000, async () => (await play(context))?.made_in === source)
      const row = (await play(context))!
      json(context, 'play', row)
      if (row.proposed || row.instructions !== INSTRUCTIONS || row.takes !== '["file"]') throw new Error('The play kept different instructions or input')
      await pair.showWork(workspace, 'Plays')
      await page.until('the play and its File input in Plays', 15_000, async () =>
        await shown(page, '[aria-label="Plays"]', PLAY) && await shown(page, '[aria-label="Plays"]', 'Takes a file'))
    }),
    step('end: choose the dummy file and see a new Work thread with its file chip', async (context) => {
      const { pair } = context
      const { page } = pair
      const before = new Set((await threads(context)).map(({ id }) => id))
      await page.clickOn('[aria-label="Plays"] button > *', PLAY)
      await page.clickOn('[role="dialog"] input[placeholder="Search file"]')
      await page.typeKeys(FILE)
      await page.clickOn('[aria-label="File found"] button > span', FILE)
      await page.clickOn('[role="dialog"] button', 'Start')
      let created: Thread | undefined
      await page.until('the new Work thread and its sent file chip', 40_000, async () => {
        created = (await threads(context)).find(row => !before.has(row.id))
        return created?.scope === 'work' && !!await page.centre('[data-sent-chips] [data-chip="doc"] button', FILE)
      })
      const id = sources.get(context)!.doc
      const doc = await document(context, id)
      json(context, 'run', { thread: created, documentId: id, title: doc?.title })
      if (doc?.title !== FILE) throw new Error('The dummy document is missing from the sandbox')
    })
  ]
})

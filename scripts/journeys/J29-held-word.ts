import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OfficeLiveAddress } from '../../src/shared/contract-work-office'
import type { OutboxItem } from '../../src/shared/contract-work-outbox'
import { holds } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { openWordAddin } from './lib/wordAddin'
import { createThread, workTool } from './lib/thread'

const NAME = 'Shared practice agenda.docx'
const WEB = 'https://journey-dummy.sharepoint.com/sites/Practice/Shared%20Documents'
const BEFORE = '{{Meeting}}'
const AFTER = 'Practice starts at noon'
const held = new WeakMap<Context, { item: OutboxItem; calls: string[] }>()

export default journey({
  id: 'J29',
  title: 'Hold a Word edit for Send; a second press runs nothing',
  tier: 1,
  shapes: ['B1', 'B2'],
  steps: [
    step('Ask the Word tool to edit a shared file and prove no byte changed', async (context) => {
      const { pair, workspace, folder } = context
      const file = fileAt(context, NAME)
      copyFileSync(join(pair.repo, 'resources/work-templates/any/Meeting notes.docx'), file)
      const before = readFileSync(file)
      const holder = context.shape === 'B1' ? pair.win : pair.desk!
      const library = context.shape === 'B1' ? pair.l1 : pair.l2!
      await pair.rpc(holder, 'work.office.filesSetRoots', { roots: [{ folder: dirname(library), web: WEB }] })
      await showPlace(context)
      const { address } = await pair.rpc<OfficeLiveAddress>(pair.box, 'work.office.live.address', {
        workspaceId: workspace.id, ref: { at: 'file', host: holder.host, path: file }
      })
      if (!address?.startsWith(WEB + '/')) throw new Error('The holder does not have the dummy file’s Office address')
      const calls = await openWordAddin(pair, file, address, BEFORE, AFTER)
      const { id } = await createThread(pair, workspace.id, 'Practice document edit')
      const answer = await workTool(pair, id, 'office_doc_edit', { document: address, find: BEFORE, replace: AFTER, because: 'own' })
      writeFileSync(join(folder, 'tool.json'), JSON.stringify(answer, null, 2))
      if (calls.includes('word.edit') || !before.equals(readFileSync(file))) throw new Error('The shared Word bytes changed before approval')
      if (answer.error || !/held/i.test(answer.text)) throw new Error('The tool did not hold the edit: ' + answer.text)
      const { items } = await pair.rpc<{ items: OutboxItem[] }>(pair.box, 'work.outbox.list')
      const item = items.find((row) => row.kind === 'office.edit' && row.state === 'held' && row.sessionId === id)
      if (!item) throw new Error('No held Word edit on box')
      held.set(context, { item, calls })
    }),
    step('Open the held Word edit in Outbox and press Send', async (context) => {
      const { page } = context.pair
      await page.clickOn('nav [data-rail-row] button > span.truncate', 'Outbox')
      const row = '[data-outbox-list] button:has([data-row-title])'
      let point: Awaited<ReturnType<typeof page.centre>> = null
      await page.until('the held Word row naming the file', 15_000, async () => {
        const at = await page.eval<number>(`[...document.querySelectorAll(${JSON.stringify(row)})].findIndex(e => e.innerText.includes(${JSON.stringify(NAME)}))`)
        if (at < 0) return false
        return (point = await page.eval(`(() => {
          const r = document.querySelectorAll(${JSON.stringify(row)})[${at}]?.getBoundingClientRect();
          return r?.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        })()`))
      })
      await page.click(point!)
      await page.clickOn('[data-outbox-verbs] button', 'Make the change')
      await page.until('the approved words on the library holder', 25_000, () => holds(fileAt(context, NAME), AFTER))
    }),
    step('end: a second Send from an old card runs nothing and answers the item as it stands', async (context) => {
      const { pair, folder } = context
      const before = readFileSync(fileAt(context, NAME))
      const calls = held.get(context)!.calls
      const edits = () => calls.filter((call) => call === 'word.edit').length
      if (edits() !== 1) throw new Error('The stand-in saw ' + edits() + ' writes for the approved edit')
      // Replay the exact request a second window would have sent from the old card.
      const { ref, updatedAt: rev } = held.get(context)!.item
      const first = await pair.rpc<OutboxItem>(pair.box, 'work.outbox.get', { ref })
      const answer = await pair.fromWindow<OutboxItem>('work.outbox.send', { ref, rev })
      writeFileSync(join(folder, 'second-press.json'), JSON.stringify(answer, null, 2))
      writeFileSync(join(folder, 'addin-calls.json'), JSON.stringify(calls, null, 2))
      if (edits() !== 1 || !before.equals(readFileSync(fileAt(context, NAME)))) throw new Error('The second Send changed the file')
      // The hold's rule (outbox.ts `send`): a press that finds the row taken answers the row as it stands and runs
      // nothing. The old card's window then draws it as gone, which is true; a refusal is right too.
      if (answer.ok && answer.value.state !== 'sent') throw new Error('The second Send answered the item as ' + answer.value.state)
      if (answer.ok && answer.value.decidedAt !== first.decidedAt) throw new Error('The second Send was recorded as a press of its own')
    })
  ]
})
